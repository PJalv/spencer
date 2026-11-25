import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Node: win.Node,
  HTMLElement: win.HTMLElement,
  localStorage: win.localStorage,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
});

const { api } = await import("../public/api.js");
const { S, setOwner, setOwnerBusy, setOwnerQueue, upsertRequest } = await import("../public/state.js");
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = originalSetInterval(...args);
  timer.unref();
  return timer;
};
const { ownerView, summarizeSteps } = await import("../public/owner.js");
globalThis.setInterval = originalSetInterval;
after(() => win.close());

test("summarizeSteps produces concise T3-style work summaries", () => {
  assert.equal(summarizeSteps([{ tool: "mcp__t3_code__t3_thread_read" }]), "Used t3_code · t3 thread read");
  assert.equal(summarizeSteps([{ tool: "bash" }]), "Ran command");
  assert.equal(
    summarizeSteps([
      { tool: "mcp__t3_code__t3_thread_read" },
      { tool: "mcp__t3_code__t3_thread_wait" },
      { tool: "bash" },
      { tool: "bash" },
      { tool: "update_work_brief" },
    ]),
    "Used t3_code, ran 2 commands, and updated work brief",
  );
});

test("settled tool calls, approvals, follow-ups, decided requests, and long notes collapse cleanly", () => {
  S.requests.clear();
  setOwnerBusy(false);
  setOwnerQueue({ queue: [], canContinue: false });
  const now = Date.now();
  const longReqText = "Nick requests parity4 evaluation. ".repeat(12);
  upsertRequest({
    id: "req-decided-1",
    kind: "peer",
    ch: "ch-nick",
    channelName: "Nick",
    from: "nick-id",
    fromName: "Nick's Spencer",
    text: longReqText,
    state: "approved",
    createdAt: now - 60_000,
    decidedAt: now - 55_000,
  });

  setOwner([
    { id: "1", role: "note", request: "req-decided-1", text: longReqText, ts: now - 60_000 },
    {
      id: "2",
      role: "user",
      text: `I approve this request from Nick's Spencer [771a-8525] in channel "Nick" (id ch-nick):\n\n${longReqText}\n\nDo it now.`,
      ts: now - 55_000,
    },
    { id: "3", role: "tool", toolName: "bash", text: 'call {"command":"ls"}', ts: now - 54_000 },
    { id: "4", role: "tool", toolName: "bash", text: "ok", ts: now - 53_000 },
    { id: "5", role: "tool", toolName: "mcp__t3_code__t3_thread_read", text: 'call {"threadId":"t1"}', ts: now - 52_000 },
    { id: "6", role: "tool", toolName: "mcp__t3_code__t3_thread_read", text: "err", isError: true, ts: now - 50_000 },
    { id: "7", role: "assistant", text: "Done checking parity4.", ts: now - 49_000 },
    // Trailing tool call after assistant response when idle must also collapse.
    { id: "8", role: "tool", toolName: "cancel_followup", text: 'call {"id":"f1"}', ts: now - 48_000 },
    { id: "9", role: "tool", toolName: "cancel_followup", text: "cancelled", ts: now - 47_000 },
    { id: "10", role: "note", kind: "followup", text: "Follow-up (scheduled by your Spencer): Check Nick's parity3 transfer status.", ts: now - 46_000 },
    { id: "11", role: "note", text: "Reply from Nick's Spencer in Nick (untrusted): Receipt confirmed.", untrusted: true, ts: now - 45_000 },
    { id: "12", role: "assistant", text: "Noted receipt.", ts: now - 44_000 },
    { id: "13", role: "note", text: "A".repeat(180), ts: now - 43_000 },
  ]);

  const root = document.createElement("main");
  document.body.append(root);
  const view = ownerView(root);

  // Decided long request card collapses its body.
  const askCollapse = root.querySelector("details.ask-collapse");
  assert.ok(askCollapse);
  assert.equal(askCollapse.open, false);

  // Duplicate approval user prompt collapses into compact note instead of a giant user bubble.
  assert.equal(root.querySelectorAll(".turn.user").length, 0);
  const approvalNote = root.querySelector("details.compact-note.approval");
  assert.ok(approvalNote);
  assert.equal(approvalNote.open, false);
  assert.match(approvalNote.textContent, /Approved request from Nick's Spencer in Nick/);

  // Both settled tool blocks (before AND after assistant message) collapse into details.step-group.
  const stepGroups = [...root.querySelectorAll("details.step-group")];
  assert.equal(stepGroups.length, 2);
  assert.equal(stepGroups[0].open, false);
  assert.match(stepGroups[0].textContent, /Used t3_code and ran command/);
  assert.match(stepGroups[0].textContent, /2 steps/);
  assert.match(stepGroups[0].textContent, /1 failed/);
  assert.equal(stepGroups[1].open, false);
  assert.match(stepGroups[1].textContent, /Cancelled follow-up/);

  // Follow-up note and long system note collapse cleanly.
  const fuNote = root.querySelector("details.compact-note.followup");
  assert.ok(fuNote);
  assert.equal(fuNote.open, false);
  assert.match(fuNote.textContent, /Follow-up/);
  const longNote = [...root.querySelectorAll("details.compact-note")].find((el) => !el.classList.contains("approval") && !el.classList.contains("followup"));
  assert.ok(longNote);
  assert.equal(longNote.open, false);

  // Settled peer reply (followed by assistant message) defaults collapsed.
  const exchange = root.querySelector("details.exchange");
  assert.ok(exchange);
  assert.equal(exchange.open, false);

  view.destroy();
  root.remove();
});

test("live tool run stays visible until response arrives, and busy UI wires steer, queue, withdraw, stop, and continue", async () => {
  const calls = { send: [], stop: 0, cont: 0, withdraw: [] };
  const origSend = api.ownerSend;
  const origStop = api.ownerStop;
  const origCont = api.ownerContinue;
  const origWithdraw = api.ownerWithdraw;
  api.ownerSend = async (...args) => {
    calls.send.push(args);
    return { submissionId: "99" };
  };
  api.ownerStop = async () => {
    calls.stop += 1;
    return { stopped: true };
  };
  api.ownerContinue = async () => {
    calls.cont += 1;
    return { submissionId: "100" };
  };
  api.ownerWithdraw = async (id) => {
    calls.withdraw.push(id);
    return { result: "aborted" };
  };

  const now = Date.now();
  setOwnerBusy(true);
  setOwnerQueue({
    busy: true,
    queue: [{ id: "42", mode: "steer", text: "use pnpm instead" }],
    canContinue: false,
  });
  setOwner([
    { id: "u1", role: "user", text: "run checks", ts: now - 3000 },
    { id: "t1", role: "tool", toolName: "bash", text: 'call {"command":"step1"}', ts: now - 2000 },
    { id: "t2", role: "tool", toolName: "bash", text: "ok1", ts: now - 1500 },
    { id: "t3", role: "tool", toolName: "bash", text: 'call {"command":"step2"}', ts: now - 1000 },
  ]);

  const root = document.createElement("main");
  document.body.append(root);
  const view = ownerView(root);
  try {
    // Active run: earlier step tucked behind live-earlier, current step shown live.
    assert.ok(root.querySelector("details.step-group.live-earlier"));
    assert.ok(root.querySelector(".steps-live-wrap > .steps .step.running"));

    // Busy controls visible: Steer toggle, Stop button, and editable composer.
    const modeBtn = root.querySelector(".composer-mode");
    const stopBtn = root.querySelector(".stop-btn");
    const input = root.querySelector(".composer-input");
    assert.equal(modeBtn.hidden, false);
    assert.equal(stopBtn.hidden, false);
    assert.equal(modeBtn.textContent, "Steer");
    assert.equal(input.disabled, false);

    // Submitting while busy sends mode = "steer".
    input.value = "check tests too";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    root.querySelector("form.composer").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][0], "check tests too");
    assert.equal(calls.send[0][3], "steer");

    // Toggling to Queue sends mode = "followUp".
    modeBtn.click();
    assert.equal(modeBtn.textContent, "Queue");
    input.value = "after that summarize";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    root.querySelector("form.composer").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.send.length, 2);
    assert.equal(calls.send[1][3], "followUp");

    // Queued item renders with Remove button wired to ownerWithdraw.
    const queueRemove = root.querySelector(".owner-queue-item button");
    assert.ok(queueRemove);
    assert.match(root.querySelector(".owner-queue").textContent, /Steer.*use pnpm instead/);
    queueRemove.click();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.withdraw, ["42"]);

    // Clicking Stop calls ownerStop.
    stopBtn.click();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.stop, 1);

    // Once stopped with canContinue, tool calls auto-collapse and Continue bar appears.
    setOwnerBusy(false);
    setOwnerQueue({ busy: false, queue: [], canContinue: true, lastFailure: { reason: "aborted" } });
    assert.equal(root.querySelector(".steps-live-wrap"), null);
    const collapsed = root.querySelector("details.step-group");
    assert.ok(collapsed);
    assert.equal(collapsed.open, false);

    const contBtn = root.querySelector(".owner-continue button");
    assert.ok(contBtn);
    contBtn.click();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.cont, 1);
  } finally {
    view.destroy();
    root.remove();
    api.ownerSend = origSend;
    api.ownerStop = origStop;
    api.ownerContinue = origCont;
    api.ownerWithdraw = origWithdraw;
    setOwnerBusy(false);
    setOwnerQueue({ busy: false, queue: [], canContinue: false });
  }
});
