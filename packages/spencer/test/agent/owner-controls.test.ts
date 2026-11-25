import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon.ts";
import { SpencerAgent } from "../../src/agent/agent.ts";
import type { FakeRequestInfo } from "../../src/agent/fake-brain.ts";

async function waitFor<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, label: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function apiJson<T = any>(port: number, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "X-Spencer-Token": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

test("owner controls: steer injects after tool round, withdraw removes queued follow-up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-steer-"));
  const requests: FakeRequestInfo[] = [];
  let releaseToolRequest!: () => void;
  let toolRequestEntered!: () => void;
  const toolEntered = new Promise<void>((r) => (toolRequestEntered = r));
  const toolGate = new Promise<void>((r) => (releaseToolRequest = r));
  let firstCall = true;

  const d = new Daemon({
    dataDir: dir,
    webRoot: null,
    config: {
      name: "Steer Spencer",
      relay: "ws://127.0.0.1:1/ws",
      http: { host: "127.0.0.1", port: 0 },
      model: { provider: "fake" },
    },
    agentFactory: (core) =>
      new SpencerAgent(core, {
        fakeHooks: {
          onRequest: (info) => requests.push(info),
          gate: async (info, signal) => {
            if (info.conversation === "owner" && firstCall && info.text === "/peers") {
              firstCall = false;
              toolRequestEntered();
              await new Promise<void>((resolve, reject) => {
                if (signal?.aborted) return reject(signal.reason);
                const onAbort = () => reject(signal!.reason);
                signal?.addEventListener("abort", onAbort, { once: true });
                void toolGate.then(() => {
                  signal?.removeEventListener("abort", onAbort);
                  resolve();
                });
              });
            }
          },
        },
      }),
  });

  try {
    await d.start();
    const port = d.port;
    const token = d.token;

    // 1. Start a tool-calling run ("/peers" calls list_peers, then enters post-tool turn).
    const r1 = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/messages", { text: "/peers" });
    assert.equal(r1.status, 200);
    await toolEntered;

    // Invalid mode is rejected with 400.
    const bad = await apiJson(port, token, "POST", "/api/owner/messages", { text: "oops", mode: "bogus" });
    assert.equal(bad.status, 400);

    // 2. While busy, submit a steer AND two queued follow-ups.
    const steer = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/messages", {
      text: "actually say hello instead",
      mode: "steer",
    });
    assert.equal(steer.status, 200);

    const f1 = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/messages", {
      text: "queued follow-up 1",
      mode: "followUp",
    });
    const f2 = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/messages", {
      text: "queued follow-up 2 (withdraw me)",
      mode: "followUp",
    });
    assert.equal(f1.status, 200);
    assert.equal(f2.status, 200);

    // Verify /api/state exposes ownerRun.queue with steer + both follow-ups.
    const state = await waitFor(async () => {
      const s = await apiJson<any>(port, token, "GET", "/api/state");
      return s.data.ownerRun?.queue?.length === 3 ? s.data : null;
    }, "three queued owner items");
    assert.equal(state.ownerRun.busy, true);
    assert.deepEqual(
      state.ownerRun.queue.map((q: any) => [q.mode, q.text]),
      [
        ["steer", "actually say hello instead"],
        ["followUp", "queued follow-up 1"],
        ["followUp", "queued follow-up 2 (withdraw me)"],
      ],
    );

    // 3. Withdraw the second queued follow-up before releasing the run.
    const wd = await apiJson<{ result: string }>(port, token, "DELETE", `/api/owner/queue/${f2.data.submissionId}`);
    assert.equal(wd.status, 200);
    assert.equal(wd.data.result, "aborted");

    // 4. Release the held run: the steer joins at the post-tools boundary, then f1 runs as follow-up, and f2 never runs.
    releaseToolRequest();

    const transcript = await waitFor(async () => {
      const s = await apiJson<any>(port, token, "GET", "/api/state");
      if (s.data.ownerBusy || s.data.ownerRun?.queue?.length) return null;
      const m = await apiJson<{ items: any[] }>(port, token, "GET", "/api/owner/messages?limit=50");
      return m.data.items.some((i) => i.role === "assistant" && i.text === "ok: queued follow-up 1") ? m.data.items : null;
    }, "steer and follow-up 1 settled");

    // Steer landed after the tool call and redirected the run's answer.
    assert.ok(transcript.some((i) => i.role === "assistant" && i.text === "ok: actually say hello instead"), "steer redirected the active run");
    assert.ok(transcript.some((i) => i.role === "assistant" && i.text === "ok: queued follow-up 1"), "follow-up 1 ran next");
    assert.equal(transcript.some((i) => i.text.includes("withdraw me")), false, "withdrawn follow-up never entered transcript");
    assert.equal(transcript.some((i) => i.text.includes("The model could not answer")), false, "withdrawal emitted no bogus error");
  } finally {
    releaseToolRequest();
    await d.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner controls: stop aborts active run and withdraws queue, then continue resumes cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-stop-"));
  let entered!: () => void;
  const runEntered = new Promise<void>((r) => (entered = r));
  let holdFirst = true;
  let abortedObserved = false;

  const d = new Daemon({
    dataDir: dir,
    webRoot: null,
    config: {
      name: "Stop Spencer",
      relay: "ws://127.0.0.1:1/ws",
      http: { host: "127.0.0.1", port: 0 },
      model: { provider: "fake" },
    },
    agentFactory: (core) =>
      new SpencerAgent(core, {
        fakeHooks: {
          gate: async (info, signal) => {
            if (info.conversation === "owner" && holdFirst) {
              holdFirst = false;
              entered();
              await new Promise<void>((_resolve, reject) => {
                if (signal?.aborted) {
                  abortedObserved = true;
                  return reject(signal.reason);
                }
                signal?.addEventListener(
                  "abort",
                  () => {
                    abortedObserved = true;
                    reject(signal.reason);
                  },
                  { once: true },
                );
              });
            }
          },
        },
      }),
  });

  try {
    await d.start();
    const port = d.port;
    const token = d.token;

    // Start a run that stays held in-flight.
    const r1 = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/messages", { text: "resume me later" });
    assert.equal(r1.status, 200);
    await runEntered;

    // Queue a follow-up behind it and verify /api/owner/continue rejects with 409 while busy.
    await apiJson(port, token, "POST", "/api/owner/messages", { text: "dropped on stop", mode: "followUp" });
    const busyCont = await apiJson(port, token, "POST", "/api/owner/continue");
    assert.equal(busyCont.status, 409);

    // Stop the active run.
    const stopRes = await apiJson<{ stopped: boolean }>(port, token, "POST", "/api/owner/stop");
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.data.stopped, true);
    assert.equal(abortedObserved, true, "abort signal reached the in-flight model call");

    // State settles idle with empty queue and canContinue = true.
    const afterStop = await waitFor(async () => {
      const s = await apiJson<any>(port, token, "GET", "/api/state");
      return !s.data.ownerBusy && s.data.ownerRun?.canContinue ? s.data : null;
    }, "idle with canContinue after stop");
    assert.deepEqual(afterStop.ownerRun.queue, []);
    assert.equal(afterStop.ownerRun.lastFailure?.reason, "aborted");

    // No noisy "The model could not answer (aborted)" error in the transcript.
    const midItems = (await apiJson<{ items: any[] }>(port, token, "GET", "/api/owner/messages?limit=50")).data.items;
    assert.equal(midItems.some((i) => i.text.includes("The model could not answer")), false);
    assert.equal(midItems.some((i) => i.text.includes("dropped on stop")), false);

    // Continue resumes the stopped user message and finishes cleanly.
    const cont = await apiJson<{ submissionId: string }>(port, token, "POST", "/api/owner/continue");
    assert.equal(cont.status, 200);
    assert.ok(cont.data.submissionId);

    const finalItems = await waitFor(async () => {
      const m = await apiJson<{ items: any[] }>(port, token, "GET", "/api/owner/messages?limit=50");
      return m.data.items.some((i) => i.role === "assistant" && i.text === "ok: resume me later") ? m.data.items : null;
    }, "continued answer");
    assert.ok(finalItems.some((i) => i.role === "assistant" && i.text === "ok: resume me later"));
  } finally {
    await d.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
