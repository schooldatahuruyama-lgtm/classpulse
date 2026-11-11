import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, dataUrlBytes } from '../js/image.js';

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
