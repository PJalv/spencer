import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import {
  COPILOT_API_VERSION,
  COPILOT_PROVIDER,
  DEFAULT_GITHUB_CLIENT_ID,
  copilotOAuth,
  githubClientId,
  inferCopilotApi,
  isCopilotCredential,
  parseCopilotModels,
  parseDbusUnixAddress,
  pickCopilotModel,
  pollDeviceFlow,
  type CopilotCredential,
  type CopilotKeyring,
} from "../../src/agent/copilot.ts";
import { ModelManager } from "../../src/agent/model-manager.ts";
import { setupModels } from "../../src/agent/models.ts";
import { resolveConfig, type ModelConfig } from "../../src/config.ts";
import type { CoreServices, DaemonEvent } from "../../src/contracts.ts";

const cred = (over: Partial<CopilotCredential> = {}): CopilotCredential => ({
  type: "oauth",
  access: "gho_test",
  refresh: "gho_test",
  expires: Date.now() + 3_600_000,
  login: "alice",
  plan: "individual",
  apiBase: "https://api.individual.githubcopilot.com",
  availableModelIds: ["claude-sonnet-5.5", "gpt-6.1-terra"],
  source: "device",
  ...over,
});

test("credentials survive a restart, owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const a = new FileCredentialStore(dir);
  await a.modify(COPILOT_PROVIDER, async () => cred());
  assert.equal(statSync(a.file).mode & 0o777, 0o600);
  const b = new FileCredentialStore(dir);
  assert.ok(isCopilotCredential(await b.read(COPILOT_PROVIDER)));
  assert.deepEqual(await b.list(), [{ providerId: COPILOT_PROVIDER, type: "oauth" }]);
  await b.delete(COPILOT_PROVIDER);
  assert.equal(await new FileCredentialStore(dir).read(COPILOT_PROVIDER), undefined);
  assert.deepEqual(JSON.parse(readFileSync(a.file, "utf8")), {});
});

test("a corrupt credentials file does not stop the daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const a = new FileCredentialStore(dir);
  await a.modify("x", async () => ({ type: "api_key", key: "k" }));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(a.file, "{not json");
  assert.equal(await new FileCredentialStore(dir).read("x"), undefined);
});

test("GitHub client id: env over config over default, validated", () => {
  const prev = process.env.SPENCER_GITHUB_CLIENT_ID;
  try {
    delete process.env.SPENCER_GITHUB_CLIENT_ID;
    assert.equal(githubClientId(), DEFAULT_GITHUB_CLIENT_ID);
    assert.ok(DEFAULT_GITHUB_CLIENT_ID.startsWith("Ov23li"));
    assert.equal(githubClientId("Ov23liABC"), "Ov23liABC");
    assert.equal(githubClientId("bad id with spaces"), undefined);
    process.env.SPENCER_GITHUB_CLIENT_ID = "Ov23liENV";
    assert.equal(githubClientId("Ov23liABC"), "Ov23liENV");
  } finally {
    if (prev === undefined) delete process.env.SPENCER_GITHUB_CLIENT_ID;
    else process.env.SPENCER_GITHUB_CLIENT_ID = prev;
  }
  assert.throws(() => resolveConfig({ auth: { githubClientId: "no spaces allowed" } } as never), /githubClientId/);
  assert.equal(resolveConfig({ auth: { githubClientId: " Ov23li " } } as never).auth.githubClientId, "Ov23li");
});

test("the Copilot token goes to the account's own endpoint", async () => {
  const auth = await copilotOAuth(() => undefined).toAuth(cred({ apiBase: "https://api.business.githubcopilot.com" }));
  assert.deepEqual(auth, { apiKey: "gho_test", baseUrl: "https://api.business.githubcopilot.com" });
});

test("setupModels: Copilot needs a sign-in and a model the account has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const credentials = new FileCredentialStore(dir);
  const opts = { name: () => "Spencer", credentials };
  const none = await setupModels({ provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" }, opts);
  assert.equal(none.ref, undefined);
  assert.match(none.error ?? "", /not connected/);

  await credentials.modify(COPILOT_PROVIDER, async () => cred());
  const ok = await setupModels({ provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" }, opts);
  assert.deepEqual(ok.ref, { provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" });
  // Requests identify as Spencer (with Copilot API version), not as VS Code.
  const model = ok.models.getModel(COPILOT_PROVIDER, "claude-sonnet-5.5")!;
  assert.match(String(model.headers?.["User-Agent"]), /^spencer\//);
  assert.equal(model.headers?.["X-GitHub-Api-Version"], COPILOT_API_VERSION);
  assert.equal(model.headers?.["Editor-Version"], undefined);
  assert.equal(model.headers?.["Copilot-Integration-Id"], undefined);
  // Only the account's models are offered.
  const available = (await ok.models.getAvailable(COPILOT_PROVIDER)).map((m) => m.id).sort();
  assert.deepEqual(available, ["claude-sonnet-5.5", "gpt-6.1-terra"]);

  const unknown = await setupModels({ provider: COPILOT_PROVIDER, modelId: "no-such-model" }, opts);
  assert.match(unknown.error ?? "", /unknown GitHub Copilot model/);
});

test("model picked after sign-in", () => {
  assert.equal(pickCopilotModel(["gpt-6.1-terra", "claude-sonnet-5.5"]), "claude-sonnet-5.5");
  assert.equal(pickCopilotModel(["claude-sonnet-9", "gpt-x"]), "claude-sonnet-9");
  assert.equal(pickCopilotModel(["gpt-x"]), "gpt-x");
  assert.equal(pickCopilotModel([]), undefined);
});

function makeModelManager(
  dir: string,
  initialModel: ModelConfig,
  extra: { copilotCliConfig?: string; copilotKeyring?: CopilotKeyring } = {},
  conversationModel?: ModelConfig,
) {
  let cfg = resolveConfig({ model: initialModel, ...(conversationModel ? { conversationModel } : {}) } as never);
  const saved: ModelConfig[] = [];
  const events: DaemonEvent[] = [];
  let reloads = 0;
  const core = {
    dataDir: dir,
    config: () => cfg,
    saveModel: (m: ModelConfig, customProvider?: import("../../src/config.ts").CustomProviderSetup | null) => {
      cfg = { ...cfg, model: m, ...(customProvider === undefined ? {} : customProvider ? { customProvider } : { customProvider: undefined }) };
      saved.push(m);
    },
    saveCustomProvider: (customProvider: import("../../src/config.ts").CustomProviderSetup | null) => {
      cfg = { ...cfg, ...(customProvider ? { customProvider } : { customProvider: undefined }) };
    },
    events: { emit: (e: DaemonEvent) => events.push(e) },
  } as unknown as CoreServices;
  const mm = new ModelManager({
    core,
    name: () => "Spencer",
    log: () => {},
    autoRefreshCopilot: false,
    ...extra,
    onReload: async () => {
      reloads++;
    },
  });
  return { mm, saved, events, getReloads: () => reloads, getConfig: () => cfg };
}

test("ModelManager: provider auth changes never switch the active model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-auth-only-"));
  const { mm, saved, getConfig, getReloads } = makeModelManager(dir, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
  try {
    await mm.init();
    const initial = mm.status();
    const activeModel = { provider: initial.provider, modelId: initial.modelId };
    const openai = initial.providers!.find((provider) => provider.id === "openai")!;

    const savedAuth = await mm.setProviderAuth("openai", { apiKey: "synthetic-openai-key" });
    assert.deepEqual({ provider: savedAuth.provider, modelId: savedAuth.modelId }, activeModel);
    assert.equal(savedAuth.providers?.find((provider) => provider.id === "openai")?.hasSavedKey, true);
    assert.deepEqual(getConfig().model, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 0);

    const removed = await mm.setProviderAuth("openai", { clearApiKey: true });
    assert.deepEqual({ provider: removed.provider, modelId: removed.modelId }, activeModel);
    assert.equal(removed.providers?.find((provider) => provider.id === "openai")?.hasSavedKey, false);
    assert.equal(await mm.credentials.read("openai"), undefined);
    assert.deepEqual(getConfig().model, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 0);

    const activeAuth = await mm.setProviderAuth("anthropic", { apiKey: "synthetic-active-provider-key" });
    assert.deepEqual({ provider: activeAuth.provider, modelId: activeAuth.modelId }, activeModel);
    assert.deepEqual(getConfig().model, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.equal(activeAuth.providers?.find((provider) => provider.id === "anthropic")?.hasSavedKey, true);
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 1, "active credentials reload the runtime without selecting a different model");

    const activeKeyRemoved = await mm.setProviderAuth("anthropic", { clearApiKey: true });
    assert.deepEqual({ provider: activeKeyRemoved.provider, modelId: activeKeyRemoved.modelId }, activeModel);
    assert.deepEqual(getConfig().model, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 2);

    const switched = await mm.setModel("openai", openai.models[0]!.id);
    assert.equal(switched.provider, "openai", "only the explicit model-switch operation changes the model");
    assert.equal(getReloads(), 3);
  } finally {
    mm.stop();
  }
});

test("ModelManager: provider auth refreshes a separately configured Conversations model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-conversation-auth-"));
  const envName = "SPENCER_TEST_CONVERSATION_KEY";
  const previous = process.env[envName];
  const previousMainKey = process.env.ANTHROPIC_API_KEY;
  delete process.env[envName];
  process.env.ANTHROPIC_API_KEY = "synthetic-main-key";
  const main = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  const conversation = { provider: "openai", modelId: "gpt-4o", apiKeyEnv: envName };
  const { mm, getConfig, getReloads, saved } = makeModelManager(dir, main, {}, conversation);
  try {
    await mm.init();
    assert.equal(mm.status().conversation?.ready, false);
    assert.deepEqual(mm.conversationRef(), { provider: "anthropic", modelId: "claude-sonnet-5-5" });

    const configured = await mm.setProviderAuth("openai", { apiKey: "synthetic-conversation-key" });
    assert.equal(configured.conversation?.ready, true);
    assert.deepEqual(mm.conversationRef(), { provider: "openai", modelId: "gpt-4o" });
    assert.deepEqual({ provider: configured.provider, modelId: configured.modelId }, main);
    assert.deepEqual(getConfig().model, main);
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 1, "credentials for the Conversations provider rebuild the runtime");

    const removed = await mm.setProviderAuth("openai", { clearApiKey: true });
    assert.equal(removed.conversation?.ready, false);
    assert.deepEqual(mm.conversationRef(), { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.deepEqual({ provider: removed.provider, modelId: removed.modelId }, main);
    assert.deepEqual(getConfig().model, main);
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 2, "removing Conversations credentials also rebuilds the runtime");
  } finally {
    mm.stop();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    if (previousMainKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousMainKey;
  }
});

test("ModelManager: custom endpoint Auth setup is remembered independently from model selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-custom-auth-only-"));
  const envName = "SPENCER_TEST_CUSTOM_AUTH_KEY";
  const previous = process.env[envName];
  process.env[envName] = "synthetic-custom-env-key";
  const active = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  const { mm, getConfig, getReloads, saved } = makeModelManager(dir, active);
  try {
    await mm.init();
    const endpoint = "https://models.example.test/auth-only/v1";
    const configured = await mm.setProviderAuth("openai-compatible", { baseUrl: endpoint, apiKeyEnv: envName });
    assert.deepEqual({ provider: configured.provider, modelId: configured.modelId }, active);
    assert.deepEqual(getConfig().model, active);
    assert.deepEqual(saved, []);
    assert.equal(getReloads(), 0, "non-active auth setup does not rebuild the runtime");
    assert.deepEqual(configured.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup, {
      baseUrl: endpoint, apiKeyEnv: envName, authMode: "credentialed", ready: true,
    });
    assert.equal(process.env[envName], "synthetic-custom-env-key");

    const keyless = await mm.setProviderAuth("openai-compatible", { baseUrl: endpoint, clearApiKeyEnv: true });
    assert.equal(keyless.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup?.authMode, "keyless");
    assert.equal(keyless.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup?.ready, true);
    assert.equal(process.env[envName], "synthetic-custom-env-key", "forgetting the association does not alter the environment");
    assert.deepEqual(getConfig().model, active);

    const switched = await mm.setModel("openai-compatible", "synthetic-model", { baseUrl: endpoint });
    assert.equal(switched.provider, "openai-compatible", "only explicit model selection switches the active model");
    assert.equal(switched.baseUrl, endpoint);
    assert.equal(switched.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup?.authMode, "keyless");
  } finally {
    mm.stop();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("ModelManager: switching models honors a saved keyless custom endpoint over the old env-key reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-keyless-switch-"));
  const envName = "SPENCER_TEST_CUSTOM_EXISTING_ENV_KEY";
  const previous = process.env[envName];
  process.env[envName] = "synthetic-existing-env-key";
  const endpoint = "https://models.example.test/keyless-switch/v1";
  const active: ModelConfig = { provider: "openai-compatible", baseUrl: endpoint, modelId: "existing-model", apiKeyEnv: envName };
  const { mm, getConfig } = makeModelManager(dir, active);
  try {
    await mm.init();
    assert.equal(mm.status().ready, true);

    const keyless = await mm.setProviderAuth("openai-compatible", { baseUrl: endpoint, clearApiKeyEnv: true });
    const setup = keyless.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup;
    assert.equal(setup?.authMode, "keyless");
    assert.equal(setup?.apiKeyEnv, undefined);
    assert.deepEqual(getConfig().model, active, "saving Auth setup does not rewrite the active model");

    const switched = await mm.setModel("openai-compatible", "next-model", { baseUrl: endpoint });
    assert.equal(switched.modelId, "next-model");
    assert.equal(switched.apiKeyEnv, undefined, "model switch does not restore the old environment-key reference");
    assert.equal(switched.ready, true);
    const finalSetup = switched.providers?.find((provider) => provider.id === "openai-compatible")?.customSetup;
    assert.equal(finalSetup?.authMode, "keyless");
    assert.equal(finalSetup?.apiKeyEnv, undefined);
    assert.equal(process.env[envName], "synthetic-existing-env-key", "keyless setup does not mutate the environment");
    assert.deepEqual(getConfig().model, { provider: "openai-compatible", baseUrl: endpoint, modelId: "next-model" });
  } finally {
    mm.stop();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("ModelManager: lists providers, switches live with saved API key, and clears key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-"));
  const prevAnt = process.env.ANTHROPIC_API_KEY;
  const prevOai = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { mm, saved, getReloads } = makeModelManager(dir, {
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  });
  try {
    await mm.init();
    const initial = mm.status();
    assert.equal(initial.ready, false);
    const providerIds = initial.providers?.map((p) => p.id) ?? [];
    assert.ok(providerIds.includes("github-copilot"));
    assert.ok(providerIds.includes("anthropic"));
    assert.ok(providerIds.includes("openai"));
    assert.ok(providerIds.includes("google"));
    assert.ok(providerIds.includes("openai-compatible"));
    const antCatalog = initial.providers?.find((p) => p.id === "anthropic");
    assert.ok((antCatalog?.models.length ?? 0) > 0);
    const antModelId = antCatalog!.models[0].id;

    // Save an API key via setModel: stored in secrets/credentials.json (0600), never in config.json.
    const st1 = await mm.setModel("anthropic", antModelId, { apiKey: "sk-ant-test-123", thinking: "high" });
    assert.equal(st1.ready, true);
    assert.equal(st1.provider, "anthropic");
    assert.equal(st1.modelId, antModelId);
    assert.equal(st1.thinking, "high");
    assert.equal(st1.providers?.find((p) => p.id === "anthropic")?.hasSavedKey, true);
    assert.equal(getReloads(), 1);
    assert.equal((saved.at(-1) as { apiKey?: string }).apiKey, undefined);
    assert.equal(statSync(mm.credentials.file).mode & 0o777, 0o600);
    assert.deepEqual(await mm.credentials.read("anthropic"), { type: "api_key", key: "sk-ant-test-123" });

    // Switch to another built-in provider (OpenAI) with its own saved key.
    const oaiModelId = initial.providers!.find((p) => p.id === "openai")!.models[0].id;
    const st2 = await mm.setModel("openai", oaiModelId, { apiKey: "sk-oai-test-456", thinking: "off" });
    assert.equal(st2.ready, true);
    assert.equal(st2.provider, "openai");
    assert.equal(st2.modelId, oaiModelId);
    assert.equal(st2.thinking, undefined);
    assert.equal(st2.providers?.find((p) => p.id === "openai")?.hasSavedKey, true);

    // Clear the saved key: credentials removed and status drops to not ready (no env var).
    const st3 = await mm.setModel("openai", oaiModelId, { clearApiKey: true });
    assert.equal(st3.ready, false);
    assert.equal(st3.providers?.find((p) => p.id === "openai")?.hasSavedKey, false);
    assert.equal(await mm.credentials.read("openai"), undefined);

    // Switch to openai-compatible (no key required for local servers like Ollama).
    const st4 = await mm.setModel("openai-compatible", "llama3.1", {
      baseUrl: "http://localhost:11434/v1/",
      thinking: "low",
    });
    assert.equal(st4.ready, true);
    assert.equal(st4.provider, "openai-compatible");
    assert.equal(st4.modelId, "llama3.1");
    assert.equal(st4.baseUrl, "http://localhost:11434/v1/");
    assert.equal(st4.thinking, "low");

    // Validation errors.
    await assert.rejects(() => mm.setModel("no-such-provider", "m"), /unknown model provider/);
    await assert.rejects(() => mm.setModel("openai", "no-such-model"), /has no model/);
    await assert.rejects(() => mm.setModel("openai", oaiModelId, { thinking: "ultra" as never }), /thinking must be/);
    await assert.rejects(() => mm.setModel("openai-compatible", "llama3.1", { baseUrl: "ftp://bad" }), /http/);
  } finally {
    mm.stop();
    if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnt;
    if (prevOai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOai;
  }
});

test("ModelManager: openai-compatible requires baseUrl when switching from another provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-"));
  const { mm } = makeModelManager(dir, { provider: "fake" });
  try {
    await mm.init();
    await assert.rejects(() => mm.setModel("openai-compatible", "llama3.1"), /baseUrl is required/);
  } finally {
    mm.stop();
  }
});

test("parseCopilotModels: supports Business accounts with legacy/picker-false models and filters non-chat", () => {
  const parsed = parseCopilotModels({
    data: [
      { id: "text-embedding-3-small", name: "Embedding", capabilities: { type: "embeddings" } },
      { id: "no-tools", name: "No Tools", capabilities: { type: "chat", supports: { tool_calls: false } } },
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true } } },
      { id: "gpt-4o", name: "GPT-4o", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true, vision: true }, limits: { max_prompt_tokens: 128000, max_output_tokens: 4096 } } },
      { id: "gpt-4o", name: "GPT-4o duplicate", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true } } },
    ],
  });
  assert.deepEqual(
    parsed?.map((m) => ({ id: m.id, name: m.name, api: m.api, vision: m.vision })),
    [
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", api: "openai-completions", vision: undefined },
      { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", vision: true },
    ],
  );
  const endpoints = parseCopilotModels({
    data: [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", model_picker_enabled: true, supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { type: "chat", supports: { tool_calls: true } } },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { tool_calls: true } } },
    ],
  });
  assert.equal(endpoints?.[0].api, "anthropic-messages");
  assert.equal(endpoints?.[1].api, "openai-responses");

  // OpenCode fallback endpoint routing when supported_endpoints is omitted.
  assert.equal(inferCopilotApi("gpt-4o", undefined), "openai-completions");
  assert.equal(inferCopilotApi("gpt-5-mini", undefined), "openai-completions");
  assert.equal(inferCopilotApi("gpt-5", undefined), "openai-responses");
  assert.equal(inferCopilotApi("gpt-5.3-codex", undefined), "openai-responses");
  assert.equal(inferCopilotApi("grok-4.7", undefined), "openai-responses");
  assert.equal(inferCopilotApi("claude-sonnet-4.5", undefined), "anthropic-messages");
});

test("Copilot live-discovered models outside pi-ai static catalog populate picker and work in setupModels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-biz-"));
  const businessCred = cred({
    plan: "business",
    apiBase: "https://api.business.githubcopilot.com",
    availableModelIds: ["gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-3.5-turbo"],
    availableModels: [
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", api: "openai-completions" },
      { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", vision: true },
      { id: "gpt-3.5-turbo", name: "GPT 3.5 Turbo", api: "openai-completions" },
    ],
  });
  const store = new FileCredentialStore(dir);
  await store.modify(COPILOT_PROVIDER, async () => businessCred);

  const { mm } = makeModelManager(dir, { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" });
  try {
    await mm.init();
    const st = mm.status();
    assert.equal(st.copilot.connected, true);
    assert.deepEqual(
      st.copilot.models.map((m) => m.id),
      ["gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-3.5-turbo"],
    );
    assert.deepEqual(
      st.providers?.find((p) => p.id === COPILOT_PROVIDER)?.models.map((m) => m.id),
      ["gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-3.5-turbo"],
    );
    assert.equal(pickCopilotModel(st.copilot.models.map((m) => m.id)), "gpt-4o");

    const switched = await mm.setModel(COPILOT_PROVIDER, "gpt-4o");
    assert.equal(switched.ready, true);
    assert.equal(switched.provider, COPILOT_PROVIDER);
    assert.equal(switched.modelId, "gpt-4o");
    assert.equal(switched.thinking, undefined);
  } finally {
    mm.stop();
  }

  // Also works for credentials saved before `availableModels` existed (only `availableModelIds`).
  const legacyDir = mkdtempSync(join(tmpdir(), "spencer-mm-legacy-"));
  const legacyStore = new FileCredentialStore(legacyDir);
  await legacyStore.modify(COPILOT_PROVIDER, async () => cred({ availableModelIds: ["gpt-4o", "gpt-3.5-turbo"] }));
  const ok = await setupModels({ provider: COPILOT_PROVIDER, modelId: "gpt-4o" }, { name: () => "Spencer", credentials: legacyStore });
  assert.deepEqual(ok.ref, { provider: COPILOT_PROVIDER, modelId: "gpt-4o" });
  assert.equal(ok.models.getModel(COPILOT_PROVIDER, "gpt-4o")?.api, "openai-completions");
});

test("pollDeviceFlow waits longer than GitHub's interval so an approved sign-in is not stuck on slow_down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // A GitHub that answers slow_down (raising the interval by 5s) to any poll that isn't later than the interval.
  let interval = 5;
  let last = Date.now();
  const polls: string[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    const early = Date.now() - last <= interval * 1000;
    last = Date.now();
    if (early) interval += 5;
    const body = early ? { error: "slow_down", interval } : polls.length < 2 ? { error: "authorization_pending" } : { access_token: "gho_ok" };
    polls.push(early ? "slow_down" : (body.error ?? "token"));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const device = { deviceCode: "d", userCode: "U", verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresAt: Date.now() + 900_000 };
  const ac = new AbortController();
  const result = pollDeviceFlow("id", device, ac.signal);
  let done = false;
  void result.finally(() => (done = true)).catch(() => {});
  for (let s = 0; s < 120 && !done; s++) {
    t.mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
  }
  ac.abort(new Error("test over"));
  assert.equal(await result, "gho_ok");
  assert.deepEqual(polls, ["authorization_pending", "authorization_pending", "token"]);
});

test("ModelManager reuses the GitHub Copilot CLI sign-in (GitHub's own client, full model list)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-cli-"));
  const cliConfig = join(dir, "copilot-config.json");
  const cliToken = "gho_" + "c".repeat(36);
  writeFileSync(
    cliConfig,
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({
      authTokens: { "https://github.com:alice": { token: cliToken }, "https://github.com:alice:github": { token: cliToken } },
      loggedInUsers: [{ host: "https://github.com", login: "alice" }],
    })}`,
  );
  const auths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    auths.push(new Headers(init.headers).get("Authorization") ?? "");
    const body = String(url).endsWith("/copilot_internal/user")
      ? { login: "alice", copilot_plan: "business", chat_enabled: true, endpoints: { api: "https://api.business.githubcopilot.com" } }
      : { data: [{ id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true } } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const { mm, saved: modelSaves, getConfig } = makeModelManager(dir, { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" }, { copilotCliConfig: cliConfig });
  try {
    await mm.init();
    assert.deepEqual(mm.status().copilot.cliAccounts, ["alice"]);
    await assert.rejects(mm.useCopilotCliLogin("bob"), /no saved sign-in for @bob/);

    const st = await mm.useCopilotCliLogin("alice");
    assert.equal(st.copilot.connected, true);
    assert.equal(st.copilot.via, "copilot-cli");
    assert.deepEqual(st.copilot.models.map((m) => m.id), ["claude-sonnet-5.5"]);
    assert.equal(st.provider, COPILOT_PROVIDER, "Copilot sign-in selects a model when the current model is not ready");
    assert.equal(st.modelId, "claude-sonnet-5.5");
    const selected = { provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5", thinking: "medium" };
    assert.deepEqual(modelSaves, [selected]);
    assert.deepEqual(getConfig().model, selected);

    const refreshed = await mm.refreshCopilotModels();
    assert.equal(refreshed.provider, COPILOT_PROVIDER);
    assert.equal(refreshed.modelId, "claude-sonnet-5.5");
    assert.deepEqual(modelSaves, [selected], "refresh retains the available active Copilot model");
    assert.ok(auths.length > 0 && auths.every((a) => a === `Bearer ${cliToken}`));
    const credential = await new FileCredentialStore(dir).read(COPILOT_PROVIDER);
    assert.ok(isCopilotCredential(credential) && credential.source === "copilot-cli" && credential.access === cliToken);
  } finally {
    mm.stop();
  }
});

test("parseDbusUnixAddress handles path, percent-encoding, multiple addresses, and abstract sockets", () => {
  assert.equal(parseDbusUnixAddress("unix:path=/run/user/1000/bus"), "/run/user/1000/bus");
  assert.equal(parseDbusUnixAddress("tcp:host=127.0.0.1;unix:path=/tmp/my%20bus,guid=abc"), "/tmp/my bus");
  assert.equal(parseDbusUnixAddress("unix:abstract=/tmp/dbus-xyz"), "\0/tmp/dbus-xyz");
  assert.equal(parseDbusUnixAddress("tcp:host=127.0.0.1"), undefined);
  assert.equal(parseDbusUnixAddress(undefined), undefined);
});

test("ModelManager reuses Copilot CLI sign-in stored in OS keyring (loggedInUsers without plaintext authTokens)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-keyring-"));
  const cliConfig = join(dir, "copilot-config.json");
  const cliToken = "gho_" + "k".repeat(36);
  writeFileSync(
    cliConfig,
    `// User settings belong in settings.json.\n${JSON.stringify({
      loggedInUsers: [
        { host: "https://github.com", login: "first-user" },
        { host: "https://github.com", login: "biz-user" },
        { host: "https://ghe.example.com", login: "other-host" },
      ],
      lastLoggedInUser: { host: "https://github.com", login: "biz-user" },
    })}`,
  );
  const keyring: CopilotKeyring = {
    available: () => true,
    read: async (login) => {
      if (login === "biz-user") return { status: "ok", token: cliToken };
      if (login === "first-user") return { status: "locked" };
      return { status: "not_found" };
    },
  };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const body = String(url).endsWith("/copilot_internal/user")
      ? { login: "biz-user", copilot_plan: "business", chat_enabled: true, endpoints: { api: "https://api.business.githubcopilot.com" } }
      : {
          data: [
            { id: "gpt-6-luna", name: "GPT-6 Luna", model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { tool_calls: true } } },
          ],
        };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const { mm, saved: modelSaves, getConfig } = makeModelManager(
    dir,
    { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { copilotCliConfig: cliConfig, copilotKeyring: keyring },
  );
  try {
    await mm.init();
    // lastLoggedInUser is listed first; non-github.com hosts are excluded.
    assert.deepEqual(mm.status().copilot.cliAccounts, ["biz-user", "first-user"]);
    await assert.rejects(mm.useCopilotCliLogin("first-user"), /keyring is locked/);

    const st = await mm.useCopilotCliLogin("biz-user");
    assert.equal(st.copilot.connected, true);
    assert.equal(st.copilot.via, "copilot-cli");
    assert.equal(st.copilot.login, "biz-user");
    assert.equal(st.provider, COPILOT_PROVIDER);
    assert.equal(st.modelId, "gpt-6-luna");
    assert.deepEqual(modelSaves, [{ provider: COPILOT_PROVIDER, modelId: "gpt-6-luna" }]);
    assert.deepEqual(getConfig().model, { provider: COPILOT_PROVIDER, modelId: "gpt-6-luna" });
    const credential = await new FileCredentialStore(dir).read(COPILOT_PROVIDER);
    assert.ok(isCopilotCredential(credential) && credential.source === "copilot-cli" && credential.access === cliToken);
  } finally {
    mm.stop();
  }
});
