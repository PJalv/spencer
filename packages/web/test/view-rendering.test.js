import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, {
  window: browser, document: browser.document, Node: browser.Node, HTMLElement: browser.HTMLElement,
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

test("quarantine cards provide download, safe text preview and inline deletion confirmation", async () => {
  const { transferCard } = await import("../public/transfers.js");
  const { api } = await import("../public/api.js");
  const t = { tid: "safe-file", ch: "a", direction: "in", peer: "peer", name: "source.txt", size: 10, state: "completed", path: "/quarantine/safe-file/source.txt", createdAt: Date.now(), updatedAt: Date.now() };
  const root = document.createElement("div"); root.id = "modal-root"; document.body.append(root);
  const card = transferCard(t); document.body.append(card);
  const button = label => [...card.querySelectorAll("button")].find(b => b.textContent === label);
  assert.ok(button("Download")); assert.ok(card.querySelector('[title="Copy path"]'));
  const original = api.transferPreview;
  api.transferPreview = async () => ({ name: t.name, kind: "text", content: '<script>unsafe()</script>' });
  try {
    button("Preview").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const code = document.querySelector(".document-preview pre code");
    assert.equal(code.textContent, '<script>unsafe()</script>'); assert.equal(code.querySelector("script"), null);
    api.transferPreview = async () => ({ name: "raster.png", kind: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" });
    button("Preview").click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".document-preview img").getAttribute("src"), "data:image/png;base64,aGVsbG8=");
    button("Delete file").click(); assert.ok(button("Confirm delete file"));
    assert.equal([...transferCard({ ...t, name: "unsafe.svg" }).querySelectorAll("button")].some(b => b.textContent === "Preview"), false);
  } finally { api.transferPreview = original; document.querySelectorAll(".modal-backdrop").forEach(el => el.remove()); card.remove(); root.remove(); }
});
