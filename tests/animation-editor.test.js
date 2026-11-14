import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorDom } from './helpers/editor-dom.js';
import { flush } from './helpers/resilience.js';
import { createTextItem, createShapeItem, normalizeShapeItem, normalizeDeck, SHAPE_KINDS } from '../js/model.js';
import { mount } from '../js/views/editor.js';

for (const [value, expected] of [
  ['文字', 0], ['3', 0], [2.7, 2], [-1, 0], [21, 20], [NaN, 0],
  [0, 0], [undefined, 0], [null, 0], [Infinity, 0], [1, 1], [2, 2], [20, 20],
]) {
  test(`図形の順番: ${String(value)} (${typeof value}) → ${expected}、直接補正と読みこみは同じ`, () => {
    for (const shape of SHAPE_KINDS) {
      const raw = { ...createShapeItem('shape', shape), step: value };
      const before = structuredClone(raw);
      const item = normalizeShapeItem(raw);
      assert.equal(item.step ?? 0, expected, shape);
      assert.equal(Object.hasOwn(item, 'step'), expected > 0, shape);
      assert.deepEqual(normalizeShapeItem(item), item);
      const deck = normalizeDeck({ order: ['a'], slides: { a: { type: 'content', items: [raw] } } });
      assert.deepEqual(deck.slides.a.items[0], item);
      assert.deepEqual(raw, before);
    }
  });
}

const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const pointer = (node, name, x = 10) => node.dispatch(name, {
  pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: 10,
});
let sequence = 0;

async function setup(t, { narrow = true, shape = 'rect' } = {}) {
  const h = editorDom(t, narrow);
  t.mock.method(Date, 'now', () => 100);
  let deck = normalizeDeck({ title: '順番の保持を確認', order: ['a'], slides: { a: { type: 'content', items: [
    { ...createTextItem('text'), text: '例の文字', x: 0.2, y: 0.2, w: 0.4, h: 0.3, step: 1 },
    { ...createShapeItem('shape', shape), step: 2 },
    { id: 'image', kind: 'image', imageId: 'picture', x: 0.2, y: 0.2, w: 0.4, h: 0.3, step: 3 },
  ] } }, images: { picture: 'data:image/png;base64,AA==' } });
  const saved = [];
  const ctx = { params: { deckId: `animation-retain-${++sequence}` }, auth: { user: { uid: 'teacher-test' } },
    repo: { deckState: async () => 'live', loadDeck: async () => normalizeDeck(deck),
      saveDeck: async (_, next) => { deck = JSON.parse(JSON.stringify(next)); saved.push(deck); } } };
  let stop = mount(h.root, ctx);
  h.cleanup(async () => { stop(); await flush(); });
  await flush();
  const save = async () => {
    h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); await flush();
    assert.ok(saved.length > 0);
    return saved.at(-1);
  };
  return { ...h, save,
    savedItem: async (id) => (await save()).slides.a.items.find((it) => it.id === id),
    select: (id) => h.root.querySelector(`[data-focus-key="ed-pick:${id}"]`).click(),
    pick: (key) => h.root.querySelector(`[data-focus-key="${key}"]`).click(),
    item: (id) => h.root.querySelector('.ed-center').querySelector(`[data-item-id="${id}"]`),
    label: () => h.root.querySelector('.ed-step-label').textContent,
    undo: () => h.root.querySelector('[aria-label="元に戻す"]').click(),
    redo: () => h.root.querySelector('[aria-label="やり直す"]').click(),
    reload: async () => { await save(); stop(); await flush(); stop = mount(h.root, ctx); await flush(); },
  };
}

for (const [shape, key, field, value] of [
  ['rect', 'ed-fill:#E8576A', 'fill', '#E8576A'],
  ['rect', 'ed-stroke:#E8576A', 'stroke', '#E8576A'],
  ['rect', 'ed-stroke-width:l', 'strokeWidth', 'l'],
  ['arrow', 'ed-dir:v', 'dir', 'v'],
  ['arrow', 'ed-head:both', 'head', 'both'],
]) {
  test(`編集 DOM: 図形の ${field} を変えても順番 2 を保存・再読込・Undo/Redo で保つ`, async (t) => {
    const h = await setup(t, { shape });
    h.select('shape');
    const before = { ...createShapeItem('shape', shape), step: 2 };
    h.pick(key);
    const changed = await h.savedItem('shape');
    assert.equal(changed[field], value);
    assert.equal(changed.step, 2);
    assert.equal(h.item('shape').dataset.stepRank, '2');
    assert.equal(h.label(), '順番 2（「次へ」の 2 回目で出る）');
    h.undo();
    assert.deepEqual(await h.savedItem('shape'), before);
    h.redo();
    assert.deepEqual(await h.savedItem('shape'), changed);
    // 順番自体を変えた履歴も、見た目の変更と分けて戻せる。
    h.pick('ed-step:plus');
    assert.equal((await h.savedItem('shape')).step, 3);
    h.undo();
    assert.deepEqual(await h.savedItem('shape'), changed);
    h.redo();
    assert.equal((await h.savedItem('shape')).step, 3);
    h.undo();
    await h.reload();
    h.select('shape');
    assert.equal(h.label(), '順番 2（「次へ」の 2 回目で出る）');
    assert.equal(h.item('shape').dataset.stepRank, '2');
    assert.deepEqual(await h.savedItem('shape'), changed);
  });
}

for (const [key, field, value] of [
  ['ed-size:l', 'size', 'l'], ['ed-bold', 'bold', true],
  ['ed-color:#E8576A', 'color', '#E8576A'], ['ed-align:center', 'align', 'center'],
]) {
  test(`編集 DOM: 文字の ${field} を変えても順番を保つ`, async (t) => {
    const h = await setup(t);
    h.select('text'); h.pick(key);
    const item = await h.savedItem('text');
    assert.equal(item[field], value);
    assert.equal(item.step, 1);
    assert.equal(h.item('text').dataset.stepRank, '1');
  });
}

for (const [id, step] of [['text', 1], ['shape', 2], ['image', 3]]) {
  test(`編集 DOM: ${id} の重なりの順番・位置と大きさの各ボタンで順番を保つ`, async (t) => {
    const h = await setup(t);
    h.select(id);
    // 画像は最初からいちばん前なので、先に後ろへ動かす。
    for (const front of id === 'image' ? [false, true] : [true, false]) {
      h.pick(`ed-layer:${front ? 'front' : 'back'}`);
      assert.equal((await h.save()).slides.a.items.at(front ? -1 : 0).id, id);
      assert.equal((await h.savedItem(id)).step, step);
    }
    for (const [key, field, sign] of [
      ['ed-nudge:left', 'x', -1], ['ed-nudge:right', 'x', 1],
      ['ed-nudge:up', 'y', -1], ['ed-nudge:down', 'y', 1],
      ['ed-resize:bigger', 'w', 1], ['ed-resize:smaller', 'w', -1],
      ['ed-resize:wider', 'w', 1], ['ed-resize:narrower', 'w', -1],
      ['ed-resize:taller', 'h', 1], ['ed-resize:shorter', 'h', -1],
    ]) {
      const before = await h.savedItem(id);
      h.pick(key);
      const after = await h.savedItem(id);
      assert.ok(sign * (after[field] - before[field]) > 0, key);
      assert.equal(after.step, step, key);
      assert.equal(h.item(id).dataset.stepRank, String(step), key);
    }
  });

  test(`編集 DOM: ${id} のドラッグとキーによる移動・サイズ変更で順番を保つ`, async (t) => {
    const h = await setup(t, { narrow: false });
    h.select(id);
    for (const resize of [false, true]) {
      const target = resize ? h.root.querySelector('.ed-handle') : h.item(id);
      const field = resize ? 'w' : 'x';
      const before = Number.parseFloat(h.item(id).style[resize ? 'width' : 'left']);
      pointer(target, 'pointerdown'); pointer(target, 'pointermove', 26); pointer(target, 'pointerup', 26);
      const afterDrag = await h.savedItem(id);
      assert.ok(afterDrag[field] * 100 > before);
      assert.equal(afterDrag.step, step);
      h.undo(); h.redo();
      assert.deepEqual(await h.savedItem(id), afterDrag);
      const nextTarget = resize ? h.root.querySelector('.ed-handle') : h.item(id);
      nextTarget.dispatch('keydown', { key: 'ArrowRight' });
      const afterKey = await h.savedItem(id);
      assert.ok(afterKey[field] > afterDrag[field]);
      assert.equal(afterKey.step, step);
    }
  });
}

for (const narrow of [true, false]) {
  test(`編集 DOM: 文字の入力中も順番を保つ（狭い=${narrow}）`, async (t) => {
    const h = await setup(t, { narrow });
    h.select('text'); h.item('text').dispatch('keydown', { key: 'Enter' });
    const ta = h.root.querySelector('textarea');
    ta.value = '入力を変える'; ta.dispatch('input');
    assert.equal((await h.savedItem('text')).text, '入力を変える');
    assert.equal((await h.savedItem('text')).step, 1);
  });

  test(`編集 DOM: 設定を開いたまま、とび・重複の表示回と印を更新（狭い=${narrow}）`, async (t) => {
    const h = await setup(t, { narrow });
    h.select('shape');
    h.pick('ed-step:minus'); // 文字と同じ 1 にすると、画像の 3 は 2 回目になる。
    assert.equal(h.label(), '順番 1（「次へ」の 1 回目で出る）');
    assert.equal(h.item('image').dataset.stepRank, '2');
    h.select('image');
    assert.equal(h.label(), '順番 3（「次へ」の 2 回目で出る）');
    h.pick('ed-step:minus');
    assert.equal(h.label(), '順番 2（「次へ」の 2 回目で出る）');
    h.pick('ed-step:minus');
    assert.equal(h.label(), '順番 1（「次へ」の 1 回目で出る）');
    assert.equal(h.item('image').dataset.stepRank, '1');
    h.undo();
    assert.equal(h.label(), '順番 3（「次へ」の 2 回目で出る）');
    h.redo();
    assert.equal(h.label(), '順番 1（「次へ」の 1 回目で出る）');
  });
}

test('編集 DOM: スライド複製で文字・図形・画像の順番も写り、保存後の読みこみでも残る', async (t) => {
  const h = await setup(t);
  button(h.root.querySelector('.ed-slide-actions'), '複製').click();
  const deck = normalizeDeck(JSON.parse(JSON.stringify(await h.save())));
  const copy = deck.slides[deck.order[1]];
  assert.deepEqual(copy.items.map((it) => it.step), [1, 2, 3]);
  assert.deepEqual(copy.items.map((it) => it.kind), ['text', 'shape', 'image']);
  assert.ok(copy.items.every((it, i) => it.id !== deck.slides.a.items[i].id));
  h.undo(); assert.equal((await h.save()).order.length, 1);
  h.redo(); assert.deepEqual((await h.save()).slides[deck.order[1]], copy);
});
