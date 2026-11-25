import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  Node: browser.Node,
  Event: browser.Event,
  MutationObserver: browser.MutationObserver,
});
const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { composer } = await import("../public/common.js");
globalThis.setInterval = originalSetInterval;

function installLayout(input, viewportWidth = () => 1280) {
  Object.defineProperties(input, {
    scrollHeight: {
      configurable: true,
      get() {
        if (!input.isConnected) return 0;
        const lines = Math.max(1, input.value.split("\n").length);
        return lines === 1 ? (viewportWidth() < 500 ? 38 : 37) : Math.ceil(lines * 22.5 + 14);
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        if (!input.isConnected) return 0;
        return Number.parseFloat(input.style.height) || 14;
      },
    },
  });
}

test("a newly mounted empty composer is sized before its first focus and after resize", () => {
  const view = composer({ label: "Message", onSend: async () => true });
  let viewportWidth = 1280;
  installLayout(view.input, () => viewportWidth);

  // Owner and peer draft renderers sync before their form is attached to the page.
  view.sync();
  document.body.append(view.form);
  view.input.focus();
  for (const frame of frames.splice(0)) frame(0);

  assert.equal(view.input.value, "");
  assert.equal(view.input.clientHeight, 37);
  assert.equal(view.input.scrollHeight, view.input.clientHeight);
  assert.equal(view.input.scrollTop, 0);

  viewportWidth = 390;
  window.dispatchEvent(new Event("resize"));
  assert.equal(view.input.clientHeight, 38);
  assert.equal(view.input.scrollHeight, view.input.clientHeight);
  assert.equal(view.input.scrollTop, 0);
  view.destroy();
  view.form.remove();
});

test("typing then clearing stays single-line, while capped multiline text overflows", () => {
  const view = composer({ label: "Message", onSend: async () => true });
  installLayout(view.input);
  document.body.append(view.form);
  for (const frame of frames.splice(0)) frame(0);

  view.input.value = "hello";
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(view.input.clientHeight, 37);
  assert.equal(view.input.scrollHeight, view.input.clientHeight);

  view.input.value = "";
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(view.input.value, "");
  assert.equal(view.input.clientHeight, 37);
  assert.equal(view.input.scrollHeight, view.input.clientHeight);

  view.input.value = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(view.input.clientHeight, 220);
  assert.ok(view.input.scrollHeight > view.input.clientHeight);
  view.destroy();
  view.form.remove();
});
