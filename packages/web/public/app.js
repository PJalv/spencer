import { unseenMemoirCount } from "./memoir.js";
// Spencer local UI: entry point. Sidebar, routing, keyboard shortcuts, and the events stream.
import { h, icon, shortFp, avatar, selfAvatar, clear, append } from "./dom.js";
import { api, attempt, toast, connectEvents } from "./api.js";
import {
  S,
  on,
  setState,
  upsertChannel,
  removeChannel,
  upsertMessage,
  maxMessageSequence,
  upsertTransfer,
  upsertOwner,
  upsertRequest,
  upsertFollowup,
  setConversation,
  setWorking,
  clearWorkingFor,
  setOwner,
  setOwnerBusy,
  setMessages,
  unreadCount,
  actionCount,
  attentionCount,
  needsAction,
  peers,
  channelTitle,
  applyPresence,
  setModel,
  channelStatus,
  relaysDown,
  emit,
  setExperimental,
} from "./state.js";
import { parseHash, hashFor, navigate } from "./router.js";
import { setSidebarOpen, syncAttention, presenceInfo, mark, activityLine, skeleton } from "./common.js";
import { ownerView } from "./owner.js";
import { channelView } from "./channel.js";
import { loadMessageWindow } from "./message-window.js";
import { transfersView } from "./transfers.js";
import { mcpView } from "./mcp.js";
import { bioView } from "./bio.js";
import { peersView } from "./peers.js";
import { applyBioEvent } from "./state.js";
import { soulView } from "./soul.js";
import { modelView, modelName } from "./model.js";
import { inboxView } from "./inbox.js";
import { inviteModal, joinModal } from "./invites.js";
import { openSwitcher, shortcutsModal } from "./switcher.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");

// ---------------------------------------------------------------- sidebar

function navItem(view, content, opts = {}) {
  const active = hashFor(view) === hashFor(S.view);
  return h(
    `a.nav-item${active ? ".active" : ""}${opts.cls ? "." + opts.cls : ""}`,
    { href: hashFor(view), "aria-current": active ? "page" : undefined, title: opts.title },
    content,
  );
}

function badge(n, label, cls = "") {
  return n > 0 ? h(`span.badge-count${cls ? "." + cls : ""}`, { "aria-label": `${n} ${label}` }, n > 99 ? "99+" : String(n)) : null;
}

/** What the daemon connection looks like, in words. */
function linkStatus() {
  if (!S.wsUp) return { state: "down", text: "Reconnecting", title: "Not connected to the Spencer daemon on this computer" };
  const down = relaysDown();
  if (S.relay?.connected && !down.length) return { state: "up", text: "Connected", title: `Relay connected: ${S.relay.url}` };
  const urls = down.length ? down.map((r) => r.url).join(", ") : (S.relay?.url ?? "");
  const r = down[0];
  const why = r?.lastError ? ` Last error: ${r.lastError}.` : "";
  if (r?.state === "connecting") return { state: "down", text: "Connecting to relay", title: `Connecting to ${urls}. Messages are queued.${why}` };
  if (r?.state === "waiting" && Number.isFinite(r.retryAt)) {
    const s = Math.max(0, Math.round((r.retryAt - Date.now()) / 1000));
    return { state: "down", text: s > 1 ? `Relay offline · retry in ${s}s` : "Relay offline · retrying", title: `Relay disconnected: ${urls}. Messages are queued until it is back.${why}` };
  }
  return { state: "down", text: "Relay offline", title: `Relay disconnected: ${urls}. Messages are queued until it is back.${why}` };
}

let unseenMemoir = 0, memoirSeq = 0, memoirTimer;
function refreshMemoirBadge() {
  const seq = ++memoirSeq;
  clearTimeout(memoirTimer);
  memoirTimer = setTimeout(async () => {
    const result = await attempt(() => api.peers());
    if(result && seq === memoirSeq) { unseenMemoir = unseenMemoirCount(result.peers); renderSidebar(); }
  },150);
}
refreshMemoirBadge();
function renderSidebar() {
  const me = S.me;
  const link = linkStatus();
  const channels = [...S.channels.values()].sort((a, b) => a.createdAt - b.createdAt);
  const direct = channels.filter((c) => c.kind === "direct");
  const groups = channels.filter((c) => c.kind === "group");
  const nameOf = (c, id) => (id === S.me?.id ? "Yours" : (c.members.find((m) => m.id === id)?.name ?? "A Spencer"));

  // One roster row: the avatar carries the state, and one line says what is going on and what you owe.
  const channelItem = (c) => {
    const title = channelTitle(c);
    const n = unreadCount(c.id);
    const p = peers(c)[0];
    const status = channelStatus(c);
    const active = status.state === "working" || status.state === "thinking";
    let text = status.text;
    let info = null;
    if (active) {
      const lead = c.kind === "group" || status.from === S.me?.id ? `${nameOf(c, status.from)}: ` : "";
      text = [lead, h("span.act.shimmer", null, activityLine(status.text))];
      info = { state: status.state, text: status.text };
    } else if (status.state === "waiting" || status.state === "blocked") {
      info = { state: status.state, text: status.text };
    } else if (c.kind === "direct" && p) {
      info = presenceInfo(p, c.id);
      text = info ? info.text.replace(/^./, (x) => x.toUpperCase()) : shortFp(p.fingerprint);
    }
    const sub = h(`span.nav-sub.s-${status.state}`, null, text);
    const av =
      c.kind === "group"
        ? h("span.avatar.agent.group.sm", { "aria-hidden": "true" }, icon("users", 13))
        : p
          ? avatar(title, p.id, "sm")
          : h("span.avatar.agent.pending.sm", { "aria-hidden": "true" }, icon("link", 12));
    return navItem(
      { name: "channel", ch: c.id },
      [
        mark(av, info),
        h("span.nav-text", null, h("span.nav-name", null, title), sub),
        status.owes ? h("span.badge-flag", { role: "img", "aria-label": "needs you" }, icon("inbox", 12)) : null,
        badge(n, "unread"),
      ],
      { cls: `${n ? "unread" : ""}${status.owes ? (n ? ".owes" : "owes") : ""}`, title: c.kind === "direct" && c.name !== title ? `${title} (${c.name})` : title },
    );
  };

  const section = (label, items, emptyText) =>
    h("section.nav-section", { "aria-label": label }, h("h2.nav-heading", null, label), items.length ? items.map(channelItem) : h("p.nav-empty", null, emptyText));

  const pending = actionCount();
  const attention = attentionCount();
  const mcpBad = S.mcp.some((s) => s.status === "error");
  const modelBad = S.model && !S.model.ready;
  const ownerSub = S.ownerBusy ? h("span.nav-sub.s-working", null, h("span.act.shimmer", null, "Working on it")) : h("span.nav-sub", null, "Your agent");

  // Rebuilding the sidebar would drop keyboard focus; remember what had it.
  const focused = sidebar.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? (focused.getAttribute("href") ?? focused.dataset.key ?? focused.textContent) : null;
  const scrollTop = sidebar.querySelector(".side-nav")?.scrollTop ?? 0;

  append(clear(sidebar), [
    h(
      "header.side-head",
      null,
      mark(selfAvatar(), S.ownerBusy ? { state: "working", text: "working" } : null),
      h(
        "div.side-id",
        null,
        h("div.side-name", null, me?.name ?? "Spencer"),
        h(
          "div.side-status",
          { title: link.title },
          h(`span.pdot.inline.${link.state === "up" ? "on" : "warn"}`, { "aria-hidden": "true" }),
          h("span", null, link.text),
          me ? h("code.side-fp", { title: `Your fingerprint ${me.fingerprint}\nid ${me.id}` }, shortFp(me.fingerprint)) : null,
        ),
      ),
      h("button.icon-btn.close-side", { type: "button", "aria-label": "Close sidebar", on: { click: () => setSidebarOpen(false) } }, icon("close", 18)),
    ),
    h("button.side-search", { type: "button", dataset: { key: "search" }, on: { click: openSwitcher } }, icon("search", 15), h("span", null, "Jump to…"), h("kbd", null, /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘K" : "Ctrl K")),
    h(
      "nav.side-nav",
      { "aria-label": "Conversations" },
      navItem({ name: "inbox" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("inbox", 16)), h("span.nav-text", null, h("span.nav-name", null, "Needs you")), badge(attention, "waiting for you", "attn")], {
        cls: attention ? "pinned.attn" : "pinned",
      }),
      navItem({ name: "owner" }, [mark(selfAvatar("sm"), S.ownerBusy ? { state: "working", text: "working" } : null), h("span.nav-text", null, h("span.nav-name", null, "Spencer"), ownerSub)], { cls: "pinned" }),
      section("Direct", direct, "No one yet. Invite someone's Spencer."),
      section("Groups", groups, "No groups yet."),
      h(
        "div.side-actions",
        null,
        h("button.btn.sm", { type: "button", dataset: { key: "invite" }, on: { click: inviteModal } }, icon("plus", 14), "Invite"),
        h("button.btn.sm", { type: "button", dataset: { key: "join" }, on: { click: joinModal } }, icon("link", 14), "Join"),
      ),
    ),
    h(
      "footer.side-foot",
      null,
      navItem({ name: "transfers" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("transfer", 16)), h("span.nav-name", null, "Transfers"), badge(pending, "need action", "attn")], { cls: "foot" }),
      navItem({ name: "mcp" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("plug", 16)), h("span.nav-name", null, "MCP servers"), mcpBad ? h("span.pdot.inline.bad", { role: "img", "aria-label": "a server has an error" }) : null], { cls: "foot" }),
      navItem({ name: "bio" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("file", 16)), h("span.nav-name", null, "Bio")], { cls: "foot" }),
      navItem({ name: "peers" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("users", 16)), h("span.nav-name", null, "Peers"), badge(unseenMemoir, "unseen memoir notes", "attn")], { cls: "foot" }),
      S.experimental ? navItem({ name: "soul" }, [h("span.nav-glyph", { "aria-hidden": "true" }, icon("heart", 16)), h("span.nav-name", null, "Soul")], { cls: "foot" }) : null,
      navItem(
        { name: "model" },
        [
          h("span.nav-glyph", { "aria-hidden": "true" }, icon("gear", 16)),
          h("span.nav-text", null, h("span.nav-name", null, "Model & settings"), S.model ? h("span.nav-sub", null, modelName(S.model) ?? "Not configured") : null),
          modelBad ? h("span.pdot.inline.bad", { role: "img", "aria-label": "no model is ready" }) : null,
        ],
        { cls: "foot" },
      ),
      h("button.nav-item.foot", { type: "button", dataset: { key: "keys" }, on: { click: shortcutsModal } }, h("span.nav-glyph", { "aria-hidden": "true" }, icon("keyboard", 16)), h("span.nav-name", null, "Shortcuts"), h("kbd", null, "?")),
    ),
  ]);
  const nav = sidebar.querySelector(".side-nav");
  if (nav) nav.scrollTop = scrollTop;
  if (focusKey) {
    const again = [...sidebar.querySelectorAll("a, button")].find((el) => (el.getAttribute("href") ?? el.dataset.key ?? el.textContent) === focusKey);
    again?.focus();
  }
  syncAttention();
  document.getElementById("conn").hidden = S.wsUp || !everConnected;
}

let everConnected = false;
let sidebarQueued = false;
/** Coalesce bursts of events (status ticks, presence) into one sidebar render per frame. */
function queueSidebar() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => {
    sidebarQueued = false;
    renderSidebar();
  });
}

// ---------------------------------------------------------------- routing

let current = null;
let mountedKey = "";

function mount() {
  const view = S.view;
  const key = hashFor(view);
  if (view.name === "channel" && !S.channels.has(view.ch)) {
    if (S.loaded) {
      navigate({ name: "owner" });
      return;
    }
    current?.destroy?.();
    current = null;
    mountedKey = "";
    clear(main).append(skeleton(5));
    return;
  }
  // The soul page needs experimental features; until the state arrives we do not know yet.
  if (view.name === "soul" && !S.experimental) {
    if (S.loaded) {
      navigate({ name: "owner" });
      return;
    }
    current?.destroy?.();
    current = null;
    mountedKey = "";
    clear(main).append(skeleton(5));
    return;
  }
  if (key === mountedKey && current) return;
  current?.destroy?.();
  clear(main);
  main.className = `main view-${view.name}`;
  mountedKey = key;
  if (view.name === "channel") current = channelView(main, view.ch);
  else if (view.name === "transfers") current = transfersView(main);
  else if (view.name === "mcp") current = mcpView(main);
  else if (view.name === "bio") current = bioView(main);
  else if (view.name === "peers") current = peersView(main);
  else if (view.name === "soul") current = soulView(main);
  else if (view.name === "model") current = modelView(main);
  else if (view.name === "inbox") current = inboxView(main);
  else current = ownerView(main);
}

function onRoute() {
  S.view = parseHash();
  setSidebarOpen(false);
  mount();
  renderSidebar();
  syncTitle();
}

const PAGE_TITLES = { bio: "Bio", peers: "Peers", model: "Model", mcp: "MCP servers", soul: "Soul", transfers: "Transfers", inbox: "Needs you" };
const timelineRefreshGeneration = new Map();

function syncTitle() {
  const c = S.view.name === "channel" ? S.channels.get(S.view.ch) : null;
  const page = c ? channelTitle(c) : PAGE_TITLES[S.view.name];
  const n = attentionCount();
  document.title = `${n ? `(${n}) ` : ""}${page ? `${page} · ` : ""}Spencer`;
}

// ---------------------------------------------------------------- events

function handleEvent(ev) {
  switch (ev.type) {
    case "memoir": emit("memoir", ev); refreshMemoirBadge(); break;
    case "bio":
    case "peer_bio": applyBioEvent(ev); refreshMemoirBadge(); break;
    case "channel":
      if (ev.channel?.id) upsertChannel(ev.channel);
      break;
    case "channel_removed":
      removeChannel(ev.ch);
      if (S.view.name === "channel" && S.view.ch === ev.ch) {
        toast("This channel was removed", "info");
        navigate({ name: "owner" });
      }
      break;
    case "message":
      if (ev.ch && ev.message?.id) {
        const current = S.messages.get(ev.ch) ?? [];
        const previous = current.find((m) => m.id === ev.message.id);
        const maxSeq = maxMessageSequence(current);
        const acknowledged = previous && Number.isSafeInteger(ev.message.seq) && previous.seq !== ev.message.seq;
        const outOfOrderReplay = !previous && Number.isSafeInteger(ev.message.seq) && ev.message.seq < maxSeq;
        upsertMessage(ev.ch, ev.message);
        if (acknowledged || outOfOrderReplay) void refreshLoadedMessageWindow(ev.ch);
        // The reply landed: whoever was "working" on it is done.
        if (ev.message.type === "chat" && ev.message.replyTo) clearWorkingFor(ev.ch, ev.message.from, ev.message.replyTo);
      }
      break;
    case "status":
      if (ev.ch && ev.from && ev.replyTo) setWorking(ev);
      break;
    case "transfer": {
      const t = ev.transfer;
      if (!t?.tid) break;
      const prev = S.transfers.get(t.tid);
      upsertTransfer(t);
      if (needsAction(t) && t.initiatedBy !== "owner" && (!prev || prev.state !== t.state) && S.view.name !== "transfers") {
        const who = t.peerName ?? "A peer";
        if (S.view.name !== "inbox")
          toast(t.direction === "in" ? `${who} wants to send you ${t.name}` : `${t.name} needs your approval to send`, "attn", { action: { label: "Review", onClick: () => navigate({ name: "inbox" }) } });
      }
      break;
    }
    case "owner":
      if (ev.item?.id) upsertOwner(ev.item);
      break;
    case "request": {
      const r = ev.request;
      if (!r?.id) break;
      const prev = S.requests.get(r.id);
      upsertRequest(r);
      if (!prev && r.state === "pending" && S.view.name !== "owner" && S.view.name !== "inbox")
        toast(r.kind === "continue" ? `Your Spencer paused its conversation in ${r.channelName ?? "a channel"}` : `${r.fromName ?? "A peer's Spencer"} asks for your approval`, "attn", { action: { label: "Review", onClick: () => navigate({ name: "inbox" }) } });
      break;
    }
    case "owner_busy":
      setOwnerBusy(ev.busy);
      break;
    case "presence":
      applyPresence(ev);
      break;
    case "followup":
      if (ev.followup?.id) upsertFollowup(ev.followup);
      break;
    case "conversation":
      if (ev.conversation?.ch) setConversation(ev.conversation);
      break;
    case "relay": {
      // {type:"relay", ...RelayStatus}: one relay's connection changed; "connected" overall means all are.
      const { type: _t, ...rs } = ev;
      if (ev.url) S.relays = S.relays.some((r) => r.url === ev.url) ? S.relays.map((r) => (r.url === ev.url ? { ...r, ...rs } : r)) : [...S.relays, rs];
      S.relay = { url: S.relay.url || ev.url || "", connected: S.relays.length ? S.relays.every((r) => r.connected) : !!ev.connected };
      emit("relay");
      break;
    }
    case "mcp":
      if (Array.isArray(ev.servers)) {
        S.mcp = ev.servers;
        emit("mcp");
      }
      break;
    case "model":
      if (ev.model?.copilot) setModel(ev.model);
      break;
    case "experimental":
      setExperimental(ev.enabled);
      break;
    default:
      break;
  }
}

function refreshLoadedMessageWindow(ch) {
  const generation = (timelineRefreshGeneration.get(ch) ?? 0) + 1;
  timelineRefreshGeneration.set(ch, generation);
  const required = new Set((S.messages.get(ch) ?? []).map((m) => m.id));
  if (!required.size) return;

  void loadMessageWindow(
    (before) => api.channelMessages(ch, 100, before, false),
    required,
    () => (S.messages.get(ch) ?? []).map((m) => m.id),
  ).then((loaded) => {
    if (!loaded || timelineRefreshGeneration.get(ch) !== generation) return;
    const loadedIds = new Set(loaded.map((m) => m.id));
    if ((S.messages.get(ch) ?? []).some((m) => !loadedIds.has(m.id))) {
      refreshLoadedMessageWindow(ch);
      return;
    }
    setMessages(ch, loaded);
  }).catch((err) => console.warn(`could not refresh ordering for ${ch}`, err));
}

async function refresh(full) {
  const st = await attempt(() => api.state());
  if (st) {
    setState(st);
    mount();
  }
  if (!full) return;
  // Events may have been missed while disconnected: drop cached transcripts, reload the visible one.
  const viewing = S.view.name === "channel" ? S.view.ch : null;
  for (const ch of [...S.messages.keys()]) if (ch !== viewing) S.messages.delete(ch);
  if (viewing && S.channels.has(viewing)) {
    const r = await attempt(() => api.channelMessages(viewing, 100));
    if (r) setMessages(viewing, r.items ?? []);
  }
  if (S.owner) {
    const r = await attempt(() => api.ownerMessages(200));
    if (r) setOwner(r.items ?? []);
  }
}

// ---------------------------------------------------------------- boot

for (const t of ["channels", "transfers", "relay", "mcp", "model", "working", "busy", "requests"]) on(t, queueSidebar);
for (const t of ["transfers", "requests"]) on(t, syncTitle);

// ---------------------------------------------------------------- keyboard

const typing = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Alt+↑/↓: the previous/next destination in sidebar order. */
function step(delta) {
  const items = [...sidebar.querySelectorAll("a.nav-item")];
  if (!items.length) return;
  const i = items.findIndex((el) => el.classList.contains("active"));
  const next = items[(Math.max(i, 0) + delta + items.length) % items.length];
  location.hash = next.getAttribute("href");
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  const modalOpen = !!document.querySelector("#modal-root .overlay");
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSwitcher();
    return;
  }
  if (modalOpen) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    step(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
  if (e.key === "/") {
    const input = document.querySelector(".composer-input");
    if (input) {
      e.preventDefault();
      input.focus();
    }
  } else if (e.key === "?") {
    e.preventDefault();
    shortcutsModal();
  }
});
document.getElementById("backdrop")?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("app")?.classList.contains("sidebar-open")) setSidebarOpen(false);
});
window.addEventListener("hashchange", onRoute);

S.view = parseHash();
renderSidebar();
mount();
refresh(false);
connectEvents({
  onEvent: handleEvent,
  onOpen: (isReconnect) => { refreshMemoirBadge(); return refresh(isReconnect); },
  onStatus: (up) => {
    S.wsUp = up;
    if (up) everConnected = true;
    renderSidebar();
  },
});
setTimeout(() => {
  if (!S.wsUp) {
    everConnected = true;
    renderSidebar();
  }
}, 2500);

// Experimental features turned on or off: the soul page and Conversations channels appear or go away.
on("experimental", () => {
  if (S.view.name === "soul" && !S.experimental) navigate({ name: "owner" });
  else if (S.view.name === "channel" || S.view.name === "soul") {
    mountedKey = "";
    mount();
  }
});

let directNoticeSeen = false;
on("direct_transfer", () => {
  try { directNoticeSeen ||= !!localStorage.getItem("spencer.seenDirectTransfer"); } catch {}
  if (directNoticeSeen) return;
  directNoticeSeen = true;
  try { localStorage.setItem("spencer.seenDirectTransfer", "1"); } catch {}
  toast("Sent directly", "info");
});
