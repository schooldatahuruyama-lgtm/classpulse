import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, historySelection } from '../js/views/editor/history.js';

const snapshot = (n) => ({ deck: { title: String(n) }, slideId: `s${n}`, itemId: `i${n}` });

test('履歴: 空・null の記録は例外にせず、戻す先は null', () => {
  const h = createHistory();
  h.record(null, snapshot(1), 'text');
  h.record(snapshot(0), null, 'text');
  h.record(snapshot(0));
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
});

test('履歴: 教材の参照と変更前後の選択を保持し、undo・redo を往復する', () => {
  const h = createHistory();
  const a = snapshot(0); const b = snapshot(1); const c = snapshot(2);
  h.record(a, b); h.record(b, c);
  a.slideId = '選択を変更';
  c.itemId = '選択を変更';
  assert.deepEqual(h.undo(), b);
  const restored = h.undo();
  assert.equal(restored.deck, a.deck);
  assert.equal(restored.slideId, 's0');
  assert.equal(restored.itemId, 'i0');
  assert.equal(h.canUndo(), false);
  assert.deepEqual(h.redo(), b);
  const redone = h.redo();
  assert.equal(redone.deck, c.deck);
  assert.equal(redone.slideId, 's2');
  assert.equal(redone.itemId, 'i2');
  assert.equal(h.canRedo(), false);
});

for (const count of [50, 51]) {
  test(`履歴: ${count} 回の変更で保持するのは最新 50 回`, () => {
    const h = createHistory();
    for (let i = 0; i < count; i++) h.record(snapshot(i), snapshot(i + 1));
    for (let i = count - 1; i >= Math.max(0, count - 50); i--) {
      const current = h.undo();
      assert.equal(current.deck.title, String(i));
    }
    assert.equal(h.undo(), null);
    for (let i = Math.max(1, count - 49); i <= count; i++) {
      const current = h.redo();
      assert.equal(current.deck.title, String(i));
    }
    assert.equal(h.redo(), null);
  });
}

for (const gap of [999, 1000, 1001]) {
  test(`履歴: 同じ鍵の間隔 ${gap}ms の境界`, () => {
    let time = 0;
    const h = createHistory({ now: () => time });
    h.record(snapshot(0), snapshot(1), 'text'); time = gap; h.record(snapshot(1), snapshot(2), 'text');
    assert.equal(h.undo().deck.title, gap <= 1000 ? '0' : '1');
    assert.equal(h.canUndo(), gap > 1000);
    assert.deepEqual(h.redo(), snapshot(2));
  });
}

test('履歴: まとめた操作の時刻も更新し、別の鍵では分ける', () => {
  let time = 0;
  const h = createHistory({ now: () => time });
  h.record(snapshot(0), snapshot(1), 'text'); time = 900; h.record(snapshot(1), snapshot(2), 'text');
  time = 1800; h.record(snapshot(2), snapshot(3), 'text'); h.record(snapshot(3), snapshot(4), 'title');
  assert.equal(h.undo().deck.title, '3');
  assert.deepEqual(h.undo(), snapshot(0));
  assert.deepEqual(h.redo(), snapshot(3));
  assert.deepEqual(h.redo(), snapshot(4));
});

for (const key of [undefined, null, 1, {}, [], true]) {
  test(`履歴: 文字ではない鍵 ${JSON.stringify(key)} ではまとめない`, () => {
    const h = createHistory({ now: () => 0 });
    h.record(snapshot(0), snapshot(1), key); h.record(snapshot(1), snapshot(2), key);
    assert.equal(h.undo().deck.title, '1');
    assert.equal(h.undo().deck.title, '0');
  });
}

test('履歴: 空文字も文字の鍵として扱い、breakGroup の後は分ける', () => {
  const h = createHistory({ now: () => 0 });
  h.record(snapshot(0), snapshot(1), ''); h.record(snapshot(1), snapshot(2), '');
  h.breakGroup(); h.record(snapshot(2), snapshot(3), '');
  assert.equal(h.undo().deck.title, '2');
  assert.equal(h.undo().deck.title, '0');
});

test('履歴: undo・redo 後の変更は新しい記録になり、redo を消す', () => {
  const h = createHistory({ now: () => 0 });
  h.record(snapshot(0), snapshot(1), 'text'); h.undo();
  h.record(snapshot(0), snapshot(2), 'text');
  assert.equal(h.canRedo(), false);
  h.undo(); h.redo();
  h.record(snapshot(2), snapshot(3), 'text');
  assert.equal(h.undo().deck.title, '2');
});

test('履歴: clear は両側とまとめを消す。limit・groupMs を指定できる', () => {
  let time = 0;
  const h = createHistory({ limit: 2, groupMs: 10, now: () => time });
  for (let i = 0; i < 3; i++) { h.record(snapshot(i), snapshot(i + 1), 'text'); time += 11; }
  h.undo(); h.undo();
  assert.equal(h.canUndo(), false);
  h.clear(); h.record(snapshot(4), snapshot(5), 'text');
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo().deck.title, '4');
});

const deck = { order: ['a', 'b', 'c'], slides: { a: { items: [{ id: 'text' }] }, b: { items: [] }, c: { type: 'poll' } } };
for (const [slideId, itemId, expected] of [
  ['a', 'text', { slideId: 'a', itemId: 'text' }],
  ['a', 'missing', { slideId: 'a', itemId: null }],
  ['a', null, { slideId: 'a', itemId: null }],
  ['c', 'text', { slideId: 'c', itemId: null }],
  ['missing', 'text', { slideId: 'b', itemId: null }],
  [null, null, { slideId: 'b', itemId: null }],
  [undefined, 'text', { slideId: 'b', itemId: null }],
  [1, 'text', { slideId: 'b', itemId: null }],
  [['a'], 'text', { slideId: 'b', itemId: null }],
  ['__proto__', 'text', { slideId: 'b', itemId: null }],
]) {
  test(`履歴の選択: 記録した ${slideId}/${itemId} の有無で復元先を決める`, () => {
    assert.deepEqual(historySelection({ deck, slideId, itemId }, { deck, slideId: 'b' }), expected);
  });
}

test('履歴の選択: 近いスライドは現在の位置。枚数が減れば末尾、現在位置が無ければ先頭', () => {
  const snapshot = { deck, slideId: 'missing', itemId: 'text' };
  assert.deepEqual(historySelection(snapshot, { deck: { order: ['a', 'b', 'c', 'd'] }, slideId: 'd' }), { slideId: 'c', itemId: null });
  assert.deepEqual(historySelection(snapshot, { deck, slideId: null }), { slideId: 'a', itemId: null });
});

test('履歴の選択: スライドが0枚なら両方の選択を外す', () => {
  assert.deepEqual(historySelection({ deck: { order: [], slides: {} }, slideId: 'a', itemId: 'text' }, { deck, slideId: 'a' }), { slideId: null, itemId: null });
});
