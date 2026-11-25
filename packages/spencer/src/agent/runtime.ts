/**
 * The thin adapter over `@earendil-works/pi-durable` 1.5.2 (and chord). This is the only file that imports
 * them, so API churn stays here. Everything else talks to `AgentRuntime`.
 *
 * Mapping:
 *  - storage: `openNodeSqliteStorage(<dataDir>/pi.sqlite)`, one writer (the core holds the data-dir lock).
 *  - "owner" → the root conversation; "ch:<id>" → one ownerless conversation per channel. The key → id map
 *    lives in `agent_conversations` in core.db.
 *  - tools: every `ToolSpec` becomes a pi-durable tool in one extension ("spencer"), reinstalled in place when
 *    the set changes. Each conversation enables exactly its own tools by name (`configure({ tools })`) and
 *    selects exactly its extensions (channel conversations never select the coding tools). A tool resolves
 *    the conversation key from `api.conversationId` and refuses to run outside the conversations it was
 *    configured for (defense in depth on top of pi-durable's own filtering).
 */
import type { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Registry,
  type SubmissionId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { OwnerAttachment, OwnerItem, OwnerQueuedItem, OwnerRunState } from "../contracts.ts";

// ------------------------------------------------------------------ public surface

export interface ToolContext {
  /** "owner" or "ch:<id>": the conversation the call runs in. */
  conversationKey: string;
  /** Unique id of this call (stable across a restart of the same call). */
  callId: string;
  signal?: AbortSignal;
}

export type ToolOutput = string | { text: string; isError?: boolean };

/**
 * A tool. Tools are global by name: two specs with the same name are the same tool, so `execute` must derive
 * per-conversation state from `ctx.conversationKey`, never from a closure over one conversation.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: object;
  execute(args: any, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ConversationSetup {
  tools: ToolSpec[];
  instructions: string;
  /** Owner only: also enable pi-durable's read/write/edit/bash, running in `cwd` (default: home dir). */
  codingTools?: { cwd?: string };
  /** Reasoning effort ("off", "minimal", "low", "medium", "high"); absent: "off". */
  thinkingLevel?: string;
  /** Run this conversation on another model than the agent's main one (Conversations channels). */
  model?: { provider: string; modelId: string };
}

export interface NoteInput {
  kind: string;
  data: unknown;
  /** Text the model sees (as a user message). Absent: display only. */
  modelText?: string;
  /** Dedupe key, scoped to the conversation. */
  requestId?: string;
}

export interface InputSubmission {
  content: string;
  requestId: string;
  whenBusy?: "steer" | "followUp" | "reject";
  whenIdle?: "reject";
  display?: { kind: string; data: unknown };
}

export type Answer = { status: "done"; text: string } | { status: "unanswered"; reason: string };

export interface WatchHandlers {
  /** New committed transcript items, oldest first. */
  onItems?(items: OwnerItem[]): void;
  onBusy?(busy: boolean): void;
  onState?(state: OwnerRunState): void;
}

export interface AgentRuntime {
  open(): Promise<void>;
  close(): Promise<void>;
  ensureConversation(key: string): Promise<string>;
  configure(key: string, setup: ConversationSetup): Promise<void>;
  submitInput(key: string, input: InputSubmission): Promise<string>;
  appendNote(key: string, note: NoteInput): Promise<void>;
  /** Rejects with the signal's reason once `signal` aborts; the wait is released then. */
  waitAnswer(submissionId: string, signal?: AbortSignal): Promise<Answer>;
  /** Abort active run(s) and withdraw queued inputs in this conversation. */
  abort(key: string): Promise<void>;
  /** Resume an idle conversation after a stopped/failed run without adding a new user message. */
  continueRun(key: string): Promise<string>;
  /** Withdraw a queued submission from this conversation's inbox. */
  abortSubmission(key: string, submissionId: string): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
  /** Live busy/queue/continue state for a watched conversation. */
  runState(key: string): OwnerRunState;
  transcript(key: string, limit: number): Promise<OwnerItem[]>;
  watch(key: string, handlers: WatchHandlers): Promise<() => Promise<void>>;
  isBusy(key: string): boolean;
  /** Tool names currently offered to the model in a conversation (for tests and diagnostics). */
  offeredTools(key: string): Promise<string[]>;
  /** Submission ids of the inputs the conversation's current run is answering ([] when idle). */
  runningInputs(key: string): Promise<string[]>;
  /** Drop a throwaway conversation (a heated-mode moderator): its key, tools and mapping. pi.sqlite keeps its history. */
  forget(key: string): void;
}

export interface PiRuntimeOptions {
  /** Path of the pi-durable SQLite file. */
  file: string;
  /** core.db, for the `agent_conversations` table. */
  db: DatabaseSync;
  /** Current pi-ai models (read at each use). */
  models: () => Models;
  /** Model every conversation runs with; undefined = none configured (runs end `no_model`). */
  model: () => { provider: string; modelId: string } | undefined;
  log?: (msg: string) => void;
}

export const OWNER_KEY = "owner";
export const channelKey = (ch: string) => `ch:${ch}`;
const SPENCER_EXTENSION = "spencer";

// ------------------------------------------------------------------ implementation

export class PiRuntime implements AgentRuntime {
  private opts: PiRuntimeOptions;
  private log: (msg: string) => void;
  private harness: Harness | undefined;
  private registry: Registry = createRegistry();
  private extension: Extension = defineExtension({ name: SPENCER_EXTENSION, tools: [] });
  private specs = new Map<string, ToolSpec>();
  private registrations = new Map<string, ToolRegistration>();
  private keySpecs = new Map<string, ToolSpec[]>();
  private allowed = new Map<string, Set<string>>();
  private keyToConv = new Map<string, ConversationId>();
  private convToKey = new Map<number, string>();
  private ensuring = new Map<string, Promise<ConversationId>>();
  private busy = new Map<string, boolean>();
  private state = new Map<string, OwnerRunState>();
  private waits = new Set<(reason?: unknown) => void>();
  private watches = new Set<() => Promise<void>>();
  private closed = false;

  constructor(opts: PiRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async open(opts: { deferResume?: boolean } = {}): Promise<void> {
    const { db } = this.opts;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations (
      key TEXT PRIMARY KEY,
      conv_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Moderators live as long as one conversation; the ones a crash left behind are never used again.
    db.prepare("DELETE FROM agent_conversations WHERE key LIKE '%#mod:%'").run();
    for (const row of db.prepare("SELECT key, conv_id FROM agent_conversations").all() as { key: string; conv_id: number }[]) {
      this.remember(row.key, row.conv_id as ConversationId);
    }
    this.remember(OWNER_KEY, ROOT_CONVERSATION_ID);
    this.registry.install(this.extension);
    this.registry.install(CodingTools);
    // The transcript holds private conversations: owner-only. SQLite creates -wal/-shm with the main file's mode.
    restrictFile(this.opts.file);
    const storage = await openNodeSqliteStorage(this.opts.file);
    restrictFile(this.opts.file);
    this.harness = await Harness.open(
      storage,
      {
        models: () => this.opts.models(),
        registry: this.registry,
        identity: { attribution: null },
        settings: {
          // Our own channel conversations must not stall behind a failed run: queued peer inputs go on.
          afterFailedRun: "continue",
          // Only explicitly selected extensions; channel conversations select only "spencer".
          extensions: [this.extension],
        },
        // Only the owner conversation gets an execution environment (for the optional coding tools).
        env: ({ conversationId, cwd }) =>
          conversationId === ROOT_CONVERSATION_ID ? new NodeExecutionEnv({ cwd: cwd ?? homedir() }) : undefined,
        onReport: (r) => this.log(`pi-durable ${r.kind}: ${errText(r.error)}`),
      },
      BACKGROUND_CONTEXT,
    );
    await this.harness.root(BACKGROUND_CONTEXT);
    // Continue runs (and tool calls) the last process left unfinished.
    if (!opts.deferResume) this.resume();
  }

  resume(): void {
    this.h().resume();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.waits]) cancel(new Error("runtime closing"));
    this.waits.clear();
    for (const stop of [...this.watches]) await stop().catch(() => {});
    this.watches.clear();
    const h = this.harness;
    this.harness = undefined;
    if (h) await h.close(BACKGROUND_CONTEXT);
  }

  private h(): Harness {
    if (!this.harness || this.closed) throw new Error("agent runtime is not open");
    return this.harness;
  }

  private remember(key: string, id: ConversationId): void {
    this.keyToConv.set(key, id);
    this.convToKey.set(id as number, key);
  }

  forget(key: string): void {
    if (key === OWNER_KEY) return;
    const id = this.keyToConv.get(key);
    this.keyToConv.delete(key);
    if (id !== undefined) this.convToKey.delete(id as number);
    this.busy.delete(key);
    this.state.delete(key);
    this.allowed.delete(key);
    if (this.keySpecs.delete(key)) this.reinstall();
    this.opts.db.prepare("DELETE FROM agent_conversations WHERE key = ?").run(key);
  }

  async ensureConversation(key: string): Promise<string> {
    return String(await this.convId(key));
  }

  private async convId(key: string): Promise<ConversationId> {
    if (key === OWNER_KEY) return ROOT_CONVERSATION_ID;
    if (!key.startsWith("ch:")) throw new Error(`bad conversation key: ${key}`);
    const pending = this.ensuring.get(key);
    if (pending) return pending;
    const p = (async () => {
      const known = this.keyToConv.get(key);
      if (known !== undefined && (await this.h().conversation(known, BACKGROUND_CONTEXT))) return known;
      // Unknown, or pi.sqlite was replaced: create it. A crash before the insert leaves an unused conversation.
      const conv = await this.h().createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      this.opts.db
        .prepare("INSERT OR REPLACE INTO agent_conversations (key, conv_id, created_at) VALUES (?, ?, ?)")
        .run(key, conv.id as number, Date.now());
      this.remember(key, conv.id);
      return conv.id;
    })();
    this.ensuring.set(key, p);
    try {
      return await p;
    } finally {
      this.ensuring.delete(key);
    }
  }

  private async conversation(key: string): Promise<Conversation> {
    const id = await this.convId(key);
    const conv = id === ROOT_CONVERSATION_ID ? await this.h().root(BACKGROUND_CONTEXT) : await this.h().conversation(id, BACKGROUND_CONTEXT);
    if (!conv) throw new Error(`conversation ${key} not found`);
    return conv;
  }

  async configure(key: string, setup: ConversationSetup): Promise<void> {
    const conv = await this.conversation(key);
    // The latest setup supplies the shared superset schema for each tool.
    this.keySpecs.delete(key);
    this.keySpecs.set(key, setup.tools);
    this.allowed.set(key, new Set(setup.tools.map((t) => t.name)));
    this.reinstall();
    const regs = setup.tools.map((t) => this.registrations.get(t.name)!);
    const coding = key === OWNER_KEY && setup.codingTools !== undefined;
    const tools: ToolRegistration[] = coding ? [...regs, ...(CodingTools.tools ?? [])] : regs;
    const extensions: Extension[] = coding ? [this.extension, CodingTools] : [this.extension];
    const model = setup.model ?? this.opts.model();
    // Skip the commit when nothing changed (start() configures every conversation each time).
    const current = await conv.agent(BACKGROUND_CONTEXT);
    const same =
      current.instructions === setup.instructions &&
      sameList(current.extensions.map((e) => e.name), extensions.map((e) => e.name)) &&
      sameList(current.tools.map((t) => t.name), tools.map((t) => t.name)) &&
      current.model?.provider === model?.provider &&
      current.model?.modelId === model?.modelId &&
      (current.thinkingLevel ?? "off") === (setup.thinkingLevel ?? "off") &&
      (current.cwd ?? undefined) === (coding ? setup.codingTools?.cwd : undefined);
    if (same) return;
    await conv.configure(
      {
        model: model ?? null,
        extensions,
        tools,
        instructions: setup.instructions,
        cwd: coding ? (setup.codingTools?.cwd ?? null) : null,
        // No level means "off": a level an earlier setup set must not stick.
        thinkingLevel: (setup.thinkingLevel ?? "off") as never,
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** Rebuild the "spencer" extension from the union of every conversation's tools; replaces it in place. */
  private reinstall(): void {
    const union = new Map<string, ToolSpec>();
    for (const list of this.keySpecs.values()) for (const t of list) union.set(t.name, t);
    let changed = union.size !== this.specs.size;
    for (const [name, spec] of union) {
      const previous = this.specs.get(name);
      if (previous !== spec) changed = true;
      this.specs.set(name, spec);
      if (!this.registrations.has(name) || this.registrations.get(name)!.description !== spec.description || JSON.stringify(previous?.parameters) !== JSON.stringify(spec.parameters)) {
        this.registrations.set(name, this.toRegistration(spec));
        changed = true;
      }
    }
    for (const name of [...this.specs.keys()]) {
      if (!union.has(name)) {
        this.specs.delete(name);
        this.registrations.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    this.extension = defineExtension({ name: SPENCER_EXTENSION, tools: [...this.registrations.values()] });
    this.registry.install(this.extension);
  }

  private toRegistration(spec: ToolSpec): ToolRegistration {
    const name = spec.name;
    return defineTool<object>({
      name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (args, api, context) => {
        const key = this.convToKey.get(api.conversationId as number);
        const current = this.specs.get(name);
        if (!key || !current || !this.allowed.get(key)?.has(name)) {
          return { output: [{ type: "text", text: `Tool ${name} is not available in this conversation.` }], isError: true };
        }
        const out = await current.execute(args, { conversationKey: key, callId: api.callId, signal: context.abortSignal });
        const r = typeof out === "string" ? { text: out } : out;
        return { output: [{ type: "text", text: r.text }], isError: r.isError === true };
      },
    });
  }

  async submitInput(key: string, input: InputSubmission): Promise<string> {
    const conv = await this.conversation(key);
    const s = await conv.submit(
      {
        type: "input",
        content: input.content,
        requestId: input.requestId,
        ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
        ...(input.whenIdle ? { whenIdle: input.whenIdle } : {}),
        ...(input.display ? { entry: { kind: input.display.kind, data: toJson(input.display.data) } } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    return String(s.id);
  }

  async abort(key: string): Promise<void> {
    const conv = await this.conversation(key);
    await conv.abort(BACKGROUND_CONTEXT);
  }

  async continueRun(key: string): Promise<string> {
    const conv = await this.conversation(key);
    const s = await conv.submit({ type: "continue" }, BACKGROUND_CONTEXT);
    return String(s.id);
  }

  async abortSubmission(key: string, submissionId: string): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
    const id = Number(submissionId);
    if (!Number.isSafeInteger(id) || id <= 0) return "not_found";
    return await this.h().abortSubmission(id as SubmissionId, BACKGROUND_CONTEXT, await this.convId(key));
  }

  runState(key: string): OwnerRunState {
    return this.state.get(key) ?? { busy: this.busy.get(key) ?? false, queue: [] };
  }

  async appendNote(key: string, note: NoteInput): Promise<void> {
    const conv = await this.conversation(key);
    const model: Message[] | undefined = note.modelText
      ? [{ role: "user", content: note.modelText, timestamp: Date.now() }]
      : undefined;
    await conv.submit(
      {
        type: "write",
        entry: { kind: note.kind, data: toJson(note.data), ...(model ? { model } : {}) },
        ...(note.requestId ? { requestId: note.requestId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
  }

  async waitAnswer(submissionId: string, signal?: AbortSignal): Promise<Answer> {
    const h = this.h();
    signal?.throwIfAborted();
    const s = await h.submission(Number(submissionId) as SubmissionId, BACKGROUND_CONTEXT);
    if (!s) return { status: "unanswered", reason: "unknown submission" };
    signal?.throwIfAborted();
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    this.waits.add(cancel);
    const onAbort = () => cancel(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const settled = await s.wait(context);
      if (settled.status !== "done" || settled.type === "write") {
        if (settled.status === "done") return { status: "unanswered", reason: "not an input" };
        const detail = settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`;
        return { status: "unanswered", reason: `${settled.reason}${detail}` };
      }
      const conv = await h.conversation(settled.conversationId, BACKGROUND_CONTEXT);
      const page = conv
        ? await conv.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, BACKGROUND_CONTEXT)
        : undefined;
      const entry = page?.items[0];
      const msg = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
      return { status: "done", text: msg && msg.role === "assistant" ? assistantText(msg) : "" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.waits.delete(cancel);
    }
  }

  async transcript(key: string, limit: number): Promise<OwnerItem[]> {
    const conv = await this.conversation(key);
    const page = await conv.entries({ order: "descending" }, Math.max(1, Math.min(limit, 500)) * 2, undefined, BACKGROUND_CONTEXT);
    const items = [...page.items].reverse().flatMap(entryItems);
    return items.slice(-limit);
  }

  async watch(key: string, handlers: WatchHandlers): Promise<() => Promise<void>> {
    const conv = await this.conversation(key);
    const watch = await conv.watch(BACKGROUND_CONTEXT);
    let last = maxId(watch.value.entries);
    let runState = extractRunState(watch.value);
    let lastStateJson = JSON.stringify(runState);
    this.busy.set(key, runState.busy);
    this.state.set(key, runState);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const fresh = call.value.entries.filter((e) => (e.id as number) > last);
      if (fresh.length) {
        last = maxId(fresh);
        const items = fresh.flatMap(entryItems);
        if (items.length) handlers.onItems?.(items);
      }
      const nextState = extractRunState(call.value);
      const prevBusy = runState.busy;
      runState = nextState;
      this.busy.set(key, nextState.busy);
      this.state.set(key, nextState);
      if (nextState.busy !== prevBusy) handlers.onBusy?.(nextState.busy);
      const nextJson = JSON.stringify(nextState);
      if (nextJson !== lastStateJson) {
        lastStateJson = nextJson;
        handlers.onState?.(nextState);
      }
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      this.watches.delete(stop);
      await watch.stop();
    };
    this.watches.add(stop);
    return stop;
  }

  isBusy(key: string): boolean {
    return this.busy.get(key) ?? false;
  }

  async runningInputs(key: string): Promise<string[]> {
    const live = await this.h().snapshot(LiveDoc, await this.convId(key), BACKGROUND_CONTEXT);
    return (live?.run?.inputs ?? []).map((id) => String(id));
  }

  async offeredTools(key: string): Promise<string[]> {
    const conv = await this.conversation(key);
    return (await conv.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
  }
}

// ------------------------------------------------------------------ helpers

/** Creates `file` (empty) with mode 0600 if missing, and chmods it and its -wal/-shm/-journal files to 0600. */
export function restrictFile(file: string): void {
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function maxId(entries: readonly EntryRecord[]): number {
  let m = 0;
  for (const e of entries) m = Math.max(m, e.id as number);
  return m;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON-safe copy (pi-durable stores JSON values only). */
function toJson(v: unknown): any {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as any).type === "text" ? String((b as any).text) : b?.type === "image" ? "[image]" : ""))
      .join("");
  }
  return "";
}

function extractRunState(view: { docs: Record<string, any> }): OwnerRunState {
  const live = view.docs["pi.live"];
  const inbox = view.docs["pi.inbox"];
  const busy = Boolean(live?.run);
  const queue: OwnerQueuedItem[] = [];
  for (const it of inbox?.items ?? []) {
    if (!it || (it.mode !== "steer" && it.mode !== "followUp")) continue;
    const entryData = it.entry?.data && typeof it.entry.data === "object" ? (it.entry.data as Record<string, unknown>) : undefined;
    const text = typeof entryData?.text === "string" ? entryData.text : contentText(it.content);
    const attachments = Array.isArray(entryData?.attachments)
      ? entryData.attachments.filter((file): file is OwnerAttachment =>
          !!file && typeof file === "object" && typeof (file as OwnerAttachment).id === "string" &&
          typeof (file as OwnerAttachment).name === "string" && Number.isSafeInteger((file as OwnerAttachment).size),
        )
      : undefined;
    queue.push({
      id: String(it.id),
      mode: it.mode,
      text: short(text, 400),
      ...(attachments?.length ? { attachments } : {}),
    });
  }
  const rf = live?.runFailure;
  const canContinue = !busy && !!rf && typeof rf.reason === "string" && rf.reason !== "nothing_to_answer" && rf.reason !== "reset";
  const lastFailure = !busy && rf && typeof rf.reason === "string"
    ? { reason: String(rf.reason), ...(typeof rf.detail === "string" && rf.detail ? { detail: short(rf.detail, 200) } : {}) }
    : undefined;
  return {
    busy,
    queue,
    ...(canContinue ? { canContinue: true } : {}),
    ...(lastFailure ? { lastFailure } : {}),
  };
}

function short(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Transcript entry → owner UI items. Our notes carry `{ text, ts, isError?, untrusted?, role? }` in `data`. */
function entryItems(e: EntryRecord): OwnerItem[] {
  const id = String(e.id);
  const msg = e.model?.[0];
  const ts = (msg && "timestamp" in msg ? (msg.timestamp as number) : undefined) ?? Number((e.data as any)?.ts ?? 0);
  switch (e.kind) {
    case "pi.system":
    case "pi.reset":
      return [];
    case "pi.user":
    case "spencer.owner-input": {
      const data = (e.data ?? {}) as { text?: unknown; attachments?: unknown };
      const item: OwnerItem = { id, role: "user", text: typeof data.text === "string" ? data.text : contentText(msg?.content), ts };
      if (Array.isArray(data.attachments)) {
        item.attachments = data.attachments.filter((file): file is OwnerAttachment =>
          !!file && typeof file === "object" && typeof (file as OwnerAttachment).id === "string" &&
          typeof (file as OwnerAttachment).name === "string" && Number.isSafeInteger((file as OwnerAttachment).size),
        );
      }
      return [item];
    }
    case "pi.assistant": {
      if (!msg || msg.role !== "assistant") return [];
      const am = msg as AssistantMessage;
      const out: OwnerItem[] = [];
      const text = assistantText(am);
      if (text) out.push({ id, role: "assistant", text, ts });
      if (am.stopReason === "error") {
        out.push({ id: `${id}.err`, role: "assistant", text: `Model ${am.stopReason}: ${am.errorMessage ?? "no details"}`, ts, isError: true });
      } else if (am.stopReason === "aborted") {
        out.push({ id: `${id}.err`, role: "note", kind: "stopped", text: "Stopped.", ts });
      }
      am.content.forEach((b, i) => {
        if (b.type === "toolCall") {
          out.push({ id: `${id}.${i}`, role: "tool", toolName: b.name, text: short(`call ${JSON.stringify(b.arguments)}`, 300), ts });
        }
      });
      return out;
    }
    case "pi.tool-result": {
      if (!msg || msg.role !== "toolResult") return [];
      const tr = msg as ToolResultMessage;
      return [{ id, role: "tool", toolName: tr.toolName, text: short(contentText(tr.content)), ts, isError: tr.isError }];
    }
    case "pi.compaction":
      return [{ id, role: "note", text: "(earlier conversation summarized)", ts }];
    default: {
      // Our own kinds: notes, peer messages, errors.
      const d = (e.data ?? {}) as { text?: string; ts?: number; isError?: boolean; untrusted?: boolean; request?: string; role?: OwnerItem["role"]; kind?: string; fullText?: string };
      const text = d.text ?? contentText(msg?.content);
      if (!text) return [];
      const role = d.role ?? "note";
      const item: OwnerItem = { id, role, text, ts: d.ts ?? ts };
      if (d.isError) item.isError = true;
      if (d.untrusted) item.untrusted = true;
      if (typeof d.request === "string") item.request = d.request;
      if (typeof d.kind === "string") item.kind = d.kind;
      if (typeof d.fullText === "string") item.fullText = d.fullText;
      return [item];
    }
  }
}
