/**
 * Standalone MCP 2026-07-28 + MCP Events (`io.modelcontextprotocol/events`, SEP-3415 Beta) HTTP client.
 *
 * Kept separate from `@modelcontextprotocol/sdk` 1.32.2 (which tops out at 2025-11-25) so existing
 * stdio/HTTP tool servers stay untouched while any HTTP MCP server advertising `2026-07-28` + Events
 * can deliver durable push (`events/stream`) or fallback poll (`events/poll`) events.
 */
import type { McpServerConfig } from "../config.ts";
import { formatMcpError } from "./mcp.ts";

export const MCP_EVENTS_PROTOCOL_VERSION = "2026-07-28";
export const MCP_EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";
export const MCP_SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export type McpEventDeliveryMode = "push" | "poll" | "webhook";
type Obj = Record<string, any>;

export interface McpEventDescriptor {
  name: string;
  description?: string;
  delivery: McpEventDeliveryMode[];
  inputSchema?: Obj;
  payloadSchema?: Obj;
  /** Validated `x-mcp-header` map: argument property name -> header suffix (`Mcp-Param-<suffix>`). */
  headerParams: Record<string, string>;
  _meta?: Obj;
}

export interface McpEventsDiscovery {
  supported: boolean;
  revoked?: boolean;
  /** True when discovery failed due to a transient network/5xx/timeout error and should be retried later. */
  transient?: boolean;
  events: McpEventDescriptor[];
  error?: string;
  protocolVersion?: string;
  serverIdentity?: string;
  listChanged?: boolean;
  /** True when Events was detected via T3/pre-SEP-3415 top-level `capabilities.events` compatibility shim. */
  legacyFallback?: boolean;
}

export interface McpEventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Obj;
  cursor: string | null;
  _meta?: Obj;
}

export interface McpEventGap {
  cursor: string | null;
  reason: "truncated" | "gap";
}

export interface McpEventTerminated {
  code: number;
  message: string;
  data?: Obj;
  revoked: boolean;
  notFound?: boolean;
  schemaChanged?: boolean;
}

export interface McpEventStreamHandle {
  stop(): Promise<void>;
}

export interface DiscoverMcpEventsOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface McpEventSubscriptionOptions {
  config: McpServerConfig;
  event: McpEventDescriptor;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  /** Read the latest safely persisted cursor before each connect/reconnect/poll. */
  getCursor?: () => string | null;
  maxAgeMs?: number;
  maxEvents?: number;
  heartbeatMs?: number;
  livenessMultiplier?: number;
  wakeCheckMs?: number;
  wakeJumpMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  pollFloorMs?: number;
  onActive?: (v: { cursor: string | null; truncated: boolean; heartbeatMs: number }) => void | Promise<void>;
  onEvent: (v: McpEventOccurrence) => void | Promise<void>;
  onGap: (v: McpEventGap) => void | Promise<void>;
  onHeartbeat?: (v: { cursor: string | null }) => void | Promise<void>;
  onError?: (v: { message: string; code?: number; transient: boolean }) => void;
  onTerminated: (v: McpEventTerminated) => void | Promise<void>;
  onHeaderMismatch?: () => Promise<McpEventDescriptor | undefined>;
  log?: (msg: string) => void;
}

const CLIENT_CAPABILITIES_META = {
  [MCP_CLIENT_CAPABILITIES_META_KEY]: {
    extensions: {
      [MCP_EVENTS_EXTENSION_ID]: {},
    },
  },
};

const DEFAULT_DISCOVER_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 15_000;
const MAX_LIST_PAGES = 50;

const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** SEP-2243 routing header encoding: plain printable ASCII (0x21..0x7e) unless unsafe or prefixed `b64:`. */
export function encodeMcpRoutingHeader(value: string): string {
  return /^[\x21-\x7e]+$/.test(value) && !value.startsWith("b64:")
    ? value
    : `b64:${Buffer.from(value, "utf8").toString("base64")}`;
}

/** Lightweight JSON Schema validator for subscription arguments so invalid filters fail fast. */
export function validateEventArguments(descriptor: McpEventDescriptor, args: Record<string, unknown>): string | undefined {
  const check = (schema: Obj, value: unknown, path: string): string | undefined => {
    if (Array.isArray(schema.enum) && !schema.enum.some((v: unknown) => JSON.stringify(v) === JSON.stringify(value))) {
      return `${path} must be one of the allowed values`;
    }
    const t = schema.type;
    if (typeof t === "string") {
      const ok =
        t === "object"
          ? isObject(value)
          : t === "array"
            ? Array.isArray(value)
            : t === "integer"
              ? typeof value === "number" && Number.isInteger(value)
              : t === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : t === "null"
                  ? value === null
                  : typeof value === t;
      if (!ok) return `${path} must be ${t}`;
    } else if (Array.isArray(t)) {
      const matchesAny = t.some((one) => typeof one === "string" && check({ type: one }, value, path) === undefined);
      if (!matchesAny) return `${path} must match one of ${t.join(" | ")}`;
    }
    if (isObject(value)) {
      if (Array.isArray(schema.required)) {
        for (const k of schema.required) {
          if (typeof k === "string" && !(k in value)) return `${path}.${k} is required`;
        }
      }
      const props = isObject(schema.properties) ? schema.properties : undefined;
      if (schema.additionalProperties === false && props) {
        for (const k of Object.keys(value)) {
          if (!(k in props)) return `${path}.${k} is not an allowed argument`;
        }
      }
      if (props) {
        for (const [k, propSchema] of Object.entries(props)) {
          if (k in value && isObject(propSchema)) {
            const err = check(propSchema, value[k], `${path}.${k}`);
            if (err) return err;
          }
        }
      }
    }
    if (Array.isArray(value) && isObject(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const err = check(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
    return undefined;
  };
  return check(descriptor.inputSchema ?? { type: "object" }, args, "arguments");
}

function parseDescriptor(v: unknown, log?: (msg: string) => void): McpEventDescriptor | undefined {
  if (!isObject(v) || typeof v.name !== "string" || !v.name || !Array.isArray(v.delivery)) return undefined;
  const headerParams: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  const props = isObject(v.inputSchema) && isObject(v.inputSchema.properties) ? v.inputSchema.properties : undefined;
  if (props) {
    for (const [key, schema] of Object.entries(props)) {
      if (isObject(schema) && "x-mcp-header" in schema) {
        const header = schema["x-mcp-header"];
        if (typeof header !== "string" || !/^[A-Za-z0-9-]+$/.test(header) || seenHeaders.has(header.toLowerCase())) {
          log?.(`mcp-events: excluding event ${JSON.stringify(v.name)} due to invalid x-mcp-header annotation`);
          return undefined;
        }
        seenHeaders.add(header.toLowerCase());
        headerParams[key] = header;
      }
    }
  }
  const delivery = v.delivery.filter((x: unknown): x is McpEventDeliveryMode => x === "push" || x === "poll" || x === "webhook");
  return {
    name: v.name,
    ...(typeof v.description === "string" ? { description: v.description } : {}),
    delivery,
    ...(isObject(v.inputSchema) ? { inputSchema: v.inputSchema } : {}),
    ...(isObject(v.payloadSchema) ? { payloadSchema: v.payloadSchema } : {}),
    headerParams,
    ...(isObject(v._meta) ? { _meta: v._meta } : {}),
  };
}

/**
 * Isolated compatibility helper for T3 Code / pre-SEP-3415 servers that advertise top-level `capabilities.events`
 * instead of (or alongside) `capabilities.extensions["io.modelcontextprotocol/events"]`.
 */
function detectEventsCapability(capabilities: unknown): { supported: boolean; listChanged: boolean; legacyFallback: boolean } {
  if (!isObject(capabilities)) return { supported: false, listChanged: false, legacyFallback: false };
  const extensions = isObject(capabilities.extensions) ? capabilities.extensions : undefined;
  const standard = extensions?.[MCP_EVENTS_EXTENSION_ID];
  if (isObject(standard)) {
    return { supported: true, listChanged: standard.listChanged === true, legacyFallback: false };
  }
  if (isObject(capabilities.events)) {
    return { supported: true, listChanged: capabilities.events.listChanged === true, legacyFallback: true };
  }
  return { supported: false, listChanged: false, legacyFallback: false };
}

function resolveDiscoverProtocolVersion(result: Obj, responseHeader: string | null): { supported: boolean; version?: string; reported?: string } {
  const versions: string[] = [];
  if (Array.isArray(result.supportedVersions)) {
    for (const v of result.supportedVersions) if (typeof v === "string" && v) versions.push(v);
  }
  if (typeof result.protocolVersion === "string" && result.protocolVersion) {
    versions.push(result.protocolVersion);
  }
  if (versions.length > 0) {
    if (versions.includes(MCP_EVENTS_PROTOCOL_VERSION)) {
      return { supported: true, version: MCP_EVENTS_PROTOCOL_VERSION };
    }
    const eligible = versions.filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= MCP_EVENTS_PROTOCOL_VERSION).sort();
    if (eligible.length > 0) {
      return { supported: true, version: eligible.at(-1)! };
    }
    return { supported: false, reported: versions.join(", ") };
  }
  if (responseHeader && /^\d{4}-\d{2}-\d{2}$/.test(responseHeader)) {
    return responseHeader >= MCP_EVENTS_PROTOCOL_VERSION
      ? { supported: true, version: responseHeader }
      : { supported: false, reported: responseHeader };
  }
  // A stateless 2026-07-28 server accepted our `Mcp-Protocol-Version: 2026-07-28` discover call.
  return { supported: true, version: MCP_EVENTS_PROTOCOL_VERSION };
}

function buildServerIdentity(result: Obj, config: McpServerConfig): string | undefined {
  const info =
    (isObject(result._meta) && isObject(result._meta[MCP_SERVER_INFO_META_KEY])
      ? result._meta[MCP_SERVER_INFO_META_KEY]
      : undefined) ?? (isObject(result.serverInfo) ? result.serverInfo : undefined);
  let endpoint = "";
  if ("url" in config) {
    try {
      const u = new URL(config.url);
      endpoint = `${u.origin}${u.pathname}`;
    } catch {
      endpoint = "";
    }
  }
  if (info && typeof info.name === "string" && info.name) {
    const version = typeof info.version === "string" && info.version ? `@${info.version}` : "";
    return endpoint ? `${info.name}${version} (${endpoint})` : `${info.name}${version}`;
  }
  return endpoint || undefined;
}

class RpcError extends Error {
  code: number;
  httpStatus?: number;
  data?: Obj;
  constructor(code: number, message: string, opts: { httpStatus?: number; data?: Obj } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.data = opts.data;
  }
}

async function parseErrorResponse(res: Response): Promise<RpcError> {
  const status = res.status;
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isObject(parsed) && isObject(parsed.error)) {
      const err = parsed.error;
      const code =
        typeof err.code === "number"
          ? err.code
          : status === 401 || status === 403
            ? -32024
            : status;
      const message = typeof err.message === "string" && err.message ? err.message : `HTTP ${status}`;
      return new RpcError(code, message, { httpStatus: status, data: isObject(err.data) ? err.data : undefined });
    }
  } catch {
    /* non-JSON HTTP error body */
  }
  const detail = bodyText.trim().slice(0, 200);
  const message = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  return new RpcError(status === 401 || status === 403 ? -32024 : status, message, { httpStatus: status });
}

function encodeHeaderParamValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return encodeMcpRoutingHeader(raw);
}

async function mcpPost(
  config: McpServerConfig,
  method: string,
  params: Obj,
  opts: {
    id: number;
    signal?: AbortSignal;
    event?: McpEventDescriptor;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  if (!("url" in config)) throw new RpcError(-32026, "MCP Events requires an HTTP MCP server");
  const headers = new Headers(config.headers ?? {});
  // Never send a browser Origin header; MCP HTTP servers (including T3 Code) reject requests with Origin.
  headers.delete("origin");
  headers.set("content-type", "application/json");
  headers.set("accept", method === "events/stream" ? "text/event-stream, application/json" : "application/json, text/event-stream");
  headers.set("mcp-protocol-version", MCP_EVENTS_PROTOCOL_VERSION);
  headers.set("mcp-method", method);
  if (opts.event) {
    headers.set("mcp-name", encodeMcpRoutingHeader(opts.event.name));
    const args = isObject(params.arguments) ? params.arguments : undefined;
    if (args) {
      for (const [argKey, headerSuffix] of Object.entries(opts.event.headerParams)) {
        if (argKey in args && args[argKey] !== undefined) {
          headers.set(`mcp-param-${headerSuffix}`, encodeHeaderParamValue(args[argKey]));
        }
      }
    }
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id, method, params }),
    signal: opts.signal,
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res;
}

async function parseJsonRpcResult(res: Response, expectedId?: number): Promise<Obj> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  let raw: unknown;
  if (contentType.includes("text/event-stream")) {
    const body = await res.text();
    const frames: Obj[] = [];
    let dataLines: string[] = [];
    const flush = () => {
      if (!dataLines.length) return;
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload) return;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (isObject(parsed)) frames.push(parsed);
      } catch {
        /* ignore non-JSON SSE frames */
      }
    };
    for (const rawLine of body.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) flush();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    flush();
    raw =
      (expectedId !== undefined ? frames.find((f) => f.id === expectedId && ("result" in f || "error" in f)) : undefined) ??
      frames.find((f) => "result" in f || "error" in f);
  } else {
    raw = (await res.json()) as unknown;
  }
  if (!isObject(raw)) throw new RpcError(-32603, "Invalid JSON-RPC response");
  if (isObject(raw.error)) {
    const code = typeof raw.error.code === "number" ? raw.error.code : -32603;
    const message = typeof raw.error.message === "string" ? raw.error.message : "JSON-RPC error";
    throw new RpcError(code, message, { data: isObject(raw.error.data) ? raw.error.data : undefined });
  }
  return isObject(raw.result) ? raw.result : {};
}

function isRevocationError(error: RpcError): boolean {
  return error.code === -32024 || error.httpStatus === 401 || error.httpStatus === 403;
}

function parseNotificationError(params: Obj): RpcError {
  const nested = isObject(params.error) ? params.error : params;
  const code = typeof nested.code === "number" ? nested.code : -32603;
  const message = typeof nested.message === "string" && nested.message ? nested.message : "Event stream error";
  const data = isObject(nested.data) ? nested.data : undefined;
  return new RpcError(code, message, { data });
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Probe an HTTP MCP server with `server/discover` and (when advertised) paginate `events/list`.
 * Never throws; incompatibility and auth revocation are returned as structured fields.
 */
export async function discoverMcpEvents(config: McpServerConfig, opts: DiscoverMcpEventsOptions = {}): Promise<McpEventsDiscovery> {
  if (!("url" in config)) {
    return {
      supported: false,
      events: [],
      error: "MCP Events requires an HTTP MCP server (stdio servers are not supported for HTTP events).",
    };
  }
  const timeout = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS);
  try {
    let reqId = 1;
    const discoverId = reqId++;
    const discoverRes = await mcpPost(config, "server/discover", {}, { id: discoverId, signal: timeout.signal, fetchImpl: opts.fetch });
    const discover = await parseJsonRpcResult(discoverRes, discoverId);
    const version = resolveDiscoverProtocolVersion(discover, discoverRes.headers.get("mcp-protocol-version"));
    const serverIdentity = buildServerIdentity(discover, config);
    if (!version.supported) {
      return {
        supported: false,
        events: [],
        ...(version.reported ? { protocolVersion: version.reported } : {}),
        ...(serverIdentity ? { serverIdentity } : {}),
        error: `MCP Events requires protocol ${MCP_EVENTS_PROTOCOL_VERSION} or later (server reported: ${version.reported ?? "unknown"}).`,
      };
    }
    const cap = detectEventsCapability(discover.capabilities);
    if (!cap.supported) {
      return {
        supported: false,
        events: [],
        protocolVersion: version.version,
        ...(serverIdentity ? { serverIdentity } : {}),
        error: `Server does not advertise the ${MCP_EVENTS_EXTENSION_ID} extension.`,
      };
    }
    const events: McpEventDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listId = reqId++;
      const listRes = await mcpPost(
        config,
        "events/list",
        { ...(cursor ? { cursor } : {}), _meta: CLIENT_CAPABILITIES_META },
        { id: listId, signal: timeout.signal, fetchImpl: opts.fetch },
      );
      const list = await parseJsonRpcResult(listRes, listId);
      if (Array.isArray(list.events)) {
        for (const raw of list.events) {
          const parsed = parseDescriptor(raw, opts.log);
          if (parsed) events.push(parsed);
        }
      }
      cursor = typeof list.nextCursor === "string" && list.nextCursor ? list.nextCursor : undefined;
      if (!cursor) break;
      if (page === MAX_LIST_PAGES - 1) {
        throw new Error(`events/list pagination exceeded ${MAX_LIST_PAGES} pages`);
      }
    }
    return {
      supported: true,
      events,
      protocolVersion: version.version,
      ...(serverIdentity ? { serverIdentity } : {}),
      listChanged: cap.listChanged,
      ...(cap.legacyFallback ? { legacyFallback: true } : {}),
    };
  } catch (e) {
    const revoked = e instanceof RpcError && isRevocationError(e);
    const incompatible =
      e instanceof RpcError &&
      (e.code === -32601 || e.code === -32026 || e.httpStatus === 400 || e.httpStatus === 404 || e.httpStatus === 405);
    const transient = !revoked && !incompatible;
    const detail = formatMcpError(e, config);
    return {
      supported: false,
      ...(revoked ? { revoked: true } : {}),
      ...(transient ? { transient: true } : {}),
      events: [],
      error: revoked
        ? `Authorization failed or revoked: ${detail}`
        : incompatible
          ? `Server does not support MCP ${MCP_EVENTS_PROTOCOL_VERSION} Events (${detail}).`
          : detail,
    };
  } finally {
    timeout.cleanup();
  }
}

/**
 * Open a durable, self-healing MCP Events subscription over Push (`events/stream`) with automatic
 * Poll (`events/poll`) fallback when an event descriptor advertises `"poll"` without `"push"`.
 */
export function openMcpEventSubscription(o: McpEventSubscriptionOptions): McpEventStreamHandle {
  let stopped = false;
  let controller: AbortController | undefined;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  let sleepResolve: (() => void) | undefined;
  let wakeTimer: ReturnType<typeof setInterval> | undefined;
  let event = o.event;
  let headerMismatchRetried = false;
  let attempt = 0;
  let reqSeq = 0;

  const now = o.now ?? Date.now;
  const readCursor = () => (o.getCursor ? o.getCursor() : (o.cursor ?? null));

  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      sleepResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = undefined;
        sleepResolve = undefined;
        resolve();
      }, Math.max(0, ms));
      sleepTimer.unref?.();
    });

  const terminate = async (err: RpcError): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const revoked = isRevocationError(err);
    await o.onTerminated({
      code: revoked ? -32024 : err.code,
      message: formatMcpError(err, o.config),
      ...(err.data ? { data: err.data } : {}),
      revoked,
      notFound: err.code === -32023,
      schemaChanged: err.code === -32026 && err.data?.reason === "schema_changed",
    });
  };

  const deliverOccurrence = async (raw: Obj, cursorValue: string | null): Promise<void> => {
    if (
      typeof raw.eventId !== "string" ||
      !raw.eventId ||
      raw.name !== event.name ||
      typeof raw.timestamp !== "string" ||
      !isObject(raw.data)
    ) {
      o.log?.(`mcp-events: ignored malformed occurrence for ${event.name}`);
      return;
    }
    await o.onEvent({
      eventId: raw.eventId,
      name: raw.name,
      timestamp: raw.timestamp,
      data: raw.data,
      cursor: cursorValue,
      ...(isObject(raw._meta) ? { _meta: raw._meta } : {}),
    });
  };

  const run = async (): Promise<void> => {
    const args = o.arguments ?? {};
    const invalid = validateEventArguments(event, args);
    if (invalid) {
      await terminate(new RpcError(-32602, invalid));
      return;
    }
    const usePush = event.delivery.includes("push");
    if (!usePush && !event.delivery.includes("poll")) {
      await terminate(
        new RpcError(-32026, `Event "${event.name}" does not support push or poll delivery (offered: ${event.delivery.join(", ") || "none"})`, {
          data: { feature: "deliveryMode", value: "push" },
        }),
      );
      return;
    }

    while (!stopped) {
      controller = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const reqId = ++reqSeq;
        const currentCursor = readCursor();
        const params: Obj = {
          name: event.name,
          arguments: args,
          cursor: currentCursor,
          ...(o.maxAgeMs !== undefined ? { maxAgeMs: o.maxAgeMs } : {}),
          _meta: CLIENT_CAPABILITIES_META,
        };
        if (usePush) {
          params.heartbeatMs = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        } else if (o.maxEvents !== undefined) {
          params.maxEvents = o.maxEvents;
        }

        const res = await mcpPost(o.config, usePush ? "events/stream" : "events/poll", params, {
          id: reqId,
          signal: controller.signal,
          event,
          fetchImpl: o.fetch,
        });

        if (!usePush) {
          const result = await parseJsonRpcResult(res, reqId);
          attempt = 0;
          headerMismatchRetried = false;
          const nextCursor = typeof result.cursor === "string" ? result.cursor : null;
          const items = Array.isArray(result.events) ? result.events.filter(isObject) : [];
          if (result.truncated === true) {
            await o.onGap({ cursor: items.length > 0 ? null : nextCursor, reason: "truncated" });
          }
          for (let i = 0; i < items.length; i++) {
            await deliverOccurrence(items[i]!, i === items.length - 1 ? nextCursor : null);
            if (stopped) return;
          }
          if (items.length === 0) {
            await o.onHeartbeat?.({ cursor: nextCursor });
          }
          if (result.hasMore !== true && !stopped) {
            const floor = o.pollFloorMs ?? 1_000;
            const suggested = typeof result.nextPollMs === "number" && Number.isFinite(result.nextPollMs) ? result.nextPollMs : DEFAULT_POLL_MS;
            await pause(Math.max(floor, suggested));
          }
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) {
          // Server replied with JSON (likely a JSON-RPC error or immediate complete result).
          await parseJsonRpcResult(res, reqId);
          if (!stopped) throw new Error("events/stream returned non-SSE response");
          return;
        }
        if (!res.body) throw new Error("events/stream response had no body");

        let grantedHeartbeat = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        const multiplier = o.livenessMultiplier ?? 3;
        const resetWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => controller?.abort(new Error("heartbeat timeout")), Math.max(10, grantedHeartbeat * multiplier));
          watchdog.unref?.();
        };
        resetWatchdog();

        let lastWall = now();
        const wakeJumpMs = o.wakeJumpMs ?? 10_000;
        wakeTimer = setInterval(() => {
          const t = now();
          if (t - lastWall > wakeJumpMs) controller?.abort(new Error("system wake detected"));
          lastWall = t;
        }, o.wakeCheckMs ?? 5_000);
        wakeTimer.unref?.();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let dataLines: string[] = [];

        const dispatchFrame = async () => {
          if (dataLines.length === 0) return;
          const payload = dataLines.join("\n");
          dataLines = [];
          if (!payload.trim()) return;
          resetWatchdog();
          let msg: unknown;
          try {
            msg = JSON.parse(payload);
          } catch {
            o.log?.(`mcp-events: ignored non-JSON SSE frame on ${event.name}`);
            return;
          }
          if (!isObject(msg)) return;
          const p = isObject(msg.params) ? msg.params : {};
          switch (msg.method) {
            case "notifications/events/active": {
              attempt = 0;
              headerMismatchRetried = false;
              if (typeof p.heartbeatMs === "number" && Number.isFinite(p.heartbeatMs) && p.heartbeatMs > 0) {
                grantedHeartbeat = p.heartbeatMs;
              }
              resetWatchdog();
              const activeCursor = typeof p.cursor === "string" ? p.cursor : null;
              const truncated = p.truncated === true;
              await o.onActive?.({ cursor: activeCursor, truncated, heartbeatMs: grantedHeartbeat });
              if (truncated) {
                await o.onGap({ cursor: activeCursor, reason: "truncated" });
              }
              break;
            }
            case "notifications/events/event": {
              const evCursor = typeof p.cursor === "string" ? p.cursor : null;
              await deliverOccurrence(p, evCursor);
              break;
            }
            case "notifications/events/heartbeat": {
              const hbCursor = typeof p.cursor === "string" ? p.cursor : null;
              await o.onHeartbeat?.({ cursor: hbCursor });
              break;
            }
            case "notifications/events/error": {
              const err = parseNotificationError(p);
              o.onError?.({ message: formatMcpError(err, o.config), code: err.code, transient: true });
              break;
            }
            case "notifications/events/terminated": {
              await terminate(parseNotificationError(p));
              controller?.abort();
              break;
            }
            default: {
              if (msg.id === reqId && isObject(msg.error)) {
                throw parseNotificationError({ error: msg.error });
              }
              // Final `StreamEventsResult` (id === reqId && result): stream closed cleanly by server.
              break;
            }
          }
        };

        const processLine = async (rawLine: string) => {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (!line) {
            await dispatchFrame();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        };

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) {
            const tail = buffer + decoder.decode();
            buffer = "";
            if (tail) await processLine(tail);
            await dispatchFrame();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            await processLine(line);
            if (stopped) break;
          }
        }
        if (!stopped) throw new Error("events/stream closed");
      } catch (e) {
        if (stopped) break;
        if (e instanceof RpcError && e.code === -32020 && !headerMismatchRetried && o.onHeaderMismatch) {
          headerMismatchRetried = true;
          const refreshed = await o.onHeaderMismatch().catch(() => undefined);
          if (refreshed) {
            event = refreshed;
            continue;
          }
        }
        if (
          e instanceof RpcError &&
          (isRevocationError(e) || e.code === -32023 || e.code === -32602 || e.code === -32026 || e.code === -32020)
        ) {
          await terminate(e);
          break;
        }
        const reason = controller?.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : e;
        o.onError?.({
          message: formatMcpError(reason, o.config),
          ...(e instanceof RpcError ? { code: e.code } : {}),
          transient: true,
        });
        if (!stopped) {
          const delay = Math.min(o.backoffMaxMs ?? 60_000, (o.backoffMinMs ?? 1_000) * 2 ** Math.min(attempt++, 16));
          await pause(delay * (0.8 + Math.random() * 0.4));
        }
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (wakeTimer) clearInterval(wakeTimer);
        wakeTimer = undefined;
        controller = undefined;
      }
    }
  };

  const done = run().catch(async (e) => {
    if (!stopped) await terminate(new RpcError(-32603, formatMcpError(e, o.config)));
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      controller?.abort(new Error("stopped"));
      if (sleepTimer) clearTimeout(sleepTimer);
      sleepTimer = undefined;
      sleepResolve?.();
      sleepResolve = undefined;
      if (wakeTimer) clearInterval(wakeTimer);
      wakeTimer = undefined;
      await done;
    },
  };
}
