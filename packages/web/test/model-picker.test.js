import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelManager } from "../../spencer/src/agent/model-manager.ts";
import { resolveConfig } from "../../spencer/src/config.ts";
import { modelPickerProviders } from "../public/model-picker.js";

function customModelStatus(customSetup, baseUrl = "https://models.example.test/active/v1") {
  return {
    provider: "openai-compatible",
    modelId: "active-model",
    baseUrl,
    ready: true,
    copilot: { connected: false },
    providers: [{
      id: "openai-compatible",
      name: "OpenAI-compatible server",
      custom: true,
      hasSavedKey: false,
      hasEnvKey: false,
      ...(customSetup ? { customSetup } : {}),
      models: [],
    }],
  };
}

test("model picker does not infer keyless readiness over an explicitly unavailable custom setup", () => {
  const setup = { baseUrl: "https://models.example.test/active/v1", apiKeyEnv: "SYNTHETIC_CUSTOM_KEY", authMode: "unavailable", ready: false };
  assert.deepEqual(modelPickerProviders(customModelStatus(setup)), []);
});

test("model picker does not infer keyless readiness for URLs that cannot be remembered", () => {
  for (const baseUrl of [
    "https://models.example.test/v1?api-version=2025-01-01",
    "https://synthetic-user:synthetic-pass@models.example.test/v1",
    "https://models.example.test/v1#fragment",
  ]) assert.deepEqual(modelPickerProviders(customModelStatus(undefined, baseUrl)), []);
});

test("model picker retains configured keyless and legacy active custom endpoints", () => {
  const setup = { baseUrl: "https://models.example.test/active/v1", authMode: "keyless", ready: true };
  assert.equal(modelPickerProviders(customModelStatus(setup))[0].customSetup.authMode, "keyless");
  const legacy = modelPickerProviders(customModelStatus(undefined));
  assert.equal(legacy[0].customSetup.ready, true);
  assert.equal(legacy[0].customSetup.authMode, "keyless");
});

test("legacy active custom endpoint remains selectable after switching away", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-model-picker-legacy-"));
  const model = { provider: "openai-compatible", modelId: "legacy-model", baseUrl: "http://localhost:11434/v1" };
  let config = resolveConfig({ model });
  const core = {
    dataDir: dir,
    config: () => config,
    saveModel: (nextModel, customProvider) => {
      config = { ...config, model: nextModel, ...(customProvider ? { customProvider } : { customProvider: undefined }) };
    },
    saveCustomProvider: (customProvider) => { config = { ...config, ...(customProvider ? { customProvider } : { customProvider: undefined }) }; },
    events: { emit() {} },
  };
  const manager = new ModelManager({ core, name: () => "Synthetic test", log: () => {}, autoRefreshCopilot: false, onReload: async () => {} });
  try {
    await manager.init();
    const initial = manager.status();
    assert.equal(initial.ready, true);
    assert.deepEqual(modelPickerProviders(initial).map((provider) => provider.id), ["openai-compatible"]);
    const anthropicModelId = initial.providers.find((provider) => provider.id === "anthropic").models[0].id;
    const switched = await manager.setModel("anthropic", anthropicModelId);
    const custom = switched.providers.find((provider) => provider.id === "openai-compatible");
    assert.equal(custom.customSetup.authMode, "keyless");
    assert.equal(custom.customSetup.ready, true);
    assert.ok(modelPickerProviders(switched).some((provider) => provider.id === "openai-compatible"));
  } finally {
    manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unrememberable active custom URL stays intact and is not inferred keyless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-model-picker-unrememberable-"));
  const baseUrl = "http://localhost:11434/v1?api-version=2025-01-01";
  const model = { provider: "openai-compatible", modelId: "legacy-model", baseUrl };
  let config = resolveConfig({ model });
  const core = {
    dataDir: dir,
    config: () => config,
    saveModel: (nextModel, customProvider) => { config = { ...config, model: nextModel, ...(customProvider ? { customProvider } : { customProvider: undefined }) }; },
    saveCustomProvider: (customProvider) => { config = { ...config, ...(customProvider ? { customProvider } : { customProvider: undefined }) }; },
    events: { emit() {} },
  };
  const manager = new ModelManager({ core, name: () => "Synthetic test", log: () => {}, autoRefreshCopilot: false, onReload: async () => {} });
  try {
    await manager.init();
    const status = manager.status();
    const custom = status.providers.find((provider) => provider.id === "openai-compatible");
    assert.equal(status.baseUrl, baseUrl, "active URL query is not silently stripped");
    assert.equal(config.model.baseUrl, baseUrl);
    assert.equal(custom.customSetup, undefined);
    assert.deepEqual(modelPickerProviders(status).map((provider) => provider.id), []);
    await assert.rejects(manager.setProviderAuth("openai-compatible", { baseUrl, apiKey: "synthetic-key" }), /query strings/);
    assert.equal(await manager.credentials.read("openai-compatible"), undefined);
    assert.equal(config.model.baseUrl, baseUrl);
    assert.equal(config.customProvider, undefined);
  } finally {
    manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
