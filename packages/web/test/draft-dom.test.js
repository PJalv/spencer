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
  KeyboardEvent: browser.KeyboardEvent,
  requestAnimationFrame: () => 0,
  localStorage: browser.localStorage,
});
const { createFilePicker, createDraftRecipientSelect, createDraftRemoveButton, refreshDraftRecipientOptions, scrollAfterAcceptedFile } = await import("../public/draft-dom.js");
const { getChannelDraftState, releaseRecipientAfterDefiniteFailure, removeDraft } = await import("../public/draft-state.js");
const { scrollKeeper } = await import("../public/scroll.js");
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { composer } = await import("../public/common.js");
globalThis.setInterval = originalSetInterval;

const member = (id, name) => ({ id, name, fingerprint: "aaaa-bbbb-cccc" });
const label = (m) => `${m.name} (${m.fingerprint.split("-").slice(0, 2).join("-")})`;

test("recipient updates keep the attached picker and current choice in the DOM", () => {
  const state = { recipient: "member-a", recipientLocked: false };
  const picker = createDraftRecipientSelect([member("member-a", "Alice")], label);
  const draftBox = document.createElement("div");
  draftBox.append(picker);
  document.body.append(draftBox);

  refreshDraftRecipientOptions(picker, state, [member("member-a", "Alice Cooper"), member("member-b", "Bob")], label);
  assert.equal(picker.parentElement, draftBox);
  assert.equal(picker.value, "member-a");
  assert.equal(picker.options[1].textContent, "Alice Cooper (aaaa-bbbb)");
  assert.equal(picker.options[2].value, "member-b");

  refreshDraftRecipientOptions(picker, state, [member("member-b", "Bob")], label);
  assert.equal(picker.parentElement, draftBox);
  assert.equal(picker.value, "");
  assert.equal(state.recipient, null);
  draftBox.remove();
});

test("dismissing an ambiguous draft unlocks the composer and recovers its pending text", async () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const uncertain = { file: { name: "possibly-sent.txt" }, status: "failed", uploadId: "stable-id", outcomeUnknown: true };
  state.drafts.push(uncertain);
  state.recipient = "member-a";
  state.recipientLocked = true;
  const recipientSelect = createDraftRecipientSelect([member("member-a", "Alice")], label);
  recipientSelect.value = "member-a";
  recipientSelect.disabled = true;
  const remove = createDraftRemoveButton(uncertain, () => {
    if (!removeDraft(state, uncertain)) return;
    recipientSelect.disabled = state.recipientLocked;
    view.sync();
  });
  assert.equal(remove.disabled, false);
  assert.equal(createDraftRemoveButton({ ...uncertain, status: "uploading" }, () => {}).disabled, true);
  const drafts = document.createElement("div");
  drafts.append(remove, recipientSelect);
  const textSent = [];
  const view = composer({
    label: "Message",
    drafts,
    canSend: () => state.drafts.some((draft) => draft.status !== "sent"),
    isBusy: () => state.sending,
    onSend: async (text) => {
      state.sending = true;
      try {
        if (state.drafts.some((draft) => draft.status !== "sent")) return false;
        textSent.push(text);
        return true;
      } finally {
        state.sending = false;
        releaseRecipientAfterDefiniteFailure(state);
      }
    },
  });
  document.body.append(view.form);
  view.input.value = "send this message";
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  view.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(textSent, []);
  assert.equal(view.input.value, "send this message");
  assert.equal(remove.disabled, false);

  remove.click();
  assert.deepEqual(state.drafts, []);
  assert.equal(state.recipientLocked, false);
  assert.equal(recipientSelect.disabled, false);
  view.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(textSent, ["send this message"]);
  assert.equal(view.input.value, "");
  view.destroy();
  view.form.remove();
});

test("typing leaves the draft DOM and live status untouched, and empty Send stays disabled", async () => {
  const drafts = document.createElement("div");
  const liveStatus = document.createElement("span");
  liveStatus.setAttribute("aria-live", "polite");
  liveStatus.textContent = "Ready to send";
  drafts.append(liveStatus);
  const observer = new MutationObserver(() => {});
  observer.observe(drafts, { childList: true, subtree: true, characterData: true });
  let sends = 0;
  const view = composer({
    placeholder: "Message",
    label: "Message",
    drafts,
    canSend: () => false,
    onSend: async () => { sends++; return true; },
  });
  document.body.append(view.form);
  const send = view.form.querySelector("button[type=submit]");
  assert.equal(send.disabled, true);

  view.input.value = "hello";
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
  assert.equal(drafts.parentElement, view.form);
  assert.equal(drafts.firstChild, liveStatus);
  assert.equal(liveStatus.textContent, "Ready to send");
  assert.deepEqual(observer.takeRecords(), []);
  assert.equal(send.disabled, false);

  view.input.value = "";
  view.input.dispatchEvent(new Event("input", { bubbles: true }));
  view.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.equal(send.disabled, true);
  assert.equal(sends, 0);
  observer.disconnect();
  view.destroy();
  view.form.remove();
});

test("a mounted composer cannot re-enter a send started by another mount", async () => {
  const state = { sending: false };
  let finish;
  let sends = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const onSend = async () => {
    sends++;
    state.sending = true;
    try { return await pending; } finally { state.sending = false; }
  };
  const first = composer({ label: "First", canSend: () => true, isBusy: () => state.sending, onSend });
  const second = composer({ label: "Second", canSend: () => true, isBusy: () => state.sending, onSend });
  document.body.append(first.form, second.form);
  first.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  second.sync();
  assert.equal(state.sending, true);
  assert.equal(second.form.querySelector("button[type=submit]").disabled, true);
  second.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(sends, 1);
  finish(true);
  await Promise.resolve();
  await Promise.resolve();
  first.destroy();
  second.destroy();
  first.form.remove();
  second.form.remove();
});

test("a successful file remains scrolled into view when a later file in the batch fails", async () => {
  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 200 },
  });
  scroller.scrollTop = 0;
  const oldScroller = document.createElement("div");
  Object.defineProperties(oldScroller, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 200 },
  });
  oldScroller.scrollTop = 0;
  const oldKeeper = scrollKeeper(oldScroller);
  const oldViewScroll = () => oldKeeper.toBottom();
  const scrollers = new Set([oldViewScroll]);
  const drafts = [{ status: "draft" }, { status: "draft" }];
  let attempts = 0;
  let resolveFirstUpload;
  const { uploadDraftBatch } = await import("../public/draft-batch.js");
  const pending = uploadDraftBatch(drafts, {
    isPresent: () => true,
    upload: async () => {
      if (++attempts === 2) throw new Error("network reset");
      return new Promise((resolve) => { resolveFirstUpload = () => resolve({ tid: "accepted" }); });
    },
    onSuccess: (draft) => {
      draft.status = "sent";
      scrollAfterAcceptedFile(scrollers, "");
    },
    onFailure: (draft) => { draft.status = "failed"; },
  });
  await Promise.resolve();
  assert.equal(typeof resolveFirstUpload, "function");
  scrollers.delete(oldViewScroll);
  const visibleKeeper = scrollKeeper(scroller);
  scrollers.add(() => visibleKeeper.toBottom());
  resolveFirstUpload();
  const ok = await pending;
  assert.equal(ok, false);
  assert.equal(drafts[0].status, "sent");
  assert.equal(oldScroller.scrollTop, 0);
  assert.equal(scroller.scrollTop, 900);
});

test("file picker opens and passes multiple selected files to the draft queue", () => {
  const received = [];
  const { input, button } = createFilePicker((files) => received.push(...files));
  let opened = false;
  input.click = () => { opened = true; };
  button.click();
  assert.equal(opened, true);
  const files = [new browser.File(["a"], "a.txt"), new browser.File(["b"], "b.txt")];
  Object.defineProperty(input, "files", { value: files });
  input.dispatchEvent(new browser.Event("change"));
  assert.deepEqual(received, files);
});

test("owner composer renders kbd send hint cleanly and includes an attach button", async () => {
  globalThis.requestAnimationFrame ??= () => 0;
  const { ownerView } = await import("../public/owner.js");
  const main = document.createElement("main");
  const view = ownerView(main);
  const hint = main.querySelector(".composer-hint");
  assert.ok(hint);
  assert.doesNotMatch(hint.textContent, /\[object /);
  assert.match(hint.textContent, /Attach or drop files/);
  assert.ok(hint.querySelector("kbd"));
  assert.ok(main.querySelector("button.attach"));
  assert.ok(main.querySelector("input[type=file]"));
  view.destroy();
});
