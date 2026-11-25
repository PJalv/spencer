// Fetch the contiguous API window needed to keep already-loaded messages and their cursor together.
export async function loadMessageWindow(fetchPage, requiredIds, currentIds = () => []) {
  const required = new Set(requiredIds);
  const found = new Set();
  const loaded = [];
  let before;

  while (true) {
    const response = await fetchPage(before);
    const page = response?.items ?? [];
    if (!page.length) return null;
    let requiredChanged = false;
    for (const id of currentIds()) {
      if (!required.has(id)) {
        required.add(id);
        requiredChanged = true;
      }
    }
    if (requiredChanged) {
      loaded.length = 0;
      found.clear();
      before = undefined;
      continue;
    }
    loaded.unshift(...page);
    for (const message of page) found.add(message.id);
    if ([...required].every((id) => found.has(id))) return loaded;
    if (page.length < 100 || page[0].id === before) return null;
    before = page[0].id;
  }
}
