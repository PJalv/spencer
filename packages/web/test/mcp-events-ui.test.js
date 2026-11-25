import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Node: win.Node,
  HTMLElement: win.HTMLElement,
  localStorage: win.localStorage,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
});
const { api } = await import('../public/api.js');
const { S, setOwner, upsertFollowup } = await import('../public/state.js');
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); timer.unref(); return timer; };
const { mcpView } = await import('../public/mcp.js');
const { followupList } = await import('../public/common.js');
const { ownerView } = await import('../public/owner.js');
globalThis.setInterval = originalSetInterval;
after(() => win.close());

test('HTTP T3 Code keeps its configuration and displays semantic event status pills', async () => {
  api.mcp = async () => ({
    config: {
      t3code: { url: 'http://localhost:1234/mcp' },
      revokedSrv: { url: 'http://localhost:1235/mcp' },
      errSrv: { url: 'http://localhost:1236/mcp' },
    },
    presets: [{ name: 't3code', config: { command: 't3code', args: ['mcp'] } }],
    servers: [
      { name: 't3code', status: 'connected', transport: 'http', tools: [], events: { status: 'supported', eventCount: 3 } },
      { name: 'revokedSrv', status: 'error', transport: 'http', tools: [], events: { status: 'revoked', error: '401' } },
      { name: 'errSrv', status: 'error', transport: 'http', tools: [], events: { status: 'error', error: '503' } },
    ],
  });
  const root = document.createElement('main');
  document.body.append(root);
  const view = mcpView(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(root.textContent, /events: 3/);
  assert.match(root.textContent, /events: revoked/);
  assert.match(root.textContent, /events: error/);
  assert.ok(root.querySelector('.pill.ok'));
  assert.ok(root.querySelector('.pill.bad'));
  assert.ok(root.querySelector('.pill.attn'));
  assert.doesNotMatch(root.textContent, /Switch to local T3 Code bridge/);
  view.destroy();
  root.remove();
});

test('event-backed follow-up lists show event trigger and non-reply untrusted notes render as notes', async () => {
  S.followups.clear();
  upsertFollowup({
    id: 'fu-ev-1',
    conversation: 'owner',
    note: 'Check T3 thread',
    dueAt: Date.now() + 60 * 60_000,
    state: 'pending',
    createdAt: Date.now(),
    eventSubscriptions: [{ id: 'sub-1', server: 't3code', event: 'thread.run_settled', state: 'active' }],
  });
  upsertFollowup({
    id: 'fu-ev-2',
    conversation: 'owner',
    note: 'Check revoked thread',
    dueAt: Date.now() + 90 * 60_000,
    state: 'pending',
    createdAt: Date.now(),
    eventSubscriptions: [{ id: 'sub-2', server: 't3code', event: 'thread.run_settled', state: 'revoked' }],
  });
  const list = followupList('owner');
  assert.ok(list);
  assert.match(list.textContent, /Due on t3code:thread\.run_settled, or /);
  assert.match(list.textContent, /Due on t3code:thread\.run_settled \(revoked\), or /);

  setOwner([
    { id: 'n1', role: 'note', text: 'MCP event reception for t3code stopped: authorization was revoked (403).', untrusted: true, ts: Date.now() },
    { id: 'n2', role: 'note', text: "Reply from Alice's Spencer in Alice (untrusted): hello", untrusted: true, ts: Date.now() + 1 },
  ]);
  const root = document.createElement('main');
  document.body.append(root);
  const view = ownerView(root);
  assert.ok(root.querySelector('.note'));
  assert.match(root.querySelector('.note').textContent, /MCP event reception for t3code stopped/);
  assert.ok(root.querySelector('details.exchange'));
  assert.match(root.querySelector('details.exchange').textContent, /Alice's Spencer/);
  assert.doesNotMatch(root.querySelector('details.exchange').textContent, /MCP event reception/);
  view.destroy();
  root.remove();
  S.followups.clear();
});
