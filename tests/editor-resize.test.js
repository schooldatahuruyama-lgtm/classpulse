import test from 'node:test';
import assert from 'node:assert/strict';
import { resize } from '../js/views/editor/phone-logic.js';
import { clampItem, MIN_ITEM_SIZE, createShapeItem } from '../js/model.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
const original = Object.freeze({ id: 'test', x: 0.1, y: 0.2, w: 0.4, h: 0.2 });
const kinds = ['bigger', 'smaller', 'wider', 'narrower', 'taller', 'shorter'];
for (const [kind, w, h] of [
  ['bigger', 0.42, 0.21], ['smaller', 0.4 / 1.05, 0.2 / 1.05],
  ['wider', 0.42, 0.2], ['narrower', 0.38, 0.2], ['taller', 0.4, 0.22], ['shorter', 0.4, 0.18],
]) {
  test(`大きさ: ${kind} の歩幅と左上の固定、元の値を変更しない`, () => {
    const next = resize(original, kind);
    near(next.w, w); near(next.h, h);
    assert.equal(next.x, original.x); assert.equal(next.y, original.y); assert.equal(next.id, original.id);
  });
}

for (const [kind, item, w, h] of [
  ['bigger', { x: 0.59, y: 0.1, w: 0.4, h: 0.2 }, 0.41, 0.205],
  ['bigger', { x: 0.1, y: 0.795, w: 0.4, h: 0.2 }, 0.41, 0.205],
  ['smaller', { x: 0.2, y: 0.3, w: 0.102, h: 0.051 }, 0.1, 0.05],
  ['smaller', { x: 0.2, y: 0.3, w: 0.051, h: 0.102 }, 0.05, 0.1],
]) {
  test(`大きさ: ${kind} は片側の限界で比を保つ（${item.w}, ${item.y}）`, () => {
    const next = resize(item, kind);
    near(next.w, w); near(next.h, h); near(next.w / next.h, item.w / item.h);
    assert.equal(next.x, item.x); assert.equal(next.y, item.y);
    const again = resize(next, kind);
    near(again.w, w); near(again.h, h);
  });
}

for (const kind of kinds) {
  test(`大きさ: ${kind} を 300 回押しても端・最小で止まる`, () => {
    let item = original;
    for (let i = 0; i < 300; i++) item = resize(item, kind);
    assert.equal(item.x, original.x); assert.equal(item.y, original.y);
    assert.ok(item.w >= MIN_ITEM_SIZE && item.h >= MIN_ITEM_SIZE);
    assert.ok(item.w <= 1 - item.x && item.h <= 1 - item.y);
    assert.deepEqual(resize(item, kind), item);
    if (kind === 'bigger' || kind === 'smaller') near(item.w / item.h, original.w / original.h);
  });
}

for (const bad of [null, { w: '0.5', h: NaN }, { x: 10, y: -2, w: 3, h: -1 }, { w: Infinity, h: undefined }]) {
  test(`大きさ: 不正な値 ${JSON.stringify(bad)} は clampItem で正してから計算`, () => {
    for (const kind of kinds) assert.deepEqual(resize(bad, kind), resize(clampItem(bad), kind));
  });
}

for (const kind of [undefined, null, 'unknown', 'constructor', {}]) {
  test(`大きさ: 知らない種類 ${JSON.stringify(kind)} は同じ参照を返す`, () => {
    assert.equal(resize(original, kind), original);
  });
}

for (const shape of ['line', 'arrow']) {
  test(`大きさ: 細い図形 ${shape} も同じ最小サイズを使う`, () => {
    const item = { ...createShapeItem('shape', shape), w: 0.4, h: 0.001 };
    const next = resize(item, 'smaller');
    assert.equal(next.h, MIN_ITEM_SIZE); assert.equal(next.w, item.w);
    assert.equal(next.shape, shape);
  });
}
