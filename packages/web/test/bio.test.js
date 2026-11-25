import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document, Node: browser.Node, HTMLElement: browser.HTMLElement, localStorage: browser.localStorage, MutationObserver: browser.MutationObserver, matchMedia: browser.matchMedia.bind(browser), requestAnimationFrame: () => 0 });
const originalInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { S, applyBioEvent } = await import("../public/state.js");
const { api } = await import("../public/api.js");
const { bioView } = await import("../public/bio.js");
const { peersView } = await import("../public/peers.js");
const { channelView } = await import("../public/channel.js");
const { closeModal } = await import("../public/modal.js");
const { parseHash, hashFor } = await import("../public/router.js");
globalThis.setInterval = originalInterval;
const flush = () => new Promise(resolve => setImmediate(resolve));
const c = { id: "team", name: "Team", kind: "direct", trust: "standard", members: [{ id: "bob", name: "Bob", fingerprint: "aaaa-bbbb-cccc-dddd-eeee", me: false }], autoReply: false, shareBio: true, allowedMcpTools: [] };
const peer = { ...c.members[0], about: "# Public bio\n<script>bad()</script>", aboutAt: 1000, channels: [{ ...c, about: "Channel-specific scope", aboutAt: 1000 }] };
function mount() { document.body.innerHTML = '<div id="modal-root"></div><main></main>'; return document.querySelector("main"); }
function button(root, text) { return [...root.querySelectorAll("button")].find(b => b.textContent === text); }
api.peers = async () => ({ peers: [peer] });
api.memoir = async () => ({...peer,bio:peer.about,rules:"",notes:[]});
api.mcp = async () => ({ servers: [] });

test("Bio route is a clean raw markdown editor without Work Brief clutter and saves/reverts", async () => {
  S.experimental = false;
  assert.deepEqual(parseHash("#/bio"), { name: "bio" });
  assert.equal(hashFor({ name: "peers" }), "#/peers");
  let status = { text: "", maxChars: 2000, sharedChannels: [c] };
  api.bio = async () => status;
  api.setBio = async text => status = { ...status, text: text.trim() };
  const main = mount(); const view = bioView(main); await flush();
  assert.match(main.textContent, /never put secrets, private IPs, or sensitive paths/);
  assert.match(main.textContent, /shared with your channels by default/i);
  assert.doesNotMatch(main.textContent, /Work Brief|Add work item/);
  button(main, "Start from a template").click();
  const editor = main.querySelector("textarea");
  assert.match(editor.value, /Who I am[\s\S]*What I can help with[\s\S]*How to ask me[\s\S]*What I won't do/);
  editor.value = "😀".repeat(1001); editor.dispatchEvent(new browser.Event("input"));
  assert.match(main.textContent, /2002 \/ 2000 chars/); assert.equal(button(main, "Save").disabled, true);
  editor.value = "Public scope"; editor.dispatchEvent(new browser.Event("input"));
  button(main, "Save").click(); await flush(); assert.equal(status.text, "Public scope");
  editor.value = "Unsaved"; editor.dispatchEvent(new browser.Event("input")); button(main, "Revert").click(); assert.equal(editor.value, "Public scope");
  applyBioEvent({ type: "bio", bio: { ...status, text: "Live scope" } }); assert.equal(editor.value, "Live scope");
  view.destroy();
});

test("Peers directory aligns inside page-body, hides peer BIO.md, and opens Memoir", async () => {
  const main = mount(); const view = peersView(main); await flush();
  assert.ok(main.querySelector(".page-body"));
  assert.match(main.textContent, /Bob/); assert.match(main.textContent, /Team/);
  assert.doesNotMatch(main.textContent, /Public bio|No bio shared yet|BIO\.md/);
  assert.equal(main.querySelector("script"), null);
  assert.ok(main.querySelector("h1"));
  button(main, "Show Memoir").click(); await flush();
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Memoir/);
  assert.doesNotMatch(dialog.textContent, /Their BIO\.md|Public bio|Peer Card/);
  closeModal(); view.destroy();
});

test("DM sidebar shows Memoir without exposing peer BIO, and Channel settings defaults Share my Bio on", async () => {
  const main = mount(); S.channels.set(c.id, c); S.messages.set(c.id, []);
  S.peerBios.clear(); const view = channelView(main, c.id); await flush();
  const sidebarText = main.querySelector(".members").textContent;
  assert.match(sidebarText, /Memoir[\s\S]*Show Memoir/);
  assert.doesNotMatch(sidebarText, /Bio & Memoir|Channel-specific scope|No bio shared yet|Open Peer Card/);
  main.querySelector(".member[role=button]").click(); await flush();
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Memoir/);
  assert.doesNotMatch(dialog.textContent, /Channel-specific scope|Their BIO\.md/);
  closeModal();
  const settings = button(main, "Channel settings"); settings.click(); await flush();
  const row = [...document.querySelectorAll("label.switch-row")].find(l => l.textContent.includes("Share my Bio"));
  assert.ok(row); assert.equal(row.querySelector("input").checked, true);
  assert.match(row.textContent, /older copy/);
  row.querySelector("input").checked = false;
  let patch;
  api.patchChannel = async (_ch, data) => { patch = data; return { ...c, ...data }; };
  document.querySelector("#settings-form").dispatchEvent(new browser.Event("submit", { cancelable: true })); await flush();
  assert.equal(patch.shareBio, false); view.destroy();
});

test("group sidebar shows Group Memoir with Show Memoir and peer rows open peer Memoir without BIO", async () => {
  const main = mount();
  S.channels.set(c.id, { ...c, kind: "group" }); S.messages.set(c.id, []);
  const view = channelView(main, c.id); await flush();
  assert.ok(button(main, "Show Memoir"));
  assert.equal(button(main, "Open Peer Card"), undefined);
  main.querySelector(".member[role=button]").click(); await flush();
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /Channel-specific scope|Their BIO\.md/);
  closeModal(); view.destroy();
});
