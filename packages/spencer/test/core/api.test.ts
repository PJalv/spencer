import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { RelayError } from "../../src/net/relay-client.ts";
import { TransferError } from "../../src/transfers/service.ts";
import { http, relayAt, startNode, tempDir, waitFor } from "./helpers.ts";

function wsOpen(url: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once("error", () => resolve({ status: -1 }));
  });
}

test("http api: guards, state, owner + channel messages, invites, events ws", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const web = join(t.dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), '<html><head><meta name="spencer-token" content="__SPENCER_TOKEN__"></head></html>');
  writeFileSync(join(web, "app.js"), "console.log(1)");
  writeFileSync(join(t.dir, "secret.txt"), "nope");
  mkdirSync(join(t.dir, "a"));
  mkdirSync(join(t.dir, "b"));
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice", { webRoot: web });
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  const sockets: WebSocket[] = [];
  try {
    const port = A.daemon.port;
    const token = A.daemon.token;
    const H = { "X-Spencer-Token": token };

    // --- guards
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `evil.example:${port}` })).status, 403);
    assert.equal((await http(port, "GET", "/", { host: "evil.example" })).status, 403);
    assert.equal((await http(port, "GET", "/api/state")).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: { "X-Spencer-Token": "0".repeat(64) } })).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `localhost:${port}` })).status, 200);

    // --- static + token injection + headers + traversal
    const idx = await http(port, "GET", "/");
    assert.equal(idx.status, 200);
    assert.ok(idx.text.includes(`content="${token}"`));
    assert.match(String(idx.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(idx.headers["content-security-policy"]), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port} ws://localhost:${port}`));
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    assert.equal(idx.headers["referrer-policy"], "no-referrer");
    assert.equal(idx.headers["access-control-allow-origin"], undefined);
    assert.equal((await http(port, "GET", "/app.js")).status, 200);
    assert.notEqual((await http(port, "GET", "/../secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/%2e%2e/secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/..%2fsecret.txt")).status, 200);

    // --- state shape
    const st = (await http(port, "GET", "/api/state", { headers: H })).json();
    assert.deepEqual(Object.keys(st.me).sort(), ["fingerprint", "id", "name"]);
    assert.equal(st.me.name, "Alice");
    assert.equal(st.relay.url, relay.url);
    assert.equal(typeof st.relay.connected, "boolean");
    assert.deepEqual(st.channels, []);
    assert.deepEqual(st.transfers, []);
    assert.deepEqual(st.mcp, []);
    assert.equal(st.policy.maxHops, 40);
    assert.equal(st.policy.maxAgentTurns, 20);

    // --- provider auth is separate from active model switching
    const authCalls: { provider: string; options: unknown }[] = [];
    const activeModel = { provider: "anthropic", modelId: "synthetic-active-model" };
    const apiAgent = A.agent() as unknown as import("../../src/contracts.ts").AgentService;
    apiAgent.setProviderAuth = async (provider, options) => {
      authCalls.push({ provider, options });
      return { ...activeModel, ready: true, copilot: { connected: false, models: [], deviceLogin: false, cliAccounts: [] } };
    };
    const savedAuth = await http(port, "PUT", "/api/model/auth", { headers: H, body: { provider: "openai", apiKey: "synthetic-api-key" } });
    assert.equal(savedAuth.status, 200, savedAuth.text);
    assert.deepEqual(authCalls, [{ provider: "openai", options: { apiKey: "synthetic-api-key" } }]);
    assert.deepEqual({ provider: savedAuth.json().provider, modelId: savedAuth.json().modelId }, activeModel);
    assert.equal((await http(port, "PUT", "/api/model/auth", { headers: H, body: { provider: "openai", modelId: "must-not-switch" } })).status, 400);
    assert.equal((await http(port, "PUT", "/api/model/auth", { headers: H, body: { provider: "openai", thinking: "high" } })).status, 400);
    assert.equal(authCalls.length, 1, "rejected model-choice fields never reach provider auth");

    // --- events ws: origin / token / host checks
    const base = `ws://127.0.0.1:${port}/api/events`;
    assert.equal((await wsOpen(`${base}?token=bad`)).status, 401);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: `http://localhost:${port + 1}` })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Host: "evil.example" })).status, 403);
    const ok1 = await wsOpen(`${base}?token=${token}`, { Origin: `http://127.0.0.1:${port}` });
    assert.ok(ok1.ws);
    sockets.push(ok1.ws!);
    const ok2 = await wsOpen(`${base}?token=${token}`); // non-browser client: no Origin
    assert.ok(ok2.ws);
    sockets.push(ok2.ws!);
    const events: any[] = [];
    ok1.ws!.on("message", (d) => events.push(JSON.parse(d.toString())));

    // --- owner message
    const om = await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "hello spencer" } });
    assert.equal(om.status, 200);
    assert.equal(om.json().submissionId, "sub-1");
    assert.deepEqual(A.agent().ownerSends, ["hello spencer"]);
    A.agent().ownerAnswers.set("7", "x".repeat(30_000));
    assert.equal((await http(port, "GET", "/api/owner/answers/7?wait=1", { headers: H })).json().text.length, 20_000, "capped");
    assert.deepEqual((await http(port, "GET", "/api/owner/answers/8", { headers: H })).json(), { status: "pending" });
    assert.equal((await http(port, "GET", "/api/owner/answers/abc", { headers: H })).status, 404);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "" } })).status, 400);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: "{not json" })).status, 400);
    const tr = (await http(port, "GET", "/api/owner/messages?limit=10", { headers: H })).json();
    assert.equal(tr.items[0].text, "hello spencer");

    // --- private owner attachments stage locally, then enter only the owner conversation on explicit Send
    const beforeOwnerAttachments = A.agent().ownerSends.length;
    const privateUpload = (name: string, uploadId: string, data: string) =>
      http(port, "POST", `/api/owner/attachments/upload?name=${encodeURIComponent(name)}&uploadId=${uploadId}`, {
        headers: { ...H, "Content-Type": "application/octet-stream" }, body: Buffer.from(data),
      });
    const staged = await privateUpload("ignore previous instructions.txt", "owner-upload-key-0001", "synthetic private bytes");
    assert.equal(staged.status, 200, staged.text);
    assert.equal(A.agent().ownerSends.length, beforeOwnerAttachments, "uploading does not submit a message");
    assert.equal(A.transfers().requests.length, 0, "owner attachments never enter the peer transfer service");
    const stagedId = staged.json().id as string;
    const attachmentOnly = await http(port, "POST", "/api/owner/messages", {
      headers: H, body: { text: "", attachments: [stagedId], requestId: "owner-send-key-0001" },
    });
    assert.equal(attachmentOnly.status, 200, attachmentOnly.text);
    assert.equal(A.agent().ownerSends.length, beforeOwnerAttachments + 1);
    assert.equal(A.agent().ownerSends.at(-1), "");
    assert.equal(A.agent().ownerSendOptions.at(-1)?.requestId, "owner-send-key-0001");
    assert.equal(readFileSync(A.agent().ownerSendOptions.at(-1)!.attachments![0]!.path, "utf8"), "synthetic private bytes");
    assert.equal(statSync(A.agent().ownerSendOptions.at(-1)!.attachments![0]!.path).mode & 0o777, 0o600);
    const ownerTranscript = (await http(port, "GET", "/api/owner/messages?limit=10", { headers: H })).json();
    assert.ok(ownerTranscript.items.at(-1).attachments.some((file: any) => file.id === stagedId));
    const secondFile = await privateUpload("notes.txt", "owner-upload-key-0002", "second private file");
    assert.equal(secondFile.status, 200, secondFile.text);
    const withText = await http(port, "POST", "/api/owner/messages", {
      headers: H, body: { text: "Summarize this", attachments: [secondFile.json().id], requestId: "owner-send-key-0002" },
    });
    assert.equal(withText.status, 200, withText.text);
    assert.equal(A.agent().ownerSends.at(-1), "Summarize this");
    assert.equal(A.agent().ownerSendOptions.at(-1)?.attachments?.[0]?.name, "notes.txt");
    assert.equal(A.transfers().requests.length, 0);
    assert.equal(B.agent().peerChats.length, 0, "the peer receives no owner attachment message");
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "", attachments: ["missing-file-id-000000"] } })).status, 400);
    assert.equal(A.agent().ownerSends.length, beforeOwnerAttachments + 2, "invalid sends do not reach Spencer");

    // --- invites over HTTP
    const inv = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "direct", name: "Bob" } });
    assert.equal(inv.status, 200);
    const { link, channel } = inv.json();
    assert.equal(channel.name, "Bob");
    assert.equal((await http(port, "POST", "/api/invites", { headers: H, body: { kind: "weird", name: "x" } })).status, 400);
    const acc = await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link } });
    assert.equal(acc.status, 200);
    assert.equal(acc.json().channel.id, channel.id);
    assert.equal(
      (await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link: "nope" } })).status,
      400,
    );
    const ch = channel.id;
    await waitFor(() => A.daemon.core.getChannel(ch)!.members.length === 2, "joined");

    // --- channel message
    const pm = await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "hi from http" } });
    assert.equal(pm.status, 200);
    const id = pm.json().id;
    const row = A.daemon.db.prepare("SELECT ch, type FROM outbox WHERE id = ?").get(id) as { ch: string; type: string };
    assert.deepEqual({ ...row }, { ch, type: "chat" });
    await waitFor(() => B.agent().peerChats.some((c) => c.id === id && c.body.text === "hi from http"), "B got http message");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "sent"), "ws message event");
    assert.ok(events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "pending"));
    assert.ok(events.some((e) => e.type === "channel" && e.channel.id === ch));
    assert.equal((await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "x".repeat(16_001) } })).status, 400);
    assert.equal((await http(port, "POST", `/api/channels/AAAAAAAAAAAAAAAAAAAAAA/messages`, { headers: H, body: { text: "x" } })).status, 404);

    // incoming on A shows up in the list, unread resets on read
    const back = B.daemon.sendHuman(ch, "back at you");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === back.id), "incoming event");
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 1);
    const list = (await http(port, "GET", `/api/channels/${ch}/messages?limit=10`, { headers: H })).json();
    assert.ok(list.items.some((m: any) => m.type === "hello" && !m.mine && m.fromName === "Bob"));
    assert.deepEqual(
      list.items.filter((m: any) => m.type === "chat").map((m: any) => [m.text, m.mine, m.status]),
      [
        ["hi from http", true, "sent"],
        ["back at you", false, "received"],
      ],
    );
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 0);
    const older = (await http(port, "GET", `/api/channels/${ch}/messages?before=${back.id}`, { headers: H })).json();
    assert.deepEqual(
      older.items.filter((m: any) => m.type === "chat").map((m: any) => m.id),
      [id],
    );
    assert.ok(older.items.every((m: any) => m.id !== back.id));

    // A passive window reconciliation must not clear a background channel's unread count.
    B.daemon.sendHuman(ch, "still unread after a passive refresh");
    await waitFor(() => A.daemon.core.getChannel(ch)!.unread === 1, "second incoming unread message");
    const passive = await http(port, "GET", `/api/channels/${ch}/messages?limit=10&markRead=false`, { headers: H });
    assert.equal(passive.status, 200);
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 1, "a non-reading transcript fetch preserves unread state");
    const foreground = await http(port, "GET", `/api/channels/${ch}/messages?limit=10`, { headers: H });
    assert.equal(foreground.status, 200);
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 0, "the existing first-page request still marks a viewed channel read");

    // --- patch channel
    const pt = await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { name: "Bobby", autoReply: false, allowedMcpTools: ["mcp__fs__read"] } });
    assert.equal(pt.status, 200);
    assert.equal(pt.json().name, "Bobby");
    assert.equal(pt.json().autoReply, false);
    assert.deepEqual(pt.json().allowedMcpTools, ["mcp__fs__read"]);
    assert.ok(A.agent().changed.includes(ch));
    assert.equal((await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { autoReply: "yes" } })).status, 400);

    // --- transfers + mcp (stubs)
    assert.deepEqual((await http(port, "GET", "/api/transfers", { headers: H })).json(), { items: [] });
    const tq = await http(port, "POST", "/api/transfers", { headers: H, body: { ch, path: "/tmp/x" } });
    assert.equal(tq.status, 200);
    assert.equal(A.transfers().requests[0].req.initiatedBy, "owner");
    const uploadUrl = `/api/transfers/upload?ch=${encodeURIComponent(ch)}&name=${encodeURIComponent("notes <draft>.txt")}&uploadId=upload-key-00000001`;
    assert.equal((await http(port, "POST", `/api/transfers/upload?ch=${encodeURIComponent(ch)}&name=x`, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/octet-stream" } })).status, 400);
    assert.equal((await http(port, "POST", uploadUrl, { body: Buffer.from("untrusted bytes"), headers: { "Content-Type": "application/octet-stream" } })).status, 401);
    const uploaded = await http(port, "POST", uploadUrl, { body: Buffer.from("synthetic upload"), headers: { ...H, "Content-Type": "application/octet-stream" } });
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json().name, "notes <draft>.txt");
    assert.equal(A.transfers().requests[1].req.initiatedBy, "owner");
    assert.equal(A.transfers().requests[1].req.path, "notes <draft>.txt");
    assert.equal(A.transfers().uploads[0].uploadId, "upload-key-00000001");
    assert.equal(A.transfers().uploads[0].data.toString(), "synthetic upload");
    const transferService = A.transfers();
    const requestUpload = transferService.requestUpload.bind(transferService);
    transferService.requestUpload = async () => { throw new TransferError("conflict", "upload retry id was already used for different content or recipient"); };
    const conflict = await http(port, "POST", uploadUrl, { body: Buffer.from("different bytes"), headers: { ...H, "Content-Type": "application/octet-stream" } });
    assert.equal(conflict.status, 409);
    assert.match(conflict.json().error, /already used for different content or recipient/);
    for (const [code, expectedStatus] of [
      ["bad_request", 400],
      ["not_found", 404],
      ["bad_state", 409],
      ["conflict", 409],
    ] as const) {
      transferService.requestUpload = async () => { throw new TransferError(code, `synthetic ${code}`); };
      const response = await http(port, "POST", uploadUrl, { body: Buffer.from("synthetic"), headers: { ...H, "Content-Type": "application/octet-stream" } });
      assert.equal(response.status, expectedStatus, `${code} maps to ${expectedStatus}`);
    }
    transferService.requestUpload = requestUpload;
    const preview = transferService.preview.bind(transferService);
    transferService.preview = async () => { throw new TransferError("too_large", "preview is too large"); };
    const previewTooLarge = await http(port, "GET", "/api/transfers/preview-test/preview", { headers: H });
    assert.equal(previewTooLarge.status, 413);
    transferService.preview = async () => { throw new TransferError("invalid_text", "preview is not valid UTF-8"); };
    const previewInvalidText = await http(port, "GET", "/api/transfers/preview-test/preview", { headers: H });
    assert.equal(previewInvalidText.status, 400);
    transferService.preview = preview;

    const createInvite = A.daemon.core.createInvite.bind(A.daemon.core);
    A.daemon.core.createInvite = async () => { throw new RelayError("too_large", "relay envelope too large"); };
    const relayTooLarge = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "direct", name: "synthetic" } });
    assert.equal(relayTooLarge.status, 400, "existing relay too_large failures retain their 400 status");
    A.daemon.core.createInvite = createInvite;
    assert.equal((await http(port, "POST", uploadUrl, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/json" } })).status, 415);
    assert.equal((await http(port, "POST", `/api/transfers/upload?ch=unknown&name=x`, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/octet-stream" } })).status, 400);
    assert.equal((await http(port, "POST", "/api/transfers/abc/approve", { headers: H })).status, 404);
    assert.equal((await http(port, "GET", "/api/transfers/tttttttttttttttttttttt/preview")).status, 401);
    assert.equal((await http(port, "GET", "/api/transfers/tttttttttttttttttttttt/preview", { headers: H })).status, 404);
    assert.deepEqual((await http(port, "GET", "/api/mcp", { headers: H })).json().servers, []);
    assert.equal((await http(port, "GET", "/api/nope", { headers: H })).status, 404);

    // --- body limit
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "x".repeat(1024 * 1024 + 10) } })).status, 413);

    // --- leave
    assert.equal((await http(port, "DELETE", `/api/channels/${ch}`, { headers: H })).status, 200);
    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().channels.length, 0);
    assert.ok(events.some((e) => e.type === "channel_removed" && e.ch === ch));
  } finally {
    for (const s of sockets) s.terminate();
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: MCP servers are added, edited and removed from the UI, saved in config.json", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const dir = join(t.dir, "a");
  mkdirSync(dir);
  const A = await startNode(dir, relay.url, "Alice");
  try {
    const port = A.daemon.port;
    const H = { "X-Spencer-Token": A.daemon.token };
    const saved = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).mcpServers;
    const view = (await http(port, "GET", "/api/mcp", { headers: H })).json();
    assert.deepEqual(view.config, {});
    assert.equal(view.presets[0].name, "t3code");
    assert.deepEqual(view.presets[0].config.args.slice(-2), ["mcp", "t3"]);
    assert.deepEqual(view.presets[0].config.disabledTools, ["thread_list", "thread_start", "thread_send", "thread_show"], "T3 tools start off");
    assert.deepEqual(view.spencerBridge.args.slice(-4), ["mcp", "spencer", "--data-dir", dir]);

    const put = (name: string, body: unknown) => http(port, "PUT", `/api/mcp/servers/${name}`, { headers: H, body });
    assert.equal((await put("bad%20name", { command: "x" })).status, 400);
    assert.equal((await put("x", { command: " " })).status, 400);
    assert.equal((await put("x", { url: "ftp://host" })).status, 400);
    assert.equal((await put("x", { command: "x", url: "http://h" })).status, 400);
    assert.equal((await put("x", { command: "x", env: { A: 1 } })).status, 400);
    assert.equal((await put("__proto__", { command: "x" })).status, 400);
    assert.equal((await put("a--b", { command: "x" })).status, 400);
    assert.equal((await http(port, "DELETE", "/api/mcp/servers/toString", { headers: H })).status, 404);
    assert.deepEqual(saved(), {}, "nothing saved on errors");

    const r = await put("tools", { command: " npx ", args: ["-y", "pkg"], env: {}, junk: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().config, { tools: { command: "npx", args: ["-y", "pkg"] } });
    assert.deepEqual(saved(), { tools: { command: "npx", args: ["-y", "pkg"] } });
    assert.equal((await put("tools", { command: "npx", disabledTools: "x" })).status, 400);
    assert.deepEqual((await put("tools", { command: "npx", disabledTools: ["a", "a"] })).json().config.tools, { command: "npx", disabledTools: ["a"] });
    await put("tools", { command: "npx", disabled: true });
    assert.deepEqual(saved(), { tools: { command: "npx", disabled: true } });
    await put("web", { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } });
    assert.equal((await put("we_b", { command: "x" })).status, 200);
    assert.match((await put("we-b", { command: "x" })).text, /collide/, "tool names would clash with we_b");
    assert.equal((await http(port, "DELETE", "/api/mcp/servers/we_b", { headers: H })).status, 200);
    assert.equal((await http(port, "DELETE", "/api/mcp/servers/tools", { headers: H })).status, 200);
    assert.equal((await http(port, "DELETE", "/api/mcp/servers/tools", { headers: H })).status, 404);
    assert.deepEqual(saved(), { web: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } } });
    assert.deepEqual(A.daemon.config.mcpServers, saved(), "running config follows");
    assert.deepEqual(
      A.agent().mcpSets.map(([n, c]) => [n, c === undefined ? "removed" : "url" in (c as object) ? "url" : "command"]),
      [["tools", "command"], ["tools", "command"], ["tools", "command"], ["web", "url"], ["we_b", "command"], ["we_b", "removed"], ["tools", "removed"]],
      "each change applied right away",
    );
  } finally {
    await A.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: experimental features are off by default; the gates answer 403 until they are turned on", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  mkdirSync(join(t.dir, "a"));
  mkdirSync(join(t.dir, "b"));
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice");
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  try {
    const port = A.daemon.port;
    const H = { "X-Spencer-Token": A.daemon.token };
    const direct = (await http(port, "POST", "/api/invites", { headers: H, body: { kind: "group", name: "Plain" } })).json().channel;

    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().experimental, false);
    assert.equal((await http(port, "GET", "/api/soul", { headers: H })).status, 403);
    assert.equal((await http(port, "PUT", "/api/model/conversation", { headers: H, body: { provider: null } })).status, 403);
    assert.equal((await http(port, "POST", "/api/invites", { headers: H, body: { kind: "conversation", name: "Debates" } })).status, 403);
    assert.equal((await http(port, "GET", `/api/channels/${direct.id}/conversation`, { headers: H })).status, 403);
    assert.equal((await http(port, "PATCH", `/api/channels/${direct.id}`, { headers: H, body: { heated: true } })).status, 403);
    await assert.rejects(A.daemon.core.createInvite("conversation", "Debates"), /experimental/, "the agent's create_invite path too");

    assert.equal((await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: "yes" } })).status, 400);
    const on = await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: true } });
    assert.deepEqual(on.json(), { enabled: true });
    assert.equal(A.agent().experimentalChanges, 1);
    assert.equal(JSON.parse(readFileSync(join(t.dir, "a", "config.json"), "utf8")).experimental, true, "saved in config.json");
    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().experimental, true);
    await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: true } });
    assert.equal(A.agent().experimentalChanges, 1, "no change, nothing re-applied");

    const inv = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "conversation", name: "Debates" } });
    assert.equal(inv.status, 200);
    const convo = inv.json().channel;
    assert.equal(convo.mode, "conversation");
    assert.equal(convo.heated, false);
    assert.equal((await http(port, "PATCH", `/api/channels/${direct.id}`, { headers: H, body: { heated: true } })).status, 400, "only Conversations channels");
    const hot = await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { heated: true } });
    assert.equal(hot.status, 200);
    assert.equal(hot.json().heated, true);

    // A person writing in a Conversations channel: the agent gives the message its conversation, peers get it.
    const ok = await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link: inv.json().link } });
    assert.equal(ok.status, 200);
    await waitFor(() => A.daemon.core.getChannel(convo.id)!.members.length === 2, "joined");
    const ref = { id: "C".repeat(22), start: true as const, heated: true as const };
    A.agent().convoRef = ref;
    const sent = (await http(port, "POST", `/api/channels/${convo.id}/messages`, { headers: H, body: { text: "yo" } })).json();
    await waitFor(() => A.agent().outgoing.some((o) => o.id === sent.id), "outgoing");
    assert.deepEqual(A.agent().outgoing.find((o) => o.id === sent.id)!.convo, ref, "the agent learns which conversation it started");
    await waitFor(() => B.agent().peerChats.some((c) => c.id === sent.id), "B got it");
    assert.deepEqual(B.agent().peerChats.find((c) => c.id === sent.id)!.body.convo, ref);
    // Not in a plain group.
    const plain = (await http(port, "POST", `/api/channels/${direct.id}/messages`, { headers: H, body: { text: "hi" } })).json();
    await waitFor(() => A.agent().outgoing.some((o) => o.id === plain.id), "outgoing plain");
    assert.equal(A.agent().outgoing.find((o) => o.id === plain.id)!.convo, undefined);

    await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: false } });
    assert.equal((await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { heated: false } })).status, 403);
    assert.equal((await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { name: "Still renamable" } })).status, 200);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: placeholder page when the web UI is not installed", async () => {
  const t = tempDir();
  const A = await startNode(t.dir, "ws://127.0.0.1:1/ws", "Solo");
  try {
    const r = await http(A.daemon.port, "GET", "/");
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A.daemon.token));
    assert.ok(r.text.includes("Spencer is running"));
  } finally {
    await A.daemon.stop();
    t.cleanup();
  }
});
