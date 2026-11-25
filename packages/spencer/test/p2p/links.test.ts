import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '../../../protocol/src/identity.ts';
import { pairKey } from '../../../protocol/src/channel.ts';
import { randomId } from '../../../protocol/src/encoding.ts';
import { LinkManager } from '../../src/p2p/links.ts';
import { openLink, sealLink, type LinkBody } from '@spencer/protocol';
import type { FileDataChannel } from '../../src/p2p/file-stream.ts';

test('loopback links authenticate and open file channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-')); const a = generateIdentity(), b = generateIdentity(); let received = 0;
  let left: LinkManager, right: LinkManager;
  const make = (me: typeof a, dest: () => LinkManager) => new LinkManager({ dataDir: join(dir, me.id), me, sendSignal: (ch, body) => { void dest().onSignal(ch, me.id, body); }, pairKey: (ch, peer) => pairKey(me.secret, peer, me.id, ch), authorize: () => ({ ok: true, allowLocalAddresses: true, stunServers: [] }), onFileChannel: () => { received++; }, ownerNote: () => {}, log: console.error, tuning: { allowLoopback: true, cleanupOnStop: false, idleTimeoutMs: 100 } });
  left = make(a, () => right); right = make(b, () => left); left.start(); right.start();
  try { for (const ch of [randomId(), randomId()]) { const link = await left.ensureLink(ch, b.id); assert.ok(link); assert.equal(existsSync(join(dir, a.id, "p2p-attempt")), false); await new Promise(r => setTimeout(r, 50)); assert.ok(right.getLink(ch, a.id)); const dc = left.openFileChannel(ch, b.id, `f:${randomId()}:1`); assert.ok(dc); await new Promise(r => setTimeout(r, 100)); assert.ok(received); dc.close(); left.closeChannel(ch); right.closeChannel(ch); } } finally { left.stop(); right.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('crash marker disables the channel', () => { const dir = mkdtempSync(join(tmpdir(), 'links-')); const ch = randomId(); writeFileSync(join(dir, 'p2p-attempt'), JSON.stringify({ ch, ts: 1 })); let notes = 0; const m = new LinkManager({ dataDir: dir, me: generateIdentity(), sendSignal() {}, pairKey: () => new Uint8Array(32), authorize: () => ({ ok: true, allowLocalAddresses: false, stunServers: [] }), onFileChannel() {}, ownerNote: () => { notes++; }, log() {}, tuning: { cleanupOnStop: false } }); try { m.start(); assert.equal(m.isCrashDisabled(ch), true); assert.equal(notes, 1); assert.ok(m.crashDisabledUntil(ch)); m.clearCrashDisable(ch); assert.deepEqual(m.status().crashDisabled, {}); assert.deepEqual(JSON.parse(readFileSync(join(dir, "p2p-disabled.json"), "utf8")), {}); } finally { m.stop(); rmSync(dir, { recursive: true, force: true }); } });

test('crash disable survives restart and expires after 24 hours', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const ch = randomId();
  let now = 1_000;
  let notes = 0;
  writeFileSync(join(dir, 'p2p-attempt'), JSON.stringify({ ch, ts: now }));
  const make = () => new LinkManager({ dataDir: dir, me: generateIdentity(), sendSignal() {}, pairKey: () => new Uint8Array(32), authorize: () => ({ ok: true, allowLocalAddresses: false, stunServers: [] }), onFileChannel() {}, ownerNote: () => { notes++; }, log() {}, now: () => now, tuning: { cleanupOnStop: false } });
  const first = make();
  const second = make();
  try {
    first.start();
    assert.equal(JSON.parse(readFileSync(join(dir, 'p2p-disabled.json'), 'utf8'))[ch], now + 86_400_000);
    first.stop();
    second.start();
    assert.equal(second.isCrashDisabled(ch), true);
    assert.equal(notes, 1);
    now += 86_400_000;
    assert.equal(second.isCrashDisabled(ch), false);
  } finally {
    first.stop(); second.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'condition did not become true');
}

function pair(idleTimeoutMs = 5000) {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const a = generateIdentity(), b = generateIdentity(), ch = randomId();
  let now = 1000;
  const signals: { from: string; body: LinkBody }[] = [];
  const files: { label: string; dc: FileDataChannel }[] = [];
  let intercept: ((from: string, body: LinkBody) => void) | undefined;
  let dropClose = false;
  let left: LinkManager, right: LinkManager;
  const make = (me: typeof a, dest: () => LinkManager) => new LinkManager({
    dataDir: join(dir, me.id), me,
    sendSignal: (channel, body) => {
      signals.push({ from: me.id, body });
      intercept?.(me.id, body);
      if (!(dropClose && body.type === 'link_close')) void dest().onSignal(channel, me.id, body);
    },
    pairKey: (channel, peer) => pairKey(me.secret, peer, me.id, channel),
    authorize: () => ({ ok: true, allowLocalAddresses: true, stunServers: [] }),
    onFileChannel: (_ch, _peer, label, dc) => files.push({ label, dc }),
    ownerNote() {}, log() {}, now: () => now,
    tuning: { allowLoopback: true, cleanupOnStop: false, idleTimeoutMs, offerRateLimitMs: 10000, dialTimeoutMs: 500 },
  });
  left = make(a, () => right); right = make(b, () => left);
  left.start(); right.start();
  return { a, b, ch, left, right, signals, files,
    setNow: (value: number) => { now = value; },
    dropClose: () => { dropClose = true; },
    intercept: (fn: typeof intercept) => { intercept = fn; },
    close: () => { left.stop(); right.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function connected(p: ReturnType<typeof pair>) {
  const link = await p.left.ensureLink(p.ch, p.b.id);
  assert.ok(link);
  await until(() => !!p.right.getLink(p.ch, p.a.id));
  return link;
}

test('wrong answer sid and replayed offer are ignored', async () => {
  const p = pair();
  try {
    p.intercept((from, body) => {
      if (from === p.b.id && body.type === 'link_answer')
        void p.left.onSignal(p.ch, p.b.id, { ...body, sid: randomId() });
    });
    const link = await connected(p);
    const offer = p.signals.find(x => x.body.type === 'link_offer')!.body;
    const count = p.signals.filter(x => x.body.type === 'link_answer').length;
    await p.right.onSignal(p.ch, p.a.id, offer);
    await delay(100);
    assert.equal(p.signals.filter(x => x.body.type === 'link_answer').length, count);
    assert.equal(p.left.getLink(p.ch, p.b.id), link);
    assert.ok(p.right.getLink(p.ch, p.a.id));
  } finally { p.close(); }
});

test('replacement failure preserves the verified link and rate limit is per channel', async () => {
  const p = pair();
  try {
    const link = await connected(p);
    const offer = p.signals.find(x => x.body.type === 'link_offer')!.body;
    assert.equal(offer.type, 'link_offer');
    if (offer.type !== 'link_offer') throw Error('missing offer');
    const key = pairKey(p.a.secret, p.b.id, p.a.id, p.ch);
    const original = openLink<{ sdp: string }>(key, 'offer', offer.sid, offer.sealed)!;
    const makeOffer = () => {
      const sid = randomId();
      const sdp = original.sdp.replace(/a=fingerprint:([^ ]+) [^\r\n]+/i, (_m, algorithm: string) => `a=fingerprint:${algorithm} ${Array(32).fill('00').join(':')}`);
      assert.notEqual(sdp, original.sdp);
      return { ...offer, sid, sealed: sealLink(key, 'offer', sid, { sdp }) };
    };
    const answers = () => p.signals.filter(x => x.body.type === 'link_answer').length;
    const initial = answers();
    p.setNow(2000);
    await p.right.onSignal(p.ch, p.a.id, makeOffer());
    assert.equal(answers(), initial);
    p.setNow(11001);
    await p.right.onSignal(p.ch, p.a.id, makeOffer());
    assert.equal(answers(), initial + 1);
    await delay(600);
    assert.equal(p.left.getLink(p.ch, p.b.id), link);
    assert.ok(p.right.getLink(p.ch, p.a.id));
    const dc = p.left.openFileChannel(p.ch, p.b.id, `f:${randomId()}:1`);
    assert.ok(dc);
    await until(() => dc.isOpen() && p.files.length > 0);
    let received: string | Buffer | ArrayBuffer | undefined;
    p.files[0]!.dc.onMessage(msg => { received = msg; });
    dc.sendMessageBinary(Buffer.from('hello'));
    await until(() => received !== undefined);
    assert.deepEqual(Buffer.from(received as Buffer), Buffer.from('hello'));
    dc.close();
  } finally { p.close(); }
});

test('rejects unknown peer labels and limits peer file channels to four', async () => {
  const p = pair();
  try {
    const link = await connected(p);
    const evil = link.pc.createDataChannel('evil');
    let evilClosed = false;
    evil.onClosed(() => { evilClosed = true; });
    await until(() => evilClosed);
    assert.equal(p.files.some(x => x.label === 'evil'), false);
    const tid = randomId();
    const channels = Array.from({ length: 4 }, (_, i) => link.pc.createDataChannel(`f:${tid}:${i + 1}`));
    await until(() => p.files.length === 4);
    const fifth = link.pc.createDataChannel(`f:${tid}:5`);
    let fifthClosed = false;
    fifth.onClosed(() => { fifthClosed = true; });
    await until(() => fifthClosed);
    assert.equal(p.files.length, 4);
    channels.push(fifth);
    channels.forEach(dc => dc.close());
  } finally { p.close(); }
});

test('idle timeout respects open file channels and caller close handlers', async () => {
  const p = pair(120);
  try {
    await connected(p);
    await until(() => !p.left.getLink(p.ch, p.b.id), 400);
  } finally { p.close(); }
  const q = pair(120);
  try {
    await connected(q);
    const dc = q.left.openFileChannel(q.ch, q.b.id, `f:${randomId()}:1`);
    assert.ok(dc);
    let closed = false;
    dc.onClosed(() => { closed = true; });
    await until(() => dc.isOpen() && q.files.length > 0);
    await delay(250);
    assert.ok(q.left.getLink(q.ch, q.b.id));
    assert.ok(q.right.getLink(q.ch, q.a.id));
    dc.close();
    assert.equal(closed, true);
    await until(() => !q.left.getLink(q.ch, q.b.id), 400);
  } finally { q.close(); }
});

for (const action of ['onWake', 'stop'] as const) {
  test(`${action} closes links and sends link_close`, async () => {
    const p = pair();
    try {
      await connected(p);
      p.dropClose();
      p.left[action]();
      assert.ok(p.signals.some(x => x.from === p.a.id && x.body.type === 'link_close'));
      assert.equal(p.left.getLink(p.ch, p.b.id), null);
      await until(() => !p.right.getLink(p.ch, p.a.id));
    } finally { p.close(); }
  });
}
