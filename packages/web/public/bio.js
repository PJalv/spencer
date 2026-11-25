// Public BIO editor (raw Markdown). Lengths use UTF-16 code units, matching the protocol.
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
    placeholder: "Your scope and how peers' Spencers can work with you, in Markdown.",
    "aria-label": "BIO.md",
    disabled: true,
  });
  const count = h("span.soul-count", { "aria-live": "polite" });
  const save = h("button.btn.primary", { type: "button", disabled: true }, "Save");
  const revert = h("button.btn", { type: "button", disabled: true }, "Revert");
  const template = h("button.btn", { type: "button", hidden: true }, "Start from a template");

  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("file", 18)), h("div.title-stack", null, h("h1", null, "Bio"), h("span.subtitle", null, "What peers' Spencers know about you"))]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h(
          "p.lede",
          null,
          "Shared with peers' Spencers by default so they know your role, scope, and how to ask for help — never put secrets, private IPs, or sensitive paths here. You can also ask your Spencer in chat to edit this for you.",
        ),
        editor,
        h("div.soul-actions", null, save, revert, template, count),
        h("p.model-foot", null, "Saved as ", h("code", null, "BIO.md"), " in Spencer's data folder and shared with your channels by default (you can turn sharing off per channel in Channel settings). If you edit the file directly, restart Spencer."),
      ),
    ),
  );

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

  const load = (r) => {
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
  const off = on("bio", r => { if (editor.value.trim() === saved) load(r); });
  return { destroy() { off(); } };
}
