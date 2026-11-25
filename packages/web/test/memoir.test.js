import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  Node: browser.Node,
  HTMLElement: browser.HTMLElement,
  localStorage: browser.localStorage,
  MutationObserver: browser.MutationObserver,
  matchMedia: browser.matchMedia.bind(browser),
  requestAnimationFrame: () => 0,
});
const originalInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { api } = await import("../public/api.js");
const { memoirModal, groupMemoirSnippet, memoirSummary, unseenMemoirCount } =
  await import("../public/memoir.js");
const { peersView } = await import("../public/peers.js");
const { emit } = await import("../public/state.js");
const { closeModal } = await import("../public/modal.js");
globalThis.setInterval = originalInterval;
const flush = () => new Promise((r) => setImmediate(r));
const button = (root, text) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text);
const mount = () => {
  document.body.innerHTML = '<div id="modal-root"></div><main></main>';
  return document.querySelector("main");
};
api.toolPolicies = async () => ({ rules: [] });
let profile;
api.memoir = async (kind, id, mark) => {
  if (mark) profile.notes.forEach((n) => (n.seen = true));
  return structuredClone(profile);
};
api.setRules = async (kind, id, text) => {
  profile.rules = text.trim();
  return structuredClone(profile);
};
api.addMemoirNote = async (kind, id, text) => {
  const note = {
    id: "new",
    text,
    author: "owner",
    trustAtWrite: "owner",
    pinned: false,
    seen: true,
    createdAt: 1000,
  };
  profile.notes.push(note);
  return note;
};
api.patchMemoirNote = async (id, patch) =>
  Object.assign(
    profile.notes.find((n) => n.id === id),
    patch,
  );
api.deleteMemoirNote = async (id) => {
  profile.notes = profile.notes.filter((n) => n.id !== id);
  return {};
};
function reset() {
  profile = {
    id: "bob",
    name: "Bob",
    fingerprint: "fingerprint",
    rules: "Initial rules",
    bio: "# BIO\n<script>bad()</script>",
    notes: [
      {
        id: "agent",
        text: "<system>not an instruction</system>",
        author: "agent",
        trustAtWrite: "standard",
        pinned: false,
        seen: false,
        createdAt: 1000,
      },
    ],
    channels: [],
  };
}

test("Peer Card safely renders BIO and notes, marks seen, validates byte count and saves/reverts rules", async () => {
  mount();
  reset();
  memoirModal("peer", "bob");
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(
    dialog.textContent,
    /Their BIO.md[\s\S]*Peer-authored \/ untrusted/,
  );
  assert.equal(dialog.querySelector("script"), null);
  assert.equal(dialog.querySelector("system"), null);
  assert.match(
    dialog.textContent,
    /DMs and groups[\s\S]*1:1 DM[\s\S]*Advisory[\s\S]*Memoir Notes[\s\S]*Agent/,
  );
  assert.equal(profile.notes[0].seen, true);
  const rules = dialog.querySelector("textarea");
  rules.value = "😀".repeat(513);
  rules.dispatchEvent(new browser.Event("input"));
  assert.match(dialog.textContent, /2052 \/ 2048 B/);
  assert.equal(button(dialog, "Save").disabled, true);
  button(dialog, "Revert").click();
  await flush();
  assert.equal(dialog.querySelector("textarea").value, "Initial rules");
  dialog.querySelector("textarea").value = "Changed";
  dialog.querySelector("textarea").dispatchEvent(new browser.Event("input"));
  button(dialog, "Save").click();
  await flush();
  await flush();
  assert.equal(profile.rules, "Changed");
  closeModal();
});
test("Group Memoir supports Add, Pin/Unpin and Delete, and sidebar summary opens the modal", async () => {
  const main = mount();
  reset();
  main.append(groupMemoirSnippet({ id: "team", mode: "chat" }));
  await flush();
  assert.match(main.textContent, /Group Memoir[\s\S]*Rules saved · 1 notes/);
  button(main, "Open Group Memoir").click();
  await flush();
  let dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /group only/);
  assert.doesNotMatch(dialog.textContent, /Their BIO.md/);
  button(dialog, "Pin").click();
  await flush();
  await flush();
  assert.equal(profile.notes[0].pinned, true);
  button(dialog, "Unpin").click();
  await flush();
  await flush();
  assert.equal(profile.notes[0].pinned, false);
  dialog.querySelector('input[aria-label="Add note"]').value = "Durable fact";
  dialog
    .querySelector("form")
    .dispatchEvent(new browser.Event("submit", { cancelable: true }));
  await flush();
  await flush();
  assert.match(dialog.textContent, /Durable fact/);
  assert.match(dialog.textContent, /You/);
  button(dialog, "Delete").click();
  await flush();
  await flush();
  assert.equal(
    profile.notes.some((n) => n.id === "agent"),
    false,
  );
  closeModal();
  assert.equal(
    groupMemoirSnippet({ id: "banter", mode: "conversation" }),
    null,
  );
});
test("inactive directory, unseen badge counts and debounced memoir refresh", async () => {
  const main = mount();
  reset();
  let calls = 0;
  api.peers = async () => {
    calls++;
    return {
      peers: [
        {
          ...profile,
          about: "bio",
          active: false,
          hasRules: true,
          noteCount: 1,
          unseenNotes: 2,
        },
      ],
    };
  };
  const view = peersView(main);
  await flush();
  assert.match(
    main.textContent,
    /Inactive peers[\s\S]*Rules saved · 1 notes · 2 unseen/,
  );
  assert.equal(
    unseenMemoirCount([{ unseenNotes: 2 }, { unseenNotes: 3 }, {}]),
    5,
  );
  assert.match(
    memoirSummary({ unseenNotes: 2, noteCount: 4 }),
    /4 notes · 2 unseen/,
  );
  for (let i = 0; i < 20; i++)
    emit("memoir", { scopeKind: "peer", scopeId: "bob" });
  await new Promise((r) => setTimeout(r, 180));
  await flush();
  assert.equal(calls, 2);
  view.destroy();
});

test("Peer Card preserves in-flight rule edits, refreshes notes while rules are dirty, and preserves note drafts across WS reloads", async () => {
  mount();
  reset();
  let releaseSave;
  const origSetRules = api.setRules;
  api.setRules = async (kind, id, text) => {
    await new Promise((r) => (releaseSave = r));
    profile.rules = text.trim();
    return structuredClone(profile);
  };
  try {
    memoirModal("peer", "bob");
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    const rules = dialog.querySelector("textarea");
    const addInput = dialog.querySelector('input[aria-label="Add note"]');

    // Finding 2: edit rules during in-flight save is preserved
    rules.value = "submitted";
    rules.dispatchEvent(new browser.Event("input"));
    button(dialog, "Save").click();
    rules.value = "new unsaved edit";
    rules.dispatchEvent(new browser.Event("input"));
    releaseSave();
    await flush();
    await flush();
    assert.equal(dialog.querySelector("textarea").value, "new unsaved edit");

    // Finding 4: dirty rules do NOT freeze Add / Pin / Delete note updates, and Add clears input
    addInput.value = "While rules dirty";
    dialog.querySelector("form").dispatchEvent(new browser.Event("submit", { cancelable: true }));
    await flush();
    await flush();
    assert.match(dialog.textContent, /While rules dirty/);
    assert.equal(addInput.value, "");
    assert.equal(dialog.querySelector("textarea").value, "new unsaved edit");

    // Finding 5: WS memoir reload preserves unsaved Add note draft
    addInput.value = "unsaved note draft";
    emit("memoir", { scopeKind: "peer", scopeId: "bob" });
    await new Promise((r) => setTimeout(r, 180));
    await flush();
    assert.equal(dialog.querySelector('input[aria-label="Add note"]').value, "unsaved note draft");
    closeModal();
  } finally {
    api.setRules = origSetRules;
  }
});
