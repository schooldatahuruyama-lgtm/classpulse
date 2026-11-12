import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, dataUrlBytes, compressCanvas } from '../js/image.js';

test('fitSize: 横長の大きな画像は長辺を maxEdge にそろえ、縦横比を保つ', () => {
  assert.deepEqual(fitSize(4000, 3000, 1280), { width: 1280, height: 960 });
});

test('fitSize: 縦長の大きな画像は高さを maxEdge にそろえる', () => {
  assert.deepEqual(fitSize(3000, 4000, 1280), { width: 960, height: 1280 });
});

test('fitSize: もともと小さい画像はそのまま', () => {
  assert.deepEqual(fitSize(800, 600, 1280), { width: 800, height: 600 });
});

test('fitSize: とても細長い画像でも、短い辺は 1 以上の整数', () => {
  const r = fitSize(1281, 1, 1280);
  assert.equal(r.width, 1280);
  assert.ok(r.height >= 1);
  assert.ok(Number.isInteger(r.height));
});

test('fitSize: 結果はいつも整数', () => {
  const r = fitSize(1999, 1333, 1280);
  assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
  assert.ok(Math.max(r.width, r.height) <= 1280);
});

test('dataUrlBytes: データ URL の文字数を返す', () => {
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAAA'), 27);
  assert.equal(dataUrlBytes(''), 0);
});

// toDataURL の代わり: 画質ごとに決まった長さの JPEG のデータ URL を返し、呼ばれた画質を記録する
function fakeCanvas(lengthOf, type = 'data:image/jpeg') {
  const calls = [];
  return {
    calls,
    toDataURL(mime, q) {
      calls.push([mime, q]);
      const head = `${type};base64,`;
      return head + 'A'.repeat(Math.max(0, lengthOf(q) - head.length));
    },
  };
}

test('compressCanvas: 画質 0.85 から下げていき、上限以下になった所で返す', () => {
  const c = fakeCanvas((q) => Math.round(q * 1000));
  const url = compressCanvas(c, { maxBytes: 600 });
  assert.equal(dataUrlBytes(url), 550);
  assert.deepEqual(c.calls, [['image/jpeg', 0.85], ['image/jpeg', 0.75], ['image/jpeg', 0.65], ['image/jpeg', 0.55]]);
});

test('compressCanvas: 最初の画質で収まれば、それを返す', () => {
  const c = fakeCanvas(() => 100);
  assert.equal(dataUrlBytes(compressCanvas(c, { maxBytes: 100 })), 100);
  assert.equal(c.calls.length, 1);
});

test('compressCanvas: 画質 0.45 でも収まらなければ null（呼ぶ側が小さく描き直す）', () => {
  const c = fakeCanvas(() => 5000);
  assert.equal(compressCanvas(c, { maxBytes: 4999 }), null);
  assert.deepEqual(c.calls.map(([, q]) => q), [0.85, 0.75, 0.65, 0.55, 0.45]);
});

test('compressCanvas: JPEG にできなければ（PNG などが返れば）例外', () => {
  const c = fakeCanvas(() => 50, 'data:image/png');
  assert.throws(() => compressCanvas(c, { maxBytes: 1000 }), /JPEG/);
});
