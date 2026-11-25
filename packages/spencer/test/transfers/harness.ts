/** Test harness: two (or more) transfer managers wired through an in-memory message bus. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateIdentity, pairKey, randomId } from "@spencer/protocol";
import type { CrocInfo, FileBody, Identity } from "@spencer/protocol";
import { DEFAULT_POLICY } from "../../src/config.ts";
import type { Policy } from "../../src/config.ts";
import type { Transfer, TransferService } from "../../src/contracts.ts";
import { createTransferService } from "../../src/transfers/index.ts";
import type { CrocRunner, TransferServiceOptions } from "../../src/transfers/index.ts";

export interface Delivered {
  from: string;
  to: string;
  ch: string;
  body: FileBody;
}

export class Bus {
  nodes = new Map<string, TNode>();
  log: Delivered[] = [];
  errors: unknown[] = [];
  /** Return "drop" to lose a message, "dup" to deliver it twice. */
  filter: ((d: Delivered) => "drop" | "dup" | void) | undefined;

  send(from: string, ch: string, body: FileBody): void {
    const d: Delivered = { from, to: body.to, ch, body };
    this.log.push(d);
    const verdict = this.filter?.(d);
    if (verdict === "drop") return;
    const times = verdict === "dup" ? 2 : 1;
    for (let i = 0; i < times; i++) setImmediate(() => this.deliver(d));
  }

  deliver(d: Delivered): void {
    const n = this.nodes.get(d.to);
    if (!n) return;
    if (!n.svc) {
      n.queue.push(d); // node is down: the relay keeps it until it comes back
      return;
    }
    n.svc.onBody(d.ch, d.from, d.body).catch((e) => this.errors.push(e));
  }

  types(from?: TNode): string[] {
    return this.log.filter((d) => !from || d.from === from.id.id).map((d) => d.body.type);
  }
}

export interface NodeOptions {
  p2p?: import("../../src/contracts.ts").TransferP2pAdapter;
  policy?: Partial<Policy>;
  crocInfo?: () => CrocInfo | undefined;
  service?: TransferServiceOptions;
  runner: CrocRunner;
}

export class TNode {
  name: string;
  id: Identity;
  dir: string;
  dataDir: string;
  dbPath: string;
  db!: DatabaseSync;
  svc: TransferService | undefined;
  queue: Delivered[] = [];
  events: Transfer[] = [];
  notes: string[] = [];
  channelNotes: Array<{ ch: string; text: string; untrusted?: boolean }> = [];
  enqueued: FileBody[] = [];
  policy: Policy;
  clock = { offset: 0 };
  peersOf = new Map<string, string[]>();
  trustOf = new Map<string, "standard" | "full">();
  bus: Bus;
  opts: NodeOptions;
  info: CrocInfo | undefined = { relay: "fake-relay:9009", pass: "fake-pass" };

  constructor(name: string, bus: Bus, opts: NodeOptions) {
    this.name = name;
    this.bus = bus;
    this.opts = opts;
    this.id = generateIdentity();
    this.dir = mkdtempSync(join(tmpdir(), `spencer-xfer-${name}-`));
    this.dataDir = join(this.dir, "data");
    this.dbPath = join(this.dir, "spencer.db");
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    bus.nodes.set(this.id.id, this);
  }

  now(): number {
    return Date.now() + this.clock.offset;
  }

  async start(): Promise<void> {
    this.db = new DatabaseSync(this.dbPath);
    const svc = createTransferService(
      {
        p2p: this.opts.p2p,
        db: this.db,
        dataDir: this.dataDir,
        me: this.id,
        policy: () => this.policy,
        trust: (ch) => this.trustOf.get(ch) ?? "standard",
        enqueue: (ch, body) => {
          this.enqueued.push(body);
          this.bus.send(this.id.id, ch, body);
        },
        crocInfo: () => (this.opts.crocInfo ? this.opts.crocInfo() : this.info),
        pairKey: (ch, peer) => pairKey(this.id.secret, peer, this.id.id, ch),
        peers: (ch) => this.peersOf.get(ch) ?? [],
        peerName: (_ch, peer) => this.bus.nodes.get(peer)?.name,
        crocPath: "/nonexistent/croc",
        events: { emit: (e) => e.type === "transfer" && this.events.push(e.transfer) },
        channelTransferNote: (ch, text, opts) => { this.channelNotes.push({ ch, text, ...opts }); },
        ownerNote: (t) => this.notes.push(t),
        now: () => this.now(),
      },
      { runner: this.opts.runner, backoffMs: () => 5, sweepIntervalMs: 20, noRelayRetryMs: 20, watchdogMs: 20, ...this.opts.service },
    );
    await svc.start();
    this.svc = svc;
    for (const d of this.queue.splice(0)) this.bus.deliver(d);
  }

  async stop(): Promise<void> {
    const s = this.svc;
    this.svc = undefined;
    await s?.stop();
    this.db?.close();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  get s(): TransferService {
    if (!this.svc) throw new Error(`${this.name} is down`);
    return this.svc;
  }

  state(tid: string): string | undefined {
    return this.svc?.get(tid)?.state;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Two nodes sharing a direct channel. */
export async function pair(opts: { runner: CrocRunner; a?: Partial<NodeOptions>; b?: Partial<NodeOptions> }) {
  const bus = new Bus();
  const A = new TNode("alice", bus, { runner: opts.runner, ...opts.a });
  const B = new TNode("bob", bus, { runner: opts.runner, ...opts.b });
  const ch = randomId();
  A.peersOf.set(ch, [B.id.id]);
  B.peersOf.set(ch, [A.id.id]);
  await A.start();
  await B.start();
  return {
    bus,
    A,
    B,
    ch,
    async close() {
      await A.stop();
      await B.stop();
      A.cleanup();
      B.cleanup();
    },
  };
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
