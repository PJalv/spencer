import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SpencerAgent } from "../../src/agent/agent.ts";
import type { FakeBrainHooks, FakeRequestInfo } from "../../src/agent/fake-brain.ts";
import { createEventsMcpServer, type FakeEventsMcpServerOptions } from "./fixtures/events-mcp-server.ts";
import { channel, makeCore, peerChat, waitFor } from "./helpers.ts";

const echo = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.ts", import.meta.url))] };
const eventSpec = (server = "t3code", name = "thread.run_settled", args: Record<string, unknown> = { threadIds: ["th-1"] }) => ({ server, events: [{ name, arguments: args }] });
const schedule = (extra: Record<string, unknown> = {}) => ({ in_minutes: 60, note: '/tool mcp__t3code__t3_thread_read {"threadId":"th-1"}', on_event: eventSpec(), ...extra });
const isWake = (info: FakeRequestInfo) => info.text.includes("<followup_note>");

async function harness(options: FakeEventsMcpServerOptions = {}, hooks: FakeBrainHooks = {}) {
  const reads: Record<string, unknown>[] = [];
  const server = await createEventsMcpServer({ autoHeartbeat: true, heartbeatMs: 40, tools: [{ name: "t3_thread_read", run: (args) => { reads.push(args); return "authoritative thread summary"; } }], ...options });
  const core = makeCore({ channels: [channel("chFull", "direct", "Full", { trust: "full" }), channel("chAllowed", "direct", "Allowed", { allowedMcpTools: ["mcp__t3code__t3_thread_read"] }), channel("chPlain", "direct", "Plain")], config: { mcpServers: { t3code: { url: server.url }, echo } } });
  const requests: FakeRequestInfo[] = [];
  const newAgent = (extraHooks: FakeBrainHooks = hooks) => new SpencerAgent(core, { log: () => {}, mcpEvents: { heartbeatMs: 80, backoffMinMs: 20, backoffMaxMs: 50, pollFloorMs: 20 }, fakeHooks: { ...extraHooks, onRequest: (info) => { requests.push(info); extraHooks.onRequest?.(info); } } });
  let agent = newAgent();
  try { await agent.start(); await agent.mcpSettled(); } catch (e) { await agent.stop(); await server.close(); core.cleanup(); throw e; }
  return { server, core, reads, requests, get agent() { return agent; },
    async restart(extraHooks: FakeBrainHooks = {}) { await agent.stop(); agent = newAgent(extraHooks); await agent.start(); await agent.mcpSettled(); },
    async tool(name: string, args: Record<string, unknown>) { await agent.ownerSend(`/tool ${name} ${JSON.stringify(args)}`); await agent.idle(); },
    async watch(extra: Record<string, unknown> = {}) { const before = new Set(agent.listFollowups().map(f => f.id)); await this.tool("schedule_followup", schedule(extra)); const f = agent.listFollowups().find(f => !before.has(f.id)); assert.ok(f, requests.at(-1)?.text); await waitFor(() => server.streamCount() > 0 || server.requestLog.some(r => r.method === "events/poll"), "event subscription"); return f.id; },
    async wakes(id: string, count: number) { await waitFor(() => agent.listFollowups().some(f => f.id === id && f.wakeCount === count && f.state === "pending"), `${count} completed wakes`); await agent.idle(); },
    async close() { await agent.stop(); await server.close(); core.cleanup(); },
  };
}

test("outbound HTTP and stdio MCP tools coexist with Events discovery", async () => {
  const h = await harness();
  try {
    await h.tool("mcp__t3code__t3_thread_read", {});
    assert.ok(h.requests.some(r => r.text.includes("authoritative thread summary")));
    await h.tool("mcp__echo__echo", { text: "hi" });
    assert.ok(h.requests.some(r => r.text.includes("echo: hi")));
    assert.equal(h.agent.mcpStatus().find(s => s.name === "t3code")?.events?.status, "supported");
  } finally { await h.close(); }
});

for (const scenario of [
  { name: "stdio", options: {}, spec: eventSpec("echo"), error: /stdio.*HTTP.*2026-07-28/i },
  { name: "old protocol", options: { supportedVersions: ["2025-11-25"] }, spec: eventSpec(), error: /2026-07-28/ },
  { name: "missing capability", options: { omitEventsCapability: true }, spec: eventSpec(), error: /does not support MCP Events.*(?:capability|extension)/i },
  { name: "unknown name", options: {}, spec: eventSpec("t3code", "unknown.event"), error: /Available events:.*thread.run_settled/ },
  { name: "invalid schema", options: {}, spec: eventSpec("t3code", "thread.run_settled", { threadIds: 42 }), error: /(?:invalid|schema|must be array)/i },
  { name: "webhook only", options: { events: [{ name: "thread.run_settled", delivery: ["webhook"], inputSchema: { type: "object" } }] }, spec: eventSpec(), error: /webhook.*push or poll required/i },
  { name: "reply and event combined", options: {}, spec: eventSpec(), error: /on_reply_from and on_event cannot be combined/, extra: { on_reply_from: "chFull" } },
]) {
  test(`schedule_followup rejects ${scenario.name} with an actionable error`, async () => {
    const h = await harness(scenario.options);
    try {
      await h.tool("schedule_followup", schedule({ on_event: scenario.spec, ...scenario.extra }));
      assert.equal(h.agent.listFollowups().length, 0);
      assert.match(h.requests.at(-1)!.text, scenario.error);
    } finally { await h.close(); }
  });
}

test("matching events wake the intended owner with redacted untrusted data and authoritative re-read", async () => {
  const h = await harness();
  try {
    const id = await h.watch();
    h.server.emit("thread.run_settled", { threadId: "th-other" });
    h.server.emit("pr.watch_wake", { threadId: "th-1" });
    await delay(120);
    assert.equal(h.requests.filter(isWake).length, 0);
    h.server.emit("thread.run_settled", { threadId: "th-1", summary: "ok Bearer leak-secret-token" });
    await h.wakes(id, 1);
    const wake = h.requests.find(isWake)!;
    assert.equal(wake.conversation, "owner");
    assert.match(wake.text, /<untrusted_note/);
    assert.match(wake.text, /Re-read authoritative state/);
    assert.match(wake.text, /\[redacted\]/);
    assert.ok(!wake.text.includes("leak-secret-token"));
    assert.deepEqual(h.reads, [{ threadId: "th-1" }]);
    const f = h.agent.listFollowups().find(f => f.id === id)!;
    assert.equal(f.firedBy, "event");
    assert.equal(f.eventSubscriptions?.[0]?.event, "thread.run_settled");
  } finally { await h.close(); }
});

test("event deduplication is per subscription, including redelivery after both watches rearm", async () => {
  const h = await harness();
  try {
    const a = await h.watch(); const b = await h.watch();
    await waitFor(() => h.server.streamCount() === 2);
    h.server.emit("thread.run_settled", { threadId: "th-1" }, { eventId: "evt-dup-1" });
    await h.wakes(a, 1); await h.wakes(b, 1);
    h.server.emit("thread.run_settled", { threadId: "th-1" }, { eventId: "evt-dup-1" });
    await delay(120); await h.agent.idle();
    assert.deepEqual(h.agent.listFollowups().map(f => f.wakeCount), [1, 1]);
    assert.equal(h.requests.filter(isWake).length, 2);
    assert.equal(h.reads.length, 2);
  } finally { await h.close(); }
});

test("heartbeats persist cursor and heartbeat time without any follow-up model turn", async () => {
  const h = await harness({ autoHeartbeat: false });
  try {
    await h.watch();
    const modelCalls = h.requests.length;
    for (let i = 0; i < 3; i++) {
      const before = h.core.db.prepare("SELECT last_heartbeat_at FROM mcp_event_subscriptions").get()!.last_heartbeat_at;
      await delay(5);
      // A filtered event advances the server cursor without producing a wake.
      h.server.emit("thread.run_settled", { threadId: "unrelated" });
      h.server.emitHeartbeat();
      await waitFor(() => h.core.db.prepare("SELECT last_heartbeat_at FROM mcp_event_subscriptions").get()!.last_heartbeat_at !== before);
      assert.equal(h.core.db.prepare("SELECT cursor FROM mcp_event_subscriptions").get()!.cursor, `1.${i + 1}`);
    }
    assert.equal(h.requests.filter(isWake).length, 0);
    assert.equal(h.requests.length, modelCalls);
    assert.equal(h.agent.listFollowups()[0]!.wakeCount, 0);
  } finally { await h.close(); }
});

for (const queued of [false, true]) {
  test(`restart recovers admitted active event work${queued ? " and a queued update" : ""} with persisted cursor`, async () => {
    let held = false;
    const h = await harness({}, { gate: (info, signal) => isWake(info) && info.text.includes("HOLD") ? new Promise<void>((_resolve, reject) => { held = true; signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); }) : Promise.resolve() });
    try {
      const id = await h.watch();
      h.server.emit("thread.run_settled", { threadId: "th-1", phase: "finished" });
      await h.wakes(id, 1);
      h.server.emit("thread.run_settled", { threadId: "th-1", phase: "HOLD" });
      await waitFor(() => held, "active event wake");
      if (queued) {
        h.server.emit("thread.run_settled", { threadId: "th-1", phase: "QUEUED" });
        await waitFor(() => h.core.db.prepare("SELECT count(*) AS n FROM agent_watch_updates WHERE claimed = 0").get()!.n === 1);
      }
      const cursor = h.core.db.prepare("SELECT cursor FROM mcp_event_subscriptions").get()!.cursor;
      const logStart = h.server.requestLog.length;
      await h.restart();
      await h.wakes(id, queued ? 3 : 2);
      await waitFor(() => h.server.requestLog.slice(logStart).some(r => r.method === "events/stream" && r.body.params.cursor === cursor), "reconnect with durable cursor");
      assert.equal(h.requests.filter(r => isWake(r) && r.text.includes('"finished"')).length, 1);
      assert.equal(h.reads.length, queued ? 3 : 2);
      if (queued) assert.equal(h.requests.filter(r => isWake(r) && r.text.includes('"QUEUED"')).length, 1);
      assert.equal(h.core.db.prepare("SELECT count(*) AS n FROM agent_watch_updates WHERE claimed = 0").get()!.n, 0);
    } finally { await h.close(); }
  });
}

test("stream reconnect replays missed events from durable cursor without repeating completed wakes", async () => {
  const h = await harness();
  try {
    const id = await h.watch();
    const first = h.server.emit("thread.run_settled", { threadId: "th-1" });
    await h.wakes(id, 1);
    const logStart = h.server.requestLog.length;
    h.server.dropStreams();
    h.server.emit("thread.run_settled", { threadId: "th-1" });
    await h.wakes(id, 2);
    assert.ok(h.server.requestLog.slice(logStart).some(r => r.method === "events/stream" && r.body.params.cursor === first.cursor));
    await delay(100);
    assert.equal(h.requests.filter(isWake).length, 2);
  } finally { await h.close(); }
});

for (const epochReset of [false, true]) {
  test(`${epochReset ? "server epoch reset" : "mid-stream gap"} wakes reconciliation against authoritative state`, async () => {
    const h = await harness();
    try {
      const id = await h.watch();
      await waitFor(() => h.core.db.prepare("SELECT cursor FROM mcp_event_subscriptions").get()!.cursor !== null);
      if (epochReset) h.server.restart(); else h.server.emitGap();
      await h.wakes(id, 1);
      assert.match(h.requests.find(isWake)!.text, /gap\/truncation/);
      assert.match(h.requests.find(isWake)!.text, /MUST re-read authoritative state/);
      assert.equal(h.reads.length, 1);
    } finally { await h.close(); }
  });
}

test("revocation stops streams, records owner note and status, and never retries", async () => {
  const h = await harness();
  try {
    await h.watch(); h.server.revoke(401);
    await waitFor(() => h.agent.mcpStatus().find(s => s.name === "t3code")?.events?.status === "revoked");
    assert.equal(h.core.db.prepare("SELECT state FROM mcp_event_subscriptions").get()!.state, "revoked");
    assert.equal(h.agent.mcpStatus().find(s => s.name === "t3code")?.status, "error");
    await waitFor(async () => (await h.agent.ownerTranscript(100)).some(n => /authorization was revoked/.test(n.text)));
    assert.equal(h.server.streamCount(), 0);
    const count = h.server.requestLog.length; await delay(200);
    assert.equal(h.server.requestLog.length, count);
  } finally { await h.close(); }
});

test("busy owner serializes the event wake behind the active owner turn", async () => {
  let entered = false; let release = () => {};
  const h = await harness({}, { gate: (info, signal) => info.text === "BUSY_OWNER" ? new Promise<void>((resolve, reject) => { entered = true; release = resolve; signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); }) : Promise.resolve() });
  try {
    const id = await h.watch();
    await h.agent.ownerSend("BUSY_OWNER"); await waitFor(() => entered);
    h.server.emit("thread.run_settled", { threadId: "th-1" });
    await waitFor(() => h.agent.listFollowups()[0]!.wakeCount === 1);
    await delay(100);
    assert.equal(h.requests.filter(isWake).length, 0);
    release(); await h.wakes(id, 1);
    assert.equal(h.requests.filter(isWake).length, 1);
    const transcript = await h.agent.ownerTranscript(100);
    assert.ok(transcript.findIndex(n => n.text === "ok: BUSY_OWNER") < transcript.findIndex(n => n.text.startsWith("Follow-up (scheduled")));
  } finally { release(); await h.close(); }
});

for (const chId of ["chFull", "chAllowed"]) {
  test(`${chId} event watches stay channel scoped, reply twice, and cancel when autoReply turns off`, async () => {
    const h = await harness();
    try {
      const plain = h.core.getChannel("chPlain")!;
      await h.agent.onPeerChat(peerChat(plain, `please call schedule_followup ${JSON.stringify(schedule())}`)); await h.agent.idle();
      const plainRequest = h.requests.find(r => r.conversation === "channel")!;
      assert.ok(!plainRequest.systemPrompt.includes("thread.run_settled"));
      assert.ok(!plainRequest.systemPrompt.includes("t3code"));
      assert.ok(h.requests.some(r => /Policy violation/.test(r.text)));
      assert.equal(h.agent.listFollowups().length, 0);
      const ch = h.core.getChannel(chId)!;
      await h.agent.onPeerChat(peerChat(ch, `please call schedule_followup ${JSON.stringify(schedule({ note: "report progress" }))}`)); await h.agent.idle();
      const f = h.agent.listFollowups()[0]!;
      assert.equal(f.ch, chId); assert.equal(f.conversation, "channel");
      await waitFor(() => h.server.streamCount() === 1);
      for (let i = 1; i <= 2; i++) { h.server.emit("thread.run_settled", { threadId: "th-1", milestone: i }); await h.wakes(f.id, i); }
      const replies = h.core.sent.filter(s => s.origin === "agent-followup");
      assert.equal(replies.length, 2); assert.ok(replies.every(s => s.ch === chId));
      assert.equal(new Set(replies.map(s => s.idempotencyKey)).size, 2);
      assert.ok(replies.every(s => s.idempotencyKey));
      assert.ok(h.requests.filter(isWake).every(r => r.conversation === "channel"));
      assert.equal(h.core.db.prepare("SELECT conv FROM agent_followups WHERE id = ?").get(f.id)!.conv, `ch:${chId}`);
      ch.autoReply = false;
      h.server.emit("thread.run_settled", { threadId: "th-1", milestone: 3 });
      await waitFor(() => h.agent.listFollowups()[0]!.state === "cancelled");
      await waitFor(() => h.server.streamCount() === 0);
      assert.equal(h.requests.filter(isWake).length, 2);
    } finally { await h.close(); }
  });
}

test("poll-only event delivery wakes the owner end to end", async () => {
  const h = await harness({ events: [{ name: "thread.run_settled", delivery: ["poll"], inputSchema: { type: "object" } }], nextPollMs: 20 });
  try {
    const id = await h.watch();
    await waitFor(() => h.core.db.prepare("SELECT cursor FROM mcp_event_subscriptions").get()!.cursor !== null);
    h.server.emit("thread.run_settled", { threadId: "th-1" }); await h.wakes(id, 1);
    assert.equal(h.server.streamCount(), 0); assert.equal(h.reads.length, 1);
    assert.equal(h.requests.find(isWake)!.conversation, "owner");
  } finally { await h.close(); }
});

for (const viaTool of [false, true]) {
  test(`${viaTool ? "cancel_followup tool" : "cancelFollowup API"} immediately tears down live stream`, async () => {
    const h = await harness();
    try {
      const id = await h.watch(); assert.equal(h.server.streamCount(), 1);
      if (viaTool) await h.tool("cancel_followup", { id }); else h.agent.cancelFollowup(id);
      await waitFor(() => h.server.streamCount() === 0, "cancelled stream closes", 1000);
      assert.equal(h.agent.listFollowups()[0]!.state, "cancelled");
      h.server.emit("thread.run_settled", { threadId: "th-1" }); await delay(100);
      assert.equal(h.requests.filter(isWake).length, 0);
    } finally { await h.close(); }
  });
}

test("channel trust downgrade, deny guardrail, and Conversations mode block/cancel active event watches", async () => {
  const h = await harness();
  try {
    // Conversations channels must never get MCP Events prompt or subscribe.
    const convo = channel("chConvo", "group", "Banter", { mode: "conversation", trust: "full" });
    h.core.channels.set("chConvo", convo);
    await h.agent.channelChanged("chConvo");
    await h.agent.onPeerChat(peerChat(convo, `please call schedule_followup ${JSON.stringify(schedule())}`, { mentions: ["me"] }));
    await h.agent.idle();
    assert.equal(h.agent.listFollowups().length, 0);

    // Narrow deny guardrail covering all server tools cancels an active Full Trust watch on channelChanged.
    const full = h.core.getChannel("chFull")!;
    await h.agent.onPeerChat(peerChat(full, `please call schedule_followup ${JSON.stringify(schedule({ note: "watch" }))}`));
    await h.agent.idle();
    await waitFor(() => h.server.streamCount() === 1);
    h.core.toolPolicies.replace({ scopeKind: "channel", scopeId: "chFull" }, [{ toolPattern: "mcp__t3code__t3_*", effect: "deny" }]);
    await h.agent.channelChanged("chFull");
    assert.equal(h.agent.listFollowups()[0]!.state, "cancelled");
    await waitFor(() => h.server.streamCount() === 0);

    // Downgrading Full Trust -> Standard without allowedMcpTools cancels on drainWatch too even if channelChanged wasn't called yet.
    h.core.toolPolicies.replace({ scopeKind: "channel", scopeId: "chFull" }, []);
    await h.agent.channelChanged("chFull");
    await h.agent.onPeerChat(peerChat(full, `please call schedule_followup ${JSON.stringify(schedule({ note: "watch2" }))}`));
    await h.agent.idle();
    const second = h.agent.listFollowups().find((f) => f.state === "pending")!;
    await waitFor(() => h.server.streamCount() === 1);
    full.trust = "standard";
    full.allowedMcpTools = [];
    h.server.emit("thread.run_settled", { threadId: "th-1" });
    await waitFor(() => h.agent.listFollowups().find((f) => f.id === second.id)?.state === "cancelled");
    await waitFor(() => h.server.streamCount() === 0);
    assert.equal(h.requests.filter(isWake).length, 0);
  } finally { await h.close(); }
});

test("transient discovery error reports status error and recovers automatically when MCP server comes online", async () => {
  let unavailable = true;
  const backend = await createEventsMcpServer({ tools: [{ name: "t3_thread_read", run: () => "ok" }] });
  const proxy = createServer(async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString("utf8");
      if (unavailable) {
        res.writeHead(503, { "content-type": "text/plain" }).end("starting up");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k.toLowerCase() !== "host") headers[k] = v;
      const upstream = await fetch(backend.url, { method: req.method, headers, body: req.method === "POST" ? raw : undefined, signal: ac.signal });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      if (!upstream.body) { res.end(); return; }
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch {
      if (!res.writableEnded) res.end();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const addr = proxy.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const core = makeCore({ config: { mcpServers: { t3code: { url } } } });
  const agent = new SpencerAgent(core, { log: () => {}, mcpEvents: { heartbeatMs: 80, backoffMinMs: 20, backoffMaxMs: 40 } });
  try {
    await agent.start();
    await agent.mcpSettled();
    assert.equal(agent.mcpStatus().find((s) => s.name === "t3code")?.events?.status, "error");
    unavailable = false;
    await waitFor(() => agent.mcpStatus().find((s) => s.name === "t3code")?.events?.status === "supported", "events recover after 503", 5000);
    await agent.ownerSend(`/tool schedule_followup ${JSON.stringify(schedule())}`);
    await agent.idle();
    await waitFor(() => backend.streamCount() === 1, "stream opens after transient recovery");
  } finally {
    await agent.stop();
    proxy.closeAllConnections();
    proxy.close();
    await once(proxy, "close");
    await backend.close();
    core.cleanup();
  }
});

test("channel event watch paused by turn budget drains once owner resets budget and final wake prompt notes closure", async () => {
  const reads: Record<string, unknown>[] = [];
  const server = await createEventsMcpServer({ autoHeartbeat: true, heartbeatMs: 40, tools: [{ name: "t3_thread_read", run: (a) => { reads.push(a); return "ok"; } }] });
  const core = makeCore({
    channels: [channel("chFull", "direct", "Full", { trust: "full" })],
    config: { mcpServers: { t3code: { url: server.url } }, policy: { maxAgentTurnsFullTrust: 1 } as never },
  });
  const requests: FakeRequestInfo[] = [];
  const agent = new SpencerAgent(core, { log: () => {}, mcpEvents: { heartbeatMs: 80, backoffMinMs: 20, backoffMaxMs: 40, watchRetryMs: 10_000 }, fakeHooks: { onRequest: (r) => requests.push(r) } });
  try {
    await agent.start(); await agent.mcpSettled();
    const ch = core.getChannel("chFull")!;
    // First peer message consumes the 1-turn streak budget and schedules a single-shot (watch: false) event follow-up.
    await agent.onPeerChat(peerChat(ch, `please call schedule_followup ${JSON.stringify(schedule({ watch: false, note: "single shot" }))}`));
    await agent.idle();
    const f = agent.listFollowups()[0]!;
    await waitFor(() => server.streamCount() === 1);
    server.emit("thread.run_settled", { threadId: "th-1" });
    await waitFor(() => core.db.prepare("SELECT count(*) AS n FROM agent_watch_updates WHERE claimed = 0").get()!.n === 1, "event admitted while budget exhausted");
    assert.equal(requests.filter(isWake).length, 0);
    // Owner types in channel -> refills budget -> immediately drains the queued event wake.
    await agent.onOutgoingChat({ id: "owner-msg-1", ch: "chFull", text: "go ahead", origin: "human", ts: Date.now() });
    await waitFor(() => agent.listFollowups().find((x) => x.id === f.id)?.state === "done", "drained after budget refill");
    await agent.idle();
    const wake = requests.find(isWake)!;
    assert.match(wake.text, /final wake 1\/1: this watch will now close/);
    await waitFor(() => server.streamCount() === 0);
  } finally {
    await agent.stop();
    await server.close();
    core.cleanup();
  }
});

test("protocol discovery error (-32602) reports status error (not unsupported), distinguishes schedule_followup error, and recovers on re-probe", async () => {
  const h = await harness({
    discoverError: { httpStatus: 400, code: -32602, message: "Required request metadata is missing" },
  });
  try {
    const status = h.agent.mcpStatus().find((s) => s.name === "t3code");
    assert.equal(status?.status, "connected");
    assert.equal(status?.events?.status, "error");
    assert.match(status?.events?.error ?? "", /Required request metadata is missing/);

    await h.tool("schedule_followup", schedule());
    assert.equal(h.agent.listFollowups().length, 0);
    assert.match(h.requests.at(-1)!.text, /MCP Events discovery failed for t3code/);
    assert.doesNotMatch(h.requests.at(-1)!.text, /does not support MCP Events/);

    // Once the server recovers, the next schedule_followup re-probes and succeeds without needing a reconnect.
    h.server.setDiscoverError(undefined);
    const id = await h.watch();
    assert.equal(h.agent.mcpStatus().find((s) => s.name === "t3code")?.events?.status, "supported");
    h.server.emit("thread.run_settled", { threadId: "th-1" });
    await h.wakes(id, 1);
    assert.equal(h.reads.length, 1);
  } finally {
    await h.close();
  }
});
