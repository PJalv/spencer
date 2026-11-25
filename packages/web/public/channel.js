import { groupMemoirSnippet } from "./memoir.js";
// A channel (direct or group): the transcript between people and their Spencers, composer, members, files and settings.
import { peerCard, peerBioSnippet } from "./peers.js";
import { h, icon, iconButton, richText, shortFp, timeShort, timeFull, autoGrow, hue, avatar, selfAvatar, youAvatar, personOf, clear, append, relTime } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, isConversation, setConversation, setMessages, upsertTransfer, upsertChannel, removeChannel, markRead, peers, channelTitle, allMcpTools, workingIn, workingOf, typingIn, presenceOf } from "./state.js";
import { markdown } from "./md.js";
import { joinModal } from "./invites.js";
import { inviteLinks, suppressQuietNotice } from "./chat-polish.js";
import { viewHeader, composer, SEND_HINT, stage, skeleton, emptyState, trace, mark, presenceInfo, activityLine, followupList } from "./common.js";
import { transferCard } from "./transfers.js";
import { openModal, field } from "./modal.js";
import { scrollKeeper } from "./scroll.js";
import { navigate } from "./router.js";
import { draftFileError, hasDraftFile, uploadDraftBatch } from "./draft-batch.js";
import { createFilePicker, createDraftRecipientSelect, createDraftRemoveButton, refreshDraftRecipientOptions, scrollAfterAcceptedFile } from "./draft-dom.js";
import { clearSentDraftsWhenNoWork, discardEmptyChannelDraftState, getChannelDraftState, markUploadFailure, releaseRecipientAfterDefiniteFailure, removeDraft, resolveUploadSuccess, selectDraftRecipient } from "./draft-state.js";
import { timelineItems } from "./timeline-order.js";

const NOTE_LABEL = {
  "not addressed": "Your Spencer stayed quiet: it was not addressed.",
  "hop cap": "Your Spencer stayed quiet: the automatic reply limit was reached.",
  "rate limited": "Your Spencer stayed quiet: it is rate limited.",
  "auto-reply off": "Your Spencer stayed quiet: auto-reply is off here.",
  "conversation ended": "Your Spencer stayed quiet: the other side ended the exchange.",
  repeated: "Your Spencer stayed quiet: this repeats an earlier message.",
  "budget exhausted": "Your Spencer paused: it used its automatic replies here. Continue or stop it from Needs you.",
  "handled by owner": "Your Spencer picked this up in your own chat.",
  "out of messages": "Your Spencer stayed quiet: it used all its messages in this conversation.",
  "not in this conversation": "Your Spencer stayed quiet: this conversation is over or it is not part of it.",
};
/** Consecutive turns by the same speaker within this window share one header. */
const GROUP_MS = 5 * 60_000;
const MAX_DRAFT_FILES = 10;
const MAX_DRAFT_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const attachmentDraftsByChannel = new Map();

function hasDraggedFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

// A file dropped anywhere in the document must never be interpreted by the browser as navigation.
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (e) => {
    if (hasDraggedFiles(e)) e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------- message rendering

/**
 * Who a message is from, for display. A person and their agent share one identity; `by` says which of
 * them typed. Returns {name, label, fp, id, kind, mine, avatar()}.
 */
function speaker(c, m) {
  const mem = c.members.find((x) => x.id === m.from);
  const by = m.by ?? (m.mine ? "human" : "agent");
  const identity = m.mine ? (S.me?.name ?? "Your Spencer") : m.fromName || mem?.name || `${m.from.slice(0, 8)}…`;
  const id = m.mine ? (S.me?.id ?? m.from) : m.from;
  const fp = m.mine ? S.me?.fingerprint : mem?.fingerprint;
  if (by === "human") {
    const p = personOf(identity);
    return {
      id,
      fp,
      kind: "human",
      mine: m.mine,
      name: m.mine ? "You" : p.person,
      // The identity name did not tell us the person's name: say that a person typed it.
      label: m.mine || p.derived ? null : "typed by a person",
      avatar: (cls = "") => (m.mine ? youAvatar(p.person, cls) : avatar(p.person, id, cls, "human")),
    };
  }
  return { id, fp, kind: "agent", mine: m.mine, name: identity, label: null, avatar: (cls = "") => (m.mine ? selfAvatar(cls) : avatar(identity, id, cls)) };
}

function jumpTo(id) {
  const el = document.getElementById(`m-${id}`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1400);
}

/** One line above a reply that names its parent and jumps to it. */
function replyRef(c, m, byId) {
  if (!m.replyTo) return null;
  const target = byId.get(m.replyTo);
  if (!target) return h("div.reply-ref.missing", null, icon("reply", 13), h("span", null, "Reply to an earlier message"));
  const who = speaker(c, target);
  const text = (target.text ?? target.type).replace(/\s+/g, " ");
  return h(
    "button.reply-ref",
    { type: "button", title: "Go to the message this replies to", on: { click: () => jumpTo(target.id) } },
    icon("reply", 13),
    who.avatar("xs"),
    h("span.reply-who", null, who.name),
    h("span.reply-text", null, text.length > 120 ? `${text.slice(0, 120)}…` : text),
  );
}

function statusMark(m) {
  if (!m.mine) return null;
  if (m.status === "failed") return h("span.status.failed", { title: m.note ? `Not delivered: ${m.note}` : "Not delivered" }, icon("warn", 13), " not delivered");
  if (m.status === "pending") return h("span.status.pending", { title: "Queued. The relay has not accepted it yet.", role: "img", "aria-label": "sending" }, icon("clock", 12));
  return h("span.status.sent", { title: "Delivered to the relay", role: "img", "aria-label": "sent" }, icon("check", 12));
}

function systemLine(c, m) {
  const mem = c.members.find((x) => x.id === m.from);
  const name = m.mine ? (S.me?.name ?? "Your Spencer") : m.fromName || mem?.name || `${m.from.slice(0, 8)}…`;
  const fp = m.mine ? S.me?.fingerprint : mem?.fingerprint;
  const time = h("time", { datetime: new Date(m.ts).toISOString(), title: timeFull(m.ts) }, timeShort(m.ts));
  if (m.type === "hello") {
    return h(
      "div.system-line",
      { id: `m-${m.id}` },
      h("span", null, h("strong", null, name), " joined"),
      m.text ? h("span.system-extra", null, `“${m.text}”`) : null,
      fp ? h("code.fp", { title: `Fingerprint ${fp}\nid ${m.from}\nCompare it with them over another channel to be sure who this is.` }, shortFp(fp)) : null,
      time,
    );
  }
  return h("div.system-line", { id: `m-${m.id}` }, h("span", null, h("strong", null, name), ` ${m.type}${m.text ? `: ${m.text}` : ""}`), time);
}

/** A chat turn. `cont`: it continues the previous turn by the same speaker (no header). `hideRef`: the parent is right above. */
function messageRow(c, m, byId, names, myNames, cont, hideRef, hideNote) {
  const who = speaker(c, m);
  const time = h("time", { datetime: new Date(m.ts).toISOString(), title: timeFull(m.ts) }, timeShort(m.ts));
  const failed = m.mine && m.status === "failed";
  let note = null;
  if (!m.mine && m.note && !hideNote) note = h("p.route-note", null, NOTE_LABEL[m.note] ?? `Your Spencer stayed quiet: ${m.note}.`);
  else if (failed) note = h("p.route-note.failed", null, icon("warn", 13), ` The relay rejected this message${m.note ? `: ${m.note}` : ""}. It will not be retried.`);
  const head = cont
    ? null
    : h(
        "div.msg-head",
        null,
        h("span.who", { title: who.fp ? `Fingerprint ${who.fp}\nid ${who.id}` : undefined }, who.name),
        who.kind === "agent" && who.mine ? h("span.tag", null, "yours") : null,
        who.label ? h("span.tag", null, who.label) : null,
        m.origin === "agent-followup" ? h("span.tag", { title: "Sent on its own, from a follow-up it scheduled" }, "follow-up") : null,
        m.convo?.mod ? h("span.tag", { title: "Heated mode: the moderator ended this conversation" }, "moderator") : null,
        m.convo?.start && m.by === "agent" ? h("span.tag", { title: "Its conversation timer went off: it opened a new conversation" }, "new topic") : null,
        m.convo?.start && m.convo.heated ? h("span.tag", { title: "Heated mode: a real argument, with a moderator" }, "heated") : null,
        m.hop > 0 ? h("span.tag.hop", { title: `Automatic reply, ${m.hop} ${m.hop === 1 ? "step" : "steps"} from a person's message` }, `hop ${m.hop}`) : null,
        time,
        statusMark(m),
      );
  const row = h(
    `div.msg.${who.kind}${who.mine ? ".mine" : ""}${cont ? ".cont" : ""}${failed ? ".failed" : ""}`,
    { id: `m-${m.id}` },
    h("div.msg-gutter", null, cont ? [h("span.gutter-time", { "aria-hidden": "true" }, timeShort(m.ts).replace(/\s?[AP]M$/i, "")), statusMark(m)] : who.avatar()),
    h("div.msg-body", null, head, hideRef ? null : replyRef(c, m, byId), h("div.msg-text.md", null, markdown(m.text ?? "", (s) => richText(s, names, myNames))), inviteLinks(m.text ?? "").map((link) => h("button.btn", { type: "button", on: { click: () => joinModal(link) } }, "Join channel")), m.final && !failed ? h("p.route-note.end", { title: "The sender closed this exchange and expects no answer" }, icon("check", 12), " Ended the exchange") : null, note),
  );
  if (!who.mine) row.style.setProperty("--h", String(hue(who.id)));
  return row;
}

// ---------------------------------------------------------------- mention completion

function mentionCompleter(input, getChannel, onChange) {
  const list = h("ul.mention-list", { role: "listbox", hidden: true, "aria-label": "Mention a member" });
  let state = null; // {start, items, idx}

  const close = () => {
    state = null;
    list.hidden = true;
    input.removeAttribute("aria-activedescendant");
  };

  const pick = (i) => {
    if (!state) return;
    const m = state.items[i];
    const caret = input.selectionStart;
    const before = input.value.slice(0, state.start);
    const after = input.value.slice(caret);
    const ins = `@${m.name} `;
    input.value = before + ins + after;
    const pos = before.length + ins.length;
    input.setSelectionRange(pos, pos);
    close();
    autoGrow(input);
    onChange?.(input.value);
    input.focus();
  };

  const render = () => {
    clear(list);
    state.items.forEach((m, i) => {
      const li = h(
        `li.mention-opt${i === state.idx ? ".active" : ""}`,
        { role: "option", id: `mopt-${i}`, "aria-selected": String(i === state.idx), on: { mousedown: (e) => (e.preventDefault(), pick(i)) } },
        avatar(m.name, m.id, "xs"),
        h("span", null, m.name),
        h("code.fp", null, shortFp(m.fingerprint)),
      );
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-activedescendant", `mopt-${state.idx}`);
  };

  const update = () => {
    const c = getChannel();
    const caret = input.selectionStart;
    if (!c || caret !== input.selectionEnd) return close();
    const upto = input.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0 || (at > 0 && /[\w@]/.test(upto[at - 1]))) return close();
    const q = upto.slice(at + 1).toLowerCase();
    if (q.length > 32 || q.includes("\n")) return close();
    const items = peers(c).filter((m) => m.name && m.name.toLowerCase().startsWith(q) && m.name.toLowerCase() !== q);
    if (!items.length) return close();
    state = { start: at, items, idx: Math.min(state?.idx ?? 0, items.length - 1) };
    render();
  };

  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", () => setTimeout(close, 100));
  return {
    el: list,
    /** Returns true if the key was handled by the popup. */
    onKey(e) {
      if (!state) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = state.items.length;
        state.idx = (state.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        render();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(state.idx);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
  };
}

/** Ids of members whose @name appears in the text. */
function mentionIds(c, text) {
  const lower = text.toLowerCase();
  return peers(c)
    .filter((m) => m.name && new RegExp(`(^|[^\\w@])@${escapeRe(m.name.toLowerCase())}(?![\\w])`).test(lower))
    .map((m) => m.id);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- modals

function sendFileModal(c) {
  const path = h("input.input", { type: "text", placeholder: "/home/you/Documents/report.pdf", spellcheck: "false", autocomplete: "off", "data-autofocus": true });
  const ps = peers(c);
  let select = null;
  if (c.kind === "group") {
    select = h(
      "select.input",
      null,
      h("option", { value: "" }, "Choose a member…"),
      ps.map((m) => h("option", { value: m.id }, `${m.name || m.id.slice(0, 8)} (${shortFp(m.fingerprint)})`)),
    );
  }
  const submit = h("button.btn.primary", { type: "submit", form: "send-file-form" }, "Request send");
  const form = h(
    "form",
    { id: "send-file-form" },
    field(
      "File path on this computer",
      path,
      "Browsers can't tell a page where a file lives, so type or paste its absolute path. Spencer copies it to its outgoing folder; you approve it before it is offered.",
    ),
    select ? field("Recipient", select) : h("p.hint", null, `To ${ps[0]?.name ?? "the other member"} via croc, end-to-end encrypted.`),
  );
  const modal = openModal({
    title: `Send a file to ${channelTitle(c)}`,
    body: form,
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), submit],
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = path.value.trim();
    if (!p) return path.focus();
    if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("~")) {
      toast("Please use an absolute path (starting with /)");
      return path.focus();
    }
    if (select && !select.value) {
      toast("Choose who gets the file");
      return select.focus();
    }
    submit.disabled = true;
    const t = await attempt(() => api.sendFile(c.id, p, select?.value || undefined));
    submit.disabled = false;
    if (t && t.tid) {
      upsertTransfer(t);
      modal.close();
      toast(t.state === "awaiting_approval" ? "File staged — approve it to offer it" : "File offered", "info");
    }
  });
}

function settingsModal(c) {
  const name = h("input.input", { type: "text", value: c.name, maxlength: "100" });
  const shareBio = h("input", { type: "checkbox", checked: c.shareBio !== false, role: "switch" });
  const autoReply = h("input", { type: "checkbox", checked: c.autoReply, role: "switch" });
  const heated = h("input", { type: "checkbox", checked: !!c.heated, role: "switch" });
  const directLink = h("input", { type: "checkbox", checked: c.directLink !== "off", role: "switch" });
  const allowLocal = h("input", { type: "checkbox", checked: !!c.allowLocalAddresses, disabled: !directLink.checked, role: "switch" });
  directLink.addEventListener("change", () => { allowLocal.disabled = !directLink.checked; });
  const peerName = c.kind === "direct" ? peers(c)[0]?.name?.replace(/'s Spencer$/, "") : null;
  const toolsBox = h("div.tool-checks", null, h("p.hint", null, "Loading MCP tools…"));
  const selected = new Set(c.allowedMcpTools ?? []);
  let trust = c.trust === "full" ? "full" : "standard";
  const trustOption = (value, title, desc) => {
    const radio = h("input", { type: "radio", name: "trust", value, checked: trust === value });
    radio.addEventListener("change", () => {
      if (radio.checked) {
        trust = value;
        syncTrust();
      }
    });
    return h("label.trust-option", null, radio, h("span", null, h("strong", null, value === "full" ? [icon("shield", 14), " ", title] : title), h("span.hint.block", null, desc)));
  };
  const toolsField = h("div.field");
  const syncTrust = () => {
    toolsField.hidden = trust === "full";
    fullWarn.hidden = trust !== "full";
  };
  const fullWarn = h(
    "div.callout.warn",
    null,
    icon("warn", 16),
    h(
      "span",
      null,
      "Peers in this channel can make your Spencer use every MCP tool (for T3 Code: start threads, run agents with their access level) and receive files without your approval. You still see every tool call in your Spencer chat. Only pick this for people you trust like yourself.",
    ),
  );

  const renderTools = () => {
    const tools = allMcpTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = [...selected].filter((t) => !names.has(t));
    if (!tools.length && !missing.length) {
      toolsBox.replaceChildren(h("p.hint", null, "No MCP tools available. Add servers on the ", h("a", { href: "#/mcp", on: { click: () => modal.close() } }, "MCP servers page"), "."));
      return;
    }
    const byServer = new Map();
    for (const t of tools) {
      if (!byServer.has(t.server)) byServer.set(t.server, []);
      byServer.get(t.server).push(t);
    }
    const check = (tname, desc, extra) => {
      const cb = h("input", { type: "checkbox", checked: selected.has(tname), on: { change: () => (cb.checked ? selected.add(tname) : selected.delete(tname)) } });
      return h("label.check", { title: desc ?? "" }, cb, h("span.check-text", null, h("code", null, tname), extra ? h("span.muted", null, ` ${extra}`) : null, desc ? h("span.check-desc", null, desc) : null));
    };
    append(clear(toolsBox), [
      ...[...byServer].map(([server, ts]) => h("fieldset.tool-group", null, h("legend", null, server), ts.map((t) => check(t.name, t.description)))),
      missing.length ? h("fieldset.tool-group", null, h("legend", null, "Unavailable"), missing.map((t) => check(t, undefined, "(server not connected)"))) : null,
    ]);
  };

  const saveBtn = h("button.btn.primary", { type: "submit", form: "settings-form" }, "Save");
  const leaveArea = h("div.danger-zone");
  const renderLeave = (confirming) => {
    if (!confirming) {
      leaveArea.replaceChildren(
        h("div", null, h("strong", null, "Leave channel"), h("p.hint", null, "You'll stop receiving its messages and it disappears from this list.")),
        h("button.btn.danger", { type: "button", on: { click: () => renderLeave(true) } }, "Leave…"),
      );
      return;
    }
    const yes = h(
      "button.btn.danger",
      {
        type: "button",
        on: {
          click: async () => {
            yes.disabled = true;
            const r = await attempt(() => api.leaveChannel(c.id));
            yes.disabled = false;
            if (r) {
              modal.close();
              removeChannel(c.id);
              navigate({ name: "owner" });
              toast(`Left ${channelTitle(c)}`, "info");
            }
          },
        },
      },
      "Yes, leave",
    );
    leaveArea.replaceChildren(
      h("div", null, h("strong", null, `Leave “${channelTitle(c)}”?`), h("p.hint", null, c.kind === "direct" ? "Direct invite links can't be reused, so you'd need a new invite to talk again." : "You'd need the invite link again to rejoin.")),
      h("div.row", null, h("button.btn", { type: "button", on: { click: () => renderLeave(false) } }, "Cancel"), yes),
    );
    yes.focus();
  };
  renderLeave(false);

  const policy = S.policy ?? {};
  const form = h(
    "form",
    { id: "settings-form" },
    h("div.field", null, h("div.label", null, "Hub"), h("code.mono", null, c.relayUrl ?? "")),
    h("label.switch-row", null, directLink, h("span", null, h("strong", null, "Direct file transfers"), h("span.hint.block", null, `Send files directly when you're both online. Faster, and the bytes don't go through the server, but ${peerName ? `${peerName}'s Spencer sees` : "peers' Spencers see"} your IP address while a file is moving.`))),
    S.p2p?.available === false ? h("div.callout.warn", null, icon("warn", 16), h("span", null, `Direct file transfers aren't available on this machine${S.p2p.error ? ": " + S.p2p.error : "."}`)) : null,
    S.p2p?.mode === "off" ? h("span.hint.block", null, `Direct file transfers are currently disabled in Spencer's config (p2p.mode = "off").`) : null,
    h("label.switch-row", null, allowLocal, h("span", null, h("strong", null, "Allow local network addresses"), h("span.hint.block", null, "Share local LAN addresses in this channel for faster transfers between machines on the same Wi-Fi or network."))),
    h("label.switch-row", null, shareBio, h("span", null, "Share my BIO in this channel", h("span.hint.block", null, "Turning this off clears it for peers going forward. Peers may already have an older copy."))),
    field("Name", name, c.kind === "direct" ? "Your private label for this channel. Peers don't see it." : "Your label for this group."),
    h(
      "label.switch-row",
      null,
      autoReply,
      h(
        "span",
        null,
        h("strong", null, "Auto-reply"),
        h(
          "span.hint.block",
          null,
          `Your Spencer answers peer messages on its own${c.kind === "group" ? " when mentioned" : ""}. Limits: ${policy.maxHops ?? 4} hops, ${policy.repliesPerMinute ?? 6}/min, ${policy.repliesPerHour ?? 60}/hour.`,
        ),
      ),
    ),
    isConversation(c)
      ? h(
          "label.switch-row",
          null,
          heated,
          h(
            "span",
            null,
            h("strong", null, "Heated mode"),
            h(
              "span.hint.block",
              null,
              "Conversations your Spencer starts are real arguments about spicy topics. A moderator watches them and ends one that goes off the rails. Off: chill hangouts about fun stuff.",
            ),
          ),
        )
      : null,
    h(
      "div.field",
      null,
      h("div.label", null, "Trust"),
      h(
        "div.trust-options",
        null,
        trustOption(
          "standard",
          "Standard",
          "Your Spencer chats on its own but asks you (Approve / Deny) before doing tasks for them. File sends need your approval. Only the MCP tools picked below.",
        ),
        trustOption("full", "Full trust", "No approvals: your Spencer does what they ask with all its MCP tools and sends files right away."),
      ),
      fullWarn,
    ),
    append(toolsField, [
      h("div.label", null, "MCP tools this channel's agent may use without asking"),
      h("div.callout.warn", null, icon("warn", 16), h("span", null, "MCP tools let peers in this channel trigger real actions on your machine through your Spencer. Only allow tools you'd let them run.")),
      toolsBox,
    ]),
  );
  syncTrust();
  const modal = openModal({
    title: `${channelTitle(c)} settings`,
    wide: true,
    body: [form, leaveArea],
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), saveBtn],
  });
  renderTools();
  attempt(() => api.mcp()).then((r) => {
    if (r && Array.isArray(r.servers)) {
      S.mcp = r.servers;
      renderTools();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = {};
    const n = name.value.trim();
    if (n && n !== c.name) patch.name = n;
    if ((directLink.checked ? "auto" : "off") !== (c.directLink ?? "auto")) patch.directLink = directLink.checked ? "auto" : "off";
    if (allowLocal.checked !== !!c.allowLocalAddresses) patch.allowLocalAddresses = allowLocal.checked;
    if (shareBio.checked !== (c.shareBio !== false)) patch.shareBio = shareBio.checked;
    if (autoReply.checked !== c.autoReply) patch.autoReply = autoReply.checked;
    if (isConversation(c) && heated.checked !== !!c.heated) patch.heated = heated.checked;
    if (trust !== (c.trust ?? "standard")) patch.trust = trust;
    const tools = [...selected].sort();
    if (JSON.stringify(tools) !== JSON.stringify([...(c.allowedMcpTools ?? [])].sort())) patch.allowedMcpTools = tools;
    if (!Object.keys(patch).length) return modal.close();
    saveBtn.disabled = true;
    const updated = await attempt(() => api.patchChannel(c.id, patch));
    saveBtn.disabled = false;
    if (updated && updated.id) {
      upsertChannel(updated);
      modal.close();
      toast("Settings saved", "info");
    }
  });
}

// ---------------------------------------------------------------- members panel

const MEMBERS_KEY = "spencer.members";
const wide = () => matchMedia("(min-width: 1180px)").matches;

/** Conversations channels: my timer, the conversation going on, and "Start now". */
function hourLabel(hr) {
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${h12}${hr % 24 < 12 ? "am" : "pm"}`;
}

function zoneLabel(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

function conversationSection(c) {
  const st = S.conversations.get(c.id);
  let what;
  let detail;
  if (!st) {
    what = "Conversations";
    detail = "Loading…";
  } else if (!c.autoReply) {
    what = "Paused";
    detail = "Auto-reply is off: your Spencer won't start or join conversations.";
  } else if (st.opening) {
    what = "Picking a topic…";
    detail = "Your Spencer is opening a new conversation.";
  } else if (st.active) {
    const left = Math.max(0, st.active.max - st.active.used);
    what = st.active.heated ? "Heated conversation going on" : "Conversation going on";
    detail = `Your Spencer has ${left} of ${st.active.max} messages left. It ends when they wrap up or go quiet.${st.active.moderating ? " Your Spencer moderates this one and ends it if it goes off the rails." : ""}`;
  } else if (!peers(c).length) {
    what = "Waiting for people";
    detail = "Conversations start once someone else joins: share the invite link.";
  } else {
    what = `Next topic ${relTime(Math.max(st.nextAt, Date.now() + 60_000))}`;
    detail = "Unless another Spencer brings one up first (then every timer starts over).";
  }
  if (st?.hours && !st.active && !st.opening && c.autoReply && peers(c).length) detail += ` Conversations only open between ${hourLabel(st.hours.start)} and ${hourLabel(st.hours.end)} (${zoneLabel(st.hours.timeZone)}).`;
  const canStart = st && !st.opening && !st.active && c.autoReply && peers(c).length > 0;
  const start = canStart
    ? h(
        "button.btn.sm",
        {
          type: "button",
          on: {
            click: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              const res = await attempt(() => api.startConversation(c.id));
              if (res?.ch) setConversation(res);
              else btn.disabled = false;
            },
          },
        },
        icon("spark", 14),
        "Start one now",
      )
    : null;
  return h(
    "section.access",
    { "aria-label": "Conversations" },
    h("h2", null, "Conversations"),
    h("div.access-row", null, icon(st?.active ? "spark" : "clock", 15), h("div", null, h("strong", null, what), h("p", null, detail))),
    start,
  );
}

function membersPref() {
  try {
    return localStorage.getItem(MEMBERS_KEY) !== "0";
  } catch {
    return true;
  }
}

function memberRow(c, m) {
  const w = workingOf(c.id, m.id);
  const info = presenceInfo(m, c.id);
  const name = m.name ?? `${m.id.slice(0, 6)}…`;
  const av = m.me ? selfAvatar() : avatar(name, m.id);
  let status;
  if (typingIn(c.id).includes(m.id)) status = h("span.member-status.live", null, "typing…");
  else if (w) status = h("span.member-status.live", null, h("span.act.shimmer", null, activityLine(w.activity)));
  else if (m.me) status = h("span.member-status", null, "this computer");
  else if (info) status = h("span.member-status", null, info.text);
  else status = h("span.member-status", null, m.name ? "presence unknown" : "has not said hello yet");
  return h(
    "li.member",
    m.me ? null : { tabindex: "0", role: "button", on: { click: () => peerCard(m.id, c.id), keydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); peerCard(m.id, c.id); } } } },
    mark(av, w ? { state: /^thinking/i.test(w.activity) ? "thinking" : "working", text: w.activity.replace(/…$/, "") } : info),
    h("div.member-text", null, h("div.member-name", null, name), status),
    h("code.fp", { title: `Fingerprint ${m.fingerprint}\nid ${m.id}` }, shortFp(m.fingerprint)),
  );
}

// ---------------------------------------------------------------- view

export function channelView(main, chId) {
  const getC = () => S.channels.get(chId);
  const header = h("div.header-slot");
  const timeline = h("div.transcript", { role: "log", "aria-live": "polite", "aria-label": "Channel messages" });
  const olderBtn = h("button.btn.sm.load-older", { type: "button", hidden: true }, "Load older messages");
  const workingBox = h("div.live", { role: "status" });
  const scroller = h("div.scroller", null, olderBtn, timeline, workingBox);
  const keeper = scrollKeeper(scroller);
  const st = stage(scroller, keeper);
  const members = h("aside.members", { "aria-label": "Members and access" });
  let hasOlder = false;
  let messagesLoaded = false;
  let historyExpansionPending = false;
  let membersOpen = wide() && membersPref();

  let typingTimer, typingLast = 0, typingActive = false;
  const stopTyping = () => { clearTimeout(typingTimer); if (typingActive) api.typing(chId, false); typingActive = false; typingLast = 0; };
  const send = async (text) => {
    stopTyping();
    if (draftState.sending) return false;
    const c = getC();
    if (!c || c.id !== chId) return false;
    const hasAttachments = drafts.some((d) => d.status !== "sent");
    const recipient = hasAttachments && c.kind === "group" ? (draftState.recipient ?? recipientSelect?.value) : undefined;
    if (hasAttachments && c.kind === "group" && !recipient) {
      toast("Choose who gets the files");
      recipientSelect?.focus();
      return false;
    }
    draftState.sending = true;
    renderDrafts();
    try {
      if (hasAttachments) {
        const batchOk = await uploadDraftBatch(drafts, {
          isPresent: (draft) => draftState.drafts.includes(draft),
          onUpdate: () => renderDrafts(),
          upload: async (draft) => {
            if (c.kind === "group") {
              draftState.recipient = recipient;
              draftState.recipientLocked = true;
              draft.attemptRecipient = recipient;
            }
            draft.status = "uploading";
            draft.progress = 0;
            renderDrafts();
            return api.uploadFile(c.id, draft.file, recipient, draft.uploadId, (fraction) => {
              const progress = Math.floor(fraction * 10) * 10;
              if (progress !== draft.progress) {
                draft.progress = progress;
                renderDrafts();
              }
            });
          },
          onSuccess: (draft, transfer) => {
            draft.status = "sent";
            draft.error = "";
            resolveUploadSuccess(draft);
            draft.transfer = transfer;
            upsertTransfer(transfer);
            renderDrafts();
            scrollAfterAcceptedFile(draftState.scrollers, text);
          },
          onFailure: (draft, error) => {
            draft.status = "failed";
            draft.error = error instanceof Error ? error.message : String(error);
            markUploadFailure(draft, error);
            renderDrafts();
            toast(`Could not send ${draft.file.name}: ${draft.error}`);
          },
        });
        if (!batchOk) {
          const accepted = drafts.some((draft) => draft.status === "sent");
          const unresolved = drafts.some((draft) => draft.outcomeUnknown);
          if (!accepted && !unresolved) {
            releaseRecipientAfterDefiniteFailure(draftState);
            if (recipientSelect) recipientSelect.disabled = false;
          }
          return false;
        }
        for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].status === "sent") drafts.splice(i, 1);
        clearSentDraftsWhenNoWork(draftState);
        renderDrafts();
        comp.sync();
      }
      if (!text) return true;
      const res = await attempt(() => api.channelSend(c.id, text, mentionIds(c, text)));
      if (res) {
        draftState.messageText = "";
        keeper.toBottom();
      }
      return !!res;
    } finally {
      draftState.sending = false;
      clearSentDraftsWhenNoWork(draftState);
      releaseRecipientAfterDefiniteFailure(draftState);
      renderDrafts();
      discardEmptyChannelDraftState(attachmentDraftsByChannel, chId, draftState);
    }
  };
  const completerHolder = { onKey: () => false };
  const { input: fileInput, button: fileBtn } = createFilePicker((files) => addFiles(files));
  const draftBox = h("div.draft-attachments", { hidden: true });
  const draftList = h("div.draft-list");
  const draftState = getChannelDraftState(attachmentDraftsByChannel, chId);
  const scrollToBottom = () => keeper.toBottom();
  draftState.scrollers.add(scrollToBottom);
  const drafts = draftState.drafts;
  const cAtCreation = getC();
  const ps = cAtCreation ? peers(cAtCreation) : [];
  const recipientSelect = cAtCreation?.kind === "group"
    ? createDraftRecipientSelect(ps, (m) => `${m.name || m.id.slice(0, 8)} (${shortFp(m.fingerprint)})`)
    : null;
  const refreshRecipientOptions = () => refreshDraftRecipientOptions(
    recipientSelect,
    draftState,
    peers(getC()),
    (m) => `${m.name || m.id.slice(0, 8)} (${shortFp(m.fingerprint)})`,
  );
  if (recipientSelect) {
    recipientSelect.value = draftState.recipient ?? "";
    recipientSelect.addEventListener("change", () => {
      if (draftState.recipientLocked) {
        recipientSelect.value = draftState.recipient ?? "";
        return;
      }
      selectDraftRecipient(draftState, recipientSelect.value || null, () => crypto.randomUUID());
    });
  }
  const drawDrafts = () => {
    draftBox.hidden = drafts.length === 0;
    if (recipientSelect) recipientSelect.disabled = draftState.recipientLocked;
    const nodes = drafts.map((d) => h("div.draft-attachment", null,
      icon("file", 16),
      h("span.draft-name", { title: d.file.name }, d.file.name),
      h("span.draft-state", { role: "status", "aria-live": "polite", title: d.error || "" }, d.status === "uploading" ? `Uploading ${d.progress ?? 0}%` : d.status === "queued" ? "Waiting to upload" : d.status === "failed" ? (d.outcomeUnknown ? "Outcome unknown · Retry same recipient" : "Failed · Send to retry") : d.status === "sent" ? (d.transfer?.state === "awaiting_approval" ? "Waiting for approval" : "Offered") : "Ready to send"),
      createDraftRemoveButton(d, () => { if (!removeDraft(draftState, d)) return; renderDrafts(); comp.sync(); }),
    ));
    draftList.replaceChildren(...nodes);
    if (recipientSelect) recipientSelect.hidden = drafts.length === 0;
    if (recipientSelect && recipientSelect.parentElement !== draftBox) draftBox.append(recipientSelect);
    if (draftList.parentElement !== draftBox) draftBox.prepend(draftList);
  };
  const renderDrafts = () => {
    for (const render of draftState.renderers) render();
  };
  const comp = composer({
    placeholder: "Write as yourself…",
    label: "Message as yourself",
    hint: ["You write here as a person; your Spencer answers on its own. ", h("kbd", null, "@"), " mentions. ", SEND_HINT()],
    left: fileBtn,
    drafts: draftBox,
    canSend: () => drafts.some((draft) => draft.status !== "sent"),
    initialText: draftState.messageText,
    onTextChange: (value) => {
      draftState.messageText = value;
      if (!value.trim()) return stopTyping();
      if (Date.now() - typingLast >= 3000) { api.typing(chId, true); typingLast = Date.now(); typingActive = true; }
      clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 5000);
    },
    isBusy: () => draftState.sending,
    onKey: (e) => completerHolder.onKey(e),
    onSend: send,
  });
  const renderDraftsForView = () => {
    if (!draftState.sending && document.activeElement !== comp.input && comp.input.value !== draftState.messageText) comp.input.value = draftState.messageText;
    refreshRecipientOptions();
    drawDrafts();
    comp.sync();
  };
  draftState.renderers.add(renderDraftsForView);
  renderDrafts();
  const addDroppedFiles = (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const items = Array.from(e.dataTransfer.items ?? []);
    let folderDropped = false;
    const files = [];
    if (items.length) {
      for (const item of items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) { folderDropped = true; continue; }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    } else files.push(...Array.from(e.dataTransfer.files ?? []));
    if (folderDropped) toast("Folders can’t be attached; drop regular files instead");
    addFiles(files);
  };
  const addFiles = (files) => {
    let total = drafts.reduce((n, d) => n + d.file.size, 0);
    for (const file of files) {
      const error = draftFileError(file, MAX_FILE_BYTES);
      if (error) { toast(error); continue; }
      if (hasDraftFile(drafts, file)) continue;
      if (drafts.length >= MAX_DRAFT_FILES || total + file.size > MAX_DRAFT_BYTES) { toast("The composer allows up to 10 files and 50 MiB at a time"); break; }
      drafts.push({ file, uploadId: crypto.randomUUID(), status: "draft", progress: 0, error: "" });
      total += file.size;
    }
    renderDrafts();
    comp.sync();
  };
  comp.form.append(fileInput);
  comp.form.addEventListener("dragover", (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    comp.form.classList.add("file-drop-target");
  });
  comp.form.addEventListener("dragleave", (e) => {
    if (!comp.form.contains(e.relatedTarget)) comp.form.classList.remove("file-drop-target");
  });
  comp.form.addEventListener("drop", (e) => {
    comp.form.classList.remove("file-drop-target");
    addDroppedFiles(e);
  });
  const completer = mentionCompleter(comp.input, getC, (value) => { draftState.messageText = value; });
  completerHolder.onKey = completer.onKey;
  comp.input.setAttribute("aria-autocomplete", "list");
  comp.form.prepend(completer.el);

  const typingBar = h("div.typing-bar", { role: "status" });
  const renderTyping = () => {
    const ids = typingIn(chId);
    const names = ids.map(id => getC()?.members.find(m => m.id === id)?.name || "Someone");
    typingBar.textContent = ids.length === 1 ? `${names[0]} is typing…` : ids.length === 2 ? `${names[0]} and ${names[1]} are typing…` : ids.length ? `${ids.length} people are typing…` : "";
    renderMembers();
  };
  comp.input.addEventListener("blur", stopTyping);
  comp.form.prepend(typingBar);
  main.append(header, st.el, comp.form, members);

  const setMembersOpen = (open, remember = true) => {
    membersOpen = open;
    main.classList.toggle("members-open", open);
    if (remember && wide()) {
      try {
        localStorage.setItem(MEMBERS_KEY, open ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
    }
    renderHeader();
    if (open && !wide()) members.querySelector("button")?.focus();
  };

  const renderMembers = () => {
    const c = getC();
    if (!c) return;
    const tools = c.allowedMcpTools ?? [];
    const full = c.trust === "full";
    members.replaceChildren(...[
      h("div.members-head", null, h("h2", null, c.kind === "group" ? "In this group" : "In this channel"), iconButton("close", "Close members", () => setMembersOpen(false), "members-close")),
      h("ul.member-list", null, c.members.map((m) => memberRow(c, m))),
      c.mode === "conversation" ? null : c.kind === "direct" ? peerBioSnippet(c) : groupMemoirSnippet(c),
      isConversation(c) ? conversationSection(c) : null,
      followupList(c.id, { title: "Your Spencer will follow up" }),
      h(
        "section.access",
        { "aria-label": "Access" },
        h("h2", null, "What peers here can do"),
        h(
          `div.access-row${full ? ".full" : ""}`,
          null,
          icon("shield", 15),
          h("div", null, h("strong", null, full ? "Full trust" : "Standard"), h("p", null, full ? "They can use every MCP tool and get files without your approval." : "Your Spencer asks you before doing tasks or sending files.")),
        ),
        full
          ? null
          : h(
              "div.access-row",
              null,
              icon("plug", 15),
              h(
                "div",
                null,
                h("strong", null, tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"} without asking` : "No tools without asking"),
                tools.length ? h("ul.access-tools", null, tools.map((t) => h("li", null, h("code", null, t.replace(/^mcp__/, "").replace(/__/, " · "))))) : null,
              ),
            ),
        h("div.access-row", null, icon("reply", 15), h("div", null, h("strong", null, c.autoReply ? "Auto-reply on" : "Auto-reply off"), h("p", null, c.autoReply ? (isConversation(c) ? "Your Spencer talks on its own, and answers anyone who writes here." : c.kind === "group" ? "Your Spencer answers when mentioned." : "Your Spencer answers on its own.") : "Your Spencer only listens."))),
        h("button.btn.sm", { type: "button", on: { click: () => settingsModal(c) } }, icon("gear", 14), "Channel settings"),
      ),
    ].filter(Boolean));
  };

  const renderHeader = () => {
    const c = getC();
    if (!c) return;
    const title = channelTitle(c);
    const p = peers(c)[0];
    const working = workingIn(chId);
    let av;
    let status;
    if (c.kind === "group") {
      av = mark(h("span.avatar.agent.group", { "aria-hidden": "true" }, icon("users", 16)), working.length ? { state: "working", text: "working" } : null);
      const others = peers(c);
      const known = others.filter((m) => presenceOf(m).known);
      const online = known.filter((m) => presenceOf(m).online).length;
      status = `${c.members.length} member${c.members.length === 1 ? "" : "s"}${known.length ? `, ${online} online` : ""}`;
    } else if (!p) {
      av = mark(h("span.avatar.agent.pending", { "aria-hidden": "true" }, icon("link", 15)), null);
      status = "Waiting for them to use the invite";
    } else {
      const info = presenceInfo(p, chId);
      av = mark(avatar(title, p.id), info);
      status = info ? info.text.replace(/^./, (x) => x.toUpperCase()) : c.name && c.name !== title ? c.name : "Direct";
    }
    const membersBtn = h(
      `button.icon-btn.members-btn${membersOpen ? ".on" : ""}`,
      { type: "button", "aria-label": membersOpen ? "Hide members" : "Show members", title: "Members and access", "aria-pressed": String(membersOpen), on: { click: () => setMembersOpen(!membersOpen) } },
      icon("users", 18),
    );
    header.replaceChildren(
      viewHeader(
        [
          av,
          h(
            "div.title-stack",
            null,
            h("h1", null, title),
            h(
              "span.subtitle",
              null,
              h("span", null, status),
              isConversation(c) ? h("span.pill", { title: "The Spencers here start conversations on their own" }, icon("spark", 11), "conversations") : null,
              isConversation(c) && c.heated ? h("span.pill", { title: "Heated mode: your Spencer starts real arguments, with a moderator" }, "heated") : null,
              c.trust === "full" ? h("span.pill.attn", { title: "Peers here can use your Spencer's MCP tools without approval" }, icon("shield", 11), "full trust") : null,
              c.autoReply ? null : h("span.pill.muted", null, "auto-reply off"),
            ),
          ),
        ],
        [iconButton("paperclip", "Send file", () => sendFileModal(c), "hide-narrow"), membersBtn, iconButton("gear", "Channel settings", () => settingsModal(c))],
      ),
    );
  };

  const renderTimeline = () => {
    const c = getC();
    if (!c) return;
    keeper.before();
    const msgs = S.messages.get(chId);
    if (!msgs) {
      timeline.replaceChildren(skeleton(5));
      keeper.after();
      return;
    }
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const names = [S.me?.name, ...c.members.map((m) => m.name)].filter(Boolean);
    const myNames = [S.me?.name, ...c.members.filter((m) => m.me).map((m) => m.name)].filter(Boolean);
    const historyExpanded = historyExpansionPending;
    historyExpansionPending = false;
    const items = timelineItems(msgs, [...S.transfers.values()].filter((t) => t.ch === chId), messagesLoaded && !hasOlder, historyExpanded);
    const nodes = [];
    if (!items.length) {
      nodes.push(
        !peers(c).length
          ? emptyState({ icon: "link", title: "Waiting for them to join", text: "Send your invite link privately. Once their Spencer connects, it says hello here and you can start talking." })
          : emptyState({ icon: "send", title: "Nothing said yet", text: "Write a message yourself, or ask your Spencer to talk here for you." }),
      );
    } else if (!peers(c).length) {
      nodes.push(h("div.callout.info", null, icon("link", 16), h("span", null, "Nobody has joined yet. Send your invite link privately; messages show up here once they connect.")));
    }
    let lastDay = "";
    let prev = null; // previous timeline item
    for (const it of items) {
      const day = new Date(it.ts).toDateString();
      if (day !== lastDay) {
        nodes.push(h("div.day-sep", null, h("span", null, new Date(it.ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))));
        lastDay = day;
        prev = null;
      }
      if (it.t) nodes.push(h("div.xfer-inline", null, transferCard(it.t)));
      else if (it.m.type !== "chat") nodes.push(systemLine(c, it.m));
      else {
        const m = it.m;
        const pm = prev?.m?.type === "chat" ? prev.m : null;
        const sameSpeaker = pm && pm.from === m.from && (pm.by ?? "") === (m.by ?? "") && m.ts - pm.ts < GROUP_MS;
        const repliesToPrev = pm && m.replyTo === pm.id;
        nodes.push(messageRow(c, m, byId, names, myNames, !!sameSpeaker && (!m.replyTo || repliesToPrev), !!repliesToPrev, c.kind === "group" && suppressQuietNotice(pm, m)));
      }
      prev = it;
    }
    timeline.replaceChildren(...nodes);
    olderBtn.hidden = !hasOlder;
    keeper.after();
  };

  const load = async () => {
    const r = await attempt(() => api.channelMessages(chId, 100));
    if (!r) {
      if (!S.messages.get(chId)) {
        const retry = h("button.btn", { type: "button", on: { click: () => (timeline.replaceChildren(skeleton(5)), load()) } }, "Try again");
        timeline.replaceChildren(emptyState({ icon: "offline", title: "Couldn't load this conversation", text: "Spencer did not answer. Check that the daemon is running.", actions: [retry] }));
      }
      return;
    }
    const items = r.items ?? [];
    hasOlder = items.length >= 100;
    messagesLoaded = true;
    setMessages(chId, items);
    requestAnimationFrame(() => keeper.toBottom());
  };

  olderBtn.addEventListener("click", async () => {
    const msgs = S.messages.get(chId) ?? [];
    const first = msgs[0];
    if (!first) return;
    olderBtn.disabled = true;
    const r = await attempt(() => api.channelMessages(chId, 100, first.id));
    olderBtn.disabled = false;
    if (!r) return;
    const current = S.messages.get(chId) ?? [];
    if (current[0]?.id !== first.id) return; // response cursor belongs to a window that moved while it was in flight
    const currentIds = new Set(current.map((m) => m.id));
    const older = (r.items ?? []).filter((m) => !currentIds.has(m.id));
    hasOlder = (r.items ?? []).length >= 100;
    const prevH = scroller.scrollHeight;
    historyExpansionPending = older.length > 0;
    setMessages(chId, [...older, ...current]);
    scroller.scrollTop = scroller.scrollHeight - prevH;
  });

  const onChannel = () => {
    if (!getC()) return; // removed: the router moves away
    renderHeader();
    renderMembers();
    renderTimeline();
    refreshRecipientOptions();
  };
  let seen = S.messages.get(chId)?.length ?? 0;
  const onMessages = () => {
    renderTimeline();
    const n = S.messages.get(chId)?.length ?? 0;
    if (seen && n > seen) st.note();
    seen = n;
    markRead(chId);
  };
  const onVisible = () => document.visibilityState === "visible" && markRead(chId);
  const onKey = (e) => {
    if (e.key === "Escape" && membersOpen && !wide() && !document.querySelector("#modal-root .overlay")) setMembersOpen(false, false);
  };
  const onResize = () => {
    // Crossing the breakpoint: docked panels follow the saved preference, sheets start closed.
    const want = wide() && membersPref();
    if (want !== membersOpen) setMembersOpen(want, false);
  };
  const mq = matchMedia("(min-width: 1180px)");

  main.classList.toggle("members-open", membersOpen);
  renderHeader();
  renderMembers();
  renderTimeline();
  markRead(chId);
  load();
  requestAnimationFrame(() => comp.input.focus());

  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("keydown", onKey);
  mq.addEventListener("change", onResize);
  const onTransfer = (t) => {
    if (t && t.ch !== chId) return;
    // Progress ticks: swap just that card so the transcript (and any text selection) stays put.
    const existing = t && timeline.querySelector(`.xfer-card[data-tid="${CSS.escape(t.tid)}"]`);
    if (existing) existing.replaceWith(transferCard(t));
    else renderTimeline();
  };
  // The live trace of every Spencer working on a reply here, mine included.
  const renderWorking = () => {
    const c = getC();
    if (!c) return;
    keeper.before();
    const msgs = S.messages.get(chId) ?? [];
    const rows = workingIn(chId).map((w) => {
      const mine = w.from === S.me?.id;
      const mem = c.members.find((m) => m.id === w.from);
      const name = mine ? (S.me?.name ?? "Your Spencer") : (mem?.name ?? "A Spencer");
      const target = msgs.find((m) => m.id === w.replyTo);
      const context = target
        ? h("button.trace-ref", { type: "button", title: "Go to the message being answered", on: { click: () => jumpTo(target.id) } }, icon("reply", 12), h("span", null, `answering ${speaker(c, target).name}`))
        : null;
      return trace({ key: `${chId} ${w.from}`, avatar: mine ? selfAvatar() : avatar(name, w.from), name, activity: w.activity, steps: w.steps, since: w.since, context });
    });
    workingBox.replaceChildren(...rows);
    keeper.after();
    renderHeader();
    renderMembers();
  };
  renderWorking();
  const typingExpiry = setInterval(renderTyping, 1000);
  const staleTimer = setInterval(() => {
    renderMembers(); // "seen 5m ago" ages
    if (workingIn(chId).length) renderWorking();
  }, 15_000);
  attempt(() => api.peers()).then(result => {
    if (!result || !main.isConnected) return;
    for (const p of result.peers) for (const ch of p.channels) {
      if (!S.peerBios.has(ch.id)) S.peerBios.set(ch.id, new Map());
      if (!S.peerBios.get(ch.id).has(p.id) || (ch.aboutAt ?? 0) > (S.peerBios.get(ch.id).get(p.id).aboutAt ?? 0)) S.peerBios.get(ch.id).set(p.id, ch);
    }
    renderMembers();
  });
  const offs = [
    on("memoir", () => renderMembers()),
    on("peer_bio", ev => { if (ev.ch === chId) renderMembers(); }),
    on(`channel:${chId}`, onChannel),
    on(`messages:${chId}`, onMessages),
    on("transfers", onTransfer),
    on(`working:${chId}`, renderWorking),
    on(`typing:${chId}`, renderTyping),
    on("followups", renderMembers),
    on(`conversation:${chId}`, renderMembers),
  ];
  if (isConversation(getC())) {
    api
      .conversation(chId)
      .then(setConversation)
      .catch(() => {});
  }
  return {
    destroy: () => {
      stopTyping();
      clearInterval(typingExpiry);
      clearInterval(staleTimer);
      draftState.renderers.delete(renderDraftsForView);
      draftState.scrollers.delete(scrollToBottom);
      comp.destroy();
      discardEmptyChannelDraftState(attachmentDraftsByChannel, chId, draftState);
      offs.forEach((f) => f());
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onResize);
      main.classList.remove("members-open");
    },
  };
}
