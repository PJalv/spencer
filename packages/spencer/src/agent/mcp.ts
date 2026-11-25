/**
 * MCP client manager: connects every configured server (stdio or streamable HTTP) in the background, tracks
 * status, reconnects with backoff, and exposes each server tool as a `ToolSpec` named `mcp__<server>__<tool>`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config.ts";
import type { EventSink, McpServerStatus } from "../contracts.ts";
import { spencerVersion } from "../version.ts";
import type { ToolSpec } from "./runtime.ts";

export const MCP_RESULT_CAP = 32 * 1024;
const CALL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

interface McpTool {
  /** Exposed (sanitized) name. */
  name: string;
  /** Name on the server. */
  remote: string;
  description?: string;
  inputSchema: object;
}

interface ServerState {
  name: string;
  config: McpServerConfig;
  transport: "stdio" | "http";
  status: McpServerStatus["status"];
  error?: string;
  tools: McpTool[];
  client?: Client;
  closeTransport?: () => Promise<void>;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Bumped on every (re)connect, so stale callbacks from an old client do nothing. */
  generation: number;
}

const on = (s: ServerState, remote: string) => !s.config.disabledTools?.includes(remote);

/** True when two configs differ only in `disabledTools`. */
function sameConnection(a: McpServerConfig, b: McpServerConfig): boolean {
  const strip = ({ disabledTools: _, ...rest }: McpServerConfig) => canonical(rest);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Sorted keys; empty lists/maps and `disabled: false` dropped (hand-written config.json may have them). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined || x === false || (Array.isArray(x) && !x.length) || (x && typeof x === "object" && !Object.keys(x).length)) continue;
    out[k] = canonical(x);
  }
  return out;
}

/** `mcp__<server>__<tool>`, characters outside [A-Za-z0-9_] replaced by `_`, at most 64 chars. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
}

/** Format transport errors without exposing configured credentials or URL query strings. */
export function formatMcpError(error: unknown, config: McpServerConfig): string {
  const secrets = "url" in config ? Object.values(config.headers ?? {}).filter(Boolean) : Object.values(config.env ?? {}).filter(Boolean);
  if ("url" in config) {
    try { secrets.push(...new URL(config.url).searchParams.values()); } catch { /* Invalid URL is reported by the transport. */ }
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      const code = "code" in current && (typeof current.code === "string" || typeof current.code === "number") ? ` (${current.code})` : "";
      parts.push(`${current.message}${code}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  let message = parts.join(": ");
  for (const secret of secrets) {
    message = message.split(secret).join("[redacted]");
    for (const token of secret.split(/\s+/).filter((v) => v.length >= 6)) message = message.split(token).join("[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/\?[^#\s]*/, "?[redacted]").replace(/\/\/[^/@\s]+@/, "//[redacted]@"))
    .replace(/(bearer\s+)[^\s,;"']+/gi, "$1[redacted]")
    .replace(/(["']?(?:token|password|secret|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,;"'}&]+/gi, "$1[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 1000);
}

export class McpManager {
  private servers = new Map<string, ServerState>();
  private setQueue = new Map<string, Promise<void>>();
  private events?: EventSink;
  private log: (msg: string) => void;
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(configs: Record<string, McpServerConfig>, opts: { events?: EventSink; log?: (msg: string) => void } = {}) {
    this.events = opts.events;
    this.log = opts.log ?? (() => {});
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, {
        name,
        config,
        transport: "url" in config ? "http" : "stdio",
        status: config.disabled ? "disabled" : "connecting",
        tools: [],
        attempt: 0,
        generation: 0,
      });
    }
  }

  /** Add, replace (reconnecting it) or, with `undefined`, remove a server while running. */
  set(name: string, config: McpServerConfig | undefined): Promise<void> {
    // Calls for one name run in order, so overlapping edits can't orphan a child process.
    const run = (this.setQueue.get(name) ?? Promise.resolve()).then(() => this.applySet(name, config));
    const tail = run.catch(() => {});
    this.setQueue.set(name, tail);
    void tail.then(() => {
      if (this.setQueue.get(name) === tail) this.setQueue.delete(name);
    });
    return run;
  }

  private async applySet(name: string, config: McpServerConfig | undefined): Promise<void> {
    const old = this.servers.get(name);
    if (old && config && sameConnection(old.config, config)) {
      // Only the tool switches changed: keep the connection.
      old.config = config;
      this.changed();
      return;
    }
    if (old) {
      this.servers.delete(name);
      await this.teardown(old);
    }
    if (config && !this.stopped) {
      const s: ServerState = {
        name,
        config,
        transport: "url" in config ? "http" : "stdio",
        status: config.disabled ? "disabled" : "connecting",
        tools: [],
        attempt: 0,
        generation: 0,
      };
      this.servers.set(name, s);
      if (!config.disabled) void this.connect(s);
    }
    this.changed();
  }

  /** Start connecting every enabled server; returns at once. */
  start(): void {
    for (const s of this.servers.values()) if (s.status !== "disabled") void this.connect(s);
  }

  /** Called whenever a server's status or tool list changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => {
      const out: McpServerStatus = {
        name: s.name,
        transport: s.transport,
        status: s.status,
        tools: s.tools.map((t) => ({ name: t.name, remote: t.remote, ...(t.description ? { description: t.description } : {}), enabled: on(s, t.remote) })),
      };
      if (s.error) out.error = s.error;
      return out;
    });
  }

  /** Tools of connected servers. */
  tools(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const s of this.servers.values()) {
      if (s.status !== "connected") continue;
      for (const t of s.tools) if (on(s, t.remote)) out.push(this.spec(s.name, t));
    }
    return out;
  }

  /** Resolves when every enabled server is connected or has failed at least once (tests). */
  async settled(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if ([...this.servers.values()].every((s) => s.status !== "connecting")) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.servers.values()].map((s) => this.teardown(s)));
    this.listeners.clear();
  }

  private spec(server: string, t: McpTool): ToolSpec {
    return {
      name: t.name,
      description: `[MCP ${server}] ${t.description ?? t.remote}`.slice(0, 1024),
      parameters: t.inputSchema,
      execute: (args, ctx) => this.call(server, t.remote, args ?? {}, ctx.signal),
    };
  }

  /** Call a tool; text content joined and capped, `isError` respected. Never throws. */
  async call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const s = this.servers.get(server);
    if (!s || s.status !== "connected" || !s.client) return { text: `MCP server ${server} is not connected.`, isError: true };
    if (!on(s, tool)) return { text: `The ${tool} tool of MCP server ${server} is turned off.`, isError: true };
    try {
      const res = await s.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
      const parts: string[] = [];
      const content = Array.isArray(res.content) ? res.content : [];
      for (const c of content as { type: string; text?: string; resource?: { uri?: string; text?: string } }[]) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c.type === "resource" && c.resource) parts.push(c.resource.text ?? `[resource ${c.resource.uri ?? ""}]`);
        else parts.push(`[${c.type}]`);
      }
      if (parts.length === 0 && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
      return { text: cap(parts.join("\n")), isError: res.isError === true };
    } catch (e) {
      return { text: `MCP call failed: ${formatMcpError(e, s.config)}`, isError: true };
    }
  }

  private changed(): void {
    if (this.stopped) return;
    this.events?.emit({ type: "mcp", servers: this.status() });
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        this.log(`mcp listener failed: ${(e as Error).message}`);
      }
    }
  }

  private async connect(s: ServerState): Promise<void> {
    if (this.stopped) return;
    const generation = ++s.generation;
    s.status = "connecting";
    s.error = undefined;
    this.changed();
    const client = new Client({ name: "spencer", version: spencerVersion() });
    let stderrTail = "";
    try {
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if ("url" in s.config) {
        transport = new StreamableHTTPClientTransport(new URL(s.config.url), { requestInit: { headers: s.config.headers ?? {} } });
      } else {
        transport = new StdioClientTransport({
          command: s.config.command,
          args: s.config.args ?? [],
          env: { ...getDefaultEnvironment(), ...(s.config.env ?? {}) },
          cwd: s.config.cwd,
          stderr: "pipe",
        });
        // Drain stderr (a full pipe would block the child); keep a short tail for error messages.
        transport.stderr?.on("data", (d: Buffer) => {
          stderrTail = (stderrTail + d.toString("utf8")).slice(-2000);
        });
      }
      s.client = client;
      s.closeTransport = () => transport.close();
      client.onclose = () => {
        if (this.stopped || s.generation !== generation) return;
        s.status = "error";
        s.error = "connection closed" + (stderrTail ? `: ${stderrTail.trim().split("\n").pop()}` : "");
        s.tools = [];
        s.client = undefined;
        this.changed();
        this.schedule(s);
      };
      client.onerror = (e) => this.log(`mcp ${s.name}: ${formatMcpError(e, s.config)}`);
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      if (this.stopped || s.generation !== generation) {
        await client.close().catch(() => {});
        return;
      }
      if (client.getServerCapabilities()?.tools?.listChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          if (s.generation !== generation) return;
          try {
            s.tools = await this.listTools(s.name, client);
            this.changed();
          } catch (e) {
            this.log(`mcp ${s.name}: relisting tools failed: ${formatMcpError(e, s.config)}`);
          }
        });
      }
      s.tools = await this.listTools(s.name, client);
      s.status = "connected";
      s.attempt = 0;
      this.changed();
    } catch (e) {
      if (this.stopped || s.generation !== generation) return;
      const msg = formatMcpError(e, s.config);
      s.status = "error";
      s.error = msg + (stderrTail ? ` (${stderrTail.trim().split("\n").pop()})` : "");
      s.tools = [];
      await this.teardown(s, false);
      this.changed();
      this.schedule(s);
    }
  }

  private async listTools(server: string, client: Client): Promise<McpTool[]> {
    const out: McpTool[] = [];
    const used = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        let name = mcpToolName(server, t.name);
        for (let i = 2; used.has(name); i++) name = name.slice(0, 64 - String(i).length - 1) + "_" + i;
        used.add(name);
        const schema: Record<string, unknown> = { ...(t.inputSchema as Record<string, unknown>) };
        delete schema.$schema;
        if (schema.type !== "object") schema.type = "object";
        out.push({ name, remote: t.name, description: t.description, inputSchema: schema });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  private schedule(s: ServerState): void {
    if (this.stopped || s.timer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** s.attempt);
    s.attempt++;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      void this.teardown(s, false).then(() => this.connect(s));
    }, delay);
    s.timer.unref?.();
  }

  private async teardown(s: ServerState, clearTimer = true): Promise<void> {
    if (clearTimer && s.timer) {
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    const client = s.client;
    const closeTransport = s.closeTransport;
    // Retire the old client first, so its onclose (fired by close() below) is ignored.
    s.generation++;
    s.client = undefined;
    s.closeTransport = undefined;
    // Client.close() closes the transport; for stdio that ends stdin, then SIGTERM/SIGKILL the child.
    if (client) await client.close().catch(() => {});
    else if (closeTransport) await closeTransport().catch(() => {});
    if (this.stopped && s.status !== "disabled") {
      s.status = "error";
      s.error = "stopped";
    }
  }
}

function cap(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MCP_RESULT_CAP) return s;
  const buf = Buffer.from(s, "utf8").subarray(0, MCP_RESULT_CAP);
  return buf.toString("utf8").replace(/�$/, "") + "\n[truncated to 32 KB]";
}
