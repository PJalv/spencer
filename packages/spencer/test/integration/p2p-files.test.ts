import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay } from '../../../relay/src/index.ts';
import { Daemon } from '../../src/daemon.ts';
import { DEFAULT_POLICY } from '../../src/config.ts';
import { createTransferService, fakeCrocRunner } from "../../src/transfers/index.ts";
import { Api, tempDir, waitFor } from './harness.ts';

 test('direct file over a chat-only relay', { timeout: 60000 }, async () => {
  const tmp = tempDir('spencer-p2p-');
  const relay = await startRelay({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'relay.db'), stunBind: '127.0.0.1:0' });
  const nodes = ['Alice', 'Bob'].map(name => new Daemon({ dataDir: join(tmp.dir, name), config: { name, relay: relay.url, http: { host: '127.0.0.1', port: 0 }, model: { provider: 'fake' }, policy: { ...DEFAULT_POLICY, autoAcceptIncomingFiles: true } }, tuning: { p2p: { allowLoopback: true, cleanupOnStop: false } }, webRoot: null }));
  try {
    await Promise.all(nodes.map(n => n.start()));
    const [a, b] = nodes as [Daemon, Daemon];
    const inv = await a.createInvite('direct', 'Bob');
    await b.acceptInvite(inv.link);
    await waitFor(() => a.channels.peerHasFeature(inv.channel.id, b.identity.id, 'p2p-files/1') && b.channels.peerHasFeature(inv.channel.id, a.identity.id, 'p2p-files/1'), 'feature hello');
    const aa = new Api(a.port, a.token), bb = new Api(b.port, b.token);
    const data = randomBytes(64 * 1024), path = join(tmp.dir, 'file.bin');
    writeFileSync(path, data);
    const tr = await aa.sendFile(inv.channel.id, path);
    assert.notEqual(tr.state, 'awaiting_approval');
    await waitFor(async () => (await aa.transfer(tr.tid)).state === 'completed' && (await bb.transfer(tr.tid)).state === 'completed', 'transfer', 30000);
    const sent = await aa.transfer(tr.tid), received = await bb.transfer(tr.tid);
    assert.equal(sent.via, 'link'); assert.equal(received.via, 'link');
    assert.equal(createHash('sha256').update(readFileSync(received.path!)).digest('hex'), createHash('sha256').update(data).digest('hex'));
  } finally { await Promise.all(nodes.map(n => n.stop())); await relay.close(); tmp.cleanup(); }
});

 test('group transfer reaches only the selected peer', { timeout: 60000 }, async () => {
  const tmp = tempDir('spencer-p2p-group-');
  const relay = await startRelay({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'relay.db'), stunBind: '127.0.0.1:0' });
  const nodes = ['Alice', 'Bob', 'Carol'].map(name => new Daemon({ dataDir: join(tmp.dir, name), config: { name, relay: relay.url, http: { host: '127.0.0.1', port: 0 }, model: { provider: 'fake' }, policy: { ...DEFAULT_POLICY, autoAcceptIncomingFiles: true } }, tuning: { p2p: { allowLoopback: true, cleanupOnStop: false } }, webRoot: null }));
  try {
    await Promise.all(nodes.map(n => n.start()));
    const [a, b, c] = nodes as [Daemon, Daemon, Daemon];
    const inv = await a.createInvite('group', 'Team');
    await b.acceptInvite(inv.link); await c.acceptInvite(inv.link);
    await waitFor(() => a.channels.peerHasFeature(inv.channel.id, b.identity.id, 'p2p-files/1') && b.channels.peerHasFeature(inv.channel.id, a.identity.id, 'p2p-files/1'), 'feature hello');
    const aa = new Api(a.port, a.token), bb = new Api(b.port, b.token);
    const data = randomBytes(5 * 1024 * 1024), path = join(tmp.dir, 'file.bin'); writeFileSync(path, data);
    const tr = await aa.sendFile(inv.channel.id, path, b.identity.id); assert.notEqual(tr.state, 'awaiting_approval');
    await waitFor(async () => (await aa.transfer(tr.tid)).state === 'completed' && (await bb.transfer(tr.tid)).state === 'completed', 'transfer', 30000);
    const sent = await aa.transfer(tr.tid), received = await bb.transfer(tr.tid);
    assert.equal(sent.via, 'link'); assert.equal(received.via, 'link');
    assert.deepEqual(readFileSync(received.path!), data);
    assert.equal(c.transfers.list().length, 0); assert.equal(c.links?.status().active, 0);
  } finally { await Promise.all(nodes.map(n => n.stop())); await relay.close(); tmp.cleanup(); }
});

const FOUR_MIB = 4 * 1024 * 1024;

async function scenario(kind: 'threshold' | 'multihub' | 'restart' | 'mode-off' | 'channel-off' | 'crash') {
  const tmp = tempDir(`spencer-${kind}-`);
  const dbPath = join(tmp.dir, 'relay.db');
  const options = { host: '127.0.0.1', port: 0, dbPath, stunBind: '127.0.0.1:0', crocRelay: '127.0.0.1:9009', crocPass: 'test' };
  let hub = await startRelay(options);
  const hubB = kind === 'multihub' ? await startRelay({ host: '127.0.0.1', port: 0, dbPath: join(tmp.dir, 'hub-b.db'), stunBind: '127.0.0.1:0' }) : undefined;
  const fakeCroc = fakeCrocRunner();
  const makeNode = (name: string) => new Daemon({
    dataDir: join(tmp.dir, name),
    config: { name, relay: hub.url, http: { host: '127.0.0.1', port: 0 }, model: { provider: 'fake' }, policy: { ...DEFAULT_POLICY, autoAcceptIncomingFiles: true }, ...(name === 'Bob' && kind === 'mode-off' ? { p2p: { mode: 'off' as const, hideLocalAddresses: true, minFileBytes: FOUR_MIB, stun: [] } } : {}) },
    tuning: { p2p: { allowLoopback: true, cleanupOnStop: false } }, webRoot: null,
    transferFactory: deps => createTransferService(deps, { runner: fakeCroc }),
  });
  let a = makeNode('Alice'); const b = makeNode('Bob');
  try {
    await Promise.all([a.start(), b.start()]);
    const inv = await a.createInvite('direct', 'HubB', hubB?.url);
    await b.acceptInvite(inv.link);
    const ch = inv.channel.id;
    await waitFor(() => a.channels.peers(ch).includes(b.identity.id), 'peer membership');
    if (kind !== 'mode-off') await waitFor(() => a.channels.peerHasFeature(ch, b.identity.id, 'p2p-files/1') && b.channels.peerHasFeature(ch, a.identity.id, 'p2p-files/1'), 'feature hello');
    if (kind === 'crash') {
      await a.stop();
      writeFileSync(join(tmp.dir, 'Alice', 'p2p-attempt'), JSON.stringify({ ch, ts: Date.now() }));
      a = makeNode('Alice'); await a.start();
      assert.equal(a.links?.isCrashDisabled(ch), true);
      await waitFor(async () => JSON.stringify(await new Api(a.port, a.token).owner()).includes('Direct links were disabled'), 'crash note');
    }
    const aa = new Api(a.port, a.token), bb = new Api(b.port, b.token);
    if (kind === 'channel-off') await aa.req('PATCH', `/api/channels/${ch}`, { directLink: 'off' });
    if (kind === 'multihub') {
      await aa.say(ch, 'hello from Alice'); await bb.say(ch, 'hello from Bob');
      await waitFor(async () => JSON.stringify(await aa.messages(ch)).includes('hello from Bob') && JSON.stringify(await bb.messages(ch)).includes('hello from Alice'), 'chat on Hub B');
    }
    const transfer = async (size: number, via: 'link' | 'croc') => {
      const data = randomBytes(size), path = join(tmp.dir, `file-${size}.bin`); writeFileSync(path, data);
      const tr = await aa.sendFile(ch, path); assert.notEqual(tr.state, 'awaiting_approval');
      await waitFor(async () => (await aa.transfer(tr.tid)).state === 'completed' && (await bb.transfer(tr.tid)).state === 'completed', 'transfer', 30000);
      const sent = await aa.transfer(tr.tid), received = await bb.transfer(tr.tid);
      assert.equal(sent.via, via); assert.equal(received.via, via);
      assert.equal(createHash('sha256').update(readFileSync(received.path!)).digest('hex'), createHash('sha256').update(data).digest('hex'));
    };
    if (kind === 'threshold') {
      await transfer(5 * 1024 * 1024, 'link'); assert.equal(fakeCroc.spawned.length, 0);
      await transfer(16 * 1024, 'croc'); assert.ok(fakeCroc.spawned.length > 0);
    } else if (kind === 'restart') {
      await transfer(5 * 1024 * 1024, 'link');
      const port = Number(new URL(hub.url).port);
      await hub.close();
      assert.ok(a.links!.status().active > 0); assert.ok(b.links!.status().active > 0);
      hub = await startRelay({ ...options, port });
      await waitFor(() => a.pool.peek(hub.url)?.ready && b.pool.peek(hub.url)?.ready, 'relay reconnect', 30000);
      assert.ok(a.links!.status().active > 0); assert.ok(b.links!.status().active > 0);
      await transfer(5 * 1024 * 1024, 'link');
    } else if (kind === 'multihub') await transfer(64 * 1024, 'link');
    else { await transfer(5 * 1024 * 1024, 'croc'); assert.ok(fakeCroc.spawned.length > 0); }
  } finally { await Promise.all([a.stop(), b.stop()]); await hub.close(); await hubB?.close(); tmp.cleanup(); }
}

for (const kind of ['threshold', 'multihub', 'restart', 'mode-off', 'channel-off', 'crash'] as const) {
  test(`P2P integration: ${kind}`, { timeout: 90000 }, () => scenario(kind));
}
