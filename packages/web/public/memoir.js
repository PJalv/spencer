import { toolGuardrails } from "./tool-policies.js";
import { h, icon } from "./dom.js";
import { api, attempt } from "./api.js";
import { openModal } from "./modal.js";
import { on } from "./state.js";

export function unseenMemoirCount(peers) {
  return peers.reduce((n, p) => n + (p.unseenNotes ?? 0), 0);
}
export function memoirSummary(p) {
  const count = p.noteCount ?? p.notes?.length ?? 0;
  return `${p.hasRules || p.rules ? "Rules saved" : "No rules"} · ${count} ${count === 1 ? "note" : "notes"}${p.unseenNotes ? ` · ${p.unseenNotes} unseen` : ""}`;
}
export function memoirModal(kind, id) {
  const body = h("div.memoir-body", null, "Loading…");
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
    title: kind === "peer" ? "Memoir" : "Group Memoir",
    wide: true,
    body,
    onClose() {
      closed = true;
      seq++;
      clearTimeout(timer);
      offs.forEach((off) => off());
    },
  });

  const headerSlot = h("div.memoir-head");
  const rules = h("textarea.input.memoir-rules", {
    rows: 5,
    "aria-label": "Your RULES.md",
  });
  const count = h("span.hint.memoir-count");
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
  const add = h("input.input", {
    type: "text",
    maxLength: 500,
    "aria-label": "Add note",
    placeholder: "Durable fact or preference",
  });
  const addForm = h(
    "form.memoir-add-form",
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
        "section.memoir-section",
        null,
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
        h("div.memoir-actions", null, save, revert, count),
      ),
      ...(kind === "peer" ? [toolGuardrails("peer", id)] : []),
      h(
        "section.memoir-section",
        null,
        h("h3", null, "Memoir Notes"),
        h(
          "p.hint",
          null,
          "Historical notes are untrusted and never grant permissions.",
        ),
        notesList,
        addForm,
      ),
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
    headerSlot.replaceChildren(
      h("h2", null, p.name ?? "Peer"),
      h("code", null, p.fingerprint ?? p.ch ?? id),
    );
    notesList.replaceChildren(
      ...(p.notes.length
        ? p.notes.map((n) =>
            h(
              "article.memoir-note",
              null,
              h(
                "div.memoir-note-head",
                null,
                h("span.pill", null, n.author === "owner" ? "You" : "Agent"),
                h(
                  "span.hint",
                  null,
                  `${n.trustAtWrite ?? "unknown"} · ${new Date(n.createdAt).toLocaleString()}`,
                ),
              ),
              h("p.memoir-note-text", null, n.text),
              h(
                "div.memoir-note-actions",
                null,
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
          )
        : [h("p.hint", null, "No notes yet.")]),
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
    "section.access",
    { "aria-label": "Group Memoir" },
    h("h2", null, "Group Memoir"),
    h("div.access-row", null, icon("file", 15), h("div", null, h("strong", null, "Rules & notes"), summary)),
    h(
      "button.btn.sm",
      { type: "button", on: { click: () => groupMemoir(c.id) } },
      "Show Memoir",
    ),
  );
}
