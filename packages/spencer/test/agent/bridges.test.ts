import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findT3, t3Tools } from "../../src/bridges/t3.ts";
import { VIA, spencerTools } from "../../src/bridges/spencer.ts";
import { McpManager } from "../../src/agent/mcp.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "spencer-bridge-"));
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;

test("findT3: T3_BIN, then PATH, then the newest ~/.t3 runtime version", () => {
  const home = tmp();
  try {
    for (const v of ["0.1.9", "0.1.10", "0.2.0-beta"]) mkdirSync(join(home, ".t3/runtime/versions", v), { recursive: true });
    writeFileSync(join(home, ".t3/runtime/versions/0.1.9/t3"), "");
    writeFileSync(join(home, ".t3/runtime/versions/0.1.10/t3"), "");
    for (const v of ["0.1.9", "0.1.10"]) writeFileSync(join(home, ".t3/runtime/versions", v, ".install-complete"), "");
    mkdirSync(join(home, ".t3/runtime/versions/0.1.11"));
    writeFileSync(join(home, ".t3/runtime/versions/0.1.11/t3"), "");
    assert.equal(findT3({ PATH: "" }, home), join(home, ".t3/runtime/versions/0.1.10/t3"), "numeric order; a version without t3 or still installing is skipped");
    mkdirSync(join(home, ".t3/bin"), { recursive: true });
    writeFileSync(join(home, ".t3/bin/t3"), "");
    assert.equal(findT3({ PATH: "" }, home), join(home, ".t3/bin/t3"));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin/t3"), "");
    assert.equal(findT3({ PATH: join(home, "bin") }, home), join(home, "bin/t3"));
    assert.equal(findT3({ T3_BIN: "/opt/t3", PATH: join(home, "bin") }, home), "/opt/t3");
    assert.equal(findT3({ PATH: "" }, join(home, "nope")), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spencer mcp t3: tools run the t3 CLI (message on stdin) and report its errors", async () => {
  const dir = tmp();
  const bin = join(dir, "t3");
  // A fake t3: prints its arguments and stdin; `thread show bad` fails like the real one.
  writeFileSync(bin, '#!/bin/sh\nif [ "$3" = bad ]; then echo "thread bad not found" >&2; exit 1; fi\nif [ "$5" = late ]; then echo \'{"threadId":"th-late-1","link":"https://t3/th-late-1"}\'; echo boom >&2; exit 1; fi\necho "$*" >> "$0.calls"\necho "args: $*"\necho "stdin: $(cat)"\n');
  chmodSync(bin, 0o755);
  const mgr = new McpManager({ t3code: { command: process.execPath, args: [MAIN, "mcp", "t3"], env: { T3_BIN: bin, T3_PROJECT: "/work/proj" } } });
  try {
    mgr.start();
    await mgr.settled();
    assert.deepEqual(
      mgr.status()[0]!.tools.map((t) => t.name),
      ["mcp__t3code__thread_list", "mcp__t3code__thread_start", "mcp__t3code__thread_send", "mcp__t3code__thread_show"],
    );
    assert.match((await mgr.call("t3code", "thread_list", {})).text, /^args: thread list --project \/work\/proj/);
    const started = await mgr.call("t3code", "thread_start", { message: "fix the 'bug'\nplease", title: "Fix", project: "." });
    assert.equal(started.isError, false);
    assert.match(started.text, /args: thread start --json --title Fix \. -/);
    assert.match(started.text, /stdin: fix the 'bug'\nplease/);
    assert.match(started.text, /runs in the background/);
    const options = await mgr.call("t3code", "thread_start", { message: "x", options: ["effort=high", "mode=auto"], generate_title: true });
    assert.match(options.text, /--option effort=high --option mode=auto --generate-title/);
    assert.match((await mgr.call("t3code", "thread_send", { thread: "t1", message: "go" })).text, /^Sent to thread t1\./);
    assert.deepEqual(await mgr.call("t3code", "thread_show", { thread: "bad" }), { text: "thread bad not found", isError: true });
    assert.deepEqual(await mgr.call("t3code", "thread_send", { thread: "t1" }), { text: "message is required", isError: true });
    const calls = () => readFileSync(`${bin}.calls`, "utf8").split("\n").length;
    const n = calls();
    assert.equal((await mgr.call("t3code", "thread_start", { message: "x", wait_seconds: "30s" })).isError, true);
    assert.equal(calls(), n, "a bad argument is caught before a thread is started");
    // t3 prints the new thread, then fails: the id still comes back, as a success.
    const late = await mgr.call("t3code", "thread_start", { message: "x", title: "late" });
    assert.equal(late.isError, false);
    assert.match(late.text, /^Started thread th-late-1 \(https:\/\/t3\/th-late-1\)\.\nt3 reported a problem after creating it \(boom\); do not start it again\./);
  } finally {
    await mgr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spencer mcp spencer: channels, reading and asking go through the local API with the token", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: 1, port: 7999 }));
  writeFileSync(join(dir, "api-token"), "tok\n");
  const owner: { id: string; role: string; text: string; ts: number }[] = [{ id: "o1", role: "assistant", text: "old", ts: 1 }];
  const answers = new Map<string, string>();
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    assert.equal((init.headers as Record<string, string>)["X-Spencer-Token"], "tok");
    assert.equal(u.host, "127.0.0.1:7999");
    calls.push(`${init.method} ${u.pathname}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (u.pathname === "/api/state")
      return json({
        me: { name: "Nick" },
        ownerBusy: false,
        channels: [
          { id: "c1", kind: "group", name: "Platform", unread: 2, autoReply: true, members: [{ me: true, presence: "online" }, { name: "Max", me: false, presence: "online" }] },
        ],
      });
    if (u.pathname === "/api/channels/c1/messages")
      return json({ items: [{ id: "m1", type: "chat", from: "x", fromName: "Max", mine: false, ts: 0, text: "hi", by: "agent", note: "not addressed" }] });
    if (u.pathname === "/api/owner/messages" && init.method === "POST") {
      const text = JSON.parse(String(init.body)).text as string;
      const sid = String(owner.length);
      owner.push({ id: `o${sid}`, role: "user", text, ts: 2 });
      // Answers arrive out of order: the later question is answered first.
      setTimeout(() => answers.set(sid, `answer to ${text.slice(VIA.length + 1)}`), text.endsWith("first") ? 1500 : 300);
      return json({ submissionId: sid });
    }
    const m = /^\/api\/owner\/answers\/(\d+)$/.exec(u.pathname);
    if (m) {
      const wait = Number(u.searchParams.get("wait") ?? 0) * 1000;
      const until = Date.now() + Math.min(wait, 200);
      while (!answers.has(m[1]!) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      return json(answers.has(m[1]!) ? { status: "done", text: answers.get(m[1]!) } : { status: "pending" });
    }
    if (u.pathname === "/api/owner/messages") return json({ items: owner });
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  const tools = Object.fromEntries(spencerTools(dir, fakeFetch).map((t) => [t.name, t]));
  try {
    assert.match(await tools.spencer_channels!.run({}), /- Platform \[c1\] group, 2 unread: Max \(online\)/);
    assert.match(await tools.spencer_read_channel!.run({ channel: "platform" }), /Max: hi \(no reply: not addressed\)/);
    await assert.rejects(tools.spencer_read_channel!.run({ channel: "nope" }), /no channel "nope". Channels: Platform \(c1\)/);
    const [a1, a2] = await Promise.all([
      tools.spencer_ask!.run({ message: "first", wait_seconds: 20 }),
      tools.spencer_ask!.run({ message: "second", wait_seconds: 20 }),
    ]);
    assert.deepEqual([a1, a2], ["answer to first", "answer to second"], "each caller gets only its own answer");
    assert.equal(owner[1]!.text, `${VIA} first`, "marked as coming from another agent");
    assert.match(await tools.spencer_ask!.run({ message: "slow first", wait_seconds: 0 }), /still working/);
    assert.ok(calls.includes("POST /api/owner/messages"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selfCommand uses the stable executable override", async () => {
  const { selfCommand } = await import("../../src/bridges/stdio-server.ts");
  const previous = process.env.SPENCER_BIN;
  try {
    process.env.SPENCER_BIN = "/stable/bin/spencer";
    assert.deepEqual(selfCommand(["mcp", "t3"]), { command: "/stable/bin/spencer", args: ["mcp", "t3"] });
  } finally {
    if (previous === undefined) delete process.env.SPENCER_BIN;
    else process.env.SPENCER_BIN = previous;
  }
});


test("liaison tools call the corresponding local API", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({port: 7999}));
  writeFileSync(join(dir, "api-token"), "tok");
  const calls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const u = new URL(url); calls.push(`${init.method} ${u.pathname}${u.search}`);
    if (u.pathname === "/api/state") return new Response(JSON.stringify({me:{name:"a"},channels:[{id:"c1",name:"Team",members:[]}]}));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  try {
    const tools = Object.fromEntries(spencerTools(dir, fake).map(t => [t.name,t]));
    await tools.spencer_publish_update!.run({title:"x",summary:"y"});
    await tools.spencer_work_brief!.run({status:"active"});
    await tools.spencer_read_peer!.run({id:"p"});
    await tools.spencer_add_memoir_note!.run({id:"p",text:"note"});
    await tools.spencer_send_file!.run({channel:"Team",path:"/tmp/file"});
    await tools.spencer_list_transfers!.run({channel:"Team"});
    assert.deepEqual(calls.filter(c => !c.includes("/api/state")), ["POST /api/work-brief", "GET /api/work-brief?status=active", "GET /api/peers/p/memoir", "POST /api/peers/p/notes", "POST /api/transfers", "GET /api/transfers?ch=c1"]);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('all channel-taking bridge tools reject ambiguous names but accept exact IDs', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({port:7999}));
  writeFileSync(join(dir, 'api-token'), 'tok');
  const writes: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/state') return new Response(JSON.stringify({channels:[
      {id:'one',name:'Team'}, {id:'two',name:'TEAM'},
    ]}));
    writes.push(path);
    return new Response(JSON.stringify({items:[],id:'message'}));
  }) as typeof fetch;
  try {
    const tools = Object.fromEntries(spencerTools(dir, fake).map(t => [t.name,t]));
    for (const name of ['spencer_send_file','spencer_list_transfers','spencer_post_channel','spencer_read_channel']) {
      const args = {channel:'team',path:'/artifact',text:'hello'};
      await assert.rejects(tools[name]!.run(args), /ambiguous.*explicit channel ID: one, two/);
      assert.equal(writes.length, 0);
    }
    await tools.spencer_send_file!.run({channel:'two',path:'/artifact'});
    assert.deepEqual(writes, ['/api/transfers']);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
