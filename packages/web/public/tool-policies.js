import { h } from './dom.js';
import { api, attempt } from './api.js';

const EFFECTS = [
  ['allow', 'Allow'],
  ['ask_owner', 'Ask owner'],
  ['deny', 'Deny'],
];

const SCOPE_HINT = {
  peer: 'Rules narrow MCP tool access when this peer asks in a DM or group, including Full Trust. Strictest match wins (deny > ask owner > allow).',
  channel: 'Rules narrow MCP tool access in this channel, including Full Trust. Strictest match wins (deny > ask owner > allow).',
  global: 'Global rules narrow MCP tool access across all channels, including Full Trust. Strictest match wins (deny > ask owner > allow).',
};

/** Owner-only tool-level guardrail editor. */
export function toolGuardrails(kind, id) {
  const rows = h('div.tp-list');
  const status = h('p.hint.tp-status', null, 'Loading…');
  let loaded = false;
  function add(rule = {}) {
    const pattern = h('input.input.mono', { value: rule.toolPattern ?? '', placeholder: 'mcp__server__*', 'aria-label': 'Tool matcher', maxlength: 128 });
    const effect = h('select.input', { 'aria-label': 'Effect' }, ...EFFECTS.map(([value, label]) => h('option', { value, selected: value === (rule.effect ?? 'allow') }, label)));
    effect.value = rule.effect ?? 'allow';
    const row = h(
      'fieldset.tp-rule',
      null,
      h('legend.sr-only', null, 'Tool rule'),
      h(
        'div.tp-rule-head',
        null,
        h('label.tp-field.tp-grow', null, h('span.tp-label', null, 'Tool matcher'), pattern),
        h('label.tp-field.tp-effect', null, h('span.tp-label', null, 'Effect'), effect),
        h('button.btn.sm.tp-remove', { type: 'button', on: { click: () => row.remove() } }, 'Remove rule'),
      ),
    );
    row.policy = () => ({ ...(rule.id ? { id: rule.id } : {}), ...(rule.note ? { note: rule.note } : {}), toolPattern: pattern.value, effect: effect.value });
    rows.append(row);
  }
  const save = h('button.btn.primary', { type: 'button', disabled: true, on: { click: () => attempt(async () => {
    if (!loaded) return;
    const result = await api.setToolPolicies(kind, id, [...rows.children].map(row => row.policy()));
    rows.replaceChildren(); result.rules.forEach(add); status.textContent = 'Guardrails saved.';
  }) } }, 'Save guardrails');
  const addButton = h('button.btn', { type: 'button', disabled: true, on: { click: () => add() } }, 'Add rule');
  const section = h(
    'section.tp-section',
    null,
    h('div.tp-head', null, h('h3', null, 'Tool guardrails'), h('p.hint', null, SCOPE_HINT[kind] ?? SCOPE_HINT.channel)),
    rows,
    h('div.tp-actions', null, addButton, save, status),
  );
  void attempt(async () => {
    try {
      const result = await api.toolPolicies(kind, id);
      result.rules.forEach(add); loaded = true; save.disabled = false; addButton.disabled = false; status.textContent = '';
    } catch (err) {
      status.textContent = `Could not load guardrails: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  });
  return section;
}
