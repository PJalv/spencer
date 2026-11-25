import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createEventsMcpServer } from "./fixtures/events-mcp-server.ts";
import { waitFor } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FollowupStore } from "../../src/agent/followups.ts";
import { isAuthRevocationError, McpManager } from "../../src/agent/mcp.ts";

test("event receipts are scoped to subscriptions and survive reopening", () => {
  const db = new DatabaseSync(":memory:");
  const store = new FollowupStore(db, { now: () => 100, onDue: async () => {} });
  store.init(); store.init();
  const f = store.insert({ conv: "owner", note: "watch", dueAt: 1000, depth: 0, watch: true, maxWakes: 3 });
  const [a, b] = store.insertEventSubscriptions(f.id, ["a", "b"].map((eventName) => ({ serverName: "s", eventName, argsJson: "{}" })));
  assert.ok(a && b);
  assert.equal(store.admitEvent({ subscriptionId: a.id, eventId: "1", cursor: "c", content: "first" }).admitted, true);
  assert.equal(store.admitEvent({ subscriptionId: a.id, eventId: "1", cursor: "c2", content: "duplicate" }).duplicate, true);
  assert.equal(store.subscription(a.id)?.cursor, "c2");
  assert.equal(store.admitEvent({ subscriptionId: a.id, eventId: "2", cursor: null, content: "null-cursor" }).admitted, true);
  assert.equal(store.subscription(a.id)?.cursor, "c2", "null cursor must never wipe a persisted cursor");
  assert.equal(store.hasUnclaimedUpdate(f.id), true);
  assert.equal(store.admitEvent({ subscriptionId: b.id, eventId: "1", content: "second" }).admitted, true);
  const reopened = new FollowupStore(db, { now: () => 100, onDue: async () => {} }); reopened.init();
  assert.equal(reopened.subscription(a.id)?.cursor, "c2");
  reopened.updateSubscriptionCursor(a.id, null, { heartbeat: true });
  assert.equal(reopened.subscription(a.id)?.cursor, "c2");
  assert.equal(reopened.claimUpdate(f.id)?.fired_by, "event");
  assert.equal(reopened.rearm(f.id), true);
  assert.equal(reopened.claimUpdate(f.id)?.wake_text, "null-cursor");
  assert.equal(reopened.rearm(f.id), true);
  assert.equal(reopened.claimUpdate(f.id)?.wake_text, "second");
  assert.equal(reopened.rearm(f.id), false);
  const f2 = reopened.insert({ conv: "owner", note: "gap", dueAt: 1000, depth: 0, watch: true, maxWakes: 2 });
  const [g] = reopened.insertEventSubscriptions(f2.id, [{ serverName: "s", eventName: "a", argsJson: "{}" }]);
  assert.equal(reopened.admitGap({ subscriptionId: g!.id, gapKey: "gap", cursor: null, content: "reconcile" }).admitted, true);
  assert.equal(reopened.admitGap({ subscriptionId: g!.id, gapKey: "gap", content: "reconcile" }).admitted, false);
  assert.equal(reopened.claimUpdate(f2.id)?.wake_text, "reconcile");
  assert.equal(reopened.finish(f.id, "done"), true);
  assert.equal(reopened.finish(f2.id, "done"), true);
  assert.equal(reopened.activeSubscriptions().length, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM mcp_event_receipts").get() as { n: number }).n, 0);
  db.close();
});

test("auth detection and event status hooks", async () => {
  assert.equal(isAuthRevocationError(new Error("outer", { cause: Object.assign(new Error("denied"), { code: 403 }) })), true);
  const manager = new McpManager({ server: { url: "http://localhost:1" } });
  let changes = 0; manager.onChange(() => changes++);
  assert.equal(manager.status()[0]?.events, undefined);
  manager.setEventsStatus("server", { status: "supported" });
  manager.setEventsStatus("server", { status: "supported" });
  assert.equal(changes, 1);
  manager.markRevoked("server", "denied");
  assert.equal(manager.httpServers()[0]?.revoked, true);
  await manager.stop();
});

test("legacy queued reply migrates fired_by before claimUpdate", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new FollowupStore(db, { now: () => 100, onDue: async () => {} });
    store.init();
    const f = store.insert({ conv: "owner", note: "legacy", dueAt: 1000, depth: 0, watch: true });
    db.exec(`DROP TABLE agent_watch_updates;
      CREATE TABLE agent_watch_updates (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, followup_id TEXT NOT NULL,
        msg_id TEXT NOT NULL, content TEXT NOT NULL, final INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0, UNIQUE(followup_id, msg_id)
      )`);
    db.prepare("INSERT INTO agent_watch_updates (followup_id, msg_id, content, final) VALUES (?, ?, ?, 0)").run(f.id, "legacy-reply", "stored before upgrade");
    store.init(); store.init();
    const claimed = store.claimUpdate(f.id)!;
    assert.equal(claimed.fired_by, "reply");
    assert.equal(claimed.wake_text, "stored before upgrade");
    assert.equal(claimed.wake_count, 1);
  } finally { db.close(); }
});

test("closing and reopening a SQLite file preserves event cursor, receipts, and queued wake", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-event-recovery-"));
  const path = join(dir, "events.db");
  let db = new DatabaseSync(path);
  try {
    const store = new FollowupStore(db, { now: () => 100, onDue: async () => {} }); store.init();
    const f = store.insert({ conv: "owner", note: "recover", dueAt: 1000, depth: 0, watch: true });
    const sub = store.insertEventSubscriptions(f.id, [{ serverName: "t3code", eventName: "thread.run_settled", argsJson: "{}" }])[0]!;
    assert.equal(store.admitEvent({ subscriptionId: sub.id, eventId: "evt-file", cursor: "epoch.42", content: "durable event" }).admitted, true);
    db.close(); db = new DatabaseSync(path);
    const reopened = new FollowupStore(db, { now: () => 100, onDue: async () => {} }); reopened.init();
    assert.equal(reopened.subscription(sub.id)?.cursor, "epoch.42");
    assert.equal(reopened.admitEvent({ subscriptionId: sub.id, eventId: "evt-file", cursor: "epoch.42", content: "duplicate" }).duplicate, true);
    const claimed = reopened.claimUpdate(f.id)!;
    assert.equal(claimed.wake_text, "durable event"); assert.equal(claimed.fired_by, "event");
    assert.equal(claimed.wake_count, 1); assert.equal(reopened.rearm(f.id), true);
    assert.equal(reopened.claimUpdate(f.id), undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const final of [false, true]) {
  test(`${final ? "final reply" : "due_at expiry"} prevents rearm`, () => {
    const db = new DatabaseSync(":memory:"); let now = 100;
    try {
      const store = new FollowupStore(db, { now: () => now, onDue: async () => {} }); store.init();
      const f = store.insert({ conv: "owner", note: "stop", dueAt: 200, depth: 0, watch: true });
      assert.equal(store.enqueueUpdate(f.id, "reply", "finished", final), true);
      assert.ok(store.claimUpdate(f.id));
      if (!final) now = 200;
      assert.equal(store.rearm(f.id), false);
    } finally { db.close(); }
  });
}

for (const status of [401, 403, 503]) {
  test(`McpManager HTTP ${status} ${status === 503 ? "retries" : "stops retrying until credentials change"}`, async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
      requests++;
      for await (const _chunk of req) { /* drain the local request */ }
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: "fixture failure" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const manager = new McpManager({ local: { url: `http://127.0.0.1:${address.port}/mcp` } });
    let healthy: Awaited<ReturnType<typeof createEventsMcpServer>> | undefined;
    try {
      manager.start(); await manager.settled();
      assert.equal(manager.status()[0]?.status, "error");
      if (status === 503) {
        assert.equal(manager.httpServers()[0]?.revoked, false);
        await waitFor(() => requests >= 2, "retry after 503", 1800);
      } else {
        assert.equal(manager.httpServers()[0]?.revoked, true);
        assert.equal(requests, 1);
        await delay(1250); assert.equal(requests, 1);
        healthy = await createEventsMcpServer({ authToken: "updated-token" });
        await manager.set("local", { url: healthy.url, headers: { Authorization: "Bearer updated-token" } });
        await manager.settled();
        assert.equal(manager.httpServers()[0]?.revoked, false);
        assert.equal(manager.status()[0]?.status, "connected");
        assert.ok(healthy.requestLog.some(r => r.method === "initialize" && r.headers.authorization === "Bearer updated-token"));
      }
    } finally {
      await manager.stop(); await healthy?.close(); server.closeAllConnections(); server.close(); await once(server, "close");
    }
  });
}
