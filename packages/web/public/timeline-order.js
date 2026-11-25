/** Build a mixed timeline with transfer anchors that survive pagination and reloads. */
const anchorCache = new Map();
const anchorPrefix = "spencer.timeline-anchor.v6.";

export function timelineItems(messages, transfers, historyComplete = true, historyExpanded = false) {
  const orderedMessages = messages.every((m) => Number.isSafeInteger(m.seq))
    ? [...messages].sort((a, b) => a.seq - b.seq)
    : [...messages];
  const at = new Map();
  let maxSeq = 0;
  for (const m of orderedMessages) if (Number.isSafeInteger(m.seq)) maxSeq = Math.max(maxSeq, m.seq);
  const ids = new Map(orderedMessages.map((m, i) => [m.id, i]));

  for (const transfer of transfers) {
    let anchor = getAnchor(transfer);
    const targetId = anchor?.beforeId ?? anchor?.afterId;
    const anchorTargetLoaded = targetId && ids.has(targetId);
    const targetIndex = anchorTargetLoaded ? ids.get(targetId) : -1;
    const targetSeq = targetIndex >= 0 && Number.isSafeInteger(orderedMessages[targetIndex].seq) ? orderedMessages[targetIndex].seq : null;
    const targetChanged = anchorTargetLoaded && Object.hasOwn(anchor, "targetSeq") && anchor.targetSeq !== targetSeq;
    const firstId = orderedMessages[0]?.id ?? null;
    const provisionalBoundaryChanged = anchor?.provisional && (historyComplete || (historyExpanded && anchor.windowFirstId !== firstId));
    if (provisionalBoundaryChanged || ((!anchorTargetLoaded || targetChanged) && !Number.isSafeInteger(anchor?.boundarySeq))) {
      // Keep a provisional edge anchor stable across live updates. If older history changes
      // the first loaded message, or the history becomes complete, recompute from its wider
      // timestamp window and promote it to a durable anchor when complete.
      anchor = createAnchor(orderedMessages, transfer, maxSeq, historyComplete);
      saveAnchor(transfer, anchor);
    }
    const index = resolveAnchor(anchor, orderedMessages, ids);
    push(at, index, { ts: transfer.createdAt, t: transfer });
  }

  const items = [];
  for (let i = 0; i <= orderedMessages.length; i++) {
    items.push(...sortTransfers(at.get(i) ?? []));
    if (i < orderedMessages.length) items.push({ ts: orderedMessages[i].ts, m: orderedMessages[i] });
  }
  return items;
}

function createAnchor(messages, transfer, maxSeq, historyComplete) {
  const next = messages.find((m) => m.ts > transfer.createdAt);
  const last = messages.at(-1);
  const anchor = next
    ? {
        beforeId: next.id,
        boundarySeq: Number.isSafeInteger(next.seq) ? next.seq : null,
        targetSeq: Number.isSafeInteger(next.seq) ? next.seq : null,
      }
    : {
        afterId: last?.id,
        boundarySeq: maxSeq + 1,
        targetSeq: Number.isSafeInteger(last?.seq) ? last.seq : null,
      };
  return historyComplete ? anchor : { ...anchor, provisional: true, windowFirstId: messages[0]?.id ?? null };
}

function resolveAnchor(anchor, messages, ids) {
  const targetId = anchor?.beforeId ?? anchor?.afterId;
  const targetIndex = targetId && ids.has(targetId) ? ids.get(targetId) : -1;
  const targetSeq = targetIndex >= 0 && Number.isSafeInteger(messages[targetIndex].seq) ? messages[targetIndex].seq : null;
  if (targetIndex >= 0 && anchor.targetSeq === targetSeq) {
    return anchor.beforeId ? targetIndex : targetIndex + 1;
  }
  if (
    anchor?.afterId && targetIndex >= 0 && Number.isSafeInteger(targetSeq) &&
    Number.isSafeInteger(anchor.boundarySeq) && targetSeq >= anchor.boundarySeq
  ) return targetIndex + 1;
  if (Number.isSafeInteger(anchor?.boundarySeq)) {
    const next = messages.findIndex((m) => Number.isSafeInteger(m.seq) && m.seq >= anchor.boundarySeq);
    return next >= 0 ? next : messages.length;
  }
  if (anchor?.beforeId && targetIndex >= 0) return targetIndex;
  if (anchor?.afterId && targetIndex >= 0) return targetIndex + 1;
  return messages.length;
}

function storageKey(transfer) {
  return `${anchorPrefix}${transfer.ch ?? ""}.${transfer.tid ?? ""}`;
}

function getAnchor(transfer) {
  if (!transfer.tid) return undefined;
  const key = storageKey(transfer);
  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
  } catch {
    // Storage can be disabled; the in-memory cache still preserves route changes.
  }
  return anchorCache.get(key);
}

function saveAnchor(transfer, anchor) {
  if (!transfer.tid) return;
  const key = storageKey(transfer);
  anchorCache.set(key, anchor);
  try {
    localStorage.setItem(key, JSON.stringify(anchor));
  } catch {
    // Storage can be disabled; use the in-memory value for this page session.
  }
}

function push(map, key, item) {
  const items = map.get(key) ?? [];
  items.push(item);
  map.set(key, items);
}

function sortTransfers(items) {
  return items.sort((a, b) => a.ts - b.ts);
}
