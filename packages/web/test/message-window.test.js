import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMessageWindow } from "../public/message-window.js";

test("live acknowledgement refreshes through moved page cursors", async () => {
  const latest = Array.from({ length: 100 }, (_, index) => ({ id: `seq-${index + 4}` }));
  latest[0] = { id: "four" };
  latest[1] = { id: "five" };
  const older = [{ id: "pending" }];
  const requests = [];
  const current = ["pending", "five"];
  const loaded = await loadMessageWindow(async (before) => {
    requests.push(before);
    return { items: before === undefined ? latest : older };
  }, current, () => current);

  assert.deepEqual(requests, [undefined, "four"]);
  assert.deepEqual(loaded.map((message) => message.id), ["pending", ...latest.map((message) => message.id)]);
});

test("message-window reconciliation restarts when a message arrives during paging", async () => {
  const initialPage = Array.from({ length: 100 }, (_, index) => ({ id: `seq-${index + 4}` }));
  initialPage[0] = { id: "four" };
  initialPage[1] = { id: "five" };
  const refreshedPage = ["pending", "four", "five", "newer-arrival"].map((id) => ({ id }));
  let latestCalls = 0;
  let currentCalls = 0;
  const requests = [];
  const loaded = await loadMessageWindow(async (before) => {
    requests.push(before);
    if (before !== undefined) return { items: [{ id: "pending" }] };
    return { items: ++latestCalls === 1 ? initialPage : refreshedPage };
  }, ["pending", "five"], () => ++currentCalls === 1 ? ["pending", "five", "newer-arrival"] : ["pending", "five", "newer-arrival"]);

  assert.deepEqual(requests, [undefined, undefined]);
  assert.deepEqual(loaded.map((message) => message.id), refreshedPage.map((message) => message.id));
});

test("message-window reconciliation continues past a hundred pages", async () => {
  const pages = Array.from({ length: 101 }, (_, page) =>
    Array.from({ length: 100 }, (_, index) => ({ id: `page-${page}-${index}` })),
  );
  const cursorToPage = new Map(pages.slice(0, -1).map((page, index) => [page[0].id, index + 1]));
  let calls = 0;
  const loaded = await loadMessageWindow(async (before) => {
    calls++;
    const index = before === undefined ? 0 : cursorToPage.get(before);
    return { items: pages[index] };
  }, ["page-100-99"]);

  assert.equal(calls, 101);
  assert.equal(loaded.length, 10_100);
  assert.equal(loaded.at(-1).id, "page-0-99");
});
