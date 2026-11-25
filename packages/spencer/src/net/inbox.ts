import { isEnvelope, openEnvelope, parseBody, type Body, type Identity } from "@spencer/protocol";
import type { Sql } from "../store/db.ts";
import type { ChannelKeyInfo } from "./outbox.ts";

export interface StoredMessage {
  id: string;
  ch: string;
  seq: number | null;
  from_id: string;
  ts: number;
  type: string;
  body: string;
}

export interface InboxDeps {
  sql: Sql;
  me: Identity;
  log: (m: string) => void;
  channelInfo(ch: string): ChannelKeyInfo | undefined;
  /** Hand a stored message to hello/chat/transfer handling. Must be idempotent. */
  route(msg: StoredMessage, body: Body): Promise<void>;
  /** Typing delivered on a durable relay path is handled without storing a message. */
  typing?(ch: string, from: string, active: boolean, ts: number): void;
  /** After routed=1 was set (emit UI events). */
  routed(msg: StoredMessage, body: Body): void;
  /** Cumulative ack to the relay (best effort). */
  ack(relayUrl: string, ch: string, seq: number): void;
  /** Delay before retrying messages whose routing threw. */
  retryMs?: number;
}

/** Durable receive (PROTOCOL §5.2): store-then-route-then-ack, serialized per channel. */
export class Inbox {
  private d: InboxDeps;
  private chains = new Map<string, Promise<void>>();
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(deps: InboxDeps) {
    this.d = deps;
  }

  /** A `msg` frame from the relay at `relayUrl`. */
  onMsg(relayUrl: string, frame: { ch?: unknown; seq?: unknown; env?: unknown }): void {
    if (this.stopped) return;
    const ch = typeof frame.ch === "string" ? frame.ch : (frame.env as { ch?: unknown } | undefined)?.ch;
    if (typeof ch !== "string") {
      this.d.log(`inbox: msg frame without channel from ${relayUrl}`);
      return;
    }
    this.enqueueWork(ch, () => this.process(relayUrl, ch, frame.seq, frame.env));
  }

  private enqueueWork(ch: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(ch) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((e: Error) => this.d.log(`inbox ${ch}: ${e.stack ?? e.message}`))
      .finally(() => {
        if (this.chains.get(ch) === next) this.chains.delete(ch);
      });
    this.chains.set(ch, next);
    return next;
  }

  private async process(relayUrl: string, ch: string, seqRaw: unknown, env: unknown): Promise<void> {
    const { sql, log } = this.d;
    const seq = Number(seqRaw);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      log(`inbox ${ch}: msg with bad seq`);
      return;
    }
    const info = this.d.channelInfo(ch);
    if (!info) {
      log(`inbox ${ch}: msg for unknown channel, ignored`);
      return;
    }
    if (info.relayUrl !== relayUrl) {
      log(`inbox ${ch}: msg from unexpected relay ${relayUrl}, ignored`);
      return;
    }
    const advance = () => sql.run("UPDATE channels SET last_seq = max(last_seq, ?) WHERE id = ?", seq, ch);
    if (!isEnvelope(env) || env.ch !== ch) {
      log(`inbox ${ch}: malformed envelope at seq ${seq}, dropped`);
      advance();
      this.d.ack(relayUrl, ch, seq);
      return;
    }
    if (env.from === this.d.me.id) {
      advance();
      this.d.ack(relayUrl, ch, seq);
      return;
    }
    let body: Body;
    try {
      body = openEnvelope(env, info.encKey);
    } catch (e) {
      log(`inbox ${ch}: dropped ${env.id} from ${env.from} at seq ${seq}: ${(e as Error).message}`);
      advance();
      this.d.ack(relayUrl, ch, seq);
      return;
    }
    if (body.type === "typing") {
      advance();
      this.d.ack(relayUrl, ch, seq);
      this.d.typing?.(ch, env.from, body.active, env.ts);
      return;
    }
    const now = Date.now();
    sql.tx(() => {
      const r = sql.run(
        `INSERT OR IGNORE INTO messages (id, ch, seq, from_id, ts, type, body, mine, status, origin, note, routed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'received', 'peer', NULL, 0, ?)`,
        env.id,
        ch,
        seq,
        env.from,
        env.ts,
        body.type,
        JSON.stringify(body),
        now,
      );
      if (r.changes > 0 && body.type === "chat") sql.run("UPDATE channels SET unread = unread + 1 WHERE id = ?", ch);
      advance();
    });
    const row = sql.get<StoredMessage & { routed: number }>(
      "SELECT id, ch, seq, from_id, ts, type, body, routed FROM messages WHERE id = ?",
      env.id,
    );
    if (row && row.ch === ch && !row.routed) await this.routeOne(row);
    this.d.ack(relayUrl, ch, seq);
  }

  private async routeOne(row: StoredMessage): Promise<void> {
    let body: Body | null = null;
    try {
      body = parseBody(JSON.parse(row.body));
    } catch {
      body = null;
    }
    if (!body) {
      this.d.sql.run("UPDATE messages SET routed = 1, note = 'invalid body' WHERE id = ?", row.id);
      return;
    }
    try {
      await this.d.route(row, body);
    } catch (e) {
      this.d.log(`inbox ${row.ch}: routing ${row.type} ${row.id} failed (will retry): ${(e as Error).message}`);
      this.scheduleRetry();
      return;
    }
    this.d.sql.run("UPDATE messages SET routed = 1 WHERE id = ?", row.id);
    this.d.routed(row, body);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.rerouteUnrouted();
    }, this.d.retryMs ?? 30_000);
  }

  /** Route rows stored but never routed (crash between store and route, or a routing error). */
  async rerouteUnrouted(): Promise<void> {
    const rows = this.d.sql.all<StoredMessage>(
      "SELECT id, ch, seq, from_id, ts, type, body FROM messages WHERE routed = 0 AND mine = 0 ORDER BY ch, seq, rowid",
    );
    const work: Promise<void>[] = [];
    for (const row of rows) {
      if (!this.d.channelInfo(row.ch)) {
        this.d.sql.run("UPDATE messages SET routed = 1 WHERE id = ?", row.id);
        continue;
      }
      work.push(
        this.enqueueWork(row.ch, async () => {
          const cur = this.d.sql.get<{ routed: number }>("SELECT routed FROM messages WHERE id = ?", row.id);
          if (cur && !cur.routed) await this.routeOne(row);
        }),
      );
    }
    await Promise.all(work);
  }

  /** Wait for in-flight processing (used on stop). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.idle();
  }
}
