import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Core schema. Other parts (transfers, agent) create their own tables in the same file with
 * `CREATE TABLE IF NOT EXISTS`; they must not use PRAGMA user_version, which belongs to the core.
 */
const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct','group')),
    meta_name TEXT NOT NULL,
    custom_name TEXT,
    created_by TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    secret TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    auto_reply INTEGER NOT NULL DEFAULT 1,
    allowed_mcp_tools TEXT NOT NULL DEFAULT '[]',
    last_hello_members TEXT NOT NULL DEFAULT '[]',
    unread INTEGER NOT NULL DEFAULT 0,
    gap INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    ch TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT,
    about TEXT,
    agent TEXT,
    present INTEGER NOT NULL DEFAULT 1,
    joined_at INTEGER,
    PRIMARY KEY (ch, id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    ch TEXT NOT NULL,
    seq INTEGER,
    from_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    mine INTEGER NOT NULL,
    status TEXT NOT NULL,
    origin TEXT,
    note TEXT,
    routed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_ch_created ON messages (ch, created_at);
  CREATE INDEX messages_unrouted ON messages (routed) WHERE routed = 0;
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    ch TEXT NOT NULL,
    env TEXT NOT NULL,
    type TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending',
    seq INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX outbox_pending ON outbox (ch, state, created_at);
  `,
  // 2: per-channel trust level
  `ALTER TABLE channels ADD COLUMN trust TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE members ADD COLUMN features TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE channels ADD COLUMN last_hello_features TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE channels ADD COLUMN direct_link TEXT NOT NULL DEFAULT 'auto';
   ALTER TABLE channels ADD COLUMN allow_local_addresses INTEGER NOT NULL DEFAULT 0;`,
  // 4: Conversations channels (a group whose agents start debates on their own)
  `ALTER TABLE channels ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'`,
  // 5: Conversations channels: heated mode (spicy debates with a moderator)
  `ALTER TABLE channels ADD COLUMN heated INTEGER NOT NULL DEFAULT 0`,
  // 6: Public BIO sharing and peer bio timestamps
  `ALTER TABLE channels ADD COLUMN share_bio INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE channels ADD COLUMN last_hello_about TEXT;
   ALTER TABLE members ADD COLUMN about_at INTEGER;`,
  // 7: the name sent in our last hello, so a rename re-greets the channel
  `ALTER TABLE channels ADD COLUMN last_hello_name TEXT NOT NULL DEFAULT ''`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function dbPath(dataDir: string): string {
  return join(dataDir, "spencer.sqlite");
}

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = dbPath(dataDir);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      /* best effort (e.g. non-POSIX fs) */
    }
  }
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  if (v > MIGRATIONS.length) throw new Error(`database schema v${v} is newer than this Spencer (v${MIGRATIONS.length})`);
  while (v < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    v++;
  }
}

let spCounter = 0;
/**
 * Runs `fn` atomically. Uses SAVEPOINTs so it nests inside a caller's BEGIN…COMMIT or another tx().
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const name = `sp${++spCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* connection may be broken; rethrow original */
    }
    throw e;
  }
}

/** Prepared-statement cache for one database. */
export class Sql {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.stmt(sql).run(...args);
  }
  get<T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...args) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...args) as T[];
  }
  tx<T>(fn: () => T): T {
    return tx(this.db, fn);
  }
}
