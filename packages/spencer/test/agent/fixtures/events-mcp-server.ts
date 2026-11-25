/**
 * Controllable local HTTP MCP server fixture supporting BOTH:
 *  - Legacy 2025-11-25 MCP (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) so Spencer's
 *    existing `McpManager` connects and executes outbound tools against the same endpoint, AND
 *  - MCP 2026-07-28 + Events (`server/discover`, `events/list`, `events/stream`, `events/poll`).
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): string | { text: string; isError?: boolean } | Promise<string | { text: string; isError?: boolean }>;
}

export interface FakeEventsMcpServerOptions {
  protocolVersion?: string;
  supportedVersions?: string[];
  legacyCapabilityOnly?: boolean;
  omitEventsCapability?: boolean;
  serverInfo?: { name: string; version: string };
  events?: Record<string, unknown>[];
  tools?: FakeMcpTool[];
  authToken?: string;
  heartbeatMs?: number;
  autoHeartbeat?: boolean;
  bufferSize?: number;
  pageSize?: number;
  nextPollMs?: number;
  /** Enforce a required `mcp-param-<header>` check on `events/stream` / `events/poll`. */
  requiredHeaderParam?: { arg: string; header: string };
  /** Force `server/discover` to fail with a JSON-RPC / HTTP error (for testing discovery errors). */
  discoverError?: { httpStatus?: number; code: number; message: string; data?: Record<string, unknown> };
}

function decodeMcpRoutingHeader(value: string): string {
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    return Buffer.from(value.slice("=?base64?".length, -"?=".length), "base64").toString("utf8");
  }
  return value;
}

interface StreamClient {
  id: number | string;
  res: ServerResponse;
  name: string;
  args: Record<string, unknown>;
  timer?: ReturnType<typeof setInterval>;
}

interface BufferedEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string;
  seq: number;
}

function matchesArgs(args: Record<string, unknown>, data: Record<string, unknown>): boolean {
  for (const [k, filterVal] of Object.entries(args)) {
    if (filterVal === undefined) continue;
    if (k === "threadIds" && Array.isArray(filterVal)) {
      if (typeof data.threadId !== "string" || !filterVal.includes(data.threadId)) return false;
      continue;
    }
    if (k === "projectIds" && Array.isArray(filterVal)) {
      if (typeof data.projectId !== "string" || !filterVal.includes(data.projectId)) return false;
      continue;
    }
    if (k === "workflowRunIds" && Array.isArray(filterVal)) {
      if (typeof data.workflowRunId !== "string" || !filterVal.includes(data.workflowRunId)) return false;
      continue;
    }
    if (k === "workflows" && Array.isArray(filterVal)) {
      if (typeof data.workflow !== "string" || !filterVal.includes(data.workflow)) return false;
      continue;
    }
    if (Array.isArray(filterVal)) {
      if (!filterVal.includes(data[k])) return false;
    } else if (data[k] !== filterVal) {
      return false;
    }
  }
  return true;
}

export function defaultT3LikeEvents(): Record<string, unknown>[] {
  const threadInputSchema = {
    type: "object",
    properties: {
      projectIds: { type: "array", items: { type: "string" } },
      threadIds: { type: "array", items: { type: "string" } },
      workflowRunIds: { type: "array", items: { type: "string" } },
      includeSubagentChildren: { type: "boolean" },
    },
  };
  return [
    {
      name: "thread.run_settled",
      description: "A thread's turn ended: completed, failed, interrupted or cancelled.",
      delivery: ["push", "poll"],
      inputSchema: threadInputSchema,
    },
    {
      name: "thread.needs_input",
      description: "An agent waits on a person to answer a question or approve an action.",
      delivery: ["push", "poll"],
      inputSchema: threadInputSchema,
    },
    {
      name: "pr.watch_wake",
      description: "A watched pull request changed and woke its thread.",
      delivery: ["push", "poll"],
      inputSchema: threadInputSchema,
    },
  ];
}

export async function createEventsMcpServer(options: FakeEventsMcpServerOptions = {}) {
  let events = [...(options.events ?? defaultT3LikeEvents())];
  const tools = options.tools ?? [];
  const requestLog: { method: string; headers: IncomingHttpHeaders; body: any }[] = [];
  const streams = new Set<StreamClient>();
  let revoked = false;
  let revokeStatus: 401 | 403 = 401;
  let epoch = 1;
  let sequence = 0;
  let buffer: BufferedEvent[] = [];
  let requiredHeaderParam = options.requiredHeaderParam;
  let discoverError = options.discoverError;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const bufferSize = options.bufferSize ?? 100;

  const cursorStr = (seq = sequence) => `${epoch}.${seq}`;
  const parseCursor = (c: unknown): { epoch: number; seq: number } | undefined => {
    if (typeof c !== "string") return undefined;
    const [e, s] = c.split(".");
    const en = Number(e);
    const sn = Number(s);
    if (!Number.isSafeInteger(en) || !Number.isSafeInteger(sn) || sn < 0) return undefined;
    return { epoch: en, seq: sn };
  };
  const isTruncated = (c: unknown): boolean => {
    if (c === null || c === undefined) return false;
    const parsed = parseCursor(c);
    if (!parsed || parsed.epoch !== epoch || parsed.seq > sequence) return true;
    const oldest = buffer[0]?.seq ?? sequence + 1;
    return parsed.seq < oldest - 1;
  };
  const sendSse = (client: StreamClient, method: string, params: Record<string, unknown>) => {
    if (client.res.writableEnded || client.res.destroyed) return;
    const meta = {
      ...(typeof params._meta === "object" && params._meta ? (params._meta as Record<string, unknown>) : {}),
      "io.modelcontextprotocol/subscriptionId": client.id,
    };
    client.res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } })}\n\n`);
  };
  const cleanupStream = (client: StreamClient) => {
    if (client.timer) clearInterval(client.timer);
    streams.delete(client);
  };

  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      // StreamableHTTPClientTransport may probe GET for standalone SSE; 405 tells SDK GET SSE is unused.
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk.toString("utf8");
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: -32700, message: "Parse error" } }));
      return;
    }
    requestLog.push({ method: String(body.method ?? ""), headers: req.headers, body });

    if (req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    if (revoked || (options.authToken && req.headers.authorization !== `Bearer ${options.authToken}`)) {
      res.writeHead(revokeStatus, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } },
        }),
      );
      return;
    }

    const reply = (result: unknown, extraHeaders: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    const replyError = (httpStatus: number, code: number, message: string, data?: Record<string, unknown>) => {
      res.writeHead(httpStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code, message, ...(data ? { data } : {}) } }));
    };

    const validateStateless2026Request = (): boolean => {
      const mcpMethod = req.headers["mcp-method"];
      if (mcpMethod !== body.method) {
        replyError(400, -32020, `Mcp-Method header mismatch (expected ${String(body.method)}, got ${String(mcpMethod ?? "missing")})`);
        return false;
      }
      const meta = p && typeof p === "object" && !Array.isArray(p) && p._meta && typeof p._meta === "object" && !Array.isArray(p._meta)
        ? (p._meta as Record<string, unknown>)
        : undefined;
      const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
      if (typeof metaVersion !== "string" || !metaVersion) {
        replyError(400, -32602, "Required request metadata is missing");
        return false;
      }
      const headerVersion = req.headers["mcp-protocol-version"];
      if (typeof headerVersion === "string" && headerVersion !== metaVersion) {
        replyError(400, -32020, `Mcp-Protocol-Version header mismatch (${headerVersion} !== ${metaVersion})`);
        return false;
      }
      const clientCaps = meta?.["io.modelcontextprotocol/clientCapabilities"];
      if (!clientCaps || typeof clientCaps !== "object" || Array.isArray(clientCaps)) {
        replyError(400, -32602, "io.modelcontextprotocol/clientCapabilities request metadata is required");
        return false;
      }
      return true;
    };

    const p = body.params ?? {};
    switch (body.method) {
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "initialize":
        reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: options.serverInfo ?? { name: "fake-t3", version: "1.0.0" },
        });
        return;
      case "tools/list":
        reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? t.name,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        });
        return;
      case "tools/call": {
        const tool = tools.find((t) => t.name === p.name);
        if (!tool) return replyError(200, -32601, `Unknown tool ${String(p.name)}`);
        const out = await tool.run((p.arguments ?? {}) as Record<string, unknown>);
        const norm = typeof out === "string" ? { text: out, isError: false } : { text: out.text, isError: out.isError === true };
        reply({ content: [{ type: "text", text: norm.text }], isError: norm.isError });
        return;
      }
      case "server/discover": {
        if (discoverError) {
          replyError(discoverError.httpStatus ?? 400, discoverError.code, discoverError.message, discoverError.data);
          return;
        }
        if (!validateStateless2026Request()) return;
        const supportedVersions = options.supportedVersions ?? (options.protocolVersion ? [options.protocolVersion] : ["2026-07-28", "2025-11-25"]);
        const capabilities: Record<string, unknown> = { tools: {} };
        if (!options.omitEventsCapability) {
          if (options.legacyCapabilityOnly) {
            capabilities.events = {};
          } else {
            capabilities.extensions = { "io.modelcontextprotocol/events": { listChanged: false } };
          }
        }
        const info = options.serverInfo ?? { name: "fake-t3", version: "1.0.0" };
        reply(
          {
            resultType: "complete",
            supportedVersions,
            ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
            capabilities,
            _meta: { "io.modelcontextprotocol/serverInfo": info },
          },
          { "mcp-protocol-version": supportedVersions[0] ?? "2026-07-28" },
        );
        return;
      }
      case "events/list": {
        if (!validateStateless2026Request()) return;
        if (options.omitEventsCapability) return replyError(404, -32601, "Method not found");
        const start = Number(p.cursor ?? 0);
        const size = options.pageSize ?? events.length;
        const page = events.slice(start, start + size);
        reply({
          resultType: "complete",
          events: page,
          ...(start + size < events.length ? { nextCursor: String(start + size) } : {}),
        });
        return;
      }
      case "events/stream": {
        if (!validateStateless2026Request()) return;
        const descriptor = events.find((e) => e.name === p.name) as { delivery?: string[] } | undefined;
        if (!descriptor) return replyError(200, -32023, "Unknown event", { kind: "event" });
        if (!descriptor.delivery?.includes("push")) {
          return replyError(200, -32026, "Push not supported", { feature: "deliveryMode", value: "push" });
        }
        if (typeof req.headers["mcp-name"] !== "string" || decodeMcpRoutingHeader(req.headers["mcp-name"]) !== String(p.name)) {
          return replyError(400, -32020, "Missing or mismatched Mcp-Name header");
        }
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        if (requiredHeaderParam && requiredHeaderParam.arg in args) {
          const got = req.headers[`mcp-param-${requiredHeaderParam.header.toLowerCase()}`];
          const expected = typeof args[requiredHeaderParam.arg] === "string"
            ? String(args[requiredHeaderParam.arg])
            : JSON.stringify(args[requiredHeaderParam.arg]);
          if (typeof got !== "string" || decodeMcpRoutingHeader(got) !== expected) {
            return replyError(400, -32020, "Mcp-Param header mismatch");
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const client: StreamClient = { id: body.id ?? 1, res, name: String(p.name), args };
        streams.add(client);
        req.on("close", () => cleanupStream(client));
        res.on("close", () => cleanupStream(client));

        const truncated = isTruncated(p.cursor);
        const parsed = parseCursor(p.cursor);
        const replay =
          p.cursor === null || p.cursor === undefined
            ? []
            : buffer.filter((item) => item.name === client.name && matchesArgs(client.args, item.data) && (truncated || (parsed !== undefined && item.seq > parsed.seq)));
        const initialCursor = replay.length > 0 ? cursorStr(replay[0]!.seq - 1) : cursorStr();
        sendSse(client, "notifications/events/active", { cursor: initialCursor, truncated, heartbeatMs });
        for (const item of replay) {
          sendSse(client, "notifications/events/event", {
            eventId: item.eventId,
            name: item.name,
            timestamp: item.timestamp,
            data: item.data,
            cursor: item.cursor,
          });
        }
        if (options.autoHeartbeat) {
          client.timer = setInterval(() => {
            sendSse(client, "notifications/events/heartbeat", { cursor: cursorStr() });
          }, heartbeatMs);
          client.timer.unref?.();
        }
        return;
      }
      case "events/poll": {
        if (!validateStateless2026Request()) return;
        const descriptor = events.find((e) => e.name === p.name) as { delivery?: string[] } | undefined;
        if (!descriptor) return replyError(200, -32023, "Unknown event", { kind: "event" });
        if (!descriptor.delivery?.includes("poll")) {
          return replyError(200, -32026, "Poll not supported", { feature: "deliveryMode", value: "poll" });
        }
        if (typeof req.headers["mcp-name"] !== "string" || decodeMcpRoutingHeader(req.headers["mcp-name"]) !== String(p.name)) {
          return replyError(400, -32020, "Missing or mismatched Mcp-Name header");
        }
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        if (requiredHeaderParam && requiredHeaderParam.arg in args) {
          const got = req.headers[`mcp-param-${requiredHeaderParam.header.toLowerCase()}`];
          const expected = typeof args[requiredHeaderParam.arg] === "string"
            ? String(args[requiredHeaderParam.arg])
            : JSON.stringify(args[requiredHeaderParam.arg]);
          if (typeof got !== "string" || decodeMcpRoutingHeader(got) !== expected) {
            return replyError(400, -32020, "Mcp-Param header mismatch");
          }
        }
        if (p.cursor === null || p.cursor === undefined) {
          reply({ resultType: "complete", events: [], cursor: cursorStr(), truncated: false, hasMore: false, nextPollMs: options.nextPollMs ?? 50 });
          return;
        }
        const truncated = isTruncated(p.cursor);
        const parsed = parseCursor(p.cursor);
        const matching = buffer.filter(
          (item) => item.name === p.name && matchesArgs(args, item.data) && (truncated || (parsed !== undefined && item.seq > parsed.seq)),
        );
        const maxEvents = typeof p.maxEvents === "number" && p.maxEvents > 0 ? p.maxEvents : matching.length;
        const selected = matching.slice(0, maxEvents);
        const hasMore = selected.length < matching.length;
        const nextCursor = hasMore ? selected.at(-1)!.cursor : cursorStr();
        reply({
          resultType: "complete",
          events: selected.map(({ eventId, name, timestamp, data }) => ({ eventId, name, timestamp, data })),
          cursor: nextCursor,
          truncated,
          hasMore,
          nextPollMs: options.nextPollMs ?? 50,
        });
        return;
      }
      default:
        replyError(404, -32601, `Method not found: ${String(body.method)}`);
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind fake events server");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requestLog,
    streamCount: () => streams.size,
    setEvents(next: Record<string, unknown>[]) {
      events = [...next];
    },
    setRequiredHeaderParam(param: { arg: string; header: string } | undefined) {
      requiredHeaderParam = param;
    },
    setDiscoverError(err: FakeEventsMcpServerOptions["discoverError"]) {
      discoverError = err;
    },
    emit(name: string, data: Record<string, unknown>, opts: { eventId?: string; timestamp?: string; duplicateOf?: BufferedEvent } = {}): BufferedEvent {
      const seq = ++sequence;
      const item: BufferedEvent = {
        eventId: opts.eventId ?? opts.duplicateOf?.eventId ?? `evt_${epoch}_${seq}`,
        name,
        timestamp: opts.timestamp ?? new Date().toISOString(),
        data,
        cursor: cursorStr(seq),
        seq,
      };
      buffer.push(item);
      if (buffer.length > bufferSize) buffer = buffer.slice(-bufferSize);
      for (const client of streams) {
        if (client.name === name && matchesArgs(client.args, data)) {
          sendSse(client, "notifications/events/event", {
            eventId: item.eventId,
            name: item.name,
            timestamp: item.timestamp,
            data: item.data,
            cursor: item.cursor,
          });
        }
      }
      return item;
    },
    emitHeartbeat() {
      for (const client of streams) {
        sendSse(client, "notifications/events/heartbeat", { cursor: cursorStr() });
      }
    },
    emitGap() {
      const c = cursorStr();
      for (const client of streams) {
        sendSse(client, "notifications/events/active", { cursor: c, truncated: true, heartbeatMs });
      }
    },
    emitTransientError(message = "Upstream temporary failure") {
      for (const client of streams) {
        sendSse(client, "notifications/events/error", { error: { code: -32603, message } });
      }
    },
    terminateStreams(error: { code: number; message: string; data?: Record<string, unknown> }) {
      for (const client of [...streams]) {
        sendSse(client, "notifications/events/terminated", { error });
        client.res.end();
        cleanupStream(client);
      }
    },
    revoke(status: 401 | 403 = 401) {
      revoked = true;
      revokeStatus = status;
      for (const client of [...streams]) {
        sendSse(client, "notifications/events/terminated", {
          error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } },
        });
        client.res.end();
        cleanupStream(client);
      }
    },
    unrevoke() {
      revoked = false;
    },
    dropStreams() {
      for (const client of [...streams]) {
        client.res.destroy();
        cleanupStream(client);
      }
    },
    restart() {
      epoch++;
      sequence = 0;
      buffer = [];
      for (const client of [...streams]) {
        client.res.destroy();
        cleanupStream(client);
      }
    },
    async close() {
      for (const client of [...streams]) {
        client.res.destroy();
        cleanupStream(client);
      }
      server.close();
      await once(server, "close");
    },
  };
}
