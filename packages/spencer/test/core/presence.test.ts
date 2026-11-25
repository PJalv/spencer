/** Presence (relay "presence" feature), relay connection state, and ephemeral status (relay "ephemeral" feature). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sealEnvelope } from "@spencer/protocol";
import { loadOrCreateIdentity } from "../../src/store/files.ts";
import { startRelay } from "../../../relay/src/index.ts";
import type { DaemonEvent } from "../../src/contracts.ts";
import { freePort, quietLog, relayAt, startNode, tempDir, waitFor, type TestNode } from "./helpers.ts";

async function pair(t: { dir: string }, relayUrl: string): Promise<{ A: TestNode; B: TestNode; ch: string }> {
  const da = join(t.dir, "a");
  const db = join(t.dir, "b");
  mkdirSync(da);
  mkdirSync(db);
  const A = await startNode(da, relayUrl, "Alice");
  const B = await startNode(db, relayUrl, "Bob");
  const { link, channel } = await A.daemon.createInvite("direct", "Bob");
  await B.daemon.acceptInvite(link);
  await waitFor(() => A.daemon.core.getChannel(channel.id)?.members.length === 2, "joined");
  return { A, B, ch: channel.id };
}

const peerOf = (n: TestNode, ch: string) => n.daemon.core.getChannel(ch)!.members.find((m) => !m.me)!;
const meOf = (n: TestNode, ch: string) => n.daemon.core.getChannel(ch)!.members.find((m) => m.me)!;

test("presence: peers online/offline with lastSeen, live events, our own relay state, and unknown while disconnected", async () => {
  const t = tempDir();
  const port = await freePort();
  let relay: Awaited<ReturnType<typeof relayAt>> | undefined = await relayAt(t.dir, port);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    const events: DaemonEvent[] = [];
    A.daemon.events.subscribe((e) => events.push(e));
    await waitFor(() => peerOf(A, ch).presence === "online", "A sees Bob online");
    assert.equal(peerOf(B, ch).presence, "online", "the joiner sees the creator online too");
    assert.equal(meOf(A, ch).presence, "online");
    const st = A.daemon.apiState() as { relays: Record<string, unknown>[] };
    assert.equal(st.relays.length, 1);
    assert.equal(st.relays[0]!.state, "connected");
    assert.equal(st.relays[0]!.connected, true);
    assert.deepEqual(st.relays[0]!.features, ["presence", "ephemeral"]);
    assert.ok(typeof st.relays[0]!.lastConnectedAt === "number");

    const bobId = peerOf(A, ch).id;
    const before = Date.now();
    await B.daemon.stop();
    const off = await waitFor(
      () => events.find((e): e is Extract<DaemonEvent, { type: "presence" }> => e.type === "presence" && e.presence === "offline"),
      "offline event",
    );
    assert.equal(off.ch, ch);
    assert.equal(off.id, bobId);
    assert.ok(off.lastSeen! >= before);
    assert.equal(peerOf(A, ch).presence, "offline");
    assert.equal(peerOf(A, ch).lastSeen, off.lastSeen);

    await B.restart();
    await waitFor(() => events.some((e) => e.type === "presence" && e.presence === "online"), "online event");
    assert.equal(peerOf(A, ch).presence, "online");

    // Our own connection drops: we can't tell anything about peers, and we show ourselves offline.
    await relay.close();
    relay = undefined;
    await waitFor(() => events.some((e) => e.type === "relay" && !e.connected && (e.state === "waiting" || e.state === "connecting")), "relay down event");
    assert.equal(peerOf(A, ch).presence, "unknown");
    assert.equal(meOf(A, ch).presence, "offline");
    const down = (A.daemon.apiState() as { relays: Record<string, unknown>[] }).relays[0]!;
    assert.equal(down.connected, false);
    relay = await relayAt(t.dir, port);
    await waitFor(() => peerOf(A, ch).presence === "online", "fresh presence after the reconnect", 10_000);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay?.close();
    t.cleanup();
  }
});

test("status is ephemeral: pushed live, never queued in the outbox or stored for later", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    const seen: DaemonEvent[] = [];
    B.daemon.events.subscribe((e) => seen.push(e));
    const replyTo = A.daemon.sendHuman(ch, "a message to work on").id;
    A.daemon.core.sendStatus!(ch, { replyTo, state: "working", activity: "Thinking…" });
    await waitFor(() => seen.some((e) => e.type === "status" && e.activity === "Thinking…"), "B sees the status");
    const queued = A.daemon.db.prepare("SELECT count(*) AS n FROM outbox WHERE type = 'status'").get() as { n: number };
    assert.equal(queued.n, 0, "not in the durable outbox");
    // B restarts: the status is not delivered again (it was never stored).
    await B.restart();
    const later: DaemonEvent[] = [];
    B.daemon.events.subscribe((e) => later.push(e));
    const ping = A.daemon.sendHuman(ch, "after restart");
    await waitFor(() => B.agent().peerChats.some((c) => c.id === ping.id), "B caught up");
    assert.equal(later.filter((e) => e.type === "status").length, 0);
    assert.equal(B.daemon.db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'status'").get()!.n, 0);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("an older relay (no presence, no ephemeral): presence is unknown, and status still arrives (stored path)", async () => {
  const t = tempDir();
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    dbPath: join(t.dir, "relay.sqlite"),
    log: quietLog,
    features: { presence: false, ephemeral: false },
  });
  const { A, B, ch } = await pair(t, relay.url);
  try {
    assert.equal(peerOf(A, ch).presence, "unknown");
    assert.equal(peerOf(A, ch).lastSeen, undefined);
    assert.equal(meOf(A, ch).presence, "online");
    assert.deepEqual((A.daemon.apiState() as { relays: { features: string[] }[] }).relays[0]!.features, []);
    const seen: DaemonEvent[] = [];
    B.daemon.events.subscribe((e) => seen.push(e));
    const replyTo = A.daemon.sendHuman(ch, "work on this").id;
    A.daemon.core.sendStatus!(ch, { replyTo, state: "working", activity: "Using t3code · thread read" });
    await waitFor(() => seen.some((e) => e.type === "status" && e.activity === "Using t3code · thread read"), "B sees the status");
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("typing uses the ephemeral relay and HTTP validates and throttles", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    const seen: DaemonEvent[] = [];
    B.daemon.events.subscribe(e => seen.push(e));
    const post = (channel: string, active: unknown) => fetch(`http://127.0.0.1:${A.daemon.port}/api/channels/${channel}/typing`, {
      method: "POST", headers: { "X-Spencer-Token": A.daemon.token, "Content-Type": "application/json" }, body: JSON.stringify({ active }),
    });
    assert.equal((await post("unknown", true)).status, 404);
    assert.equal((await post(ch, "yes")).status, 400);
    assert.equal((await post(ch, true)).status, 200);
    await waitFor(() => seen.some(e => e.type === "typing" && e.active), "typing received");
    await post(ch, true);
    await post(ch, false);
    await waitFor(() => seen.some(e => e.type === "typing" && !e.active), "typing stopped");
    assert.equal(seen.filter(e => e.type === "typing" && e.active).length, 1);
    await post(ch, true);
    await post(ch, false);
    await waitFor(() => seen.filter(e => e.type === "typing" && !e.active).length === 2, "second typing stop");
    assert.deepEqual(seen.filter(e => e.type === "typing").map(e => e.active), [true, false, true, false]);
    assert.equal(B.daemon.db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'typing'").get()!.n, 0);
    assert.equal(B.agent().peerChats.length, 0);
  } finally {
    await A.daemon.stop(); await B.daemon.stop(); await relay.close(); t.cleanup();
  }
});


test("typing is never sent to a legacy relay", async () => {
  const t = tempDir();
  const dbPath = join(t.dir, "relay.sqlite");
  const relay = await startRelay({ host: "127.0.0.1", port: 0, dbPath, log: quietLog, features: { presence: false, ephemeral: false } });
  const { A, B, ch } = await pair(t, relay.url);
  try {
    await B.daemon.stop();
    const db = new DatabaseSync(dbPath);
    const before = db.prepare("SELECT count(*) AS n FROM messages").get()!.n;
    A.daemon.core.sendTyping(ch, true);
    A.daemon.core.sendTyping(ch, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get()!.n, before);
    db.close();
  } finally { await A.daemon.stop(); await B.daemon.stop(); await relay.close(); t.cleanup(); }
});


test("durable typing never inserts a message and still advances and acknowledges the relay sequence", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    B.daemon.db.exec(`
      CREATE TEMP TABLE typing_inserts (id TEXT);
      CREATE TEMP TRIGGER record_typing_insert AFTER INSERT ON messages WHEN NEW.type = 'typing'
      BEGIN INSERT INTO typing_inserts VALUES (NEW.id); END;
    `);
    const seen: DaemonEvent[] = [];
    B.daemon.events.subscribe(e => seen.push(e));
    const info = A.daemon.channels.info(ch)!;
    const env = sealEnvelope(loadOrCreateIdentity(A.dir), ch, info.encKey, { type: "typing", active: true });
    const ack = await A.daemon.pool.get(relay.url).request({ t: "send", env });
    await waitFor(() => seen.some(e => e.type === "typing"), "durable typing event");
    assert.equal(B.daemon.db.prepare("SELECT count(*) AS n FROM typing_inserts").get()!.n, 0, "no insert, even transiently");
    assert.equal(B.daemon.channels.row(ch)!.last_seq, ack.seq);
    assert.ok(typeof ack.seq === "number");
    const seq = ack.seq;
    assert.equal(B.agent().peerChats.length, 0);
    const relayDb = new DatabaseSync(join(t.dir, "relay.sqlite"));
    try {
      await waitFor(() => relayDb.prepare("SELECT count(*) AS n FROM messages WHERE ch = ? AND seq = ?").get(ch, seq)!.n === 0, "typing sequence acknowledged");
    } finally { relayDb.close(); }
  } finally { await A.daemon.stop(); await B.daemon.stop(); await relay.close(); t.cleanup(); }
});

test("typing rejects stale and future timestamps on ephemeral and durable delivery", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    const seen: DaemonEvent[] = [];
    B.daemon.events.subscribe(e => seen.push(e));
    const info = A.daemon.channels.info(ch)!;
    const me = loadOrCreateIdentity(A.dir);
    for (const ephemeral of [true, false]) {
      seen.length = 0;
      for (const ts of [Date.now() - 15_000, Date.now() + 60_000, Date.now() + 3000]) {
        await A.daemon.pool.get(relay.url).request({ t: "send", ephemeral, env: sealEnvelope(me, ch, info.encKey, { type: "typing", active: true }, { ts }) });
      }
      await A.daemon.pool.get(relay.url).request({ t: "send", ephemeral, env: sealEnvelope(me, ch, info.encKey, { type: "typing", active: false }) });
      await waitFor(() => seen.some(e => e.type === "typing" && !e.active), "typing barrier");
      assert.deepEqual(seen.filter(e => e.type === "typing").map(e => e.active), [true, false], `ephemeral=${ephemeral}`);
    }
  } finally { await A.daemon.stop(); await B.daemon.stop(); await relay.close(); t.cleanup(); }
});
