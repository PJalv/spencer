import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const win=new Window({url:'http://localhost'});
Object.assign(globalThis,{window:win,document:win.document,Node:win.Node,HTMLElement:win.HTMLElement,localStorage:win.localStorage});
const {api}=await import('../public/api.js');
const {toolGuardrails}=await import('../public/tool-policies.js');
const flush=()=>new Promise(r=>setImmediate(r));

test('guardrails editor loads, edits, adds and removes tool-level rules without JSON fields',async()=>{
 api.toolPolicies=async()=>({rules:[{id:'existing',toolPattern:'*delete*',effect:'deny',note:'keep me'}]});
 let saved;
 api.setToolPolicies=async(kind,id,rules)=>{saved={kind,id,rules};return {rules};};
 const root=toolGuardrails('peer','bob'); document.body.append(root); await flush();
 assert.match(root.textContent,/Tool guardrails/);
 assert.equal(root.querySelector('select').value,'deny');
 assert.equal(root.querySelectorAll('textarea').length,0);
 assert.equal(root.querySelectorAll('details').length,0);
 const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
 button('Add rule').click(); assert.equal(root.querySelectorAll('fieldset').length,2);
 root.querySelectorAll('input')[1].value='mcp__any__launch';
 root.querySelectorAll('select')[1].value='ask_owner';
 button('Remove rule').click(); button('Save guardrails').click(); await flush();
 assert.equal(saved.kind,'peer');
 assert.deepEqual(saved.rules,[{toolPattern:'mcp__any__launch',effect:'ask_owner'}]);
 assert.match(root.textContent,/Guardrails saved/);
 root.remove();
});

test('existing rule id and note round-trip cleanly on save', async () => {
 api.toolPolicies=async()=>({rules:[{id:'r1',toolPattern:'*',effect:'allow',note:'audit note'}]});
 let saved;
 api.setToolPolicies=async(_kind,_id,rules)=>{saved=rules;return {rules};};
 const root=toolGuardrails('channel','room');document.body.append(root);await flush();
 root.querySelector('select').value='deny';
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Save guardrails').click();await flush();
 assert.deepEqual(saved,[{id:'r1',note:'audit note',toolPattern:'*',effect:'deny'}]);root.remove();
});

test('load errors replace the loading status and keep save disabled', async () => {
 api.toolPolicies=async()=>{throw new Error('offline');};
 const root=toolGuardrails('peer','bob');document.body.append(root);await flush();
 assert.match(root.textContent,/Could not load guardrails: offline/);
 assert.doesNotMatch(root.textContent,/Loading…/);
 assert.ok([...root.querySelectorAll('button')].find(b=>b.textContent==='Save guardrails').disabled);root.remove();
});
