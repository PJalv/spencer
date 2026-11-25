import WebSocket from "ws";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIdentity, randomId } from "@spencer/protocol";
import { Memoir, MAX_RULES_BYTES } from "../../src/memoir.ts";
import { openDb } from "../../src/store/db.ts";
import { tempDir, relayAt, startNode, waitFor, http } from "./helpers.ts";

test("separate rules and note stores: bounded private writes, validation, rate/dedupe, eviction, mutations", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const tmp = tempDir(),
    db = openDb(tmp.dir),
    id = generateIdentity().id,
    ch = randomId();
  const store = new Memoir({
    db,
    dataDir: tmp.dir,
    peers: () => [
      {
        id,
        name: "Bob",
        about: null,
        aboutAt: null,
        fingerprint: "bob",
        channels: [],
        active: true,
        hasRules: false,
        noteCount: 0,
        unseenNotes: 0,
      },
    ],
    channels: () => [],
    events: { emit() {} },
    refresh() {},
  });
  const s = { kind: "peer", id } as const;
  try {
    const version = db.prepare("PRAGMA user_version").get();
    store.writeRules(s, "  private rules  ");
    const file = join(tmp.dir, "peers", id, "RULES.md");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
    assert.equal(store.readRules(s), "private rules");
    assert.throws(() => store.writeRules(s, "😀".repeat(513)), /2048/);
    writeFileSync(file, "a".repeat(MAX_RULES_BYTES - 1) + "😀".repeat(2000));
    assert.equal(store.readRules(s), "a".repeat(MAX_RULES_BYTES - 1));
    assert.throws(
      () => store.writeRules({ kind: "peer", id: "../../bad" }, "bad"),
      /invalid/,
    );
    const unknown = generateIdentity().id;
    assert.throws(
      () => store.writeRules({ kind: "peer", id: unknown }, "bad"),
      /unknown/,
    );
    assert.equal(existsSync(join(tmp.dir, "peers", unknown)), false);
    store.writeRules(s, "trusted");
    const pin = store.addOwnerNote(s, "pinned", true);
    const first = store.recordAgentNote(s, "Fact", ch, "standard", id);
    assert.equal(first.seen, false);
    assert.equal(
      store.recordAgentNote(s, "  FACT ", ch, "standard", id).id,
      first.id,
    );
    for (let i = 0; i < 4; i++)
      store.recordAgentNote(s, `Fact ${i}`, ch, "full", id);
    assert.throws(
      () => store.recordAgentNote(s, "too soon", ch, "full", id),
      /rate limit/,
    );
    t.mock.timers.tick(600_001);
    store.recordAgentNote(s, "later", ch, "full", id);
    for (let i = 0; i < 25; i++)
      store.addOwnerNote(s, `note ${i} ` + "x".repeat(300));
    const remaining = store.notes(s);
    assert.ok(remaining.some((n) => n.id === pin.id));
    assert.ok(remaining.filter((n) => !n.pinned).length <= 20);
    assert.ok(
      remaining
        .filter((n) => !n.pinned)
        .reduce((n, v) => n + v.text.length, 0) <= 4000,
    );
    assert.equal(
      store.update(pin.id, { text: "edited", pinned: false, seen: false }).text,
      "edited",
    );
    assert.throws(() => store.update(pin.id, { pinned: "yes" }), /boolean/);
    store.markSeen(s);
    assert.ok(store.notes(s).every((n) => n.seen));
    store.delete(pin.id);
    assert.ok(!store.notes(s).some((n) => n.id === pin.id));
    assert.equal(readFileSync(file, "utf8"), "trusted");
    store.writeRules(s, "");
    assert.equal(existsSync(file), false);
    assert.deepEqual(db.prepare("PRAGMA user_version").get(), version);
  } finally {
    store.stop();
    db.close();
    tmp.cleanup();
  }
});

test("authenticated memoir HTTP, events, group boundaries, leave cleanup and inactive peer retention", async () => {
  const tmp = tempDir(),
    relay = await relayAt(tmp.dir);
  const a = await startNode(join(tmp.dir, "a"), relay.url, "A"),
    b = await startNode(join(tmp.dir, "b"), relay.url, "B");
  const H = { "X-Spencer-Token": a.daemon.token };
  const request = (method: string, path: string, body?: unknown) =>
    http(a.daemon.port, method, path, { headers: H, body });
  const ws = new WebSocket(
    `ws://127.0.0.1:${a.daemon.port}/api/events?token=${a.daemon.token}`,
  );
  const frames: string[] = [];
  ws.on("message", (data) => frames.push(data.toString()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const events: unknown[] = [];
  a.daemon.events.subscribe((e) => events.push(e));
  try {
    const inv = await a.daemon.createInvite("group", "Team");
    const ch = inv.channel.id;
    await b.daemon.acceptInvite(inv.link);
    await waitFor(() => a.daemon.core.listPeerDirectory().length === 1);
    const id = b.daemon.identity.id;
    assert.equal(
      (
        await http(a.daemon.port, "PUT", `/api/peers/${id}/rules`, {
          body: { text: "bad" },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("PUT", `/api/peers/${id}/rules`, { text: "DM private" }))
        .status,
      200,
    );
    assert.equal(
      (await request("PUT", `/api/channels/${ch}/rules`, { text: "group" }))
        .status,
      200,
    );
    const n = (
      await request("POST", `/api/peers/${id}/notes`, {
        text: "owner fact",
        pinned: true,
      })
    ).json();
    assert.equal(n.author, "owner");
    assert.equal(n.pinned, true);
    assert.equal(
      (
        await request("PATCH", `/api/memoir/notes/${n.id}`, {
          text: "changed",
          pinned: false,
        })
      ).json().text,
      "changed",
    );
    assert.equal(
      (
        await request("POST", `/api/channels/${ch}/notes`, {
          text: "group fact",
        })
      ).status,
      200,
    );
    a.daemon.core.memoir.recordAgentNote(
      { kind: "peer", id },
      "agent fact",
      ch,
      "standard",
      id,
    );
    assert.equal(a.daemon.core.listPeerDirectory()[0].unseenNotes, 1);
    assert.equal(
      (await request("GET", `/api/peers/${id}/memoir?markSeen=1`))
        .json()
        .notes.every((n: { seen: boolean }) => n.seen),
      true,
    );
    assert.equal(a.daemon.core.listPeerDirectory()[0].unseenNotes, 0);
    assert.equal(
      (await request("GET", `/api/channels/${ch}/memoir`)).json().notes.length,
      1,
    );
    const dm = await a.daemon.createInvite("direct", "DM");
    assert.equal(
      (await request("GET", `/api/channels/${dm.channel.id}/memoir`)).status,
      400,
    );
    assert.equal(
      (await request("GET", `/api/peers/not-valid/memoir`)).status,
      400,
    );
    assert.equal(
      (await request("DELETE", `/api/memoir/notes/${n.id}`)).status,
      200,
    );
    assert.ok(
      events.some((e) => JSON.stringify(e).includes('"type":"memoir"')),
    );
    await waitFor(() =>
      frames.some((f) => f.includes('"type":"memoir"') && f.includes(id)),
    );
    assert.equal(
      (await request("PUT", `/api/peers/${id}/rules/seen`, { text: "bad" })).status,
      404,
    );
    assert.equal(
      (await request("POST", `/api/peers/${id}/notes/seen`, { text: "bad" })).status,
      404,
    );
    await a.daemon.channels.leave(ch);
    assert.equal(
      existsSync(join(a.daemon.dataDir, "channels", ch, "RULES.md")),
      false,
    );
    assert.equal(
      a.daemon.core.memoir.notes({ kind: "channel", id: ch }).length,
      0,
    );
    const inactive = a.daemon.core
      .listPeerDirectory()
      .find((p) => p.id === id)!;
    assert.equal(inactive.active, false);
    assert.equal(inactive.hasRules, true);
    assert.equal(inactive.noteCount, 1);
    assert.equal(
      (await request("PUT", `/api/peers/${id}/rules`, { text: "" })).status,
      200,
    );
    const saved = (await request("GET", `/api/peers/${id}/memoir`)).json();
    await request("DELETE", `/api/memoir/notes/${saved.notes[0].id}`);
    assert.equal(
      a.daemon.core.listPeerDirectory().some((p) => p.id === id),
      false,
    );
    // A saved rules file alone remains clearable even after the last shared channel is gone.
    writeFileSync(
      join(a.daemon.dataDir, "peers", id, "RULES.md"),
      "last saved rule",
    );
    assert.equal(
      (await request("PUT", `/api/peers/${id}/rules`, { text: "" })).status,
      200,
    );
    assert.equal(
      a.daemon.core.listPeerDirectory().some((p) => p.id === id),
      false,
    );
  } finally {
    ws.terminate();
    await a.daemon.stop();
    await b.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("agent refresh is scope-local, leading/trailing throttled, owner writes immediate, stop clears timers", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const tmp = tempDir(),
    db = openDb(tmp.dir),
    me = generateIdentity(),
    peer = generateIdentity(),
    ch = randomId(),
    group = randomId();
  const base = {
    shareBio: true,
    directLink: "auto" as const,
    allowLocalAddresses: false,
    mode: "chat" as const,
    name: "Team",
    relayUrl: "ws://localhost",
    members: [
      { id: me.id, me: true, fingerprint: me.id, presence: "online" as const },
      {
        id: peer.id,
        me: false,
        fingerprint: peer.id,
        presence: "online" as const,
      },
    ],
    autoReply: true,
    allowedMcpTools: [],
    trust: "standard" as const,
    unread: 0,
    lastSeq: 0,
    createdAt: 0,
  };
  const channels = [
    { ...base, id: ch, kind: "direct" as const },
    { ...base, id: group, kind: "group" as const },
  ];
  const changes: string[] = [];
  const store = new Memoir({
    db,
    dataDir: tmp.dir,
    peers: () => [
      {
        id: peer.id,
        name: "Bob",
        about: null,
        aboutAt: null,
        fingerprint: peer.id,
        channels: [],
        active: true,
        hasRules: false,
        noteCount: 0,
        unseenNotes: 0,
      },
    ],
    channels: () => channels,
    events: { emit() {} },
    refresh: (id) => changes.push(id),
  });
  const scope = { kind: "peer", id: peer.id } as const;
  try {
    store.recordAgentNote(scope, "first", ch, "standard", peer.id);
    store.recordAgentNote(scope, "second", ch, "standard", peer.id);
    assert.deepEqual(changes, [ch, group]);
    t.mock.timers.tick(119_999);
    assert.equal(changes.length, 2);
    t.mock.timers.tick(1);
    assert.deepEqual(changes, [ch, group, ch, group]);
    store.writeRules(scope, "owner edit");
    assert.deepEqual(changes, [ch, group, ch, group, ch, group]);
    store.addOwnerNote(scope, "owner note");
    assert.equal(changes.length, 8);
    store.recordAgentNote(
      { kind: "channel", id: group },
      "group fact",
      group,
      "standard",
      peer.id,
    );
    assert.equal(changes.at(-1), group);
    assert.ok(store.prompt(scope).length <= 2000);
    store.recordAgentNote(scope, "third", ch, "standard", peer.id);
    const count = changes.length;
    store.stop();
    t.mock.timers.tick(120_000);
    assert.equal(changes.length, count);
  } finally {
    store.stop();
    db.close();
    tmp.cleanup();
  }
});

test("recordAgentNote rolls back rate slot and insert atomically when eviction fails", () => {
  const tmp = tempDir();
  const db = openDb(tmp.dir);
  const peer = generateIdentity();
  const ch = randomId();
  const events: unknown[] = [];
  const store = new Memoir({
    db,
    dataDir: tmp.dir,
    peers: () => [
      {
        id: peer.id,
        name: "Bob",
        about: null,
        aboutAt: null,
        fingerprint: peer.id,
        channels: [],
        active: true,
        hasRules: false,
        noteCount: 0,
        unseenNotes: 0,
      },
    ],
    channels: () => [],
    events: { emit: (e) => events.push(e) },
    refresh() {},
  });
  const scope = { kind: "peer", id: peer.id } as const;
  try {
    for (let i = 0; i < 20; i++) store.addOwnerNote(scope, `seed ${i}`);
    events.length = 0;
    db.exec("CREATE TRIGGER fail_evict BEFORE DELETE ON memoir_notes BEGIN SELECT RAISE(ABORT, 'evict failed'); END;");
    assert.throws(() => store.recordAgentNote(scope, "overflow", ch, "standard", peer.id), /evict failed/);
    assert.equal(store.notes(scope).length, 20);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM memoir_rate").get()!.n), 0);
    assert.equal(events.length, 0);
  } finally {
    store.stop();
    db.close();
    tmp.cleanup();
  }
});
