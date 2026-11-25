/**
 * The model Spencer thinks with, chosen and signed in from the web UI's Model page:
 *
 *  - builds the pi-ai `Models` from config.json's `model` (models.ts), and rebuilds it live when the owner
 *    switches model or signs in, so no restart is needed;
 *  - runs "Sign in with GitHub" (Copilot device flow) and "use my Copilot CLI sign-in", saving the result in
 *    `<dataDir>/secrets/credentials.json`;
 *  - reports all of it as `ModelStatus` (GET /api/model and `model` events).
 */
import type { Models } from "@earendil-works/pi-ai";
import { rememberableCustomProviderSetup, type CustomProviderSetup, type ModelConfig, type ThinkingLevel } from "../config.ts";
import type { CoreServices, LoginState, ModelProviderOption, ModelStatus, ProviderAuthOptions, SetModelOptions } from "../contracts.ts";
import {
  COPILOT_PROVIDER,
  CopilotAuthError,
  PREFERRED_COPILOT_MODELS,
  connectCopilot,
  copilotCliAccounts,
  copilotCliToken,
  githubClientId,
  isCopilotCredential,
  pickCopilotModel,
  pollDeviceFlow,
  spencerCopilotProvider,
  startDeviceFlow,
  type CopilotCredential,
  type CopilotKeyring,
} from "./copilot.ts";
import { FileCredentialStore } from "./credentials.ts";
import type { FakeBrainHooks } from "./fake-brain.ts";
import { defaultApiKeyEnvFor, loadBuiltinProvider, PICKER_PROVIDERS, setupModels, withExtraModel, type ModelSetup } from "./models.ts";
import { BUILTIN_PROVIDERS } from "./providers.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

class ModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Copilot's Claude models refuse requests with thinking turned off (they want "between_tools"), so a Copilot
 * Claude model gets "medium" unless the owner picked another level. Other Copilot models (like GPT-4o) respect
 * "off".
 */
function copilotModelConfig(modelId: string, thinking: string | undefined): ModelConfig {
  const needsThinking = /^claude-/i.test(modelId);
  const level = thinking && thinking !== "off" ? thinking : needsThinking ? "medium" : undefined;
  return { provider: COPILOT_PROVIDER, modelId, ...(level ? { thinking: level } : {}) } as ModelConfig;
}

function normalizeHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ModelError(400, "baseUrl must be a valid http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ModelError(400, "baseUrl must use http:// or https://");
  return raw.trim();
}

export interface ModelManagerOptions {
  core: CoreServices;
  name: () => string;
  fakeHooks?: FakeBrainHooks;
  log: (m: string) => void;
  /** The model changed: reconfigure every conversation. */
  onReload: () => Promise<void>;
  /** Automatically refresh Copilot's live model list in the background on startup (default true). */
  autoRefreshCopilot?: boolean;
  /** The Copilot CLI's config.json (tests; default `copilotCliConfigPath()`). */
  copilotCliConfig?: string;
  /** Keyring backend for Copilot CLI tokens (tests; default OS keyring when using the real config path). */
  copilotKeyring?: CopilotKeyring;
}

export class ModelManager {
  private opts: ModelManagerOptions;
  readonly credentials: FileCredentialStore;
  private setup: ModelSetup | undefined;
  /** The Conversations model, when it is set apart from the main one. */
  private convSetup: ModelSetup | undefined;
  private combined: Models | undefined;
  private catalog: { id: string; name: string; reasoning?: boolean }[] = [];
  private catalogs = new Map<string, { name: string; models: { id: string; name: string; reasoning?: boolean }[] }>();
  private savedKeys = new Set<string>();
  private copilot: CopilotCredential | undefined;
  private copilotModelsError: string | undefined;
  private refreshAbort: AbortController | undefined;
  private signIn: (LoginState & { abort?: AbortController }) | undefined;
  private stopped = false;

  constructor(opts: ModelManagerOptions) {
    this.opts = opts;
    this.credentials = new FileCredentialStore(opts.core.dataDir);
  }

  private clientId(): string | undefined {
    return githubClientId(this.opts.core.config().auth?.githubClientId);
  }

  private async ensureCatalog(providerId: string): Promise<{ name: string; models: { id: string; name: string; reasoning?: boolean }[] } | undefined> {
    const existing = this.catalogs.get(providerId);
    if (existing) return existing;
    const p = await loadBuiltinProvider(providerId).catch(() => undefined);
    if (!p) return undefined;
    const entry = {
      name: p.name || providerId,
      models: p.getModels().map((m) => ({ id: m.id, name: m.name, ...(m.reasoning ? { reasoning: true } : {}) })),
    };
    this.catalogs.set(providerId, entry);
    return entry;
  }

  async init(): Promise<void> {
    const saved = await this.credentials.read(COPILOT_PROVIDER);
    this.copilot = isCopilotCredential(saved) ? saved : undefined;
    const credList = await this.credentials.list();
    this.savedKeys = new Set(credList.filter((c) => c.type === "api_key").map((c) => c.providerId));
    const base = await loadBuiltinProvider(COPILOT_PROVIDER).catch(() => undefined);
    if (base) {
      this.catalog = spencerCopilotProvider(base, () => undefined)
        .getModels()
        .map((m) => ({ id: m.id, name: m.name, ...(m.reasoning ? { reasoning: true } : {}) }));
    }
    const toLoad = new Set(PICKER_PROVIDERS.filter((p) => !p.custom && p.id !== COPILOT_PROVIDER).map((p) => p.id));
    for (const m of [this.opts.core.config().model, this.opts.core.config().conversationModel]) {
      const prov = m?.provider;
      if (prov && prov !== "fake" && prov !== "openai-compatible" && prov !== COPILOT_PROVIDER && Object.hasOwn(BUILTIN_PROVIDERS, prov)) toLoad.add(prov);
    }
    await Promise.all([...toLoad].map((id) => this.ensureCatalog(id)));
    await this.build();
    if (this.copilot && this.opts.autoRefreshCopilot !== false) {
      void this.refreshCopilotModels({ silent: true });
    }
  }

  stop(): void {
    this.stopped = true;
    this.signIn?.abort?.abort(new Error("stopping"));
    this.refreshAbort?.abort(new Error("stopping"));
  }

  models(): Models | undefined {
    return this.combined;
  }
  ref(): { provider: string; modelId: string } | undefined {
    return this.setup?.ref;
  }
  error(): string | undefined {
    return this.setup?.error;
  }
  /** The model Conversations channels run with: their own one if it is set and works, else the main one. */
  conversationRef(): { provider: string; modelId: string } | undefined {
    return this.convSetup?.ref ?? this.ref();
  }
  /** The reasoning effort that goes with `conversationRef()`. */
  conversationThinking(): string | undefined {
    const m = (this.convSetup?.ref ? this.opts.core.config().conversationModel : this.opts.core.config().model) as { thinking?: string } | undefined;
    return typeof m?.thinking === "string" ? m.thinking : undefined;
  }

  private async build(): Promise<void> {
    const opts = {
      name: this.opts.name,
      ...(this.opts.fakeHooks ? { fakeHooks: this.opts.fakeHooks } : {}),
      credentials: this.credentials,
      githubClientId: () => this.clientId(),
    };
    this.setup = await setupModels(this.opts.core.config().model, opts);
    if (this.setup.error) this.opts.log(`model not available: ${this.setup.error}`);
    const conv = this.opts.core.config().conversationModel;
    this.convSetup = conv ? await setupModels(conv, opts) : undefined;
    if (this.convSetup?.error) this.opts.log(`Conversations model not available (using the main model): ${this.convSetup.error}`);
    const ref = this.convSetup?.ref;
    const main = this.setup.ref;
    if (ref && main && ref.provider === main.provider && ref.modelId === main.modelId) {
      // The same model as the main one: its requests cannot be told apart, so it runs as the main model.
      const a = this.opts.core.config().model as { baseUrl?: string; apiKeyEnv?: string };
      const b = conv as { baseUrl?: string; apiKeyEnv?: string };
      if (a.baseUrl !== b.baseUrl || a.apiKeyEnv !== b.apiKeyEnv) {
        this.convSetup = { models: this.setup.models, error: "same provider and model as the main model but other settings; using the main model" };
        this.opts.log(`Conversations model not available: ${this.convSetup.error}`);
      }
      this.combined = this.setup.models;
      return;
    }
    this.combined = withExtraModel(this.setup.models, ref ? { models: this.convSetup!.models, ref } : undefined);
  }

  private async reload(opts: { rememberCustomSetup?: boolean; preserveCredentialed?: boolean; clearApiKeyEnv?: boolean } = {}): Promise<void> {
    await this.build();
    await this.opts.onReload();
    if (opts.rememberCustomSetup) {
      const model = this.opts.core.config().model;
      const setup = this.customSetupFromModel(model, !!this.setup?.ref, true, opts.preserveCredentialed, opts.clearApiKeyEnv);
      this.opts.core.saveCustomProvider?.(setup ?? null);
    }
    this.emit();
  }

  private customSetupFromModel(model: ModelConfig, ready: boolean, explicitlyConfigured = false, preserveCredentialed = false, clearApiKeyEnv = false): CustomProviderSetup | undefined {
    if (model.provider !== "openai-compatible") return undefined;
    const custom = model as Extract<ModelConfig, { provider: "openai-compatible" }>;
    const previous = this.opts.core.config().customProvider;
    const currentSetup = rememberableCustomProviderSetup({ baseUrl: custom.baseUrl, modelId: custom.modelId, authMode: "unavailable", ready: false });
    const sameEndpoint = previous?.baseUrl === currentSetup?.baseUrl;
    const hasLiteralKey = typeof custom.apiKey === "string" && custom.apiKey.length > 0;
    const apiKeyEnv = clearApiKeyEnv ? undefined : custom.apiKeyEnv ?? (sameEndpoint && previous?.authMode === "credentialed" ? previous.apiKeyEnv : undefined);
    const authMode = hasLiteralKey
      ? "unavailable"
      : preserveCredentialed || apiKeyEnv || this.savedKeys.has("openai-compatible")
        ? "credentialed"
        : explicitlyConfigured
          ? "keyless"
          : sameEndpoint && previous?.authMode === "credentialed"
            ? "credentialed"
            : sameEndpoint && previous?.authMode === "keyless"
              ? "keyless"
              : !previous && !apiKeyEnv ? "keyless" : "unavailable";
    const missingEnvironmentKey = authMode === "credentialed" && !!apiKeyEnv && !!this.setup?.error?.includes(`environment variable ${apiKeyEnv}`);
    return rememberableCustomProviderSetup({
      baseUrl: custom.baseUrl,
      modelId: custom.modelId,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      authMode,
      ready: ready || missingEnvironmentKey,
    });
  }

  private hasCustomCredentials(setup: CustomProviderSetup): boolean {
    if (setup.authMode === "keyless") return true;
    if (setup.authMode !== "credentialed") return false;
    return this.savedKeys.has("openai-compatible") || Boolean(setup.apiKeyEnv && process.env[setup.apiKeyEnv]);
  }

  private customSetupForSave(current: ModelConfig): CustomProviderSetup | undefined {
    return this.opts.core.config().customProvider ?? (current.provider === "openai-compatible" ? this.customSetupFromModel(current, !!this.setup?.ref) : undefined);
  }

  private emit(): void {
    if (this.stopped) return;
    this.opts.core.events.emit({ type: "model", model: this.status() });
  }

  private copilotModels(): { id: string; name: string; reasoning?: boolean }[] {
    const byId = new Map(this.catalog.map((m) => [m.id, m]));
    const rank = (id: string) => {
      const i = PREFERRED_COPILOT_MODELS.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const sortPref = (list: { id: string; name: string; reasoning?: boolean }[]) =>
      [...list].sort((a, b) => rank(a.id) - rank(b.id));

    const discovered = this.copilot?.availableModels;
    if (discovered?.length) {
      return sortPref(
        discovered.map((d) => byId.get(d.id) ?? { id: d.id, name: d.name || d.id, ...(d.reasoning ? { reasoning: true } : {}) }),
      );
    }
    const ids = this.copilot?.availableModelIds;
    if (ids?.length) {
      return sortPref(ids.map((id) => byId.get(id) ?? { id, name: id }));
    }
    return this.catalog;
  }

  private providerOptions(...configured: ({ provider: string; apiKeyEnv?: string } | undefined)[]): ModelProviderOption[] {
    const cur = configured[0]!;
    const list: ModelProviderOption[] = PICKER_PROVIDERS.map((p) => {
      if (p.id === COPILOT_PROVIDER) {
        return { id: p.id, name: p.name, models: this.copilot ? this.copilotModels() : [] };
      }
      if (p.custom) {
        const customSetup = this.opts.core.config().customProvider ?? (cur.provider === p.id
          ? this.customSetupFromModel(this.opts.core.config().model, !!this.setup?.ref)
          : undefined);
        const status = customSetup ? { ...customSetup, ready: customSetup.ready && this.hasCustomCredentials(customSetup) } : undefined;
        const envName = status?.apiKeyEnv ?? (cur.provider === p.id ? cur.apiKeyEnv : undefined);
        return {
          id: p.id,
          name: p.name,
          custom: true,
          ...(status ? { customSetup: status } : {}),
          hasEnvKey: envName ? Boolean(process.env[envName]) : false,
          hasSavedKey: this.savedKeys.has(p.id),
          models: [],
        };
      }
      const envName = cur.provider === p.id && cur.apiKeyEnv ? cur.apiKeyEnv : p.defaultApiKeyEnv;
      return {
        id: p.id,
        name: p.name,
        ...(p.defaultApiKeyEnv ? { defaultApiKeyEnv: p.defaultApiKeyEnv } : {}),
        hasEnvKey: envName ? Boolean(process.env[envName]) : false,
        hasSavedKey: this.savedKeys.has(p.id),
        models: this.catalogs.get(p.id)?.models ?? [],
      };
    });
    // Providers set in config.json that the picker does not offer (the main model's, then the Conversations model's).
    for (const c of configured) {
      if (!c?.provider || c.provider === "fake" || list.some((p) => p.id === c.provider)) continue;
      const cat = this.catalogs.get(c.provider);
      list.push({
        id: c.provider,
        name: cat?.name ?? c.provider,
        ...(c.apiKeyEnv ? { defaultApiKeyEnv: c.apiKeyEnv, hasEnvKey: Boolean(process.env[c.apiKeyEnv]) } : {}),
        hasSavedKey: this.savedKeys.has(c.provider),
        models: cat?.models ?? [],
      });
    }
    return list;
  }

  status(): ModelStatus {
    const m = this.opts.core.config().model as {
      provider: string;
      modelId?: string;
      thinking?: ThinkingLevel;
      baseUrl?: string;
      apiKeyEnv?: string;
    };
    const c = this.copilot;
    const signIn = this.signIn ? (({ abort: _a, ...rest }) => rest)(this.signIn) : undefined;
    return {
      provider: m.provider,
      ...(m.modelId ? { modelId: m.modelId } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      ...(m.apiKeyEnv ? { apiKeyEnv: m.apiKeyEnv } : {}),
      ready: !!this.setup?.ref,
      ...(this.setup?.error ? { error: this.setup.error } : {}),
      providers: this.providerOptions(m, this.opts.core.config().conversationModel as { provider: string; apiKeyEnv?: string } | undefined),
      copilot: {
        connected: !!c,
        ...(c ? { login: c.login, via: c.source, ...(c.plan ? { plan: c.plan } : {}) } : {}),
        models: c ? this.copilotModels().map(({ id, name }) => ({ id, name })) : [],
        ...(c?.modelsRefreshedAt ? { modelsRefreshedAt: c.modelsRefreshedAt } : {}),
        ...(this.copilotModelsError ? { modelsError: this.copilotModelsError } : {}),
        deviceLogin: !!this.clientId(),
        cliAccounts: copilotCliAccounts(this.opts.copilotCliConfig, this.opts.copilotKeyring),
        ...(signIn ? { signIn } : {}),
      },
      ...this.conversationStatus(),
    };
  }

  private conversationStatus(): Pick<ModelStatus, "conversation"> {
    const c = this.opts.core.config().conversationModel as
      | { provider: string; modelId?: string; thinking?: ThinkingLevel; baseUrl?: string; apiKeyEnv?: string }
      | undefined;
    if (!c) return {};
    return {
      conversation: {
        provider: c.provider,
        ...(c.modelId ? { modelId: c.modelId } : {}),
        ...(c.thinking ? { thinking: c.thinking } : {}),
        ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
        ...(c.apiKeyEnv ? { apiKeyEnv: c.apiKeyEnv } : {}),
        ready: !!this.convSetup?.ref,
        ...(this.convSetup?.error ? { error: this.convSetup.error } : {}),
      },
    };
  }

  async setProviderAuth(provider: string, opts: ProviderAuthOptions = {}): Promise<ModelStatus> {
    if (typeof provider !== "string" || !provider.trim()) throw new ModelError(400, "provider is required");
    const prov = provider.trim();
    if (prov === COPILOT_PROVIDER) throw new ModelError(409, "Use the GitHub Copilot sign-in controls to manage this provider.");
    const isCustom = prov === "openai-compatible";
    if (!isCustom && !Object.hasOwn(BUILTIN_PROVIDERS, prov)) throw new ModelError(400, `unknown model provider "${prov}"`);
    if (!isCustom && (opts.baseUrl !== undefined || opts.apiKeyEnv !== undefined || opts.clearApiKeyEnv !== undefined)) {
      throw new ModelError(400, "endpoint settings are only supported for openai-compatible");
    }
    if (opts.apiKey !== undefined && typeof opts.apiKey !== "string") throw new ModelError(400, "apiKey must be a string");
    if (opts.clearApiKey !== undefined && typeof opts.clearApiKey !== "boolean") throw new ModelError(400, "clearApiKey must be a boolean");
    if (opts.clearApiKey && opts.apiKey?.trim()) throw new ModelError(400, "apiKey and clearApiKey cannot be used together");
    if (opts.clearApiKeyEnv !== undefined && typeof opts.clearApiKeyEnv !== "boolean") throw new ModelError(400, "clearApiKeyEnv must be a boolean");
    if (opts.baseUrl !== undefined && typeof opts.baseUrl !== "string") throw new ModelError(400, "baseUrl must be a string");

    let apiKeyEnv: string | undefined;
    if (opts.apiKeyEnv !== undefined && opts.apiKeyEnv.trim() !== "") {
      apiKeyEnv = opts.apiKeyEnv.trim();
      if (!ENV_NAME_RE.test(apiKeyEnv)) throw new ModelError(400, "apiKeyEnv must be an environment variable name");
    }
    const baseUrl = opts.baseUrl?.trim() ? normalizeHttpUrl(opts.baseUrl) : undefined;
    const config = this.opts.core.config();
    const current = config.model as ModelConfig & { provider: string; baseUrl?: string };
    const conversation = config.conversationModel;
    let existingCustom: CustomProviderSetup | undefined;
    let savedBaseUrl: string | undefined;

    if (isCustom) {
      if (!this.opts.core.saveCustomProvider) throw new ModelError(501, "this Spencer cannot save custom provider setup");
      existingCustom = this.opts.core.config().customProvider ?? (current.provider === prov ? this.customSetupFromModel(current, !!this.setup?.ref) : undefined);
      savedBaseUrl = baseUrl ?? existingCustom?.baseUrl ?? (current.provider === prov ? current.baseUrl : undefined);
      if (!savedBaseUrl) throw new ModelError(400, 'baseUrl is required for "openai-compatible" setup');
      if (!rememberableCustomProviderSetup({ baseUrl: savedBaseUrl, authMode: "unavailable", ready: false })) {
        throw new ModelError(400, "custom endpoint URL cannot be remembered; remove userinfo, query strings, or fragments");
      }
    } else if (opts.clearApiKeyEnv !== undefined || opts.apiKeyEnv !== undefined) {
      throw new ModelError(400, "apiKeyEnv options are only supported for openai-compatible");
    }

    const key = opts.apiKey?.trim();
    let credentialChanged = false;
    if (opts.clearApiKey) {
      if (this.savedKeys.has(prov)) {
        await this.credentials.delete(prov);
        this.savedKeys.delete(prov);
        credentialChanged = true;
      }
    } else if (key) {
      await this.credentials.modify(prov, async () => ({ type: "api_key", key }));
      this.savedKeys.add(prov);
      credentialChanged = true;
    }

    if (isCustom) {
      const sameEndpoint = existingCustom?.baseUrl === savedBaseUrl;
      const envName = opts.clearApiKeyEnv === true ? undefined : apiKeyEnv ?? (sameEndpoint ? existingCustom?.apiKeyEnv : undefined);
      const hasSavedKey = this.savedKeys.has(prov);
      const hasEnvKey = !!envName && !!process.env[envName];
      const explicitlyKeyless = opts.clearApiKeyEnv === true && !hasSavedKey && !envName;
      const preserveKeyless = opts.clearApiKeyEnv !== true && sameEndpoint && existingCustom?.authMode === "keyless" && !hasSavedKey && !envName;
      const authMode = explicitlyKeyless || preserveKeyless
        ? "keyless"
        : hasSavedKey || envName ? "credentialed" : "unavailable";
      const setup = rememberableCustomProviderSetup({
        baseUrl: savedBaseUrl,
        ...(sameEndpoint && existingCustom?.modelId ? { modelId: existingCustom.modelId } : {}),
        ...(authMode === "credentialed" && envName ? { apiKeyEnv: envName } : {}),
        authMode,
        ready: authMode === "keyless" || (authMode === "credentialed" && (hasSavedKey || hasEnvKey)),
      });
      if (!setup) throw new ModelError(400, "invalid custom provider setup");
      this.opts.core.saveCustomProvider!(setup);
    }

    if (credentialChanged && (current.provider === prov || conversation?.provider === prov)) {
      await this.build();
      await this.opts.onReload();
    }
    this.emit();
    return this.status();
  }

  async setModel(provider: string, modelId: string, opts: SetModelOptions = {}): Promise<ModelStatus> {
    const current = this.opts.core.config().model;
    const hadSavedCustomKey = this.savedKeys.has("openai-compatible");
    const next = await this.modelConfig(provider, modelId, opts, current);
    const clearedCustomKey = provider === "openai-compatible" && opts.clearApiKey === true && hadSavedCustomKey;
    const customProvider = provider === "openai-compatible"
      ? this.customSetupFromModel(next, false, true, clearedCustomKey, opts.clearApiKeyEnv === true)
      : this.customSetupForSave(current);
    this.save(next, customProvider ?? null);
    await this.reload(provider === "openai-compatible" ? {
      rememberCustomSetup: true,
      preserveCredentialed: clearedCustomKey,
      clearApiKeyEnv: opts.clearApiKeyEnv === true,
    } : undefined);
    return this.status();
  }

  /** The model Conversations channels use; `provider: null` goes back to the main model. */
  async setConversationModel(provider: string | null, modelId: string, opts: SetModelOptions = {}): Promise<ModelStatus> {
    if (!this.opts.core.saveConversationModel) throw new ModelError(501, "this Spencer cannot change its model at runtime");
    if (provider === null) {
      this.opts.core.saveConversationModel(undefined);
    } else {
      const cfg = this.opts.core.config();
      const next = await this.modelConfig(provider, modelId, opts, cfg.conversationModel ?? cfg.model);
      this.opts.core.saveConversationModel(next);
    }
    await this.reload();
    return this.status();
  }

  /** Validate a model choice and turn it into its config (saving or clearing an API key on the way). */
  private async modelConfig(provider: string, modelId: string, opts: SetModelOptions, currentConfig: ModelConfig): Promise<ModelConfig> {
    if (typeof provider !== "string" || typeof modelId !== "string" || !provider.trim() || !modelId.trim()) {
      throw new ModelError(400, "provider and modelId are required");
    }
    const prov = provider.trim();
    const mid = modelId.trim();
    if (opts.clearApiKeyEnv !== undefined && typeof opts.clearApiKeyEnv !== "boolean") throw new ModelError(400, "clearApiKeyEnv must be a boolean");
    if (opts.clearApiKeyEnv === true && prov !== "openai-compatible") throw new ModelError(400, "clearApiKeyEnv is only supported for openai-compatible");
    if (opts.thinking !== undefined && !THINKING_LEVELS.has(opts.thinking)) {
      throw new ModelError(400, `thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
    let apiKeyEnv: string | undefined;
    if (opts.apiKeyEnv !== undefined && opts.apiKeyEnv.trim() !== "") {
      apiKeyEnv = opts.apiKeyEnv.trim();
      if (!ENV_NAME_RE.test(apiKeyEnv)) throw new ModelError(400, "apiKeyEnv must be an environment variable name");
    }
    const baseUrl = opts.baseUrl !== undefined && opts.baseUrl.trim() !== "" ? normalizeHttpUrl(opts.baseUrl) : undefined;
    const current = currentConfig as ModelConfig & {
      modelId?: string;
      thinking?: ThinkingLevel;
      baseUrl?: string;
      apiKeyEnv?: string;
    };

    const updateKey = async (target: string) => {
      if (opts.clearApiKey) {
        await this.credentials.delete(target);
        this.savedKeys.delete(target);
      } else if (typeof opts.apiKey === "string" && opts.apiKey.trim()) {
        await this.credentials.modify(target, async () => ({ type: "api_key", key: opts.apiKey!.trim() }));
        this.savedKeys.add(target);
      }
    };

    let next: ModelConfig;
    if (prov === COPILOT_PROVIDER) {
      if (!this.copilot) throw new ModelError(409, "Sign in to GitHub Copilot first.");
      if (!this.copilotModels().some((m) => m.id === mid)) throw new ModelError(400, `GitHub Copilot has no model "${mid}" for @${this.copilot.login}`);
      const thinking = opts.thinking ?? (current.provider === COPILOT_PROVIDER ? current.thinking : undefined);
      next = copilotModelConfig(mid, thinking);
    } else if (prov === "openai-compatible") {
      const url = baseUrl ?? (current.provider === "openai-compatible" ? current.baseUrl : undefined);
      if (!url) throw new ModelError(400, 'baseUrl is required for "openai-compatible"');
      await updateKey(prov);
      const remembered = this.opts.core.config().customProvider;
      const rememberedKeyless = remembered?.baseUrl === url && remembered.authMode === "keyless";
      const env = opts.clearApiKeyEnv === true
        ? undefined
        : apiKeyEnv ?? (rememberedKeyless ? undefined :
          (current.provider === "openai-compatible" && current.baseUrl === url ? current.apiKeyEnv : undefined) ??
          (remembered?.baseUrl === url ? remembered.apiKeyEnv : undefined));
      const thinking = opts.thinking ?? (current.provider === "openai-compatible" ? current.thinking : undefined);
      next = {
        provider: "openai-compatible",
        baseUrl: url,
        modelId: mid,
        ...(env ? { apiKeyEnv: env } : {}),
        ...(thinking && thinking !== "off" ? { thinking } : {}),
      };
    } else if (Object.hasOwn(BUILTIN_PROVIDERS, prov)) {
      const cat = await this.ensureCatalog(prov);
      if (!cat) throw new ModelError(400, `unknown model provider "${prov}"`);
      if (!cat.models.some((m) => m.id === mid)) throw new ModelError(400, `provider "${prov}" has no model "${mid}"`);
      await updateKey(prov);
      const defEnv = defaultApiKeyEnvFor(prov);
      const env = apiKeyEnv ?? (current.provider === prov ? current.apiKeyEnv : undefined) ?? (this.savedKeys.has(prov) ? undefined : defEnv);
      const url = baseUrl ?? (current.provider === prov && opts.baseUrl === undefined ? current.baseUrl : undefined);
      const thinking = opts.thinking ?? (current.provider === prov ? current.thinking : undefined);
      next = {
        provider: prov,
        modelId: mid,
        ...(env ? { apiKeyEnv: env } : {}),
        ...(url ? { baseUrl: url } : {}),
        ...(thinking && thinking !== "off" ? { thinking } : {}),
      };
    } else {
      throw new ModelError(400, `unknown model provider "${prov}"`);
    }
    return next;
  }

  private save(model: ModelConfig, customProvider: CustomProviderSetup | null = this.opts.core.config().customProvider ?? null): void {
    if (!this.opts.core.saveModel) throw new ModelError(501, "this Spencer cannot change its model at runtime");
    this.opts.core.saveModel(model, customProvider);
  }

  /** A Copilot sign-in succeeded: save it, and if Spencer has no working model yet, start using Copilot. */
  private async connected(cred: CopilotCredential): Promise<void> {
    await this.credentials.modify(COPILOT_PROVIDER, async () => cred);
    this.copilot = cred;
    this.copilotModelsError = cred.availableModels?.length ? undefined : "Could not fetch live models from GitHub Copilot; click Refresh models to retry.";
    this.signIn = undefined;
    this.opts.log(
      `GitHub Copilot connected as @${cred.login}${cred.plan ? ` (${cred.plan})` : ""} (${cred.availableModels?.length ?? 0} live models from ${cred.apiBase})`,
    );
    const current = this.opts.core.config().model as { provider: string; modelId?: string };
    const available = this.copilotModels().map((model) => model.id);
    const keep = current.provider === COPILOT_PROVIDER && current.modelId && available.includes(current.modelId);
    if (!keep && (current.provider === COPILOT_PROVIDER || !this.setup?.ref)) {
      const pick = pickCopilotModel(available);
      if (pick) this.save(copilotModelConfig(pick, current.provider === COPILOT_PROVIDER ? (current as { thinking?: string }).thinking : undefined));
    }
    await this.reload();
  }

  /** Re-queries `/copilot_internal/user` and `${apiBase}/models` and updates the live model picker. */
  async refreshCopilotModels(opts?: { silent?: boolean }): Promise<ModelStatus> {
    const currentCred = this.copilot;
    if (!currentCred) {
      if (opts?.silent) return this.status();
      throw new ModelError(409, "Sign in to GitHub Copilot first.");
    }
    this.refreshAbort?.abort(new Error("superseded"));
    const abort = new AbortController();
    this.refreshAbort = abort;
    try {
      const next = await connectCopilot(currentCred.access, currentCred.source ?? "device", abort.signal, { strictModels: true });
      if (this.stopped || abort.signal.aborted || this.copilot?.access !== currentCred.access) return this.status();
      this.copilotModelsError = undefined;
      await this.credentials.modify(COPILOT_PROVIDER, async () => next);
      this.copilot = next;
      this.opts.log(`GitHub Copilot models refreshed: ${next.availableModels?.length ?? 0} models from ${next.apiBase}`);
      const current = this.opts.core.config().model as { provider: string; modelId?: string; thinking?: string };
      const available = this.copilotModels().map((model) => model.id);
      const keep = current.provider === COPILOT_PROVIDER && current.modelId && available.includes(current.modelId);
      if (!keep && (current.provider === COPILOT_PROVIDER || !this.setup?.ref)) {
        const pick = pickCopilotModel(available);
        if (pick) this.save(copilotModelConfig(pick, current.provider === COPILOT_PROVIDER ? current.thinking : undefined));
      }
      await this.reload();
      return this.status();
    } catch (e) {
      if (this.stopped || abort.signal.aborted) return this.status();
      const msg = e instanceof Error ? e.message : String(e);
      this.copilotModelsError = msg;
      this.opts.log(`GitHub Copilot model refresh failed: ${msg}`);
      this.emit();
      if (opts?.silent) return this.status();
      const status = e instanceof CopilotAuthError && e.code === "revoked" ? 401 : 502;
      throw new ModelError(status, msg);
    } finally {
      if (this.refreshAbort === abort) this.refreshAbort = undefined;
    }
  }

  async startCopilotLogin(): Promise<ModelStatus> {
    const clientId = this.clientId();
    if (!clientId) {
      throw new ModelError(409, "Sign in with GitHub needs a GitHub OAuth app id (auth.githubClientId in config.json).");
    }
    this.signIn?.abort?.abort(new Error("restarted"));
    const abort = new AbortController();
    let device;
    try {
      device = await startDeviceFlow(clientId, abort.signal);
    } catch (e) {
      throw new ModelError(502, (e as Error).message);
    }
    const state: LoginState & { abort?: AbortController } = {
      state: "waiting",
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: device.expiresAt,
      abort,
    };
    this.signIn = state;
    this.emit();
    void (async () => {
      try {
        const token = await pollDeviceFlow(clientId, device, abort.signal);
        if (this.signIn !== state) return;
        state.state = "connecting";
        this.emit();
        const cred = await connectCopilot(token, "device", abort.signal);
        if (this.signIn !== state) return;
        await this.connected(cred);
      } catch (e) {
        if (this.signIn !== state || abort.signal.aborted) return;
        this.signIn = { state: "failed", error: e instanceof CopilotAuthError ? e.message : `Sign-in failed: ${(e as Error).message}` };
        this.emit();
      }
    })();
    return this.status();
  }

  cancelCopilotLogin(): ModelStatus {
    if (this.signIn?.state === "waiting" || this.signIn?.state === "connecting") {
      this.signIn.abort?.abort(new Error("cancelled"));
      this.signIn = { state: "cancelled" };
    } else {
      this.signIn = undefined;
    }
    this.emit();
    return this.status();
  }

  /** Reuse the GitHub Copilot CLI's saved sign-in for `login`. */
  async useCopilotCliLogin(login: string): Promise<ModelStatus> {
    if (typeof login !== "string" || !login) throw new ModelError(400, "login is required");
    let cred: CopilotCredential;
    try {
      const token = await copilotCliToken(login, this.opts.copilotCliConfig, this.opts.copilotKeyring);
      cred = await connectCopilot(token, "copilot-cli");
    } catch (e) {
      const status = e instanceof CopilotAuthError && e.code === "network" ? 502 : 400;
      throw new ModelError(status, (e as Error).message);
    }
    this.signIn?.abort?.abort(new Error("replaced"));
    this.signIn = undefined;
    await this.connected(cred);
    return this.status();
  }

  async copilotLogout(): Promise<ModelStatus> {
    this.signIn?.abort?.abort(new Error("signed out"));
    this.refreshAbort?.abort(new Error("signed out"));
    this.signIn = undefined;
    this.copilotModelsError = undefined;
    await this.credentials.delete(COPILOT_PROVIDER);
    this.copilot = undefined;
    this.opts.log("GitHub Copilot signed out");
    await this.reload();
    return this.status();
  }
}
