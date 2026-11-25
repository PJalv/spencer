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

test("typing indicators display peers and expire", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
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
  now += 4000;
  setTyping({ ch: c.id, from: "Cara", active: true, ts: now });
  now += 4000;
  assert.deepEqual(typingIn(c.id), ["Cara"]);
  view.destroy();
});


test("typing expiry uses receipt time and removes empty channel maps", async (t) => {
  const { setTyping, typingIn } = await import("../public/state.js");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ch = "typing-clock";
  setTyping({ ch, from: "Alice", active: true, ts: now + 3600_000 });
  now += 8000;
  assert.deepEqual(typingIn(ch), [], "sender clock cannot extend expiry");
  assert.equal(S.typing.has(ch), false, "expiry removes empty map");
});

test("clearing the last typing peer removes its channel map", async () => {
  const { setTyping, clearTyping } = await import("../public/state.js");
  const ch = "typing-stop-cleanup", now = Date.now();
  setTyping({ ch, from: "Alice", active: true, ts: now });
  clearTyping(ch, "Alice");
  assert.equal(S.typing.has(ch), false, "stop removes empty map");
});

test("removing a channel clears its typing peers", async () => {
  const { setTyping, removeChannel } = await import("../public/state.js");
  const ch = "typing-remove-cleanup", now = Date.now();
  setTyping({ ch, from: "Alice", active: true, ts: now });
  removeChannel(ch);
  assert.equal(S.typing.has(ch), false, "channel removal removes typing map");
});

test("typing ticks and peer transitions preserve member focus and unrelated DOM", async (t) => {
  const { setTyping } = await import("../public/state.js");
  const timers = [];
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (fn, ms) => { timers.push({ fn, ms }); return 0; });
  const c = { id: "typing-focus", kind: "group", members: ["Alice", "Bob"].map(name => ({ id: name, name })), trust: "standard", autoReply: false };
  S.channels.set(c.id, c); S.messages.set(c.id, []);
  const main = document.createElement("main");
  document.body.append(main);
  const view = channelView(main, c.id);
  try {
    const tick = timers.find(timer => timer.ms === 1000).fn;
    const list = main.querySelector(".member-list");
    const alice = list.children[0], bob = list.children[1];
    const bobStatus = bob.querySelector(".member-status");
    alice.focus();
    const assertStable = () => {
      assert.equal(document.activeElement, alice);
      assert.equal(main.querySelector(".member-list"), list);
      assert.equal(bob.querySelector(".member-status"), bobStatus);
    };
    tick(); assertStable();
    setTyping({ ch: c.id, from: "Alice", active: true, ts: now });
    assertStable();
    assert.equal(alice.querySelector(".member-status").textContent, "typing…");
    const activeStatus = alice.querySelector(".member-status");
    tick(); assertStable();
    assert.equal(alice.querySelector(".member-status"), activeStatus, "heartbeat tick does not rewrite unchanged status");
    now += 8000; tick(); assertStable();
    assert.notEqual(alice.querySelector(".member-status").textContent, "typing…");
    assert.equal(main.querySelector(".typing-bar").textContent, "");
  } finally { view.destroy(); main.remove(); }
});
