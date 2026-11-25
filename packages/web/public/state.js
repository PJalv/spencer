// In-memory UI state plus a tiny pub/sub. Views subscribe to topics and re-render their part.

export const TERMINAL = new Set(["completed", "denied", "declined", "failed", "expired", "cancelled"]);

export const S = {
  bio: null,
  peerBios: new Map(), // channel id -> Map(peer id -> latest received bio)
  version: "",
  me: null, // {id, name, fingerprint}
  relay: { url: "", connected: false },
  relays: [], // {url, connected}[] when the daemon reports each relay in use
  p2p: null,
  policy: {},
  experimental: false, // experimental features on (SOUL.md, Conversations channels)
  channels: new Map(), // id -> Channel
  transfers: new Map(), // tid -> Transfer
  mcp: [], // McpServerStatus[]
  model: null, // ModelStatus: the model Spencer thinks with and the Copilot sign-in
  requests: new Map(), // id -> OwnerRequest (ask_owner approvals and "continue?" cards)
  followups: new Map(), // id -> Followup (reminders the agents scheduled on themselves)
  conversations: new Map(), // ch -> ConversationStatus (Conversations channels: my timer and the debate going on)
  typing: new Map(),
  working: new Map(), // ch -> Map(memberId -> {replyTo, activity, steps, since, ts}): a Spencer is working on a reply
  messages: new Map(), // ch -> ChannelMessage[] (only for channels that were opened)
  owner: null, // OwnerItem[] once loaded
  ownerBusy: false,
  ownerBusySince: 0,
  wsUp: false,
  loaded: false,
  view: { name: "owner" }, // {name:"owner"} | {name:"channel", ch} | {name:"transfers"} | {name:"mcp"} | {name:"model"}
  /** Server unread count already "seen" per channel (persisted), and locally counted unread. */
  ack: loadAck(),
  local: {},
};

const listeners = new Map(); // topic -> Set<fn>

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, detail) {
  for (const fn of listeners.get(topic) ?? []) {
    try {
      fn(detail);
    } catch (err) {
      console.error(`listener for ${topic} failed`, err);
    }
  }
}

// ---------------------------------------------------------------- unread

function loadAck() {
  try {
    return JSON.parse(localStorage.getItem("spencer.ack") ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function saveAck() {
  try {
    localStorage.setItem("spencer.ack", JSON.stringify(S.ack));
  } catch {
    /* storage unavailable: badges just reset on reload */
  }
}

/**
 * Badge count: the server's unread count minus what we already saw while the channel was open,
 * or the locally counted messages, whichever is larger (the daemon may or may not bump `unread`
 * for each message, and there is no "mark read" endpoint).
 */
export function unreadCount(ch) {
  const c = S.channels.get(ch);
  if (!c) return 0;
  const server = Math.max(0, (c.unread ?? 0) - (S.ack[ch] ?? 0));
  return Math.max(server, S.local[ch] ?? 0);
}

export function markRead(ch) {
  const c = S.channels.get(ch);
  if (!c) return;
  const before = unreadCount(ch);
  S.ack[ch] = c.unread ?? 0;
  S.local[ch] = 0;
  saveAck();
  if (before) emit("channels");
}

export function isViewing(ch) {
  return S.view.name === "channel" && S.view.ch === ch && document.visibilityState !== "hidden";
}

// ---------------------------------------------------------------- mutations

export function setState(st) {
  if (typeof st.version === "string") S.version = st.version;
  S.me = st.me ?? S.me;
  S.relay = st.relay ?? S.relay;
  S.relays = Array.isArray(st.relays) ? st.relays : [];
  if (typeof st.ownerBusy === "boolean") setOwnerBusy(st.ownerBusy);
  S.p2p = st.p2p ?? null;
  S.policy = st.policy ?? {};
  const experimental = st.experimental === true;
  const experimentalChanged = S.experimental !== experimental;
  S.experimental = experimental;
  S.channels = new Map((st.channels ?? []).map((c) => [c.id, c]));
  S.transfers = new Map((st.transfers ?? []).map((t) => [t.tid, t]));
  S.mcp = st.mcp ?? [];
  if (st.model) S.model = st.model;
  S.requests = new Map((st.requests ?? []).map((r) => [r.id, r]));
  S.followups = new Map((st.followups ?? []).map((f) => [f.id, f]));
  for (const ch of Object.keys(S.ack)) {
    const c = S.channels.get(ch);
    // The server count dropped (e.g. it marked messages read): don't hide future ones.
    if (!c) delete S.ack[ch];
    else if ((c.unread ?? 0) < S.ack[ch]) S.ack[ch] = c.unread ?? 0;
  }
  for (const ch of S.channels.keys()) if (isViewing(ch)) S.ack[ch] = S.channels.get(ch).unread ?? 0;
  saveAck();
  S.loaded = true;
  emit("channels");
  emit("transfers");
  emit("relay");
  emit("mcp");
  emit("model");
  emit("owner");
  emit("requests");
  emit("followups");
  if (experimentalChanged) emit("experimental");
}

export function setExperimental(enabled) {
  if (S.experimental === !!enabled) return;
  S.experimental = !!enabled;
  emit("experimental");
  emit("channels");
}

/** A Conversations channel, shown as one only while experimental features are on. */
export function isConversation(c) {
  return S.experimental && c?.mode === "conversation";
}

export function setModel(m) {
  S.model = m;
  emit("model");
}

export function setOwnerBusy(busy) {
  if (busy && !S.ownerBusy) S.ownerBusySince = Date.now();
  S.ownerBusy = !!busy;
  emit("busy");
}

export function setConversation(st) {
  S.conversations.set(st.ch, st);
  emit(`conversation:${st.ch}`);
}

export function upsertFollowup(f) {
  S.followups.set(f.id, f);
  emit("followups");
}

/** Follow-ups still to come, soonest first. conversation: "owner", or a channel id. */
export function pendingFollowups(where) {
  return [...S.followups.values()]
    .filter((f) => (f.state === "pending" || f.state === "running") && (where === "owner" ? f.conversation === "owner" : f.ch === where && f.conversation === "channel"))
    .sort((a, b) => a.dueAt - b.dueAt);
}

export function upsertRequest(r) {
  S.requests.set(r.id, r);
  emit("owner");
  emit("requests");
}

/** ask_owner requests still waiting for a decision, oldest first. */
export function pendingRequests() {
  return [...S.requests.values()].filter((r) => r.state === "pending").sort((a, b) => a.createdAt - b.createdAt);
}

/** Everything waiting for the owner: pending requests plus transfers to approve or accept. */
export function attentionCount() {
  return pendingRequests().length + actionCount();
}

export function upsertChannel(c) {
  S.channels.set(c.id, c);
  if (isViewing(c.id)) {
    S.ack[c.id] = c.unread ?? 0;
    saveAck();
  }
  emit("channels");
  emit(`channel:${c.id}`);
}

export function removeChannel(ch) {
  S.channels.delete(ch);
  S.messages.delete(ch);
  delete S.ack[ch];
  delete S.local[ch];
  saveAck();
  emit("channels");
  emit(`channel:${ch}`);
}

export function setMessages(ch, items) {
  // The API has applied relay ordering across the entire history before slicing a page.
  // Preserve that order; recomputing from only this page can change its cursor boundary.
  S.messages.set(ch, [...items]);
  emit(`messages:${ch}`);
}

const counted = new Set(); // message ids already counted as unread

export function maxMessageSequence(messages) {
  let maxSeq = 0;
  messages.forEach((message) => {
    if (Number.isSafeInteger(message.seq) && message.seq > maxSeq) maxSeq = message.seq;
  });
  return maxSeq;
}

export function upsertMessage(ch, m) {
  const list = S.messages.get(ch);
  let isNew = !counted.has(m.id);
  if (list) {
    const i = list.findIndex((x) => x.id === m.id);
    let shouldReorder = false;
    if (i >= 0) {
      const previous = list[i];
      list[i] = { ...previous, ...m };
      isNew = false;
      shouldReorder = Number.isSafeInteger(m.seq) && previous.seq !== m.seq;
    } else {
      const maxSeq = maxMessageSequence(list);
      list.push(m);
      // Normal relay delivery appends a newer sequence. Preserve the API's loaded-page
      // boundary; only an out-of-order replay needs slot reconstruction.
      shouldReorder = Number.isSafeInteger(m.seq) && m.seq < maxSeq;
    }
    if (shouldReorder) {
      const ordered = orderBySequenceSlots(list);
      list.length = 0;
      for (const message of ordered) list.push(message);
    }
  }
  if (isNew && !m.mine && m.type === "chat" && !isViewing(ch)) {
    counted.add(m.id);
    S.local[ch] = (S.local[ch] ?? 0) + 1;
    emit("channels");
  }
  emit(`messages:${ch}`);
}

function insertBlock(items, index, block) {
  const length = items.length;
  items.length = length + block.length;
  for (let i = length - 1; i >= index; i--) items[i + block.length] = items[i];
  for (let i = 0; i < block.length; i++) items[index + i] = block[i];
}

function orderBySequenceSlots(items) {
  // Use each row's persistent database slot, not its already-rendered position. That keeps
  // a delayed acknowledgement from changing the slots used by a subsequent replay.
  const slots = items.map((message, index) => ({
    message,
    index,
    slot: Number.isSafeInteger(message.timelineSlot) ? message.timelineSlot : index,
  })).sort((a, b) => a.slot - b.slot || a.index - b.index);
  const ordered = slots.map((entry) => entry.message).filter((m) => Number.isSafeInteger(m.seq)).sort((a, b) => a.seq - b.seq);
  let next = 0;
  const result = slots.map(({ message }) => (Number.isSafeInteger(message.seq) ? ordered[next++] : message));

  // A sequenced reply may be replayed after a later-sequence message. Keep its unsequenced
  // parent (and neighboring local rows) together, ahead of the earliest such reply.
  for (let i = 0; i < result.length; i++) {
    const child = result[i];
    if (!Number.isSafeInteger(child.seq) || !child.replyTo) continue;
    const parentIndex = result.findIndex((m) => m.id === child.replyTo);
    if (parentIndex <= i || Number.isSafeInteger(result[parentIndex]?.seq)) continue;
    let start = parentIndex;
    while (start > 0 && !Number.isSafeInteger(result[start - 1].seq)) start--;
    let end = parentIndex + 1;
    while (end < result.length && !Number.isSafeInteger(result[end].seq)) end++;
    const pending = result.splice(start, end - start);
    insertBlock(result, i, pending);
    i = -1; // Re-check the reordered list for additional parent/reply constraints.
  }
  return result;
}

export function setTransfers(items) {
  S.transfers = new Map(items.map((t) => [t.tid, t]));
  emit("transfers");
}

export function upsertTransfer(t) {
  S.transfers.set(t.tid, t);
  if (t.direction === "out" && t.via === "link" && (t.state === "sending" || t.state === "completed")) emit("direct_transfer", t);
  emit("transfers", t);
}

export function setOwner(items) {
  S.owner = items;
  emit("owner");
}

export function upsertOwner(item) {
  if (!S.owner) return; // not loaded yet; the next load includes it
  const i = S.owner.findIndex((x) => x.id === item.id);
  if (i >= 0) S.owner[i] = item;
  else S.owner.push(item);
  emit("owner");
}

// ---------------------------------------------------------------- derived

export function needsAction(t) {
  return (t.direction === "out" && t.state === "awaiting_approval") || (t.direction === "in" && t.state === "offered");
}

export function actionCount() {
  let n = 0;
  for (const t of S.transfers.values()) if (needsAction(t)) n++;
  return n;
}

export function peers(c) {
  return (c?.members ?? []).filter((m) => !m.me);
}

export function memberName(c, id) {
  const m = c?.members.find((x) => x.id === id);
  return m?.name;
}

/** Display name of a channel: direct channels show the peer's name. */
export function channelTitle(c) {
  if (!c) return "Unknown channel";
  if (c.kind === "direct") {
    const p = peers(c)[0];
    return p?.name || c.name || "Waiting for peer…";
  }
  return c.name || "Unnamed group";
}

export function allMcpTools() {
  const out = [];
  for (const s of S.mcp) for (const t of s.tools ?? []) if (t.enabled !== false) out.push({ server: s.name, ...t });
  return out;
}

// ---------------------------------------------------------------- working status

const WORKING_STALE_MS = 150_000;

/** A status event (from a peer's Spencer or mine). "done" or a reply to the same message clears it. */
export function setWorking(ev) {
  let m = S.working.get(ev.ch);
  if (!m) S.working.set(ev.ch, (m = new Map()));
  if (ev.state === "done" || ev.state === "completed" || ev.state === "failed") m.delete(ev.from);
  else {
    // input_required: the run is parked on its owner's approval (a remote ask_owner).
    const activity = ev.state === "input_required" ? "Waiting for its owner's approval" : ev.activity || "Working…";
    const prev = m.get(ev.from);
    const same = prev && prev.replyTo === ev.replyTo;
    // Earlier activities of this run, so the UI can show a short trace instead of only the latest step.
    const steps = same ? [...prev.steps] : [];
    if (same && prev.activity !== activity) steps.push(prev.activity);
    m.set(ev.from, { replyTo: ev.replyTo, activity, waiting: ev.state === "input_required", steps: steps.slice(-6), since: same ? prev.since : Date.now(), ts: Date.now() });
  }
  emit(`working:${ev.ch}`);
  emit("working");
}

export function clearWorkingFor(ch, from, replyTo) {
  const m = S.working.get(ch);
  const w = m?.get(from);
  if (w && (!replyTo || w.replyTo === replyTo)) {
    m.delete(from);
    emit(`working:${ch}`);
    emit("working");
  }
}

/** Live working entries of a channel (stale ones dropped: a Spencer that went offline mid-run). */
export function workingIn(ch) {
  const m = S.working.get(ch);
  if (!m) return [];
  const now = Date.now();
  for (const [k, v] of m) if (now - v.ts > WORKING_STALE_MS) m.delete(k);
  return [...m].map(([from, v]) => ({ from, ...v }));
}

// ---------------------------------------------------------------- presence
// The daemon sends member.presence = "online"|"offline"|"unknown" and member.lastSeen (ms), see PROTOCOL §8.
// An older daemon sends nothing; the UI then shows nothing presence-related.

/** Presence of a channel member: {known, online, lastSeenAt}. `known` is false for "unknown" or missing data. */
export function presenceOf(member) {
  const p = member?.presence;
  const seen = Number.isFinite(member?.lastSeen) ? member.lastSeen : undefined;
  if (p === "online") return { known: true, online: true, lastSeenAt: seen };
  if (p === "offline") return { known: true, online: false, lastSeenAt: seen };
  return { known: false, online: false, lastSeenAt: undefined };
}

/** Is this member's Spencer working in the channel right now? (Working implies reachable.) */
export function workingOf(ch, memberId) {
  return workingIn(ch).find((w) => w.from === memberId);
}

/** A presence event: {type:"presence", ch, id, presence: "online"|"offline"|"unknown", lastSeen?}. */
export function applyPresence(ev) {
  if (typeof ev?.id !== "string" || typeof ev.presence !== "string") return;
  let touched = false;
  for (const c of S.channels.values()) {
    if (typeof ev.ch === "string" && ev.ch !== c.id) continue;
    const m = c.members?.find((x) => x.id === ev.id);
    if (!m || m.me) continue;
    m.presence = ev.presence;
    if (Number.isFinite(ev.lastSeen)) m.lastSeen = ev.lastSeen;
    touched = true;
    emit(`channel:${c.id}`);
  }
  if (touched) emit("channels");
}

/** Relays the daemon reports as down (empty when it reports no per-relay list). */
export function relaysDown() {
  return (S.relays ?? []).filter((r) => r && r.connected === false);
}

// ---------------------------------------------------------------- channel status
// The API sends only {state: "working"|"done", activity}. The richer states are derived here:
// waiting = something in this channel is waiting for the owner; blocked = it cannot be delivered right now.

/**
 * What is going on in a channel, as one line: {state, text, from?}.
 * state: "waiting" | "blocked" | "thinking" | "working" | "idle" | "offline" | "pending" | "unknown".
 * The line is outcome first and names what the owner owes, if anything.
 */
export function channelStatus(c) {
  if (!c) return { state: "unknown", text: "" };
  const req = pendingRequests().find((r) => r.ch === c.id);
  if (req) return { state: "waiting", text: req.kind === "continue" ? "Paused: continue or stop?" : `Needs your yes for ${req.fromName ?? "a peer"}`, owes: true };
  const xfer = [...S.transfers.values()].filter((t) => t.ch === c.id && needsAction(t)).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (xfer) return { state: "waiting", text: xfer.direction === "out" ? `Waiting on your approval to send ${xfer.name}` : `Wants to send you ${xfer.name}`, owes: true };
  const others = peers(c);
  if (!others.length) return { state: "pending", text: "Invite not used yet" };
  if (S.loaded && S.wsUp && S.relay && S.relay.connected === false) return { state: "blocked", text: "Relay offline. Messages are queued." };
  const w = workingIn(c.id)[0];
  if (w) return { state: w.waiting ? "waiting" : /^thinking/i.test(w.activity) ? "thinking" : "working", text: w.activity.replace(/…$/, ""), from: w.from };
  if (c.kind === "group") {
    const known = others.filter((m) => presenceOf(m).known);
    if (!known.length) return { state: "unknown", text: `${c.members.length} member${c.members.length === 1 ? "" : "s"}` };
    const online = known.filter((m) => presenceOf(m).online).length;
    return { state: online ? "idle" : "offline", text: `${online} of ${others.length} online` };
  }
  const p = presenceOf(others[0]);
  if (!p.known) return { state: "unknown", text: "" };
  return p.online ? { state: "idle", text: "Online" } : { state: "offline", text: "" };
}

export function applyBioEvent(ev) {
  if (ev.type === "bio") { S.bio = ev.bio; emit("bio", ev.bio); }
  if (ev.type === "peer_bio") {
    if (!S.peerBios.has(ev.ch)) S.peerBios.set(ev.ch, new Map());
    S.peerBios.get(ev.ch).set(ev.id, ev);
    emit("peer_bio", ev);
  }
}

export function clearTyping(ch, from) {
  if (S.typing.get(ch)?.delete(from)) emit(`typing:${ch}`);
}
export function setTyping(ev) {
  if (!ev.active) return clearTyping(ev.ch, ev.from);
  if (!S.typing.has(ev.ch)) S.typing.set(ev.ch, new Map());
  S.typing.get(ev.ch).set(ev.from, { ts: ev.ts });
  emit(`typing:${ev.ch}`);
}
export function typingIn(ch) {
  const entries = S.typing.get(ch);
  if (!entries) return [];
  for (const [id, value] of entries) if (Date.now() - value.ts >= 8000) entries.delete(id);
  return [...entries.keys()];
}
