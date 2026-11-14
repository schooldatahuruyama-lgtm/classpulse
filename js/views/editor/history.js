// 編集画面を開いている間だけの履歴。教材は変更せず、変更前後の値への参照を持つ。
// 記録した選択が無ければ、現在の位置に近いスライドへ戻して要素の選択を外す。
export function historySelection(snapshot, current) {
  const { deck } = snapshot;
  const at = current.deck.order.indexOf(current.slideId);
  const slideId = typeof snapshot.slideId === 'string' && deck.order.includes(snapshot.slideId) && deck.slides[snapshot.slideId] ? snapshot.slideId
    : deck.order[Math.max(0, Math.min(at, deck.order.length - 1))] ?? null;
  const itemId = slideId === snapshot.slideId && deck.slides[slideId]?.items?.some((it) => it.id === snapshot.itemId) ? snapshot.itemId : null;
  return { slideId, itemId };
}

export function createHistory({ limit = 50, groupMs = 1000, now = Date.now } = {}) {
  const past = [];
  const future = [];
  let lastKey = null;
  let lastTime = 0;

  function breakGroup() { lastKey = null; }
  function copy(snapshot) { return { deck: snapshot.deck, slideId: snapshot.slideId, itemId: snapshot.itemId }; }
  function push(stack, entry) {
    stack.push(entry);
    if (stack.length > limit) stack.shift();
  }
  function travel(from, to, side) {
    breakGroup();
    if (!from.length) return null;
    const entry = from.pop();
    push(to, entry);
    return copy(entry[side]);
  }

  return {
    record(before, after, groupKey) {
      if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return;
      const time = now();
      const key = typeof groupKey === 'string' ? groupKey : null;
      if (!past.length || key === null || key !== lastKey || time - lastTime > groupMs) {
        push(past, { before: copy(before), after: copy(after) });
      } else past[past.length - 1].after = copy(after);
      lastKey = key;
      lastTime = time;
      future.length = 0;
    },
    undo: () => travel(past, future, 'before'),
    redo: () => travel(future, past, 'after'),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    breakGroup,
    clear() { past.length = 0; future.length = 0; breakGroup(); },
  };
}
