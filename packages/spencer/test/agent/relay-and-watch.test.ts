import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SpencerAgent } from "../../src/agent/agent.ts";
import { FollowupStore } from "../../src/agent/followups.ts";
import { BOB, CAROL, ME, makeCore, peerChat, waitFor } from "./helpers.ts";

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

for (const restart of [false, true]) {
  test(`watch drains updates received during a wake${restart ? " after restart" : ""}`, async () => {
    const core = makeCore();
    let entered = false;
    let release = () => {};
    const inputs: string[] = [];
    let agent = new SpencerAgent(core, { log: () => {}, fakeHooks: {
      onRequest: (info) => { if (info.text.includes("<followup_note>")) inputs.push(info.text); },
      gate: (info, signal) => info.text.includes("<followup_note>") ? new Promise<void>((resolve, reject) => {
        entered = true; release = resolve;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) : Promise.resolve(),
    } });
    try {
      await agent.start();
      await agent.ownerSend('/ask "Bob chat" monitor'); await agent.idle();
      const ch = core.getChannel("chDirect")!;
      await agent.onPeerChat(peerChat(ch, "ACK", { by: "agent" }));
      await waitFor(() => entered);
      const result = peerChat(ch, "FINAL_DURING_WAKE", { by: "agent", final: true });
      assert.equal((await agent.onPeerChat(result)).note, "handled by owner");
      assert.equal((await agent.onPeerChat(result)).note, "handled by owner"); // redelivery does not enqueue twice
      if (restart) {
        await agent.stop();
        agent = new SpencerAgent(core, { log: () => {}, fakeHooks: {
          onRequest: (info) => { if (info.text.includes("<followup_note>")) inputs.push(info.text); },
        } });
        await agent.start();
      } else {
        // Subsequent wakes must run without the first wake's gate.
        const firstRelease = release;
        entered = false;
        firstRelease();
        await waitFor(() => entered);
        release();
      }
      await agent.idle();
      const watch = agent.listFollowups()[0]!;
      assert.equal(watch.state, "done");
      assert.equal(watch.wakeCount, 2);
      assert.ok(inputs.some((input) => input.includes("FINAL_DURING_WAKE") && input.includes("final; the exchange has ended")));
      assert.equal(core.sent.length, 1, "only the initial owner send, no channel-agent response");
      assert.equal(core.db.prepare("SELECT count(*) AS n FROM agent_watch_updates").get()!.n, 0);
    } finally { await agent.stop(); core.cleanup(); }
  });
}

test("group replies and follow-ups cap mentions at 64 and preserve the reply target first", async () => {
  const core = makeCore();
  const ch = core.getChannel("chGroup")!;
  const peers = Array.from({ length: 70 }, (_, i) => ({
    id: `peer-${i}`, name: `Member${i}`, fingerprint: `fp-${i}`, me: false, presence: "online" as const,
  }));
  ch.members.push(...peers);
  const handles = peers.map((peer) => `@${peer.name}`).join(" ");
  let now = Date.now();
  const agent = new SpencerAgent(core, { now: () => now, log: () => {} });
  try {
    await agent.start();
    await agent.onPeerChat(peerChat(ch, `@Alice ${handles}`, { mentions: [ME.id] }));
    await agent.idle();
    await agent.onPeerChat(peerChat(ch, `@Alice please follow up in 1 minutes: ${handles}`, { mentions: [ME.id] }));
    await agent.idle();
    now += 61_000; await agent.followupTick(); await agent.idle();
    for (const reply of [core.sent[0]!, core.sent.at(-1)!]) {
      assert.equal(reply.mentions!.length, 64);
      assert.equal(reply.mentions![0], BOB.id);
      assert.equal(new Set(reply.mentions).size, 64);
      assert.ok(!reply.mentions!.includes(ME.id));
    }
  } finally { await agent.stop(); core.cleanup(); }
});

test("cancelled active follow-up reconciles the linked task after restart", async () => {
  const core = makeCore();
  let now = Date.now();
  let entered = false;
  let agent = new SpencerAgent(core, { now: () => now, log: () => {}, fakeHooks: {
    gate: (info, signal) => info.text.includes("<followup_note>") ? new Promise<void>((_resolve, reject) => {
      entered = true;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) : Promise.resolve(),
  } });
  try {
    await agent.start();
    const incoming = peerChat(core.getChannel("chDirect")!, 'please ask owner: /followup 1 check');
    await agent.onPeerChat(incoming); await agent.idle();
    await agent.decideRequest(agent.listRequests().find((r) => r.kind === "peer")!.id, true);
    await agent.idle();
    now += 61_000; await agent.followupTick(); await waitFor(() => entered);
    agent.cancelFollowup(agent.listFollowups()[0]!.id);
    assert.equal(core.statuses.at(-1)!.state, "working");
    await agent.stop();
    agent = new SpencerAgent(core, { now: () => now, log: () => {} });
    await agent.start(); await agent.idle();
    assert.equal(core.statuses.at(-1)!.state, "completed");
    assert.equal(core.statuses.at(-1)!.replyTo, incoming.id);
    const count = core.statuses.length;
    await agent.stop();
    agent = new SpencerAgent(core, { now: () => now, log: () => {} });
    await agent.start(); await agent.idle();
    assert.equal(core.statuses.length, count, "settled statuses are not resent every restart");
  } finally { await agent.stop(); core.cleanup(); }
});

test("follow-up owner summaries redact credentials even without an MCP server", async () => {
  const core = makeCore();
  let now = Date.now();
  const agent = new SpencerAgent(core, { now: () => now, log: () => {} });
  try {
    await agent.start();
    await agent.onPeerChat(peerChat(core.getChannel("chDirect")!, "please follow up in 1 minutes: password=hunter2 Bearer private-token"));
    await agent.idle();
    now += 61_000; await agent.followupTick(); await agent.idle();
    const note = (await agent.ownerTranscript(100)).find((item) => item.text.startsWith("[follow-up in"))!;
    assert.ok(note.untrusted);
    assert.ok(note.text.includes("[redacted]"));
    assert.ok(!note.text.includes("hunter2"));
    assert.ok(!note.text.includes("private-token"));
  } finally { await agent.stop(); core.cleanup(); }
});
