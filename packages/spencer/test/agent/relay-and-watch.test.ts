import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SpencerAgent } from "../../src/agent/agent.ts";
import { FollowupStore } from "../../src/agent/followups.ts";
import { BOB, CAROL, ME, makeCore, peerChat } from "./helpers.ts";

test("three Spencers relay explicit group mentions; plain names do not wake the third", async () => {
  const identities = [ME, BOB, CAROL];
  const cores = identities.map((identity) => {
    const core = makeCore();
    core.me = () => identity;
    core.cfg.name = identity.name;
    const group = core.getChannel("chGroup")!;
    group.members = identities.map((member) => ({ ...member, me: member.id === identity.id, presence: "online" }));
    return core;
  });
  const agents = cores.map((core) => new SpencerAgent(core, { log: () => {} }));
  try {
    await Promise.all(agents.map((agent) => agent.start()));
    const host = agents[0]!;
    const charlie = agents[2]!;
    const group = cores[0]!.getChannel("chGroup")!;
    for (const explicit of [false, true]) {
      await agents[1]!.ownerSend(explicit ? '/send Team @Alice ask @Carol to check staging' : '/send Team @Alice ask Carol to inspect logs');
      await agents[1]!.idle();
      const request = cores[1]!.sent.at(-1)!;
      await host.onPeerChat(peerChat(group, request.text, { mentions: request.mentions, by: "agent" }));
      await host.idle();
      const reply = cores[0]!.sent.at(-1)!;
      assert.equal(reply.mentions?.includes(CAROL.id), explicit);
      assert.ok(reply.mentions?.includes(BOB.id));
      assert.ok(!reply.mentions?.includes(ME.id));
      const result = await charlie.onPeerChat(peerChat(cores[2]!.getChannel("chGroup")!, reply.text, { from: ME, mentions: reply.mentions, by: "agent" }));
      await charlie.idle();
      assert.equal(result.note, explicit ? undefined : "not addressed");
    }
    assert.equal(cores[2]!.sent.length, 1);
  } finally {
    await Promise.all(agents.map((agent) => agent.stop()));
    cores.forEach((core) => core.cleanup());
  }
});

test("await_reply wakes owner for acknowledgement and final result with separate durable inputs", async () => {
  const core = makeCore();
  const agent = new SpencerAgent(core, { log: () => {} });
  await agent.start();
  try {
    await agent.ownerSend('/ask "Bob chat" check staging');
    await agent.idle();
    const watch = agent.listFollowups()[0]!;
    assert.equal(watch.watch, true);
    for (const [text, final] of [["Checking now", false], ["REAL_RESULT", true]] as const) {
      assert.equal((await agent.onPeerChat(peerChat(core.getChannel("chDirect")!, text, { by: "agent", final }))).note, "handled by owner");
      await agent.idle();
      const current = agent.listFollowups().find((f) => f.id === watch.id)!;
      assert.equal(current.state, final ? "done" : "pending");
      assert.equal(current.wakeCount, final ? 2 : 1);
    }
    const transcript = await agent.ownerTranscript(100);
    assert.ok(transcript.some((item) => item.untrusted && item.text.includes("REAL_RESULT")));
    assert.equal(transcript.filter((item) => item.text.startsWith("Follow-up (scheduled")).length, 2);
  } finally { await agent.stop(); core.cleanup(); }
});

test("watch cap, expiry and cancellation prevent rearming; schema init is idempotent", () => {
  const core = makeCore();
  let now = 100;
  const store = new FollowupStore(core.db, { now: () => now, onDue: async () => {} });
  try {
    store.init(); store.init();
    const row = store.insert({ conv: "owner", note: "wait", dueAt: 500, depth: 0, watch: true, maxWakes: 2 });
    assert.ok(store.markFired(row.id, "reply"));
    assert.ok(store.rearm(row.id));
    assert.ok(store.markFired(row.id, "reply"));
    assert.equal(store.rearm(row.id), false);
    const cancelled = store.insert({ conv: "owner", note: "cancel", dueAt: 500, depth: 0, watch: true });
    store.markFired(cancelled.id, "reply");
    store.finish(cancelled.id, "cancelled");
    assert.equal(store.rearm(cancelled.id), false);
    const expired = store.insert({ conv: "owner", note: "expire", dueAt: 500, depth: 0, watch: true });
    store.markFired(expired.id, "reply"); now = 501;
    assert.equal(store.rearm(expired.id), false);
  } finally { core.cleanup(); }
});

test("channel MCP outcomes and follow-up summaries are untrusted owner notes", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/echo-mcp-server.ts", import.meta.url));
  const core = makeCore({ config: { mcpServers: { echo: { command: process.execPath, args: [fixture], env: { AUDIT_SECRET: "private-audit-value" } } } } });
  const ch = core.getChannel("chDirect")!;
  ch.trust = "full";
  let now = Date.now();
  const agent = new SpencerAgent(core, { now: () => now, log: () => {} });
  await agent.start();
  try {
    await agent.mcpSettled();
    await agent.onPeerChat(peerChat(ch, 'please call mcp__echo__echo {"text":"OUTCOME private-audit-value password=another-secret"}'));
    await agent.idle();
    await agent.onPeerChat(peerChat(ch, "please follow up in 1 minutes: deliver"));
    await agent.idle();
    now += 61_000;
    await agent.followupTick(); await agent.idle();
    const notes = await agent.ownerTranscript(100);
    assert.ok(notes.some((item) => item.untrusted && item.text.includes("result (untrusted)") && item.text.includes("echo: OUTCOME")));
    const audit = notes.find((item) => item.text.includes("result (untrusted)"))!;
    assert.ok(!audit.text.includes("private-audit-value"));
    assert.ok(!audit.text.includes("another-secret"));
    assert.ok(audit.text.includes("[redacted]"));
    assert.ok(notes.some((item) => item.untrusted && item.text.includes("[follow-up in Bob chat]")));
  } finally { await agent.stop(); core.cleanup(); }
});

test("approved task stays working through an owner follow-up chain", async () => {
  const core = makeCore();
  let now = Date.now();
  const agent = new SpencerAgent(core, { now: () => now, log: () => {} });
  await agent.start();
  try {
    const incoming = peerChat(core.getChannel("chDirect")!, 'please ask owner: /followup 1 /followup 1 /send "Bob chat" REAL_RESULT');
    await agent.onPeerChat(incoming); await agent.idle();
    const request = agent.listRequests().find((r) => r.kind === "peer")!;
    await agent.decideRequest(request.id, true); await agent.idle();
    assert.equal(core.statuses.at(-1)!.state, "working");
    assert.equal(core.statuses.at(-1)!.activity, "Working on it (follow-up scheduled)");
    now += 61_000; await agent.followupTick(); await agent.idle();
    assert.equal(core.statuses.at(-1)!.state, "working");
    now += 61_000; await agent.followupTick(); await agent.idle();
    assert.equal(core.statuses.at(-1)!.state, "completed");
    assert.equal(core.sent.at(-1)!.text, "REAL_RESULT");
  } finally { await agent.stop(); core.cleanup(); }
});

test("owner watch closes at its wake cap and respects cancellation during its own turn", async () => {
  const core = makeCore();
  const agent = new SpencerAgent(core, { log: () => {} });
  await agent.start();
  try {
    await agent.ownerSend('/ask "Bob chat" monitor');
    await agent.idle();
    core.db.prepare("UPDATE agent_followups SET max_wakes = 2").run();
    const ch = core.getChannel("chDirect")!;
    for (let i = 0; i < 2; i++) {
      await agent.onPeerChat(peerChat(ch, `update ${i}`, { by: "agent" }));
      await agent.idle();
    }
    assert.equal(agent.listFollowups()[0]!.state, "done");
    await agent.ownerSend('/tool schedule_followup {"in_minutes":60,"note":"/tool cancel_followup {\\"id\\":\\"all\\"}","on_reply_from":"chDirect","watch":true}');
    await agent.idle();
    await agent.onPeerChat(peerChat(ch, "settled", { by: "agent" }));
    await agent.idle();
    assert.equal(agent.listFollowups().filter((f) => f.state === "pending").length, 0);
    assert.ok(agent.listFollowups().some((f) => f.state === "cancelled"));
  } finally { await agent.stop(); core.cleanup(); }
});
