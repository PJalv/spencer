import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fingerprint, isB64uId, truncateUtf16 } from "@spencer/protocol";
import type { Channel, EventSink, PeerSummary } from "./contracts.ts";
import { UserError } from "./channels.ts";

export const MAX_RULES_BYTES = 2048;
export type ScopeKind = "peer" | "channel";
export interface MemoirScope {
  kind: ScopeKind;
  id: string;
}
export interface MemoirNote {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  sourceCh: string | null;
  author: "owner" | "agent";
  trustAtWrite: "owner" | "standard" | "full" | null;
  askerId: string | null;
  text: string;
  pinned: boolean;
  seen: boolean;
  createdAt: number;
}
interface Deps {
  db: DatabaseSync;
  dataDir: string;
  peers(): PeerSummary[];
  channels(): Channel[];
  events: EventSink;
  refresh(ch: string): void;
}
const columns = `id, scope_kind AS scopeKind, scope_id AS scopeId, source_ch AS sourceCh, author,
 trust_at_write AS trustAtWrite, asker_id AS askerId, text, pinned, seen, created_at AS createdAt`;
function noteText(value: unknown): string {
  if (typeof value !== "string")
    throw new UserError(400, "text must be a string");
  const text = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (!text || text.length > 500)
    throw new UserError(400, "note must contain 1 to 500 characters");
  return text;
}
export class Memoir {
  private timers = new Map<
    string,
    { at: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private stopped = false;
  private d: Deps;
  constructor(d: Deps) {
    this.d = d;
    d.db.exec(`CREATE TABLE IF NOT EXISTS memoir_notes (
      id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL CHECK(scope_kind IN ('peer','channel')),
      scope_id TEXT NOT NULL, source_ch TEXT, author TEXT NOT NULL CHECK(author IN ('owner','agent')),
      trust_at_write TEXT CHECK(trust_at_write IN ('full','standard','owner')), asker_id TEXT,
      text TEXT NOT NULL CHECK(length(text) <= 500), pinned INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memoir_scope ON memoir_notes(scope_kind,scope_id,created_at);
      CREATE TABLE IF NOT EXISTS memoir_rate (scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, at INTEGER NOT NULL);`);
  }
  private file(s: MemoirScope): string {
    if (!isB64uId(s.id, s.kind === "peer" ? 32 : 16))
      throw new UserError(400, "invalid scope id");
    return join(
      this.d.dataDir,
      s.kind === "peer" ? "peers" : "channels",
      s.id,
      "RULES.md",
    );
  }
  readRules(s: MemoirScope): string {
    let fd: number | undefined;
    try {
      fd = openSync(this.file(s), "r");
      const buf = Buffer.alloc(MAX_RULES_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf
        .subarray(0, n)
        .toString("utf8")
        .replace(/\uFFFD+$/, "")
        .trim();
    } catch {
      return "";
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }
  private require(s: MemoirScope): void {
    const file = this.file(s);
    if (s.kind === "channel") {
      const ch = this.d.channels().find((c) => c.id === s.id);
      if (!ch) throw new UserError(404, "unknown channel");
      if (ch.kind !== "group" || ch.mode === "conversation")
        throw new UserError(400, "group chat required");
    } else if (
      !this.directory().some((p) => p.id === s.id) &&
      !existsSync(file)
    )
      throw new UserError(404, "unknown peer");
  }
  writeRules(s: MemoirScope, value: unknown): void {
    this.require(s);
    if (typeof value !== "string")
      throw new UserError(400, "text must be a string");
    const text = value.trim();
    if (Buffer.byteLength(text) > MAX_RULES_BYTES)
      throw new UserError(400, "RULES.md exceeds 2048 bytes");
    const file = this.file(s);
    if (!text) rmSync(file, { force: true });
    else {
      mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
        renameSync(temp, file);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    this.changed(s);
  }
  notes(s: MemoirScope): MemoirNote[] {
    this.file(s);
    return this.d.db
      .prepare(
        `SELECT ${columns} FROM memoir_notes WHERE scope_kind=? AND scope_id=? ORDER BY pinned DESC, created_at DESC, rowid DESC`,
      )
      .all(s.kind, s.id)
      .map(
        (r) =>
          ({
            ...r,
            pinned: !!r.pinned,
            seen: !!r.seen,
          }) as unknown as MemoirNote,
      );
  }
  prompt(s: MemoirScope): string {
    return truncateUtf16(
      this.notes(s)
        .map((n) => n.text)
        .join("\n"),
      2000,
    );
  }
  private tx<T>(fn: () => T): T {
    this.d.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.d.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.d.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw e;
    }
  }
  addOwnerNote(
    s: MemoirScope,
    text: unknown,
    pinned: unknown = false,
  ): MemoirNote {
    this.require(s);
    if (typeof pinned !== "boolean")
      throw new UserError(400, "pinned must be boolean");
    const clean = noteText(text);
    const note = this.tx(() =>
      this.insertRow(s, clean, "owner", null, "owner", null, pinned),
    );
    this.changed(s, false);
    return note;
  }
  recordAgentNote(
    s: MemoirScope,
    text: unknown,
    sourceCh: string,
    trust: "full" | "standard",
    asker?: string,
  ): MemoirNote {
    this.require(s);
    if (!isB64uId(sourceCh) || (asker !== undefined && !isB64uId(asker, 32)))
      throw new UserError(400, "invalid provenance");
    const clean = noteText(text);
    const { note, mutated } = this.tx(() => {
      const duplicate = this.notes(s).find(
        (n) =>
          n.text.normalize("NFKC").toLowerCase() ===
          clean.normalize("NFKC").toLowerCase(),
      );
      if (duplicate) {
        const evicted = this.evict(s);
        return { note: duplicate, mutated: evicted > 0 };
      }
      const now = Date.now();
      this.d.db
        .prepare("DELETE FROM memoir_rate WHERE at <= ?")
        .run(now - 600_000);
      const count = this.d.db
        .prepare(
          "SELECT count(*) AS n FROM memoir_rate WHERE scope_kind=? AND scope_id=?",
        )
        .get(s.kind, s.id)!;
      if (Number(count.n) >= 5)
        throw new UserError(429, "memoir note rate limit: 5 per 10 minutes");
      this.d.db
        .prepare("INSERT INTO memoir_rate VALUES (?,?,?)")
        .run(s.kind, s.id, now);
      return {
        note: this.insertRow(
          s,
          clean,
          "agent",
          sourceCh,
          trust,
          asker ?? null,
          false,
        ),
        mutated: true,
      };
    });
    if (mutated) this.changed(s, true);
    return note;
  }
  private insertRow(
    s: MemoirScope,
    text: string,
    author: "owner" | "agent",
    source: string | null,
    trust: string,
    asker: string | null,
    pinned: boolean,
  ): MemoirNote {
    const id = randomUUID();
    this.d.db
      .prepare("INSERT INTO memoir_notes VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        s.kind,
        s.id,
        source,
        author,
        trust,
        asker,
        text,
        Number(pinned),
        Number(author === "owner"),
        Date.now(),
      );
    this.evict(s);
    return this.notes(s).find((n) => n.id === id)!;
  }
  private evict(s: MemoirScope): number {
    const unpinned = this.notes(s).filter((n) => !n.pinned);
    let chars = unpinned.reduce((sum, n) => sum + n.text.length, 0);
    let removed = 0;
    while (unpinned.length > 20 || chars > 4000) {
      const oldest = unpinned.pop()!;
      chars -= oldest.text.length;
      this.d.db.prepare("DELETE FROM memoir_notes WHERE id=?").run(oldest.id);
      removed++;
    }
    return removed;
  }
  update(
    id: string,
    patch: { text?: unknown; pinned?: unknown; seen?: unknown },
  ): MemoirNote {
    const updated = this.tx(() => {
      const n = this.find(id);
      const text = patch.text === undefined ? n.text : noteText(patch.text);
      for (const k of ["pinned", "seen"] as const)
        if (patch[k] !== undefined && typeof patch[k] !== "boolean")
          throw new UserError(400, `${k} must be boolean`);
      this.d.db
        .prepare("UPDATE memoir_notes SET text=?,pinned=?,seen=? WHERE id=?")
        .run(
          text,
          Number(patch.pinned ?? n.pinned),
          Number(patch.seen ?? n.seen),
          id,
        );
      this.evict({ kind: n.scopeKind, id: n.scopeId });
      return {
        ...n,
        text,
        pinned: Boolean(patch.pinned ?? n.pinned),
        seen: Boolean(patch.seen ?? n.seen),
      };
    });
    this.changed({ kind: updated.scopeKind, id: updated.scopeId });
    return updated;
  }
  private find(id: string): MemoirNote {
    const r = this.d.db
      .prepare(`SELECT ${columns} FROM memoir_notes WHERE id=?`)
      .get(id);
    if (!r) throw new UserError(404, "unknown note");
    return {
      ...r,
      pinned: !!r.pinned,
      seen: !!r.seen,
    } as unknown as MemoirNote;
  }
  delete(id: string): void {
    const n = this.tx(() => {
      const found = this.find(id);
      this.d.db.prepare("DELETE FROM memoir_notes WHERE id=?").run(id);
      return found;
    });
    this.changed({ kind: n.scopeKind, id: n.scopeId });
  }
  markSeen(s: MemoirScope): void {
    this.require(s);
    this.d.db
      .prepare(
        "UPDATE memoir_notes SET seen=1 WHERE scope_kind=? AND scope_id=?",
      )
      .run(s.kind, s.id);
    this.d.events.emit({ type: "memoir", scopeKind: s.kind, scopeId: s.id });
  }
  directory(): PeerSummary[] {
    const peers = new Map(
      this.d.peers().map((p) => [p.id, { ...p, active: true }]),
    );
    const saved = new Set(
      this.d.db
        .prepare(
          "SELECT DISTINCT scope_id FROM memoir_notes WHERE scope_kind='peer'",
        )
        .all()
        .map((r) => String(r.scope_id)),
    );
    try {
      for (const id of readdirSync(join(this.d.dataDir, "peers")))
        if (isB64uId(id, 32) && existsSync(this.file({ kind: "peer", id })))
          saved.add(id);
    } catch {}
    for (const id of saved)
      if (!peers.has(id) && isB64uId(id, 32))
        peers.set(id, {
          id,
          name: null,
          about: null,
          aboutAt: null,
          fingerprint: fingerprint(id),
          channels: [],
          active: false,
          hasRules: false,
          noteCount: 0,
          unseenNotes: 0,
        });
    return [...peers.values()].map((p) => {
      const s = { kind: "peer", id: p.id } as const;
      const notes = this.notes(s);
      return {
        ...p,
        hasRules: !!this.readRules(s),
        noteCount: notes.length,
        unseenNotes: notes.filter((n) => !n.seen && n.author === "agent")
          .length,
      };
    });
  }
  profile(s: MemoirScope) {
    this.require(s);
    if (s.kind === "channel") {
      const ch = this.d.channels().find((c) => c.id === s.id)!;
      return {
        kind: s.kind,
        id: s.id,
        ch: s.id,
        name: ch.name,
        rules: this.readRules(s),
        maxRulesBytes: MAX_RULES_BYTES,
        notes: this.notes(s),
      };
    }
    const p = this.directory().find((p) => p.id === s.id)!;
    return {
      ...p,
      kind: s.kind,
      bio: p.about,
      bioAt: p.aboutAt,
      rules: this.readRules(s),
      maxRulesBytes: MAX_RULES_BYTES,
      notes: this.notes(s),
    };
  }
  resolve(target: string): MemoirScope {
    const peers = this.directory();
    const groups = this.d
      .channels()
      .filter((c) => c.kind === "group" && c.mode !== "conversation");
    const exact: MemoirScope[] = [
      ...peers
        .filter((p) => p.id === target || p.fingerprint === target)
        .map((p) => ({ kind: "peer" as const, id: p.id })),
      ...groups
        .filter((c) => c.id === target)
        .map((c) => ({ kind: "channel" as const, id: c.id })),
    ];
    const matches = exact.length
      ? exact
      : [
          ...peers
            .filter((p) => p.name?.toLowerCase() === target.toLowerCase())
            .map((p) => ({ kind: "peer" as const, id: p.id })),
          ...groups
            .filter((c) => c.name.toLowerCase() === target.toLowerCase())
            .map((c) => ({ kind: "channel" as const, id: c.id })),
        ];
    if (matches.length !== 1)
      throw new UserError(
        400,
        `No unique target; use an exact id or fingerprint. Candidates: ${matches.map((s) => (s.kind === "peer" ? fingerprint(s.id) : s.id)).join(", ") || "none"}`,
      );
    return matches[0]!;
  }
  removeChannel(id: string): void {
    rmSync(this.file({ kind: "channel", id }), { force: true });
    this.d.db
      .prepare(
        "DELETE FROM memoir_notes WHERE scope_kind='channel' AND scope_id=?",
      )
      .run(id);
    this.d.db
      .prepare(
        "DELETE FROM memoir_rate WHERE scope_kind='channel' AND scope_id=?",
      )
      .run(id);
  }
  private changed(s: MemoirScope, throttle = false): void {
    if (this.stopped) return;
    this.d.events.emit({ type: "memoir", scopeKind: s.kind, scopeId: s.id });
    const refresh = () => {
      for (const c of this.d.channels())
        if (
          c.mode !== "conversation" &&
          (s.kind === "channel"
            ? c.id === s.id
            : c.members.some((m) => !m.me && m.id === s.id))
        )
          this.d.refresh(c.id);
    };
    if (!throttle) {
      refresh();
      return;
    }
    const key = `${s.kind}:${s.id}`,
      now = Date.now(),
      state = this.timers.get(key);
    if (!state || now - state.at >= 120_000) {
      if (state?.timer) clearTimeout(state.timer);
      this.timers.set(key, { at: now });
      refresh();
    } else if (!state.timer) {
      state.timer = setTimeout(
        () => {
          this.timers.set(key, { at: Date.now() });
          refresh();
        },
        120_000 - (now - state.at),
      );
      state.timer.unref();
    }
  }
  stop(): void {
    this.stopped = true;
    for (const s of this.timers.values()) if (s.timer) clearTimeout(s.timer);
    this.timers.clear();
  }
}
