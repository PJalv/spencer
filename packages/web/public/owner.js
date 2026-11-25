// The owner's own conversation with their Spencer.
import { h, icon, linkify, timeShort, timeFull, selfAvatar } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, setOwner } from "./state.js";
import { hashFor } from "./router.js";
import { viewHeader, composer, SEND_HINT, stage, skeleton, trace, mark, activityNode, followupList } from "./common.js";
import { markdown } from "./md.js";
import { scrollKeeper } from "./scroll.js";
import { requestCard } from "./requests.js";
import { createFilePicker } from "./draft-dom.js";
import { hasDraftFile, uploadDraftBatch } from "./draft-batch.js";

const MAX_DRAFT_FILES = 10;
const MAX_DRAFT_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ownerDraftState = { drafts: [], messageText: "", sending: false, sendId: null, sendKey: null, pendingSend: null, renderers: new Set() };

for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
  }, true);
}

const EXAMPLES = ["List my peers", "Ask Bob's Spencer for the logs", "What transfers are waiting for me?", "Create an invite for Carol"];

/** Disclosure state of tool steps, collapsed groups, compact notes, and peer exchanges across re-renders. */
const openSteps = new Set();
const openStepGroups = new Set();
const openCompactNotes = new Set();
const openExchanges = new Set();

/** "Reply from Bob's Spencer in Bob (untrusted): text" (the daemon's reply note) → {from, channel, text}. */
function parseReply(text) {
  const m = /^Reply from (.+?)(?: in (.+?))? \((?:untrusted[^)]*)\):\s*([\s\S]*)$/.exec(text);
  return m ? { from: m[1], channel: m[2], text: m[3] } : null;
}

const isPeerNote = (item) => item.role === "note" && item.untrusted === true && !item.request && !!parseReply(item.text);

/** "I approve this request from Nick's Spencer [fp] in channel \"Nick\" (id ...):\n\n..." */
function parseApproval(item) {
  if (item.role !== "user" || !item.text) return null;
  const m = /^I approve this request from (.+?) in channel "([^"]+)"(?:\s*\(id [^)]+\))?:\s*([\s\S]*)$/.exec(item.text);
  if (!m) return null;
  const who = m[1].replace(/\s*\[[0-9a-f-]+\]\s*$/i, "").trim() || m[1];
  return { who, channel: m[2], body: m[3].trim() };
}

/** "Follow-up (scheduled by your Spencer): ..." */
function parseFollowup(item) {
  if (item.role !== "note" || item.request) return null;
  const m = /^Follow-up(?:\s*\(scheduled by your Spencer\))?:\s*([\s\S]*)$/.exec(item.text ?? "");
  if (!m && item.kind !== "followup") return null;
  return { body: (m ? m[1] : item.text ?? "").trim() };
}

function compactNoteRow({ id, iconName, title, preview, body, ts, cls = "" }) {
  const open = openCompactNotes.has(id);
  const d = h(
    `details.compact-note${cls ? "." + cls : ""}`,
    { open },
    h(
      "summary",
      null,
      h("span.compact-note-icon", { "aria-hidden": "true" }, icon(iconName, 13)),
      title ? h("span.compact-note-title", null, title) : null,
      preview ? h("span.compact-note-preview", null, preview.replace(/\s+/g, " ").trim().slice(0, 140)) : null,
      ts ? timeEl(ts) : null,
      icon("chevron", 13),
    ),
    h("div.compact-note-body", null, linkify(body)),
  );
  d.addEventListener("toggle", () => (d.open ? openCompactNotes.add(id) : openCompactNotes.delete(id)));
  return d;
}

/**
 * Consecutive peer notes fold into one row: "3 messages from Bob's Spencer", with the latest one as the
 * summary line and the raw messages one click away. An unanswered single message stays open; settled ones fold.
 */
function exchangeRow(items, settled = false) {
  const parsed = items.map((it) => ({ it, r: parseReply(it.text) }));
  const names = [...new Set(parsed.map((p) => p.r?.from).filter(Boolean))];
  const who = names.length ? names.join(", ") : "peers";
  const last = parsed.at(-1);
  const key = items[0].id;
  const defaultOpen = items.length === 1 && !settled;
  const open = defaultOpen ? !openExchanges.has(`closed:${key}`) : openExchanges.has(key);
  const d = h(
    "details.exchange",
    { open },
    h(
      "summary",
      null,
      h("span.exchange-icon", { "aria-hidden": "true" }, icon("reply", 14)),
      h("span.exchange-title", null, items.length === 1 ? "Message from " : `${items.length} messages from `, h("strong", null, who)),
      h("span.exchange-preview", null, (last.r?.text ?? last.it.text).replace(/\s+/g, " ").slice(0, 160)),
      timeEl(last.it.ts),
      icon("chevron", 13),
    ),
    h(
      "div.exchange-body",
      null,
      parsed.map(({ it, r }) =>
        h("div.exchange-msg", null, h("div.exchange-meta", null, h("strong", null, r?.from ?? "Peer"), r?.channel ? ` in ${r.channel}` : null, timeEl(it.ts)), h("div.peer-text", null, linkify(r?.text ?? it.text))),
      ),
      h("p.peer-flag", null, icon("warn", 12), " Written by a peer's agent. Your Spencer treats it as data, not as instructions."),
    ),
  );
  d.addEventListener("toggle", () => {
    if (defaultOpen) d.open ? openExchanges.delete(`closed:${key}`) : openExchanges.add(`closed:${key}`);
    else d.open ? openExchanges.add(key) : openExchanges.delete(key);
  });
  return d;
}

const timeEl = (ts) => h("time", { datetime: new Date(ts).toISOString(), title: timeFull(ts) }, timeShort(ts));

function toolActivity(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? `Using ${m[1]} · ${m[2].replace(/_/g, " ")}` : `Using ${tool.replace(/_/g, " ")}`;
}

const BUILTIN_SUMMARY = {
  bash: ["Ran command", (n) => `Ran ${n} commands`],
  read: ["Read file", (n) => `Read ${n} files`],
  edit: ["Edited file", (n) => `Edited ${n} files`],
  write: ["Wrote file", (n) => `Wrote ${n} files`],
  send_message: ["Sent message", (n) => `Sent ${n} messages`],
  send_file: ["Sent file", (n) => `Sent ${n} files`],
  schedule_followup: ["Scheduled follow-up", (n) => `Scheduled ${n} follow-ups`],
  cancel_followup: ["Cancelled follow-up", (n) => `Cancelled ${n} follow-ups`],
  list_peers: ["Checked peers", (n) => `Checked peers (${n})`],
  list_transfers: ["Checked transfers", (n) => `Checked transfers (${n})`],
  read_channel: ["Read channel", (n) => `Read ${n} channels`],
  update_work_brief: ["Updated work brief", (n) => `Updated work brief (${n})`],
  list_work_brief: ["Checked work brief", (n) => `Checked work brief (${n})`],
  edit_bio: ["Updated bio", (n) => `Updated bio (${n})`],
};

function humanToolName(tool) {
  return String(tool || "tool").replace(/_/g, " ");
}

function formatCompactDuration(ms) {
  if (!Number.isFinite(ms) || ms < 2000) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

/** T3-Code-inspired summary of a tool call batch: e.g. "Used t3_code, ran 9 commands, and updated work brief". */
export function summarizeSteps(steps) {
  if (!steps.length) return "Worked";
  if (steps.length === 1) {
    const t = steps[0].tool || "tool";
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
    if (mcp) return `Used ${mcp[1]} · ${mcp[2].replace(/_/g, " ")}`;
    const known = BUILTIN_SUMMARY[t];
    return known ? known[0] : `Used ${humanToolName(t)}`;
  }
  const mcpServers = new Set();
  const counts = new Map();
  let otherCount = 0;
  for (const s of steps) {
    const t = s.tool || "tool";
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
    if (mcp) {
      mcpServers.add(mcp[1]);
      continue;
    }
    if (BUILTIN_SUMMARY[t]) counts.set(t, (counts.get(t) ?? 0) + 1);
    else otherCount += 1;
  }
  const labels = [];
  if (mcpServers.size) {
    const names = [...mcpServers];
    const joined = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
    labels.push(`Used ${joined}`);
  }
  for (const [tool, count] of counts) {
    const [one, many] = BUILTIN_SUMMARY[tool];
    labels.push(count === 1 ? one : many(count));
  }
  if (otherCount) labels.push(otherCount === 1 ? "Used 1 tool" : `Used ${otherCount} tools`);
  const visible = labels.length > 3 ? [...labels.slice(0, 2), `${labels.length - 2} more actions`] : labels;
  const lowered = visible.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)));
  if (lowered.length === 1) return lowered[0];
  if (lowered.length === 2) return `${lowered[0]} and ${lowered[1]}`;
  return `${lowered.slice(0, -1).join(", ")}, and ${lowered.at(-1)}`;
}

const isCall = (item) => item.role === "tool" && item.text.startsWith("call ");

/**
 * Fold a run of tool items into steps. The daemon writes a "call {args}" item and then the result item
 * for each tool use; a step pairs them. A call without a result yet is still running.
 */
function toSteps(items) {
  const steps = [];
  for (const it of items) {
    const last = steps.at(-1);
    if (isCall(it)) steps.push({ id: it.id, tool: it.toolName || "tool", args: it.text.slice(5), ts: it.ts });
    else if (last && last.result === undefined && last.tool === (it.toolName || "tool")) Object.assign(last, { result: it.text, isError: !!it.isError, endTs: it.ts });
    else steps.push({ id: it.id, tool: it.toolName || "tool", result: it.text, isError: !!it.isError, ts: it.ts });
  }
  return steps;
}

function stepRow(step, running) {
  const pending = step.result === undefined;
  const preview = (pending ? step.args : step.result).replace(/\s+/g, " ").trim();
  const d = h(
    `details.step${step.isError ? ".error" : ""}${pending && running ? ".running" : ""}`,
    { open: openSteps.has(step.id) },
    h(
      "summary",
      null,
      h("span.step-mark", { "aria-hidden": "true" }, step.isError ? icon("warn", 13) : pending && running ? h("span.now-caret") : icon("check", 13)),
      activityNode(toolActivity(step.tool)),
      step.isError ? h("span.step-flag", null, "failed") : null,
      h("span.step-preview", null, preview.slice(0, 160)),
      icon("chevron", 13),
    ),
    h(
      "div.step-body",
      null,
      step.args && step.args !== "{}" ? [h("div.step-label", null, "Sent"), h("pre", null, step.args)] : null,
      step.result !== undefined ? [h("div.step-label", null, step.isError ? "Error" : "Returned"), h("pre", null, step.result)] : null,
    ),
  );
  d.addEventListener("toggle", () => (d.open ? openSteps.add(step.id) : openSteps.delete(step.id)));
  return d;
}

/**
 * Settled tool calls collapse into a single summary disclosure row (T3 Code-style).
 * Active tool calls at the tail of a live run show the current step cleanly while tucking earlier steps away.
 */
function stepsBlock(items, { live = false } = {}) {
  const steps = toSteps(items);
  if (!steps.length) return h("div.steps");
  const key = steps[0].id;
  if (live) {
    if (steps.length === 1) {
      return h("div.steps", { role: "group", "aria-label": "1 tool step" }, stepRow(steps[0], true));
    }
    const earlier = steps.slice(0, -1);
    const current = steps.at(-1);
    const earlierKey = `live:${key}`;
    const earlierFailed = earlier.filter((s) => s.isError).length;
    const earlierGroup = h(
      `details.step-group.live-earlier${earlierFailed ? ".has-error" : ""}`,
      { open: openStepGroups.has(earlierKey) },
      h(
        "summary",
        null,
        h("span.step-group-mark", { "aria-hidden": "true" }, earlierFailed ? icon("warn", 13) : icon("check", 13)),
        h("span.step-group-title", null, `${earlier.length} earlier ${earlier.length === 1 ? "step" : "steps"} · ${summarizeSteps(earlier)}`),
        earlierFailed ? h("span.step-flag", null, `${earlierFailed} failed`) : null,
        icon("chevron", 13),
      ),
      h("div.step-group-body", null, h("div.steps", { role: "group" }, earlier.map((s) => stepRow(s, false)))),
    );
    earlierGroup.addEventListener("toggle", () => (earlierGroup.open ? openStepGroups.add(earlierKey) : openStepGroups.delete(earlierKey)));
    return h(
      "div.steps-live-wrap",
      null,
      earlierGroup,
      h("div.steps", { role: "group", "aria-label": "Current tool step" }, stepRow(current, true)),
    );
  }

  const failed = steps.filter((s) => s.isError).length;
  const firstTs = steps[0].ts;
  const lastStep = steps.at(-1);
  const lastTs = lastStep.endTs ?? lastStep.ts;
  const dur = firstTs && lastTs && lastTs > firstTs ? formatCompactDuration(lastTs - firstTs) : "";
  const metaParts = [];
  if (steps.length > 1) metaParts.push(`${steps.length} steps`);
  if (dur) metaParts.push(dur);

  const d = h(
    `details.step-group${failed ? ".has-error" : ""}`,
    { open: openStepGroups.has(key) },
    h(
      "summary",
      null,
      h("span.step-group-mark", { "aria-hidden": "true" }, failed ? icon("warn", 13) : icon("check", 13)),
      h("span.step-group-title", null, summarizeSteps(steps)),
      metaParts.length ? h("span.step-group-meta", null, metaParts.join(" · ")) : null,
      failed ? h("span.step-flag", null, `${failed} failed`) : null,
      lastTs ? timeEl(lastTs) : null,
      icon("chevron", 13),
    ),
    h(
      "div.step-group-body",
      null,
      h("div.steps", { role: "group", "aria-label": `${steps.length} tool ${steps.length === 1 ? "step" : "steps"}` }, steps.map((s) => stepRow(s, false))),
    ),
  );
  d.addEventListener("toggle", () => (d.open ? openStepGroups.add(key) : openStepGroups.delete(key)));
  return d;
}

function ownerItem(item) {
  switch (item.role) {
    case "user": {
      const approval = parseApproval(item);
      if (approval) {
        return compactNoteRow({
          id: item.id,
          iconName: "check",
          title: ["Approved request from ", h("strong", null, approval.who), " in ", approval.channel],
          preview: "",
          body: approval.body || item.text,
          ts: item.ts,
          cls: "approval",
        });
      }
      return h("div.turn.user", null,
        item.text ? h("div.turn-text", null, linkify(item.text)) : null,
        item.attachments?.length ? h("div.turn-attachments", { "aria-label": "Attachments" }, item.attachments.map((file) => h("div.draft-attachment", null, icon("file", 16), h("span.draft-name", { title: file.name }, file.name)))) : null,
        h("div.turn-meta", null, timeEl(item.ts)),
      );
    }
    case "assistant":
      return h(
        "div.turn.agent",
        null,
        selfAvatar(),
        h("div.turn-body", null, h("div.turn-head", null, h("span.who", null, "Spencer"), timeEl(item.ts)), h("div.turn-text.md", null, markdown(item.text, linkify))),
      );
    case "note": {
      if (item.request) return h("div.turn.card", null, requestCard(item.request, { text: item.text, ts: item.ts }));
      const fu = parseFollowup(item);
      if (fu) {
        return compactNoteRow({
          id: item.id,
          iconName: "clock",
          title: h("strong", null, "Follow-up"),
          preview: fu.body,
          body: fu.body || item.text,
          ts: item.ts,
          cls: "followup",
        });
      }
      if ((item.text ?? "").length > 140) {
        return compactNoteRow({
          id: item.id,
          iconName: "info",
          title: null,
          preview: item.text,
          body: item.text,
          ts: item.ts,
        });
      }
      return h("div.note", { role: "note" }, h("span.note-icon", { "aria-hidden": "true" }, icon("info", 14)), h("div.note-body", null, h("div.note-text", null, linkify(item.text)), h("div.note-meta", null, timeEl(item.ts))));
    }
    default:
      return h("div.system-line", null, item.text);
  }
}

function failureLabel(f) {
  if (!f?.reason) return "Spencer stopped before finishing.";
  switch (f.reason) {
    case "aborted":
      return "Spencer stopped.";
    case "turn_limit":
      return "Spencer reached its turn limit.";
    case "interrupted":
      return "Spencer was interrupted before finishing.";
    case "model_error":
      return "The last run failed with a model error.";
    default:
      return `The last run ended (${f.reason}).`;
  }
}

export function ownerView(main) {
  const transcript = h("div.transcript.owner", { role: "log", "aria-live": "polite", "aria-label": "Conversation with Spencer" });
  const busy = h("div.live", { role: "status" });
  const scroller = h("div.scroller", null, transcript, busy);
  const keeper = scrollKeeper(scroller);
  const st = stage(scroller, keeper);

  const drafts = ownerDraftState.drafts;
  const draftBox = h("div.draft-attachments", { hidden: true, "aria-live": "polite" });
  const retryPendingButton = h("button.btn.sm", { type: "button", on: { click: () => retryPending() } }, "Retry previous send");
  const pendingNotice = h("div.owner-pending-send", { hidden: true, role: "status" }, h("span", null, "Send outcome unknown. Retry the previous send before sending new text."), retryPendingButton);
  const draftArea = h("div.owner-composer-drafts", null, pendingNotice, draftBox);

  let busyMode = "steer";
  let nextSendModeOverride = null;
  let stopping = false;
  let continuing = false;
  let comp;

  const stopRun = async () => {
    if (stopping || !S.ownerBusy) return;
    stopping = true;
    syncBusyControls();
    try {
      const res = await attempt(() => api.ownerStop());
      if (res?.stopped) toast("Stopping Spencer…", "info");
    } finally {
      stopping = false;
      syncBusyControls();
    }
  };

  const continueRun = async () => {
    if (continuing || S.ownerBusy) return;
    continuing = true;
    renderLater();
    try {
      await attempt(() => api.ownerContinue());
    } finally {
      continuing = false;
      renderLater();
    }
  };

  const modeBtn = h("button.composer-mode", {
    type: "button",
    hidden: true,
    on: {
      click: () => {
        busyMode = busyMode === "steer" ? "followUp" : "steer";
        syncBusyControls();
        comp?.input.focus();
      },
    },
  }, "Steer");

  const stopBtn = h("button.stop-btn", {
    type: "button",
    hidden: true,
    "aria-label": "Stop Spencer",
    title: "Stop Spencer (Esc)",
    on: { click: () => void stopRun() },
  }, icon("stop", 14));

  const rightControls = h("div.composer-controls", null, modeBtn, stopBtn);

  const syncBusyControls = () => {
    const isBusy = !!S.ownerBusy;
    modeBtn.hidden = !isBusy;
    stopBtn.hidden = !isBusy;
    stopBtn.disabled = stopping;
    modeBtn.textContent = busyMode === "steer" ? "Steer" : "Queue";
    modeBtn.classList.toggle("steer", busyMode === "steer");
    modeBtn.title = busyMode === "steer"
      ? "Steer Spencer after the current tool call (click to queue instead)"
      : "Queue for after this run finishes (click to steer instead)";
    if (comp) {
      comp.input.placeholder = isBusy
        ? (busyMode === "steer" ? "Steer Spencer…" : "Queue next message…")
        : "Message Spencer…";
      comp.sendBtn.title = isBusy
        ? (busyMode === "steer" ? "Steer Spencer (Enter)" : "Queue message (Enter)")
        : "Send (Enter)";
      comp.sendBtn.setAttribute("aria-label", isBusy ? (busyMode === "steer" ? "Steer" : "Queue") : "Send");
      if (comp.hintEl) {
        if (isBusy) {
          comp.hintEl.replaceChildren(
            h("kbd", null, "Enter"),
            busyMode === "steer" ? " to steer, " : " to queue, ",
            h("kbd", null, "Alt"), " ", h("kbd", null, "Enter"),
            busyMode === "steer" ? " to queue, " : " to steer, ",
            h("kbd", null, "Esc"), " to stop.",
          );
        } else {
          comp.hintEl.replaceChildren(...SEND_HINT(), ". Attach or drop files.");
        }
      }
      comp.sync();
    }
  };

  const drawDrafts = () => {
    draftBox.hidden = drafts.length === 0;
    pendingNotice.hidden = !ownerDraftState.pendingSend;
    retryPendingButton.disabled = ownerDraftState.sending;
    draftBox.replaceChildren(...drafts.map((draft) => h("div.draft-attachment", null,
      icon("file", 16),
      h("span.draft-name", { title: draft.file.name }, draft.file.name),
      h("span.draft-state", { title: draft.error || "" }, ownerDraftState.pendingSend?.uploadIds.includes(draft.uploadId) ? "Send status unknown · retry" : draft.status === "uploading" ? `Uploading ${draft.progress ?? 0}%` : draft.status === "failed" ? "Failed · Send to retry" : draft.status === "sent" ? "Ready to send" : "Ready"),
      h("button.draft-remove", { type: "button", "aria-label": `Remove ${draft.file.name}`, disabled: ownerDraftState.sending || ownerDraftState.pendingSend?.uploadIds.includes(draft.uploadId) || draft.status === "uploading" || draft.status === "queued", on: { click: () => { drafts.splice(drafts.indexOf(draft), 1); renderDrafts(); } } }, "×"),
    )));
    comp?.sync();
  };
  const renderDraftsForView = () => {
    drawDrafts();
    if (comp && document.activeElement !== comp.input && !ownerDraftState.sending) comp.input.value = ownerDraftState.messageText;
  };
  const renderDrafts = () => { for (const render of ownerDraftState.renderers) render(); };
  const send = async (text, preserveText = null) => {
    if (ownerDraftState.sending) return false;
    const pending = ownerDraftState.pendingSend;
    if (pending && text !== pending.text && preserveText === null) {
      toast("A previous send’s outcome is unknown. Retry it before sending this draft.");
      return false;
    }
    const modeOverride = nextSendModeOverride;
    nextSendModeOverride = null;
    const mode = S.ownerBusy ? (modeOverride ?? busyMode) : undefined;
    const batchDrafts = pending
      ? drafts.filter((draft) => pending.uploadIds.includes(draft.uploadId))
      : drafts.slice();
    const requestText = pending?.text ?? text;
    const hasAttachments = batchDrafts.length > 0;
    const key = JSON.stringify([requestText, batchDrafts.map((draft) => draft.uploadId)]);
    if (!pending && key !== ownerDraftState.sendKey) {
      ownerDraftState.sendKey = key;
      ownerDraftState.sendId = crypto.randomUUID();
    }
    ownerDraftState.sending = true;
    renderDrafts();
    try {
      if (hasAttachments) {
        const uploaded = await uploadDraftBatch(batchDrafts, {
          isPresent: (draft) => drafts.includes(draft),
          onUpdate: renderDrafts,
          upload: async (draft) => {
            draft.status = "uploading";
            draft.progress = 0;
            renderDrafts();
            return api.uploadOwnerFile(draft.file, draft.uploadId, (fraction) => {
              const progress = Math.floor(fraction * 10) * 10;
              if (progress !== draft.progress) { draft.progress = progress; renderDrafts(); }
            });
          },
          onSuccess: (draft, attachment) => { draft.status = "sent"; draft.error = ""; draft.attachment = attachment; renderDrafts(); },
          onFailure: (draft, error) => { draft.status = "failed"; draft.error = error instanceof Error ? error.message : String(error); renderDrafts(); toast(`Could not upload ${draft.file.name}: ${draft.error}`); },
        });
        if (!uploaded) return false;
      }
      const files = batchDrafts.filter((draft) => draft.status === "sent").map((draft) => draft.attachment.id);
      const request = pending ?? { requestId: ownerDraftState.sendId, text: requestText, uploadIds: batchDrafts.map((draft) => draft.uploadId), mode };
      ownerDraftState.pendingSend = request;
      let res;
      try {
        res = request.mode
          ? await api.ownerSend(request.text, files, request.requestId, request.mode)
          : await api.ownerSend(request.text, files, request.requestId);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
        const status = Number(error?.status);
        if (!pending && status >= 400 && status < 500) {
          // A definitive client rejection was not accepted; let the owner correct this draft.
          ownerDraftState.pendingSend = null;
          ownerDraftState.sendId = null;
          ownerDraftState.sendKey = null;
        }
        return false;
      }
      if (!res) return false;
      for (const draft of batchDrafts) {
        const index = drafts.indexOf(draft);
        if (index >= 0) drafts.splice(index, 1);
      }
      ownerDraftState.pendingSend = null;
      ownerDraftState.sendId = null;
      ownerDraftState.sendKey = null;
      ownerDraftState.messageText = pending && preserveText !== null && preserveText !== request.text ? preserveText : "";
      if (comp) comp.input.value = ownerDraftState.messageText;
      if (request.mode) toast(request.mode === "steer" ? "Steering Spencer…" : "Queued for next turn.", "info");
      keeper.toBottom();
      return true;
    } finally {
      ownerDraftState.sending = false;
      renderDrafts();
    }
  };
  async function retryPending() {
    const pending = ownerDraftState.pendingSend;
    if (!pending || ownerDraftState.sending) return;
    await send(pending.text, ownerDraftState.messageText);
  }

  const { input: fileInput, button: fileBtn } = createFilePicker((files) => addFiles(files));
  comp = composer({
    placeholder: "Message Spencer…", label: "Message Spencer", hint: [...SEND_HINT(), ". Attach or drop files."], drafts: draftArea, left: fileBtn, right: rightControls,
    canSend: () => drafts.length > 0, isBusy: () => ownerDraftState.sending,
    initialText: ownerDraftState.messageText,
    onTextChange: (text) => { ownerDraftState.messageText = text; },
    onKey: (e) => {
      if (S.ownerBusy && e.key === "Enter" && e.altKey && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        nextSendModeOverride = busyMode === "steer" ? "followUp" : "steer";
        void comp.submit();
        return true;
      }
      if (S.ownerBusy && e.key === "Escape" && !comp.input.value.trim() && !e.isComposing) {
        e.preventDefault();
        void stopRun();
        return true;
      }
      return false;
    },
    onSend: send,
  });

  const onEscapeKey = (e) => {
    if (e.defaultPrevented || e.key !== "Escape" || !S.ownerBusy || stopping) return;
    if (document.querySelector("#modal-root .overlay")) return;
    if (document.activeElement === comp.input && comp.input.value.trim()) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== comp.input && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    e.preventDefault();
    void stopRun();
  };
  document.addEventListener("keydown", onEscapeKey);

  const addDroppedFiles = (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    const files = [];
    let folderDropped = false;
    const items = Array.from(event.dataTransfer.items ?? []);
    if (items.length) {
      for (const item of items) {
        if (item.kind !== "file") continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) { folderDropped = true; continue; }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    } else files.push(...Array.from(event.dataTransfer.files ?? []));
    if (folderDropped) toast("Folders can’t be attached; drop regular files instead");
    addFiles(files);
  };
  const addFiles = (files) => {
    let total = drafts.reduce((sum, draft) => sum + draft.file.size, 0);
    for (const file of files) {
      if (!file.name || file.size > MAX_FILE_BYTES) { toast(`${file.name || "File"} exceeds the 25 MiB limit`); continue; }
      if (new TextEncoder().encode(file.name).length > 255) { toast("File names must be 255 bytes or shorter"); continue; }
      if (hasDraftFile(drafts, file)) continue;
      if (drafts.length >= MAX_DRAFT_FILES || total + file.size > MAX_DRAFT_BYTES) { toast("The composer allows up to 10 files and 50 MiB at a time"); break; }
      drafts.push({ file, uploadId: crypto.randomUUID(), status: "draft", progress: 0, error: "" });
      total += file.size;
    }
    renderDrafts();
  };
  comp.form.append(fileInput);
  comp.form.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) { event.preventDefault(); comp.form.classList.add("file-drop-target"); }
  });
  comp.form.addEventListener("dragleave", (event) => { if (!comp.form.contains(event.relatedTarget)) comp.form.classList.remove("file-drop-target"); });
  comp.form.addEventListener("drop", (event) => { comp.form.classList.remove("file-drop-target"); addDroppedFiles(event); });
  ownerDraftState.renderers.add(renderDraftsForView);
  renderDrafts();

  const headMark = h("span.header-mark");
  const sub = h("span.subtitle");
  // Reminders, queued steers/follow-ups, and continue bar docked above the composer.
  const later = h("div.owner-later");
  // No model yet (first run, or the sign-in was revoked): say so where the owner is about to type.
  const setup = () =>
    S.model && !S.model.ready
      ? h(
          "div.model-nudge",
          { role: "status" },
          icon("spark", 16),
          h("span.model-nudge-text", null, h("strong", null, "Spencer has no model yet. "), "Sign in with GitHub Copilot to give it one."),
          h("a.btn.sm.primary", { href: hashFor({ name: "model" }) }, "Connect a model"),
        )
      : null;

  const continueBanner = () => {
    if (S.ownerBusy || !S.ownerRun?.canContinue) return null;
    const btn = h("button.btn.sm.primary", { type: "button", disabled: continuing, on: { click: () => void continueRun() } }, icon("play", 12), "Continue");
    return h(
      "div.owner-continue",
      { role: "status" },
      h("span.owner-continue-text", null, failureLabel(S.ownerRun.lastFailure)),
      btn,
    );
  };

  const queueList = () => {
    const items = S.ownerRun?.queue ?? [];
    if (!items.length) return null;
    return h(
      "section.owner-queue",
      { "aria-label": "Queued messages" },
      h("h2", null, "Queued for Spencer", h("span.count", null, String(items.length))),
      h(
        "ul",
        null,
        items.map((item) => {
          const remove = h("button.btn.ghost.xs", { type: "button", title: "Remove from queue", "aria-label": "Remove queued message" }, "Remove");
          remove.addEventListener("click", async () => {
            remove.disabled = true;
            const res = await attempt(() => api.ownerWithdraw(item.id));
            if (res?.result === "aborted") toast("Removed from queue.", "info");
            else if (res?.result && res.result !== "aborted") toast("Already delivered to Spencer.", "info");
            else remove.disabled = false;
          });
          const label = item.text || (item.attachments?.length ? `${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}` : "(message)");
          return h(
            "li.owner-queue-item",
            null,
            h(`span.pill.${item.mode === "steer" ? "accent" : "muted"}`, null, item.mode === "steer" ? "Steer" : "Next"),
            h("span.owner-queue-text", { title: label }, label.replace(/\s+/g, " ").trim()),
            remove,
          );
        }),
      ),
    );
  };

  const renderLater = () =>
    later.replaceChildren(...[setup(), continueBanner(), queueList(), followupList("owner", { compact: true, title: "Spencer will check back" })].filter(Boolean));
  main.append(viewHeader([headMark, h("div.title-stack", null, h("h1", null, "Spencer"), sub)]), st.el, later, comp.form);
  renderLater();

  let seen = 0;
  const render = () => {
    keeper.before();
    if (!S.owner) {
      transcript.replaceChildren(skeleton(4));
    } else if (!S.owner.length) {
      transcript.replaceChildren(
        h(
          "div.empty-chat",
          null,
          selfAvatar("big"),
          h("h2", null, "What should Spencer do?"),
          h("p", null, "It can message other people's Spencers for you, send files, and use its tools. Answers from peers come back here."),
          h(
            "div.examples",
            null,
            EXAMPLES.map((ex) =>
              h("button.example", { type: "button", on: { click: () => send(ex) } }, h("span", null, ex), icon("up", 14)),
            ),
          ),
        ),
      );
    } else {
      // Precompute whether any assistant or user message follows each index so settled tool blocks and peer replies fold cleanly.
      const total = S.owner.length;
      const hasTurnAfter = new Array(total).fill(false);
      let sawTurn = false;
      for (let i = total - 1; i >= 0; i--) {
        hasTurnAfter[i] = sawTurn;
        const r = S.owner[i].role;
        if (r === "assistant" || r === "user") sawTurn = true;
      }

      const nodes = [];
      let run = [];
      let runEndIdx = -1;
      let notes = [];
      let notesEndIdx = -1;
      const flush = () => {
        if (run.length) {
          const isLive = S.ownerBusy && !hasTurnAfter[runEndIdx];
          nodes.push(stepsBlock(run, { live: isLive }));
        }
        if (notes.length) {
          nodes.push(exchangeRow(notes, hasTurnAfter[notesEndIdx]));
        }
        run = [];
        runEndIdx = -1;
        notes = [];
        notesEndIdx = -1;
      };
      let lastDay = "";
      for (let i = 0; i < total; i++) {
        const item = S.owner[i];
        const day = new Date(item.ts).toDateString();
        if (item.role === "tool" && day === lastDay && !notes.length) {
          run.push(item);
          runEndIdx = i;
          continue;
        }
        if (isPeerNote(item) && day === lastDay && !run.length) {
          notes.push(item);
          notesEndIdx = i;
          continue;
        }
        flush();
        if (day !== lastDay) {
          nodes.push(h("div.day-sep", null, h("span", null, new Date(item.ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))));
          lastDay = day;
        }
        if (item.role === "tool") {
          run.push(item);
          runEndIdx = i;
        } else if (isPeerNote(item)) {
          notes.push(item);
          notesEndIdx = i;
        } else {
          nodes.push(ownerItem(item));
        }
      }
      flush();
      transcript.replaceChildren(...nodes);
      if (S.owner.length > seen && seen) st.note();
      seen = S.owner.length;
    }
    keeper.after();
  };

  const renderBusy = () => {
    keeper.before();
    headMark.replaceChildren(mark(selfAvatar(), S.ownerBusy ? { state: "working", text: "working" } : null));
    sub.textContent = S.ownerBusy ? "Working on it" : "Your agent. Only you see this conversation.";
    if (!S.ownerBusy) busy.replaceChildren();
    else {
      const last = S.owner?.at(-1);
      const activity = last && isCall(last) ? toolActivity(last.toolName ?? "a tool") : "Thinking";
      const stopTraceBtn = h("button.btn.ghost.xs.trace-stop", { type: "button", disabled: stopping, on: { click: () => void stopRun() } }, icon("stop", 11), "Stop");
      busy.replaceChildren(trace({ key: "owner", avatar: selfAvatar(), name: "Spencer", activity, since: S.ownerBusySince || Date.now(), action: stopTraceBtn }));
    }
    keeper.after();
  };

  render();
  renderBusy();
  syncBusyControls();
  if (!S.owner) attempt(() => api.ownerMessages(200)).then((r) => r && setOwner(r.items ?? []));
  requestAnimationFrame(() => {
    keeper.toBottom();
    comp.input.focus();
  });

  const offs = [
    on("owner", () => (render(), renderBusy())),
    on("busy", () => (render(), renderBusy(), renderLater(), syncBusyControls())),
    on("owner_queue", () => (renderLater(), syncBusyControls())),
    on("followups", renderLater),
    on("model", renderLater),
  ];
  return {
    destroy: () => {
      document.removeEventListener("keydown", onEscapeKey);
      ownerDraftState.renderers.delete(renderDraftsForView);
      comp.destroy();
      offs.forEach((f) => f());
    },
  };
}
