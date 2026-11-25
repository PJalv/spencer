/**
 * `spencer mcp spencer`: a stdio MCP server that lets other agents (e.g. T3 Code threads) talk to this machine's
 * Spencer through its local API: ask it something in the owner chat, list its channels, read them and post in them.
 * The port and API token are read per call (`<dataDir>/daemon.json`, `<dataDir>/api-token`), so restarts are fine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BridgeTool, ToolError, int, serveStdio, str } from "./stdio-server.ts";

const MAX_WAIT_S = 300;
/** Marks messages in the owner chat that came from another agent, for the owner and for Spencer. */
export const VIA = "[from a T3 Code thread]";

interface Conn {
  base: string;
  token: string;
}

export function connection(dataDir: string, env: NodeJS.ProcessEnv = process.env): Conn {
  let port = env.SPENCER_PORT ? Number(env.SPENCER_PORT) : undefined;
  if (!port) {
    try {
      port = (JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")) as { port?: number }).port;
    } catch {
      /* not running */
    }
  }
  if (!port) throw new ToolError(`Spencer is not running (no ${join(dataDir, "daemon.json")}).`);
  let token: string;
  try {
    token = readFileSync(join(dataDir, "api-token"), "utf8").trim();
  } catch {
    throw new ToolError(`cannot read Spencer's API token in ${dataDir}.`);
  }
  return { base: `http://127.0.0.1:${port}`, token };
}

interface Member {
  name?: string;
  me: boolean;
  presence: string;
}
interface Channel {
  id: string;
  kind: string;
  mode?: string;
  name: string;
  members: Member[];
  unread: number;
  autoReply: boolean;
}
interface ChannelMessage {
  id: string;
  fromName?: string;
  from: string;
  mine: boolean;
  ts: number;
  type: string;
  text?: string;
  by?: string;
  note?: string;
}
interface OwnerItem {
  id: string;
  role: string;
  text: string;
  ts: number;
  toolName?: string;
}

const MAX_ANSWER = 8_000;
const capText = (t: string) => (t.length > MAX_ANSWER ? `${t.slice(0, MAX_ANSWER)}\n[…cut; the full answer is in the owner chat]` : t);

export function spencerTools(dataDir: string, fetchImpl: typeof fetch = fetch): BridgeTool[] {
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const c = connection(dataDir);
    let res: Response;
    try {
      res = await fetchImpl(c.base + path, {
        method,
        headers: { "X-Spencer-Token": c.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ToolError(`Spencer is not reachable at ${c.base}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* plain text */
      }
      throw new ToolError(`Spencer API ${method} ${path}: ${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  const WINDOW = 500;
  const owner = async (limit: number) => (await api<{ items: OwnerItem[] }>("GET", `/api/owner/messages?limit=${limit}`)).items;
  const state = () => api<{ me: { name: string }; channels: Channel[]; ownerBusy: boolean }>("GET", "/api/state");

  async function channel(ref: string): Promise<Channel> {
    const { channels } = await state();
    const want = ref.trim().toLowerCase();
    const exact = channels.find((c) => c.id === ref);
    const matches = channels.filter((c) => c.name.toLowerCase() === want);
    if (!exact && matches.length > 1) throw new ToolError(`ambiguous channel "${ref}". Use an explicit channel ID: ${matches.map(c => c.id).join(", ")}`);
    const found = exact ?? matches[0];
    if (!found) throw new ToolError(`no channel "${ref}". Channels: ${channels.map((c) => `${c.name} (${c.id})`).join(", ") || "none"}`);
    return found;
  }

  const fmtOwner = (items: OwnerItem[]) =>
    items
      .filter((i) => i.role === "user" || i.role === "assistant" || i.role === "note")
      .map((i) => `${i.role === "user" ? "Owner" : i.role === "note" ? "Note" : "Spencer"}: ${i.text}`)
      .join("\n\n");

  return [
    {
      name: "spencer_ask",
      description:
        "Send a message to Spencer (the owner's always-on agent, which chats with other people's Spencers) in its owner chat and wait for its answer. The message is marked as coming from an external agent.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          wait_seconds: { type: "number", description: `How long to wait for the answer (0-${MAX_WAIT_S}, default 120).` },
        },
        required: ["message"],
      },
      run: async (a) => {
        const text = `${VIA} ${str(a, "message", true)}`;
        const wait = int(a, "wait_seconds", 120, 0, MAX_WAIT_S);
        const { submissionId } = await api<{ submissionId: string }>("POST", "/api/owner/messages", { text });
        // The answer to this very submission, so concurrent callers never get each other's replies.
        const end = Date.now() + wait * 1000;
        do {
          const left = Math.ceil((end - Date.now()) / 1000);
          const a = await api<{ status: string; text?: string; reason?: string }>(
            "GET",
            `/api/owner/answers/${encodeURIComponent(submissionId)}${left > 0 ? `?wait=${Math.min(left, 25)}` : ""}`,
          );
          if (a.status === "done") return capText(a.text?.trim() || "Spencer finished without a reply.");
          if (a.status === "unanswered") throw new ToolError(`Spencer could not answer: ${a.reason ?? "unknown reason"}`);
        } while (Date.now() < end);
        return `Spencer is still working after ${wait}s; read its answer later with spencer_owner_messages.`;
      },
    },
    {
      name: "spencer_owner_messages",
      description: "Read the latest messages of Spencer's owner chat (the owner's private conversation with Spencer).",
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "1-50, default 10" } } },
      run: async (a) => fmtOwner(await owner(int(a, "limit", 10, 1, 50))) || "The owner chat is empty.",
    },
    {
      name: "spencer_channels",
      description: "List Spencer's channels (chats with other people's Spencers): id, name, kind, members and who is online.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const s = await state();
        if (!s.channels.length) return `Spencer "${s.me.name}" has no channels.`;
        return [
          `Spencer "${s.me.name}" channels:`,
          ...s.channels.map((c) => {
            const peers = c.members.filter((m) => !m.me).map((m) => `${m.name ?? "?"} (${m.presence})`);
            const kind = c.mode === "conversation" ? "conversations" : c.kind;
            return `- ${c.name} [${c.id}] ${kind}${c.autoReply ? "" : ", auto-reply off"}${c.unread ? `, ${c.unread} unread` : ""}: ${peers.join(", ") || "no peers"}`;
          }),
        ].join("\n");
      },
    },
    {
      name: "spencer_read_channel",
      description: "Read the latest messages of one of Spencer's channels.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel id or name." },
          limit: { type: "number", description: "1-100, default 20" },
        },
        required: ["channel"],
      },
      run: async (a) => {
        const c = await channel(str(a, "channel", true));
        const { items } = await api<{ items: ChannelMessage[] }>("GET", `/api/channels/${encodeURIComponent(c.id)}/messages?limit=${int(a, "limit", 20, 1, 100)}`);
        const lines = items
          .filter((m) => m.type === "chat" && m.text)
          .map((m) => {
            const who = m.mine ? (m.by === "human" ? "Owner" : "Spencer (me)") : `${m.fromName ?? m.from}${m.by === "human" ? " (person)" : ""}`;
            return `[${new Date(m.ts).toISOString().slice(0, 16).replace("T", " ")}] ${who}: ${m.text}${m.note ? ` (no reply: ${m.note})` : ""}`;
          });
        return lines.length ? `#${c.name}\n${lines.join("\n")}` : `#${c.name} has no messages yet.`;
      },
    },
    {
      name: "spencer_post_channel",
      description: "Post a message in one of Spencer's channels as the owner (a person, not the agent). Other people and their Spencers will see it.",
      inputSchema: {
        type: "object",
        properties: { channel: { type: "string", description: "Channel id or name." }, text: { type: "string" } },
        required: ["channel", "text"],
      },
      run: async (a) => {
        const c = await channel(str(a, "channel", true));
        const { id } = await api<{ id: string }>("POST", `/api/channels/${encodeURIComponent(c.id)}/messages`, { text: str(a, "text", true) });
        return `Posted in #${c.name} (message ${id}).`;
      },
    },
    {
      name: "spencer_publish_update", description: "Publish a work update from any agent or script, optionally notifying the owner without waking the model.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, status: { type: "string", enum: ["active", "blocked", "done"] }, visibility: { type: "string", enum: ["private", "trusted", "public"] }, project: { type: "string" }, links: { type: "array", items: { type: "string" } }, source: { type: "string" }, notifyOwner: { type: "boolean" }, notifyChannel: { type: "string" }, final: { type: "boolean" } }, required: ["title", "summary"] },
      run: async a => JSON.stringify(await api("POST", "/api/work-brief", a)),
    },
    {
      name: "spencer_work_brief", description: "Read the owner's work brief.",
      inputSchema: { type: "object", properties: { status: { type: "string" }, project: { type: "string" } } },
      run: async a => { const q = new URLSearchParams(); for (const k of ["status", "project"]) { const v = str(a, k); if (v) q.set(k, v); } return JSON.stringify(await api("GET", `/api/work-brief?${q}`)); },
    },
    {
      name: "spencer_read_peer", description: "Read a peer or group profile, including BIO, rules and memoir notes.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["peer", "channel"] } }, required: ["id"] },
      run: async a => { const kind = str(a, "kind") ?? "peer"; if (kind !== "peer" && kind !== "channel") throw new ToolError("invalid kind"); return JSON.stringify(await api("GET", `/api/${kind === "peer" ? "peers" : "channels"}/${encodeURIComponent(str(a, "id", true))}/memoir`)); },
    },
    {
      name: "spencer_add_memoir_note", description: "Add an owner-scoped note to a peer or group memoir.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["peer", "channel"] }, text: { type: "string" }, pinned: { type: "boolean" } }, required: ["id", "text"] },
      run: async a => { const kind = str(a, "kind") ?? "peer"; if (kind !== "peer" && kind !== "channel") throw new ToolError("invalid kind"); return JSON.stringify(await api("POST", `/api/${kind === "peer" ? "peers" : "channels"}/${encodeURIComponent(str(a, "id", true))}/notes`, { text: str(a, "text", true), ...(a.pinned === undefined ? {} : { pinned: a.pinned }) })); },
    },
    {
      name: "spencer_send_file", description: "Send a local artifact to a channel.",
      inputSchema: { type: "object", properties: { channel: { type: "string" }, path: { type: "string" }, to: { type: "string" } }, required: ["channel", "path"] },
      run: async a => { const c = await channel(str(a, "channel", true)); return JSON.stringify(await api("POST", "/api/transfers", { ch: c.id, path: str(a, "path", true), to: str(a, "to") })); },
    },
    {
      name: "spencer_list_transfers", description: "List incoming and outgoing file transfers.",
      inputSchema: { type: "object", properties: { channel: { type: "string" } } },
      run: async a => { const ref = str(a, "channel"); const c = ref ? await channel(ref) : undefined; return JSON.stringify(await api("GET", `/api/transfers${c ? `?ch=${encodeURIComponent(c.id)}` : ""}`)); },
    },
  ];
}

export async function runSpencerBridge(dataDir: string): Promise<void> {
  const tools = spencerTools(dataDir);
  await serveStdio(
    "spencer",
    "Spencer connects coding agents, CLI tools and scripts with the owner's agent, work brief, channels, memoirs and transfers.",
    () => tools,
  );
}
