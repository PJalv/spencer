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

test('invalid visibility cannot overwrite an existing item; undefined preserves it', () => {
  const db = new DatabaseSync(':memory:'); const store = new WorkBriefStore(db);
  try {
    const original = store.upsert({key:'stable', title:'Public', summary:'safe', visibility:'public'});
    for (const visibility of [null, false, 42, {}, [], '', 'PRIVATE']) {
      assert.throws(() => store.upsert(JSON.parse(JSON.stringify({key:'stable', summary:'SECRET', visibility}))), /visibility/);
      assert.deepEqual(store.list(), [original]);
    }
    assert.equal(store.upsert({key:'stable', summary:'updated', visibility:undefined}).visibility, 'public');
  } finally { store.stop(); db.close(); }
});

test('completed retention evicts the oldest completed items and preserves live items', () => {
  const db = new DatabaseSync(':memory:'); const store = new WorkBriefStore(db);
  try {
    const active = store.upsert({title:'active', summary:'live'});
    const blocked = store.upsert({title:'blocked', summary:'live', status:'blocked'});
    const first = store.upsert({key:'old', title:'old', summary:'done', status:'done'});
    db.prepare('UPDATE work_brief_items SET updated_at=0 WHERE id=?').run(first.id);
    for (let i=0; i<25; i++) store.upsert({title:`done ${i}`, summary:'done', status:'done'});
    assert.equal(store.list({status:'done'}).length, 25);
    assert.ok(!store.list().some(i => i.id === first.id));
    assert.ok(store.list().some(i => i.id === active.id));
    assert.ok(store.list().some(i => i.id === blocked.id));
    store.upsert({status:'done'}, active.id);
    assert.equal(store.list({status:'done'}).length, 25);
    assert.equal(store.list().length, 26);
  } finally { store.stop(); db.close(); }
});
