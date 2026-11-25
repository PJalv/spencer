// MCP servers view: status and tools of each server; add, edit, turn off and remove them (saved in config.json).
import { h, icon, copyText } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, emit } from "./state.js";
import { viewHeader, emptyState } from "./common.js";
import { openModal, field } from "./modal.js";

const STATUS_TEXT = { connected: "connected", error: "error", disabled: "off", connecting: "connecting…" };
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function mcpView(main) {
  const list = h("div.mcp-list");
  const presetsBox = h("div.mcp-presets");
  const bridgeBox = h("div.mcp-bridge");
  // config.json entries, presets and the "talk to Spencer" command; statuses live in S.mcp.
  let config = {};
  let presets = [];
  let bridge = null;

  const apply = (r) => {
    if (!r) return false;
    if (Array.isArray(r.servers)) S.mcp = r.servers;
    if (r.config) config = r.config;
    if (Array.isArray(r.presets)) presets = r.presets;
    if (r.spencerBridge) bridge = r.spencerBridge;
    emit("mcp");
    return true;
  };

  const addBtn = h("button.btn.primary.sm", { type: "button", on: { click: () => editServer() } }, icon("plus", 14), "Add server");
  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("plug", 18)), h("div.title-stack", null, h("h1", null, "MCP servers"), h("span.subtitle", null, "Tools your Spencer can call"))], [addBtn]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h("p.lede", null, "Uncheck a tool to turn it off everywhere. Your own conversation can use every checked tool; in a channel, peers only reach the tools you allow in that channel's settings. Changes apply right away."),
        presetsBox,
        list,
        bridgeBox,
      ),
    ),
  );

  function editServer(name, preset) {
    const editing = name !== undefined && config[name] !== undefined;
    const cur = preset?.config ?? (editing ? config[name] : { command: "" });
    let kind = "url" in cur ? "http" : "stdio";
    const nameIn = h("input.input.mono", { value: preset?.name ?? name ?? "", placeholder: "my-tools", autocomplete: "off", spellcheck: "false", required: true });
    const command = h("input.input.mono", { value: cur.command ?? "", placeholder: "npx", spellcheck: "false" });
    const args = h("textarea.input.mono", { rows: 3, placeholder: "one argument per line", spellcheck: "false" });
    args.value = (cur.args ?? []).join("\n");
    const cwd = h("input.input.mono", { value: cur.cwd ?? "", placeholder: "(Spencer's folder)", spellcheck: "false" });
    const env = h("textarea.input.mono", { rows: 2, placeholder: "KEY=value, one per line", spellcheck: "false" });
    env.value = Object.entries(cur.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
    const url = h("input.input.mono", { value: cur.url ?? "", placeholder: "https://example.com/mcp", spellcheck: "false" });
    const headers = h("textarea.input.mono", { rows: 2, placeholder: "Authorization: Bearer …, one per line", spellcheck: "false" });
    headers.value = Object.entries(cur.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
    const enabled = h("input", { type: "checkbox", checked: !cur.disabled });

    const stdioFields = h("div", null, field("Command", command), field("Arguments", args), field("Working folder", cwd), field("Environment", env, "Visible to anyone who can open this page."));
    const httpFields = h("div", null, field("URL", url, "Streamable HTTP MCP endpoint."), field("Headers", headers));
    const seg = h("div.segmented", { role: "radiogroup", "aria-label": "Server type" });
    const renderKind = () => {
      seg.replaceChildren(
        ...[
          ["stdio", "Command", "Spencer starts it (stdio)"],
          ["http", "URL", "It runs elsewhere (HTTP)"],
        ].map(([k, label, sub]) =>
          h(
            `button.seg${kind === k ? ".active" : ""}`,
            { type: "button", role: "radio", "aria-checked": String(kind === k), on: { click: () => ((kind = k), renderKind()) } },
            label,
            h("span", null, sub),
          ),
        ),
      );
      stdioFields.hidden = kind !== "stdio";
      httpFields.hidden = kind !== "http";
    };
    renderKind();

    const save = h("button.btn.primary", { type: "submit", form: "mcp-form" }, editing ? "Save" : "Add");
    const form = h(
      "form",
      {
        id: "mcp-form",
        on: {
          submit: async (e) => {
            e.preventDefault();
            const newName = nameIn.value.trim();
            if (!NAME_RE.test(newName)) return toast("Name: 1-32 letters, digits, - or _");
            if (/[_-]{2}/.test(newName) || ["__proto__", "constructor", "prototype"].includes(newName)) return toast(`Name ${newName} is not allowed`);
            if (newName !== name && Object.hasOwn(config, newName)) return toast(`There is already a server named ${newName}`);
            let cfg;
            try {
              cfg = kind === "http" ? { url: url.value.trim(), headers: pairs(headers.value, ":") } : { command: command.value.trim(), args: lines(args.value), env: pairs(env.value, "="), ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) };
            } catch (err) {
              return toast(err.message);
            }
            if (!enabled.checked) cfg.disabled = true;
            const base = preset?.config ?? (editing ? config[name] : undefined);
            if (base?.disabledTools?.length) cfg.disabledTools = base.disabledTools;
            save.disabled = true;
            let r = await attempt(() => api.saveMcpServer(newName, cfg));
            if (r && editing && newName !== name) {
              const removed = await attempt(() => api.removeMcpServer(name));
              if (!removed) {
                save.disabled = false;
                apply(r);
                modal.close();
                return toast(`Saved ${newName}, but ${name} is still there; remove it by hand`);
              }
              r = removed;
            }
            save.disabled = false;
            if (apply(r)) {
              modal.close();
              toast(editing ? `Saved ${newName}` : `Added ${newName}`, "info");
            }
          },
        },
      },
      preset?.problem ? h("div.callout.warn", null, icon("warn", 16), h("span", null, preset.problem)) : null,
      field("Name", nameIn, "Tools show up as mcp__<name>__<tool>; renaming changes them (re-pick them in channel settings)."),
      field("Type", seg),
      stdioFields,
      httpFields,
      h("label.switch-row", null, enabled, h("span", null, h("strong", null, "Enabled"), h("span.hint.block", null, "Off keeps the entry but stops the server."))),
    );
    const modal = openModal({
      title: editing ? `Edit ${name}` : preset ? `Add ${preset.title}` : "Add MCP server",
      body: form,
      footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), save],
    });
  }

  const toggle = async (name, on) => {
    const cfg = { ...config[name] };
    if (on) delete cfg.disabled;
    else cfg.disabled = true;
    await saveNow(name, cfg);
  };

  const toggleTool = async (name, remote, on) => {
    const cfg = { ...config[name] };
    const off = new Set(cfg.disabledTools ?? []);
    if (on) off.delete(remote);
    else off.add(remote);
    if (off.size) cfg.disabledTools = [...off];
    else delete cfg.disabledTools;
    await saveNow(name, cfg);
  };

  // The local copy changes at once, so a second click before the reply builds on this one instead of undoing it.
  const saveNow = async (name, cfg) => {
    config[name] = cfg;
    const r = await attempt(() => api.saveMcpServer(name, cfg));
    apply(r ?? (await attempt(() => api.mcp())));
  };

  const removeBtn = (name) => {
    const btn = h(
      "button.btn.sm",
      {
        type: "button",
        on: {
          click: async () => {
            if (btn.dataset.confirm !== "1") {
              btn.dataset.confirm = "1";
              btn.textContent = "Remove?";
              btn.classList.add("danger");
              setTimeout(() => {
                if (!btn.isConnected) return;
                btn.dataset.confirm = "";
                btn.textContent = "Remove";
                btn.classList.remove("danger");
              }, 4000);
              return;
            }
            btn.disabled = true;
            if (apply(await attempt(() => api.removeMcpServer(name)))) toast(`Removed ${name}`, "info");
            btn.disabled = false;
          },
        },
      },
      "Remove",
    );
    return btn;
  };

  const describe = (c) => (c ? ("url" in c ? c.url : [c.command, ...(c.args ?? [])].map(quote).join(" ")) : "");

  const render = () => {
    const missing = presets.filter((p) => config[p.name] === undefined || (p.name === "t3code" && (!config[p.name].url && (config[p.name].command !== p.config.command || JSON.stringify(config[p.name].args ?? []) !== JSON.stringify(p.config.args ?? [])))));
    presetsBox.replaceChildren(
      ...missing.map((p) =>
        h(
          "section.mcp-preset",
          { "aria-label": p.title },
          h("div", null, h("strong", null, p.title), h("p.hint", null, p.description), p.problem ? h("p.hint", null, icon("warn", 12), " ", p.problem) : null),
          h("button.btn.sm", { type: "button", on: { click: () => editServer(config[p.name] ? p.name : undefined, p) } }, icon("plus", 14), config[p.name] ? "Switch to local T3 Code bridge" : "Add"),
        ),
      ),
    );
    bridgeBox.replaceChildren(
      ...(bridge
        ? [
            h(
              "section.mcp-preset",
              { "aria-label": "Talk to this Spencer from other agents" },
              h(
                "div",
                null,
                h("strong", null, "Talk to this Spencer from other agents"),
                h("p.hint", null, "Add this stdio MCP server to T3 Code threads, Claude Code, Codex or Copilot: they can ask your Spencer things, read its channels and post in them as you."),
                h("pre.mcp-cmd", null, h("code", null, JSON.stringify({ spencer: bridge }, null, 2))),
              ),
              h(
                "button.btn.sm",
                { type: "button", on: { click: async () => toast((await copyText(JSON.stringify({ spencer: bridge }, null, 2))) ? "Copied" : "Copy failed", "info") } },
                icon("copy", 14),
                "Copy",
              ),
            ),
          ]
        : []),
    );
    if (!S.mcp.length) {
      list.replaceChildren(emptyState({ icon: "plug", title: "No MCP servers yet", text: "Add one with Add server, or pick a ready-made one above." }));
      return;
    }
    list.replaceChildren(
      ...S.mcp.map((s) => {
        const saved = config[s.name];
        const enabled = h("input", { type: "checkbox", checked: s.status !== "disabled", "aria-label": `${s.name} enabled`, on: { change: (e) => toggle(s.name, e.target.checked) } });
        return h(
          "section.mcp-card",
          { "aria-label": s.name },
          h(
            "div.mcp-head",
            null,
            h(`span.dot.${s.status}`, { "aria-hidden": "true" }),
            h("h2", null, s.name),
            h("span.pill.muted", null, s.transport),
            s.events ? h(`span.pill.${s.events.status === "supported" ? "ok" : s.events.status === "revoked" ? "bad" : s.events.status === "error" ? "attn" : "muted"}`, { title: s.events.error ?? "MCP Events" }, s.events.status === "supported" ? `events: ${s.events.eventCount ?? 0}` : s.events.status === "revoked" ? "events: revoked" : s.events.status === "error" ? "events: error" : "events: off") : null,
            h(`span.mcp-status.${s.status}`, null, STATUS_TEXT[s.status] ?? s.status),
            h("span.mcp-count", null, toolCount(s.tools ?? [])),
          ),
          saved ? h("p.mcp-cmdline", { title: describe(saved) }, describe(saved)) : null,
          s.error ? h("p.xfer-error", null, s.error) : null,
          s.tools?.length
            ? h(
                "ul.mcp-tools",
                null,
                s.tools.map((t) => {
                  const label = t.name.replace(/^mcp__.+?__/, "").replace(/_/g, " ");
                  const desc = t.description ? h("span.check-desc", null, t.description) : null;
                  if (!saved) return h("li", null, h("code", { title: t.name }, label), desc);
                  const box = h("input", {
                    type: "checkbox",
                    checked: t.enabled !== false,
                    "aria-label": `Allow ${label}`,
                    on: { change: (e) => toggleTool(s.name, t.remote ?? t.name, e.target.checked) },
                  });
                  return h(`li${t.enabled === false ? ".off" : ""}`, null, h("label.check", null, box, h("code", { title: t.name }, label)), desc);
                }),
              )
            : null,
          saved
            ? h(
                "div.mcp-actions",
                null,
                h("label.check", null, enabled, h("span", null, "Enabled")),
                h("button.btn.sm", { type: "button", on: { click: () => editServer(s.name) } }, "Edit"),
                removeBtn(s.name),
              )
            : null,
        );
      }),
    );
  };
  render();
  attempt(() => api.mcp()).then(apply);
  return { destroy: on("mcp", render) };
}

function toolCount(tools) {
  const off = tools.filter((t) => t.enabled === false).length;
  const n = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
  return off ? `${n}, ${off} off` : n;
}

function lines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** "KEY=value" (or "Name: value") lines to an object. */
function pairs(text, sep) {
  const out = {};
  for (const l of lines(text)) {
    const i = l.indexOf(sep);
    if (i <= 0) throw new Error(`"${l}" needs ${sep === "=" ? "KEY=value" : "Name: value"}`);
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

function quote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a);
}
