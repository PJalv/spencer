import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, loadMergedConfig } from "../../src/daemon.ts";
import { resolveConfig, rememberableCustomProviderSetup, type CustomProviderSetup, type ModelConfig, type SpencerConfig } from "../../src/config.ts";

test("custom endpoint metadata remembers ordinary paths but excludes query, userinfo, and fragment URLs", () => {
  const base = { modelId: "llama3.1", authMode: "keyless", ready: true };
  const endpoint = "https://models.example.test/cliproxy/v1";
  assert.deepEqual(rememberableCustomProviderSetup({ ...base, baseUrl: endpoint }), { ...base, baseUrl: endpoint });
  assert.deepEqual(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}/` }), { ...base, baseUrl: `${endpoint}/` });
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: "https://models.example.test/customer-code/tenant/v1" })?.baseUrl, "https://models.example.test/customer-code/tenant/v1");
  const dotSegmentPath = "https://models.example.test/customer/../tenant/v1";
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: dotSegmentPath })?.baseUrl, dotSegmentPath);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}?api-version=2025-01-01` }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}?api_key=not-a-real-key` }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: "https://user:not-a-real-password@models.example.test/cliproxy/v1" }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: "https://@models.example.test/cliproxy/v1" }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}#not-persisted` }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}?` }), undefined);
  assert.equal(rememberableCustomProviderSetup({ ...base, baseUrl: `${endpoint}#` }), undefined);
});

test("custom endpoint metadata persists across config reload without credential values", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-custom-config-"));
  const daemon = new Daemon({ dataDir: dir });
  const privateApiKey = "synthetic-not-for-config-test";
  const setup = {
    baseUrl: "https://models.example.test/v1",
    modelId: "llama3.1",
    apiKeyEnv: "SPENCER_TEST_CUSTOM_KEY",
    authMode: "credentialed",
    ready: true,
    apiKey: privateApiKey,
  } as unknown as CustomProviderSetup;
  const internals = daemon as unknown as {
    s: { cfg: SpencerConfig };
    saveModel(model: ModelConfig, customProvider?: CustomProviderSetup | null): void;
  };
  internals.s = { cfg: resolveConfig({ model: { provider: "openai-compatible", baseUrl: "https://models.example.test/v1", modelId: "llama3.1", apiKey: privateApiKey } } as never) };
  internals.saveModel({ provider: "anthropic", modelId: "claude-test" }, setup);

  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(JSON.stringify(raw).includes(privateApiKey), false);
  assert.deepEqual(raw.customProvider, {
    baseUrl: "https://models.example.test/v1",
    modelId: "llama3.1",
    apiKeyEnv: "SPENCER_TEST_CUSTOM_KEY",
    authMode: "credentialed",
    ready: true,
  });
  assert.deepEqual(loadMergedConfig(dir).customProvider, raw.customProvider);
});

test("saving custom metadata does not persist an in-memory model override or its literal key", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-custom-status-only-"));
  const daemon = new Daemon({ dataDir: dir });
  const privateApiKey = "synthetic-override-key-not-for-config";
  const setup: CustomProviderSetup = { baseUrl: "http://localhost:11434/v1", authMode: "keyless", ready: true };
  const internals = daemon as unknown as {
    s: { cfg: SpencerConfig };
    saveCustomProvider(customProvider: CustomProviderSetup | null): void;
  };
  internals.s = { cfg: resolveConfig({ model: { provider: "openai-compatible", baseUrl: setup.baseUrl, modelId: "llama3.1", apiKey: privateApiKey } } as never) };
  internals.saveCustomProvider(setup);

  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(JSON.stringify(raw).includes(privateApiKey), false);
  assert.equal(raw.model, undefined);
  assert.deepEqual(loadMergedConfig(dir).customProvider, setup);
});

test("unrememberable endpoint URLs stay only in the active model config", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-custom-unremembered-"));
  const daemon = new Daemon({ dataDir: dir });
  const baseUrl = "https://models.example.test/cliproxy/v1?api-version=2025-01-01";
  const model: ModelConfig = { provider: "openai-compatible", baseUrl, modelId: "llama3.1" };
  const setup: CustomProviderSetup = { baseUrl, modelId: "llama3.1", authMode: "keyless", ready: true };
  const internals = daemon as unknown as {
    s: { cfg: SpencerConfig };
    saveModel(model: ModelConfig, customProvider?: CustomProviderSetup | null): void;
    saveCustomProvider(customProvider: CustomProviderSetup | null): void;
  };
  internals.s = { cfg: resolveConfig({ model } as never) };
  internals.saveModel(model);
  internals.saveCustomProvider(setup);

  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(raw.model.baseUrl, baseUrl, "existing active model URL is preserved");
  assert.equal(raw.customProvider, undefined, "URL is not copied into remembered provider metadata");
  assert.equal(loadMergedConfig(dir).customProvider, undefined);
});

test("legacy configs without custom endpoint metadata still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-legacy-config-"));
  const daemon = new Daemon({ dataDir: dir });
  const internals = daemon as unknown as {
    s: { cfg: SpencerConfig };
    saveModel(model: ModelConfig, customProvider?: CustomProviderSetup | null): void;
  };
  internals.s = { cfg: resolveConfig({ model: { provider: "fake" } } as never) };
  internals.saveModel({ provider: "fake" }, null);
  assert.equal(loadMergedConfig(dir).customProvider, undefined);
});
