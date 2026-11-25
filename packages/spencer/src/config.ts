import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { normalizeRelayUrl } from "@spencer/protocol";

export type P2pConfig = { mode: "files" | "off"; hideLocalAddresses: boolean; minFileBytes: number; stun: string[] };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type CustomProviderAuthMode = "keyless" | "credentialed" | "unavailable";

/** Non-secret remembered endpoint setup. The URL path is routing data and is not inspected for embedded credentials. */
export interface CustomProviderSetup {
  baseUrl: string;
  modelId?: string;
  apiKeyEnv?: string;
  authMode: CustomProviderAuthMode;
  ready: boolean;
}

/** Keep only HTTP(S) endpoints without userinfo, query strings, or fragments; retain the exact path. */
export function rememberableCustomProviderSetup(value: unknown): CustomProviderSetup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.baseUrl !== "string" ||
    (raw.modelId !== undefined && (typeof raw.modelId !== "string" || !raw.modelId.trim())) ||
    typeof raw.ready !== "boolean" ||
    !["keyless", "credentialed", "unavailable"].includes(String(raw.authMode))
  ) return undefined;
  const baseUrl = raw.baseUrl.trim();
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  const authority = baseUrl.match(/^[a-z][a-z\d+.-]*:(?:\/\/)?([^/?#]*)/i)?.[1];
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") || !authority || authority.includes("@") ||
    url.username || url.password || baseUrl.includes("?") || baseUrl.includes("#")
  ) return undefined;
  const apiKeyEnv = typeof raw.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(raw.apiKeyEnv)
    ? raw.apiKeyEnv
    : undefined;
  return {
    baseUrl: raw.baseUrl.trim(),
    ...(typeof raw.modelId === "string" && raw.modelId.trim() ? { modelId: raw.modelId.trim() } : {}),
    ...(raw.authMode === "credentialed" && apiKeyEnv ? { apiKeyEnv } : {}),
    authMode: raw.authMode as CustomProviderAuthMode,
    ready: raw.ready,
  };
}

export type ModelConfig =
  | { provider: "fake" }
  /** Built-in pi-ai provider id (anthropic, openai, openrouter, google, xai, groq, …). */
  | { provider: string; modelId: string; apiKeyEnv?: string; apiKey?: string; baseUrl?: string; thinking?: ThinkingLevel }
  | {
      provider: "openai-compatible";
      baseUrl: string;
      modelId: string;
      apiKeyEnv?: string;
      apiKey?: string;
      contextWindow?: number;
      maxTokens?: number;
      /** Reasoning effort, sent as `reasoning_effort` (needs a reasoning model). Absent or "off": none. */
      thinking?: ThinkingLevel;
    };

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean; disabledTools?: string[] }
  | { url: string; headers?: Record<string, string>; disabled?: boolean; disabledTools?: string[] };

export interface Policy {
  /**
   * Loop guard (PROTOCOL.md §7.2). Standard trust: the highest hop that still gets an automatic reply (a backstop that
   * old Spencers understand too; 0 = no cap). The turn budget below is the main limit.
   */
  maxHops: number;
  /** The same for channels with full trust. 0 = no cap. */
  maxHopsFullTrust: number;
  /** Automatic replies in a channel since a person last wrote there, standard trust; then the channel pauses and asks. 0 = no limit. */
  maxAgentTurns: number;
  maxAgentTurnsFullTrust: number;
  /** Automatic replies per channel per minute (skipped above it) and per hour / day (pauses and asks), standard trust. */
  repliesPerMinute: number;
  repliesPerHour: number;
  repliesPerDay: number;
  /** The same for channels with full trust. */
  repliesPerMinuteFullTrust: number;
  repliesPerHourFullTrust: number;
  repliesPerDayFullTrust: number;
  /** Follow-ups (schedule_followup) one conversation may have pending at once. */
  maxPendingFollowups: number;
  /** How many times in a row a follow-up may schedule the next one (polling a long task). */
  maxFollowupChain: number;
  autoAcceptIncomingFiles: boolean;
  maxIncomingFileBytes: number;
  requireApprovalForOutgoingFiles: boolean;
  ownerCodingTools: boolean;
  transferTtlHours: number;
  maxTransferAttempts: number;
  /**
   * Conversations channels: each agent's timer is a random number of minutes in [min, max]; when it goes off and no
   * conversation is going on, the agent opens one. Every agent may send at most `conversationMessages` messages in it.
   */
  conversationMinMinutes: number;
  conversationMaxMinutes: number;
  conversationMessages: number;
  /**
   * Timers only open conversations from `conversationStartHour` to `conversationEndHour` (0–24, end exclusive), local
   * time in `conversationTimeZone` (an IANA zone). People can still start one any time by writing in the channel.
   */
  conversationStartHour: number;
  conversationEndHour: number;
  conversationTimeZone: string;
}

export interface SpencerConfig {
  name: string;
  relay: string;
  p2p: P2pConfig;
  http: { host: "127.0.0.1"; port: number };
  model: ModelConfig;
  /** Non-secret remembered custom endpoint setup; separate from the active model. */
  customProvider?: CustomProviderSetup;
  /** The model Conversations channels use (they run often and can use many tokens). Absent: the main model. */
  conversationModel?: ModelConfig;
  /** Experimental features (SOUL.md and Conversations channels). Off by default. */
  experimental: boolean;
  /** `throttleUpload`: croc's --throttleUpload for sends (e.g. "500k"), null = unlimited. */
  croc: { path: string; relay: string | null; pass: string | null; allowLocal: boolean; throttleUpload: string | null };
  mcpServers: Record<string, McpServerConfig>;
  policy: Policy;
  /** Model sign-in settings. `githubClientId`: Spencer's GitHub OAuth app for "Sign in with GitHub" (Copilot). */
  auth: { githubClientId?: string };
}

export const DEFAULT_POLICY: Policy = {
  maxHops: 40,
  maxHopsFullTrust: 0,
  maxAgentTurns: 20,
  maxAgentTurnsFullTrust: 50,
  repliesPerMinute: 6,
  repliesPerHour: 60,
  repliesPerDay: 300,
  repliesPerMinuteFullTrust: 20,
  repliesPerHourFullTrust: 200,
  repliesPerDayFullTrust: 1000,
  maxPendingFollowups: 5,
  maxFollowupChain: 12,
  autoAcceptIncomingFiles: true,
  maxIncomingFileBytes: 512 * 1024 * 1024,
  requireApprovalForOutgoingFiles: true,
  ownerCodingTools: true,
  transferTtlHours: 24,
  maxTransferAttempts: 5,
  conversationMinMinutes: 30,
  conversationMaxMinutes: 60,
  conversationMessages: 10,
  conversationStartHour: 8,
  conversationEndHour: 18,
  conversationTimeZone: "America/Los_Angeles",
};

export function defaultConfig(): SpencerConfig {
  return {
    name: "Spencer",
    relay: "wss://spencer.pjalv.com/ws",
    p2p: { mode: "files", hideLocalAddresses: true, minFileBytes: 4 * 1024 * 1024, stun: [] },
    http: { host: "127.0.0.1", port: 7420 },
    model: { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    croc: { path: "croc", relay: null, pass: null, allowLocal: false, throttleUpload: null },
    mcpServers: {},
    policy: { ...DEFAULT_POLICY },
    auth: {},
    experimental: false,
  };
}

export function defaultDataDir(): string {
  return process.env.SPENCER_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "spencer");
}

/** Merge a user config over defaults. Unknown keys are kept out. */
export function resolveConfig(raw: Partial<SpencerConfig> & Record<string, unknown>): SpencerConfig {
  const d = defaultConfig();
  const customProvider = rememberableCustomProviderSetup(raw.customProvider);
  const cfg: SpencerConfig = {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 100) : d.name,
    relay: typeof raw.relay === "string" ? raw.relay : d.relay,
    p2p: { ...d.p2p, ...(raw.p2p ?? {}) },
    http: { host: "127.0.0.1", port: Number(raw.http?.port ?? d.http.port) },
    model: (raw.model as ModelConfig) ?? d.model,
    ...(customProvider ? { customProvider } : {}),
    croc: { ...d.croc, ...(raw.croc ?? {}) },
    mcpServers: (raw.mcpServers as Record<string, McpServerConfig>) ?? {},
    policy: { ...d.policy, ...(raw.policy ?? {}) },
    auth: {},
    experimental: raw.experimental === true,
  };
  if (raw.conversationModel && typeof raw.conversationModel === "object") cfg.conversationModel = raw.conversationModel as ModelConfig;
  const auth = raw.auth as Record<string, unknown> | undefined;
  if (auth && typeof auth.githubClientId === "string" && auth.githubClientId.trim()) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(auth.githubClientId.trim())) throw new Error("auth.githubClientId does not look like a GitHub OAuth client id");
    cfg.auth.githubClientId = auth.githubClientId.trim();
  }
  if (process.env.SPENCER_PORT) cfg.http.port = Number(process.env.SPENCER_PORT);
  if (!Number.isInteger(cfg.http.port) || cfg.http.port < 0 || cfg.http.port > 65535) throw new Error("invalid http.port");
  cfg.relay = normalizeRelayUrl(process.env.SPENCER_RELAY || cfg.relay);
  const p = cfg.p2p;
  if ((p.mode !== "files" && p.mode !== "off") || typeof p.hideLocalAddresses !== "boolean" || !Number.isSafeInteger(p.minFileBytes) || p.minFileBytes < 0 || !Array.isArray(p.stun) || p.stun.length > 16 || !p.stun.every(x => { if (typeof x !== "string") return false; const m = /^(?:\[[^\[\]]+\]|[^:\s]+):(\d+)$/.exec(x); return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 65535; })) throw new Error("invalid p2p configuration");
  if (cfg.croc.throttleUpload !== null && !/^\d+[kKmMgG]?$/.test(String(cfg.croc.throttleUpload))) {
    throw new Error('croc.throttleUpload must look like "500k" (or null)');
  }
  for (const k of [
    "maxHops",
    "maxHopsFullTrust",
    "maxAgentTurns",
    "maxAgentTurnsFullTrust",
    "repliesPerMinute",
    "repliesPerHour",
    "repliesPerDay",
    "repliesPerMinuteFullTrust",
    "repliesPerHourFullTrust",
    "repliesPerDayFullTrust",
    "maxPendingFollowups",
    "maxFollowupChain",
  ] as const) {
    if (!Number.isSafeInteger(cfg.policy[k]) || cfg.policy[k] < 0) throw new Error(`policy.${k} must be a non-negative integer`);
  }
  for (const k of ["conversationMinMinutes", "conversationMaxMinutes", "conversationMessages"] as const) {
    if (!Number.isSafeInteger(cfg.policy[k]) || cfg.policy[k] < 1) throw new Error(`policy.${k} must be a positive integer`);
  }
  if (cfg.policy.conversationMaxMinutes < cfg.policy.conversationMinMinutes) {
    throw new Error("policy.conversationMaxMinutes must be at least policy.conversationMinMinutes");
  }
  const { conversationStartHour: start, conversationEndHour: end, conversationTimeZone: tz } = cfg.policy;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > 24 || start >= end) {
    throw new Error("policy.conversationStartHour and conversationEndHour must be whole hours with 0 <= start < end <= 24");
  }
  try {
    // Intl takes undefined (the system zone) and "" quietly: only a real zone name counts.
    if (typeof tz !== "string" || !tz.trim()) throw new Error();
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`policy.conversationTimeZone: unknown time zone ${JSON.stringify(tz)}`);
  }
  for (const [name, s] of Object.entries(cfg.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
    if (!("command" in s) && !("url" in s)) throw new Error(`MCP server ${name} needs command or url`);
  }
  return cfg;
}

const isStrMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/** Strict check of one MCP server entry from the UI; returns a clean copy (unknown keys dropped). */
export function validateMcpServer(name: string, raw: unknown): McpServerConfig {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("name: 1-32 letters, digits, - or _");
  if (/[_-]{2}/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
    throw new Error(`name: ${name} is not allowed`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("server config must be an object");
  const r = raw as Record<string, unknown>;
  if (r.disabled !== undefined && typeof r.disabled !== "boolean") throw new Error("disabled must be a boolean");
  if (r.disabledTools !== undefined && !(Array.isArray(r.disabledTools) && r.disabledTools.every((t) => typeof t === "string")))
    throw new Error("disabledTools must be a list of tool names");
  const off = [...new Set((r.disabledTools as string[] | undefined) ?? [])];
  const disabled = { ...(r.disabled === true ? { disabled: true } : {}), ...(off.length ? { disabledTools: off } : {}) };
  if ("url" in r && "command" in r) throw new Error("give either command or url, not both");
  if ("url" in r) {
    if (typeof r.url !== "string" || !/^https?:\/\/./.test(r.url)) throw new Error("url must start with http:// or https://");
    try {
      new URL(r.url);
    } catch {
      throw new Error("url is not valid");
    }
    if (r.headers !== undefined && !isStrMap(r.headers)) throw new Error("headers must map names to strings");
    return { url: r.url, ...(r.headers && Object.keys(r.headers).length ? { headers: r.headers as Record<string, string> } : {}), ...disabled };
  }
  if (typeof r.command !== "string" || !r.command.trim()) throw new Error("command (or url) is required");
  if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === "string"))) throw new Error("args must be a list of strings");
  if (r.env !== undefined && !isStrMap(r.env)) throw new Error("env must map names to strings");
  if (r.cwd !== undefined && (typeof r.cwd !== "string" || !r.cwd.trim())) throw new Error("cwd must be a path");
  const args = r.args as string[] | undefined;
  const env = r.env as Record<string, string> | undefined;
  return {
    command: r.command.trim(),
    ...(args?.length ? { args } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
    ...(r.cwd ? { cwd: (r.cwd as string).trim() } : {}),
    ...disabled,
  };
}

export function loadConfig(dataDir: string): SpencerConfig {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) {
    const cfg = defaultConfig();
    writeFileSync(file, JSON.stringify({ name: cfg.name, relay: cfg.relay, model: cfg.model, mcpServers: {} }, null, 2) + "\n", {
      mode: 0o600,
    });
    return cfg;
  }
  return resolveConfig(JSON.parse(readFileSync(file, "utf8")));
}
