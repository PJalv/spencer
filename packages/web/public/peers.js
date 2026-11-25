import { memoirModal, memoirSummary } from "./memoir.js";
import { h, icon, avatar, shortFp } from "./dom.js";
import { api, attempt } from "./api.js";
import { on } from "./state.js";
import { viewHeader, emptyState } from "./common.js";

export function peerCard(id, ch) {
  return memoirModal("peer", id, ch);
}

export function peerBioSnippet(c) {
  const peer = c.members.find(m => !m.me);
  if (!peer) return null;
  const summary = h("p", null, "Loading…");
  void attempt(() => api.memoir("peer", peer.id)).then(p => { if (p) summary.textContent = memoirSummary(p); });
  return h(
    "section.access",
    { "aria-label": "Memoir" },
    h("h2", null, "Memoir"),
    h("div.access-row", null, icon("file", 15), h("div", null, h("strong", null, peer.name ?? "Peer"), summary)),
    h("button.btn.sm", { type: "button", on: { click: () => peerCard(peer.id, c.id) } }, "Show Memoir"),
  );
}

export function peersView(main) {
  const list = h("div.peer-directory");
  main.append(
    viewHeader([
      h("span.title-icon", { "aria-hidden": "true" }, icon("users", 18)),
      h("div.title-stack", null, h("h1", null, "Peers"), h("span.subtitle", null, "Connected Spencers and their memoirs")),
    ]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h("p.lede", null, "Rules, tool guardrails, and notes your Spencer remembers for each peer."),
        list,
      ),
    ),
  );
  let dead = false;
  let seq = 0;
  let timer = null;
  const load = async () => {
    const mine = ++seq;
    const result = await attempt(() => api.peers());
    if (!result || dead || mine !== seq) return;
    const card = p => {
      const channelNames = (p.channels ?? []).map(c => c.name).filter(Boolean).join(" · ");
      return h(
        "article.peer-card",
        null,
        avatar(p.name ?? "Peer", p.id),
        h(
          "div.peer-main",
          null,
          h(
            "div.peer-heading",
            null,
            h("strong.peer-name", null, p.name ?? "Peer"),
            h("code.fp", { title: p.fingerprint ?? p.id }, shortFp(p.fingerprint)),
            p.unseenNotes ? h("span.pill.attn", null, `${p.unseenNotes} unseen`) : null,
          ),
          channelNames ? h("p.peer-channels", null, channelNames) : null,
          h("p.peer-summary.hint", null, memoirSummary(p)),
        ),
        h("button.btn.sm", { type: "button", on: { click: () => peerCard(p.id) } }, "Show Memoir"),
      );
    };
    const active = result.peers.filter(p => p.active !== false);
    const inactive = result.peers.filter(p => p.active === false);
    if (!result.peers.length) {
      list.replaceChildren(emptyState({ icon: "users", title: "No peers yet", text: "Invite someone or join a channel to see their Spencer here." }));
      return;
    }
    list.replaceChildren(
      ...active.map(card),
      ...(inactive.length ? [h("h2.section-title.peer-inactive-title", null, "Inactive peers"), ...inactive.map(card)] : []),
    );
  };
  const schedule = () => {
    seq++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void load(); }, 150);
  };
  const offChannels = on("channels", schedule);
  const offMemoir = on("memoir", schedule);
  void load();
  return { destroy() { dead = true; if (timer) clearTimeout(timer); offChannels(); offMemoir(); } };
}
