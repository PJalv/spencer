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

test("Bio route works without Experimental; editor counts UTF-16 and saves/reverts", async () => {
  S.experimental = false;
  assert.deepEqual(parseHash("#/bio"), { name: "bio" });
  assert.equal(hashFor({ name: "peers" }), "#/peers");
  let status = { text: "", maxChars: 2000, sharedChannels: [c] };
  api.bio = async () => status;
  api.setBio = async text => status = { ...status, text: text.trim() };
  const main = mount(); const view = bioView(main); await flush();
  assert.match(main.textContent, /never put secrets, private IPs, or sensitive paths/);
  assert.match(main.textContent, /Team · direct · standard/);
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

test("Peers directory renders safe markdown and updates from peer_bio events", async () => {
  const main = mount(); const view = peersView(main); await flush();
  assert.match(main.textContent, /Public bio/); assert.match(main.textContent, /Team/);
  assert.equal(main.querySelector("script"), null);
  assert.ok(main.querySelector("h1"));
  applyBioEvent({ type: "peer_bio", ch: c.id, id: "bob", about: "Updated", aboutAt: 2 }); await flush();
  button(main, "Open Peer Card").click(); await flush();
  assert.match(document.querySelector('[role="dialog"]').textContent, /Peer Card/);
  closeModal(); view.destroy();
});

test("DM Peer BIO snippet, peer row cards, channel-specific bio, and share toggle", async () => {
  const main = mount(); S.channels.set(c.id, c); S.messages.set(c.id, []);
  S.peerBios.clear(); const view = channelView(main, c.id); await flush();
  assert.match(main.querySelector(".members").textContent, /Bio & Memoir[\s\S]*Channel-specific scope/);
  main.querySelector(".member[role=button]").click(); await flush();
  assert.match(document.querySelector('[role="dialog"]').textContent, /Channel-specific scope/); closeModal();
  const settings = button(main, "Channel settings"); settings.click(); await flush();
  const row = [...document.querySelectorAll("label.switch-row")].find(l => l.textContent.includes("Share my BIO"));
  assert.ok(row); assert.match(row.textContent, /older copy/);
  row.querySelector("input").checked = false;
  let patch;
  api.patchChannel = async (_ch, data) => { patch = data; return { ...c, ...data }; };
  document.querySelector("#settings-form").dispatchEvent(new browser.Event("submit", { cancelable: true })); await flush();
  assert.equal(patch.shareBio, false); view.destroy();
});

test("group peer row opens its channel BIO without a DM snippet", async () => {
  const main = mount();
  S.channels.set(c.id, { ...c, kind: "group" }); S.messages.set(c.id, []);
  const view = channelView(main, c.id); await flush();
  assert.equal(button(main, "Open Peer Card"), undefined);
  main.querySelector(".member[role=button]").click(); await flush();
  assert.match(document.querySelector('[role="dialog"]').textContent, /Channel-specific scope/);
  closeModal(); view.destroy();
});

test("Work Brief submission preserves in-flight edits and prevents duplicate submits", async () => {
  api.bio = async () => ({text:"", sharedChannels:[]});
  api.workBrief = async () => ({items:[]});
  let finish; const calls = [];
  api.addWorkBrief = item => { calls.push(item); return new Promise(resolve => { finish = resolve; }); };
  const main = mount(); const view = bioView(main); await flush();
  try {
    const title = main.querySelector('[aria-label="Work title"]');
    const summary = main.querySelector('[aria-label="Work summary"]');
    const submit = button(main, "Add work item");
    title.value = 'submitted title'; summary.value = 'submitted summary';
    submit.click(); submit.click();
    assert.equal(submit.disabled, true);
    assert.equal(calls.length, 1);
    title.value = 'next title'; summary.value = 'next summary';
    finish({id:'new'}); await flush();
    assert.equal(title.value, 'next title'); assert.equal(summary.value, 'next summary');
    assert.equal(submit.disabled, false);
    submit.click(); finish({id:'second'}); await flush();
    assert.equal(title.value, ''); assert.equal(summary.value, '');
  } finally { view.destroy(); }
});
