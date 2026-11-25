import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ToolPolicyStore, toolMatches } from '../../src/agent/tool-policy.ts';

const global = { scopeKind: 'global', scopeId: '*' } as const;
const channel = { scopeKind: 'channel', scopeId: 'room' } as const;
const peer = { scopeKind: 'peer', scopeId: 'bob' } as const;
const tool = 'mcp__arbitrary__launch';
test('glob treats regex syntax literally and supports arbitrary MCP servers', () => {
  for (const [pattern, name, result] of [['*', tool, true], ['mcp__arbitrary__*', tool, true], ['*launch', tool, true], ['*delete*', tool, false], ['a.b', 'axb', false], ['a*b*c', 'axbyc', true], ['a*b', 'ac', false]] as const) assert.equal(toolMatches(pattern, name), result);
});
test('SQLite policies persist, narrow effects and isolate scopes', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    store.replace(global, [{toolPattern: '*', effect:'ask_owner'}]);
    store.replace(channel, [{toolPattern: tool, effect:'allow'}]);
    assert.equal(store.effect(store.active('room','bob'), tool), 'ask_owner');
    store.replace(peer, [{toolPattern: '*launch', effect:'deny'}]);
    assert.equal(new ToolPolicyStore(db).effect(store.active('other','bob'),tool), 'deny');
    assert.equal(store.effect(store.active('room','alice'),tool), 'ask_owner');
    assert.match(JSON.stringify(store.enforce(store.active('room','alice'),tool,{})), /ask_owner/);
    store.replace(peer, []); assert.equal(store.list(peer).length,0);
  } finally {db.close();}
});
test('defaults, deep locks and intersecting allowlists fail closed without mutating arguments', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    store.replace(global,[{toolPattern:'*',effect:'allow',argDefaults:{worktree:'main'},argLocks:{provider:'any-provider','modelSelection.model':'chosen'},argAllowValues:{projectId:['one','two']}}]);
    store.replace(channel,[{toolPattern:'*',effect:'allow',argAllowValues:{projectId:['two','three']}}]);
    const input = {projectId:'two'};
    assert.deepEqual(store.enforce(store.active('room','bob'),tool,input),{args:{projectId:'two',worktree:'main',provider:'any-provider',modelSelection:{model:'chosen'}}});
    assert.deepEqual(input,{projectId:'two'});
    for (const args of [{}, {projectId:'one'}, {projectId:'three'}, {projectId:'two',provider:'other'}, {projectId:'two',modelSelection:{model:'bad'}}]) assert.equal('isError' in store.enforce(store.active('room','bob'),tool,args),true);
    store.replace(peer,[{toolPattern:'*',effect:'allow',argLocks:{provider:'conflict'}}]);
    assert.match(JSON.stringify(store.enforce(store.active('room','bob'),tool,input)),/conflicting locks/);
    store.replace(peer,[{toolPattern:'*',effect:'allow',argLocks:{modelSelection:{model:'other'}}}]);
    assert.equal('isError' in store.enforce(store.active('room','bob'),tool,input),true);
  } finally {db.close();}
});
test('rejects pollution, malformed and oversized policies atomically', () => {
 const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
 try {
  store.replace(global,[{toolPattern:'*',effect:'deny'}]);
  for(const key of ['__proto__','constructor','prototype','a.__proto__.x']) for(const field of ['argDefaults','argLocks','argAllowValues']) assert.throws(()=>store.replace(global,JSON.parse(`[{"toolPattern":"*","effect":"allow","${field}":{"${key}":${field==='argAllowValues'?'[]':'1'}}}]`)));
  for(const value of [[{toolPattern:'x'.repeat(129),effect:'allow'}],[{toolPattern:'*',effect:'invalid'}],[{toolPattern:'*',effect:'allow',argAllowValues:{x:'no'}}],Array(101).fill({}),[{toolPattern:'*',effect:'allow',argDefaults:{x:'x'.repeat(65536)}}]]) assert.throws(()=>store.replace(global,value));
  assert.equal(store.list(global)[0].effect,'deny');
  assert.throws(()=>store.list({scopeKind:'global',scopeId:'bad'}));
 } finally {db.close();}
});

test('dot paths are validated independently from JSON value keys', () => {
  const db = new DatabaseSync(':memory:'); const store = new ToolPolicyStore(db);
  try {
    const value = { '.gitignore': 'dist/', '': 'empty key', 'literal.dot': 'value' };
    const rules = store.replace(global, [{toolPattern:'*',effect:'allow',argDefaults:{files:value},argLocks:{headers:value},argAllowValues:{headers:[value]}}]);
    assert.deepEqual(store.enforce(rules,tool,{files:value}), {args:{files:value,headers:value}});
    for (const path of ['', '.hidden', 'a..b', 'a.', 'a.__proto__.x', 'constructor']) {
      for (const field of ['argDefaults','argLocks','argAllowValues']) assert.throws(()=>store.replace(global,[{toolPattern:'*',effect:'allow',[field]:{[path]:field==='argAllowValues'?[value]:value}}]));
    }
    for (const key of ['__proto__','constructor','prototype']) {
      const unsafe = JSON.parse(`{"files":{"${key}":{}}}`);
      assert.equal('isError' in store.enforce(rules,tool,unsafe),true);
      assert.throws(()=>store.replace(global,[{toolPattern:'*',effect:'allow',argDefaults:{files:unsafe}}]));
    }
  } finally {db.close();}
});
