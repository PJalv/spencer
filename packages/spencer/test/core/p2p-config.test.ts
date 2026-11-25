import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, resolveConfig } from "../../src/config.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../src/store/db.ts";

test("migrates a v2 database without losing channel or member data", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2p-migration-"));
  try {
    const old = new DatabaseSync(join(dir, "spencer.sqlite"));
    old.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL, meta_name TEXT NOT NULL, custom_name TEXT, created_by TEXT NOT NULL, relay_url TEXT NOT NULL, secret TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, auto_reply INTEGER NOT NULL DEFAULT 1, allowed_mcp_tools TEXT NOT NULL DEFAULT '[]', last_hello_members TEXT NOT NULL DEFAULT '[]', unread INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, trust TEXT NOT NULL DEFAULT 'standard');
      CREATE TABLE members (ch TEXT NOT NULL, id TEXT NOT NULL, name TEXT, about TEXT, agent TEXT, present INTEGER NOT NULL DEFAULT 1, joined_at INTEGER, PRIMARY KEY(ch,id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, ch TEXT NOT NULL, seq INTEGER);
      INSERT INTO channels (id,kind,meta_name,created_by,relay_url,secret,created_at) VALUES ('ch','direct','name','me','ws://hub','secret',42);
      INSERT INTO members (ch,id,name) VALUES ('ch','peer','Alice');
      INSERT INTO messages (id,ch,seq) VALUES ('msg','ch',1);
      PRAGMA user_version = 2;`);
    old.close();
    const db = openDb(dir);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
      const channel = db.prepare("SELECT * FROM channels WHERE id = 'ch'").get()!;
      assert.equal(channel.meta_name, "name");
      assert.equal(channel.last_hello_features, "[]");
      assert.equal(channel.last_hello_name, "");
      assert.equal(channel.direct_link, "auto");
      assert.equal(channel.allow_local_addresses, 0);
      assert.equal(channel.mode, "chat");
      const member = db.prepare("SELECT * FROM members WHERE id = 'peer'").get()!;
      assert.equal(member.name, "Alice");
      assert.equal(member.features, "[]");
      const message = db.prepare("SELECT id, seq FROM messages WHERE ch = 'ch'").get() as { id: string; seq: number };
      assert.equal(message.id, "msg");
      assert.equal(message.seq, 1);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reconciles both independent version-6 database layouts", () => {
  for (const layout of ["upstream", "ordering"] as const) {
    const db = new DatabaseSync(":memory:");
    try {
      const bioColumns = layout === "upstream" ? ", share_bio INTEGER NOT NULL DEFAULT 1, last_hello_about TEXT" : "";
      const memberBioColumn = layout === "upstream" ? ", about_at INTEGER" : "";
      const orderingIndex = layout === "ordering" ? "CREATE INDEX messages_ch_seq ON messages (ch, seq) WHERE seq IS NOT NULL;" : "";
      db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY${bioColumns});
        CREATE TABLE members (id TEXT PRIMARY KEY${memberBioColumn});
        CREATE TABLE messages (ch TEXT NOT NULL, seq INTEGER);
        ${orderingIndex}
        PRAGMA user_version = 6;`);

      migrate(db);

      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
      const channelColumns = (db.prepare("PRAGMA table_info(channels)").all() as { name: string }[]).map((column) => column.name);
      const memberColumns = (db.prepare("PRAGMA table_info(members)").all() as { name: string }[]).map((column) => column.name);
      assert.ok(channelColumns.includes("share_bio"));
      assert.ok(channelColumns.includes("last_hello_about"));
      assert.ok(channelColumns.includes("last_hello_name"));
      assert.ok(memberColumns.includes("about_at"));
      const indexes = (db.prepare("PRAGMA index_list(messages)").all() as { name: string }[]).map((index) => index.name);
      assert.ok(indexes.includes("messages_ch_seq"));
    } finally { db.close(); }
  }
});

test("reconciles both independent version-7 database layouts", () => {
  for (const layout of ["upstream", "ordering"] as const) {
    const db = new DatabaseSync(":memory:");
    try {
      const lastHelloName = layout === "upstream" ? ", last_hello_name TEXT NOT NULL DEFAULT ''" : "";
      const orderingIndex = layout === "ordering" ? "CREATE INDEX messages_ch_seq ON messages (ch, seq) WHERE seq IS NOT NULL;" : "";
      db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, share_bio INTEGER NOT NULL DEFAULT 1, last_hello_about TEXT${lastHelloName});
        CREATE TABLE members (id TEXT PRIMARY KEY, about_at INTEGER);
        CREATE TABLE messages (ch TEXT NOT NULL, seq INTEGER);
        INSERT INTO channels (id) VALUES ('ch');
        ${orderingIndex}
        PRAGMA user_version = 7;`);

      migrate(db);

      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
      assert.equal((db.prepare("SELECT last_hello_name FROM channels WHERE id = 'ch'").get() as { last_hello_name: string }).last_hello_name, "");
      const indexes = (db.prepare("PRAGMA index_list(messages)").all() as { name: string }[]).map((index) => index.name);
      assert.ok(indexes.includes("messages_ch_seq"));
    } finally { db.close(); }
  }
});

test("P2P defaults, validation and relay normalization", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.p2p.minFileBytes, 4 * 1024 * 1024);
  assert.equal(resolveConfig({ relay: "https://hub.example" }).relay, "wss://hub.example/ws");
  assert.throws(() => resolveConfig({ p2p: { ...defaults.p2p, stun: ["host:65536"] } }));
  assert.throws(() => resolveConfig({ p2p: { ...defaults.p2p, minFileBytes: -1 } }));
  assert.deepEqual(resolveConfig({ p2p: { ...defaults.p2p, stun: ["[::1]:3478"] } }).p2p.stun, ["[::1]:3478"]);
  const old = process.env.SPENCER_RELAY;
  try {
    process.env.SPENCER_RELAY = "https://other.example";
    assert.equal(resolveConfig({ relay: "wss://hub.example/ws" }).relay, "wss://other.example/ws");
  } finally {
    if (old === undefined) delete process.env.SPENCER_RELAY; else process.env.SPENCER_RELAY = old;
  }
});

import { startRelay } from "../../../relay/src/index.ts";
import { http, quietLog, relayAt, startNode, tempDir, waitFor } from "./helpers.ts";

test("custom invite uses its relay and channel link settings are validated", async () => {
  const dir = tempDir();
  mkdirSync(join(dir.dir, "a")); mkdirSync(join(dir.dir, "b"));
  const relayA = await relayAt(join(dir.dir, "a"));
  const relayB = await relayAt(join(dir.dir, "b"));
  const alice = await startNode(join(dir.dir, "alice"), relayA.url, "Alice");
  alice.daemon.channels["d"].localFeatures = () => [];
  const bob = await startNode(join(dir.dir, "bob"), relayA.url, "Bob");
  bob.daemon.channels["d"].localFeatures = () => [];
  try {
    const ah = { "X-Spencer-Token": alice.daemon.token };
    const bh = { "X-Spencer-Token": bob.daemon.token };
    const invite = await http(alice.daemon.port, "POST", "/api/invites", { headers: ah, body: { kind: "direct", name: "Bob", relay: relayB.httpUrl } });
    assert.equal(invite.status, 200);
    const { link, channel } = invite.json();
    assert.equal((await http(bob.daemon.port, "POST", "/api/invites/accept", { headers: bh, body: { link } })).status, 200);
    await waitFor(() => alice.daemon.pool.status(relayB.url)?.connected && bob.daemon.pool.status(relayB.url)?.connected, "both connected to custom relay");
    await waitFor(() => alice.daemon.core.getChannel(channel.id)?.members.length === 2, "members joined");
    assert.equal(alice.daemon.core.getChannel(channel.id)?.relayUrl, relayB.url);
    assert.equal(bob.daemon.core.getChannel(channel.id)?.relayUrl, relayB.url);
    await waitFor(() => {
      const aliceAtBob = bob.daemon.core.getChannel(channel.id)?.members.find((m) => m.id === alice.daemon.identity.id);
      const bobAtAlice = alice.daemon.core.getChannel(channel.id)?.members.find((m) => m.id === bob.daemon.identity.id);
      const aliceHello = bob.daemon.channels.messages(channel.id, 50, undefined, ["chat", "hello"])
        .some((m) => m.from === alice.daemon.identity.id && m.type === "hello");
      const bobHello = alice.daemon.channels.messages(channel.id, 50, undefined, ["chat", "hello"])
        .some((m) => m.from === bob.daemon.identity.id && m.type === "hello");
      return !!aliceAtBob && !!bobAtAlice && aliceHello && bobHello
        && (aliceAtBob.features?.length ?? 0) === 0 && (bobAtAlice.features?.length ?? 0) === 0;
    }, "initial hello exchange");
    const beforeMessages = bob.daemon.channels.messages(channel.id, 50, undefined, ["chat", "hello"]);
    assert.ok(beforeMessages.some((m) => m.from === alice.daemon.identity.id && m.type === "hello"), "initial Alice hello is visible");
    alice.daemon.channels["d"].localFeatures = () => ["p2p-files/1"];
    alice.daemon.channels.recheckHellos();
    await waitFor(() => bob.daemon.core.getChannel(channel.id)?.members.some((m) => m.id === alice.daemon.identity.id && m.features?.includes("p2p-files/1")), "feature hello");
    const afterMessages = bob.daemon.channels.messages(channel.id, 50, undefined, ["chat", "hello"]);
    assert.deepEqual(afterMessages.map((m) => m.id), beforeMessages.map((m) => m.id), "feature-only hello does not enter visible history");
    assert.deepEqual(JSON.parse(String(bob.daemon.db.prepare("SELECT features FROM members WHERE ch = ? AND id = ?").get(channel.id, alice.daemon.identity.id)?.features)), ["p2p-files/1"]);
    alice.daemon.sendHuman(channel.id, "from Alice");
    bob.daemon.sendHuman(channel.id, "from Bob");
    await waitFor(() => alice.agent().peerChats.some((m) => m.body.text === "from Bob") && bob.agent().peerChats.some((m) => m.body.text === "from Alice"), "chat exchange");
    const path = `/api/channels/${channel.id}`;
    for (const settings of [{ directLink: "off", allowLocalAddresses: true }, { directLink: "auto", allowLocalAddresses: false }]) {
      assert.equal((await http(alice.daemon.port, "PATCH", path, { headers: ah, body: settings })).status, 200);
      const result = (await http(alice.daemon.port, "GET", path, { headers: ah })).json();
      assert.equal(result.directLink, settings.directLink);
      assert.equal(result.allowLocalAddresses, settings.allowLocalAddresses);
    }
    for (const body of [{ directLink: "always" }, { allowLocalAddresses: "true" }]) {
      assert.equal((await http(alice.daemon.port, "PATCH", path, { headers: ah, body })).status, 400);
    }
  } finally {
    await alice.daemon.stop(); await bob.daemon.stop(); await relayA.close(); await relayB.close(); dir.cleanup();
  }
});

test("relay welcome exposes STUN status", async () => {
  const dir = tempDir();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, dbPath: join(dir.dir, "relay.sqlite"), stunBind: "127.0.0.1:0", log: quietLog });
  const node = await startNode(join(dir.dir, "node"), relay.url, "Alice");
  try {
    node.daemon.pool.get(relay.url);
    const status = await waitFor(() => { const s = node.daemon.pool.status(relay.url); return s?.connected ? s : undefined; }, "relay welcome");
    assert.ok(status.features.includes("stun"));
    assert.equal(status.stun, relay.stunAddress);
    assert.ok(status.stun);
  } finally { await node.daemon.stop(); await relay.close(); dir.cleanup(); }
});
