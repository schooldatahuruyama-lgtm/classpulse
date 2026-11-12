// 発表の画面: ワードクラウドの文字の大きさ・並び・色の決めごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudFontSize, cloudOrder, cloudTone, CLOUD_FONT, CLOUD_TONES } from '../js/views/present.js';

test('文字の大きさ: 全員が同じ人数なら、どの言葉も同じ大きさ', () => {
  assert.equal(cloudFontSize(3, 3, 3), CLOUD_FONT.same);
  assert.equal(cloudFontSize(1, 1, 1), CLOUD_FONT.same);
});

test('文字の大きさ: 最大の人数が最大の大きさ、最小の人数が最小の大きさ', () => {
  assert.equal(cloudFontSize(10, 1, 10), CLOUD_FONT.max);
  assert.equal(cloudFontSize(1, 1, 10), CLOUD_FONT.min);
  assert.equal(cloudFontSize(2, 2, 3), CLOUD_FONT.min);
  assert.equal(cloudFontSize(3, 2, 3), CLOUD_FONT.max);
});

test('文字の大きさ: 人数が多いほど大きい（間は最小と最大の間）', () => {
  let prev = -Infinity;
  for (let c = 1; c <= 30; c++) {
    const s = cloudFontSize(c, 1, 30);
    assert.ok(s >= prev, `${c}`);
    assert.ok(s >= CLOUD_FONT.min && s <= CLOUD_FONT.max);
    prev = s;
  }
  assert.ok(cloudFontSize(2, 1, 30) > cloudFontSize(1, 1, 30));
});

test('文字の大きさ: おかしな値でも、決まった範囲の数を返す', () => {
  for (const args of [[NaN, 1, 3], [5, 1, 3], [0, 1, 3], [1, undefined, 3], [1, 3, 1]]) {
    const s = cloudFontSize(...args);
    assert.ok(Number.isFinite(s) && s >= CLOUD_FONT.min && s <= CLOUD_FONT.max, String(args));
  }
});

const items = [
  { key: 'a', word: 'あ', count: 5 }, { key: 'b', word: 'い', count: 4 }, { key: 'c', word: 'う', count: 3 },
  { key: 'd', word: 'え', count: 2 }, { key: 'e', word: 'お', count: 1 }, { key: '%E3%81%AD%E3%81%93', word: 'ねこ', count: 1 },
];

test('並び: 言葉の鍵から決まり、渡された順・人数に左右されない。元の配列は変えない', () => {
  const copy = items.map((x) => ({ ...x }));
  const a = cloudOrder(items).map((x) => x.key);
  const b = cloudOrder([...items].reverse()).map((x) => x.key);
  const c = cloudOrder(items.map((x) => ({ ...x, count: 1 }))).map((x) => x.key);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(items, copy);
  assert.deepEqual([...a].sort(), items.map((x) => x.key).sort());
});

test('並び: 人数の多い順のままにはしない。言葉を足しても、ほかの言葉どうしの並びは変わらない', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, word: `w${i}`, count: 20 - i }));
  const order = cloudOrder(many).map((x) => x.key);
  assert.notDeepEqual(order, many.map((x) => x.key));
  const more = cloudOrder([...many, { key: 'new', word: 'new', count: 1 }]).map((x) => x.key).filter((k) => k !== 'new');
  assert.deepEqual(more, order);
});

test('並び: 空・配列でないものは空の配列', () => {
  assert.deepEqual(cloudOrder([]), []);
  assert.deepEqual(cloudOrder(null), []);
});

test('色: 言葉の鍵から決まり、0〜CLOUD_TONES-1。いくつかの色に分かれる', () => {
  const tones = new Set();
  for (let i = 0; i < 40; i++) {
    const t = cloudTone(`k${i}`);
    assert.equal(t, cloudTone(`k${i}`));
    assert.ok(Number.isInteger(t) && t >= 0 && t < CLOUD_TONES);
    tones.add(t);
  }
  assert.ok(tones.size > 1);
});
