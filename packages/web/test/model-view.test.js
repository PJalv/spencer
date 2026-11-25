import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  Node: browser.Node,
  Event: browser.Event,
  MutationObserver: browser.MutationObserver,
  KeyboardEvent: browser.KeyboardEvent,
  localStorage: browser.localStorage,
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { modelView } = await import("../public/model.js");
const { S, setModel: publishModel } = await import("../public/state.js");
const { api } = await import("../public/api.js");
globalThis.setInterval = realSetInterval;

const provider = (id, name, extra = {}) => ({ id, name, models: [{ id: `${id}-model`, name: `${name} model` }], ...extra });
const status = () => ({
  provider: "anthropic", modelId: "anthropic-model", ready: true,
  providers: [
    provider("anthropic", "Anthropic", { hasEnvKey: true, defaultApiKeyEnv: "ANTHROPIC_API_KEY" }),
    provider("openai", "OpenAI", { hasEnvKey: false, hasSavedKey: false, defaultApiKeyEnv: "OPENAI_API_KEY" }),
    provider("github-copilot", "GitHub Copilot"),
    provider("openai-compatible", "OpenAI-compatible", { custom: true, hasSavedKey: false, hasEnvKey: false }),
  ],
  copilot: { connected: false, models: [], deviceLogin: true, cliAccounts: [] },
});

function mount(model = status()) {
  S.model = model;
  const main = document.createElement("main");
  document.body.append(main);
  return { main, view: modelView(main) };
}

test("Model and Auth remain separate; saving provider credentials does not switch the active model", async () => {
  const originalModel = api.model;
  const originalSave = api.saveProviderAuth;
  const originalSwitch = api.setModel;
  const calls = [];
  let switches = 0;
  api.model = async () => S.model;
  api.saveProviderAuth = async (providerId, options) => {
    calls.push({ providerId, options });
    return { ...S.model, providers: S.model.providers.map((item) => item.id === providerId ? { ...item, hasSavedKey: true } : item) };
  };
  api.setModel = async () => { switches++; throw new Error("Auth Save must not switch models"); };
  const { main, view } = mount();
  try {
    const picker = main.querySelector('[aria-labelledby="picker-title"]');
    const auth = main.querySelector('[aria-labelledby="auth-title"]');
    assert.equal(picker.querySelector('[aria-label="Provider"]').value, "", "Model selection starts without an implicit choice");
    assert.equal(picker.querySelector('[aria-label="API key"]'), null, "the model picker has no authentication fields");
    assert.equal(auth.querySelector('[aria-label="Model"]'), null, "Auth has no model selection field");
    assert.equal(main.querySelector("#copilot-title").hidden, true, "Copilot authentication is hidden unless selected in Auth");
    assert.equal(auth.querySelector('button[type="submit"]').textContent, "Save");

    const authProvider = auth.querySelector('[aria-label="Authentication provider"]');
    authProvider.value = "github-copilot";
    authProvider.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(main.querySelector("#copilot-title").hidden, false, "Copilot controls are shown only for the Copilot Auth choice");
    const refreshedAuthProvider = auth.querySelector('[aria-label="Authentication provider"]');
    refreshedAuthProvider.value = "openai";
    refreshedAuthProvider.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(main.querySelector("#copilot-title").hidden, true);

    const key = auth.querySelector('[aria-label="API key"]');
    key.value = "synthetic-openai-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    publishModel({ ...S.model, error: "synthetic background model event" });
    assert.equal(auth.querySelector('[aria-label="API key"]').value, "synthetic-openai-key", "model events preserve unsaved Auth drafts");
    auth.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    assert.deepEqual(calls, [{ providerId: "openai", options: { apiKey: "synthetic-openai-key" } }]);
    assert.equal(switches, 0);
    assert.equal(S.model.provider, "anthropic");
    assert.equal(S.model.modelId, "anthropic-model");
  } finally {
    view.destroy();
    main.remove();
    api.model = originalModel;
    api.saveProviderAuth = originalSave;
    api.setModel = originalSwitch;
  }
});

test("picker filters unavailable providers and switches only after an explicit choice", async () => {
  const originalModel = api.model;
  const originalSwitch = api.setModel;
  const switches = [];
  api.model = async () => S.model;
  api.setModel = async (providerId, modelId, options) => {
    switches.push({ providerId, modelId, options });
    return { ...S.model, provider: providerId, modelId };
  };
  const { main, view } = mount();
  try {
    const picker = main.querySelector('[aria-labelledby="picker-title"]');
    const providerSelect = picker.querySelector('[aria-label="Provider"]');
    assert.deepEqual([...providerSelect.options].map((option) => option.value), ["", "anthropic"], "unconfigured and signed-out providers are filtered out");
    providerSelect.value = "anthropic";
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const modelSelect = picker.querySelector('[aria-label="Model"]');
    assert.equal(modelSelect.options[1].value, "anthropic-model");
    modelSelect.value = "anthropic-model";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    picker.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(switches.length, 1);
    assert.equal(switches[0].providerId, "anthropic");
    assert.equal(switches[0].modelId, "anthropic-model");
    assert.equal(S.model.modelId, "anthropic-model");
  } finally {
    view.destroy();
    main.remove();
    api.model = originalModel;
    api.setModel = originalSwitch;
  }
});

test("filtering out the selected draft model disables Switch until a visible model is chosen", async () => {
  const initial = status();
  initial.providers.find((item) => item.id === "anthropic").models = Array.from({ length: 16 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
  const originalModel = api.model;
  const originalSwitch = api.setModel;
  const switches = [];
  api.model = async () => S.model;
  api.setModel = async (providerId, modelId) => {
    switches.push({ providerId, modelId });
    return { ...S.model, provider: providerId, modelId };
  };
  const { main, view } = mount(initial);
  try {
    const picker = main.querySelector('[aria-labelledby="picker-title"]');
    const providerSelect = picker.querySelector('[aria-label="Provider"]');
    providerSelect.value = "anthropic";
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    let modelSelect = picker.querySelector('[aria-label="Model"]');
    modelSelect.value = "model-0";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const filter = picker.querySelector(".model-filter");
    filter.value = "model-1";
    filter.dispatchEvent(new Event("input", { bubbles: true }));

    const switchButton = picker.querySelector('button[type="submit"]');
    assert.equal(switchButton.disabled, true);
    assert.match(picker.textContent, /Selected model does not match the filter/);
    picker.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(switches, []);

    modelSelect = picker.querySelector('[aria-label="Model"]');
    modelSelect.value = "model-1";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(picker.querySelector('button[type="submit"]').disabled, false);
    picker.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(switches, [{ providerId: "anthropic", modelId: "model-1" }]);
    assert.equal(S.model.modelId, "model-1");
  } finally {
    view.destroy();
    main.remove();
    api.model = originalModel;
    api.setModel = originalSwitch;
  }
});

test("custom Auth uses an endpoint draft and disabled Save for unrememberable URLs", () => {
  const { main, view } = mount();
  try {
    const auth = main.querySelector('[aria-labelledby="auth-title"]');
    const select = auth.querySelector('[aria-label="Authentication provider"]');
    select.value = "openai-compatible";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const endpoint = auth.querySelector('[aria-label="Base URL"]');
    endpoint.value = "https://models.example.test/v1?api-version=synthetic";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    assert.match(auth.textContent, /Only ordinary HTTP\(S\) URLs/);
    assert.equal(auth.querySelector('button[type="submit"]').disabled, true);
    assert.equal(S.model.provider, "anthropic");
  } finally {
    view.destroy();
    main.remove();
  }
});

test("changing Auth endpoint invalidates stale picker models and preserves drafts only for the same endpoint", async () => {
  const endpointA = "http://localhost:11434/v1";
  const endpointB = "https://models.example.test/v1";
  const initial = status();
  const customProvider = initial.providers.find((item) => item.id === "openai-compatible");
  customProvider.customSetup = { baseUrl: endpointA, authMode: "keyless", ready: true };
  const originalModel = api.model;
  const originalSave = api.saveProviderAuth;
  const originalSwitch = api.setModel;
  const authSaves = [];
  const switches = [];
  let hasSavedKey = false;
  let customSetup = { ...customProvider.customSetup };
  const withCustomSetup = (model) => ({
    ...model,
    providers: model.providers.map((item) => item.id === "openai-compatible"
      ? { ...item, hasSavedKey, customSetup: { ...customSetup } }
      : item),
  });
  api.model = async () => S.model;
  api.saveProviderAuth = async (providerId, options) => {
    authSaves.push({ providerId, options });
    if (options.clearApiKey) hasSavedKey = false;
    if (options.apiKey) hasSavedKey = true;
    customSetup = {
      baseUrl: options.baseUrl,
      authMode: hasSavedKey ? "credentialed" : options.clearApiKeyEnv ? "keyless" : "unavailable",
      ready: hasSavedKey || !!options.clearApiKeyEnv,
    };
    return withCustomSetup(S.model);
  };
  api.setModel = async (providerId, modelId, options) => {
    switches.push({ providerId, modelId, options });
    return withCustomSetup({ ...S.model, provider: providerId, modelId, baseUrl: options.baseUrl, ready: true });
  };
  const { main, view } = mount(initial);
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await Promise.resolve(); };
  try {
    const picker = main.querySelector('[aria-labelledby="picker-title"]');
    const pickerProvider = picker.querySelector('[aria-label="Provider"]');
    pickerProvider.value = "openai-compatible";
    pickerProvider.dispatchEvent(new Event("change", { bubbles: true }));
    let modelId = picker.querySelector('[aria-label="Model"]');
    modelId.value = "synthetic-model-a";
    modelId.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(picker.querySelector('button[type="submit"]').disabled, false);

    const auth = main.querySelector('[aria-labelledby="auth-title"]');
    const authProvider = auth.querySelector('[aria-label="Authentication provider"]');
    authProvider.value = "openai-compatible";
    authProvider.dispatchEvent(new Event("change", { bubbles: true }));
    let keyless = auth.querySelector('input[type="checkbox"]');
    keyless.checked = false;
    keyless.dispatchEvent(new Event("change", { bubbles: true }));
    const authEndpoint = auth.querySelector('[aria-label="Base URL"]');
    authEndpoint.value = endpointB;
    authEndpoint.dispatchEvent(new Event("input", { bubbles: true }));
    const apiKey = auth.querySelector('[aria-label="API key"]');
    apiKey.value = "synthetic-provider-key";
    apiKey.dispatchEvent(new Event("input", { bubbles: true }));
    auth.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    assert.deepEqual(authSaves[0], {
      providerId: "openai-compatible",
      options: { baseUrl: endpointB, clearApiKeyEnv: true, apiKey: "synthetic-provider-key" },
    });
    assert.equal(S.model.provider, "anthropic", "Auth-only saves keep the active model unchanged");
    assert.equal(S.model.modelId, "anthropic-model");
    modelId = picker.querySelector('[aria-label="Model"]');
    assert.equal(modelId.value, "", "a model draft bound to endpoint A is invalidated when Auth saves endpoint B");
    assert.equal(picker.querySelector('[aria-label="Base URL"]'), null, "ready setup keeps its URL hidden rather than retaining hidden endpoint A");
    assert.match(picker.textContent, /Endpoint setup is ready/);
    assert.equal(picker.querySelector('button[type="submit"]').disabled, true, "Switch requires selecting a model for endpoint B");
    assert.deepEqual(switches, []);

    modelId.value = "synthetic-model-b";
    modelId.dispatchEvent(new Event("input", { bubbles: true }));
    picker.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(switches[0], {
      providerId: "openai-compatible",
      modelId: "synthetic-model-b",
      options: { thinking: "off", baseUrl: endpointB },
    }, "the first explicit Switch after the Auth update targets only endpoint B");

    const remove = [...auth.querySelectorAll("button")].find((button) => button.textContent === "Remove saved key");
    assert.ok(remove, "the synthetic credential is present until explicitly removed");
    remove.click();
    await settle();
    assert.deepEqual(authSaves[1], {
      providerId: "openai-compatible",
      options: { clearApiKey: true, baseUrl: endpointB },
    });

    const refreshedModel = withCustomSetup(S.model);
    publishModel({ ...refreshedModel, error: "synthetic refresh event" });
    const refreshedCustomProvider = auth.querySelector('[aria-label="Authentication provider"]');
    refreshedCustomProvider.value = "openai-compatible";
    refreshedCustomProvider.dispatchEvent(new Event("change", { bubbles: true }));
    keyless = auth.querySelector('input[type="checkbox"]');
    keyless.checked = true;
    keyless.dispatchEvent(new Event("change", { bubbles: true }));
    auth.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(authSaves[2], {
      providerId: "openai-compatible",
      options: { baseUrl: endpointB, clearApiKeyEnv: true },
    });

    modelId = picker.querySelector('[aria-label="Model"]');
    assert.equal(modelId.value, "synthetic-model-b", "key removal and same-endpoint refresh preserve a draft bound to endpoint B");
    assert.equal(picker.querySelector('button[type="submit"]').disabled, false);
    picker.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(switches[1], {
      providerId: "openai-compatible",
      modelId: "synthetic-model-b",
      options: { thinking: "off", baseUrl: endpointB },
    });
  } finally {
    view.destroy();
    main.remove();
    api.model = originalModel;
    api.saveProviderAuth = originalSave;
    api.setModel = originalSwitch;
  }
});

test("keyless custom setup requires explicit removal of an existing saved key", async () => {
  const initial = status();
  initial.providers.find((item) => item.id === "openai-compatible").hasSavedKey = true;
  const originalSave = api.saveProviderAuth;
  const calls = [];
  api.saveProviderAuth = async (providerId, options) => {
    calls.push({ providerId, options });
    const customSetup = options.clearApiKey
      ? { baseUrl: options.baseUrl, authMode: "unavailable", ready: false }
      : { baseUrl: options.baseUrl, authMode: "keyless", ready: true };
    return {
      ...S.model,
      providers: S.model.providers.map((item) => item.id === providerId
        ? { ...item, hasSavedKey: !options.clearApiKey, customSetup }
        : item),
    };
  };
  const { main, view } = mount(initial);
  try {
    const auth = main.querySelector('[aria-labelledby="auth-title"]');
    const select = auth.querySelector('[aria-label="Authentication provider"]');
    select.value = "openai-compatible";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const endpoint = auth.querySelector('[aria-label="Base URL"]');
    endpoint.value = "http://localhost:11434/v1";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    let keyless = auth.querySelector('input[type="checkbox"]');
    keyless.checked = true;
    keyless.dispatchEvent(new Event("change", { bubbles: true }));
    assert.match(auth.textContent, /Remove the saved API key before saving this keyless setup/);
    assert.equal(auth.querySelector('button[type="submit"]').disabled, true);
    const remove = [...auth.querySelectorAll("button")].find((button) => button.textContent === "Remove saved key");
    assert.ok(remove);
    remove.click();
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    assert.deepEqual(calls, [{ providerId: "openai-compatible", options: { clearApiKey: true, baseUrl: "http://localhost:11434/v1" } }]);
    keyless = auth.querySelector('input[type="checkbox"]');
    assert.equal(keyless.checked, true, "removing an existing key preserves the keyless draft");
    assert.equal(auth.querySelector('[aria-label="Base URL"]').value, "http://localhost:11434/v1");
    assert.equal(auth.querySelector('button[type="submit"]').disabled, false);
    auth.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    assert.deepEqual(calls[1], { providerId: "openai-compatible", options: { baseUrl: "http://localhost:11434/v1", clearApiKeyEnv: true } });
    assert.equal(S.model.provider, "anthropic");
  } finally {
    view.destroy();
    main.remove();
    api.saveProviderAuth = originalSave;
  }
});
