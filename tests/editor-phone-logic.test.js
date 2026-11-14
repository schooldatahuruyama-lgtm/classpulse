import test from 'node:test';
import assert from 'node:assert/strict';
import { clampItem } from '../js/model.js';
import { SHAPE_NAMES } from '../js/slide-render.js';
import {
  NARROW_QUERY, slideBarLabel, quickActions, itemRows, nudge, shouldMoveOnDown, shouldCloseSlidePanel,
} from '../js/views/editor/phone-logic.js';

test('せまい画面: 899px までを CSS と同じ条件で見る', () => {
  assert.equal(NARROW_QUERY, '(max-width: 899px)');
});

test('下の帯: 現在位置、選択なし、0 枚、不正な配列でも表示できる', () => {
  const order = Array.from({ length: 12 }, (_, i) => `s${i}`);
  assert.equal(slideBarLabel(order, 's2'), 'スライド（3／12 枚）');
  assert.equal(slideBarLabel(order, 'missing'), 'スライド（12 枚）');
  assert.equal(slideBarLabel(order, null), 'スライド（12 枚）');
  for (const value of [[], null, undefined, {}, 'abc']) assert.equal(slideBarLabel(value, null), 'スライド（0 枚）');
});

test('すぐ使うボタン: 文字だけ入力ボタンが先頭。削除は出さない', () => {
  assert.deepEqual(quickActions(null), []);
  assert.deepEqual(quickActions(undefined), []);
  assert.deepEqual(quickActions({ kind: 'text' }), ['type', 'settings', 'deselect']);
  for (const kind of ['image', 'shape']) assert.deepEqual(quickActions({ kind }), ['settings', 'deselect']);
});

test('要素の一覧: 重なりの上から、選択状態を付ける。入力を変更しない', () => {
  const items = Object.freeze([Object.freeze({ id: 'a', kind: 'text', text: '題' }), Object.freeze({ id: 'b', kind: 'image' })]);
  assert.deepEqual(itemRows(items, 'a'), [
    { id: 'b', label: '画像', selected: false }, { id: 'a', label: '文字: 題', selected: true },
  ]);
  assert.deepEqual(itemRows(items, 'a'), itemRows(items, 'a'), '同じ要素を二度選んでも外れない');
});

test('要素の一覧: 不正な入力・種類・本文でも例外にしない', () => {
  for (const value of [null, undefined, {}, 1, 'text']) assert.deepEqual(itemRows(value, null), []);
  assert.deepEqual(itemRows([null, { id: 'a', kind: 'unknown' }, { id: 'b', kind: 'text', text: 123 }], null), [
    { id: 'b', label: '文字: （空）', selected: false }, { id: 'a', label: '要素', selected: false },
  ]);
});

test('要素の一覧: 図形名は設定欄と同じ一つの定義を使う', () => {
  for (const [shape, name] of Object.entries(SHAPE_NAMES)) {
    assert.equal(itemRows([{ kind: 'shape', shape }])[0].label, `図形: ${name}`);
  }
  assert.equal(itemRows([{ kind: 'shape', shape: 'constructor' }])[0].label, `図形: ${SHAPE_NAMES.rect}`);
});

for (const [value, expected] of [
  ['あ'.repeat(12), 'あ'.repeat(12)],
  ['あ'.repeat(13), `${'あ'.repeat(12)}…`],
  ['😀'.repeat(12), '😀'.repeat(12)],
  ['😀'.repeat(13), `${'😀'.repeat(12)}…`],
  ['一\n   二\r\n\t三', '一 二 三'],
  ['\r\n \t\n', '（空）'],
  ['', '（空）'],
]) {
  test(`要素の一覧: ${JSON.stringify(value)} の抜粋`, () => {
    assert.equal(itemRows([{ kind: 'text', text: value }])[0].label, `文字: ${expected}`);
  });
}

const item = Object.freeze({ id: 'a', kind: 'image', x: 0.4, y: 0.3, w: 0.2, h: 0.2 });
for (const [dir, x, y] of [['left', 0.39, 0.3], ['right', 0.41, 0.3], ['up', 0.4, 0.29], ['down', 0.4, 0.31]]) {
  test(`位置: ${dir} は 1% ずつ、元の要素を変えない`, () => {
    const next = nudge(item, dir);
    assert.ok(Math.abs(next.x - x) < 1e-12);
    assert.ok(Math.abs(next.y - y) < 1e-12);
    assert.equal(next.w, item.w);
    assert.equal(next.h, item.h);
  });
}

test('位置: 知らない向きは元のまま。はみ出した箱は枠内へ収まる', () => {
  for (const dir of ['other', null, 'constructor']) assert.equal(nudge(item, dir), item);
  const next = nudge({ ...item, x: -10, y: 5, w: 2, h: -3 }, 'left');
  assert.deepEqual(next, clampItem(next));
});

for (const dir of ['left', 'right', 'up', 'down']) {
  test(`位置: ${dir} の端で連打しても同じ値で止まる`, () => {
    let next = item;
    for (let i = 0; i < 150; i++) next = nudge(next, dir);
    assert.deepEqual(nudge(next, dir), next);
    assert.deepEqual(clampItem(next), next);
    assert.equal(dir === 'left' ? next.x : dir === 'right' ? next.x + next.w : dir === 'up' ? next.y : next.y + next.h, ['left', 'up'].includes(dir) ? 0 : 1);
  });
}

for (const pointerType of ['touch', 'pen', 'mouse', '']) {
  test(`移動の開始: ${pointerType || '不明'} の画面幅と選択状態`, () => {
    assert.equal(shouldMoveOnDown({ narrow: true, pointerType, wasSelected: false }), pointerType === 'mouse');
    assert.equal(shouldMoveOnDown({ narrow: true, pointerType, wasSelected: true }), true);
    assert.equal(shouldMoveOnDown({ narrow: false, pointerType, wasSelected: false }), true);
  });
}

test('スライドのパネル: 選択・追加・複製だけ閉じる', () => {
  for (const action of ['select', 'add', 'duplicate']) assert.equal(shouldCloseSlidePanel(action), true);
  for (const action of ['up', 'down', 'delete', 'unknown', null]) assert.equal(shouldCloseSlidePanel(action), false);
});
