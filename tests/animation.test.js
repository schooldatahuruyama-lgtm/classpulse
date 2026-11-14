import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STEP, normalizeStep, stepCount, itemRank, isItemVisible, clampStep, advance } from '../js/animation.js';
import { normalizeDeck, duplicateSlide } from '../js/model.js';
import { buildSession, nextPatch, prevPatch, goToPatch, applyPatch } from '../js/session-logic.js';

const content = (...values) => ({ type: 'content', items: values.map((step, i) => ({ id: `item${i}`, kind: 'text', text: '例', step })) });
const slides = { a: content(0, 1, 3, 3), q: { type: 'poll', options: ['はい', 'いいえ'] }, b: content(2, 4) };
const order = ['a', 'q', 'b'];

for (const [value, expected] of [
  ['文字', 0], ['3', 0], [2.7, 2], [-1, 0], [21, 20], [Number.MAX_VALUE, 20],
  [NaN, 0], [null, 0], [undefined, 0], [Infinity, 0], [-Infinity, 0], [true, 0], [0, 0], [20, 20],
]) {
  test(`順番の補正: ${String(value)} (${typeof value}) → ${expected}`, () => {
    assert.equal(MAX_STEP, 20);
    assert.equal(normalizeStep(value), expected);
    const raw = { order: ['s'], slides: { s: content(value) } };
    const item = normalizeDeck(raw).slides.s.items[0];
    assert.equal(item.step ?? 0, expected);
    assert.equal(Object.hasOwn(item, 'step'), expected > 0);
    assert.ok(Object.is(raw.slides.s.items[0].step, value));
  });
}

test('順番: とびはつめ、同じ番号は同じ回。資料以外は数えない', () => {
  assert.equal(stepCount(slides.a), 2);
  assert.deepEqual(slides.a.items.map((item) => itemRank(slides.a, item)), [0, 1, 2, 2]);
  for (const type of ['poll', 'quiz', 'rating', 'free', 'cloud', 'video']) {
    const slide = { ...slides.a, type };
    assert.equal(stepCount(slide), 0);
    assert.equal(itemRank(slide, slide.items[1]), 0);
    assert.ok(isItemVisible(slide, slide.items[1], 0));
  }
  assert.equal(stepCount(null), 0);
  assert.equal(stepCount(content()), 0);
  assert.equal(stepCount(content(0, undefined, '3')), 0);
});

for (const [step, visible] of [[undefined, 4], ['文字', 4], ['3', 4], [null, 4], [NaN, 4], [-2, 1], [0, 1], [1, 2], [1.9, 2], [99, 4]]) {
  test(`表示回数: ${String(step)} (${typeof step}) の見える要素は ${visible} 個`, () => {
    assert.equal(slides.a.items.filter((item) => isItemVisible(slides.a, item, step)).length, visible);
    assert.ok(clampStep(slides.a, step) >= 0 && clampStep(slides.a, step) <= 2);
  });
}

test('全部に順番がある資料は 0 回では白い。順番なしは初めから全部見える', () => {
  assert.ok(slides.b.items.every((item) => !isItemVisible(slides.b, item, 0)));
  const plain = content(0, undefined);
  assert.ok(plain.items.every((item) => isItemVisible(plain, item, 0)));
});

for (const [slideId, step, dir, to, nextStep, moved] of [
  ['', 0, 1, 'a', 0, true], ['', 0, -1, '', 0, false],
  ['a', 0, 1, 'a', 1, false], ['a', 1, 1, 'a', 2, false], ['a', 2, 1, 'q', 0, true],
  ['a', 1, -1, 'a', 0, false], ['a', 0, -1, 'a', 0, false],
  ['q', 0, -1, 'a', 2, true], ['q', 0, 1, 'b', 0, true],
  ['b', 0, -1, 'q', 0, true], ['b', 0, 1, 'b', 1, false],
  ['b', 1, 1, 'b', 2, false], ['b', 2, 1, 'b', 2, false],
  ['a', undefined, 1, 'q', 0, true], ['a', undefined, -1, 'a', 1, false],
  ['a', -20, 1, 'a', 1, false], ['a', 200, -1, 'a', 1, false],
]) {
  test(`進行: ${slideId || '開始前'} / ${step} / ${dir} → ${to || '開始前'} / ${nextStep}`, () => {
    assert.deepEqual(advance({ order, slides, slideId, step }, dir), { slideId: to, step: nextStep, moved });
  });
}

test('順番なしの資料・空の教材・方向なしは従来の端の動き', () => {
  assert.deepEqual(advance({ order: [], slides: {}, slideId: '', step: 0 }, 1), { slideId: '', step: 0, moved: false });
  assert.deepEqual(advance({ order, slides: { ...slides, a: content(0) }, slideId: 'a', step: 0 }, 1), { slideId: 'q', step: 0, moved: true });
  assert.deepEqual(advance({ order, slides, slideId: 'a', step: 1 }, 0), { slideId: 'a', step: 1, moved: false });
});

test('同じ資料の中では current だけを書く。質問へ移ると受付、戻ると締切', () => {
  let pub = buildSession({ order, slides }, 'deck', 'teacher-test', 1).pub;
  pub = applyPatch(pub, nextPatch(pub, order, slides));
  for (const step of [1, 2]) {
    const patch = nextPatch(pub, order, slides);
    assert.deepEqual(patch, { current: { slideId: 'a', index: 0, step } });
    pub = applyPatch(pub, patch);
    assert.equal(pub.polls.q.status, 'waiting');
  }
  const enter = nextPatch(pub, order, slides);
  assert.equal(enter['polls/q/status'], 'open');
  pub = applyPatch(pub, enter);
  const back = prevPatch(pub, order, slides);
  assert.equal(back['polls/q/status'], 'closed');
  assert.deepEqual(back.current, { slideId: 'a', index: 0, step: 2 });
  pub = applyPatch(pub, back);
  assert.deepEqual(prevPatch(pub, order, slides), { current: { slideId: 'a', index: 0, step: 1 } });
});

test('番号による直接の移動は step 0。スライド複製では順番も写す', () => {
  const pub = { current: { slideId: 'b', index: 2, step: 2 } };
  assert.deepEqual(goToPatch(pub, order, 0).current, { slideId: 'a', index: 0, step: 0 });
  const deck = normalizeDeck({ order, slides });
  let seq = 0;
  const copy = duplicateSlide(deck, 'a', 'copy', () => `copy${++seq}`);
  assert.deepEqual(copy.slides.copy.items.map((item) => item.step), deck.slides.a.items.map((item) => item.step));
  assert.notEqual(copy.slides.copy.items[0].id, deck.slides.a.items[0].id);
});
