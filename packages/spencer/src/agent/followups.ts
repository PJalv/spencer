/**
 * Follow-ups: reminders an agent schedules on itself ("I'll get back to you"), so a long task (e.g. a T3 Code thread)
 * gets reported without anyone writing first (PROTOCOL.md §7.4).
 *
 * Stored in core.db (`agent_followups`), so they survive restarts. This module is the store and the timer; the agent
 * decides what firing means (a run in the owner or channel conversation, then a channel message). Delivery is
 * exactly-once with the same pattern as replies: `pending → fired` is one conditional UPDATE, the run is submitted with
 * `requestId = "followup:" + id + ":w" + wake_count`, and a channel message is enqueued with `idempotencyKey = "followup:" + id`.
 *
 * Timer: wall-clock based. The timer wakes at most every `maxSleepMs` and compares `due_at` with `Date.now()`, because
 * Node timers run on a monotonic clock that stops while a laptop sleeps: a plain 30-minute setTimeout armed before a
 * 2-hour suspend would fire 30 awake-minutes after resume instead of right away.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Followup } from "../contracts.ts";

export type FollowupState = "pending" | "fired" | "done" | "cancelled" | "failed";

export interface FollowupRow {
  id: string;
  /** "owner" or "ch:<id>". */
  conv: string;
  /** Channel follow-ups: the channel. */
  ch: string | null;
  note: string;
  due_at: number;
  /** Owner follow-ups: fire early when a peer writes in this channel. */
  wake_ch: string | null;
  watch: number;
  max_wakes: number;
  wake_count: number;
  last_msg_final: number;
  wake_text: string | null;
  task_notified: number;
  task_ch: string | null;
  task_msg_id: string | null;
  /** 0: scheduled by an ordinary run; n: by the run of a follow-up of depth n-1. */
  depth: number;
  /** Channel follow-ups: hop, the message it continues, and who to mention (groups). */
  hop: number;
  reply_to: string | null;
  to_id: string | null;
  state: FollowupState;
  submission_id: string | null;
  /** "time" or "reply": what fired it. */
  fired_by: string | null;
  error: string | null;
  created_at: number;
  fired_at: number | null;
  updated_at: number;
}

export type McpEventSubscriptionState = "active" | "revoked" | "ended";
export interface McpEventSubscriptionRow {
  id: string; followup_id: string; server_name: string; server_identity: string | null;
  event_name: string; args_json: string; cursor: string | null; state: McpEventSubscriptionState;
  last_event_at: number | null; last_heartbeat_at: number | null; error: string | null;
  created_at: number; updated_at: number;
}

export interface NewFollowup {
  conv: string;
  ch?: string;
  note: string;
  dueAt: number;
  wakeCh?: string;
  watch?: boolean;
  maxWakes?: number;
  taskCh?: string;
  taskMsgId?: string;
  depth: number;
  hop?: number;
  replyTo?: string;
  toId?: string;
}

export interface FollowupStoreOptions {
  now?: () => number;
  /** Called (not awaited concurrently) with rows whose time has come, oldest first. */
  onDue(rows: FollowupRow[]): Promise<void>;
  /** A row changed (for UI events). */
  onChange?(row: FollowupRow): void;
  log?(msg: string): void;
  /** Longest single sleep of the timer (default 15 s). */
  maxSleepMs?: number;
}

/** How many finished follow-ups the API lists next to the open ones. */
const RECENT_FINISHED = 20;

export class FollowupStore {
  private db: DatabaseSync;
  private o: FollowupStoreOptions;
  private now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = true;

  constructor(db: DatabaseSync, opts: FollowupStoreOptions) {
    this.db = db;
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  init(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_followups (
      id TEXT PRIMARY KEY,
      conv TEXT NOT NULL,
      ch TEXT,
      note TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      wake_ch TEXT,
      depth INTEGER NOT NULL,
      hop INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      to_id TEXT,
      state TEXT NOT NULL,
      submission_id TEXT,
      fired_by TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      updated_at INTEGER NOT NULL
    )`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(agent_followups)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of Object.entries({
      watch: "INTEGER NOT NULL DEFAULT 0", max_wakes: "INTEGER NOT NULL DEFAULT 5",
      wake_count: "INTEGER NOT NULL DEFAULT 0", last_msg_final: "INTEGER NOT NULL DEFAULT 0",
      task_ch: "TEXT", task_msg_id: "TEXT", wake_text: "TEXT", task_notified: "INTEGER NOT NULL DEFAULT 0",
    })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_followups ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_watch_updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, followup_id TEXT NOT NULL,
      msg_id TEXT NOT NULL, content TEXT NOT NULL, final INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(followup_id, msg_id)
    )`);
    const updateColumns = new Set((this.db.prepare("PRAGMA table_info(agent_watch_updates)").all() as { name: string }[]).map((c) => c.name));
    if (!updateColumns.has("fired_by")) this.db.exec("ALTER TABLE agent_watch_updates ADD COLUMN fired_by TEXT NOT NULL DEFAULT 'reply'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
      id TEXT PRIMARY KEY, followup_id TEXT NOT NULL, server_name TEXT NOT NULL, server_identity TEXT,
      event_name TEXT NOT NULL, args_json TEXT NOT NULL, cursor TEXT, state TEXT NOT NULL,
      last_event_at INTEGER, last_heartbeat_at INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_event_subs_followup ON mcp_event_subscriptions (followup_id);
    CREATE INDEX IF NOT EXISTS mcp_event_subs_active ON mcp_event_subscriptions (state, server_name);
    CREATE TABLE IF NOT EXISTS mcp_event_receipts (subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
      received_at INTEGER NOT NULL, PRIMARY KEY (subscription_id, event_id));`);
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_followups_state ON agent_followups (state, due_at)");
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  // ---------------------------------------------------------------- reads

  get(id: string): FollowupRow | undefined {
    return this.db.prepare("SELECT * FROM agent_followups WHERE id = ?").get(id) as FollowupRow | undefined;
  }

  open(conv: string): FollowupRow[] {
    return this.db.prepare("SELECT * FROM agent_followups WHERE conv = ? AND state = 'pending' ORDER BY due_at").all(conv) as unknown as FollowupRow[];
  }

  /** The follow-up whose run is one of these submissions (the run that is calling a tool now). */
  bySubmission(conv: string, submissionIds: string[]): FollowupRow | undefined {
    for (const sid of submissionIds) {
      const row = this.db.prepare("SELECT * FROM agent_followups WHERE conv = ? AND submission_id = ?").get(conv, sid) as
        | FollowupRow
        | undefined;
      if (row) return row;
    }
    return undefined;
  }

  /** Owner follow-ups waiting for a peer to write in `ch`. */
  waitingOn(ch: string): FollowupRow[] {
    return this.db
      .prepare("SELECT * FROM agent_followups WHERE (state = 'pending' OR (state = 'fired' AND watch = 1)) AND wake_ch = ? ORDER BY due_at")
      .all(ch) as unknown as FollowupRow[];
  }

  enqueueUpdate(id: string, msgId: string, content: string, final: boolean): boolean {
    return !!this.db.prepare(`INSERT OR IGNORE INTO agent_watch_updates (followup_id, msg_id, content, final)
      SELECT id, ?, ?, ? FROM agent_followups
      WHERE id = ? AND watch = 1 AND state IN ('pending', 'fired') AND due_at > ?`)
      .run(msgId, content, final ? 1 : 0, id, this.now()).changes;
  }

  /** Claim the next update and its wake number together, so restart cannot lose or repeat a wake. */
  claimUpdate(id: string): FollowupRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.db.prepare("SELECT seq, content, final, fired_by FROM agent_watch_updates WHERE followup_id = ? AND claimed = 0 ORDER BY seq LIMIT 1")
        .get(id) as { seq: number; content: string; final: number; fired_by: "reply" | "event" } | undefined;
      if (!next || !this.markFired(id, next.fired_by, !!next.final)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db.prepare("UPDATE agent_followups SET wake_text = ? WHERE id = ?").run(next.content, id);
      this.db.prepare("UPDATE agent_watch_updates SET claimed = 1 WHERE seq = ?").run(next.seq);
      this.db.exec("COMMIT");
      return this.get(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingWatches(): FollowupRow[] {
    return this.db.prepare("SELECT * FROM agent_followups WHERE watch = 1 AND state = 'pending'").all() as unknown as FollowupRow[];
  }

  hasUnclaimedUpdate(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM agent_watch_updates WHERE followup_id = ? AND claimed = 0 LIMIT 1").get(id);
  }

  unnotifiedTasks(): FollowupRow[] {
    return this.db.prepare("SELECT * FROM agent_followups WHERE task_ch IS NOT NULL AND task_notified = 0 AND state IN ('done', 'failed', 'cancelled')").all() as unknown as FollowupRow[];
  }

  taskNotified(ch: string, msgId: string): void {
    this.db.prepare("UPDATE agent_followups SET task_notified = 1 WHERE task_ch = ? AND task_msg_id = ?").run(ch, msgId);
  }

  /** Fired but not finished (a run in flight, or a crash before it finished). */
  unfinished(): FollowupRow[] {
    return this.db.prepare("SELECT * FROM agent_followups WHERE state = 'fired' ORDER BY fired_at").all() as unknown as FollowupRow[];
  }

  /** Open follow-ups, then the most recently finished ones. */
  list(): FollowupRow[] {
    const open = this.db
      .prepare("SELECT * FROM agent_followups WHERE state IN ('pending', 'fired') ORDER BY due_at")
      .all() as unknown as FollowupRow[];
    const done = this.db
      .prepare("SELECT * FROM agent_followups WHERE state NOT IN ('pending', 'fired') ORDER BY updated_at DESC LIMIT ?")
      .all(RECENT_FINISHED) as unknown as FollowupRow[];
    return [...open, ...done];
  }

  // ---------------------------------------------------------------- writes

  insert(f: NewFollowup): FollowupRow {
    const id = randomBytes(12).toString("base64url");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agent_followups (id, conv, ch, note, due_at, wake_ch, depth, hop, reply_to, to_id, state, created_at, updated_at, watch, max_wakes, task_ch, task_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.conv, f.ch ?? null, f.note, f.dueAt, f.wakeCh ?? null, f.depth, f.hop ?? 0, f.replyTo ?? null, f.toId ?? null, now, now, f.watch ? 1 : 0, f.maxWakes ?? 5, f.taskCh ?? null, f.taskMsgId ?? null);
    this.changed(id);
    this.arm();
    return this.get(id)!;
  }

  /** `pending → fired`; false when it was not pending (already fired or cancelled). */
  markFired(id: string, by: "time" | "reply" | "event", final = false): boolean {
    const now = this.now();
    const r = this.db
      .prepare("UPDATE agent_followups SET state = 'fired', fired_by = ?, fired_at = ?, updated_at = ?, last_msg_final = ?, wake_count = wake_count + 1 WHERE id = ? AND state = 'pending'")
      .run(by, now, now, final ? 1 : 0, id);
    if (Number(r.changes) === 0) return false;
    this.changed(id);
    return true;
  }

  rearm(id: string): boolean {
    const r = this.db.prepare(`UPDATE agent_followups SET state = 'pending', submission_id = NULL
      WHERE id = ? AND state = 'fired' AND watch = 1 AND fired_by IN ('reply', 'event')
      AND last_msg_final = 0 AND wake_count < max_wakes AND due_at > ?`).run(id, this.now());
    if (!r.changes) return false;
    this.changed(id);
    this.arm();
    return true;
  }

  linkedTask(ch: string, msgId: string): FollowupRow[] {
    return this.db.prepare("SELECT * FROM agent_followups WHERE task_ch = ? AND task_msg_id = ? AND state IN ('pending', 'fired')")
      .all(ch, msgId) as unknown as FollowupRow[];
  }

  setSubmission(id: string, submissionId: string): void {
    this.db.prepare("UPDATE agent_followups SET submission_id = ?, updated_at = ? WHERE id = ?").run(submissionId, this.now(), id);
  }

  /** Ends an open follow-up. Returns false if it had already ended. */
  finish(id: string, state: "done" | "cancelled" | "failed", error?: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare("UPDATE agent_followups SET state = ?, error = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'fired')")
        .run(state, error?.slice(0, 500) ?? null, this.now(), id);
      if (Number(r.changes) === 0) { this.db.exec("COMMIT"); return false; }
      this.endSubscriptionsForFollowup(id);
      this.db.prepare("DELETE FROM agent_watch_updates WHERE followup_id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.changed(id);
    this.arm();
    return true;
  }

  /** Move a pending follow-up later (e.g. the channel's turn budget is used up). */
  postpone(id: string, dueAt: number): void {
    this.db.prepare("UPDATE agent_followups SET due_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(dueAt, this.now(), id);
    this.changed(id);
    this.arm();
  }

  insertEventSubscriptions(followupId: string, subs: { serverName: string; serverIdentity?: string | null; eventName: string; argsJson: string; cursor?: string | null }[]): McpEventSubscriptionRow[] {
    const ids: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sub of subs) {
        const id = randomBytes(12).toString("base64url"); ids.push(id);
        this.db.prepare(`INSERT INTO mcp_event_subscriptions (id, followup_id, server_name, server_identity, event_name, args_json, cursor, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, followupId, sub.serverName, sub.serverIdentity ?? null, sub.eventName, sub.argsJson, sub.cursor ?? null, this.now(), this.now());
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.changed(followupId);
    return ids.map((id) => this.subscription(id)!);
  }

  subscription(id: string): McpEventSubscriptionRow | undefined {
    return this.db.prepare("SELECT * FROM mcp_event_subscriptions WHERE id = ?").get(id) as McpEventSubscriptionRow | undefined;
  }
  subscriptionsForFollowup(id: string): McpEventSubscriptionRow[] {
    return this.db.prepare("SELECT * FROM mcp_event_subscriptions WHERE followup_id = ?").all(id) as unknown as McpEventSubscriptionRow[];
  }
  activeSubscriptions(serverName?: string): McpEventSubscriptionRow[] {
    return this.db.prepare(`SELECT s.* FROM mcp_event_subscriptions s JOIN agent_followups f ON f.id = s.followup_id
      WHERE s.state = 'active' AND f.state IN ('pending', 'fired') AND (? IS NULL OR s.server_name = ?)`)
      .all(serverName ?? null, serverName ?? null) as unknown as McpEventSubscriptionRow[];
  }
  private admit(subscriptionId: string, key: string, cursor: string | null | undefined, content: string, final: boolean, gap: boolean): { admitted: boolean; duplicate: boolean; followupId?: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sub = this.db.prepare(`SELECT s.followup_id FROM mcp_event_subscriptions s JOIN agent_followups f ON f.id = s.followup_id
        WHERE s.id = ? AND s.state = 'active' AND f.watch = 1 AND f.state IN ('pending', 'fired') AND f.due_at > ?`).get(subscriptionId, this.now()) as { followup_id: string } | undefined;
      if (!sub) { this.db.exec("COMMIT"); return { admitted: false, duplicate: false }; }
      const msgId = `mcp${gap ? "-gap" : ""}:${subscriptionId}:${key}`;
      const result = gap
        ? this.db.prepare("INSERT OR IGNORE INTO agent_watch_updates (followup_id, msg_id, content, final, fired_by) VALUES (?, ?, ?, 0, 'event')").run(sub.followup_id, msgId, content)
        : this.db.prepare("INSERT OR IGNORE INTO mcp_event_receipts (subscription_id, event_id, received_at) VALUES (?, ?, ?)").run(subscriptionId, key, this.now());
      if (!result.changes) {
        if (!gap && cursor) {
          this.db.prepare("UPDATE mcp_event_subscriptions SET cursor = COALESCE(?, cursor), updated_at = ? WHERE id = ?")
            .run(cursor, this.now(), subscriptionId);
        }
        this.db.exec("COMMIT");
        return { admitted: false, duplicate: true, followupId: sub.followup_id };
      }
      if (!gap) this.db.prepare("INSERT INTO agent_watch_updates (followup_id, msg_id, content, final, fired_by) VALUES (?, ?, ?, ?, 'event')").run(sub.followup_id, msgId, content, final ? 1 : 0);
      this.db.prepare(`UPDATE mcp_event_subscriptions SET cursor = COALESCE(?, cursor),
        last_event_at = CASE WHEN ? THEN last_event_at ELSE ? END, updated_at = ? WHERE id = ?`)
        .run(cursor ?? null, gap ? 1 : 0, this.now(), this.now(), subscriptionId);
      this.db.exec("COMMIT");
      return { admitted: true, duplicate: false, followupId: sub.followup_id };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  admitEvent(opts: { subscriptionId: string; eventId: string; cursor?: string | null; content: string; final?: boolean }): { admitted: boolean; duplicate: boolean; followupId?: string } {
    return this.admit(opts.subscriptionId, opts.eventId, opts.cursor, opts.content, !!opts.final, false);
  }
  admitGap(opts: { subscriptionId: string; gapKey: string; cursor?: string | null; content: string }): { admitted: boolean; followupId?: string } {
    const { admitted, followupId } = this.admit(opts.subscriptionId, opts.gapKey, opts.cursor, opts.content, false, true);
    return { admitted, ...(followupId ? { followupId } : {}) };
  }
  updateSubscriptionCursor(id: string, cursor: string | null, opts?: { heartbeat?: boolean; serverIdentity?: string }): void {
    this.db.prepare(`UPDATE mcp_event_subscriptions SET cursor = COALESCE(?, cursor), last_heartbeat_at = CASE WHEN ? THEN ? ELSE last_heartbeat_at END,
      server_identity = COALESCE(?, server_identity), updated_at = ? WHERE id = ?`).run(cursor, opts?.heartbeat ? 1 : 0, this.now(), opts?.serverIdentity ?? null, this.now(), id);
  }
  setSubscriptionState(id: string, state: McpEventSubscriptionState, error?: string): boolean {
    const sub = this.subscription(id); if (!sub || (sub.state === state && sub.error === (error?.slice(0, 500) ?? null))) return false;
    this.db.prepare("UPDATE mcp_event_subscriptions SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error?.slice(0, 500) ?? null, this.now(), id);
    this.changed(sub.followup_id); return true;
  }
  endSubscriptionsForFollowup(id: string, state: "ended" | "revoked" = "ended", error?: string): McpEventSubscriptionRow[] {
    const subs = this.subscriptionsForFollowup(id).filter((s) => s.state === "active");
    this.db.prepare("UPDATE mcp_event_subscriptions SET state = ?, error = ?, updated_at = ? WHERE followup_id = ? AND state = 'active'").run(state, error?.slice(0, 500) ?? null, this.now(), id);
    this.db.prepare("DELETE FROM mcp_event_receipts WHERE subscription_id IN (SELECT id FROM mcp_event_subscriptions WHERE followup_id = ?)").run(id);
    return subs;
  }

  private changed(id: string): void {
    const row = this.get(id);
    if (row) this.o.onChange?.(row);
  }

  // ---------------------------------------------------------------- timer

  /** Re-arm the timer for the earliest pending follow-up (wall clock, see the file comment). */
  arm(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.db.prepare("SELECT min(due_at) AS at FROM agent_followups WHERE state = 'pending'").get() as { at: number | null };
    if (next.at === null) return;
    const delay = Math.max(0, Math.min(next.at - this.now(), this.o.maxSleepMs ?? 15_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** Fire everything that is due now (also called by tests). */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const due = this.db
          .prepare("SELECT * FROM agent_followups WHERE state = 'pending' AND due_at <= ? ORDER BY due_at")
          .all(this.now()) as unknown as FollowupRow[];
        if (due.length && !this.stopped) {
          try {
            await this.o.onDue(due);
          } catch (e) {
            this.o.log?.(`follow-ups: ${(e as Error).message}`);
          }
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = undefined;
      this.arm();
    });
    return this.running;
  }
}

export function toFollowup(r: FollowupRow, subs?: McpEventSubscriptionRow[] | number): Followup {
  const ch = r.ch ?? undefined;
  return {
    id: r.id,
    conversation: r.conv === "owner" ? "owner" : "channel",
    ...(ch ? { ch } : {}),
    note: r.note,
    dueAt: r.due_at,
    ...(r.wake_ch ? { wakeOnReplyIn: r.wake_ch } : {}),
    state: r.state === "fired" ? "running" : r.state,
    depth: r.depth,
    watch: !!r.watch,
    maxWakes: r.max_wakes,
    wakeCount: r.wake_count,
    createdAt: r.created_at,
    ...(r.fired_at ? { firedAt: r.fired_at } : {}),
    ...(Array.isArray(subs) ? { eventSubscriptions: subs.map((s) => ({ id: s.id, server: s.server_name, event: s.event_name, state: s.state, ...(s.error ? { error: s.error } : {}) })) } : {}),
    ...(r.fired_by === "time" || r.fired_by === "reply" || r.fired_by === "event" ? { firedBy: r.fired_by } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}
