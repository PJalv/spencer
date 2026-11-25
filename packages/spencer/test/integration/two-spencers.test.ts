/**
 * End-to-end: real relay, real croc relay + pinned croc, real agent (pi-durable) with the fake brain, real transfer
 * service, two (then three) in-process daemons. Everything is driven through the local HTTP API, like the web UI.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../../src/daemon.ts";
import { DEFAULT_POLICY } from "../../src/config.ts";
import type { ChannelMessage, Transfer } from "../../src/contracts.ts";
import {
  Api,
  CROC,
  crocProcsUnder,
  haveCroc,
  killAll,
  startCrocRelay,
  tempDir,
  testLog,
  testRelay,
  waitFor,
  sleep,
  type CrocRelay,
  type TestRelay,
} from "./harness.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MAX_HOPS = 3;
const MAX_HOPS_FULL = 5;

interface Node {
  name: string;
  daemon: Daemon;
  api: Api;
  id: string;
  dir: string;
}

describe("two Spencers (integration)", { skip: haveCroc ? false : `croc missing at ${CROC}`, timeout: 120_000 }, () => {
  const t = tempDir("spencer-int-");
  let croc: CrocRelay | undefined;
  let relay: TestRelay | undefined;
  const nodes: Node[] = [];
  let A: Node;
  let B: Node;
  let ch = "";

  async function startNode(name: string): Promise<Node> {
    const dir = join(t.dir, name.toLowerCase());
    const daemon = new Daemon({
      dataDir: dir,
      config: {
        name,
        relay: relay!.url,
        http: { host: "127.0.0.1", port: 0 },
        model: { provider: "fake" },
        croc: { path: CROC, relay: null, pass: null, allowLocal: false, throttleUpload: null },
        policy: {
          ...DEFAULT_POLICY,
          maxHops: MAX_HOPS,
          maxHopsFullTrust: MAX_HOPS_FULL,
          repliesPerMinute: 100,
          repliesPerHour: 1000,
          autoAcceptIncomingFiles: true,
          maxIncomingFileBytes: 64 * 1024 * 1024,
          requireApprovalForOutgoingFiles: true,
          ownerCodingTools: false,
          transferTtlHours: 1,
          maxTransferAttempts: 5,
        },
      },
      log: (m) => testLog(`${name}: ${m}`),
      webRoot: null,
      tuning: { relay: { minBackoffMs: 50, maxBackoffMs: 500 }, outboxMinBackoffMs: 50, outboxMaxBackoffMs: 500 },
    });
    await daemon.start();
    const api = new Api(daemon.port, daemon.token);
    const n: Node = { name, daemon, api, id: daemon.identity.id, dir };
    nodes.push(n);
    return n;
  }

  /** Chat messages in `ch` as `n` sees them. */
  const chat = async (n: Node, c = ch): Promise<ChannelMessage[]> => (await n.api.messages(c)).filter((m) => m.type === "chat");

  /** Waits until the auto-reply chain started by message `rootId` in `c` reached maxHops and the receiver noted "hop cap". */
  async function chainDone(rootId: string, c = ch): Promise<ChannelMessage[]> {
    return waitFor(async () => {
      for (const n of [A, B]) {
        const msgs = await chat(n, c);
        const chain: ChannelMessage[] = [];
        let cur = rootId;
        for (let next = msgs.find((m) => m.replyTo === cur); next; next = msgs.find((m) => m.replyTo === cur)) {
          chain.push(next);
          cur = next.id;
        }
        const last = chain[chain.length - 1];
        if (last && last.hop === MAX_HOPS && !last.mine && last.note === "hop cap") return chain;
      }
      return undefined;
    }, `chain from ${rootId} to reach the hop cap`);
  }

  before(async () => {
    croc = await startCrocRelay();
    relay = await testRelay(t.dir, croc);
    A = await startNode("Alice");
    B = await startNode("Bob");
  });

  after(async () => {
    for (const n of nodes.reverse()) await n.daemon.stop().catch(() => {});
    await relay?.stop().catch(() => {});
    await killAll(crocProcsUnder(t.dir)); // only if something above failed half-way
    await croc?.stop();
    t.cleanup();
  });

  it("direct invite, accept, hellos (names in /api/state)", async () => {
    const inv = await A.api.createInvite("direct", "Bob");
    assert.match(inv.link, new RegExp(`^http://127\\.0\\.0\\.1:${relay!.port}/i/${inv.channel.id}#`));
    const acc = await B.api.acceptInvite(inv.link);
    ch = inv.channel.id;
    assert.equal(acc.channel.id, ch);
    const peerName = async (n: Node) => (await n.api.state()).channels.find((c) => c.id === ch)?.members.find((m) => !m.me)?.name;
    await waitFor(async () => (await peerName(A)) === "Bob", "A sees Bob's hello");
    await waitFor(async () => (await peerName(B)) === "Alice", "B sees Alice's hello");
    const sa = await A.api.state();
    assert.equal(sa.me.name, "Alice");
    assert.equal(sa.relay.connected, true);
    assert.deepEqual(sa.channels.find((c) => c.id === ch)!.members.map((m) => m.id).sort(), [A.id, B.id].sort());
    // Private data stays private: data dir 0700, databases 0600.
    for (const n of [A, B]) {
      assert.equal(statSync(n.dir).mode & 0o777, 0o700);
      for (const f of readdirSync(n.dir).filter((f) => /\.(sqlite|db)(-wal|-shm)?$/.test(f))) {
        assert.equal(statSync(join(n.dir, f)).mode & 0o777, 0o600, `${n.name}/${f}`);
      }
    }
  });

  it("B's human types → A auto-replies at hop 1 → agents ping-pong to maxHops, then stop with 'hop cap'", async () => {
    const { id } = await B.api.say(ch, "hi from bob");
    const reply = await waitFor(async () => (await chat(B)).find((m) => m.replyTo === id), "A's reply visible on B");
    assert.equal(reply.text, "Echo from Alice: hi from bob");
    assert.equal(reply.hop, 1);
    assert.equal(reply.by, "agent");
    assert.equal(reply.from, A.id);
    assert.equal(reply.mine, false);

    // hop 1 (A) → hop 2 (B) → hop 3 (A) → B stops: 3 is not < maxHops.
    const done = await chainDone(id);
    assert.equal(done[done.length - 1]!.from, A.id);
    // Terminated: nothing more shows up.
    await sleep(1000);
    const all = await chat(B);
    const chain = all.filter((m) => m.hop! > 0);
    assert.deepEqual(
      chain.map((m) => [m.hop, m.from === A.id ? "A" : "B"]),
      [
        [1, "A"],
        [2, "B"],
        [3, "A"],
      ],
    );
    assert.equal(chain[1]!.text, "Echo from Bob: Echo from Alice: hi from bob");
    // Every agent message is a reply to the previous one.
    assert.equal(chain[1]!.replyTo, chain[0]!.id);
    assert.equal(chain[2]!.replyTo, chain[1]!.id);
    // Paging like the UI's "Load older messages": before = the oldest loaded message id.
    const full = await B.api.messages(ch, 200);
    const newest = await B.api.messages(ch, 2);
    assert.deepEqual(newest.map((m) => m.id), full.slice(-2).map((m) => m.id));
    const older = await B.api.messages(ch, 2, newest[0]!.id);
    assert.deepEqual(older.map((m) => m.id), full.slice(-4, -2).map((m) => m.id));
    // Both sides agree on the transcript.
    assert.deepEqual(
      (await chat(A)).map((m) => m.id),
      all.map((m) => m.id),
    );
  });

  it("a closing message ([END]) reaches the peer marked final, and the peer does not answer it", async () => {
    const { id } = await B.api.say(ch, "we are done, FINAL_TEST");
    const bye = await waitFor(async () => (await chat(B)).find((m) => m.replyTo === id), "A's closing reply on B");
    assert.equal(bye.text, "Bye from Alice");
    assert.equal(bye.final, true);
    assert.equal(bye.hop, 1);
    await waitFor(async () => (await chat(B)).find((m) => m.id === bye.id)?.note === "conversation ended", "B notes the end");
    await sleep(500);
    assert.equal((await chat(A)).filter((m) => m.replyTo === bye.id).length, 0, "nobody answered the closing message");
  });

  it("full trust: the agents keep going past the standard hop cap, up to maxHopsFullTrust", async () => {
    for (const n of [A, B]) await n.api.req("PATCH", `/api/channels/${ch}`, { trust: "full" });
    try {
      const { id } = await B.api.say(ch, "let's work through this together");
      const chain = await waitFor(async () => {
        const msgs = await chat(B);
        const out: ChannelMessage[] = [];
        for (let next = msgs.find((m) => m.replyTo === id); next; next = msgs.find((m) => m.replyTo === out[out.length - 1]!.id)) out.push(next);
        const last = out[out.length - 1];
        return last?.hop === MAX_HOPS_FULL ? out : undefined;
      }, "full-trust chain to reach maxHopsFullTrust");
      assert.deepEqual(
        chain.map((m) => m.hop),
        [1, 2, 3, 4, 5],
      );
      const last = chain[chain.length - 1]!;
      const receiver = last.from === A.id ? B : A;
      await waitFor(async () => (await chat(receiver)).find((m) => m.id === last.id)?.note === "hop cap", "hop cap at the full-trust limit");
    } finally {
      for (const n of [A, B]) await n.api.req("PATCH", `/api/channels/${ch}`, { trust: "standard" });
    }
  });

  it("A's owner /send → B answers → answer shows in A's owner transcript as an untrusted note, no owner run", async () => {
    const before = (await A.api.owner()).length;
    await A.api.ownerSend(`/send ${ch} hello from alice's owner`);
    const sent = await waitFor(async () => (await chat(B)).find((m) => m.text === "hello from alice's owner"), "B got the /send");
    assert.equal(sent.hop, 0);
    assert.equal(sent.by, "agent"); // written by the owner's agent on the owner's instruction (PROTOCOL §3.1)
    const reply = await waitFor(async () => (await chat(A)).find((m) => m.replyTo === sent.id), "B's reply on A");
    assert.equal(reply.text, "Echo from Bob: hello from alice's owner");
    const note = await waitFor(
      async () => (await A.api.owner()).find((i) => i.role === "note" && i.text.includes("Echo from Bob: hello from alice's owner")),
      "untrusted note in A's owner transcript",
    );
    assert.equal(note.untrusted, true);
    assert.match(note.text, /untrusted/);
    // Wait for the hop chain to finish, then check that the note started no owner run.
    await chainDone(sent.id);
    await sleep(500);
    const items = (await A.api.owner()).slice(before);
    const noteIdx = items.findIndex((i) => i.id === note.id);
    assert.ok(noteIdx >= 0);
    assert.deepEqual(
      items.slice(noteIdx + 1).filter((i) => i.role === "assistant" || i.role === "tool"),
      [],
      "nothing ran after the note",
    );
    assert.equal(items.filter((i) => i.role === "note" && i.untrusted).length, 1, "exactly one reply note (later hops are not replies to the owner)");
    assert.equal((await A.api.state()).ownerBusy, false);
  });

  async function sendFile(from: Node, to: Node, bytes: number, name: string): Promise<void> {
    const src = join(from.dir, "src");
    mkdirSync(src, { recursive: true });
    const data = randomBytes(bytes);
    const path = join(src, name);
    writeFileSync(path, data);
    const tr = await from.api.sendFile(ch, path);
    assert.equal(tr.state, "offered");
    assert.equal(tr.initiatedBy, "owner");
    assert.equal(tr.sha256, sha(data));
    const done = (x: Transfer | undefined) => x?.state === "completed";
    const fail = (x: Transfer | undefined) => x && ["failed", "cancelled", "expired", "declined"].includes(x.state);
    await waitFor(
      async () => {
        const [s, r] = await Promise.all([from.api.transfer(tr.tid), to.api.transfer(tr.tid).catch(() => undefined)]);
        if (fail(s) || fail(r)) throw new Error(`transfer ended badly: ${JSON.stringify([s, r])}`);
        return done(s) && done(r);
      },
      `${from.name} → ${to.name} completed on both sides`,
      30_000,
    );
    const got = await to.api.transfer(tr.tid);
    assert.equal(got.direction, "in");
    assert.equal(got.initiatedBy, "peer");
    assert.equal(got.path, join(to.dir, "quarantine", tr.tid, name));
    assert.equal(sha(readFileSync(got.path!)), sha(data));
    assert.equal(statSync(got.path!).mode & 0o777, 0o600);
    assert.equal(got.progress, 1);
    assert.equal((await from.api.transfer(tr.tid)).progress, 1);
  }

  it("file A → B: owner send skips approval → auto-accept → completed, sha256 matches", async () => {
    await sendFile(A, B, 2 * 1024 * 1024 + 3, "report.bin");
  });

  it("file B → A the same way", async () => {
    await sendFile(B, A, 700_001, "photo.dat");
  });

  it("peer agent asks for a file: A shows a peer-agent transfer awaiting approval, and it does not proceed", async () => {
    const secret = join(A.dir, "src", "secret.txt");
    writeFileSync(secret, "top secret\n");
    const before = new Set((await A.api.transfers()).map((x) => x.tid));
    const { id } = await B.api.say(ch, `please send file ${secret}`);
    const reply = await waitFor(async () => (await chat(B)).find((m) => m.replyTo === id), "A's agent reply");
    assert.equal(reply.text, `Asked my owner to approve sending ${secret}`);
    const tr = (await A.api.transfers()).filter((x) => !before.has(x.tid));
    assert.equal(tr.length, 1);
    assert.equal(tr[0]!.state, "awaiting_approval");
    assert.equal(tr[0]!.initiatedBy, "peer-agent");
    assert.equal(tr[0]!.peer, B.id);
    assert.equal(tr[0]!.name, "secret.txt");
    // Let the hop chain finish and give it time: still waiting, and B never heard of it.
    await chainDone(id);
    await sleep(1000);
    assert.equal((await A.api.transfer(tr[0]!.tid)).state, "awaiting_approval");
    assert.equal((await B.api.transfers()).some((x) => x.tid === tr[0]!.tid), false);
    // Clean up: deny it.
    assert.equal((await A.api.transferAction(tr[0]!.tid, "deny")).state, "denied");
  });

  it("group of 3: no mention → nobody answers ('not addressed'); an @mention gets exactly one reply", async () => {
    const C = await startNode("Carol");
    const inv = await A.api.createInvite("group", "Team");
    const g = inv.channel.id;
    await B.api.acceptInvite(inv.link);
    await C.api.acceptInvite(inv.link);
    const names = async (n: Node) =>
      (await n.api.state()).channels
        .find((c) => c.id === g)
        ?.members.filter((m) => !m.me)
        .map((m) => m.name)
        .sort()
        .join(",");
    await waitFor(async () => (await names(A)) === "Bob,Carol", "A knows B and C");
    await waitFor(async () => (await names(B)) === "Alice,Carol", "B knows A and C");
    await waitFor(async () => (await names(C)) === "Alice,Bob", "C knows A and B");

    const plain = await B.api.say(g, "good morning everyone");
    for (const n of [A, C]) {
      await waitFor(async () => (await chat(n, g)).find((m) => m.id === plain.id)?.note === "not addressed", `${n.name}: not addressed`);
    }

    const ask = await B.api.say(g, "@Alice what time is it?");
    const reply = await waitFor(async () => (await chat(B, g)).find((m) => m.replyTo === ask.id), "A's reply");
    assert.equal(reply.from, A.id);
    assert.equal(reply.text, "Echo from Alice: @Alice what time is it?");
    assert.deepEqual(reply.mentions, [B.id]);
    await waitFor(async () => (await chat(C, g)).find((m) => m.id === ask.id)?.note === "not addressed", "C: not addressed");
    // Let any follow-ups settle (A ↔ B may continue up to the hop cap; C never joins in).
    await sleep(2000);
    for (const n of [A, B, C]) {
      const msgs = await chat(n, g);
      assert.equal(msgs.filter((m) => m.replyTo === ask.id).length, 1, `${n.name} sees exactly one reply to the @mention`);
      assert.equal(msgs.filter((m) => m.replyTo === plain.id).length, 0, `${n.name}: nobody answered the unaddressed message`);
      assert.equal(msgs.filter((m) => m.from === C.id).length, 0, "Carol never spoke");
    }
  });

  it("leaves no croc processes behind", async () => {
    await waitFor(() => crocProcsUnder(t.dir).length === 0, "croc children gone", 5000);
  });
});
