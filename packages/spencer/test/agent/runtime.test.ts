import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime, OWNER_KEY, type ToolSpec } from "../../src/agent/runtime.ts";
import { setupModels } from "../../src/agent/models.ts";
import type { FakeRequestInfo } from "../../src/agent/fake-brain.ts";

async function openRuntime(dir: string, db: DatabaseSync, requests: FakeRequestInfo[]) {
  const setup = await setupModels({ provider: "fake" }, { name: () => "Test Spencer", fakeHooks: { onRequest: (i) => requests.push(i) } });
  assert.equal(setup.error, undefined);
  const rt = new PiRuntime({ file: join(dir, "pi.sqlite"), db, models: () => setup.models, model: () => setup.ref });
  await rt.open();
  return rt;
}

test("runtime: submit + waitAnswer, requestId dedupe, close/reopen keeps conversations and transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-rt-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const requests: FakeRequestInfo[] = [];
  let rt = await openRuntime(dir, db, requests);
  try {
    await rt.configure(OWNER_KEY, { tools: [], instructions: "You are a test." });
    const sid = await rt.submitInput(OWNER_KEY, { content: "hello", requestId: "req-1" });
    const again = await rt.submitInput(OWNER_KEY, { content: "hello", requestId: "req-1" });
    assert.equal(again, sid, "same requestId → same submission");
    assert.deepEqual(await rt.waitAnswer(sid), { status: "done", text: "ok: hello" });
    assert.equal(requests.length, 1, "one model call");
    assert.equal(await rt.submitInput(OWNER_KEY, { content: "hello", requestId: "req-1" }), sid, "still deduped after the answer");
    assert.equal(requests.length, 1);

    // A channel conversation with a tool that sees its conversation key.
    const seen: string[] = [];
    const tool: ToolSpec = {
      name: "notify_owner",
      description: "test",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(args, ctx) {
        seen.push(`${ctx.conversationKey}:${args.text}`);
        return "noted";
      },
    };
    const chId = await rt.ensureConversation("ch:abc");
    assert.equal(await rt.ensureConversation("ch:abc"), chId);
    await rt.configure("ch:abc", { tools: [tool], instructions: "channel" });
    assert.deepEqual(await rt.offeredTools("ch:abc"), ["notify_owner"]);
    assert.deepEqual(await rt.offeredTools(OWNER_KEY), []);
    await rt.appendNote("ch:abc", { kind: "spencer.peer", data: { text: "n" }, modelText: "[note] x", requestId: "n-1" });
    await rt.appendNote("ch:abc", { kind: "spencer.peer", data: { text: "n" }, modelText: "[note] x", requestId: "n-1" });
    const peer = await rt.submitInput("ch:abc", { content: '<peer_message from="b">hi there</peer_message>', requestId: "m-1" });
    assert.deepEqual(await rt.waitAnswer(peer), { status: "done", text: "Echo from Test Spencer: hi there" });

    const before = await rt.transcript(OWNER_KEY, 50);
    assert.deepEqual(
      before.map((i) => [i.role, i.text]),
      [
        ["user", "hello"],
        ["assistant", "ok: hello"],
      ],
    );
    await rt.close();

    rt = await openRuntime(dir, db, requests);
    assert.equal(await rt.ensureConversation("ch:abc"), chId, "conversation id survives reopen");
    assert.deepEqual(await rt.transcript(OWNER_KEY, 50), before, "transcript survives reopen");
    assert.equal(await rt.submitInput(OWNER_KEY, { content: "hello", requestId: "req-1" }), sid, "dedupe survives reopen");
    const chItems = await rt.transcript("ch:abc", 50);
    assert.equal(chItems.filter((i) => i.role === "note" && i.text === "n").length, 1, "note written once");
    assert.equal(requests.length, 2);
    assert.deepEqual(seen, []);
  } finally {
    await rt.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime: a tool runs with its conversation key and is refused elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-rt-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const rt = await openRuntime(dir, db, []);
  try {
    const calls: string[] = [];
    const list: ToolSpec = {
      name: "list_peers",
      description: "test",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        calls.push(ctx.conversationKey);
        return "peers: none";
      },
    };
    await rt.configure(OWNER_KEY, { tools: [list], instructions: "owner" });
    await rt.configure("ch:x", { tools: [], instructions: "channel" });
    const sid = await rt.submitInput(OWNER_KEY, { content: "/peers", requestId: "p-1" });
    assert.deepEqual(await rt.waitAnswer(sid), { status: "done", text: "done: peers: none" });
    assert.deepEqual(calls, [OWNER_KEY]);
    const items = await rt.transcript(OWNER_KEY, 50);
    assert.deepEqual(
      items.map((i) => [i.role, i.toolName ?? null]),
      [
        ["user", null],
        ["tool", "list_peers"],
        ["tool", "list_peers"],
        ["assistant", null],
      ],
    );
    // The channel conversation never offers it, and a direct call from there would be refused.
    const sid2 = await rt.submitInput("ch:x", { content: "/tool list_peers {}", requestId: "p-2" });
    await rt.waitAnswer(sid2);
    assert.deepEqual(calls, [OWNER_KEY]);
  } finally {
    await rt.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime: an aborted waitAnswer releases its waiter, so repeated pending polls do not pile up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-rt-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const rt = await openRuntime(dir, db, []);
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ToolSpec = {
      name: "list_peers",
      description: "test",
      parameters: { type: "object", properties: {} },
      async execute() {
        await gate;
        return "peers: none";
      },
    };
    await rt.configure(OWNER_KEY, { tools: [slow], instructions: "owner" });
    const sid = await rt.submitInput(OWNER_KEY, { content: "/peers", requestId: "slow-1" });
    const waits = () => (rt as unknown as { waits: Set<unknown> }).waits.size;
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = rt.waitAnswer(sid, ac.signal);
      setTimeout(() => ac.abort(new Error("poll over")), 20);
      await assert.rejects(p, /poll over/);
      assert.equal(waits(), 0, `poll ${i + 1}: no waiter left behind`);
    }
    const done = new AbortController();
    done.abort(new Error("already over"));
    await assert.rejects(rt.waitAnswer(sid, done.signal), /already over/);
    release();
    assert.deepEqual(await rt.waitAnswer(sid), { status: "done", text: "done: peers: none" });
    assert.equal(waits(), 0);
  } finally {
    await rt.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime: pi.sqlite and its -wal/-shm are owner-only (0600), even under a permissive umask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-rt-perm-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const old = process.umask(0o022);
  let rt: PiRuntime | undefined;
  try {
    rt = await openRuntime(dir, db, []);
    await rt.configure(OWNER_KEY, { tools: [], instructions: "You are a test." });
    await rt.appendNote(OWNER_KEY, { kind: "spencer.note", data: { text: "x", ts: 1 } });
    const files = readdirSync(dir).filter((f) => f.startsWith("pi.sqlite"));
    assert.ok(files.includes("pi.sqlite"));
    for (const f of files) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  } finally {
    process.umask(old);
    await rt?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime: notes written with data.untrusted come back as OwnerItem.untrusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-rt-untrusted-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const rt = await openRuntime(dir, db, []);
  try {
    await rt.appendNote(OWNER_KEY, { kind: "spencer.note", data: { text: "from a peer", ts: 1, untrusted: true } });
    await rt.appendNote(OWNER_KEY, { kind: "spencer.note", data: { text: "ours", ts: 2 } });
    const items = await rt.transcript(OWNER_KEY, 10);
    const peer = items.find((i) => i.text === "from a peer")!;
    const ours = items.find((i) => i.text === "ours")!;
    assert.equal(peer.untrusted, true);
    assert.equal(ours.untrusted, undefined);
  } finally {
    await rt.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared tools keep object schemas and refresh structurally changed parameters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spencer-rt-schema-'));
  const db = new DatabaseSync(':memory:'); const requests: FakeRequestInfo[] = [];
  const rt = await openRuntime(dir,db,requests);
  const tool = (required: boolean): ToolSpec => ({name:'list_peers',description:'schema regression',parameters:{type:'object',properties:{text:{type:'string'}},...(required?{required:['text']}:{})},async execute(){return 'ok';}});
  const invoke = async (id:string) => {
    const sid = await rt.submitInput(OWNER_KEY,{content:'/peers',requestId:id});
    await rt.waitAnswer(sid);
    const schema = requests.at(-1)!.toolSchemas.find(t=>t.name==='list_peers')!.parameters;
    assert.equal(Reflect.get(schema,'type'),'object');
    assert.equal(Object.hasOwn(schema,'anyOf'),false);
    return schema;
  };
  try {
    await rt.configure(OWNER_KEY,{tools:[tool(false)],instructions:'owner'});
    await rt.configure('ch:one',{tools:[tool(false)],instructions:'channel'});
    await rt.configure('ch:two',{tools:[tool(false)],instructions:'channel'});
    assert.equal(Object.hasOwn(await invoke('schema-1'),'required'),false);
    await rt.configure('ch:one',{tools:[tool(true)],instructions:'channel updated'});
    assert.deepEqual(Reflect.get(await invoke('schema-2'),'required'),['text']);
    await rt.configure('ch:one',{tools:[tool(false)],instructions:'channel restored'});
    assert.equal(Object.hasOwn(await invoke('schema-3'),'required'),false);
  } finally {await rt.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
