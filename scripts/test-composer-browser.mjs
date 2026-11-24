import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

const cwd = process.cwd();
const browserBin = process.env.AGENT_BROWSER_BIN;
assert.ok(browserBin, "Set AGENT_BROWSER_BIN to the agent-browser executable");

const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const { port } = probe.address();
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

const session = `spencer-composer-${process.pid}`;
const server = spawn(process.execPath, ["packages/web/dev/mock-server.ts", String(port)], {
  cwd,
  stdio: ["ignore", "ignore", "pipe"],
  env: { PATH: process.env.PATH ?? "" },
});
let serverError = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverError += chunk; });

function browser(...args) {
  const result = spawnSync(browserBin, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_NAMESPACE: session },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `agent-browser ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function evaluateJson(source) {
  const lines = browser("eval", source).split("\n").filter(Boolean);
  const value = JSON.parse(lines.at(-1));
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* the local mock server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`local mock server did not start: ${serverError}`);
}

function textareaState(selector) {
  return evaluateJson(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error("composer textarea not found");
    return JSON.stringify({
      value: input.value,
      height: input.clientHeight,
      scrollHeight: input.scrollHeight,
      scrollTop: input.scrollTop,
      overflowY: getComputedStyle(input).overflowY,
      focused: document.activeElement === input,
    });
  })()`);
}

function singleRowHeight(selector) {
  return evaluateJson(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const reference = input.cloneNode(false);
    reference.style.removeProperty("height");
    reference.value = "short text";
    reference.style.position = "fixed";
    reference.style.visibility = "hidden";
    reference.style.left = "-10000px";
    reference.style.top = "0";
    document.body.append(reference);
    const height = reference.scrollHeight;
    reference.remove();
    return JSON.stringify(height);
  })()`);
}

function verifyComposer(selector, context) {
  const expectedSingleRowHeight = singleRowHeight(selector);
  const initial = textareaState(selector);
  assert.equal(initial.value, "", `${context}: initial composer should be empty`);
  assert.ok(initial.height > 0, `${context}: initial textarea must have a visible row`);
  assert.equal(initial.height, expectedSingleRowHeight, `${context}: untouched composer must match an independent one-row textarea`);
  assert.ok(initial.scrollHeight <= initial.height, `${context}: empty textarea must not overflow`);
  assert.equal(initial.scrollTop, 0, `${context}: empty textarea must not scroll internally`);

  const result = evaluateJson(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const dispatch = () => input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "short text";
    dispatch();
    const singleLine = { height: input.clientHeight, scrollHeight: input.scrollHeight };
    input.value = "";
    dispatch();
    const cleared = { height: input.clientHeight, scrollHeight: input.scrollHeight, scrollTop: input.scrollTop };
    input.value = Array.from({ length: 80 }, (_, i) => "line " + (i + 1)).join("\\n");
    dispatch();
    input.scrollTop = 120;
    const overflow = { height: input.clientHeight, scrollHeight: input.scrollHeight, scrollTop: input.scrollTop, overflowY: getComputedStyle(input).overflowY };
    input.value = "";
    dispatch();
    return JSON.stringify({ singleLine, cleared, overflow, reset: { height: input.clientHeight, scrollHeight: input.scrollHeight, scrollTop: input.scrollTop } });
  })()`);
  assert.equal(result.singleLine.height, expectedSingleRowHeight, `${context}: short input should use independent one-line height`);
  assert.ok(result.singleLine.scrollHeight <= result.singleLine.height, `${context}: short text should fit on one line`);
  assert.equal(result.cleared.height, expectedSingleRowHeight, `${context}: clearing should restore independent one-line height`);
  assert.ok(result.cleared.scrollHeight <= result.cleared.height, `${context}: cleared composer should not overflow`);
  assert.ok(result.overflow.height >= 219 && result.overflow.height <= 220, `${context}: long multiline input should grow to the 220px cap`);
  assert.ok(result.overflow.scrollHeight > result.overflow.height, `${context}: long multiline text should overflow the capped textarea`);
  assert.equal(result.overflow.overflowY, "auto", `${context}: genuine overflow must remain scrollable`);
  assert.ok(result.overflow.scrollTop > 0, `${context}: capped textarea should actually scroll`);
  assert.equal(result.reset.height, expectedSingleRowHeight, `${context}: clearing multiline text should restore independent one-line height`);
  assert.ok(result.reset.scrollHeight <= result.reset.height, `${context}: clearing multiline text should remove overflow`);
  assert.equal(result.reset.scrollTop, 0, `${context}: reset composer should return to the top`);
}

try {
  await waitForServer();
  browser("open", `http://127.0.0.1:${port}/`);
  browser("wait", "300");
  verifyComposer('textarea[aria-label="Message Spencer"]', "owner chat");

  browser("set", "viewport", "390", "844");
  const narrowSelector = 'textarea[aria-label="Message Spencer"]';
  const narrow = textareaState(narrowSelector);
  assert.equal(narrow.height, singleRowHeight(narrowSelector), "owner chat: narrow viewport must retain independent one-line height");
  assert.ok(narrow.scrollHeight <= narrow.height, "owner chat: narrow viewport must not introduce empty overflow");
  browser("set", "viewport", "1280", "800");

  browser("find", "text", "Bob's Spencer", "click");
  browser("wait", "250");
  verifyComposer('textarea[aria-label="Message as yourself"]', "direct chat");

  browser("find", "text", "Hot Takes", "click");
  browser("wait", "250");
  verifyComposer('textarea[aria-label="Message as yourself"]', "group chat");

  console.log("Browser composer checks passed: owner, direct and group chats; untouched/cleared states; capped scrolling; narrow owner layout.");
} finally {
  try { browser("close", "--all"); } catch { /* no browser context was started */ }
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else {
      server.once("exit", resolve);
      setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 2_000).unref();
    }
  });
}
