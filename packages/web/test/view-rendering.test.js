import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, {
  window: browser, document: browser.document, Node: browser.Node,
  localStorage: browser.localStorage, MutationObserver: browser.MutationObserver,
  matchMedia: browser.matchMedia.bind(browser), requestAnimationFrame: () => 0,
});
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { S } = await import("../public/state.js");
const { channelView } = await import("../public/channel.js");
const { ownerView } = await import("../public/owner.js");
const { autoGrow } = await import("../public/dom.js");
globalThis.setInterval = originalSetInterval;

test("channel members omit the absent conversation section", () => {
  const main = document.createElement("main");
  const c = { id: "a", kind: "group", members: [], trust: "standard", autoReply: false };
  S.channels.set(c.id, c);
  S.messages.set(c.id, []);
  const view = channelView(main, c.id);
  const members = main.querySelector(".members");
  assert.ok(members);
  assert.equal([...members.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent === "null"), false);
  assert.notEqual(main.querySelector("textarea").style.height, "0px");
  view.destroy();
});

test("owner composer has usable initial height before layout", () => {
  S.owner = [];
  const main = document.createElement("main");
  const view = ownerView(main);
  assert.notEqual(main.querySelector("textarea").style.height, "0px");
  view.destroy();
});

test("autoGrow uses measured height and caps it", () => {
  const ta = document.createElement("textarea");
  let height = 0;
  Object.defineProperty(ta, "scrollHeight", { get: () => height });
  autoGrow(ta);
  assert.equal(ta.style.height, "auto");
  height = 80;
  autoGrow(ta);
  assert.equal(ta.style.height, "80px");
  height = 300;
  autoGrow(ta);
  assert.equal(ta.style.height, "220px");
  height = 0;
  autoGrow(ta);
  assert.equal(ta.style.height, "auto");
});

test("typing indicators display peers and expire", async () => {
  const { setTyping, typingIn, clearTyping } = await import("../public/state.js");
  const main = document.createElement("main");
  const c = { id: "typing-test", kind: "group", members: ["Alice", "Bob", "Cara"].map(name => ({ id: name, name })), trust: "standard", autoReply: false };
  S.channels.set(c.id, c); S.messages.set(c.id, []);
  const view = channelView(main, c.id);
  setTyping({ ch: c.id, from: "Alice", active: true, ts: Date.now() });
  assert.equal(main.querySelector(".typing-bar").textContent, "Alice is typing…");
  setTyping({ ch: c.id, from: "Bob", active: true, ts: Date.now() });
  assert.equal(main.querySelector(".typing-bar").textContent, "Alice and Bob are typing…");
  setTyping({ ch: c.id, from: "Cara", active: true, ts: Date.now() });
  assert.equal(main.querySelector(".typing-bar").textContent, "3 people are typing…");
  clearTyping(c.id, "Alice");
  setTyping({ ch: c.id, from: "Bob", active: true, ts: Date.now() - 8000 });
  assert.deepEqual(typingIn(c.id), ["Cara"]);
  view.destroy();
});
