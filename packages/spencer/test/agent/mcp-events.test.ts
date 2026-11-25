import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventsMcpServer } from "./fixtures/events-mcp-server.ts";
import {
  MCP_EVENTS_PROTOCOL_VERSION,
  discoverMcpEvents,
  encodeMcpRoutingHeader,
  openMcpEventSubscription,
  validateEventArguments,
  type McpEventGap,
  type McpEventOccurrence,
  type McpEventTerminated,
} from "../../src/agent/mcp-events.ts";
import { waitFor } from "./helpers.ts";

test("discoverMcpEvents: paginates events/list, parses x-mcp-header, skips invalid annotations, and supports legacy fallback", async () => {
  const server = await createEventsMcpServer({
    pageSize: 1,
    events: [
      {
        name: "incident.created",
        description: "Incident",
        delivery: ["push"],
        inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
      },
      {
        name: "bad.header",
        delivery: ["push"],
        inputSchema: { type: "object", properties: { x: { type: "string", "x-mcp-header": "bad header!" } } },
      },
      {
        name: "dup.header",
        delivery: ["push"],
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string", "x-mcp-header": "Tenant" },
            b: { type: "string", "x-mcp-header": "tenant" },
          },
        },
      },
      { name: "thread.run_settled", delivery: ["push", "poll"], inputSchema: { type: "object" } },
    ],
  });
  const legacy = await createEventsMcpServer({ legacyCapabilityOnly: true });
  const warnings: string[] = [];
  try {
    const found = await discoverMcpEvents({ url: server.url, headers: { Origin: "https://evil.example" } }, { log: (m) => warnings.push(m) });
    assert.equal(found.supported, true);
    assert.equal(found.protocolVersion, MCP_EVENTS_PROTOCOL_VERSION);
    assert.equal(found.legacyFallback, undefined);
    assert.match(found.serverIdentity ?? "", /fake-t3@1\.0\.0/);
    assert.deepEqual(
      found.events.map((e) => e.name),
      ["incident.created", "thread.run_settled"],
      "events with invalid or duplicate x-mcp-header annotations are excluded",
    );
    assert.deepEqual(found.events[0]!.headerParams, { region: "Region" });
    assert.equal(warnings.length, 2);

    const discoverReq = server.requestLog.find((r) => r.method === "server/discover")!;
    assert.equal(discoverReq.headers["mcp-protocol-version"], MCP_EVENTS_PROTOCOL_VERSION);
    assert.equal(discoverReq.headers["mcp-method"], "server/discover");
    assert.equal(discoverReq.headers["mcp-name"], undefined);
    assert.equal(discoverReq.headers.origin, undefined);

    const legacyFound = await discoverMcpEvents({ url: legacy.url });
    assert.equal(legacyFound.supported, true);
    assert.equal(legacyFound.legacyFallback, true);
    assert.equal(legacyFound.events.length, 3);
  } finally {
    await server.close();
    await legacy.close();
  }
});

test("discoverMcpEvents: rejects stdio, incompatible protocol version, missing capability, and revoked tokens with redacted errors", async () => {
  const stdio = await discoverMcpEvents({ command: "echo" });
  assert.equal(stdio.supported, false);
  assert.match(stdio.error ?? "", /HTTP MCP server/i);

  const oldServer = await createEventsMcpServer({ supportedVersions: ["2025-11-25"] });
  const noCapServer = await createEventsMcpServer({ omitEventsCapability: true });
  const authServer = await createEventsMcpServer({ authToken: "topsecret-token-123" });
  try {
    const oldRes = await discoverMcpEvents({ url: oldServer.url });
    assert.equal(oldRes.supported, false);
    assert.match(oldRes.error ?? "", /2026-07-28/);

    const noCapRes = await discoverMcpEvents({ url: noCapServer.url });
    assert.equal(noCapRes.supported, false);
    assert.match(noCapRes.error ?? "", /io\.modelcontextprotocol\/events/);

    const badAuth = await discoverMcpEvents({
      url: `${authServer.url}?api_key=querysecret999`,
      headers: { Authorization: "Bearer wrong-secret-token-abc" },
    });
    assert.equal(badAuth.supported, false);
    assert.equal(badAuth.revoked, true);
    assert.doesNotMatch(badAuth.error ?? "", /wrong-secret-token-abc|querysecret999/);
  } finally {
    await oldServer.close();
    await noCapServer.close();
    await authServer.close();
  }
});

test("encodeMcpRoutingHeader & validateEventArguments enforce routing and schema contracts", () => {
  assert.equal(encodeMcpRoutingHeader("thread.run_settled"), "thread.run_settled");
  assert.equal(encodeMcpRoutingHeader("hello world"), "b64:aGVsbG8gd29ybGQ=");
  assert.equal(encodeMcpRoutingHeader("b64:literal"), "b64:YjY0OmxpdGVyYWw=");

  const desc = {
    name: "thread.run_settled",
    delivery: ["push" as const],
    headerParams: {},
    inputSchema: {
      type: "object",
      required: ["threadIds"],
      additionalProperties: false,
      properties: { threadIds: { type: "array", items: { type: "string" } } },
    },
  };
  assert.equal(validateEventArguments(desc, { threadIds: ["t1"] }), undefined);
  assert.match(validateEventArguments(desc, {}) ?? "", /threadIds is required/);
  assert.match(validateEventArguments(desc, { threadIds: [123] }) ?? "", /must be string/);
  assert.match(validateEventArguments(desc, { threadIds: ["t1"], extra: true }) ?? "", /not an allowed argument/);
});

test("events/stream: sends routing & param headers, delivers matching events, advances cursor on heartbeats, keeps stream alive on transient errors, and replays persisted cursor across reconnect", async () => {
  const server = await createEventsMcpServer({
    events: [
      {
        name: "incident.created",
        delivery: ["push"],
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", "x-mcp-header": "Region" },
            threadIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    ],
    heartbeatMs: 500,
  });
  try {
    const found = await discoverMcpEvents({ url: server.url });
    assert.equal(found.supported, true);

    let persistedCursor: string | null = null;
    const received: McpEventOccurrence[] = [];
    const heartbeats: (string | null)[] = [];
    const errors: { message: string; transient: boolean }[] = [];
    const gaps: McpEventGap[] = [];
    const terminated: McpEventTerminated[] = [];

    const handle = openMcpEventSubscription({
      config: { url: server.url, headers: { Origin: "https://blocked.example" } },
      event: found.events[0]!,
      arguments: { region: "us-west1", threadIds: ["th-1"] },
      getCursor: () => persistedCursor,
      heartbeatMs: 500,
      backoffMinMs: 20,
      backoffMaxMs: 40,
      onActive: ({ cursor }) => {
        if (persistedCursor === null && cursor !== null) persistedCursor = cursor;
      },
      onEvent: (ev) => {
        received.push(ev);
        if (ev.cursor !== null) persistedCursor = ev.cursor;
      },
      onHeartbeat: ({ cursor }) => {
        heartbeats.push(cursor);
        if (cursor !== null) persistedCursor = cursor;
      },
      onError: (err) => { errors.push(err); },
      onGap: (gap) => { gaps.push(gap); },
      onTerminated: (t) => { terminated.push(t); },
    });

    await waitFor(() => server.streamCount() === 1, "stream connected");
    const firstReq = server.requestLog.find((r) => r.method === "events/stream")!;
    assert.equal(firstReq.headers["mcp-protocol-version"], MCP_EVENTS_PROTOCOL_VERSION);
    assert.equal(firstReq.headers["mcp-method"], "events/stream");
    assert.equal(firstReq.headers["mcp-name"], "incident.created");
    assert.equal(firstReq.headers["mcp-param-region"], "us-west1");
    assert.equal(firstReq.headers.origin, undefined);

    // Unrelated event does not match filter; matching event does.
    server.emit("incident.created", { region: "us-west1", threadId: "th-other" });
    server.emit("incident.created", { region: "us-west1", threadId: "th-1", step: 1 });
    await waitFor(() => received.length === 1, "first event received");
    assert.equal(received[0]!.data.step, 1);

    // Heartbeat updates cursor without calling onEvent.
    server.emitHeartbeat();
    await waitFor(() => heartbeats.length === 1, "heartbeat received");
    assert.equal(received.length, 1);

    // Transient per-occurrence error does NOT close the stream.
    server.emitTransientError("upstream 503");
    await waitFor(() => errors.some((e) => e.message.includes("upstream 503")), "transient error observed");
    assert.equal(terminated.length, 0);

    // Drop stream, emit event while disconnected, verify reconnect sends persistedCursor and replays missed event.
    const savedCursor = persistedCursor;
    server.dropStreams();
    server.emit("incident.created", { region: "us-west1", threadId: "th-1", step: 2 });
    await waitFor(() => received.length === 2, "replayed event received after reconnect");
    assert.equal(received[1]!.data.step, 2);
    const streamReqs = server.requestLog.filter((r) => r.method === "events/stream");
    assert.ok(streamReqs.length >= 2);
    assert.equal(streamReqs[1]!.body.params.cursor, savedCursor);
    assert.equal(gaps.length, 0);

    await handle.stop();
  } finally {
    await server.close();
  }
});

test("events/stream: detects mid-stream gap, restart truncation gap, missed-heartbeat liveness timeout, and stops immediately on revocation", async () => {
  const server = await createEventsMcpServer({ heartbeatMs: 40 });
  try {
    const found = await discoverMcpEvents({ url: server.url });
    let persistedCursor: string | null = null;
    const gaps: McpEventGap[] = [];
    const terminated: McpEventTerminated[] = [];

    const handle = openMcpEventSubscription({
      config: { url: server.url },
      event: found.events[0]!,
      getCursor: () => persistedCursor,
      heartbeatMs: 40,
      livenessMultiplier: 2,
      backoffMinMs: 15,
      backoffMaxMs: 30,
      onActive: ({ cursor }) => {
        if (cursor !== null) persistedCursor = cursor;
      },
      onEvent: (ev) => {
        if (ev.cursor !== null) persistedCursor = ev.cursor;
      },
      onGap: (gap) => {
        gaps.push(gap);
        if (gap.cursor !== null) persistedCursor = gap.cursor;
      },
      onTerminated: (t) => { terminated.push(t); },
    });

    await waitFor(() => server.streamCount() === 1, "initial stream");
    // Mid-stream gap notification.
    server.emitGap();
    await waitFor(() => gaps.length === 1, "mid-stream gap received");

    // Server restart resets epoch -> reconnect sends old cursor -> initial active has truncated: true.
    server.restart();
    await waitFor(() => gaps.length >= 2, "restart truncation gap received");

    // Missed heartbeats (server autoHeartbeat is false) cause watchdog abort + reconnect.
    const countBeforeTimeout = server.requestLog.filter((r) => r.method === "events/stream").length;
    await waitFor(() => server.requestLog.filter((r) => r.method === "events/stream").length > countBeforeTimeout, "liveness watchdog reconnect");

    // Mid-stream revocation sends notifications/events/terminated (-32024) and stops WITHOUT retrying.
    server.revoke(401);
    await waitFor(() => terminated.length === 1, "revocation termination received");
    assert.equal(terminated[0]!.revoked, true);
    assert.equal(terminated[0]!.code, -32024);

    const requestsAfterRevoke = server.requestLog.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(server.requestLog.length, requestsAfterRevoke, "revocation must not trigger retries");
    await handle.stop();
  } finally {
    await server.close();
  }
});

test("events/stream: handles HTTP 400 HeaderMismatch (-32020) by refreshing descriptor once via onHeaderMismatch", async () => {
  const server = await createEventsMcpServer({
    events: [
      { name: "job.done", delivery: ["push"], inputSchema: { type: "object", properties: { tenant: { type: "string" } } } },
    ],
    requiredHeaderParam: { arg: "tenant", header: "Tenant" },
  });
  try {
    const stale = (await discoverMcpEvents({ url: server.url })).events[0]!;
    // Server now requires Mcp-Param-Tenant header and advertises x-mcp-header in updated events/list.
    server.setEvents([
      {
        name: "job.done",
        delivery: ["push"],
        inputSchema: { type: "object", properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } },
      },
    ]);
    let refreshed = 0;
    const received: McpEventOccurrence[] = [];
    const handle = openMcpEventSubscription({
      config: { url: server.url },
      event: stale,
      arguments: { tenant: "acme" },
      onHeaderMismatch: async () => {
        refreshed++;
        return (await discoverMcpEvents({ url: server.url })).events[0];
      },
      onEvent: (ev) => { received.push(ev); },
      onGap: () => {},
      onTerminated: () => {},
    });
    await waitFor(() => server.streamCount() === 1, "stream connected after header refresh");
    assert.equal(refreshed, 1);
    server.emit("job.done", { tenant: "acme", ok: true });
    await waitFor(() => received.length === 1, "event delivered after refresh");
    await handle.stop();
  } finally {
    await server.close();
  }
});

test("events/poll fallback: drains hasMore pages, reports gaps on truncation, and stops on revocation", async () => {
  const server = await createEventsMcpServer({
    events: [{ name: "poll.only", delivery: ["poll"], inputSchema: { type: "object" } }],
    nextPollMs: 25,
  });
  try {
    const found = await discoverMcpEvents({ url: server.url });
    let persistedCursor: string | null = null;
    const received: McpEventOccurrence[] = [];
    const gaps: McpEventGap[] = [];
    const terminated: McpEventTerminated[] = [];

    const handle = openMcpEventSubscription({
      config: { url: server.url },
      event: found.events[0]!,
      maxEvents: 1,
      pollFloorMs: 20,
      getCursor: () => persistedCursor,
      onHeartbeat: ({ cursor }) => {
        if (cursor !== null) persistedCursor = cursor;
      },
      onEvent: (ev) => {
        received.push(ev);
        if (ev.cursor !== null) persistedCursor = ev.cursor;
      },
      onGap: (g) => {
        gaps.push(g);
        if (g.cursor !== null) persistedCursor = g.cursor;
      },
      onTerminated: (t) => { terminated.push(t); },
    });

    // Wait for initial cursor bootstrap poll (cursor: null returns [] + fresh cursor).
    await waitFor(() => persistedCursor !== null, "poll bootstrap cursor");
    assert.equal(received.length, 0);

    // Emit two events; maxEvents=1 forces hasMore=true drain.
    server.emit("poll.only", { n: 1 });
    server.emit("poll.only", { n: 2 });
    await waitFor(() => received.length === 2, "both polled events received");
    assert.deepEqual(
      received.map((e) => e.data.n),
      [1, 2],
    );

    // Server restart invalidates cursor -> truncated: true -> onGap called.
    server.restart();
    await waitFor(() => gaps.length >= 1, "poll truncation gap detected");

    // Revocation stops poll loop permanently.
    server.revoke(403);
    await waitFor(() => terminated.length === 1, "poll revocation detected");
    assert.equal(terminated[0]!.revoked, true);
    const reqs = server.requestLog.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(server.requestLog.length, reqs, "poll loop must not retry after revocation");
    await handle.stop();
  } finally {
    await server.close();
  }
});

test("parseJsonRpcResult handles Streamable HTTP text/event-stream responses on discover/list/poll and marks 503 as transient", async () => {
  const sseFetch: typeof fetch = async (_input, init) => {
    const req = JSON.parse(String(init?.body ?? "{}"));
    if (req.method === "server/discover") {
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    }
    if (req.method === "events/list") {
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { events: [{ name: "job.done", delivery: ["poll"], inputSchema: { type: "object" } }] } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { truncated: true, cursor: "2.2", hasMore: false, nextPollMs: 50, events: [{ eventId: "e1", name: "job.done", timestamp: new Date().toISOString(), data: { n: 1 } }, { eventId: "e2", name: "job.done", timestamp: new Date().toISOString(), data: { n: 2 } }] } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const found = await discoverMcpEvents({ url: "http://127.0.0.1:9/mcp" }, { fetch: sseFetch });
  assert.equal(found.supported, true);
  assert.deepEqual(found.events.map((e) => e.name), ["job.done"]);

  const gapCursors: (string | null)[] = [];
  const eventCursors: (string | null)[] = [];
  const handle = openMcpEventSubscription({
    config: { url: "http://127.0.0.1:9/mcp" },
    event: found.events[0]!,
    fetch: sseFetch,
    pollFloorMs: 20,
    onGap: (g) => { gapCursors.push(g.cursor); },
    onEvent: (ev) => { eventCursors.push(ev.cursor); },
    onTerminated: () => {},
  });
  await waitFor(() => eventCursors.length >= 2, "SSE poll events delivered");
  assert.equal(gapCursors[0], null, "truncated poll with items must not advance cursor before items are admitted");
  assert.deepEqual(eventCursors.slice(0, 2), [null, "2.2"]);
  await handle.stop();

  const transient = await discoverMcpEvents(
    { url: "http://127.0.0.1:9/mcp" },
    { fetch: async () => new Response("temporarily unavailable", { status: 503 }) },
  );
  assert.equal(transient.supported, false);
  assert.equal(transient.transient, true);
});
