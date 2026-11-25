import { toolGuardrails } from "./tool-policies.js";
import { h } from "./dom.js";
import { api, attempt } from "./api.js";
import { markdown } from "./md.js";
import { openModal } from "./modal.js";
import { on } from "./state.js";

export function unseenMemoirCount(peers) {
  return peers.reduce((n, p) => n + (p.unseenNotes ?? 0), 0);
}
export function memoirSummary(p) {
  return `${p.hasRules || p.rules ? "Rules saved" : "No rules"} · ${p.noteCount ?? p.notes?.length ?? 0} notes${p.unseenNotes ? ` · ${p.unseenNotes} unseen` : ""}`;
}
export function memoirModal(kind, id, ch) {
  const body = h("div", null, "Loading…");
  let closed = false,
    seq = 0,
    timer,
    dirty = false,
    rev = 0,
    saving = false,
    mounted = false,
    lastRules = "",
    first = true;
  const offs = [];
  const modal = openModal({
    title: kind === "peer" ? "Peer Card" : "Group Memoir",
    body,
    onClose() {
      closed = true;
      seq++;
      clearTimeout(timer);
      offs.forEach((off) => off());
    },
  });

  const headerSlot = h("div");
  const rules = h("textarea", {
    rows: 6,
    "aria-label": "Your RULES.md",
  });
  const count = h("span.hint");
  const updateCount = () => {
    const bytes = new TextEncoder().encode(rules.value).length;
    count.textContent = `${bytes} / 2048 B`;
    save.disabled = saving || bytes > 2048;
  };
  const save = h(
    "button.btn",
    {
      type: "button",
      on: {
        click: async () => {
          if (saving) return;
          const savedRev = rev;
          const submitted = rules.value;
          saving = true;
          updateCount();
          try {
            const result = await attempt(() =>
              api.setRules(kind, id, submitted),
            );
            if (result && !closed) {
              lastRules = result.rules ?? submitted.trim();
              if (rev === savedRev) {
                dirty = false;
                rules.value = lastRules;
              }
              void load();
            }
          } finally {
            saving = false;
            updateCount();
          }
        },
      },
    },
    "Save",
  );
  rules.addEventListener("input", () => {
    dirty = true;
    rev++;
    updateCount();
  });
  const revert = h(
    "button.btn",
    {
      type: "button",
      on: {
        click: () => {
          dirty = false;
          rev++;
          rules.value = lastRules;
          updateCount();
          void load();
        },
      },
    },
    "Revert",
  );
  const notesList = h("div.memoir-notes-list");
  const add = h("input", {
    type: "text",
    maxLength: 500,
    "aria-label": "Add note",
    placeholder: "Durable fact or preference",
  });
  const addForm = h(
    "form",
    {
      on: {
        submit: async (e) => {
          e.preventDefault();
          const text = add.value;
          if (await attempt(() => api.addMemoirNote(kind, id, text))) {
            if (add.value === text) add.value = "";
            void load();
          }
        },
      },
    },
    add,
    h("button.btn", { type: "submit" }, "Add note"),
  );

  const ensureMounted = () => {
    if (mounted) return;
    mounted = true;
    body.replaceChildren(
      headerSlot,
      h(
        "h3",
        null,
        kind === "peer"
          ? "Your RULES.md (DMs and groups)"
          : "Your RULES.md (group only)",
      ),
      h(
        "p.hint",
        null,
        kind === "peer"
          ? "Applies in 1:1 DMs and when this peer speaks in groups. Advisory when Owner coding tools or Full Trust filesystem/MCP tools can access the data folder."
          : "Applies only in this group. Advisory when Owner coding tools or Full Trust filesystem/MCP tools can access the data folder.",
      ),
      rules,
      count,
      h("div", null, save, revert),
      ...(kind === "peer" ? [toolGuardrails("peer", id)] : []),
      h("h3", null, "Memoir Notes"),
      h(
        "p.hint",
        null,
        "Historical notes are untrusted and never grant permissions.",
      ),
      notesList,
      addForm,
    );
  };

  const load = async () => {
    const mine = ++seq;
    const p = await attempt(() =>
      api.memoir(kind, id, kind === "peer" && first),
    );
    first = false;
    if (!p || closed || mine !== seq) return;
    ensureMounted();
    lastRules = p.rules ?? "";
    if (!dirty) {
      rules.value = lastRules;
    }
    updateCount();
    const channelBio = ch ? p.channels?.find((c) => c.id === ch) : null;
    const bio = channelBio ? channelBio.about : p.bio;
    headerSlot.replaceChildren(
      h("h2", null, p.name ?? "Peer"),
      h("code", null, p.fingerprint ?? p.ch ?? id),
      ...(kind === "peer"
        ? [
            h("h3", null, "Their BIO.md"),
            h("p.hint", null, "Peer-authored / untrusted"),
            h(
              "div.markdown",
              null,
              bio
                ? markdown(bio, undefined, { htmlPreview: false })
                : "No bio shared yet",
            ),
          ]
        : []),
    );
    notesList.replaceChildren(
      ...p.notes.map((n) =>
        h(
          "article.memoir-note",
          null,
          h("span.pill", null, n.author === "owner" ? "You" : "Agent"),
          " ",
          h(
            "span.hint",
            null,
            `${n.trustAtWrite ?? "unknown"} · ${new Date(n.createdAt).toLocaleString()}`,
          ),
          h("p", null, n.text),
          h(
            "button.btn.sm",
            {
              type: "button",
              on: {
                click: async () => {
                  if (
                    await attempt(() =>
                      api.patchMemoirNote(n.id, { pinned: !n.pinned }),
                    )
                  )
                    void load();
                },
              },
            },
            n.pinned ? "Unpin" : "Pin",
          ),
          h(
            "button.btn.sm",
            {
              type: "button",
              on: {
                click: async () => {
                  if (await attempt(() => api.deleteMemoirNote(n.id)))
                    void load();
                },
              },
            },
            "Delete",
          ),
        ),
      ),
    );
  };
  const schedule = () => {
    seq++;
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 150);
  };
  offs.push(
    on("memoir", (e) => {
      if (e.scopeKind === kind && e.scopeId === id) schedule();
    }),
    on("peer_bio", (e) => {
      if (kind === "peer" && e.id === id) schedule();
    }),
  );
  void load();
  return modal;
}
export const groupMemoir = (id) => memoirModal("channel", id);
export function groupMemoirSnippet(c) {
  if (c.mode === "conversation") return null;
  const summary = h("p", null, "Loading…");
  void attempt(() => api.memoir("channel", c.id)).then((p) => {
    if (p) summary.textContent = memoirSummary(p);
  });
  return h(
    "section.peer-bio",
    null,
    h("h3", null, "Group Memoir"),
    summary,
    h(
      "button.btn.sm",
      { type: "button", on: { click: () => groupMemoir(c.id) } },
      "Open Group Memoir",
    ),
  );
}
