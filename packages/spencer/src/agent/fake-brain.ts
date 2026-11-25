/**
 * A deterministic fake LLM for tests and offline demos: a pi-ai faux response factory that looks at the
 * request context (tools offered, last message) and answers by fixed rules.
 *
 * Channel conversations (recognized by the `notify_owner` tool being offered):
 *   - `Echo from <myName>: <last peer message text>`
 *   - text containing `NO_REPLY_TEST` → `NO_REPLY`
 *   - text containing `FINAL_TEST` → `Bye from <myName>` plus the `[END]` marker (a closing message)
 *   - text containing `SLOW_REPLY_TEST` → the answer comes after `SLOW_REPLY_MS` (for crash tests that run the
 *     daemon as a child process, where `hooks.gate` is out of reach)
 *   - `please send file <path>` → tool call `propose_file_send`, then `Asked my owner to approve sending <path>`
 *   - `please ask owner: <text>` → tool call `ask_owner`, then `Waiting for my owner's approval`
 *   - `please call <tool> <json args>` → that tool call (e.g. an MCP tool), then `done: <first 200 chars of the result>`
 *   - `please follow up in <n> minutes: <note>` → tool call `schedule_followup`, then `I'll get back to you`
 *   - a follow-up firing (`<followup_note>`) → `Follow-up from <myName>: <note>`; a note containing `again` schedules
 *     the next follow-up instead; a note containing `quiet` answers NO_REPLY
 * Owner conversation:
 *   /send <channel> <text>   /file <channel> <path> [to]   /peers   /transfers   /read <channel>
 *   /invite direct|group <name>   /tool <toolName> <json args>   /followup <minutes> <note>
 *   /followup-on <channel> <minutes> <note> (on_reply_from)   /ask <channel> <text> (send_message with await_reply)
 *   a follow-up firing → the note is handled like an owner command (so `/followup 5 /send Bob hi` sends later)
 *   anything else → `ok: <text>`
 *   after a tool result → `done: <first 200 chars of the result>`
 * Channel names with spaces can be quoted: /send "Bob chat" hi
 */
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";

export interface FakeRequestInfo {
  /** "owner" or "channel". */
  conversation: "owner" | "channel";
  /** Tool names offered to the model in this request. */
  tools: string[];
  /** Provider-facing schemas, for adapter regression checks. */
  toolSchemas: { name: string; parameters: object }[];
  systemPrompt: string;
  /** The text the brain is answering (peer text, owner command, or tool result). */
  text: string;
}

export interface FakeBrainHooks {
  /** Called for every request, before answering. */
  onRequest?(info: FakeRequestInfo): void;
  /**
   * Awaited before answering, e.g. to hold a run open in a crash test. It receives the request's abort signal;
   * a gate that never resolves must reject when it aborts, or closing the harness waits for it.
   */
  gate?(info: FakeRequestInfo, signal: AbortSignal | undefined): Promise<void>;
}

const NOTE_PREFIX = /^\[(note|you sent|reply from|owner note|you\/owner sent)/i;

export function createFakeBrain(opts: { name: () => string; hooks?: FakeBrainHooks }): FauxResponseFactory {
  return async (context, options) => {
    const messages = context.messages as readonly Message[];
    const tools = getCurrentTools(messages).map((t) => t.name);
    const systemPrompt = getCurrentSystemPrompt(messages);
    const channel = tools.includes("notify_owner");
    const target = lastRelevant(messages, channel);
    const info: FakeRequestInfo = {
      conversation: channel ? "channel" : "owner",
      tools,
      toolSchemas: getCurrentTools(messages).map(t => ({ name: t.name, parameters: t.parameters })),
      systemPrompt,
      text: target ? describe(target) : "",
    };
    opts.hooks?.onRequest?.(info);
    if (opts.hooks?.gate) await opts.hooks.gate(info, options?.signal);
    if (!target) return text("NO_REPLY");
    // The heated-mode moderator (agent.ts MODERATOR_INSTRUCTIONS): no tools, answers OK or STOP.
    if (systemPrompt.includes("You moderate a heated group chat")) {
      return text(describe(target).includes("MOD_STOP_TEST") ? "STOP: ok guys thats enough, im ending this one" : "OK");
    }
    if (channel && target.role === "user" && peerText(contentText(target.content)).includes("SLOW_REPLY_TEST")) {
      await abortableDelay(SLOW_REPLY_MS, options?.signal);
    }
    if (target.role === "toolResult") return afterTool(target, messages, channel);
    const userText = contentText(target.content);
    return channel ? channelAnswer(userText, opts.name()) : ownerAnswer(userText);
  };
}

export const SLOW_REPLY_MS = 3000;

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function text(s: string): AssistantMessage {
  return fauxAssistantMessage(fauxText(s));
}

function call(name: string, args: Record<string, any>): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

/** The newest tool result, peer message (channel) or owner input (owner), skipping our own notes. */
function lastRelevant(messages: readonly Message[], channel: boolean): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult") return m;
    if (m.role === "assistant") return undefined;
    if (m.role !== "user") continue;
    const t = contentText(m.content);
    if (channel ? t.includes("<peer_message") || t.includes("<followup_note") || t.includes(CONVERSATION_TIMER) : !NOTE_PREFIX.test(t.trim())) return m;
  }
  return undefined;
}

function describe(m: Message): string {
  if (m.role === "toolResult") return contentText(m.content);
  if (m.role === "user") return contentText(m.content);
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === "text" ? String(b.text) : "")).join("");
  return "";
}

/** Text inside the last <peer_message …>…</peer_message> block. */
export function peerText(s: string): string {
  const open = s.lastIndexOf("<peer_message");
  if (open === -1) return s.trim();
  const start = s.indexOf(">", open);
  const end = s.indexOf("</peer_message>", start);
  return s.slice(start + 1, end === -1 ? undefined : end).trim();
}

/** Text inside the last <followup_note>…</followup_note>, if `s` is a follow-up firing. */
function followupNote(s: string): string | undefined {
  const open = s.lastIndexOf("<followup_note>");
  if (open === -1) return undefined;
  const end = s.indexOf("</followup_note>", open);
  return s.slice(open + "<followup_note>".length, end === -1 ? undefined : end).trim();
}

/** The start of the input a Conversations timer submits (agent.ts openerInput). */
const CONVERSATION_TIMER = "[Your conversation timer went off";

function channelAnswer(raw: string, myName: string): AssistantMessage {
  if (raw.startsWith(CONVERSATION_TIMER)) return call("search_news", {});
  const fu = followupNote(raw);
  if (fu !== undefined) {
    if (/\bquiet\b/i.test(fu)) return text("NO_REPLY");
    if (/\bagain\b/i.test(fu)) return call("schedule_followup", { in_minutes: 1, note: fu });
    return text(`Follow-up from ${myName}: ${fu}`);
  }
  const t = peerText(raw);
  if (t.includes("NO_REPLY_TEST")) return text("NO_REPLY");
  if (t.includes("FINAL_TEST")) return text(`Bye from ${myName}\n[END]`);
  const file = /please send file (\S+)/i.exec(t);
  if (file) return call("propose_file_send", { path: file[1], reason: "The peer asked for it." });
  const ask = /please ask owner: ([\s\S]+)/i.exec(t);
  if (ask) return call("ask_owner", { request: ask[1]!.trim() });
  const fol = /please follow up in (\d+(?:\.\d+)?) minutes?: ([\s\S]+)/i.exec(t);
  if (fol) return call("schedule_followup", { in_minutes: Number(fol[1]), note: fol[2]!.trim() });
  const tool = /please call (\S+)\s*(\{[\s\S]*\})?/i.exec(t);
  if (tool) {
    let args: Record<string, unknown> = {};
    try {
      args = tool[2] ? JSON.parse(tool[2]) : {};
    } catch {
      /* bad JSON: no args */
    }
    return call(tool[1]!, args);
  }
  return text(`Echo from ${myName}: ${t}`);
}

function afterTool(result: Message & { role: "toolResult" }, messages: readonly Message[], channel: boolean): AssistantMessage {
  const out = contentText(result.content);
  if (channel && result.toolName === "propose_file_send") {
    const args = findCallArgs(messages, result.toolCallId);
    return text(`Asked my owner to approve sending ${String(args?.path ?? "the file")}`);
  }
  if (channel && result.toolName === "ask_owner") return text("Waiting for my owner's approval\n[END]");
  if (channel && result.toolName === "schedule_followup") {
    return text(result.isError ? `could not schedule: ${out.slice(0, 200)}` : "I'll get back to you");
  }
  if (channel && result.toolName.startsWith("mcp__")) return text(`done: ${out.slice(0, 200)}`);
  if (channel && result.toolName === "search_news") {
    const first = /^1\. (.+)$/m.exec(out);
    return text(first ? `Hot take: ${first[1]}` : "NO_REPLY");
  }
  if (channel) return text("NO_REPLY");
  return text(`done: ${out.slice(0, 200)}`);
}

function findCallArgs(messages: readonly Message[], callId: string): Record<string, unknown> | undefined {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "toolCall" && b.id === callId) return b.arguments as Record<string, unknown>;
  }
  return undefined;
}

/** Split into tokens, honoring "double quotes". */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2]!);
  return out;
}

/** First token (quoted or not) and the raw rest of the line. */
function head(s: string): [string, string] {
  const t = s.trimStart();
  const m = /^"([^"]*)"\s*|^(\S+)\s*/.exec(t);
  if (!m) return ["", ""];
  return [m[1] ?? m[2]!, t.slice(m[0].length)];
}

function ownerAnswer(input: string): AssistantMessage {
  const fu = followupNote(input);
  if (fu !== undefined) return ownerAnswer(fu);
  if (input.startsWith("I approve this request from ")) {
    const command = input.split("\n\n")[1];
    if (command) return ownerAnswer(command);
  }
  const t = input.trim();
  const [cmd, rest] = head(t);
  switch (cmd) {
    case "/send": {
      const [channel, msg] = head(rest);
      if (channel && msg) return call("send_message", { channel, text: msg });
      break;
    }
    case "/file": {
      const [channel, path, to] = tokenize(rest);
      if (channel && path) return call("send_file", to ? { channel, path, to } : { channel, path });
      break;
    }
    case "/peers":
      return call("list_peers", {});
    case "/transfers":
      return call("list_transfers", {});
    case "/read": {
      const [channel] = tokenize(rest);
      if (channel) return call("read_channel", { channel });
      break;
    }
    case "/invite": {
      const [kind, name] = head(rest);
      if ((kind === "direct" || kind === "group") && name) return call("create_invite", { kind, name: name.trim() });
      break;
    }
    case "/followup-on": {
      const [channel, r1] = head(rest);
      const [minutes, note] = head(r1);
      if (channel && minutes && note) return call("schedule_followup", { in_minutes: Number(minutes), note: note.trim(), on_reply_from: channel });
      break;
    }
    case "/ask": {
      const [channel, msg] = head(rest);
      if (channel && msg) return call("send_message", { channel, text: msg, await_reply: true });
      break;
    }
    case "/followup": {
      const [minutes, note] = head(rest);
      if (minutes && note) return call("schedule_followup", { in_minutes: Number(minutes), note: note.trim() });
      break;
    }
    case "/tool": {
      const [name, json] = head(rest);
      if (name) {
        let args: Record<string, any> = {};
        try {
          args = json.trim() ? JSON.parse(json) : {};
        } catch {
          return text(`bad JSON for /tool: ${json}`);
        }
        return call(name, args);
      }
      break;
    }
  }
  return text(`ok: ${t}`);
}
