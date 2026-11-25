/**
 * Test fixture: a stdio MCP server with `echo`, `pid` and `fail` tools. Run as `node echo-mcp-server.ts`.
 * Uses the SDK's low-level `Server` (plain JSON Schema), so the fixture needs no zod import.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    { name: "pid", description: "Process id of this server", inputSchema: { type: "object", properties: {} } },
    { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
    { name: "big", description: "A large result", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as { text?: string };
  switch (req.params.name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] };
    case "pid":
      return { content: [{ type: "text", text: String(process.pid) }] };
    case "fail":
      return { content: [{ type: "text", text: "it failed" }], isError: true };
    case "big":
      return { content: [{ type: "text", text: "x".repeat(40_000) }, { type: "text", text: "tail" }] };
    default:
      return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
