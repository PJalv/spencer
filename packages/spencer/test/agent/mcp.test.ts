import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpManager, mcpToolName } from "../../src/agent/mcp.ts";
import { SpencerAgent } from "../../src/agent/agent.ts";
import type { FakeRequestInfo } from "../../src/agent/fake-brain.ts";
import type { DaemonEvent } from "../../src/contracts.ts";
import { CHANNEL_TOOLS, ME, channel, makeCore, peerChat, waitFor } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-mcp-server.ts", import.meta.url));
const ECHO = { command: process.execPath, args: [FIXTURE] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("mcpToolName sanitizes and caps at 64 chars", () => {
  assert.equal(mcpToolName("echo", "echo"), "mcp__echo__echo");
  assert.equal(mcpToolName("my-srv", "do.thing/now"), "mcp__my_srv__do_thing_now");
  assert.equal(mcpToolName("s", "x".repeat(100)).length, 64);
});

test("McpManager: connects a stdio server, lists and calls tools, stops its child", async () => {
  const events: DaemonEvent[] = [];
  const mgr = new McpManager({ echo: ECHO, off: { command: "nonexistent-binary", disabled: true } }, { events: { emit: (e) => events.push(e) } });
  mgr.start();
  await mgr.settled();
  const status = mgr.status();
  const echo = status.find((s) => s.name === "echo")!;
  assert.equal(echo.status, "connected");
  assert.equal(echo.transport, "stdio");
  assert.deepEqual(
    echo.tools.map((t) => t.name),
    ["mcp__echo__echo", "mcp__echo__pid", "mcp__echo__fail", "mcp__echo__big"],
  );
  assert.equal(status.find((s) => s.name === "off")!.status, "disabled");
  assert.ok(events.some((e) => e.type === "mcp" && e.servers.some((s) => s.status === "connected")));

  const tool = mgr.tools().find((t) => t.name === "mcp__echo__echo")!;
  assert.deepEqual(await tool.execute({ text: "hi" }, { conversationKey: "owner", callId: "c1" }), { text: "echo: hi", isError: false });
  assert.deepEqual(await mgr.call("echo", "fail", {}), { text: "it failed", isError: true });
  const big = await mgr.call("echo", "big", {});
  assert.ok(Buffer.byteLength(big.text) <= 32 * 1024 + 64 && big.text.endsWith("[truncated to 32 KB]"));
  const pid = Number((await mgr.call("echo", "pid", {})).text);
  assert.ok(alive(pid));

  await mgr.stop();
  assert.equal(alive(pid), false, "no orphan child after stop");
  assert.deepEqual(await mgr.call("echo", "echo", { text: "x" }), { text: "MCP server echo is not connected.", isError: true });
});

test("McpManager: servers are added, replaced and removed while running", async () => {
  const mgr = new McpManager({});
  let changes = 0;
  mgr.onChange(() => changes++);
  mgr.start();
  await mgr.set("echo", ECHO);
  await mgr.settled();
  assert.equal(mgr.status()[0]!.status, "connected");
  const pid = Number((await mgr.call("echo", "pid", {})).text);

  await mgr.set("echo", { ...ECHO, disabled: true });
  assert.deepEqual(mgr.status().map((s) => [s.name, s.status]), [["echo", "disabled"]]);
  assert.equal(alive(pid), false, "the old child is stopped");
  assert.equal(mgr.tools().length, 0);

  await mgr.set("echo2", ECHO);
  await mgr.settled();
  assert.ok(mgr.tools().some((t) => t.name === "mcp__echo2__echo"));
  const pid2 = Number((await mgr.call("echo2", "pid", {})).text);
  await mgr.set("echo2", undefined);
  assert.deepEqual(mgr.status().map((s) => s.name), ["echo"]);
  assert.equal(alive(pid2), false);
  assert.ok(changes >= 4);
  await mgr.stop();
});

test("McpManager: overlapping edits of one server apply in order and leave no stray child", async () => {
  const mgr = new McpManager({});
  mgr.start();
  await mgr.set("echo", ECHO);
  await mgr.settled();
  const pid = Number((await mgr.call("echo", "pid", {})).text);
  await Promise.all([mgr.set("echo", ECHO), mgr.set("echo", { ...ECHO, disabled: true })]);
  await mgr.settled();
  assert.deepEqual(mgr.status().map((s) => [s.name, s.status]), [["echo", "disabled"]], "the last edit wins");
  assert.equal(alive(pid), false);
  await mgr.stop();
});

test("McpManager: single tools turn off and on without restarting the server", async () => {
  const mgr = new McpManager({});
  mgr.start();
  await mgr.set("echo", ECHO);
  await mgr.settled();
  const pid = Number((await mgr.call("echo", "pid", {})).text);
  await mgr.set("echo", { ...ECHO, disabledTools: ["echo"] });
  assert.ok(!mgr.tools().some((t) => t.name === "mcp__echo__echo"), "hidden from the model");
  assert.ok(mgr.tools().some((t) => t.name === "mcp__echo__pid"));
  assert.equal(mgr.status()[0]!.tools.find((t) => t.remote === "echo")?.enabled, false, "still listed for the UI");
  assert.deepEqual(await mgr.call("echo", "echo", { text: "x" }), { text: "The echo tool of MCP server echo is turned off.", isError: true });
  assert.equal(Number((await mgr.call("echo", "pid", {})).text), pid, "same connection");
  await mgr.set("echo", ECHO);
  assert.ok(mgr.tools().some((t) => t.name === "mcp__echo__echo"));
  // Hand-written config: other key order, empty lists; a tool switch still keeps the connection.
  await mgr.set("echo", { env: {}, args: [...ECHO.args], command: ECHO.command, disabled: false });
  await mgr.settled();
  const pid2 = Number((await mgr.call("echo", "pid", {})).text);
  await mgr.set("echo", { ...ECHO, disabledTools: ["echo"] });
  assert.equal(Number((await mgr.call("echo", "pid", {})).text), pid2);
  await mgr.stop();
});

test("McpManager: a failing server reports an error and does not block", async () => {
  const mgr = new McpManager({ broken: { command: process.execPath, args: ["-e", "process.exit(3)"] } });
  mgr.start();
  await mgr.settled();
  const s = mgr.status()[0]!;
  assert.equal(s.status, "error");
  assert.ok(s.error);
  assert.deepEqual(mgr.tools(), []);
  await mgr.stop();
});

test("agent: owner /tool calls an MCP tool end to end; channels get only allowed MCP tools", async () => {
  const core = makeCore({
    channels: [channel("chA", "direct", "Allowed", { allowedMcpTools: ["mcp__echo__echo"] }), channel("chB", "direct", "Plain")],
    config: { mcpServers: { echo: ECHO } },
  });
  const requests: FakeRequestInfo[] = [];
  const agent = new SpencerAgent(core, { fakeHooks: { onRequest: (i) => requests.push(i) }, log: () => {} });
  await agent.start();
  let pid = 0;
  try {
    await agent.mcpSettled();
    assert.equal(agent.mcpStatus()[0]!.status, "connected");
    await agent.ownerSend('/tool mcp__echo__echo {"text":"hi"}');
    await agent.idle();
    const items = await agent.ownerTranscript(10);
    assert.deepEqual(items.at(-1), { ...items.at(-1)!, role: "assistant", text: "done: echo: hi" });
    assert.ok(items.some((i) => i.role === "tool" && i.toolName === "mcp__echo__echo" && i.text === "echo: hi"));

    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chA"), [...CHANNEL_TOOLS, "mcp__echo__echo"]);
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chB"), CHANNEL_TOOLS);
    await agent.onPeerChat(peerChat(core.getChannel("chB")!, "hello"));
    await agent.idle();
    const chReq = requests.find((r) => r.conversation === "channel")!;
    assert.ok(!chReq.tools.some((t) => t.startsWith("mcp__")));

    // Revoking the permission takes effect on channelChanged.
    core.channels.set("chA", { ...core.getChannel("chA")!, allowedMcpTools: [] });
    await agent.channelChanged("chA");
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chA"), CHANNEL_TOOLS);

    await agent.ownerSend("/tool mcp__echo__pid {}");
    await agent.idle();
    pid = Number((await agent.ownerTranscript(1))[0]!.text.replace("done: ", ""));
    assert.ok(pid > 0 && alive(pid));
  } finally {
    await agent.stop();
    core.cleanup();
  }
  assert.equal(alive(pid), false, "MCP child gone after agent.stop()");
});

test("agent: a full-trust channel gets every MCP tool; calls leave an audit note for the owner", async () => {
  const core = makeCore({
    channels: [channel("chFull", "direct", "Trusted", { trust: "full" })],
    config: { mcpServers: { echo: ECHO } },
  });
  const agent = new SpencerAgent(core, { log: () => {} });
  await agent.start();
  try {
    await agent.mcpSettled();
    const offered = await agent.agentRuntime!.offeredTools("ch:chFull");
    assert.deepEqual(offered.slice(0, CHANNEL_TOOLS.length), CHANNEL_TOOLS);
    assert.ok(offered.includes("mcp__echo__echo") && offered.includes("mcp__echo__pid"));
    await agent.onPeerChat(peerChat(core.getChannel("chFull")!, 'please call mcp__echo__echo {"text":"from bob"}'));
    await agent.idle();
    assert.equal(core.sent.at(-1)!.text, "done: echo: from bob");
    await waitFor(async () => (await agent.ownerTranscript(20)).some((i) => i.role === "note" && i.text.includes("mcp__echo__echo")));
    const note = (await agent.ownerTranscript(20)).find((i) => i.role === "note" && i.text.includes("mcp__echo__echo"))!;
    assert.ok(note.untrusted);
    assert.match(note.text, /^Trusted \(full trust\): your Spencer called mcp__echo__echo/);

    // Back to standard: only the allow-listed tools (none).
    core.channels.set("chFull", { ...core.getChannel("chFull")!, trust: "standard" });
    await agent.channelChanged("chFull");
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chFull"), CHANNEL_TOOLS);
  } finally {
    await agent.stop();
    core.cleanup();
  }
});

test("agent: working status while answering a peer (Thinking… → Using <tool> → done)", async () => {
  const { activityFor } = await import("../../src/agent/agent.ts");
  assert.equal(activityFor("mcp__t3code__t3_thread_read"), "Using t3code · t3 thread read");
  assert.equal(activityFor("ask_owner"), "Asking its owner for approval");
  const core = makeCore({ channels: [channel("chFull", "direct", "Trusted", { trust: "full" })], config: { mcpServers: { echo: ECHO } } });
  const agent = new SpencerAgent(core, { log: () => {} });
  await agent.start();
  try {
    await agent.mcpSettled();
    const msg = peerChat(core.getChannel("chFull")!, 'please call mcp__echo__echo {"text":"x"}');
    await agent.onPeerChat(msg);
    await agent.idle();
    await waitFor(() => core.statuses.some((s) => s.state === "done"), "done status");
    const seen = core.statuses.filter((s) => s.replyTo === msg.id).map((s) => (s.state === "done" ? "done" : s.activity));
    assert.equal(seen[0], "Thinking…");
    assert.ok(seen.includes("Using echo · echo"), JSON.stringify(seen));
    assert.equal(seen.at(-1), "done");
  } finally {
    await agent.stop();
    core.cleanup();
  }
});

test("HTTP connection errors report status and redact credentials", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => { res.writeHead(403); res.end('denied token=verysecret'); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const mgr = new McpManager({ remote: { url: `http://127.0.0.1:${address.port}/mcp?key=verysecret`, headers: { Authorization: "Bearer verysecret" } } });
  try {
    mgr.start();
    await mgr.settled();
    const error = mgr.status()[0].error ?? "";
    assert.match(error, /403/);
    assert.match(error, /denied/);
    assert.doesNotMatch(error, /verysecret/);
  } finally {
    await mgr.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Full Trust policies gate real MCP calls, apply peer locks in groups, and leave owner unrestricted', async () => {
  const core = makeCore({channels:[channel('guarded','group','Guarded',{trust:'full'}), channel('unrelated','direct','Unrelated',{trust:'full'})], config:{mcpServers:{echo:ECHO}}});
  const peer = core.getChannel('guarded')!.members.find(m=>!m.me)!;
  const requests: FakeRequestInfo[]=[];
  const agent = new SpencerAgent(core,{fakeHooks:{onRequest:r=>requests.push(r)},log(){}});
  try {
    await agent.start(); await agent.mcpSettled();
    core.toolPolicies.replace({scopeKind:'channel',scopeId:'guarded'},[
      {toolPattern:'*pid',effect:'deny'}, {toolPattern:'*fail',effect:'ask_owner'},
      {toolPattern:'*echo',effect:'allow',argDefaults:{text:'injected'},argLocks:{provider:'codex','modelSelection.model':'chosen'},argAllowValues:{projectId:['spencer']}}
    ]);
    core.toolPolicies.replace({scopeKind:'peer',scopeId:peer.id},[{toolPattern:'*echo',effect:'allow',argLocks:{model:'peer-model'}}]);
    await agent.channelChanged('guarded');
    const offered=await agent.agentRuntime!.offeredTools('ch:guarded');
    assert.ok(!offered.includes('mcp__echo__pid')); assert.ok(offered.includes('mcp__echo__echo'));
    const call=async(tool:string,args:unknown)=>{await agent.onPeerChat(peerChat(core.getChannel('guarded')!,`please call mcp__echo__${tool} ${JSON.stringify(args)}`, {mentions:[ME.id]})); await agent.idle(); return core.sent.at(-1)!.text;};
    assert.match(await call('fail',{}),/Policy violation:.*ask_owner/);
    assert.match(await call('echo',{projectId:'spencer'}),/echo: injected/);
    assert.match(await call('echo',{projectId:'other'}),/Policy violation:.*projectId/);
    assert.match(await call('echo',{projectId:'spencer',model:'wrong'}),/Policy violation:.*model/);
    assert.match(await call('echo',{projectId:'spencer',provider:'wrong'}),/Policy violation:.*provider/);
    assert.ok(requests.some(r=>r.systemPrompt.includes('modelSelection.model')&&r.systemPrompt.includes('peer-model')));
    await agent.ownerSend('/tool mcp__echo__pid {}'); await agent.idle();
    assert.match((await agent.ownerTranscript(1))[0].text,/done: \d+/);
  } finally {await agent.stop(); core.cleanup();}
});

test('DM peer denies hide tools and cannot be bypassed without an active asker; owner zero-arg calls work', async () => {
  const core = makeCore({channels:[channel('dm-policy','direct','Bob',{trust:'full'})],config:{mcpServers:{echo:ECHO}}});
  const dm = core.getChannel('dm-policy')!;
  core.toolPolicies.replace({scopeKind:'peer',scopeId:dm.members.find(m=>!m.me)!.id},[{toolPattern:'*pid',effect:'deny'}]);
  const agent=new SpencerAgent(core,{log(){}});
  try {
    await agent.start();await agent.mcpSettled();
    assert.ok(!(await agent.agentRuntime!.offeredTools('ch:dm-policy')).includes('mcp__echo__pid'));
    // Exercise the execution boundary with no pending replies (e.g. a stale tool registration).
    const tools: import('../../src/agent/runtime.ts').ToolSpec[] = Reflect.apply(Reflect.get(agent,'mcpTools'),agent,[]);
    const pid=tools.find(t=>t.name==='mcp__echo__pid')!;
    assert.match(JSON.stringify(await pid.execute(undefined,{conversationKey:'ch:dm-policy',callId:'no-asker'})),/Policy violation:.*denied/);
    const owner=await pid.execute(undefined,{conversationKey:'owner',callId:'owner-zero-args'});
    assert.match(typeof owner==='string'?owner:owner.text,/^\d+$/);
  } finally {await agent.stop();core.cleanup();}
});

test('an uncompilable third-party schema warns without breaking configuration or policy enforcement', async () => {
  const core=makeCore({channels:[channel('bad-schema','direct','Bob',{trust:'full'})],config:{mcpServers:{echo:{...ECHO,args:[...ECHO.args,'--bad-schema']}}}});
  const logs:string[]=[];const agent=new SpencerAgent(core,{log:message=>logs.push(message)});
  try {
    await agent.start();await agent.mcpSettled();
    assert.ok(logs.some(s=>s.includes('cannot locally validate MCP tool mcp__echo__big')));
    assert.ok(!logs.some(s=>s.includes('configure failed')));
    await agent.ownerSend('/tool mcp__echo__echo {"text":"still works"}');await agent.idle();
    assert.match((await agent.ownerTranscript(1))[0].text,/echo: still works/);
    const tools: import('../../src/agent/runtime.ts').ToolSpec[] = Reflect.apply(Reflect.get(agent,'mcpTools'),agent,[]);
    const big=tools.find(t=>t.name==='mcp__echo__big')!;
    const output=await big.execute(undefined,{conversationKey:'owner',callId:'uncompilable'});
    assert.ok(typeof output==='string'||!output.isError);
    core.toolPolicies.replace({scopeKind:'channel',scopeId:'bad-schema'},[{toolPattern:'*big',effect:'ask_owner'}]);
    assert.match(JSON.stringify(await big.execute(undefined,{conversationKey:'ch:bad-schema',callId:'uncompilable-gated'})),/Policy violation:.*ask_owner/);
  } finally {await agent.stop();core.cleanup();}
});

test('guardrail prompts disclose only matching available tools outside Conversations', async () => {
  const core=makeCore({channels:[
    channel('hidden','direct','Hidden'),
    channel('visible','direct','Visible',{allowedMcpTools:['mcp__echo__echo']}),
    channel('plain','direct','Plain',{allowedMcpTools:['mcp__echo__pid']}),
    channel('convo-policy','group','Banter',{mode:'conversation',trust:'full'})
  ],config:{mcpServers:{echo:ECHO}}});
  core.toolPolicies.replace({scopeKind:'global',scopeId:'*'},[
    {toolPattern:'*echo__echo',effect:'ask_owner',argLocks:{worktree:'VISIBLE_ONLY'},argDefaults:{},argAllowValues:{},note:'Approval for this visible tool'},
    {toolPattern:'mcp__private__*',effect:'allow',argLocks:{projectId:'GLOBAL_SECRET'}}
  ]);
  core.toolPolicies.replace({scopeKind:'peer',scopeId:core.getChannel('hidden')!.members.find(m=>!m.me)!.id},[{toolPattern:'mcp__private__*',effect:'allow',argLocks:{namespace:'PEER_SECRET'}}]);
  const requests:FakeRequestInfo[]=[];
  const agent=new SpencerAgent(core,{fakeHooks:{onRequest:r=>requests.push(r)},log(){}});
  try {
    await agent.start();await agent.mcpSettled();
    for(const id of ['hidden','visible','plain','convo-policy']) {
      await agent.onPeerChat(peerChat(core.getChannel(id)!,'check scope',{mentions:[ME.id]}));await agent.idle();
      const prompt=requests.at(-1)!.systemPrompt;
      assert.doesNotMatch(prompt,/GLOBAL_SECRET|PEER_SECRET/);
      if(id==='visible') {
        assert.match(prompt,/Active tool guardrails/);assert.match(prompt,/VISIBLE_ONLY/);
        assert.match(prompt,/Approval for this visible tool/);assert.doesNotMatch(prompt,/defaults \{\}|allowed \{\}/);
      } else assert.doesNotMatch(prompt,/Active tool guardrails|VISIBLE_ONLY/);
    }
  } finally {await agent.stop();core.cleanup();}
});
