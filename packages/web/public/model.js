// Model & settings view: pick any provider/model/thinking effort live, and sign in to GitHub Copilot.
import { h, icon, copyText } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, setModel, setExperimental } from "./state.js";
import { viewHeader } from "./common.js";
import { renderModelSelection } from "./model-selection.js";

const PLAN = { individual: "Copilot Pro", individual_pro: "Copilot Pro+", business: "Copilot Business", enterprise: "Copilot Enterprise", free: "Copilot Free" };
const planName = (p) => PLAN[p] ?? (p ? `Copilot ${p}` : "Copilot");

const PROVIDER = {
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  xai: "xAI",
  groq: "Groq",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible server",
  fake: "Test model",
};

const THINKING_OPTIONS = [
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

/** Model id → display name from the active provider's catalog, when known. */
export function modelName(status = S.model) {
  if (!status?.modelId) return null;
  const prov = status.providers?.find((p) => p.id === status.provider);
  return prov?.models?.find((m) => m.id === status.modelId)?.name ?? status.copilot?.models?.find((m) => m.id === status.modelId)?.name ?? status.modelId;
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function modelView(main) {
  const now = h("section.model-now", { "aria-live": "polite" });
  const picker = h("section.model-card", { "aria-labelledby": "picker-title" });
  const auth = h("section.model-card", { "aria-labelledby": "auth-title" });
  const copilotTitle = h("h2.section-title", { id: "copilot-title", hidden: true }, "GitHub Copilot authentication");
  const copilot = h("section.model-card", { "aria-labelledby": "copilot-title", hidden: true });
  const about = h("section.model-card", { "aria-labelledby": "about-title" });
  const convo = h("section.model-card", { "aria-labelledby": "convo-title" });
  const convoTitle = h("h2.section-title", { id: "convo-title" }, "Conversations model");
  const expBox = h("input", { type: "checkbox", role: "switch" });
  const experimental = h(
    "section.model-card",
    { "aria-labelledby": "exp-title" },
    h(
      "label.switch-row",
      null,
      expBox,
      h(
        "span",
        null,
        h("strong", null, "Experimental features"),
        h("span.hint.block", null, "Soul (your Spencer's personality, SOUL.md) and Conversations channels (your Spencers chill out and talk on their own). Still being worked on; they may change or use a lot of tokens."),
      ),
    ),
  );
  const renderExperimental = () => {
    expBox.checked = S.experimental;
    convoTitle.hidden = convo.hidden = !S.experimental;
  };
  expBox.addEventListener("change", async () => {
    expBox.disabled = true;
    const r = await attempt(() => api.setExperimental(expBox.checked));
    expBox.disabled = false;
    if (r && typeof r.enabled === "boolean") setExperimental(r.enabled);
    renderExperimental();
  });
  main.append(
    viewHeader([
      h("span.title-icon", { "aria-hidden": "true" }, icon("spark", 18)),
      h("div.title-stack", null, h("h1", null, "Model & settings"), h("span.subtitle", null, "Pick a provider, model, and thinking level")),
    ]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        now,
        h("h2.section-title", { id: "picker-title" }, "Model selection"),
        picker,
        h("h2.section-title", { id: "auth-title" }, "Provider authentication & setup"),
        auth,
        copilotTitle,
        copilot,
        convoTitle,
        convo,
        h("h2.section-title", { id: "exp-title" }, "Experimental"),
        experimental,
        h("h2.section-title", { id: "about-title" }, "About Spencer"),
        about,
        h("p.model-foot", null, "Changes take effect immediately without restarting Spencer. Saved API keys live in ", h("code", null, "secrets/credentials.json"), " (mode 0600), never in config.json."),
      ),
    ),
  );

  let busy = false;
  let tick = null;
  const selection = { provider: "", modelId: "", filter: "", thinking: "off", baseUrl: "", baseUrlDirty: false, setupBaseUrl: undefined };
  const authDraft = { provider: "", apiKey: "", baseUrl: "", apiKeyEnv: "", keyless: false, touched: false };
  const authProviderDrafts = new Map();
  let wasCopilotConnected = false;
  const syncCopilotSelection = (m) => {
    const connected = !!m?.copilot?.connected;
    if (!wasCopilotConnected && connected && !selection.provider && (authDraft.provider === "github-copilot" || m.provider === "github-copilot")) {
      selection.provider = "github-copilot";
      selection.modelId = "";
    }
    wasCopilotConnected = connected;
  };

  const syncCustomSelection = (m) => {
    const provider = m.providers?.find((item) => item.id === selection.provider && item.custom);
    if (!provider) return;
    const nextSetupUrl = typeof provider.customSetup?.baseUrl === "string"
      ? provider.customSetup.baseUrl
      : m.provider === provider.id && typeof m.baseUrl === "string" ? m.baseUrl : undefined;
    if (nextSetupUrl === selection.setupBaseUrl) return;

    const stillBoundToSetup = !selection.baseUrlDirty || selection.baseUrl === selection.setupBaseUrl;
    if (stillBoundToSetup) {
      selection.baseUrl = nextSetupUrl ?? "";
      selection.baseUrlDirty = false;
    }
    selection.modelId = "";
    selection.filter = "";
    selection.thinking = "off";
    selection.setupBaseUrl = nextSetupUrl;
  };

  const act = async (fn, successMsg, { preserveDrafts = false, clearAuthDraft = false } = {}) => {
    if (busy) return;
    busy = true;
    render();
    const r = await attempt(fn);
    busy = false;
    if (r && typeof r === "object" && "copilot" in r) {
      if (clearAuthDraft) {
        authDraft.apiKey = "";
        authDraft.touched = false;
        authProviderDrafts.delete(authDraft.provider);
      }
      if (!preserveDrafts) {
        syncCopilotSelection(r);
        syncConvoDraft(r, true);
      }
      setModel(r);
      if (successMsg) toast(typeof successMsg === "function" ? successMsg(r) : successMsg, "info");
    } else render();
    return r;
  };

  const refreshCopilot = () =>
    act(
      () => api.copilotRefresh(),
      (r) => `Refreshed ${r.copilot?.models?.length ?? 0} GitHub Copilot models`,
    );

  const renderNow = (m) => {
    if (!m) return now.replaceChildren(h("p.muted", null, "Loading…"));
    const name = modelName(m);
    const provName = m.providers?.find((p) => p.id === m.provider)?.name ?? PROVIDER[m.provider] ?? m.provider;
    now.replaceChildren(
      h(`span.dot.${m.ready ? "connected" : "error"}`, { "aria-hidden": "true" }),
      h(
        "div.model-now-text",
        null,
        h("div.model-now-name", null, name ?? "No model"),
        h(
          "div.model-now-sub",
          null,
          provName ? `via ${provName}` : null,
          m.thinking && m.thinking !== "off" ? h("span.pill.muted", null, `thinking: ${m.thinking}`) : null,
          m.ready ? h("span.pill.ok", null, "Ready") : h("span.pill.bad", null, "Not ready"),
        ),
        !m.ready && m.error ? h("p.model-error", null, m.error.replace(/^./, (c) => c.toUpperCase())) : null,
      ),
    );
  };

  const renderPicker = (m) => renderModelSelection(picker, m, selection, {
    busy,
    rerender: () => renderPicker(S.model),
    onSwitch: (provider, modelId, options) => void act(() => api.setModel(provider, modelId, options), `Switched model to ${modelId}`),
  });

  const renderAuth = (m) => {
    const providers = m.providers ?? [];
    if (!authDraft.provider) authDraft.provider = providers.some((provider) => provider.id === m.provider) ? m.provider : providers[0]?.id ?? "";
    const provider = providers.find((item) => item.id === authDraft.provider);
    const isCopilot = provider?.id === "github-copilot";
    copilotTitle.hidden = copilot.hidden = !isCopilot;
    if (isCopilot) copilot.replaceChildren(m.copilot?.connected ? connectedBox(m) : signInBox(m.copilot));
    if (!provider) {
      auth.replaceChildren(h("p.muted", null, "No providers available."));
      return;
    }
    if (provider.custom && !authDraft.touched) {
      authDraft.baseUrl = provider.customSetup?.baseUrl ?? (m.provider === provider.id ? m.baseUrl ?? "" : "");
      authDraft.apiKeyEnv = provider.customSetup?.apiKeyEnv ?? (m.provider === provider.id ? m.apiKeyEnv ?? "" : "");
      authDraft.keyless = provider.customSetup?.authMode === "keyless";
    }
    const providerSelect = h("select.input.model-select", { "aria-label": "Authentication provider", disabled: busy,
      on: { change: (event) => {
        authProviderDrafts.set(authDraft.provider, { ...authDraft });
        authDraft.provider = event.target.value;
        Object.assign(authDraft, authProviderDrafts.get(authDraft.provider) ?? { provider: authDraft.provider, apiKey: "", baseUrl: "", apiKeyEnv: "", keyless: false, touched: false });
        renderAuth(m);
      } },
    }, providers.map((item) => h("option", { value: item.id, selected: item.id === provider.id }, item.name)));
    const isCustom = !!provider.custom;
    const customUrl = String(authDraft.baseUrl ?? "").trim();
    let safeUrl = false;
    if (isCustom && customUrl) {
      try {
        const parsed = new URL(customUrl);
        const authority = customUrl.match(/^https?:\/\/([^/?#]*)/i)?.[1];
        safeUrl = (parsed.protocol === "http:" || parsed.protocol === "https:") && !!authority && !authority.includes("@") && !parsed.username && !parsed.password && !customUrl.includes("?") && !customUrl.includes("#");
      } catch {}
    }
    const hasKey = () => !!authDraft.apiKey.trim();
    const canSave = () => !busy && !isCopilot && (isCustom
      ? safeUrl && (authDraft.keyless ? !provider.hasSavedKey : hasKey() || provider.hasSavedKey || !!authDraft.apiKeyEnv.trim())
      : hasKey());
    let saveButton;
    const fields = [];
    if (isCustom) {
      fields.push(h("label.model-pick-label", null, "Base URL", h("input.input.mono", {
        type: "text", inputmode: "url", "aria-label": "Base URL", placeholder: "http://localhost:11434/v1", value: authDraft.baseUrl, disabled: busy,
        on: { input: (event) => {
          authDraft.baseUrl = event.target.value;
          authDraft.touched = true;
          const start = event.target.selectionStart;
          const end = event.target.selectionEnd;
          renderAuth(m);
          const again = auth.querySelector('[aria-label="Base URL"]');
          if (again) { again.focus(); if (start !== null && end !== null) again.setSelectionRange(start, end); }
        } },
      })));
      fields.push(h("label.model-pick-label", null, "API key environment variable (optional)", h("input.input.mono", {
        type: "text", "aria-label": "API key environment variable", placeholder: "SPENCER_CUSTOM_MODEL_KEY", value: authDraft.apiKeyEnv, disabled: busy || authDraft.keyless,
        on: { input: (event) => { authDraft.apiKeyEnv = event.target.value; authDraft.touched = true; if (saveButton) saveButton.disabled = !canSave(); } },
      })));
      fields.push(h("label.switch-row", null, h("input", { type: "checkbox", checked: authDraft.keyless, disabled: busy,
        on: { change: (event) => { authDraft.keyless = event.target.checked; if (authDraft.keyless) authDraft.apiKeyEnv = ""; authDraft.touched = true; renderAuth(m); } },
      }), h("span", null, "This endpoint does not require an API key (keyless setup)")));
      if (authDraft.keyless && provider.hasSavedKey) fields.push(h("p.signin-note", null, "Remove the saved API key before saving this keyless setup."));
      if (customUrl && !safeUrl) fields.push(h("p.signin-note", null, "Only ordinary HTTP(S) URLs without user info, query strings, or fragments can be saved."));
      fields.push(h("p.muted", null, "Saving endpoint setup does not change the active model. Choose it in Model selection and select Switch when you want to use it."));
    }
    if (!isCopilot) {
      const envName = isCustom ? authDraft.apiKeyEnv : provider.defaultApiKeyEnv;
      const status = provider.hasSavedKey ? "API key saved locally (mode 0600)." : provider.hasEnvKey && envName ? `Using ${envName} from environment.` : isCustom ? "Optional for local servers such as Ollama." : envName ? `No key found in ${envName}.` : "Paste an API key if required.";
      const keyInput = h("input.input.mono", { type: "password", autocomplete: "off", "aria-label": "API key", placeholder: provider.hasSavedKey ? "Enter a new key to replace the saved key…" : "Paste API key…", value: authDraft.apiKey, disabled: busy || (isCustom && authDraft.keyless), on: { input: (event) => { authDraft.apiKey = event.target.value; authDraft.touched = true; if (saveButton) saveButton.disabled = !canSave(); } } });
      fields.push(
        h(
          "div.model-key-block",
          null,
          h("label.model-pick-label", null, isCustom ? "API key (optional)" : "API key", keyInput),
          h(
            "div.model-key-status",
            null,
            h("span", null, status),
            provider.hasSavedKey
              ? h("button.btn.sm.ghost", {
                  type: "button",
                  disabled: busy,
                  on: { click: () => void act(
                    () => api.saveProviderAuth(provider.id, { clearApiKey: true, ...(isCustom ? { baseUrl: customUrl, ...(authDraft.apiKeyEnv.trim() ? { apiKeyEnv: authDraft.apiKeyEnv.trim() } : {}) } : {}) }),
                    "Saved API key removed",
                    { preserveDrafts: true },
                  ) },
                }, "Remove saved key")
              : null,
          ),
        ),
      );
    }
    const save = isCopilot ? null : (saveButton = h("button.btn.primary", { type: "submit", disabled: !canSave() }, "Save"));
    auth.replaceChildren(h("p.muted", null, "Set up provider access here without changing the active model."), h("form.model-form", { on: { submit: (event) => {
      event.preventDefault();
      if (isCopilot || !canSave()) return;
      const options = isCustom
        ? { baseUrl: customUrl, ...(authDraft.apiKeyEnv.trim() ? { apiKeyEnv: authDraft.apiKeyEnv.trim() } : { clearApiKeyEnv: true }), ...(!authDraft.keyless && hasKey() ? { apiKey: authDraft.apiKey.trim() } : {}) }
        : { apiKey: authDraft.apiKey.trim() };
      void act(() => api.saveProviderAuth(provider.id, options), isCustom ? "Saved endpoint setup" : `Saved ${provider.name} access`, { preserveDrafts: true, clearAuthDraft: true });
    } } }, h("div.model-row", null, h("label.model-pick-label", null, "Provider", providerSelect)), ...fields, h("div.model-actions", null, save)));
  };

  // Conversations channels run constantly: they can use their own (cheaper) model. API keys are shared with provider setup above.
  const cdraft = { same: true, provider: "", modelId: "", thinking: "off", baseUrl: "", filter: "", lastKey: null };
  const syncConvoDraft = (m, force = false) => {
    const c = m.conversation;
    const key = JSON.stringify(c ?? null);
    if (!force && cdraft.lastKey === key) return;
    cdraft.lastKey = key;
    cdraft.same = !c;
    cdraft.provider = c?.provider ?? m.provider ?? "";
    cdraft.modelId = c?.modelId ?? m.modelId ?? "";
    cdraft.thinking = c?.thinking ?? "off";
    cdraft.baseUrl = c?.baseUrl ?? m.baseUrl ?? "";
  };

  const renderConvo = (m) => {
    const providers = (m.providers ?? []).filter((p) => p.id !== "github-copilot" || m.copilot?.connected);
    const c = m.conversation;
    const status = c
      ? h(
          "p.model-convo-status",
          null,
          h(`span.dot.${c.ready ? "connected" : "error"}`, { "aria-hidden": "true" }),
          ` ${providers.find((p) => p.id === c.provider)?.name ?? PROVIDER[c.provider] ?? c.provider} · ${c.modelId ?? "default"}`,
          c.thinking && c.thinking !== "off" ? h("span.pill.muted", null, `thinking: ${c.thinking}`) : null,
          c.ready ? null : h("span.pill.bad", null, "Not ready: using the main model"),
          !c.ready && c.error ? h("span.model-error", null, ` ${c.error}`) : null,
        )
      : h("p.model-convo-status.muted", null, "Using the main model.");
    const sameBox = h("input", {
      type: "checkbox",
      role: "switch",
      checked: cdraft.same,
      disabled: busy,
      on: {
        change: (e) => {
          cdraft.same = e.target.checked;
          renderConvo(m);
        },
      },
    });
    const fields = [];
    if (!cdraft.same) {
      if (!providers.some((p) => p.id === cdraft.provider)) cdraft.provider = providers[0]?.id ?? "";
      const prov = providers.find((p) => p.id === cdraft.provider);
      const allModels = prov?.models ?? [];
      const q = cdraft.filter.trim().toLowerCase();
      const models = q ? allModels.filter((x) => x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)) : allModels;
      if (prov && !prov.custom && models.length && !models.some((x) => x.id === cdraft.modelId)) cdraft.modelId = models[0].id;
      // Copilot's Claude models refuse requests with thinking off (see the main picker).
      const copilotClaude = cdraft.provider === "github-copilot" && /^claude-/i.test(cdraft.modelId);
      if (copilotClaude && cdraft.thinking === "off") cdraft.thinking = "medium";
      const filterInput =
        !prov?.custom && allModels.length > 15
          ? h("input.input.model-filter", {
              type: "search",
              placeholder: `Filter ${allModels.length} models…`,
              value: cdraft.filter,
              disabled: busy,
              on: {
                input: (e) => {
                  cdraft.filter = e.target.value;
                  const pos = e.target.selectionStart;
                  renderConvo(m);
                  const again = convo.querySelector(".model-filter");
                  if (again) {
                    again.focus();
                    if (pos !== null) again.setSelectionRange(pos, pos);
                  }
                },
              },
            })
          : null;
      fields.push(
        h(
          "div.model-row",
          null,
          h(
            "label.model-pick-label",
            null,
            "Provider",
            h(
              "select.input.model-select",
              { disabled: busy, on: { change: (e) => ((cdraft.provider = e.target.value), (cdraft.modelId = ""), (cdraft.filter = ""), renderConvo(m)) } },
              providers.map((p) => h("option", { value: p.id, selected: p.id === cdraft.provider }, p.name)),
            ),
          ),
          h(
            "label.model-pick-label.sm",
            null,
            "Thinking",
            h(
              "select.input.model-select",
              { disabled: busy, on: { change: (e) => (cdraft.thinking = e.target.value) } },
              THINKING_OPTIONS.filter(([v]) => !copilotClaude || v !== "off").map(([v, label]) => h("option", { value: v, selected: cdraft.thinking === v }, label)),
            ),
          ),
        ),
        prov?.custom
          ? [
              h("label.model-pick-label", null, "Model ID", h("input.input.mono", { type: "text", value: cdraft.modelId, disabled: busy, on: { input: (e) => (cdraft.modelId = e.target.value) } })),
              h("label.model-pick-label", null, "Base URL", h("input.input.mono", { type: "url", placeholder: "http://localhost:11434/v1", value: cdraft.baseUrl, disabled: busy, on: { input: (e) => (cdraft.baseUrl = e.target.value) } })),
            ]
          : h(
              "label.model-pick-label",
              null,
              "Model",
              filterInput,
              h(
                "select.input.model-select",
                { disabled: busy || !models.length, on: { change: (e) => ((cdraft.modelId = e.target.value), renderConvo(m)) } },
                models.length ? models.map((x) => h("option", { value: x.id, selected: x.id === cdraft.modelId }, x.name === x.id ? x.id : `${x.name} (${x.id})`)) : h("option", { value: "" }, "No models available"),
              ),
            ),
      );
    }
    const save = h("button.btn.primary", { type: "submit", disabled: busy || (cdraft.same && !c) }, "Save");
    const form = h(
      "form.model-form",
      {
        on: {
          submit: (e) => {
            e.preventDefault();
            if (cdraft.same) return void act(() => api.setConversationModel(null), "Conversations use the main model");
            const mid = cdraft.modelId.trim();
            if (!mid) return toast("Pick or enter a model ID");
            const prov = providers.find((p) => p.id === cdraft.provider);
            if (prov?.custom && !cdraft.baseUrl.trim()) return toast("Base URL is required for OpenAI-compatible servers");
            const claude = cdraft.provider === "github-copilot" && /^claude-/i.test(mid);
            const opts = { thinking: claude && cdraft.thinking === "off" ? "medium" : cdraft.thinking, ...(prov?.custom ? { baseUrl: cdraft.baseUrl.trim() } : {}) };
            void act(() => api.setConversationModel(cdraft.provider, mid, opts), `Conversations now use ${mid}`);
          },
        },
      },
      h("p.hint", null, "Conversations channels chat all day, so they can use a different (cheaper) model. API keys come from the picker above."),
      status,
      h("label.switch-row", null, sameBox, h("span", null, "Same as the main model")),
      ...fields,
      h("div.model-actions", null, save),
    );
    convo.replaceChildren(form);
  };

  const signInBox = (c) => {
    const si = c.signIn;
    if (si?.state === "waiting") {
      const left = h("span.model-countdown");
      const update = () => (left.textContent = si.expiresAt ? `The code expires in ${mmss(si.expiresAt - Date.now())}.` : "");
      update();
      clearInterval(tick);
      tick = setInterval(update, 1000);
      return h(
        "div.device",
        null,
        h("p.device-step", null, "Enter this code on GitHub to let Spencer use your Copilot:"),
        h(
          "div.device-code-row",
          null,
          h("code.device-code", { "aria-label": `Code ${si.userCode.split("").join(" ")}` }, si.userCode),
          h(
            "button.btn.sm",
            {
              type: "button",
              on: { click: async () => toast((await copyText(si.userCode)) ? "Code copied" : "Couldn't copy the code", "info") },
            },
            icon("copy", 14),
            "Copy",
          ),
        ),
        h(
          "div.device-actions",
          null,
          h("a.btn.primary", { href: si.verificationUri, target: "_blank", rel: "noopener noreferrer" }, "Open GitHub", icon("chevron", 14)),
          h("button.btn.ghost", { type: "button", on: { click: () => act(() => api.copilotCancel()) } }, "Cancel"),
        ),
        h("p.device-wait", null, h("span.device-wait-text", null, "Waiting for you to approve on GitHub. "), left),
      );
    }
    clearInterval(tick);
    if (si?.state === "connecting") return h("div.device", null, h("p.device-wait", null, h("span.device-wait-text", null, "Signed in. Checking your Copilot subscription…")));
    const deviceBtn = h(
      "button.btn.primary",
      { type: "button", disabled: busy || !c.deviceLogin, on: { click: () => act(() => api.copilotLogin()) } },
      "Sign in with GitHub",
    );
    return h(
      "div.signin",
      null,
      si?.state === "failed" ? h("p.model-error", null, si.error ?? "Sign-in failed.") : null,
      h("p.signin-lede", null, "Use the Copilot subscription you already pay for. Spencer pairs via GitHub device code, or reuses your GitHub Copilot CLI sign-in, and talks to Copilot directly."),
      h("div.signin-actions", null, ...cliButtons(c, "primary"), deviceBtn),
      c.deviceLogin ? null : h("p.signin-note", null, "Sign in with GitHub needs a GitHub OAuth app id (", h("code", null, "auth.githubClientId"), " in config.json)."),
    );
  };

  // Reuse the GitHub Copilot CLI's sign-in: GitHub's own client, which some Business/Enterprise policies give more models.
  const cliButtons = (c, kind = "") =>
    (c.cliAccounts ?? [])
      .filter((login) => !(c.connected && c.via === "copilot-cli" && c.login === login))
      .map((login) =>
        h(
          `button.btn${kind ? `.${kind}` : ".sm"}`,
          {
            type: "button",
            disabled: busy,
            on: { click: () => act(() => api.copilotCli(login), (r) => `Using the Copilot CLI sign-in: ${r.copilot?.models?.length ?? 0} models`) },
          },
          `Use Copilot CLI sign-in (@${login})`,
        ),
      );

  const connectedBox = (m) => {
    const c = m.copilot;
    const onCopilot = m.provider === "github-copilot";
    return h(
      "div.connected",
      null,
      h(
        "div.account",
        null,
        h("span.dot.connected", { "aria-hidden": "true" }),
        h("span.account-name", null, `@${c.login}`),
        h("span.pill.muted", null, planName(c.plan)),
        c.via === "copilot-cli" ? h("span.pill.muted", null, "via Copilot CLI") : null,
        h(
          "div.account-actions",
          null,
          h("button.btn.sm", { type: "button", disabled: busy, on: { click: () => void refreshCopilot() } }, "Refresh models"),
          h("button.btn.sm.ghost", { type: "button", disabled: busy, on: { click: () => act(() => api.copilotLogout(), "Signed out of GitHub Copilot") } }, "Sign out"),
        ),
      ),
      c.modelsError ? h("p.model-error", null, c.modelsError) : null,
      (() => {
        const btns = cliButtons(c);
        return btns.length ? h("div.signin-actions", null, ...btns) : null;
      })(),
      !onCopilot && c.models.length
        ? h(
            "div.signin-actions",
            null,
            h(
              "button.btn.sm",
              {
                type: "button",
                disabled: busy,
                on: {
                  click: () => {
                    selection.provider = "github-copilot";
                    selection.modelId = "";
                    selection.thinking = "off";
                    authDraft.provider = "github-copilot";
                    renderPicker(m);
                    renderAuth(m);
                  },
                },
              },
              "Select Copilot in picker above",
            ),
          )
        : null,
    );
  };

  const renderAbout = () => {
    const raw = S.version?.trim() || "";
    const verLabel = raw ? (/^\d/.test(raw) ? `v${raw}` : raw) : "Unknown";
    const rows = [
      h(
        "div.about-row",
        null,
        h("span.about-label", null, "Version"),
        h(
          "div.about-val",
          null,
          h("code.mono", null, verLabel),
          raw
            ? h(
                "button.btn.sm.ghost",
                {
                  type: "button",
                  on: { click: async () => toast((await copyText(verLabel)) ? "Version copied" : "Couldn't copy version", "info") },
                },
                icon("copy", 13),
                "Copy",
              )
            : null,
        ),
      ),
    ];
    if (S.relay?.url) {
      rows.push(h("div.about-row", null, h("span.about-label", null, "Default hub"), h("div.about-val", null, h("code.mono", null, S.relay.url))));
    }
    if (S.me?.fingerprint) {
      rows.push(h("div.about-row", null, h("span.about-label", null, "Fingerprint"), h("div.about-val", null, h("code.mono", null, S.me.fingerprint))));
    }
    about.replaceChildren(h("div.about-list", null, ...rows));
  };

  const render = () => {
    const m = S.model;
    renderNow(m);
    renderAbout();
    if (!m) {
      picker.replaceChildren();
      auth.replaceChildren();
      copilot.replaceChildren();
      copilotTitle.hidden = copilot.hidden = true;
      return;
    }
    syncCopilotSelection(m);
    syncCustomSelection(m);
    renderPicker(m);
    renderAuth(m);
    syncConvoDraft(m);
    renderConvo(m);
  };

  render();
  renderExperimental();
  attempt(() => api.model()).then((r) => r && setModel(r));
  const off = on("model", render);
  const offExp = on("experimental", renderExperimental);
  return {
    destroy: () => {
      clearInterval(tick);
      off();
      offExp();
    },
  };
}
