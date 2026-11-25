import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChannelManager } from "../../spencer/src/channels.ts";
import { Sql } from "../../spencer/src/store/db.ts";
import { timelineItems } from "../public/timeline-order.js";
import { maxMessageSequence, setMessages, upsertMessage, S } from "../public/state.js";

const message = (id, ts, seq, replyTo) => ({ id, ts, seq, replyTo, type: "chat" });

test("live state preserves empty, ordinary, and very large message history behavior", (t) => {
  assert.equal(maxMessageSequence([]), 0);
  assert.equal(maxMessageSequence([
    { seq: undefined }, { seq: null }, { seq: Number.NaN }, { seq: Infinity },
    { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: -1 },
  ]), 0);
  assert.equal(maxMessageSequence([
    { seq: 2 }, { seq: undefined }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: 7 },
  ]), 7);

  const channels = ["max-seq-empty", "max-seq-ordinary", "max-seq-large"];
  t.after(() => channels.forEach((ch) => S.messages.delete(ch)));

  setMessages(channels[0], []);
  upsertMessage(channels[0], { ...message("empty-first", 0, 1), mine: true });
  assert.deepEqual(S.messages.get(channels[0]).map((m) => m.id), ["empty-first"]);

  setMessages(channels[1], [
    { ...message("seq-2", 0, 2), mine: true },
    { ...message("seq-4", 0, 4), mine: true },
  ]);
  upsertMessage(channels[1], { ...message("seq-3", 0, 3), mine: true });
  assert.deepEqual(S.messages.get(channels[1]).map((m) => m.id), ["seq-2", "seq-3", "seq-4"]);

  const count = 150_000;
  setMessages(channels[2], Array.from({ length: count }, (_, index) => ({
    id: `large-${index + 1}`, ts: index, seq: index + 1, type: "chat", mine: true,
  })));
  upsertMessage(channels[2], { id: `large-${count + 1}`, ts: count, seq: count + 1, type: "chat", mine: true });
  const largeHistory = S.messages.get(channels[2]);
  assert.equal(largeHistory.length, count + 1);
  assert.equal(largeHistory.at(-1).id, `large-${count + 1}`);
});

test("large acknowledgements reorder loaded messages without spreading function arguments", (t) => {
  const ch = "timeline-large-ack";
  t.after(() => S.messages.delete(ch));
  const count = 150_000;
  setMessages(ch, Array.from({ length: count }, (_, index) => ({
    id: `m${index}`, seq: index + 1, ts: index, type: "chat", mine: true,
  })));
  const loaded = S.messages.get(ch);

  upsertMessage(ch, { id: "m0", seq: count + 1, ts: 0, type: "chat", mine: true });

  const current = S.messages.get(ch);
  assert.strictEqual(current, loaded, "acknowledgement preserves the UI's array identity");
  assert.equal(current.length, count);
  assert.equal(current[0].id, "m1");
  assert.equal(current.at(-1).id, "m0");
  assert.equal(current.at(-1).seq, count + 1);
});

test("large out-of-order replays reorder loaded messages without spreading function arguments", (t) => {
  const ch = "timeline-large-replay";
  t.after(() => S.messages.delete(ch));
  const count = 150_000;
  setMessages(ch, Array.from({ length: count }, (_, index) => ({
    id: `m${index}`, seq: index + 2, ts: index, type: "chat", mine: true,
  })));
  const loaded = S.messages.get(ch);

  upsertMessage(ch, { id: "replay", seq: 1, ts: 0, type: "chat", mine: true });

  const current = S.messages.get(ch);
  assert.strictEqual(current, loaded, "replay preserves the UI's array identity");
  assert.equal(current.length, count + 1);
  assert.equal(current[0].id, "replay");
  assert.equal(current[1].id, "m0");
  assert.equal(current.at(-1).id, `m${count - 1}`);
});

test("large pending reply blocks move ahead of their replay without argument spreading", (t) => {
  const ch = "timeline-large-pending-block";
  t.after(() => S.messages.delete(ch));
  const count = 150_000;
  setMessages(ch, [
    { id: "later", seq: 2, ts: 0, type: "chat", mine: true },
    ...Array.from({ length: count }, (_, index) => ({
      id: `pending-${index}`, ts: index, type: "chat", mine: true,
    })),
    { id: "parent", ts: count, type: "chat", mine: true },
  ]);
  const loaded = S.messages.get(ch);

  upsertMessage(ch, { id: "reply", seq: 1, replyTo: "parent", ts: 0, type: "chat", mine: true });

  const current = S.messages.get(ch);
  assert.strictEqual(current, loaded, "reply reordering preserves the UI's array identity");
  assert.equal(current.length, count + 3);
  assert.equal(current[0].id, "pending-0");
  assert.equal(current[count - 1].id, `pending-${count - 1}`);
  assert.equal(current[count].id, "parent");
  assert.equal(current[count + 1].id, "reply");
  assert.equal(current[count + 2].id, "later");
});

test("API and WebUI keep visible message slots consistent when relay rows are omitted", (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, ch TEXT, seq INTEGER, from_id TEXT, ts INTEGER, type TEXT, body TEXT,
    mine INTEGER, status TEXT, origin TEXT, note TEXT, routed INTEGER, created_at INTEGER
  ); CREATE TABLE members (ch TEXT, id TEXT, name TEXT);`);
  const sql = new Sql(db);
  const previousDocument = globalThis.document;
  t.after(() => {
    S.messages.delete("hidden-row-channel");
    S.messages.delete("partial-page-order");
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    db.close();
  });
  const channels = new ChannelManager({
    sql,
    me: { id: "local" },
    config: () => ({ name: "Local" }),
    pool: () => ({}),
    outbox: () => ({}),
    events: { emit: () => {} },
    log: () => {},
    channelChanged: () => {},
  });
  const insert = db.prepare("INSERT INTO messages (id,ch,seq,from_id,ts,type,body,mine,status,origin,note,routed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("a", "hidden-row-channel", 3, "local", 30, "chat", "{}", 1, "sent", "human", null, 1, 30);
  insert.run("pending", "hidden-row-channel", null, "local", 0, "chat", "{}", 1, "pending", "human", null, 1, 31);
  insert.run("hidden-status", "hidden-row-channel", 1, "peer", 10, "status", "{}", 0, "received", "peer", null, 1, 32);
  insert.run("b", "hidden-row-channel", 2, "peer", 20, "chat", "{}", 0, "received", "peer", null, 1, 33);

  globalThis.document = { visibilityState: "hidden" };
  setMessages("hidden-row-channel", [message("a", 30, 3), { ...message("pending", 0, undefined), mine: true }]);
  upsertMessage("hidden-row-channel", { ...message("b", 20, 2), mine: false });
  assert.deepEqual(S.messages.get("hidden-row-channel").map((m) => m.id), ["b", "pending", "a"]);
  assert.deepEqual(channels.messages("hidden-row-channel", 100, undefined, ["chat", "hello"]).map((m) => m.id), ["b", "pending", "a"]);

  const pageChannel = "partial-page-order";
  insert.run("page-seq5", pageChannel, 5, "peer", 50, "chat", "{}", 0, "received", "peer", null, 1, 50);
  insert.run("page-pending", pageChannel, null, "local", 0, "chat", "{}", 1, "pending", "human", null, 1, 51);
  insert.run("page-seq4", pageChannel, 4, "peer", 40, "chat", "{}", 0, "received", "peer", null, 1, 52);
  const page = channels.messages(pageChannel, 2, undefined, ["chat", "hello"]);
  assert.deepEqual(page.map((m) => m.id), ["page-pending", "page-seq5"]);
  setMessages(pageChannel, page);
  assert.deepEqual(S.messages.get(pageChannel).map((m) => m.id), ["page-pending", "page-seq5"], "the UI preserves the API's global order at a page boundary");
  insert.run("page-seq6", pageChannel, 6, "peer", 60, "chat", "{}", 0, "received", "peer", null, 1, 53);
  upsertMessage(pageChannel, channels.message("page-seq6"));
  const afterLiveMessage = ["page-pending", "page-seq5", "page-seq6"];
  assert.deepEqual(S.messages.get(pageChannel).map((m) => m.id), afterLiveMessage, "a newer live event preserves the loaded page's existing boundary");
  assert.deepEqual(channels.messages(pageChannel, 3).map((m) => m.id), afterLiveMessage);
  assert.deepEqual(channels.messages(pageChannel, 2, page[0].id, ["chat", "hello"]).map((m) => m.id), ["page-seq4"]);
});

test("API and live state move the whole pending segment before a replayed reply", (t) => {
  const ch = "pending-segment";
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, ch TEXT, seq INTEGER, from_id TEXT, ts INTEGER, type TEXT, body TEXT,
    mine INTEGER, status TEXT, origin TEXT, note TEXT, routed INTEGER, created_at INTEGER
  ); CREATE TABLE members (ch TEXT, id TEXT, name TEXT);`);
  const sql = new Sql(db);
  const channels = new ChannelManager({
    sql, me: { id: "local" }, config: () => ({ name: "Local" }), pool: () => ({}), outbox: () => ({}),
    events: { emit: () => {} }, log: () => {}, channelChanged: () => {},
  });
  const insert = db.prepare("INSERT INTO messages (id,ch,seq,from_id,ts,type,body,mine,status,origin,note,routed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const row = (id, seq, body = "{}") => insert.run(id, ch, seq, id === "later" ? "local" : "peer", 1, "chat", body, id === "later" ? 1 : 0, seq === null ? "pending" : "received", "human", null, 1, 1);
  row("later", 5);
  row("parent", null);
  row("other", null);
  row("reply", 4, JSON.stringify({ replyTo: "parent" }));

  const previousDocument = globalThis.document;
  t.after(() => {
    S.messages.delete(ch);
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    db.close();
  });
  globalThis.document = { visibilityState: "hidden" };
  setMessages(ch, [
    { ...message("later", 1, 5), mine: true, timelineSlot: 1 },
    { ...message("parent", 1, undefined), mine: true, timelineSlot: 2 },
    { ...message("other", 1, undefined), mine: true, timelineSlot: 3 },
  ]);
  upsertMessage(ch, { ...message("reply", 1, 4, "parent"), mine: false, timelineSlot: 4 });
  const expected = ["parent", "other", "reply", "later"];
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), expected, "live replay moves the pending block, not just its causal parent");
  const initialApi = channels.messages(ch, 100, undefined, ["chat", "hello"]);
  assert.equal(channels.message("reply")?.timelineSlot, 4, "message events carry the persistent slot used by live state");
  assert.deepEqual(initialApi.map((m) => m.id), expected, "API reload preserves the live block ordering");
  assert.deepEqual(initialApi.map((m) => [m.id, m.timelineSlot]), [
    ["parent", 2], ["other", 3], ["reply", 4], ["later", 1],
  ]);

  db.prepare("UPDATE messages SET seq = 3, status = 'sent' WHERE id = ?").run("parent");
  upsertMessage(ch, { ...message("parent", 2, 3), mine: true, status: "sent", timelineSlot: 2 });
  const acknowledged = ["parent", "reply", "other", "later"];
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), acknowledged, "an acknowledgement reuses the original database slots");
  const acknowledgedApi = channels.messages(ch, 100, undefined, ["chat", "hello"]);
  assert.deepEqual(acknowledgedApi.map((m) => m.id), acknowledged, "the acknowledged live order matches API reload");
});

test("group replies stay after their relay-ordered parent when sender clocks differ", () => {
  const mention = message("mention", 20_000, 1);
  const reply = message("reply", 10_000, 2, mention.id);

  const items = timelineItems([mention, reply], []);
  assert.deepEqual(items.map(({ m }) => m.id), ["mention", "reply"]);
  assert.deepEqual(items.map((item) => item.ts), [mention.ts, reply.ts], "date separators use each displayed message's truthful timestamp");
});

test("message order is stable across equal timestamps and transfer cards keep their timestamp slot", () => {
  const earlier = message("earlier", 10_000, 1);
  const later = message("later", 10_000, 2, earlier.id);
  const transfer = { tid: "transfer", createdAt: 10_000 };

  const items = timelineItems([earlier, later], [transfer]);
  assert.deepEqual(items.map((item) => item.m?.id ?? item.t?.tid), ["earlier", "later", "transfer"]);
  assert.deepEqual(items.filter((item) => item.m).map((item) => item.m.ts), [10_000, 10_000], "displayed sender timestamps are unchanged");
});

test("transfer anchors are reconstructed from sequence and timestamps", () => {
  const parent = message("parent", 20_000, 1);
  const reply = message("reply", 10_000, 2, parent.id);
  const transfer = { tid: "between", createdAt: 15_000 };
  const items = timelineItems([parent, reply], [transfer]);

  assert.deepEqual(items.map((item) => item.m?.id ?? item.t?.tid), ["between", "parent", "reply"]);
  assert.deepEqual(items.filter((item) => item.m).map((item) => item.m.ts), [20_000, 10_000]);
  assert.deepEqual(items.filter((item) => item.m).map((item) => item.ts), [20_000, 10_000], "day separators follow the displayed message timestamp");
});

test("a replayed reply stays after its unsequenced parent when an earlier seq arrives late", () => {
  const ch = "timeline-late-reply";
  globalThis.document = { visibilityState: "hidden" };
  setMessages(ch, [message("later", 500, 5), message("parent", 400, undefined)]);
  upsertMessage(ch, { ...message("reply", 300, 4, "parent"), mine: false });
  assert.deepEqual(timelineItems(S.messages.get(ch), []).map((item) => item.m.id), ["parent", "reply", "later"]);
  delete globalThis.document;
});

test("transfer anchors survive older-page prepends and a module reload", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const second = message("seq2", 100, 2);
  const third = message("seq3", 200, 3);
  const transfer = { tid: "persisted-transfer-anchor", ch: "anchor-channel", createdAt: 150 };
  assert.deepEqual(timelineItems([second, third], [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["seq2", "persisted-transfer-anchor", "seq3"]);

  const older = message("seq1-skewed", 175, 1);
  const expanded = timelineItems([older, second, third], [transfer]);
  const expected = ["seq1-skewed", "seq2", "persisted-transfer-anchor", "seq3"];
  assert.deepEqual(expanded.map((item) => item.m?.id ?? item.t?.tid), expected);
  const reloadedModule = await import(`../public/timeline-order.js?reload=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems([older, second, third], [transfer]).map((item) => item.m?.id ?? item.t?.tid), expected);
});

test("transfer anchors defer incomplete history boundaries until older pages are loaded", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "deferred-boundary", ch: "deferred-channel", createdAt: 5 };
  const newest = message("newest", 100, 3);
  assert.deepEqual(timelineItems([newest], [transfer], false).map((item) => item.m?.id ?? item.t?.tid), ["deferred-boundary", "newest"]);
  assert.equal(values.size, 1, "a provisional edge is retained for stable live updates");
  assert.equal(JSON.parse(values.values().next().value).provisional, true, "the cached boundary is explicitly provisional");

  const older = message("older", 10, 2);
  assert.deepEqual(timelineItems([older, newest], [transfer], false, true).map((item) => item.m?.id ?? item.t?.tid), ["deferred-boundary", "older", "newest"]);
  assert.equal(values.size, 1, "the refined boundary remains provisional while more history may exist");
  assert.equal(JSON.parse(values.values().next().value).windowFirstId, "older");

  const oldest = message("oldest", 0, 1);
  const complete = [oldest, older, newest];
  const expected = ["oldest", "deferred-boundary", "older", "newest"];
  assert.deepEqual(timelineItems(complete, [transfer], true).map((item) => item.m?.id ?? item.t?.tid), expected);
  assert.equal(JSON.parse(values.values().next().value).provisional, undefined, "complete history promotes the boundary to a durable anchor");
  const reloadedModule = await import(`../public/timeline-order.js?boundary=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems(complete, [transfer], true).map((item) => item.m?.id ?? item.t?.tid), expected);
});

test("provisional transfer anchors stay put on live events and refine when older history arrives", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "partial-live-anchor", ch: "partial-live-channel", createdAt: 50 };
  const first = message("partial-a", 10, 1);
  const second = message("partial-b", 20, 2);
  const initial = timelineItems([first, second], [transfer], false);
  assert.deepEqual(initial.map((item) => item.m?.id ?? item.t?.tid), ["partial-a", "partial-b", "partial-live-anchor"]);
  const reloadedModule = await import(`../public/timeline-order.js?partial-live=${Date.now()}`);

  const skewedNew = message("partial-c", 0, 3);
  const live = reloadedModule.timelineItems([first, second, skewedNew], [transfer], false);
  assert.deepEqual(live.map((item) => item.m?.id ?? item.t?.tid), ["partial-a", "partial-b", "partial-live-anchor", "partial-c"]);

  const older = message("partial-older", 60, 0);
  const expanded = reloadedModule.timelineItems([older, first, second, skewedNew], [transfer], false, true);
  assert.deepEqual(expanded.map((item) => item.m?.id ?? item.t?.tid), ["partial-live-anchor", "partial-older", "partial-a", "partial-b", "partial-c"]);
});

test("transfer anchors recompute when their unsequenced target is outside the loaded page", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "pending-anchor", ch: "pending-anchor-channel", createdAt: 10 };
  const before = [message("before-1", 0, 1), message("before-2", 5, 2)];
  const pending = message("pending", 20, undefined);
  const full = [...before, pending];
  assert.deepEqual(timelineItems(full, [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["before-1", "before-2", "pending-anchor", "pending"]);

  // The target's relay position can change after it receives a sequence. On reload it is
  // outside the latest page, so use the page's current boundary rather than a stale rank.
  const firstPage = [message("page-2", 15, 3), message("page-3", 20, 4), message("page-4", 30, 5)];
  const reloadedModule = await import(`../public/timeline-order.js?pending-anchor=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems(firstPage, [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["pending-anchor", "page-2", "page-3", "page-4"]);
});

test("sequenced transfer anchors stay at their relay boundary on a newer partial page", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "relay-boundary", ch: "relay-boundary-channel", createdAt: 50 };
  const full = [message("a", 10, 1), message("b", 100, 2), message("c", 0, 3)];
  assert.deepEqual(timelineItems(full, [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["a", "relay-boundary", "b", "c"]);

  const reloadedModule = await import(`../public/timeline-order.js?relay-boundary=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems([full[2]], [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["relay-boundary", "c"]);
});

test("transfer anchors after a pending target keep their relay boundary when it is acknowledged", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "pending-ack-anchor", ch: "pending-ack-channel", createdAt: 30 };
  const accepted = message("accepted", 10, 2);
  const pending = message("pending-anchor", 20, undefined);
  assert.deepEqual(timelineItems([accepted, pending], [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["accepted", "pending-anchor", "pending-ack-anchor"]);

  const reloadedModule = await import(`../public/timeline-order.js?pending-ack=${Date.now()}`);
  const afterAck = [message("pending-anchor", 20, 1), message("accepted", 10, 2)];
  assert.deepEqual(reloadedModule.timelineItems(afterAck, [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["pending-anchor", "accepted", "pending-ack-anchor"]);
});

test("transfer anchored after a pending target stays after it when acknowledgement assigns the boundary sequence", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "ack-at-boundary", ch: "ack-boundary-channel", createdAt: 30 };
  const accepted = message("accepted-before-pending", 10, 1);
  const pending = message("pending-at-boundary", 20, undefined);
  assert.deepEqual(timelineItems([accepted, pending], [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["accepted-before-pending", "pending-at-boundary", "ack-at-boundary"]);

  const acknowledged = [accepted, message("pending-at-boundary", 20, 2)];
  const reloadedModule = await import(`../public/timeline-order.js?ack-boundary=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems(acknowledged, [transfer]).map((item) => item.m?.id ?? item.t?.tid), ["accepted-before-pending", "pending-at-boundary", "ack-at-boundary"]);
});

test("partial transfer anchor stays fixed when a replay changes the first loaded row", async (t) => {
  const values = new Map();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const transfer = { tid: "replay-does-not-expand-history", ch: "replay-anchor-channel", createdAt: 50 };
  const a = message("replay-anchor-a", 10, 1);
  const b = message("replay-anchor-b", 20, 2);
  assert.deepEqual(timelineItems([a, b], [transfer], false).map((item) => item.m?.id ?? item.t?.tid), ["replay-anchor-a", "replay-anchor-b", "replay-does-not-expand-history"]);

  const replay = message("lower-sequence-replay", 60, 0);
  const reloadedModule = await import(`../public/timeline-order.js?replay-anchor=${Date.now()}`);
  assert.deepEqual(reloadedModule.timelineItems([replay, a, b], [transfer], false).map((item) => item.m?.id ?? item.t?.tid), ["lower-sequence-replay", "replay-anchor-a", "replay-anchor-b", "replay-does-not-expand-history"]);
});

test("transfer anchors stay between the same messages when a skewed message arrives", () => {
  const first = message("first", 100, 1);
  const second = message("second", 200, 2);
  const late = message("late", 0, 3);
  const transfer = { tid: "stable-transfer", createdAt: 150 };
  const initial = timelineItems([first, second], [transfer]);
  assert.deepEqual(initial.map((item) => item.m?.id ?? item.t?.tid), ["first", "stable-transfer", "second"]);

  const updated = timelineItems([first, second, late], [transfer]);
  assert.deepEqual(updated.map((item) => item.m?.id ?? item.t?.tid), ["first", "stable-transfer", "second", "late"]);
  const reloaded = timelineItems([first, second, late], [transfer]);
  assert.deepEqual(reloaded.map((item) => item.m?.id ?? item.t?.tid), updated.map((item) => item.m?.id ?? item.t?.tid));
});

test("pending local rows keep a stable place until relay sequence arrives", () => {
  const ch = "timeline-channel";
  globalThis.document = { visibilityState: "hidden" };
  setMessages(ch, [message("first", 200, 1), message("second", 100, 2)]);
  upsertMessage(ch, { ...message("pending", 0, undefined), mine: true, status: "pending" });
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), ["first", "second", "pending"]);

  upsertMessage(ch, { ...message("reply", -100, 4, "pending"), mine: false });
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), ["first", "second", "pending", "reply"]);
  assert.deepEqual(timelineItems(S.messages.get(ch), []).map((item) => item.m.id), ["first", "second", "pending", "reply"]);

  upsertMessage(ch, { id: "pending", seq: 3, status: "sent" });
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), ["first", "second", "pending", "reply"]);
  assert.equal(S.messages.get(ch).length, 4, "local-to-ack transition updates rather than duplicates the message");
  delete globalThis.document;
});

test("pagination keeps an optimistic row loaded while its relay acknowledgement changes sequence", () => {
  const ch = "timeline-page-ack";
  globalThis.document = { visibilityState: "hidden" };
  setMessages(ch, [message("cursor", 20, 2), message("last-page-row", 30, 3)]);
  upsertMessage(ch, { ...message("pending-off-page", 0, undefined), mine: true, status: "pending" });
  upsertMessage(ch, { id: "pending-off-page", seq: 4, status: "sent" });
  setMessages(ch, [message("older-page", 10, 1), ...S.messages.get(ch)]);
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), ["older-page", "cursor", "last-page-row", "pending-off-page"]);
  assert.equal(new Set(S.messages.get(ch).map((m) => m.id)).size, 4);
  delete globalThis.document;
});

test("out-of-order replay events are inserted by sequence and duplicate replay is idempotent", () => {
  const ch = "timeline-replay";
  globalThis.document = { visibilityState: "hidden" };
  setMessages(ch, [message("one", 100, 1), message("three", 300, 3)]);
  upsertMessage(ch, { ...message("two-replayed", 50, 2), mine: false });
  assert.deepEqual(timelineItems(S.messages.get(ch), []).map((item) => item.m.id), ["one", "two-replayed", "three"]);
  upsertMessage(ch, { ...message("two-replayed", 50, 2), mine: false, status: "received" });
  assert.deepEqual(S.messages.get(ch).map((m) => m.id), ["one", "two-replayed", "three"]);
  assert.equal(S.messages.get(ch).length, 3);
  delete globalThis.document;
});
