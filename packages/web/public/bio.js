// Public BIO editor. Lengths use UTF-16 code units, matching the protocol.
import { h, icon } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { on } from "./state.js";
import { viewHeader } from "./common.js";

const TEMPLATE = `# Who I am

## What I can help with

## How to ask me

## What I won't do
`;

export function bioView(main) {
  const editor = h("textarea.input.soul-editor", {
    rows: "18",
    spellcheck: "true",
    placeholder: "Your public scope and how peers can ask for help.",
    "aria-label": "BIO.md",
    disabled: true,
  });
  const count = h("span.soul-count", { "aria-live": "polite" });
  const save = h("button.btn.primary", { type: "button", disabled: true }, "Save");
  const revert = h("button.btn", { type: "button", disabled: true }, "Revert");
  const template = h("button.btn", { type: "button", hidden: true }, "Start from a template");

  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("heart", 18)), h("div.title-stack", null, h("h1", null, "Bio"), h("span.subtitle", null, "Your public calling card"))]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h(
          "p.lede",
          null,
          "Peers and their Spencers read this — never put secrets, private IPs, or sensitive paths here. Use Soul for private personality (available under Experimental). Your BIO narrows your scope in work channels.",
        ),
        editor,
        h("div.soul-actions", null, save, revert, template, count),
        h("p.model-foot", null, "Saved as ", h("code", null, "BIO.md"), " in Spencer's data folder and shared with the channels below. If you edit the file directly, restart Spencer."),
      ),
    ),
  );

  const brief = h("div");
  const title = h("input.input", { placeholder: "Title", "aria-label": "Work title", maxlength: "160" });
  const summary = h("textarea.input", { placeholder: "Current status", "aria-label": "Work summary", maxlength: "1000" });
  const visibility = h("select.input", { "aria-label": "Visibility" }, ...["private", "trusted", "public"].map(v => h("option", { value: v }, v)));
  const add = h("button.btn.primary", { type: "button" }, "Add work item");
  main.querySelector(".page-body").append(h("h2", null, "Work Brief"), h("p", null, "Private stays with you; trusted is shared with full-trust channels; public is shared with all work channels."), title, summary, visibility, add, brief);
  const refreshBrief = async () => {
    const data = await attempt(() => api.workBrief());
    if (!data) return;
    brief.replaceChildren(...data.items.map(item => {
      const select = h("select.input", { "aria-label": `Visibility for ${item.title}` }, ...["private", "trusted", "public"].map(v => h("option", { value: v }, v)));
      select.value = item.visibility;
      select.addEventListener("change", async () => { await attempt(() => api.patchWorkBrief(item.id, { visibility: select.value })); void refreshBrief(); });
      const done = h("button.btn", { type: "button" }, item.status === "done" ? "Mark active" : "Mark done");
      done.addEventListener("click", async () => { await attempt(() => api.patchWorkBrief(item.id, { status: item.status === "done" ? "active" : "done" })); void refreshBrief(); });
      const del = h("button.btn", { type: "button" }, "Delete");
      del.addEventListener("click", async () => { await attempt(() => api.deleteWorkBrief(item.id)); void refreshBrief(); });
      return h("div", null, h("h3", null, item.title), h("p", null, item.summary), h("span", null, item.status), select, done, del);
    }));
  };
  add.addEventListener("click", async () => { const result = await attempt(() => api.addWorkBrief({ title: title.value, summary: summary.value, visibility: visibility.value, source: "owner" })); if (result) { title.value = ""; summary.value = ""; void refreshBrief(); } });
  void refreshBrief();
  const offBrief = on("work_brief", () => void refreshBrief());
  const channels = h("ul.bio-channels");
  main.querySelector(".page-body").append(h("h2", null, "Shared with"), channels);
  let saved = "";
  let maxChars = 2000;
  let busy = false;

  const sync = () => {
    const n = editor.value.length;
    const over = n > maxChars;
    const dirty = editor.value.trim() !== saved;
    count.textContent = `${n} / ${maxChars} chars`;
    count.classList.toggle("over", over);
    save.disabled = busy || !dirty || over;
    revert.disabled = busy || !dirty;
    template.hidden = !!editor.value.trim();
  };

  const showChannels = r => channels.replaceChildren(...(r.sharedChannels ?? []).map(c => h("li", null, `${c.name} · ${c.kind} · ${c.trust}`)));
  const load = (r) => {
    showChannels(r);
    saved = r.text ?? "";
    maxChars = r.maxChars ?? maxChars;
    editor.value = saved;
    editor.disabled = false;
    sync();
  };

  const doSave = async () => {
    if (save.disabled) return;
    busy = true;
    sync();
    const r = await attempt(() => api.setBio(editor.value));
    busy = false;
    if (r) {
      load(r);
      toast(r.text ? "Bio saved and shared." : "Bio removed.", "info");
    } else sync();
  };

  editor.addEventListener("input", sync);
  editor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void doSave();
    }
  });
  save.addEventListener("click", () => void doSave());
  revert.addEventListener("click", () => {
    editor.value = saved;
    sync();
  });
  template.addEventListener("click", () => {
    editor.value = TEMPLATE;
    sync();
    editor.focus();
  });

  sync();
  attempt(() => api.bio()).then((r) => r && load(r));
  const off = on("bio", r => { if (editor.value.trim() === saved) load(r); else showChannels(r); });
  return { destroy() { off(); offBrief(); } };
}
