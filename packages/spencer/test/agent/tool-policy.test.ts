import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ToolPolicyStore, toolMatches } from '../../src/agent/tool-policy.ts';

const global = { scopeKind: 'global', scopeId: '*' } as const;
const channel = { scopeKind: 'channel', scopeId: 'room' } as const;
const peer = { scopeKind: 'peer', scopeId: 'bob' } as const;
const tool = 'mcp__arbitrary__launch';

test('glob treats regex syntax literally and supports arbitrary MCP servers', () => {
  for (const [pattern, name, result] of [
    ['*', tool, true],
    ['mcp__arbitrary__*', tool, true],
    ['*launch', tool, true],
    ['*delete*', tool, false],
    ['a.b', 'axb', false],
    ['a*b*c', 'axbyc', true],
    ['a*b', 'ac', false],
  ] as const) assert.equal(toolMatches(pattern, name), result);
});

test('SQLite policies persist, narrow effects, enforce tool-level guardrails and isolate scopes', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    store.replace(global, [{ toolPattern: '*', effect: 'ask_owner', note: 'confirm' }]);
    store.replace(channel, [{ toolPattern: tool, effect: 'allow' }]);
    assert.equal(store.effect(store.active('room', 'bob'), tool), 'ask_owner');
    assert.deepEqual(store.enforce(store.active('room', 'alice'), 'mcp__arbitrary__other'), {
      isError: true,
      text: 'Policy violation: mcp__arbitrary__other requires owner approval. Call ask_owner with the complete request instead.',
    });
    store.replace(peer, [{ toolPattern: '*launch', effect: 'deny' }]);
    assert.equal(new ToolPolicyStore(db).effect(store.active('other', 'bob'), tool), 'deny');
    assert.match(JSON.stringify(store.enforce(store.active('room', 'bob'), tool)), /is denied/);
    assert.equal(store.effect(store.active('room', 'alice'), tool), 'ask_owner');
    assert.match(JSON.stringify(store.enforce(store.active('room', 'alice'), tool)), /ask_owner/);
    store.replace(global, []);
    store.replace(peer, []);
    assert.equal(store.list(peer).length, 0);
    assert.deepEqual(store.enforce(store.active('room', 'bob'), tool), { ok: true });
  } finally { db.close(); }
});

test('stored legacy parameter fields are ignored when reading from SQLite', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    db.prepare('INSERT INTO agent_tool_policies VALUES (?,?,?,?)').run(
      'global', '*', 'legacy',
      JSON.stringify({ id: 'legacy', scopeKind: 'global', scopeId: '*', toolPattern: '*echo', effect: 'ask_owner', argLocks: { model: 'old' }, note: 'keep', updatedAt: 123 }),
    );
    assert.deepEqual(store.list(global), [{ id: 'legacy', scopeKind: 'global', scopeId: '*', toolPattern: '*echo', effect: 'ask_owner', note: 'keep', updatedAt: 123 }]);
    assert.deepEqual(store.all(), [{ id: 'legacy', scopeKind: 'global', scopeId: '*', toolPattern: '*echo', effect: 'ask_owner', note: 'keep', updatedAt: 123 }]);
  } finally { db.close(); }
});

test('rejects pollution, parameter-level fields, malformed and oversized policies atomically', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    store.replace(global, [{ toolPattern: '*', effect: 'deny' }]);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => store.replace(global, JSON.parse(`[{"toolPattern":"*","effect":"allow","${key}":{}}]`)));
    }
    for (const value of [
      [{ toolPattern: 'x'.repeat(129), effect: 'allow' }],
      [{ toolPattern: 'bad space', effect: 'allow' }],
      [{ toolPattern: '*', effect: 'invalid' }],
      [{ toolPattern: '*', effect: 'allow', note: 'x'.repeat(2001) }],
      [{ toolPattern: '*', effect: 'allow', argDefaults: { x: 1 } }],
      [{ toolPattern: '*', effect: 'allow', argLocks: { x: 1 } }],
      [{ toolPattern: '*', effect: 'allow', argAllowValues: { x: [1] } }],
      Array(101).fill({ toolPattern: '*', effect: 'allow' }),
      Array(40).fill(null).map((_, i) => ({ id: `r-${i}`, toolPattern: '*', effect: 'allow', note: 'x'.repeat(1800) })),
    ]) assert.throws(() => store.replace(global, value));
    assert.equal(store.list(global)[0].effect, 'deny');
    assert.throws(() => store.list({ scopeKind: 'global', scopeId: 'bad' }));
  } finally { db.close(); }
});
