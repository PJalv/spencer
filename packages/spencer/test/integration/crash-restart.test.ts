/**
 * Crash/restart: daemons run as child processes (`node packages/spencer/src/main.ts`) and are killed with SIGKILL.
 * Real relay, real croc relay and croc, real agent with the fake brain. Driven through the local HTTP API.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelMessage, Transfer } from "../../src/contracts.ts";
import {
  Api,
  CROC,
  MAIN,
  ROOT,
  crocProcsUnder,
  freePort,
  haveCroc,
  killAll,
  sleep,
  startCrocRelay,
  tempDir,
  testRelay,
  waitFor,
  type CrocRelay,
  type TestRelay,
} from "./harness.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A Spencer daemon in a child process, on a fixed port so the API client survives restarts. */
class ChildSpencer {
  name: string;
  dir: string;
  port = 0;
  proc: ChildProcess | undefined;
  out = "";
  api!: Api;
  id = "";

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
  }

  writeConfig(relayUrl: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const cfg = {
      name: this.name,
      relay: relayUrl,
      model: { provider: "fake" },
      // Slow sends down so a test can kill a daemon while croc is mid-transfer.
      croc: { path: CROC, throttleUpload: "200k" },
      policy: { maxHops: 3, repliesPerMinute: 100, repliesPerHour: 1000, ownerCodingTools: false, transferTtlHours: 1 },
    };
    writeFileSync(join(this.dir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }

  async start(): Promise<void> {
    if (!this.port) this.port = await freePort();
    const env = { ...process.env };
    delete env.SPENCER_DATA_DIR;
    delete env.SPENCER_PORT;
    const proc = spawn(process.execPath, [MAIN, "--data-dir", this.dir, "--port", String(this.port)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    const collect = (d: Buffer) => {
      this.out = (this.out + d.toString("utf8")).slice(-20_000);
      if (process.env.SPENCER_TEST_LOG) process.stderr.write(`  [${this.name}] ${d}`);
    };
    proc.stdout!.on("data", collect);
    proc.stderr!.on("data", collect);
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Error(`${this.name} exited (${proc.exitCode}):\n${this.out}`);
        const tok = join(this.dir, "api-token");
        if (!existsSync(tok)) return false;
        this.api = new Api(this.port, readFileSync(tok, "utf8").trim());
        const st = await this.api.state();
        this.id = st.me.id;
        return true;
      },
      `${this.name} API up`,
      20_000,
      100,
    );
  }

  /** SIGKILL: no shutdown hooks, no chance to stop croc. */
  async kill9(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const gone = new Promise((r) => p.once("exit", r));
    p.kill("SIGKILL");
    await gone;
  }

  async restart(): Promise<void> {
    await this.kill9();
    await this.start();
  }
}

describe("crash/restart (child processes, SIGKILL)", { skip: haveCroc ? false : `croc missing at ${CROC}`, timeout: 180_000 }, () => {
  const t = tempDir("spencer-crash-");
  let croc: CrocRelay | undefined;
  let relay: TestRelay | undefined;
  const A = new ChildSpencer("Alice", join(t.dir, "a"));
  const B = new ChildSpencer("Bob", join(t.dir, "b"));
  let ch = "";

  const chat = async (n: ChildSpencer): Promise<ChannelMessage[]> => (await n.api.messages(ch, 500)).filter((m) => m.type === "chat");
  const autoReply = (n: ChildSpencer, on: boolean) => n.api.req("PATCH", `/api/channels/${ch}`, { autoReply: on });

  before(async () => {
    croc = await startCrocRelay();
    relay = await testRelay(t.dir, croc);
    for (const n of [A, B]) {
      n.writeConfig(relay.url);
      await n.start();
    }
    const inv = await A.api.createInvite("direct", "Bob");
    ch = inv.channel.id;
    await B.api.acceptInvite(inv.link);
    const peer = async (n: ChildSpencer) => (await n.api.state()).channels.find((c) => c.id === ch)?.members.find((m) => !m.me)?.name;
    await waitFor(async () => (await peer(A)) === "Bob" && (await peer(B)) === "Alice", "hellos");
  });

  after(async () => {
    for (const n of [A, B]) await n.kill9().catch(() => {});
    // A SIGKILLed daemon cannot stop its croc children; whatever is left of them goes here.
    await killAll(crocProcsUnder(t.dir));
    await relay?.stop().catch(() => {});
    await croc?.stop();
    t.cleanup();
  });

  it("outbox: messages enqueued while the relay is down survive kill -9 and arrive exactly once, in order", async () => {
    await autoReply(B, false);
    await relay!.stop();
    await waitFor(async () => !(await A.api.state()).relay.connected, "A notices the relay is down");
    const texts = Array.from({ length: 6 }, (_, i) => `outbox-${i}`);
    const ids: string[] = [];
    for (const text of texts) ids.push((await A.api.say(ch, text)).id);
    const mine = await chat(A);
    assert.deepEqual(
      ids.map((id) => mine.find((m) => m.id === id)?.status),
      texts.map(() => "pending"),
    );
    await A.kill9();
    await relay!.start();
    await A.start();
    const got = await waitFor(
      async () => {
        const m = (await chat(B)).filter((x) => x.text?.startsWith("outbox-"));
        return m.length >= texts.length ? m : undefined;
      },
      "B received the outbox",
      30_000,
    );
    await sleep(500); // a duplicate would show up now
    const final = (await chat(B)).filter((x) => x.text?.startsWith("outbox-"));
    assert.deepEqual(
      final.map((m) => m.text),
      texts,
      "exactly once, in order",
    );
    assert.deepEqual(
      got.map((m) => m.id),
      ids,
    );
    assert.ok(final.every((m, i) => i === 0 || m.seq! > final[i - 1]!.seq!), "relay seqs increase");
    await waitFor(async () => (await chat(A)).filter((m) => ids.includes(m.id)).every((m) => m.status === "sent"), "A marks them sent");
    await autoReply(B, true);
  });

  it("inbox/agent: B killed while its reply is pending sends that reply exactly once after restart", async () => {
    await autoReply(A, false); // only B answers, so the chain is one message long
    const { id } = await A.api.say(ch, "SLOW_REPLY_TEST are you there?");
    // Kill B right after it stored the message (the fake brain holds the answer for 3 s).
    await waitFor(async () => (await chat(B)).some((m) => m.id === id), "B stored the message", 15_000, 20);
    await B.kill9();
    assert.equal((await chat(A)).filter((m) => m.replyTo === id).length, 0, "no reply before the crash");
    await B.start();
    const reply = await waitFor(async () => (await chat(A)).find((m) => m.replyTo === id), "B's reply after restart", 20_000);
    assert.equal(reply.text, "Echo from Bob: SLOW_REPLY_TEST are you there?");
    assert.equal(reply.hop, 1);
    await sleep(1500);
    assert.equal((await chat(A)).filter((m) => m.replyTo === id).length, 1, "exactly one reply on A");
    assert.equal((await chat(B)).filter((m) => m.replyTo === id).length, 1, "exactly one reply on B");
    await autoReply(A, true);
  });

  /** Sends a file A → B, kills `victim` with SIGKILL while croc is moving bytes, restarts it, and checks the result. */
  async function transferSurvivesKill(victim: ChildSpencer, label: string): Promise<void> {
    const src = join(A.dir, "src");
    mkdirSync(src, { recursive: true });
    const data = randomBytes(900_000); // ~4.5 s per attempt at 200k
    const path = join(src, `${label}.bin`);
    writeFileSync(path, data);
    const tr = await A.api.sendFile(ch, path);
    assert.equal(tr.state, "offered");
    // Mid-transfer: B is receiving and the bytes are flowing.
    await waitFor(
      async () => {
        const [s, r] = await Promise.all([A.api.transfer(tr.tid), B.api.transfer(tr.tid).catch(() => undefined)]);
        return s.state === "sending" && r?.state === "receiving" && (s.progress ?? 0) > 0.05;
      },
      "transfer in flight",
      20_000,
      50,
    );
    const crocBefore = crocProcsUnder(victim.dir);
    assert.ok(crocBefore.length > 0, "the victim runs croc");
    await victim.kill9();
    assert.ok(crocBefore.some(alive), "its croc outlived the SIGKILL (orphan)");
    await victim.start();
    // On start the daemon kills the orphans it recorded in croc.pids.
    await waitFor(() => !crocBefore.some(alive), "orphaned croc reaped by the restarted daemon", 5000);
    const end = (x: Transfer | undefined) => x && ["failed", "cancelled", "expired", "declined", "denied"].includes(x.state);
    await waitFor(
      async () => {
        const [s, r] = await Promise.all([A.api.transfer(tr.tid), B.api.transfer(tr.tid)]);
        if (end(s) || end(r)) throw new Error(`transfer ended badly: ${JSON.stringify([s, r])}`);
        return s.state === "completed" && r.state === "completed";
      },
      `${label}: completed on both sides`,
      60_000,
      100,
    );
    const got = await B.api.transfer(tr.tid);
    assert.equal(sha(readFileSync(got.path!)), sha(data));
    assert.ok((await A.api.transfer(tr.tid)).attempt >= 2, "a new attempt after the restart");
    await waitFor(() => crocProcsUnder(t.dir).length === 0, "no croc left running", 5000);
  }

  it("transfer: sender killed mid-send resumes and completes with a matching hash", async () => {
    await transferSurvivesKill(A, "sender-killed");
  });

  it("transfer: receiver killed mid-receive resumes and completes with a matching hash", async () => {
    await transferSurvivesKill(B, "receiver-killed");
  });
});
