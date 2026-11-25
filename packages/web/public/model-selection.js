import { h } from "./dom.js";
import { modelPickerProviders } from "./model-picker.js";

export function renderModelSelection(container, status, selection, { busy = false, onSwitch, rerender }) {
  const eligible = modelPickerProviders(status);
  const selectedProvider = eligible.find((provider) => provider.id === selection.provider);
  const unavailable = !!selection.provider && !selectedProvider;
  const providerOptions = eligible.map((provider) => h("option", { value: provider.id, selected: provider.id === selection.provider }, provider.name));
  if (unavailable) providerOptions.unshift(h("option", { value: selection.provider, selected: true, disabled: true }, `${selection.provider} (temporarily unavailable)`));
  const providerSelect = h("select.input.model-select", {
    "aria-label": "Provider",
    disabled: busy,
    on: { change: (event) => {
      selection.provider = event.target.value;
      selection.modelId = "";
      selection.filter = "";
      const provider = eligible.find((item) => item.id === selection.provider);
      const setup = provider?.customSetup;
      selection.setupBaseUrl = typeof setup?.baseUrl === "string" ? setup.baseUrl : undefined;
      selection.baseUrl = selection.setupBaseUrl ?? "";
      selection.baseUrlDirty = false;
      selection.thinking = "off";
      rerender();
    } },
  }, [h("option", { value: "", selected: !selection.provider }, "Choose a provider…"), ...providerOptions]);

  const models = selectedProvider?.id === "github-copilot" ? status.copilot?.models ?? [] : selectedProvider?.models ?? [];
  const q = String(selection.filter ?? "").trim().toLowerCase();
  const filtered = q ? models.filter((item) => item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)) : models;
  const custom = !!selectedProvider?.custom;
  let switchButton;
  const model = custom
    ? h("input.input.mono", { type: "text", "aria-label": "Model", placeholder: "Enter model ID…", value: selection.modelId, disabled: busy || !selectedProvider || unavailable, on: { input: (event) => { selection.modelId = event.target.value; if (switchButton) switchButton.disabled = !canSwitch(); } } })
    : h("select.input.model-select", {
        "aria-label": "Model",
        disabled: busy || !selectedProvider || unavailable || !filtered.length,
        on: { change: (event) => { selection.modelId = event.target.value; if (selectedProvider?.id === "github-copilot" && /^claude-/i.test(selection.modelId) && selection.thinking === "off") selection.thinking = "medium"; rerender(); } },
      }, [h("option", { value: "", selected: !selection.modelId }, selectedProvider ? "Choose a model…" : "Choose a provider first…"), ...filtered.map((item) => h("option", { value: item.id, selected: item.id === selection.modelId }, item.name === item.id ? item.id : `${item.name} (${item.id})`))]);
  const filter = !custom && models.length > 15 ? h("input.input.model-filter", {
    type: "search", placeholder: `Filter ${models.length} models…`, value: selection.filter ?? "", disabled: busy,
    on: { input: (event) => { selection.filter = event.target.value; const pos = event.target.selectionStart; rerender(); const again = container.querySelector(".model-filter"); if (again) { again.focus(); if (pos !== null) again.setSelectionRange(pos, pos); } } },
  }) : null;
  const selectedUnavailable = !!selection.modelId && !custom && !models.some((item) => item.id === selection.modelId);
  const selectedFilteredOut = !!selection.modelId && !custom && !selectedUnavailable && !filtered.some((item) => item.id === selection.modelId);
  const claude = selectedProvider?.id === "github-copilot" && /^claude-/i.test(selection.modelId);
  const thinking = h("select.input.model-select", { "aria-label": "Thinking effort", disabled: busy || !selectedProvider || unavailable,
    on: { change: (event) => { selection.thinking = event.target.value; } },
  }, [["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]
    .filter(([value]) => !claude || value !== "off")
    .map(([value, label]) => h("option", { value, selected: selection.thinking === value || (claude && selection.thinking === "off" && value === "medium") }, label)));

  const setup = selectedProvider?.customSetup;
  const initialUrl = selection.baseUrl || setup?.baseUrl || "";
  const canSwitch = () => !!selectedProvider && !unavailable && !!selection.modelId.trim() && !selectedUnavailable && !selectedFilteredOut && (!custom || !!(selection.baseUrl || initialUrl).trim());
  const baseUrl = custom && (!setup?.ready || selection.baseUrlDirty)
    ? h("input.input.mono", { type: "url", "aria-label": "Base URL", placeholder: "http://localhost:11434/v1", value: selection.baseUrl || initialUrl, disabled: busy || unavailable,
        on: { input: (event) => { selection.baseUrl = event.target.value; selection.baseUrlDirty = true; if (switchButton) switchButton.disabled = !canSwitch(); } } })
    : null;
  container.replaceChildren(h("form.model-form", { on: { submit: (event) => {
    event.preventDefault();
    if (!canSwitch()) return;
    const endpoint = selection.baseUrl || initialUrl;
    onSwitch(selectedProvider.id, selection.modelId.trim(), {
      thinking: claude && selection.thinking === "off" ? "medium" : selection.thinking,
      ...(custom ? { baseUrl: endpoint.trim(), ...(setup?.apiKeyEnv && endpoint.trim() === setup.baseUrl ? { apiKeyEnv: setup.apiKeyEnv } : {}) } : {}),
    });
  } } },
    h("div.model-row", null,
      h("label.model-pick-label", null, "Provider", providerSelect),
      h("label.model-pick-label", { class: !selectedProvider ? "model-disabled" : undefined }, "Model", filter ? h("div.model-pick-stack", null, filter, model) : model),
      h("label.model-pick-label.sm", null, "Thinking effort", thinking)),
    !selectedProvider ? h("p.muted", null, "Choose a ready provider to see its models.") : null,
    unavailable ? h("p.model-error", null, "This provider is temporarily unavailable. Your choice is preserved until it returns.") : null,
    selectedUnavailable ? h("p.model-error", null, `Selected model ${selection.modelId} is no longer available.`) : null,
    selectedFilteredOut ? h("p.muted", null, "Selected model does not match the filter. Choose a visible model before switching.") : null,
    baseUrl ? h("label.model-pick-label", null, "Base URL", baseUrl) : null,
    custom && setup?.ready ? h("p.muted", null, "Endpoint setup is ready. Set up access below to change it.") : null,
    h("div.model-actions", null, (switchButton = h("button.btn.primary", { type: "submit", disabled: busy || !canSwitch() }, "Switch")))));
}
