import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import WebSocket from "ws";
import { http, relayAt, startNode, tempDir, waitFor, type TestNode } from "./helpers.ts";

async function messages(node: TestNode, ch: string) {
  const response = await http(node.daemon.port, "GET", `/api/channels/${ch}/messages?limit=100`, {
    headers: { "X-Spencer-Token": node.daemon.token },
  });
  assert.equal(response.status, 200, response.text);
  return response.json().items;
}

function openEvents(node: TestNode): Promise<{ ws: WebSocket; events: any[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${node.daemon.port}/api/events?token=${node.daemon.token}`);
  const events: any[] = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, events }));
    ws.once("error", reject);
  });
}

async function waitForAsync<T>(fn: () => Promise<T | undefined>, what: string): Promise<T> {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("group mention and reply keep relay order through local outbox, inbox, API, and WebSocket", async () => {
  const t = tempDir("spencer-group-order-");
  const relay = await relayAt(t.dir);
  let A: TestNode | undefined;
  let B: TestNode | undefined;
  let C: TestNode | undefined;
  const sockets: WebSocket[] = [];
  let releaseHeldAck = () => {};
  let restoreRelayRequest: (() => void) | undefined;
  try {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 86_400_000;
      A = await startNode(join(t.dir, "alice"), relay.url, "Alice");
    } finally {
      Date.now = realNow;
    }
    B = await startNode(join(t.dir, "bob"), relay.url, "Bob");
    C = await startNode(join(t.dir, "carol"), relay.url, "Carol");
    const invited = (await http(A.daemon.port, "POST", "/api/invites", {
      headers: { "X-Spencer-Token": A.daemon.token }, body: { kind: "group", name: "Ordering" },
    })).json();
    const ch = invited.channel.id as string;
    assert.equal((await http(B.daemon.port, "POST", "/api/invites/accept", {
      headers: { "X-Spencer-Token": B.daemon.token }, body: { link: invited.link },
    })).status, 200);
    assert.equal((await http(C.daemon.port, "POST", "/api/invites/accept", {
      headers: { "X-Spencer-Token": C.daemon.token }, body: { link: invited.link },
    })).status, 200);
    await waitFor(() => A!.daemon.core.getChannel(ch)?.members.length === 3, "group membership");

    const aEvents = await openEvents(A);
    const bEvents = await openEvents(B);
    sockets.push(aEvents.ws, bEvents.ws);

    await waitFor(() => {
      const row = A!.daemon.db.prepare("SELECT count(*) AS n FROM outbox WHERE ch = ? AND state = 'pending'").get(ch) as { n: number };
      return row.n === 0;
    }, "group setup outbox drain");
    const conn = A.daemon.pool.peek(relay.url)!;
    const originalRequest = conn.request.bind(conn);
    let release!: () => void;
    let held!: () => void;
    const ackGate = new Promise<void>((resolve) => { release = resolve; });
    const ackHeld = new Promise<void>((resolve) => { held = resolve; });
    let captured = false;
    (conn as any).request = async (frame: any, ...args: any[]) => {
      const result = await originalRequest(frame, ...args);
      if (!captured && frame.t === "send" && frame.env?.ch === ch && !frame.ephemeral) {
        captured = true;
        held();
        await ackGate;
      }
      return result;
    };
    releaseHeldAck = release;
    restoreRelayRequest = () => { (conn as any).request = originalRequest; };
    const ackEventStart = aEvents.events.length;

    // Alice's outbox clock is one day ahead. Hold the relay's send response after it
    // broadcasts the message, so Bob can reply while Alice's durable row is still pending.
    const sent = await http(A.daemon.port, "POST", `/api/channels/${ch}/messages`, {
      headers: { "X-Spencer-Token": A.daemon.token },
      body: { text: "@Bob please take a look", mentions: [B.daemon.identity.id] },
    });
    assert.equal(sent.status, 200, sent.text);
    const mentionId = sent.json().id as string;

    await waitForAsync(async () => {
      const items = await messages(B!, ch);
      return items.some((m: any) => m.id === mentionId && m.mentions?.includes(B!.daemon.identity.id)) ? true : undefined;
    }, "Bob's persisted mentioned message");
    await ackHeld;
    const relayParent = (await messages(B, ch)).find((m: any) => m.id === mentionId);
    assert.ok(Number.isSafeInteger(relayParent?.seq), "Bob receives the accepted parent while Alice's send response is held");
    const localParent = (await messages(A, ch)).find((m: any) => m.id === mentionId);
    assert.equal(localParent?.seq, undefined);
    assert.equal(localParent?.status, "pending");
    const reply = B.daemon.core.sendChat(ch, {
      text: "Reply to Alice",
      hop: 1,
      by: "agent",
      origin: "agent-reply",
      replyTo: mentionId,
      mentions: [A.daemon.identity.id],
    });

    const transcript = await waitForAsync(async () => {
      const items = await messages(A!, ch);
      return items.some((m: any) => m.id === reply.id) ? items : undefined;
    }, "Bob's reply in Alice's persisted transcript");
    const pair = transcript.filter((m: any) => m.id === mentionId || m.replyTo === mentionId);
    assert.deepEqual(pair.map((m: any) => m.id), [mentionId, reply.id]);
    assert.equal(pair[0].seq, undefined, "the parent is still awaiting its local relay acknowledgement");
    assert.equal(pair[1].seq, relayParent!.seq + 1, "relay assigns the reply the next channel sequence");
    assert.ok(pair[1].ts < pair[0].ts, "the synthetic sender clock skew is present");
    assert.deepEqual((await messages(B, ch)).filter((m: any) => m.id === mentionId || m.replyTo === mentionId).map((m: any) => m.id), pair.map((m: any) => m.id));

    const later = B.daemon.core.sendChat(ch, {
      text: "A later sequence arrives first",
      hop: 1,
      by: "agent",
      origin: "agent-reply",
      replyTo: reply.id,
      mentions: [A.daemon.identity.id],
    });
    await waitForAsync(async () => (await messages(A!, ch)).some((m: any) => m.id === later.id) ? true : undefined, "later-sequence message");

    // Model a late replay: seq 5 occupies the first sequence slot, the pending parent the
    // middle slot, and seq 4 the final sequence slot. Reply metadata must keep parent first.
    const rootRow = A.daemon.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(mentionId) as { rowid: number };
    const replyRow = A.daemon.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(reply.id) as { rowid: number };
    const laterRow = A.daemon.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(later.id) as { rowid: number };
    const temporaryRowid = A.daemon.db.prepare("SELECT max(rowid) + 1 AS n FROM messages").get() as { n: number };
    for (const [index, id] of [mentionId, reply.id, later.id].entries()) {
      A.daemon.db.prepare("UPDATE messages SET rowid = ? WHERE id = ?").run(temporaryRowid.n + index, id);
    }
    A.daemon.db.prepare("UPDATE messages SET rowid = ? WHERE id = ?").run(rootRow.rowid, later.id);
    A.daemon.db.prepare("UPDATE messages SET rowid = ? WHERE id = ?").run(replyRow.rowid, mentionId);
    A.daemon.db.prepare("UPDATE messages SET rowid = ? WHERE id = ?").run(laterRow.rowid, reply.id);
    const orderedAfterReplay = await messages(A, ch);
    assert.deepEqual(orderedAfterReplay.filter((m: any) => [mentionId, reply.id, later.id].includes(m.id)).map((m: any) => m.id), [mentionId, reply.id, later.id], "reply metadata preserves parent-before-reply despite out-of-order sequence slots");
    assert.equal(new Set(orderedAfterReplay.map((m: any) => m.id)).size, orderedAfterReplay.length, "replay has no duplicate ids");

    const older = (await http(A.daemon.port, "GET", `/api/channels/${ch}/messages?limit=10&before=${reply.id}`, {
      headers: { "X-Spencer-Token": A.daemon.token },
    })).json().items;
    assert.deepEqual(older.filter((m: any) => m.type === "chat" && m.id === mentionId).map((m: any) => m.id), [mentionId], "paging before the reply returns its pending parent once");
    const page = async (before?: string) => (await http(A!.daemon.port, "GET", `/api/channels/${ch}/messages?limit=1${before ? `&before=${before}` : ""}`, {
      headers: { "X-Spencer-Token": A!.daemon.token },
    })).json().items;
    const newestPage = await page();
    assert.equal(newestPage.length, 1);
    const reversePages = [newestPage[0].id];
    let cursor = newestPage[0].id;
    while (true) {
      const olderPage = await page(cursor);
      if (!olderPage.length) break;
      assert.notEqual(olderPage[0].id, cursor, "a cursor page never includes its cursor");
      assert.ok(!reversePages.includes(olderPage[0].id), "pagination does not duplicate messages");
      reversePages.push(olderPage[0].id);
      cursor = olderPage[0].id;
    }
    assert.deepEqual(reversePages.reverse(), (await messages(A, ch)).map((m: any) => m.id), "following every cursor visits the full API order");

    await waitFor(() => aEvents.events.some((e) => e.type === "message" && e.message.replyTo === mentionId), "incoming reply event while parent ack is held");
    releaseHeldAck();
    await waitFor(() => aEvents.events.slice(ackEventStart).some((e) => e.type === "message" && e.message.id === mentionId && e.message.status === "sent"), "local send acknowledgement event after the held response is released");
    const acknowledged = await waitForAsync(async () => {
      const root = (await messages(A!, ch)).find((m: any) => m.id === mentionId);
      return Number.isSafeInteger(root?.seq) && root.status === "sent" ? root : undefined;
    }, "Alice's relay acknowledgement");
    await waitFor(() => bEvents.events.some((e) => e.type === "message" && e.message.id === mentionId), "incoming mention event");
    assert.ok(aEvents.events.some((e) => e.type === "message" && e.message.id === mentionId && e.message.status === "pending"), "optimistic local insertion is emitted");
    assert.equal(pair[1].replyTo, mentionId);

    // Re-read after acknowledgement: relay sequence restores the accepted-message order.
    const reload = await messages(A, ch);
    assert.deepEqual(reload.filter((m: any) => [mentionId, reply.id, later.id].includes(m.id)).map((m: any) => m.id), [mentionId, reply.id, later.id]);
    assert.equal(new Set(reload.map((m: any) => m.id)).size, reload.length);

    const concurrent = [
      B.daemon.core.sendChat(ch, { text: "Rapid reply from Bob", hop: 1, by: "agent", origin: "agent-reply", replyTo: reply.id }),
      C.daemon.core.sendChat(ch, { text: "Rapid reply from Carol", hop: 1, by: "agent", origin: "agent-reply", replyTo: reply.id }),
    ];
    const afterConcurrent = await waitForAsync(async () => {
      const items = await messages(A!, ch);
      return concurrent.every((m) => items.some((item: any) => item.id === m.id)) ? items : undefined;
    }, "concurrent replies from two group peers");
    const concurrentRows = afterConcurrent.filter((m: any) => concurrent.some((sent) => sent.id === m.id));
    assert.deepEqual(concurrentRows.map((m: any) => m.id), [...concurrentRows].sort((a: any, b: any) => a.seq - b.seq).map((m: any) => m.id));
    assert.equal(concurrentRows[1].seq, concurrentRows[0].seq + 1, "the relay assigns adjacent sequence numbers to rapid sends");

    // Verify a real relay backlog after reconnect: messages sent while Alice is offline are delivered once in seq order.
    const aliceId = A.daemon.identity.id;
    await A.daemon.stop();
    const replayOne = B.daemon.core.sendChat(ch, {
      text: "First message while Alice reconnects",
      hop: 1,
      by: "agent",
      origin: "agent-reply",
      replyTo: reply.id,
      mentions: [aliceId],
    });
    const replayTwo = B.daemon.core.sendChat(ch, {
      text: "Second message while Alice reconnects",
      hop: 1,
      by: "agent",
      origin: "agent-reply",
      replyTo: replayOne.id,
      mentions: [aliceId],
    });
    await A.restart();
    const replayed = await waitForAsync(async () => {
      const items = await messages(A!, ch);
      return items.some((m: any) => m.id === replayTwo.id) ? items : undefined;
    }, "relay backlog after Alice reconnects");
    const replayPair = replayed.filter((m: any) => m.id === replayOne.id || m.id === replayTwo.id);
    assert.deepEqual(replayPair.map((m: any) => m.id), [replayOne.id, replayTwo.id]);
    assert.equal(replayPair[1].seq, replayPair[0].seq + 1);
    assert.equal(replayed.filter((m: any) => m.id === replayOne.id).length, 1);
    assert.equal(replayed.filter((m: any) => m.id === replayTwo.id).length, 1);
  } finally {
    releaseHeldAck();
    restoreRelayRequest?.();
    for (const ws of sockets) ws.terminate();
    await C?.daemon.stop().catch(() => {});
    await B?.daemon.stop().catch(() => {});
    await A?.daemon.stop().catch(() => {});
    await relay.close();
    t.cleanup();
  }
});
