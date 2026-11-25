import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type ToolPolicyScope = { scopeKind: 'global' | 'channel' | 'peer'; scopeId: string };
export interface ToolPolicy extends ToolPolicyScope {
  id: string; toolPattern: string; effect: 'allow' | 'ask_owner' | 'deny';
  note?: string; updatedAt: number;
}
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const allowedFields = new Set(['id', 'scopeKind', 'scopeId', 'toolPattern', 'effect', 'note', 'updatedAt']);
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function safe(v: unknown): void {
  if (Array.isArray(v)) { v.forEach(safe); return; }
  if (object(v)) for (const [k, x] of Object.entries(v)) {
    if (forbidden.has(k)) throw new Error('Forbidden prototype key');
    safe(x);
  }
}
function fromRow(row: { rule?: unknown }): ToolPolicy {
  const r = JSON.parse(String(row.rule)) as ToolPolicy;
  return {
    id: r.id,
    scopeKind: r.scopeKind,
    scopeId: r.scopeId,
    toolPattern: r.toolPattern,
    effect: r.effect,
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
    updatedAt: r.updatedAt,
  };
}
export function validateScope(s: ToolPolicyScope): void {
  if (!['global', 'channel', 'peer'].includes(s.scopeKind) || (s.scopeKind === 'global' ? s.scopeId !== '*' : !/^[\w-]{1,128}$/.test(s.scopeId))) throw new Error('Invalid policy scope');
}
export function parsePolicies(value: unknown, scope: ToolPolicyScope): ToolPolicy[] {
  validateScope(scope);
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65536 || !Array.isArray(value) || value.length > 100) throw new Error('Policies must be an array of at most 100 rules (64 KiB)');
  safe(value);
  return value.map((r: unknown) => {
    if (!object(r) || typeof r.toolPattern !== 'string' || !r.toolPattern.length || r.toolPattern.length > 128 || /[\x00-\x20]/.test(r.toolPattern) || !['allow', 'ask_owner', 'deny'].includes(String(r.effect))) throw new Error('Invalid tool pattern or effect');
    if ((r.scopeKind !== undefined && r.scopeKind !== scope.scopeKind) || (r.scopeId !== undefined && r.scopeId !== scope.scopeId)) throw new Error('Rule scope must match the route');
    if (Object.keys(r).some(k => !allowedFields.has(k))) throw new Error('Unknown policy field');
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 2000)) throw new Error('Invalid policy note');
    if (r.id !== undefined && (typeof r.id !== 'string' || !/^[\w-]{1,128}$/.test(r.id))) throw new Error('Invalid policy id');
    // The scope is supplied by the authenticated API route, never by the payload.
    return {
      id: r.id ?? randomUUID(),
      ...scope,
      toolPattern: r.toolPattern,
      effect: r.effect as ToolPolicy['effect'],
      ...(r.note !== undefined ? { note: r.note } : {}),
      updatedAt: Date.now(),
    };
  });
}
/** Linear traversal without compiling caller-controlled regular expressions. */
export function toolMatches(pattern: string, name: string): boolean {
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < name.length) {
    if (i < pattern.length && pattern[i] === name[j]) { i++; j++; }
    else if (pattern[i] === '*') { star = i++; retry = j; }
    else if (star >= 0) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}
export class ToolPolicyStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS agent_tool_policies (scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, rule TEXT NOT NULL, PRIMARY KEY(scope_kind, scope_id, id))');
  }
  list(scope: ToolPolicyScope): ToolPolicy[] {
    validateScope(scope);
    return this.db.prepare('SELECT rule FROM agent_tool_policies WHERE scope_kind=? AND scope_id=? ORDER BY id').all(scope.scopeKind, scope.scopeId).map(fromRow);
  }
  replace(scope: ToolPolicyScope, value: unknown): ToolPolicy[] {
    const rules = parsePolicies(value, scope);
    if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Error('Duplicate policy id');
    this.db.exec('SAVEPOINT tool_policies');
    try {
      this.db.prepare('DELETE FROM agent_tool_policies WHERE scope_kind=? AND scope_id=?').run(scope.scopeKind, scope.scopeId);
      const insert = this.db.prepare('INSERT INTO agent_tool_policies VALUES (?,?,?,?)');
      for (const r of rules) insert.run(scope.scopeKind, scope.scopeId, r.id, JSON.stringify(r));
      this.db.exec('RELEASE tool_policies');
    } catch (e) { this.db.exec('ROLLBACK TO tool_policies; RELEASE tool_policies'); throw e; }
    return rules;
  }
  all(): ToolPolicy[] { return this.db.prepare('SELECT rule FROM agent_tool_policies ORDER BY scope_kind, scope_id, id').all().map(fromRow); }
  active(channel: string, peer?: string): ToolPolicy[] {
    return [...this.list({ scopeKind: 'global', scopeId: '*' }), ...this.list({ scopeKind: 'channel', scopeId: channel }), ...(peer ? this.list({ scopeKind: 'peer', scopeId: peer }) : [])];
  }
  effect(rules: ToolPolicy[], tool: string): ToolPolicy['effect'] {
    const matches = rules.filter(r => toolMatches(r.toolPattern, tool));
    return matches.some(r => r.effect === 'deny') ? 'deny' : matches.some(r => r.effect === 'ask_owner') ? 'ask_owner' : 'allow';
  }
  enforce(rules: ToolPolicy[], tool: string): { ok: true } | { isError: true; text: string } {
    const effect = this.effect(rules, tool);
    if (effect === 'deny') return { isError: true, text: `Policy violation: ${tool} is denied for this peer/channel.` };
    if (effect === 'ask_owner') return { isError: true, text: `Policy violation: ${tool} requires owner approval. Call ask_owner with the complete request instead.` };
    return { ok: true };
  }
}
