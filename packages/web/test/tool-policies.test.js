import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const win=new Window({url:'http://localhost'});
Object.assign(globalThis,{window:win,document:win.document,Node:win.Node,HTMLElement:win.HTMLElement,localStorage:win.localStorage});
const {api}=await import('../public/api.js');
const {toolGuardrails}=await import('../public/tool-policies.js');
const flush=()=>new Promise(r=>setImmediate(r));
test('guardrails editor loads, edits, adds and removes generic rule constraints',async()=>{
 api.toolPolicies=async()=>({rules:[{id:'existing',toolPattern:'*delete*',effect:'deny',argLocks:{'selection.provider':'arbitrary'}}]});
 let saved;
 api.setToolPolicies=async(kind,id,rules)=>{saved={kind,id,rules};return {rules};};
 const root=toolGuardrails('peer','bob'); document.body.append(root); await flush();
 assert.match(root.textContent,/Tool guardrails/);
 assert.equal(root.querySelector('select').value,'deny');
 assert.match(root.querySelector('[aria-label="argLocks"]').value,/selection.provider/);
 const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
 button('Add rule').click(); assert.equal(root.querySelectorAll('fieldset').length,2);
 root.querySelectorAll('input')[1].value='mcp__any__launch';
 button('Remove rule').click(); button('Save guardrails').click(); await flush();
 assert.equal(saved.kind,'peer'); assert.equal(saved.rules[0].toolPattern,'mcp__any__launch');
 assert.match(root.textContent,/Guardrails saved/);
 root.remove();
});

test('blank and empty JSON maps are omitted while nonempty constraints survive', async () => {
 api.toolPolicies=async()=>({rules:[{toolPattern:'*',effect:'allow'}]});
 let saved;
 api.setToolPolicies=async(_kind,_id,rules)=>{saved=rules;return {rules};};
 const root=toolGuardrails('channel','room');document.body.append(root);await flush();
 root.querySelector('[aria-label="argDefaults"]').value=' \n ';
 root.querySelector('[aria-label="argLocks"]').value='{}';
 root.querySelector('[aria-label="argAllowValues"]').value='{"project":["one"]}';
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Save guardrails').click();await flush();
 assert.deepEqual(saved,[{toolPattern:'*',effect:'allow',argAllowValues:{project:['one']}}]);root.remove();
});
test('load errors replace the loading status and keep save disabled', async () => {
 api.toolPolicies=async()=>{throw new Error('offline');};
 const root=toolGuardrails('peer','bob');document.body.append(root);await flush();
 assert.match(root.textContent,/Could not load guardrails: offline/);
 assert.doesNotMatch(root.textContent,/Loading…/);
 assert.ok([...root.querySelectorAll('button')].find(b=>b.textContent==='Save guardrails').disabled);root.remove();
});
