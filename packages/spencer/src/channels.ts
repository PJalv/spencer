import { createHash } from "node:crypto";
import {
  AGENT_VERSION,
  DIRECT_MAX_MEMBERS,
  GROUP_MAX_MEMBERS,
  deriveChannelKeys,
  fingerprint,
  formatInvite,
  normalizeRelayUrl,
  joinProof,
  newChannelSecret,
  openMeta,
  parseInvite,
  sealMeta,
  type ChannelKeys,
  type CrocInfo,
  type HelloBody,
  type Identity,
  type MemberInfo,
  convoRef,
} from "@spencer/protocol";
import type { Sql } from "./store/db.ts";
import type { SpencerConfig } from "./config.ts";
import type { Channel, ChannelMember, ChannelMessage, EventSink, Presence, PeerBio, PeerSummary } from "./contracts.ts";
import type { Outbox, ChannelKeyInfo } from "./net/outbox.ts";
import { RelayError, type RelayConnection, type RelayPool } from "./net/relay-client.ts";

export interface ChannelRow {
  id: string;
  kind: "direct" | "group";
  /** "chat", or "conversation" for a Conversations channel (groups only). */
  mode: string;
  meta_name: string;
  custom_name: string | null;
  created_by: string;
  relay_url: string;
  secret: string;
  last_seq: number;
  auto_reply: number;
  allowed_mcp_tools: string;
  trust: string;
  last_hello_members: string;
  last_hello_features: string;
  share_bio: number;
  last_hello_about: string | null;
  last_hello_name: string;
  direct_link: string;
  allow_local_addresses: number;
  heated: number;
  unread: number;
  gap: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  ch: string;
  seq: number | null;
  from_id: string;
  ts: number;
  type: string;
  body: string;
  mine: number;
  status: string;
  origin: string | null;
  note: string | null;
}

/** Error with an HTTP status hint for the API layer. */
export class UserError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = "UserError";
    this.status = status;
  }
}

export interface ChannelManagerDeps {
  memoirLeave?: (ch: string) => void;
  bioText?: () => string;
  bioChanged?: () => void;
  localFeatures?: () => string[];
  sql: Sql;
  me: Identity;
  config: () => SpencerConfig;
  pool: () => RelayPool;
  outbox: () => Outbox;
  events: EventSink;
  log: (m: string) => void;
  /** Fire-and-forget notification to the agent layer. */
  channelChanged(ch: string): void;
}

const MAX_NAME = 200;

/** Channel lifecycle, membership, hello logic and channel/message views. */
export class ChannelManager {
  private d: ChannelManagerDeps;
  private keyCache = new Map<string, ChannelKeys>();
  private stunByRelay = new Map<string, string>();
  setStun(url: string, stun: string | undefined): void { if (stun) this.stunByRelay.set(url, stun); else this.stunByRelay.delete(url); }
  stunFor(ch: string): string | undefined { const r = this.row(ch); return r ? this.stunByRelay.get(r.relay_url) : undefined; }
  peerFeatures(ch: string, peerId: string): string[] { return safeJsonArray(this.memberRows(ch).find(m => m.id === peerId)?.features ?? "[]"); }
  peerHasFeature(ch: string, peerId: string, feature: string): boolean { return this.peerFeatures(ch, peerId).includes(feature); }
  directLinkConfig(ch: string): { directLink: "auto" | "off"; allowLocalAddresses: boolean } | undefined { const r = this.row(ch); return r ? { directLink: r.direct_link === "off" ? "off" : "auto", allowLocalAddresses: !!r.allow_local_addresses } : undefined; }
  private crocByRelay = new Map<string, CrocInfo>();
  /** relay URL → identity id → what that relay last said about it (only relays with the "presence" feature). */
  private presence = new Map<string, Map<string, { online: boolean; lastSeen?: number }>>();

  constructor(deps: ChannelManagerDeps) {
    this.d = deps;
  }

  // ------------------------------------------------------------- rows & keys

  row(ch: string): ChannelRow | undefined {
    return this.d.sql.get<ChannelRow>("SELECT * FROM channels WHERE id = ?", ch);
  }

  rows(): ChannelRow[] {
    return this.d.sql.all<ChannelRow>("SELECT * FROM channels ORDER BY created_at, rowid");
  }

  keys(ch: string): ChannelKeys | undefined {
    let k = this.keyCache.get(ch);
    if (!k) {
      const r = this.row(ch);
      if (!r) return undefined;
      k = deriveChannelKeys(r.secret, ch);
      this.keyCache.set(ch, k);
    }
    return k;
  }

  info(ch: string): ChannelKeyInfo | undefined {
    const r = this.d.sql.get<{ relay_url: string }>("SELECT relay_url FROM channels WHERE id = ?", ch);
    if (!r) return undefined;
    const k = this.keys(ch);
    return k ? { encKey: k.encKey, relayUrl: r.relay_url } : undefined;
  }

  relayUrls(): string[] {
    return this.d.sql.all<{ relay_url: string }>("SELECT DISTINCT relay_url FROM channels").map((r) => r.relay_url);
  }

  channelsOnRelay(url: string): string[] {
    return this.d.sql.all<{ id: string }>("SELECT id FROM channels WHERE relay_url = ?", url).map((r) => r.id);
  }

  setCroc(relayUrl: string, croc: unknown): void {
    if (croc && typeof croc === "object" && typeof (croc as CrocInfo).relay === "string" && typeof (croc as CrocInfo).pass === "string") {
      this.crocByRelay.set(relayUrl, { relay: (croc as CrocInfo).relay, pass: (croc as CrocInfo).pass });
    }
  }

  crocFor(ch: string): CrocInfo | undefined {
    const r = this.row(ch);
    if (!r) return undefined;
    return this.crocByRelay.get(r.relay_url) ?? this.d.pool().peek(r.relay_url)?.croc;
  }

  // ------------------------------------------------------------- views

  memberRows(ch: string): { id: string; name: string | null; about: string | null; about_at: number | null; agent: string | null; present: number; features: string }[] {
    return this.d.sql.all("SELECT id, name, about, about_at, agent, present, features FROM members WHERE ch = ? ORDER BY joined_at, rowid", ch);
  }

  peers(ch: string): string[] {
    return this.d.sql
      .all<{ id: string }>("SELECT id FROM members WHERE ch = ? AND present = 1 AND id != ?", ch, this.d.me.id)
      .map((r) => r.id);
  }

  peerName(ch: string, id: string): string | undefined {
    if (id === this.d.me.id) return this.d.config().name;
    return this.d.sql.get<{ name: string | null }>("SELECT name FROM members WHERE ch = ? AND id = ?", ch, id)?.name ?? undefined;
  }

  displayName(r: ChannelRow): string {
    if (r.custom_name) return r.custom_name;
    if (r.kind === "group") return r.meta_name;
    const peer = this.d.sql.get<{ id: string; name: string | null }>(
      "SELECT id, name FROM members WHERE ch = ? AND id != ? ORDER BY present DESC, joined_at LIMIT 1",
      r.id,
      this.d.me.id,
    );
    if (peer?.name) return peer.name;
    // The meta name is the creator's label for the invitee; for the invitee it would be their own name.
    if (r.created_by === this.d.me.id) return r.meta_name;
    return `Spencer ${fingerprint(r.created_by).slice(0, 9)}`;
  }

  // ------------------------------------------------------------- presence

  /** A member's presence as the API shows it (PROTOCOL §8). */
  presenceOf(relayUrl: string, id: string): { presence: Presence; lastSeen?: number } {
    const connected = this.d.pool().isConnected(relayUrl);
    if (id === this.d.me.id) return { presence: connected ? "online" : "offline" };
    const p = connected ? this.presence.get(relayUrl)?.get(id) : undefined;
    if (!p) return { presence: "unknown" };
    return { presence: p.online ? "online" : "offline", ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}) };
  }

  /** Presence fields of a member list from the relay (sub/join/create/members replies). Returns whether any changed. */
  notePresence(relayUrl: string, members: MemberInfo[] | undefined): boolean {
    let changed = false;
    for (const m of Array.isArray(members) ? members : []) {
      if (!m || typeof m.id !== "string" || typeof m.online !== "boolean") continue;
      const lastSeen = Number.isSafeInteger(m.lastSeen) ? m.lastSeen : undefined;
      if (this.setPresence(relayUrl, m.id, m.online, lastSeen)) changed = true;
    }
    return changed;
  }

  private setPresence(relayUrl: string, id: string, online: boolean, lastSeen: number | undefined): boolean {
    let byId = this.presence.get(relayUrl);
    if (!byId) this.presence.set(relayUrl, (byId = new Map()));
    const prev = byId.get(id);
    if (prev && prev.online === online && prev.lastSeen === lastSeen) return false;
    byId.set(id, { online, ...(lastSeen !== undefined ? { lastSeen } : {}) });
    return true;
  }

  /** A `presence` frame from the relay at `relayUrl`. */
  onPresence(relayUrl: string, ch: string, id: unknown, online: unknown, lastSeen: unknown): void {
    if (typeof id !== "string" || typeof online !== "boolean") return;
    const r = this.row(ch);
    if (!r || r.relay_url !== relayUrl) return;
    if (!this.setPresence(relayUrl, id, online, Number.isSafeInteger(lastSeen) ? (lastSeen as number) : undefined)) return;
    const p = this.presenceOf(relayUrl, id);
    this.d.events.emit({ type: "presence", ch, id, ...p });
  }

  /** Our connection to `relayUrl` went up or down: every member's presence there changes (to unknown, or fresh). */
  relayChanged(relayUrl: string, connected: boolean): void {
    if (!connected) this.presence.delete(relayUrl);
    for (const ch of this.channelsOnRelay(relayUrl)) this.emitChannel(ch);
  }

  toApi(r: ChannelRow): Channel {
    const me = this.d.me.id;
    const members: ChannelMember[] = this.memberRows(r.id)
      .filter((m) => m.present)
      .map((m) => ({
        id: m.id,
        features: safeJsonArray(m.features),
        ...(m.id === me ? { name: this.d.config().name } : m.name ? { name: m.name } : {}),
        fingerprint: fingerprint(m.id),
        me: m.id === me,
        ...this.presenceOf(r.relay_url, m.id),
      }));
    return {
      id: r.id,
      shareBio: !!r.share_bio,
      kind: r.kind,
      mode: r.kind === "group" && r.mode === "conversation" ? "conversation" : "chat",
      name: this.displayName(r),
      relayUrl: r.relay_url,
      members,
      directLink: r.direct_link === "off" ? "off" : "auto",
      allowLocalAddresses: !!r.allow_local_addresses,
      autoReply: !!r.auto_reply,
      ...(r.kind === "group" && r.mode === "conversation" ? { heated: !!r.heated } : {}),
      allowedMcpTools: safeJsonArray(r.allowed_mcp_tools),
      trust: r.trust === "full" ? "full" : "standard",
      unread: r.unread,
      lastSeq: r.last_seq,
      createdAt: r.created_at,
    };
  }

  list(): Channel[] {
    return this.rows().map((r) => this.toApi(r));
  }

  get(ch: string): Channel | undefined {
    const r = this.row(ch);
    return r ? this.toApi(r) : undefined;
  }

  emitChannel(ch: string): void {
    const c = this.get(ch);
    if (c) this.d.events.emit({ type: "channel", channel: c });
  }

  toMessage(r: MessageRow): ChannelMessage {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.body) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    const m: ChannelMessage = {
      id: r.id,
      ch: r.ch,
      from: r.from_id,
      mine: !!r.mine,
      ts: r.ts,
      type: r.type,
      status: r.status as ChannelMessage["status"],
    };
    const name = this.peerName(r.ch, r.from_id);
    if (name) m.fromName = name;
    if (r.seq !== null) m.seq = r.seq;
    if (typeof body.text === "string") m.text = body.text;
    if (typeof body.hop === "number") m.hop = body.hop;
    if (body.by === "human" || body.by === "agent") m.by = body.by;
    if (typeof body.replyTo === "string") m.replyTo = body.replyTo;
    if (Array.isArray(body.mentions)) m.mentions = body.mentions as string[];
    if (body.final === true) m.final = true;
    const convo = body.convo as Record<string, unknown> | undefined;
    if (convo && typeof convo.id === "string") m.convo = convoRef(convo);
    if (r.note) m.note = r.note;
    if (r.origin) m.origin = r.origin as ChannelMessage["origin"];
    return m;
  }

  message(id: string): ChannelMessage | undefined {
    const r = this.d.sql.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
    return r ? this.toMessage(r) : undefined;
  }

  /**
   * Messages, oldest first: the latest `limit` (optionally before message `before`).
   * `types`: which body types to include (default chat only; the UI also shows hellos).
   */
  messages(ch: string, limit: number, before?: string, types: string[] = ["chat"]): ChannelMessage[] {
    const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    const typeIn = `type IN (${types.map(() => "?").join(", ")})`;
    let rows: MessageRow[];
    if (before) {
      const b = this.d.sql.get<{ rowid: number }>("SELECT rowid FROM messages WHERE id = ? AND ch = ?", before, ch);
      if (!b) throw new UserError(404, "unknown message");
      rows = this.d.sql.all<MessageRow>(
        `SELECT * FROM messages WHERE ch = ? AND COALESCE(origin, '') != 'feature-hello' AND ${typeIn} AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
        ch,
        ...types,
        b.rowid,
        lim,
      );
    } else {
      rows = this.d.sql.all<MessageRow>(`SELECT * FROM messages WHERE ch = ? AND COALESCE(origin, '') != 'feature-hello' AND ${typeIn} ORDER BY rowid DESC LIMIT ?`, ch, ...types, lim);
    }
    return rows.reverse().map((r) => this.toMessage(r));
  }

  markRead(ch: string): void {
    const r = this.d.sql.run("UPDATE channels SET unread = 0 WHERE id = ? AND unread != 0", ch);
    if (r.changes > 0) this.emitChannel(ch);
  }

  // ------------------------------------------------------------- membership & hello

  /**
   * Merge a member list from the relay. `full`: the list is the complete membership (create/join/sub/
   * members replies), so absent ids are marked as gone. Sends a hello when a new id shows up.
   */
  mergeMembers(ch: string, members: MemberInfo[], full: boolean): void {
    const { sql } = this.d;
    const valid = (Array.isArray(members) ? members : []).filter((m) => m && typeof m.id === "string");
    let changed = false;
    sql.tx(() => {
      if (!this.row(ch)) return;
      for (const m of valid) {
        const r = sql.run(
          `INSERT INTO members (ch, id, joined_at, present) VALUES (?, ?, ?, 1)
           ON CONFLICT (ch, id) DO UPDATE SET present = 1, joined_at = coalesce(members.joined_at, excluded.joined_at)
           WHERE members.present = 0 OR members.joined_at IS NULL`,
          ch,
          m.id,
          Number.isSafeInteger(m.joinedAt) ? m.joinedAt : Date.now(),
        );
        if (r.changes > 0) changed = true;
      }
      if (full) {
        const ids = new Set(valid.map((m) => m.id));
        for (const m of this.memberRows(ch)) {
          if (m.present && !ids.has(m.id)) {
            sql.run("UPDATE members SET present = 0 WHERE ch = ? AND id = ?", ch, m.id);
            changed = true;
          }
        }
      }
      this.maybeHello(ch);
    });
    if (changed) {
      this.emitChannel(ch);
      this.d.channelChanged(ch);
    }
  }

  onMemberEvent(ch: string, id: string, event: string): void {
    if (typeof id !== "string") return;
    if (event === "joined") {
      this.mergeMembers(ch, [{ id, joinedAt: Date.now() }], false);
    } else if (event === "left") {
      const r = this.d.sql.run("UPDATE members SET present = 0 WHERE ch = ? AND id = ? AND present = 1", ch, id);
      if (r.changes > 0) {
        this.emitChannel(ch);
        this.d.channelChanged(ch);
      }
    }
  }

  /** Enqueue a hello when a present member was not greeted yet, or our features, bio or name changed since the last one. */
  private maybeHello(ch: string): void {
    const r = this.row(ch);
    if (!r) return;
    const me = this.d.me.id;
    const present = this.memberRows(ch)
      .filter((m) => m.present && m.id !== me)
      .map((m) => m.id);
    const greeted = new Set(safeJsonArray(r.last_hello_members));
    const newcomer = present.some((id) => !greeted.has(id));
    const next = JSON.stringify([...present].sort());
    const hello = this.buildHello(ch);
    const aboutHash = createHash("sha256").update(hello.about ?? "").digest("hex");
    const prevAboutHash = r.last_hello_about ?? createHash("sha256").update("").digest("hex");
    const feats = hello.features ?? [];
    const featsJson = JSON.stringify(feats);
    const changed = present.length > 0 && (featsJson !== r.last_hello_features || aboutHash !== prevAboutHash || hello.name !== r.last_hello_name);
    if (!newcomer && !changed) {
      if (next !== r.last_hello_members && present.length < greeted.size) {
        // Someone left: shrink the set so a rejoin gets a fresh hello.
        this.d.sql.run("UPDATE channels SET last_hello_members = ? WHERE id = ?", next, ch);
      }
      return;
    }
    this.d.outbox().enqueue(ch, hello, newcomer ? {} : { origin: "feature-hello" });
    this.d.sql.run(
      "UPDATE channels SET last_hello_members = ?, last_hello_features = ?, last_hello_about = ?, last_hello_name = ? WHERE id = ?",
      next, featsJson, aboutHash, hello.name, ch,
    );
  }

  buildHello(ch: string): HelloBody {
    const feats = [...new Set(this.d.localFeatures?.() ?? [])].sort();
    let about = "";
    if (this.row(ch)?.share_bio) {
      try { about = this.d.bioText?.() ?? ""; } catch { about = ""; }
    }
    return { type: "hello", name: this.d.config().name, agent: AGENT_VERSION,
      ...(feats.length ? { features: feats } : {}), ...(about ? { about } : {}) };
  }

  private stopped = false;
  private helloTimers = new Set<ReturnType<typeof setTimeout>>();
  stop(): void {
    this.stopped = true;
    for (const timer of this.helloTimers) clearTimeout(timer);
    this.helloTimers.clear();
    for (const state of this.bioRefresh.values()) if (state.timer) clearTimeout(state.timer);
    this.bioRefresh.clear();
  }

  recheckHellos(): void {
    if (this.stopped) return;
    const rows = this.rows();
    rows.forEach((r, i) => {
      if (rows.length <= 15 || i === 0) {
        try { this.maybeHello(r.id); } catch (e) { this.d.log(`recheckHello ${r.id}: ${(e as Error).message}`); }
      } else {
        const timer = setTimeout(() => {
          this.helloTimers.delete(timer);
          if (this.stopped) return;
          try { this.maybeHello(r.id); } catch (e) { this.d.log(`recheckHello ${r.id}: ${(e as Error).message}`); }
        }, i * 150);
        timer.unref(); this.helloTimers.add(timer);
      }
    });
  }

  peerBios(ch: string): PeerBio[] {
    return this.memberRows(ch).filter(m => m.present && m.id !== this.d.me.id)
      .map(m => ({ id: m.id, name: m.name, about: m.about, aboutAt: m.about_at }));
  }

  listPeerDirectory(): PeerSummary[] {
    const peers = new Map<string, PeerSummary>();
    for (const ch of this.list()) for (const row of this.peerBios(ch.id)) {
      let peer = peers.get(row.id);
      if (!peer) {
        peer = { ...row, active: true, hasRules: false, noteCount: 0, unseenNotes: 0, fingerprint: fingerprint(row.id), channels: [] };
        peers.set(row.id, peer);
      } else {
        if (row.about !== null && (peer.about === null || (row.aboutAt ?? 0) > (peer.aboutAt ?? 0))) {
          peer.about = row.about;
          peer.aboutAt = row.aboutAt;
          if (row.name) peer.name = row.name;
        } else if (peer.about === null && (row.aboutAt ?? 0) > (peer.aboutAt ?? 0)) {
          peer.aboutAt = row.aboutAt;
          if (row.name) peer.name = row.name;
        } else if (!peer.name && row.name) {
          peer.name = row.name;
        }
      }
      peer.channels.push({ id: ch.id, name: ch.name, kind: ch.kind, about: row.about, aboutAt: row.aboutAt });
    }
    return [...peers.values()];
  }

  private bioRefresh = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>();
  private refreshPeerBio(ch: string, id: string): void {
    if (this.stopped) return;
    const key = `${ch}:${id}`;
    const state = this.bioRefresh.get(key);
    const now = Date.now();
    if (!state || now - state.at >= 120_000) {
      if (state?.timer) clearTimeout(state.timer);
      this.bioRefresh.set(key, { at: now });
      this.d.channelChanged(ch);
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        this.bioRefresh.delete(key);
        if (!this.stopped && this.row(ch)) this.refreshPeerBio(ch, id);
      }, 120_000 - (now - state.at));
      state.timer.unref();
    }
  }

  /** A hello from a peer: update its self-asserted name/about. */
  onHello(ch: string, from: string, body: HelloBody): { featureOnly: boolean } {
    const previous = this.memberRows(ch).find(m => m.id === from);
    const name = body.name.trim().slice(0, MAX_NAME) || null;
    const about = body.about ?? null;
    const prevAbout = previous?.about ?? null;
    const aboutChanged = previous ? prevAbout !== about : about !== null;
    const aboutAt = aboutChanged ? Date.now() : (previous?.about_at ?? null);
    const nameChanged = !previous || previous.name !== name;
    const r = this.d.sql.run(
      `INSERT INTO members (ch, id, name, about, agent, present, joined_at, features, about_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (ch, id) DO UPDATE SET name = excluded.name, about = excluded.about, agent = excluded.agent, features = excluded.features, about_at = excluded.about_at`,
      ch,
      from,
      name,
      body.about ?? null,
      body.agent,
      Date.now(),
      JSON.stringify(body.features ?? []),
      aboutAt,
    );
    if (r.changes > 0) {
      this.emitChannel(ch);
      if (aboutChanged) this.d.events.emit({ type: "peer_bio", ch, id: from, about, aboutAt });
      if (nameChanged) {
        const key = `${ch}:${from}`;
        const prev = this.bioRefresh.get(key);
        if (prev?.timer) clearTimeout(prev.timer);
        if (aboutChanged) this.bioRefresh.set(key, { at: Date.now() });
        else this.bioRefresh.delete(key);
        this.d.channelChanged(ch);
      } else if (aboutChanged) {
        this.refreshPeerBio(ch, from);
      }
    }
    return { featureOnly: !!previous && previous.agent !== null && previous.name === name };
  }

  // ------------------------------------------------------------- relay sync

  /** sub {ch, since:last_seq}; merges members; records gaps; acks the stored cursor. */
  async subscribe(conn: RelayConnection, ch: string): Promise<void> {
    const r = this.row(ch);
    if (!r) return;
    const since = r.last_seq;
    let ok: Record<string, unknown>;
    try {
      ok = await conn.request({ t: "sub", ch, since });
    } catch (e) {
      const code = (e as RelayError).code;
      if (code === "not_member" || code === "no_channel") this.d.log(`channel ${ch}: relay says ${code}; we are no longer a member`);
      else if (code !== "disconnected" && code !== "closed") this.d.log(`channel ${ch}: sub failed: ${(e as Error).message}`);
      return;
    }
    const head = Number(ok.head);
    const first = Number(ok.first);
    if (Number.isSafeInteger(first) && Number.isSafeInteger(head) && head > since && first > since + 1) {
      this.d.log(`channel ${ch}: messages ${since + 1}..${first - 1} expired on the relay before we got them`);
      this.d.sql.run("UPDATE channels SET gap = 1 WHERE id = ?", ch);
    }
    const presenceChanged = this.notePresence(conn.url, ok.members as MemberInfo[]);
    this.mergeMembers(ch, ok.members as MemberInfo[], true);
    if (presenceChanged) this.emitChannel(ch);
    if (since > 0) conn.send({ t: "ack", ch, seq: since });
  }

  private async readyConn(url: string): Promise<RelayConnection> {
    const conn = this.d.pool().get(url);
    await conn.whenReady();
    return conn;
  }

  // ------------------------------------------------------------- lifecycle

  /** `kind: "conversation"`: a group in Conversations mode (the relay sees a plain group). */
  async createInvite(requested: "direct" | "group" | "conversation", name: string, relay?: string): Promise<{ link: string; channel: Channel }> {
    if (requested !== "direct" && requested !== "group" && requested !== "conversation") {
      throw new UserError(400, "kind must be direct, group or conversation");
    }
    if (requested === "conversation" && !this.d.config().experimental) {
      throw new UserError(403, "Conversations channels are experimental: turn on Experimental in settings first");
    }
    const kind = requested === "direct" ? "direct" : "group";
    const mode = requested === "conversation" ? "conversation" : "chat";
    const label = typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";
    if (!label) throw new UserError(400, "name is required");
    let relayUrl = this.d.config().relay;
    if (relay?.trim()) { try { relayUrl = normalizeRelayUrl(relay); } catch { throw new UserError(400, "invalid relay URL"); } }
    const { ch, secret } = newChannelSecret();
    const keys = deriveChannelKeys(secret, ch);
    const me = this.d.me.id;
    const meta = sealMeta(keys, ch, { name: label, kind, createdBy: me, ...(mode === "conversation" ? { mode } : {}) });
    const conn = await this.readyConn(relayUrl);
    const nonce = conn.nonce;
    if (!nonce) throw new RelayError("disconnected", "relay connection lost");
    const ok = await conn.request({
      t: "create",
      ch,
      kind,
      maxMembers: kind === "direct" ? DIRECT_MAX_MEMBERS : GROUP_MAX_MEMBERS,
      capPub: keys.capPub,
      meta,
      proof: joinProof(keys, ch, me, nonce),
    });
    this.setCroc(relayUrl, ok.croc);
    const head = Number.isSafeInteger(ok.head) ? (ok.head as number) : 0;
    this.d.sql.run(
      `INSERT INTO channels (id, kind, mode, meta_name, created_by, relay_url, secret, last_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ch,
      kind,
      mode,
      label,
      me,
      relayUrl,
      secret,
      head,
      Date.now(),
    );
    this.keyCache.set(ch, keys);
    this.notePresence(relayUrl, ok.members as MemberInfo[]);
    this.mergeMembers(ch, (ok.members as MemberInfo[]) ?? [{ id: me, joinedAt: Date.now() }], true);
    await this.subscribe(conn, ch);
    this.emitChannel(ch);
    this.d.channelChanged(ch);
    return { link: formatInvite(relayUrl, ch, secret), channel: this.get(ch)! };
  }

  async acceptInvite(link: string): Promise<Channel> {
    if (typeof link !== "string") throw new UserError(400, "link is required");
    let inv: ReturnType<typeof parseInvite>;
    try {
      inv = parseInvite(link);
    } catch (e) {
      throw new UserError(400, (e as Error).message);
    }
    const existing = this.get(inv.ch);
    if (existing) return existing;
    const keys = deriveChannelKeys(inv.secret, inv.ch);
    const me = this.d.me.id;
    let ok: Record<string, unknown>;
    try {
      const conn = await this.readyConn(inv.relayUrl);
      const nonce = conn.nonce;
      if (!nonce) throw new RelayError("disconnected", "relay connection lost");
      ok = await conn.request({ t: "join", ch: inv.ch, proof: joinProof(keys, inv.ch, me, nonce) });
    } catch (e) {
      void this.pruneRelays();
      const code = (e as RelayError).code;
      if (code === "full") throw new UserError(409, "this invite has already been used (channel is full)");
      if (code === "bad_proof") throw new UserError(400, "invalid invite (secret does not match)");
      if (code === "no_channel") throw new UserError(404, "this invite's channel does not exist on the relay");
      throw e;
    }
    let meta;
    try {
      meta = openMeta(keys, inv.ch, String(ok.meta));
    } catch {
      throw new UserError(400, "invalid invite (cannot decrypt channel metadata)");
    }
    const kind = ok.kind === "group" || ok.kind === "direct" ? ok.kind : meta.kind;
    if (kind !== meta.kind) this.d.log(`channel ${inv.ch}: relay kind ${kind} differs from sealed kind ${meta.kind}`);
    this.setCroc(inv.relayUrl, ok.croc);
    const head = Number.isSafeInteger(ok.head) ? (ok.head as number) : 0;
    this.d.sql.run(
      `INSERT OR IGNORE INTO channels (id, kind, mode, meta_name, created_by, relay_url, secret, last_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      inv.ch,
      kind,
      kind === "group" && meta.mode === "conversation" ? "conversation" : "chat",
      meta.name,
      meta.createdBy,
      inv.relayUrl,
      inv.secret,
      head,
      Date.now(),
    );
    this.keyCache.set(inv.ch, keys);
    this.notePresence(inv.relayUrl, ok.members as MemberInfo[]);
    this.mergeMembers(inv.ch, (ok.members as MemberInfo[]) ?? [], true);
    const conn = this.d.pool().peek(inv.relayUrl);
    if (conn?.ready) await this.subscribe(conn, inv.ch);
    this.emitChannel(inv.ch);
    this.d.channelChanged(inv.ch);
    return this.get(inv.ch)!;
  }

  async leave(ch: string): Promise<void> {
    const r = this.row(ch);
    if (!r) throw new UserError(404, "unknown channel");
    const conn = this.d.pool().peek(r.relay_url);
    if (conn?.ready) {
      try {
        await conn.request({ t: "leave", ch });
      } catch (e) {
        this.d.log(`channel ${ch}: relay leave failed: ${(e as Error).message}`);
      }
    } else {
      this.d.log(`channel ${ch}: relay not connected; leaving locally only`);
    }
    this.d.memoirLeave?.(ch);
    this.d.sql.tx(() => {
      this.d.sql.run("DELETE FROM outbox WHERE ch = ? AND state = 'pending'", ch);
      this.d.sql.run("DELETE FROM messages WHERE ch = ?", ch);
      this.d.sql.run("DELETE FROM members WHERE ch = ?", ch);
      this.d.sql.run("DELETE FROM channels WHERE id = ?", ch);
    });
    this.keyCache.delete(ch);
    this.d.events.emit({ type: "channel_removed", ch });
    this.d.channelChanged(ch);
    void this.pruneRelays();
  }

  update(ch: string, patch: { shareBio?: unknown; name?: unknown; autoReply?: unknown; allowedMcpTools?: unknown; trust?: unknown; directLink?: unknown; allowLocalAddresses?: unknown; heated?: unknown }): Channel {
    const r = this.row(ch);
    if (!r) throw new UserError(404, "unknown channel");
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      if (patch.name !== null && typeof patch.name !== "string") throw new UserError(400, "name must be a string");
      const n = typeof patch.name === "string" ? patch.name.trim().slice(0, MAX_NAME) : "";
      sets.push("custom_name = ?");
      args.push(n || null);
    }
    if (patch.shareBio !== undefined) {
      if (typeof patch.shareBio !== "boolean") throw new UserError(400, "shareBio must be a boolean");
      sets.push("share_bio = ?"); args.push(patch.shareBio ? 1 : 0);
    }
    if (patch.autoReply !== undefined) {
      if (typeof patch.autoReply !== "boolean") throw new UserError(400, "autoReply must be a boolean");
      sets.push("auto_reply = ?");
      args.push(patch.autoReply ? 1 : 0);
    }
    if (patch.heated !== undefined) {
      if (typeof patch.heated !== "boolean") throw new UserError(400, "heated must be a boolean");
      if (r.mode !== "conversation") throw new UserError(400, "heated mode is only for Conversations channels");
      sets.push("heated = ?");
      args.push(patch.heated ? 1 : 0);
    }
    if (patch.allowedMcpTools !== undefined) {
      const t = patch.allowedMcpTools;
      if (!Array.isArray(t) || t.length > 500 || !t.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) {
        throw new UserError(400, "allowedMcpTools must be an array of tool names");
      }
      sets.push("allowed_mcp_tools = ?");
      args.push(JSON.stringify([...new Set(t as string[])]));
    }
    if (patch.trust !== undefined) {
      if (patch.trust !== "standard" && patch.trust !== "full") throw new UserError(400, 'trust must be "standard" or "full"');
      sets.push("trust = ?");
      args.push(patch.trust);
    }
    if (patch.directLink !== undefined) { if (patch.directLink !== "auto" && patch.directLink !== "off") throw new UserError(400, "invalid directLink"); sets.push("direct_link = ?"); args.push(patch.directLink); }
    if (patch.allowLocalAddresses !== undefined) { if (typeof patch.allowLocalAddresses !== "boolean") throw new UserError(400, "invalid allowLocalAddresses"); sets.push("allow_local_addresses = ?"); args.push(patch.allowLocalAddresses ? 1 : 0); }
    if (sets.length > 0) {
      this.d.sql.run(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`, ...args, ch);
      this.emitChannel(ch);
      this.d.channelChanged(ch);
    }
    if (patch.shareBio !== undefined && Number(patch.shareBio) !== r.share_bio) {
      this.maybeHello(ch);
      this.d.bioChanged?.();
    }
    return this.get(ch)!;
  }

  /** Close relay connections that no channel (and not the default relay) needs anymore. */
  async pruneRelays(): Promise<void> {
    const keep = new Set(this.relayUrls());
    keep.add(this.d.config().relay);
    await this.d.pool().prune(keep);
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
