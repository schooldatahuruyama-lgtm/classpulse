import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newId, newSessionId, createDeck, createSlide, createTextItem,
  addSlide, removeSlide, moveSlide, duplicateSlide, updateSlide,
  normalizeDeck, validateDeck, deckImageBytes,
  isChoiceSlide, choiceCount, ratingOptions, quizCorrect, removeOption, withoutCorrect,
} from '../js/model.js';
import { CONFIG } from '../js/config.js';

// テスト用の教材を手早く作る道具
function deckOf(order, slides, images = {}) {
  return { title: 't', updatedAt: 1, order, slides, images };
}
const content = (items = []) => ({ type: 'content', items });
const poll = (question, options) => ({ type: 'poll', question, options, resultMode: 'manual' });
const img = (id, imageId) => ({ id, kind: 'image', x: 0, y: 0, w: 0.5, h: 0.5, imageId });

test('新しい教材は空', () => {
  assert.deepEqual(createDeck('光', 1000), { title: '光', updatedAt: 1000, order: [], slides: {}, images: {} });
});

test('スライドを足す・途中に足す', () => {
  const d0 = createDeck('t', 1);
  const d1 = addSlide(d0, createSlide('content'), 'a');
  const d2 = addSlide(d1, createSlide('content'), 'b');
  const d3 = addSlide(d2, createSlide('poll'), 'c', 'a');
  assert.deepEqual(d3.order, ['a', 'c', 'b']);
  assert.deepEqual(d2.order, ['a', 'b']);
  assert.deepEqual(d0.order, []);
  assert.equal(d3.slides.c.type, 'poll');
});

test('動画: 初期値と正規化は 4 項目だけ。入力 URL や質問の情報は保存しない', () => {
  assert.deepEqual(createSlide('video'), { type: 'video', videoId: '', start: 0, caption: '' });
  const slide = { type: 'video', videoId: 'AbCdEf01_-2', start: 90, caption: '題', url: 'https://example.org', items: [], question: '質問', options: ['a'], resultMode: 'live' };
  const before = structuredClone(slide);
  const normalized = normalizeDeck({ order: ['v'], slides: { v: slide } }).slides.v;
  assert.deepEqual(normalized, { type: 'video', videoId: 'AbCdEf01_-2', start: 90, caption: '題' });
  assert.deepEqual(slide, before);
});

test('動画: こわれた ID・開始位置を正し、題を 100 文字までに切る', () => {
  const norm = (fields) => normalizeDeck({ order: ['v'], slides: { v: { type: 'video', ...fields } } }).slides.v;
  for (const videoId of ['', '"><script>', '../x', 12345678901, 'x'.repeat(12), 'AbCdEf01_-2\n', null, undefined]) {
    assert.equal(norm({ videoId }).videoId, '');
  }
  for (const start of [-1, 86401, 0.5, '90', NaN, Infinity, null, undefined]) assert.equal(norm({ start }).start, 0);
  for (const start of [0, 90, 86400]) assert.equal(norm({ start }).start, start);
  assert.equal(norm({ caption: 'あ'.repeat(101) }).caption, 'あ'.repeat(100));
  assert.equal(norm({ caption: 'あ'.repeat(99) + '😀' }).caption, 'あ'.repeat(99));
  assert.equal(norm({ caption: 123 }).caption, '');
  assert.deepEqual(norm({}), createSlide('video'));
});

test('動画: 発表前の確かめは題を省略でき、空・こわれた ID の枚数を知らせる', () => {
  const deck = { order: ['c', 'v', 'bad', 'ok'], slides: {
    c: createSlide('content'), v: createSlide('video'), bad: { type: 'video', videoId: '../x' },
    ok: { ...createSlide('video'), videoId: 'AbCdEf01_-2' },
  } };
  assert.deepEqual(validateDeck(deck), ['2 枚目: 動画の URL を入れてください。', '3 枚目: 動画の URL を入れてください。']);
  assert.deepEqual(validateDeck({ ...deck, order: ['ok'] }), []);
});

test('createSlide と createTextItem の初期値', () => {
  assert.deepEqual(createSlide('content'), { type: 'content', items: [] });
  assert.deepEqual(createSlide('poll'), { type: 'poll', question: '', options: ['', ''], resultMode: 'manual' });
  assert.deepEqual(createTextItem('x'), {
    id: 'x', kind: 'text', x: 0.1, y: 0.1, w: 0.8, h: 0.2,
    text: '', size: 'm', bold: false, color: '#1F2A6B', align: 'left',
  });
});

test('順番変更は端で止まる', () => {
  const d = deckOf(['a', 'b', 'c'], { a: content(), b: content(), c: content() });
  assert.deepEqual(moveSlide(d, 'a', -1).order, ['a', 'b', 'c']);
  assert.deepEqual(moveSlide(d, 'c', 1).order, ['a', 'b', 'c']);
  assert.deepEqual(moveSlide(d, 'b', 1).order, ['a', 'c', 'b']);
  assert.deepEqual(moveSlide(d, 'b', -1).order, ['b', 'a', 'c']);
  assert.deepEqual(d.order, ['a', 'b', 'c']);
});

test('複製は元のすぐ後ろ', () => {
  const d = deckOf(['a', 'b'], { a: content([img('i1', 'p1')]), b: content() }, { p1: 'data:x' });
  const d2 = duplicateSlide(d, 'a', 'a2', () => 'n1');
  assert.deepEqual(d2.order, ['a', 'a2', 'b']);
  assert.equal(d2.slides.a2.items[0].imageId, 'p1');
  assert.deepEqual(d.order, ['a', 'b']);
});

test('複製した要素の id は新しい', () => {
  const d = deckOf(['a'], { a: content([img('i1', 'p1')]) }, { p1: 'data:x' });
  const d2 = duplicateSlide(d, 'a', 'a2', () => 'n1');
  assert.equal(d2.slides.a2.items[0].id, 'n1');
  assert.equal(d2.slides.a.items[0].id, 'i1');
  assert.notEqual(d2.slides.a2.items, d2.slides.a.items);
});

test('スライドを消すと、ほかで使っていない画像も消える', () => {
  const d = deckOf(['a', 'b'], { a: content([img('i1', 'p1')]), b: content() }, { p1: 'data:x', p2: 'data:y' });
  const d2 = removeSlide(d, 'a');
  assert.deepEqual(d2.order, ['b']);
  assert.equal('a' in d2.slides, false);
  assert.deepEqual(d2.images, { p2: 'data:y' });
  assert.deepEqual(Object.keys(d.images), ['p1', 'p2']);
});

test('2 枚で共有している画像は残る', () => {
  const d = deckOf(['a', 'b'], { a: content([img('i1', 'p1')]), b: content([img('i2', 'p1')]) }, { p1: 'data:x' });
  assert.deepEqual(removeSlide(d, 'a').images, { p1: 'data:x' });
});

test('updateSlide は差しかえた新しい教材を返す', () => {
  const d = deckOf(['a'], { a: content() });
  const d2 = updateSlide(d, 'a', content([img('i1', 'p1')]));
  assert.equal(d2.slides.a.items.length, 1);
  assert.equal(d.slides.a.items.length, 0);
});

test('Realtime Database から戻った形を直す', () => {
  const e = normalizeDeck({ title: '光', updatedAt: 1 });
  assert.deepEqual(e.order, []);
  assert.deepEqual(e.slides, {});
  assert.deepEqual(e.images, {});

  const d = normalizeDeck({ title: 't', updatedAt: 1, order: { 0: 'a' }, slides: { a: { type: 'content' } } });
  assert.deepEqual(d.order, ['a']);
  assert.deepEqual(d.slides.a.items, []);

  const p = normalizeDeck({ title: 't', updatedAt: 1, order: ['a'], slides: { a: { type: 'poll', question: 'q' } } });
  assert.deepEqual(p.slides.a.options, []);
  assert.equal(p.slides.a.resultMode, 'manual');

  const z = normalizeDeck({ title: 't', updatedAt: 1, order: ['a', 'zz'], slides: { a: { type: 'content' } } });
  assert.deepEqual(z.order, ['a']);

  const n = normalizeDeck(null);
  assert.deepEqual(n, { title: '', updatedAt: 0, order: [], slides: {}, images: {} });
});

test('正規化は配列に見えるオブジェクトの items と options も直す', () => {
  const d = normalizeDeck({
    title: 't', updatedAt: 1, order: ['a', 'b'],
    slides: {
      a: { type: 'content', items: { 0: img('i1', 'p1') } },
      b: { type: 'poll', question: 'q', options: { 0: 'x', 1: 'y' }, resultMode: 'live' },
    },
  });
  assert.equal(d.slides.a.items.length, 1);
  assert.deepEqual(d.slides.b.options, ['x', 'y']);
  assert.equal(d.slides.b.resultMode, 'live');
});

function pollDeck(options, question = '質問') {
  return deckOf(['a', 'b', 'c'], { a: content(), b: content(), c: poll(question, options) });
}

test('検査: スライド 0 枚', () => {
  assert.deepEqual(validateDeck(createDeck('t', 1)), ['スライドがありません。']);
});

test('検査: アンケートの問題', () => {
  assert.ok(validateDeck(pollDeck(['a', 'b'], '   ')).includes('3 枚目: 質問文を入れてください。'));
  assert.ok(validateDeck(pollDeck(['a', ' '])).includes('3 枚目: 選択肢を 2 つ以上入れてください。'));
  assert.ok(validateDeck(pollDeck(['1', '2', '3', '4', '5', '6', '7'])).includes('3 枚目: 選択肢は 6 つまでです。'));
  assert.ok(validateDeck(pollDeck(['a', '  ', 'b'])).includes('3 枚目: 空の選択肢を消してください。'));
});

test('検査: 正しい教材は問題なし', () => {
  assert.deepEqual(validateDeck(pollDeck(['a', 'b'])), []);
});

test('画像の合計文字数', () => {
  assert.equal(deckImageBytes(deckOf([], {}, { p1: 'abc', p2: 'de' })), 5);
  assert.equal(deckImageBytes(createDeck('t', 1)), 0);
});

test('id は英数字だけで 12 文字', () => {
  assert.match(newId(), /^[A-Za-z0-9]{12}$/);
  assert.match(newId(() => 0.999999, 5), /^[A-Za-z0-9]{5}$/);
});

test('授業 ID は 22 文字で、2 回作ると違う', () => {
  const g = crypto.getRandomValues.bind(crypto);
  const a = newSessionId(g);
  const b = newSessionId(g);
  assert.match(a, /^[A-Za-z0-9]{22}$/);
  assert.notEqual(a, b);
});

// ---- 要素の位置の補正（clampItem） ----
import { clampItem, MIN_ITEM_SIZE } from '../js/model.js';

const inside = (it) => it.x >= 0 && it.y >= 0 && it.x + it.w <= 1 + 1e-9 && it.y + it.h <= 1 + 1e-9;

test('clampItem: 右にはみ出す要素（x 0.9, w 0.8）は枠の中に戻す', () => {
  const r = clampItem({ id: 'a', kind: 'text', x: 0.9, y: 0.1, w: 0.8, h: 0.2, text: '光' });
  assert.ok(inside(r));
  assert.equal(r.w, 0.8);
  assert.ok(Math.abs(r.x - 0.2) < 1e-9);
  assert.equal(r.text, '光', 'ほかの値はそのまま');
});

test('clampItem: 幅 0 は最小（0.05）、幅が無いときは文字の箱の既定値', () => {
  assert.equal(MIN_ITEM_SIZE, 0.05);
  assert.equal(clampItem({ x: 0, y: 0, w: 0, h: 0 }).w, 0.05);
  assert.equal(clampItem({ x: 0, y: 0, w: 0, h: 0 }).h, 0.05);
  const d = createTextItem('x');
  const r = clampItem({ x: 0.1, y: 0.1 });
  assert.equal(r.w, d.w);
  assert.equal(r.h, d.h);
});

test('clampItem: 負の値・NaN・数でない値・大きすぎる値を直す', () => {
  const d = createTextItem('x');
  const a = clampItem({ x: -1, y: -0.5, w: 2, h: 1.5 });
  assert.deepEqual([a.x, a.y, a.w, a.h], [0, 0, 1, 1]);
  const b = clampItem({ x: NaN, y: '0.3', w: Infinity, h: null });
  assert.equal(b.x, d.x);
  assert.equal(b.y, d.y);
  assert.equal(b.w, d.w);
  assert.equal(b.h, d.h);
  assert.ok(inside(b));
});

test('clampItem: 元の要素は書きかえない', () => {
  const it = { x: 0.9, y: 0, w: 0.8, h: 0.2 };
  clampItem(it);
  assert.deepEqual(it, { x: 0.9, y: 0, w: 0.8, h: 0.2 });
});

test('normalizeDeck: どの要素にも clampItem をかける', () => {
  const d = normalizeDeck({
    title: 't', updatedAt: 1, order: ['a'],
    slides: { a: { type: 'content', items: [{ id: 'i', kind: 'image', x: 0.9, y: 0.95, w: 0.8, h: 0, imageId: 'p' }] } },
  });
  const it = d.slides.a.items[0];
  assert.ok(inside(it));
  assert.equal(it.h, 0.05);
  assert.equal(it.imageId, 'p');
});

// ---- 自由記述（free）----
test('createSlide("free") は質問文だけを持つ', () => {
  assert.deepEqual(createSlide('free'), { type: 'free', question: '' });
});

test('normalizeDeck は free の余計な項目を落とし、質問文を文字列にする', () => {
  const d = normalizeDeck({
    title: 't', order: ['a', 'b'],
    slides: {
      a: { type: 'free', question: '感想は？', options: ['x'], items: [{}], resultMode: 'live' },
      b: { type: 'free', question: 5 },
    },
  });
  assert.deepEqual(d.slides.a, { type: 'free', question: '感想は？' });
  assert.deepEqual(d.slides.b, { type: 'free', question: '' });
});

test('validateDeck は free の空の質問文を見つける', () => {
  const bad = deckOf(['a'], { a: { type: 'free', question: '  ' } });
  assert.deepEqual(validateDeck(bad), ['1 枚目: 質問文を入れてください。']);
  const ok = deckOf(['a'], { a: { type: 'free', question: '感想は？' } });
  assert.deepEqual(validateDeck(ok), []);
});

// ---- ワードクラウド（cloud）----
test('createSlide("cloud") は質問文だけを持つ', () => {
  assert.deepEqual(createSlide('cloud'), { type: 'cloud', question: '' });
});

test('normalizeDeck は cloud の余計な項目を落とし、質問文を文字列にする', () => {
  const d = normalizeDeck({
    title: 't', order: ['a', 'b'],
    slides: {
      a: { type: 'cloud', question: '好きな動物は？', options: ['x'], items: [{}] },
      b: { type: 'cloud', question: 5 },
    },
  });
  assert.deepEqual(d.slides.a, { type: 'cloud', question: '好きな動物は？' });
  assert.deepEqual(d.slides.b, { type: 'cloud', question: '' });
});

test('validateDeck は cloud の空の質問文を見つける', () => {
  const bad = deckOf(['a'], { a: { type: 'cloud', question: '  ' } });
  assert.deepEqual(validateDeck(bad), ['1 枚目: 質問文を入れてください。']);
  const ok = deckOf(['a'], { a: { type: 'cloud', question: '好きな動物は？' } });
  assert.deepEqual(validateDeck(ok), []);
});

// ---- クイズ（quiz）と 5 段階評価（rating）----

test('createSlide: クイズは選択肢 2 つで 1 つ目が正解、評価は言葉が空で manual', () => {
  assert.deepEqual(createSlide('quiz'), { type: 'quiz', question: '', options: ['', ''], correct: 0 });
  assert.deepEqual(createSlide('rating'), { type: 'rating', question: '', lowLabel: '', highLabel: '', resultMode: 'manual' });
  assert.deepEqual(CONFIG.rating, { steps: 5, labelMaxLength: 20 });
});

test('normalizeDeck: クイズの correct は 0 以上・選択肢の数未満の整数でなければ 0', () => {
  const q = (correct, options = ['a', 'b', 'c']) => normalizeDeck(deckOf(['q'], { q: { type: 'quiz', question: 'Q', options, correct } })).slides.q;
  assert.equal(q(2).correct, 2);
  assert.equal(q(0).correct, 0);
  assert.equal(q(3).correct, 0); // 範囲外
  assert.equal(q(-1).correct, 0);
  assert.equal(q(1.5).correct, 0); // 小数
  assert.equal(q('1').correct, 0); // 文字列
  assert.equal(q(undefined).correct, 0);
  // 選択肢はアンケートと同じに正す（{0:…} の形も配列に）
  const s = q(1, { 0: 'x', 1: 'y' });
  assert.deepEqual(s.options, ['x', 'y']);
  assert.equal(s.correct, 1);
  assert.equal(s.type, 'quiz');
  assert.equal(normalizeDeck(deckOf(['q'], { q: { type: 'quiz', question: 7 } })).slides.q.question, '');
});

test('normalizeDeck: 評価の言葉は文字列にして 20 文字で切り、resultMode は live か manual', () => {
  const r = (src) => normalizeDeck(deckOf(['r'], { r: { type: 'rating', ...src } })).slides.r;
  const long = 'あ'.repeat(21);
  const s = r({ question: 'Q', lowLabel: long, highLabel: 'とても', resultMode: 'live', options: ['x'] });
  assert.deepEqual(s, { type: 'rating', question: 'Q', lowLabel: 'あ'.repeat(20), highLabel: 'とても', resultMode: 'live' });
  assert.deepEqual(r({ question: 3, lowLabel: 5, resultMode: 'x' }),
    { type: 'rating', question: '', lowLabel: '', highLabel: '', resultMode: 'manual' });
  // 切った所で対になる文字（絵文字など）が半分にならない
  const emoji = 'a'.repeat(19) + '😀';
  assert.equal(r({ lowLabel: emoji }).lowLabel, 'a'.repeat(19));
});

test('validateDeck: クイズはアンケートと同じ問題、評価は質問文が空のときだけ', () => {
  const deck = deckOf(['q', 'r', 'r2'], {
    q: { type: 'quiz', question: '', options: ['a', ''], correct: 0 },
    r: { type: 'rating', question: '', lowLabel: '', highLabel: '', resultMode: 'manual' },
    r2: { type: 'rating', question: '満足度は？', lowLabel: '', highLabel: '', resultMode: 'live' },
  });
  assert.deepEqual(validateDeck(deck), [
    '1 枚目: 質問文を入れてください。',
    '1 枚目: 選択肢を 2 つ以上入れてください。',
    '2 枚目: 質問文を入れてください。',
  ]);
  const ok = deckOf(['q'], { q: { type: 'quiz', question: 'Q', options: ['a', 'b'], correct: 1 } });
  assert.deepEqual(validateDeck(ok), []);
});

test('removeOption: クイズで正解を消すと 1 つ目が正解、前を消すと 1 減り、後ろを消すと変わらない', () => {
  const quiz = { type: 'quiz', question: 'Q', options: ['a', 'b', 'c', 'd'], correct: 2 };
  assert.deepEqual(removeOption(quiz, 2), { ...quiz, options: ['a', 'b', 'd'], correct: 0 });
  assert.deepEqual(removeOption(quiz, 0), { ...quiz, options: ['b', 'c', 'd'], correct: 1 });
  assert.deepEqual(removeOption(quiz, 3), { ...quiz, options: ['a', 'b', 'c'], correct: 2 });
  // 消したあとも、正解は同じ文の選択肢を指す
  const after = removeOption(quiz, 1);
  assert.equal(after.options[after.correct], 'c');
  // 元のスライドは書きかえない
  assert.deepEqual(quiz.options, ['a', 'b', 'c', 'd']);
  assert.equal(quiz.correct, 2);
  // アンケートは選択肢だけ
  const poll = { type: 'poll', question: 'Q', options: ['a', 'b', 'c'], resultMode: 'manual' };
  assert.deepEqual(removeOption(poll, 0), { ...poll, options: ['b', 'c'] });
  // 範囲外は何も消さない
  assert.deepEqual(removeOption(quiz, 9), quiz);
});

test('isChoiceSlide・choiceCount・ratingOptions・quizCorrect', () => {
  assert.equal(isChoiceSlide({ type: 'poll' }), true);
  assert.equal(isChoiceSlide({ type: 'quiz' }), true);
  assert.equal(isChoiceSlide({ type: 'rating' }), true);
  for (const t of ['free', 'cloud', 'content']) assert.equal(isChoiceSlide({ type: t }), false);
  assert.equal(isChoiceSlide(null), false);
  assert.equal(choiceCount({ type: 'poll', options: ['a', 'b', 'c'] }), 3);
  assert.equal(choiceCount({ type: 'quiz', options: ['a', 'b'] }), 2);
  assert.equal(choiceCount({ type: 'rating' }), 5); // options が無くても 5
  assert.equal(choiceCount({ type: 'rating', options: ['1', '2'] }), 5);
  assert.equal(choiceCount({ type: 'free' }), 0);
  assert.deepEqual(ratingOptions(), ['1', '2', '3', '4', '5']);
  assert.equal(quizCorrect({ type: 'quiz', options: ['a', 'b'], correct: 1 }), 1);
  assert.equal(quizCorrect({ type: 'quiz', options: ['a', 'b'], correct: 2 }), 0);
});

test('withoutCorrect: クイズのスライドから correct を外す（ほかは変えず、元は書きかえない）', () => {
  const deck = deckOf(['q', 'p'], {
    q: { type: 'quiz', question: 'Q', options: ['a', 'b'], correct: 1 },
    p: { type: 'poll', question: 'P', options: ['a', 'b'], resultMode: 'manual' },
  });
  const out = withoutCorrect(deck);
  assert.equal(Object.hasOwn(out.slides.q, 'correct'), false);
  assert.deepEqual(out.slides.q, { type: 'quiz', question: 'Q', options: ['a', 'b'] });
  assert.deepEqual(out.slides.p, deck.slides.p);
  assert.equal(deck.slides.q.correct, 1);
});
