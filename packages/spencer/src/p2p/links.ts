import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DataChannel, PeerConnection } from "node-datachannel";
import { openLink, sealLink } from "@spencer/protocol";
import type { LinkBody } from "@spencer/protocol";
import { randomId } from "@spencer/protocol";
import { signText, verifyText, type Identity } from "@spencer/protocol";
import type { FileDataChannel } from "./file-stream.ts";
import { loadP2pAddon } from "./addon.ts";
import {
  extractDtlsFingerprint,
  filterIncomingSdp,
  filterOutgoingSdp,
  normalizeFingerprint,
} from "./sdp.ts";

export interface LinkChannelAuth {
  ok: boolean;
  allowLocalAddresses: boolean;
  stunServers: string[];
}
export interface LinkManagerTuning {
  gatherTimeoutMs?: number;
  dialTimeoutMs?: number;
  idleTimeoutMs?: number;
  offerRateLimitMs?: number;
  seenSidTtlMs?: number;
  crashDisableMs?: number;
  allowLoopback?: boolean;
  cleanupOnStop?: boolean;
  addonOverride?: string;
}
export interface LinkManagerDeps {
  dataDir: string;
  me: Identity;
  sendSignal(ch: string, body: LinkBody): void;
  pairKey(ch: string, peerId: string): Uint8Array;
  authorize(ch: string, peerId: string): LinkChannelAuth;
  onFileChannel(
    ch: string,
    peerId: string,
    label: string,
    dc: FileDataChannel,
  ): void;
  ownerNote(text: string, opts?: { untrusted?: boolean }): void;
  log(msg: string): void;
  now?: () => number;
  tuning?: LinkManagerTuning;
}
export interface ActiveLink {
  ch: string;
  peerId: string;
  sid: string;
  pc: PeerConnection;
  ctl: DataChannel | null;
}
type Setup = ActiveLink & {
  verified: boolean;
  remoteSet: boolean;
  closed: boolean;
  files: Set<DataChannel>;
  peerFiles: Set<DataChannel>;
  idle?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  finishGather?: () => void;
  resolve: (link: ActiveLink | null) => void;
  promise: Promise<ActiveLink | null>;
};
let managers = 0;
export class LinkManager {
  private links = new Map<string, Setup>();
  private setups = new Set<Setup>();
  private seen = new Map<string, number>();
  private rates = new Map<string, number>();
  private disabled = new Map<string, number>();
  private started = false;
  private addon: ReturnType<typeof loadP2pAddon>;
  private deps: LinkManagerDeps;
  constructor(deps: LinkManagerDeps) {
    this.deps = deps;
    this.addon = loadP2pAddon(deps.tuning?.addonOverride);
  }
  private get t() {
    return {
      gatherTimeoutMs: 3000,
      dialTimeoutMs: 10000,
      idleTimeoutMs: 60000,
      offerRateLimitMs: 10000,
      seenSidTtlMs: 3600000,
      crashDisableMs: 86400000,
      allowLoopback: false,
      cleanupOnStop: true,
      ...this.deps.tuning,
    };
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private key(ch: string, peer: string) {
    return `${ch}:${peer}`;
  }
  private attempt() {
    const path = join(this.deps.dataDir, "p2p-attempt");
    const first = [...this.setups][0];
    if (first)
      writeFileSync(path, JSON.stringify({ ch: first.ch, ts: this.now() }));
    else {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  start() {
    if (this.started) return;
    this.started = true;
    managers++;
    mkdirSync(this.deps.dataDir, { recursive: true });
    const disabled = join(this.deps.dataDir, "p2p-disabled.json");
    try {
      const obj = JSON.parse(readFileSync(disabled, "utf8"));
      for (const [ch, until] of Object.entries(obj))
        if (typeof until === "number" && until > this.now())
          this.disabled.set(ch, until);
    } catch {}
    const path = join(this.deps.dataDir, "p2p-attempt");
    try {
      const obj = JSON.parse(readFileSync(path, "utf8"));
      if (typeof obj.ch === "string") {
        this.disabled.set(obj.ch, this.now() + this.t.crashDisableMs);
        this.deps.ownerNote(
          `Direct links were disabled for channel ${obj.ch} for 24 hours because Spencer died during a link attempt.`,
          { untrusted: true },
        );
      }
    } catch {}
    try {
      unlinkSync(path);
    } catch {}
    this.persistDisabled();
  }
  isCrashDisabled(ch: string) {
    return (this.disabled.get(ch) ?? 0) > this.now();
  }
  private persistDisabled() {
    const path = join(this.deps.dataDir, "p2p-disabled.json");
    writeFileSync(path + ".tmp", JSON.stringify(this.crashDisabledChannels()), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  clearCrashDisable(ch?: string) {
    if (ch) this.disabled.delete(ch); else this.disabled.clear();
    this.persistDisabled();
  }
  crashDisabledUntil(ch: string): number | undefined {
    const until = this.disabled.get(ch);
    return until && until > this.now() ? until : undefined;
  }
  crashDisabledChannels(): Record<string, number> {
    return Object.fromEntries([...this.disabled].filter(([, until]) => until > this.now()));
  }
  status() {
    return {
      available: this.addon.ok,
      ...(this.addon.ok ? {} : { error: this.addon.error }),
      active: this.links.size,
      crashDisabled: this.crashDisabledChannels(),
    };
  }
  stop() {
    if (!this.started) return;
    for (const s of [...this.setups, ...this.links.values()])
      this.close(s, { sendBye: true, sendSignalClose: true });
    this.attempt();
    this.started = false;
    managers--;
    if (!managers && this.t.cleanupOnStop && this.addon.ok)
      this.addon.addon.cleanup();
  }
  getLink(ch: string, peerId: string): ActiveLink | null {
    return this.links.get(this.key(ch, peerId)) ?? null;
  }
  private close(
    s: Setup,
    opts: {
      sendBye?: boolean;
      sendSignalClose?: boolean;
      reason?: string;
    } = {},
  ) {
    if (s.closed) return;
    s.closed = true;
    if (opts.sendBye && s.ctl?.isOpen()) {
      try {
        s.ctl.sendMessage(JSON.stringify({ type: "bye" }));
      } catch {}
    }
    if (opts.sendSignalClose) {
      try {
        this.deps.sendSignal(s.ch, {
          type: "link_close",
          to: s.peerId,
          sid: s.sid,
          ...(opts.reason ? { reason: opts.reason } : {}),
        });
      } catch {}
    }
    clearTimeout(s.timeout);
    clearTimeout(s.idle);
    s.finishGather?.();
    if (this.links.get(this.key(s.ch, s.peerId)) === s)
      this.links.delete(this.key(s.ch, s.peerId));
    this.setups.delete(s);
    for (const dc of s.files) {
      try {
        dc.close();
      } catch {}
    }
    try {
      s.ctl?.close();
      s.pc.close();
    } catch {}
    s.resolve(null);
    this.attempt();
  }
  private idle(s: Setup) {
    clearTimeout(s.idle);
    if (!s.closed && s.verified && !s.files.size) {
      s.idle = setTimeout(
        () => this.close(s, { sendBye: true, sendSignalClose: true }),
        this.t.idleTimeoutMs,
      );
      s.idle.unref?.();
    }
  }
  private file(
    s: Setup,
    dc: DataChannel,
    peer: boolean,
  ): FileDataChannel | null {
    if (
      !/^f:[A-Za-z0-9_-]{22}:[1-9]\d*$/.test(dc.getLabel()) ||
      (peer && s.peerFiles.size >= 4) ||
      !s.verified
    ) {
      dc.close();
      return null;
    }
    s.files.add(dc);
    if (peer) s.peerFiles.add(dc);
    clearTimeout(s.idle);
    let callback: (() => void) | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      s.files.delete(dc);
      s.peerFiles.delete(dc);
      this.idle(s);
      callback?.();
    };
    dc.onClosed(cleanup);
    const wrapper: FileDataChannel = {
      isOpen: () => dc.isOpen(),
      bufferedAmount: () => dc.bufferedAmount(),
      setBufferedAmountLowThreshold: (size) =>
        dc.setBufferedAmountLowThreshold(size),
      sendMessage: (msg) => dc.sendMessage(msg),
      sendMessageBinary: (buf) => dc.sendMessageBinary(buf),
      onOpen: (cb) => dc.onOpen(cb),
      onClosed: (cb) => {
        callback = cb;
      },
      onError: (cb) => dc.onError(cb),
      onBufferedAmountLow: (cb) => dc.onBufferedAmountLow(cb),
      onMessage: (cb) => dc.onMessage(cb),
      close: () => {
        try {
          dc.close();
        } finally {
          cleanup();
        }
      },
    };
    if (peer) this.deps.onFileChannel(s.ch, s.peerId, dc.getLabel(), wrapper);
    return wrapper;
  }
  openFileChannel(
    ch: string,
    peerId: string,
    label: string,
  ): FileDataChannel | null {
    const s = this.links.get(this.key(ch, peerId));
    if (!s || !/^f:[A-Za-z0-9_-]{22}:[1-9]\d*$/.test(label)) return null;
    return this.file(s, s.pc.createDataChannel(label), false);
  }
  private ctl(s: Setup, dc: DataChannel) {
    if (s.ctl) {
      dc.close();
      return;
    }
    s.ctl = dc;
    let helloSent = false;
    const sendHello = () => {
      if (helloSent) return;
      helloSent = true;
      try {
        const local = extractDtlsFingerprint(
          s.pc.localDescription()?.sdp ?? "",
        );
        const rf = s.pc.remoteFingerprint();
        if (!local || !rf?.algorithm || !rf.value)
          throw Error("missing fingerprint");
        const remote = normalizeFingerprint(rf.algorithm, rf.value);
        dc.sendMessage(
          JSON.stringify({
            type: "link_hello",
            sid: s.sid,
            sig: signText(
              this.deps.me.secret,
              `spencer/v1/link-hello\n${s.ch}\n${s.sid}\n${local}\n${remote}`,
            ),
          }),
        );
      } catch {
        this.close(s);
      }
    };
    dc.onOpen(sendHello);
    if (dc.isOpen()) sendHello();
    dc.onMessage((msg) => {
      if (typeof msg !== "string") return this.close(s);
      try {
        const m = JSON.parse(msg);
        if (m.type === "bye") return this.close(s);
        const local = extractDtlsFingerprint(
          s.pc.localDescription()?.sdp ?? "",
        );
        const rf = s.pc.remoteFingerprint();
        const remote = normalizeFingerprint(rf.algorithm, rf.value);
        if (
          m.type !== "link_hello" ||
          m.sid !== s.sid ||
          typeof m.sig !== "string" ||
          !local ||
          !verifyText(
            s.peerId,
            `spencer/v1/link-hello\n${s.ch}\n${s.sid}\n${remote}\n${local}`,
            m.sig,
          )
        )
          return this.close(s);
        if (s.verified) return;
        s.verified = true;
        clearTimeout(s.timeout);
        this.setups.delete(s);
        const old = this.links.get(this.key(s.ch, s.peerId));
        this.links.set(this.key(s.ch, s.peerId), s);
        this.attempt();
        if (old) this.close(old);
        s.resolve(s);
        this.idle(s);
      } catch {
        this.close(s);
      }
    });
    dc.onClosed(() => this.close(s));
  }
  private create(
    ch: string,
    peerId: string,
    sid: string,
    auth: LinkChannelAuth,
  ): Setup {
    if (!this.addon.ok) throw Error(this.addon.error);
    writeFileSync(
      join(this.deps.dataDir, "p2p-attempt"),
      JSON.stringify({ ch, ts: this.now() }),
    );
    let pc: PeerConnection;
    try {
      pc = new this.addon.addon.PeerConnection(peerId, {
        disableAutoNegotiation: true,
        iceServers: auth.stunServers.map((x) =>
          x.startsWith("stun:") ? x : `stun:${x}`,
        ),
        maxMessageSize: 256 * 1024,
      });
    } catch (error) {
      this.attempt();
      throw error;
    }
    let resolve!: (link: ActiveLink | null) => void;
    const promise = new Promise<ActiveLink | null>((r) => {
      resolve = r;
    });
    const s: Setup = {
      ch,
      peerId,
      sid,
      pc,
      ctl: null,
      verified: false,
      remoteSet: false,
      closed: false,
      files: new Set(),
      peerFiles: new Set(),
      resolve,
      promise,
    };
    this.setups.add(s);
    this.attempt();
    s.timeout = setTimeout(() => this.close(s), this.t.dialTimeoutMs);
    s.timeout.unref?.();
    pc.onStateChange((state) => {
      if (state === "failed" || state === "closed") this.close(s);
    });
    pc.onDataChannel((dc) => {
      if (dc.getLabel() === "ctl") this.ctl(s, dc);
      else this.file(s, dc, true);
    });
    return s;
  }
  private async signal(
    s: Setup,
    role: "offer" | "answer",
    auth: LinkChannelAuth,
  ) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          s.finishGather = undefined;
          resolve();
        }
      };
      const timer = setTimeout(finish, this.t.gatherTimeoutMs);
      timer.unref?.();
      s.finishGather = finish;
      s.pc.onGatheringStateChange((state) => {
        if (state === "complete") finish();
      });
      s.pc.setLocalDescription(role);
      if (s.pc.gatheringState() === "complete") finish();
    });
    if (s.closed) return;
    const sdp = s.pc.localDescription()?.sdp;
    if (!sdp) throw Error("missing SDP");
    this.deps.sendSignal(s.ch, {
      type: role === "offer" ? "link_offer" : "link_answer",
      to: s.peerId,
      sid: s.sid,
      sealed: sealLink(this.deps.pairKey(s.ch, s.peerId), role, s.sid, {
        sdp: filterOutgoingSdp(sdp, {
          hideLocalAddresses: !auth.allowLocalAddresses,
          allowLoopback: this.t.allowLoopback,
        }),
      }),
    });
  }
  async ensureLink(
    ch: string,
    peerId: string,
    timeoutMs?: number,
  ): Promise<ActiveLink | null> {
    const existing = this.links.get(this.key(ch, peerId));
    if (existing) return existing;
    const pending = [...this.setups].find(
      (s) => s.ch === ch && s.peerId === peerId,
    );
    if (pending) return pending.promise;
    const auth = this.deps.authorize(ch, peerId);
    if (!this.started || !auth.ok || this.isCrashDisabled(ch) || !this.addon.ok)
      return null;
    let s: Setup | undefined;
    try {
      s = this.create(ch, peerId, randomId(), auth);
      this.ctl(s, s.pc.createDataChannel("ctl"));
      if (timeoutMs !== undefined) {
        clearTimeout(s.timeout);
        s.timeout = setTimeout(() => this.close(s!), timeoutMs);
        s.timeout.unref?.();
      }
      await this.signal(s, "offer", auth);
      return await s.promise;
    } catch (e) {
      this.deps.log(String(e));
      if (s) this.close(s);
      return null;
    }
  }
  async onSignal(ch: string, from: string, body: LinkBody): Promise<void> {
    if (!this.started || body.to !== this.deps.me.id) return;
    const auth = this.deps.authorize(ch, from);
    if (!auth.ok || this.isCrashDisabled(ch)) return;
    if (body.type === "link_close") {
      for (const s of [...this.setups, ...this.links.values()])
        if (s.ch === ch && s.peerId === from && s.sid === body.sid)
          this.close(s);
      return;
    }
    let s: Setup | undefined;
    try {
      if (body.type === "link_answer") {
        s = [...this.setups].find(
          (x) => x.ch === ch && x.peerId === from && x.sid === body.sid,
        );
        if (!s || s.remoteSet) return;
      } else {
        const now = this.now();
        for (const [sid, ts] of this.seen)
          if (now - ts >= this.t.seenSidTtlMs) this.seen.delete(sid);
        if (
          this.seen.has(body.sid) ||
          (this.rates.has(ch) &&
            now - this.rates.get(ch)! < this.t.offerRateLimitMs)
        )
          return;
        this.seen.set(body.sid, now);
        if (this.seen.size > 512)
          this.seen.delete(this.seen.keys().next().value!);
        this.rates.set(ch, now);
      }
      const role = body.type === "link_offer" ? "offer" : "answer";
      const obj = openLink<{ sdp?: unknown }>(
        this.deps.pairKey(ch, from),
        role,
        body.sid,
        body.sealed,
      );
      if (
        !obj ||
        typeof obj.sdp !== "string" ||
        !extractDtlsFingerprint(obj.sdp)
      )
        throw Error("invalid SDP");
      const sdp = filterIncomingSdp(obj.sdp, {
        allowPrivate: auth.allowLocalAddresses,
        allowLoopback: this.t.allowLoopback,
      });
      if (!s) s = this.create(ch, from, body.sid, auth);
      s.pc.setRemoteDescription(sdp, role);
      s.remoteSet = true;
      if (role === "offer") await this.signal(s, "answer", auth);
    } catch (e) {
      this.deps.log(String(e));
      if (s) this.close(s);
    }
  }
  closeChannel(ch: string, reason?: string) {
    for (const s of [...this.setups, ...this.links.values()])
      if (s.ch === ch)
        this.close(s, { sendBye: true, sendSignalClose: true, reason });
  }
  onWake() {
    for (const s of [...this.setups, ...this.links.values()])
      this.close(s, { sendBye: true, sendSignalClose: true });
  }
}
