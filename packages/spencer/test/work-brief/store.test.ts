import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { WorkBriefStore } from '../../src/work-brief.ts';

test('work brief upserts, filters, expires and enforces bounds', () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkBriefStore(db);
  const first = store.upsert({key:'repo:x', title:'one', summary:'hello\u0000world', visibility:'trusted'});
  assert.equal(first.summary, 'hello world');
  assert.equal(store.upsert({key:'repo:x', title:'two'}).id, first.id);
  assert.equal(store.list({visibility:'trusted'}).length, 1);
  assert.equal(store.list({visibility:'public'}).length, 0);
  assert.throws(() => store.upsert({title:'', summary:'x'}));
  assert.throws(() => store.upsert({title:'x', summary:'x', links:Array(11).fill('x')}));
  store.upsert({title:'expired', summary:'x', expiresAt: Date.now()-1});
  assert.equal(store.list().length, 1);
  for (let i=0; i<49; i++) store.upsert({title:String(i), summary:'x'});
  assert.throws(() => store.upsert({title:'overflow', summary:'x'}));
  db.close();
});
test('visibility slices keep private and trusted work out of peer prompts', () => {
  const db = new DatabaseSync(':memory:'); const store = new WorkBriefStore(db);
  for (const visibility of ['private','trusted','public'] as const) store.upsert({title:visibility, summary:visibility, visibility});
  const owner = store.prompt(['private','trusted','public']);
  const full = store.prompt(['trusted','public']);
  const standard = store.prompt(['public']);
  for (const term of ['private','trusted','public']) assert.ok(owner.includes(term));
  assert.ok(!full.includes('private') && full.includes('trusted') && full.includes('public'));
  assert.ok(!standard.includes('private') && !standard.includes('trusted') && standard.includes('public'));
  db.close();
});
