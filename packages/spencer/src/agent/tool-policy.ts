import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type ToolPolicyScope = { scopeKind: 'global' | 'channel' | 'peer'; scopeId: string };
export interface ToolPolicy extends ToolPolicyScope {
  id: string; toolPattern: string; effect: 'allow' | 'ask_owner' | 'deny';
  argDefaults?: Record<string, unknown>; argLocks?: Record<string, unknown>;
  argAllowValues?: Record<string, unknown[]>; note?: string; updatedAt: number;
}
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function safe(v: unknown): void {
  if (Array.isArray(v)) { v.forEach(safe); return; }
  if (object(v)) for (const [k, x] of Object.entries(v)) {
    if (k.split('.').some(p => forbidden.has(p) || !p)) throw new Error('Invalid policy argument path');
    safe(x);
  }
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
    const fields = new Set(['id', 'scopeKind', 'scopeId', 'toolPattern', 'effect', 'argDefaults', 'argLocks', 'argAllowValues', 'note', 'updatedAt']);
    if (Object.keys(r).some(k => !fields.has(k))) throw new Error('Unknown policy field');
    for (const key of ['argDefaults', 'argLocks', 'argAllowValues']) {
      if (r[key] !== undefined && !object(r[key])) throw new Error(`Invalid ${key}`);
    }
    if (object(r.argAllowValues) && Object.values(r.argAllowValues).some(v => !Array.isArray(v))) throw new Error('Allow-values must be arrays');
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 2000)) throw new Error('Invalid policy note');
    if (r.id !== undefined && (typeof r.id !== 'string' || !/^[\w-]{1,128}$/.test(r.id))) throw new Error('Invalid policy id');
    // The scope is supplied by the authenticated API route, never by the payload.
    return { ...r, ...scope, id: r.id ?? randomUUID(), updatedAt: Date.now() } as ToolPolicy;
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
function read(args: Record<string, unknown>, path: string): unknown {
  let v: unknown = args;
  for (const k of path.split('.')) { if (forbidden.has(k) || !object(v) || !Object.hasOwn(v, k)) return undefined; v = v[k]; }
  return v;
}
function write(args: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.'); let node = args;
  for (const k of keys.slice(0, -1)) {
    if (forbidden.has(k)) throw new Error('Forbidden argument path');
    if (node[k] === undefined) node[k] = {};
    if (!object(node[k])) throw new Error(`argument ${path} has a non-object parent`);
    node = node[k];
  }
  const key = keys.at(-1)!;
  if (forbidden.has(key)) throw new Error('Forbidden argument path');
  node[key] = structuredClone(value);
}
export class ToolPolicyStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS agent_tool_policies (scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, id TEXT NOT NULL, rule TEXT NOT NULL, PRIMARY KEY(scope_kind, scope_id, id))');
  }
  list(scope: ToolPolicyScope): ToolPolicy[] {
    validateScope(scope);
    return this.db.prepare('SELECT rule FROM agent_tool_policies WHERE scope_kind=? AND scope_id=? ORDER BY id').all(scope.scopeKind, scope.scopeId).map(row => JSON.parse(String(row.rule)) as ToolPolicy);
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
  all(): ToolPolicy[] { return this.db.prepare('SELECT rule FROM agent_tool_policies ORDER BY scope_kind, scope_id, id').all().map(row => JSON.parse(String(row.rule)) as ToolPolicy); }
  active(channel: string, peer?: string): ToolPolicy[] {
    return [...this.list({ scopeKind: 'global', scopeId: '*' }), ...this.list({ scopeKind: 'channel', scopeId: channel }), ...(peer ? this.list({ scopeKind: 'peer', scopeId: peer }) : [])];
  }
  effect(rules: ToolPolicy[], tool: string): ToolPolicy['effect'] {
    const matches = rules.filter(r => toolMatches(r.toolPattern, tool));
    return matches.some(r => r.effect === 'deny') ? 'deny' : matches.some(r => r.effect === 'ask_owner') ? 'ask_owner' : 'allow';
  }
  enforce(rules: ToolPolicy[], tool: string, input: unknown): { args: Record<string, unknown> } | { isError: true; text: string } {
    const fail = (text: string) => ({ isError: true as const, text: `Policy violation: ${text}` });
    const matching = rules.filter(r => toolMatches(r.toolPattern, tool));
    const effect = this.effect(matching, tool);
    if (effect === 'deny') return fail(`${tool} is denied for this peer/channel.`);
    if (effect === 'ask_owner') return fail(`${tool} requires owner approval. Call ask_owner with the complete request instead.`);
    try {
      if (!object(input)) return fail('tool arguments must be an object');
      safe(input);
      const args = structuredClone(input);
      for (const r of matching) for (const [path, value] of Object.entries(r.argDefaults ?? {})) if (read(args, path) === undefined) write(args, path, value);
      // Validate all supplied values before applying locks. Defaults cannot override a lock.
      for (const r of matching) for (const [path, value] of Object.entries(r.argLocks ?? {})) {
        const supplied = read(input, path);
        if (supplied !== undefined && !isDeepStrictEqual(supplied, value)) return fail(`argument ${path} is locked to ${JSON.stringify(value)} for this peer/channel.`);
        write(args, path, value);
      }
      // Checking the final object catches conflicting and overlapping locks across scopes.
      for (const r of matching) for (const [path, value] of Object.entries(r.argLocks ?? {})) if (!isDeepStrictEqual(read(args, path), value)) return fail(`conflicting locks on argument ${path}.`);
      for (const r of matching) for (const [path, values] of Object.entries(r.argAllowValues ?? {})) if (read(args, path) === undefined || !values.some(v => isDeepStrictEqual(v, read(args, path)))) return fail(`argument ${path} must be one of ${JSON.stringify(values)} for this peer/channel.`);
      return { args };
    } catch (e) { return fail(e instanceof Error ? e.message : 'invalid arguments'); }
  }
}

/** Let the wrapper supply policy-owned fields before the MCP server validates arguments. */
export function policyParameters(schema: object, rules: ToolPolicy[], tool: string): object {
  const copy: unknown = structuredClone(schema);
  if (!object(copy)) return schema;
  for (const rule of rules.filter(r => toolMatches(r.toolPattern, tool))) {
    for (const path of [...Object.keys(rule.argDefaults ?? {}), ...Object.keys(rule.argLocks ?? {})]) {
      let node = copy;
      const segments = path.split('.');
      for (const key of segments) {
        if (Array.isArray(node.required)) node.required = node.required.filter(v => v !== key);
        if (!object(node.properties) || !object(node.properties[key])) break;
        node = node.properties[key];
      }
    }
  }
  return copy;
}
