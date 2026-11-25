// An ask_owner request: something a peer's Spencer wants done that needs the owner's go-ahead.
// The same card is used in the owner chat and in "Needs you".
import { h, icon, linkify, timeShort, timeFull, relTime, avatar } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, upsertRequest } from "./state.js";

/** Disclosure state of long decided request cards across transcript re-renders. */
const openDecidedRequests = new Set();

/**
 * requestCard(id, {text, ts}): `text` and `ts` are the fallback from the owner-chat note when the
 * request itself is not loaded. The text is written from untrusted peer input.
 */
export function requestCard(id, fallback = {}) {
  const r = S.requests.get(id);
  if (r?.kind === "continue") return continueCard(r);
  const state = r?.state ?? "pending";
  const who = r?.fromName ?? "A peer's Spencer";
  const ts = r?.createdAt ?? fallback.ts;
  const text = r?.text ?? fallback.text ?? "";
  const channel = r && S.channels.has(r.ch) ? h("a.ask-where", { href: `#/c/${encodeURIComponent(r.ch)}` }, r.channelName || "channel") : r?.channelName ? h("span.ask-where", null, r.channelName) : null;

  // What saying yes means, as facts about this request (not guesses from the peer's text).
  const trust = r ? S.channels.get(r.ch)?.trust : undefined;
  const chips = [
    h("span.chip.risk", { title: "Approving runs this in your own Spencer conversation, with every tool it has: MCP servers, files, shell." }, icon("terminal", 12), "Runs with all your tools"),
    h("span.chip", { title: "The description below was written by your channel agent from a peer's message." }, icon("warn", 12), "Peer-written"),
    trust ? h("span.chip", { title: trust === "full" ? "This channel is set to full trust." : "This channel is set to standard trust, which is why you are being asked." }, icon("shield", 12), trust === "full" ? "Full-trust channel" : "Standard-trust channel") : null,
  ];

  let foot;
  if (state === "pending") {
    const approve = h("button.btn.primary", { type: "button" }, "Approve");
    const deny = h("button.btn", { type: "button" }, "Deny");
    const decide = async (yes) => {
      approve.disabled = deny.disabled = true;
      const res = await attempt(() => api.decideRequest(id, yes));
      if (res?.id) {
        upsertRequest(res);
        toast(yes ? "Approved. Your Spencer is on it." : `Denied. ${who} was told.`, "info");
      } else approve.disabled = deny.disabled = false;
    };
    approve.addEventListener("click", () => decide(true));
    deny.addEventListener("click", () => decide(false));
    // The action row wraps, so further choices ("Allow once", "Always allow") fit here when the API has them.
    foot = h("div.ask-foot", null, h("p.ask-hint", null, "If you approve, your Spencer does it and reports back to the channel."), h("div.ask-actions", null, deny, approve));
  } else {
    const when = r?.decidedAt ? h("time", { datetime: new Date(r.decidedAt).toISOString(), title: timeFull(r.decidedAt) }, timeShort(r.decidedAt)) : null;
    foot = h("div.ask-foot.decided", null, icon(state === "approved" ? "check" : "close", 14), h("span", null, state === "approved" ? "You approved this" : "You denied this", when ? " at " : null, when));
  }

  let bodyNode;
  if (state !== "pending" && text.length > 220) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 140);
    const details = h(
      "details.ask-collapse",
      { open: openDecidedRequests.has(id) },
      h("summary", null, h("span.ask-collapse-preview", null, preview), icon("chevron", 13)),
      h("div.ask-text.peer-text", null, linkify(text)),
    );
    details.addEventListener("toggle", () => (details.open ? openDecidedRequests.add(id) : openDecidedRequests.delete(id)));
    bodyNode = details;
  } else {
    bodyNode = h("div.ask-text.peer-text", null, linkify(text));
  }

  return h(
    `article.ask.${state}`,
    { "aria-label": `Request from ${who}`, dataset: { request: id } },
    h(
      "header.ask-head",
      null,
      avatar(who, r?.from ?? who, "sm"),
      h("div.ask-title", null, h("strong", null, who), state === "pending" ? " asks for your approval" : " asked for your approval", channel ? [" in ", channel] : null),
      ts ? h("time.ask-time", { datetime: new Date(ts).toISOString(), title: timeFull(ts), "data-rel": state === "pending" ? String(ts) : undefined }, state === "pending" ? `asked ${relTime(ts)}` : timeShort(ts)) : null,
    ),
    bodyNode,
    state === "pending" ? h("div.ask-chips", null, chips) : null,
    foot,
  );
}

/**
 * A "continue?" card: the channel used up its automatic replies (turn budget), so the conversation is
 * paused. Continue answers the waiting message and refills the budget; Stop tells the peer it is paused.
 */
function continueCard(r) {
  const who = r.fromName ?? "the other Spencer";
  const channel = S.channels.has(r.ch) ? h("a.ask-where", { href: `#/c/${encodeURIComponent(r.ch)}` }, r.channelName || "channel") : h("span.ask-where", null, r.channelName || "a channel");
  let foot;
  if (r.state === "pending") {
    const go = h("button.btn.primary", { type: "button" }, "Continue");
    const stop = h("button.btn", { type: "button" }, "Stop");
    const decide = async (yes) => {
      go.disabled = stop.disabled = true;
      const res = await attempt(() => api.decideRequest(r.id, yes));
      if (res?.id) {
        upsertRequest(res);
        toast(yes ? "Continuing. Your Spencer answers the waiting message." : `Stopped. ${who} was told the conversation is paused.`, "info");
      } else go.disabled = stop.disabled = false;
    };
    go.addEventListener("click", () => decide(true));
    stop.addEventListener("click", () => decide(false));
    foot = h("div.ask-foot", null, h("p.ask-hint", null, "Continue gives it a fresh set of automatic replies. Writing in the channel yourself does the same."), h("div.ask-actions", null, stop, go));
  } else {
    const when = r.decidedAt ? h("time", { datetime: new Date(r.decidedAt).toISOString(), title: timeFull(r.decidedAt) }, timeShort(r.decidedAt)) : null;
    foot = h("div.ask-foot.decided", null, icon(r.state === "approved" ? "check" : "close", 14), h("span", null, r.state === "approved" ? "You let it continue" : "You stopped it", when ? " at " : null, when));
  }
  return h(
    `article.ask.continue.${r.state}`,
    { "aria-label": `Paused conversation in ${r.channelName ?? "a channel"}`, dataset: { request: r.id } },
    h(
      "header.ask-head",
      null,
      avatar(who, r.from ?? who, "sm"),
      h("div.ask-title", null, "Your Spencer paused its conversation with ", h("strong", null, who), " in ", channel),
      r.createdAt ? h("time.ask-time", { datetime: new Date(r.createdAt).toISOString(), title: timeFull(r.createdAt), "data-rel": r.state === "pending" ? String(r.createdAt) : undefined }, r.state === "pending" ? relTime(r.createdAt) : timeShort(r.createdAt)) : null,
    ),
    r.text ? h("div.ask-text.peer-text", null, linkify(r.text)) : null,
    r.state === "pending" ? h("div.ask-chips", null, h("span.chip", { title: "Your Spencer answered automatically as many times as its budget allows since you last wrote here." }, icon("shield", 12), "Automatic reply limit reached")) : null,
    foot,
  );
}
