import { h } from './dom.js';
import { api, attempt } from './api.js';

/** Owner-only editor. JSON fields preserve arbitrary MCP argument names and values. */
export function toolGuardrails(kind, id) {
  const rows = h('div');
  const status = h('p.hint', null, 'Loading…');
  let loaded = false;
  function add(rule = {}) {
    const pattern = h('input', { value: rule.toolPattern ?? '', placeholder: 'mcp__server__*', 'aria-label': 'Tool matcher', maxlength: 128 });
    const effect = h('select', { 'aria-label': 'Effect' }, ...['allow', 'ask_owner', 'deny'].map(value => h('option', { value, selected: value === (rule.effect ?? 'allow') }, value)));
    effect.value = rule.effect ?? "allow";
    const json = {};
    const row = h('fieldset', null, h('legend', null, 'Tool rule'), h('label', null, 'Tool matcher ', pattern), h('label', null, ' Effect ', effect));
    for (const key of ['argDefaults', 'argLocks', 'argAllowValues']) {
      json[key] = h('textarea', { rows: 3, 'aria-label': key, value: JSON.stringify(rule[key] ?? {}, null, 2) });
      row.append(h('label', null, key + ' (JSON object)', json[key]));
    }
    row.append(h('button.btn', { type: 'button', on: { click: () => row.remove() } }, 'Remove rule'));
    row.policy = () => ({ ...(rule.id ? { id: rule.id } : {}), ...(rule.note ? { note: rule.note } : {}), toolPattern: pattern.value, effect: effect.value, ...Object.fromEntries(Object.entries(json).map(([k, el]) => [k, JSON.parse(el.value)])) });
    rows.append(row);
  }
  const save = h('button.btn', { type: 'button', disabled: true, on: { click: () => attempt(async () => {
    if (!loaded) return;
    const result = await api.setToolPolicies(kind, id, [...rows.children].map(row => row.policy()));
    rows.replaceChildren(); result.rules.forEach(add); status.textContent = 'Guardrails saved.';
  }) } }, 'Save guardrails');
  const addButton = h('button.btn', { type: 'button', disabled: true, on: { click: () => add() } }, 'Add rule');
  const section = h('section', null, h('h3', null, 'Tool guardrails'), h('p.hint', null, 'Rules narrow tool access, including Full Trust. Peer rules apply when this peer asks in a DM or group. The strictest effect and all argument constraints apply.'), rows, addButton, save, status);
  void attempt(async () => { const result = await api.toolPolicies(kind, id); result.rules.forEach(add); loaded = true; save.disabled = false; addButton.disabled = false; status.textContent = ''; });
  return section;
}
