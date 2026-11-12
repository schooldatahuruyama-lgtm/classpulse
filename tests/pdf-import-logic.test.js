import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { normalizeDeck, validateDeck } from '../js/model.js';
import {
  checkPdfFile, checkPageCount, pageBudget, fitToSlide, titleFromFileName,
  buildDeckFromPages, importMessage, abortable,
} from '../js/pdf-import-logic.js';

test('CONFIG.pdf の上限', () => {
  assert.deepEqual(CONFIG.pdf, { maxPages: 30, maxFileBytes: 52428800 });
});

test('checkPdfFile', () => {
  assert.equal(checkPdfFile({ name: 'a.bin', type: 'application/pdf', size: 10 }), null);
  assert.equal(checkPdfFile({ name: 'A.PDF', type: '', size: 10 }), null);
  assert.deepEqual(checkPdfFile({ name: 'a.png', type: 'image/png', size: 10 }), { code: 'not-pdf' });
  assert.deepEqual(checkPdfFile({ name: 'a.pdf', type: 'application/pdf', size: 52428801 }), { code: 'too-large' });
  assert.equal(checkPdfFile({ name: 'a.pdf', type: 'application/pdf', size: 52428800 }), null);
});

test('checkPageCount', () => {
  assert.equal(checkPageCount(30), null);
  assert.equal(checkPageCount(1), null);
  assert.deepEqual(checkPageCount(31), { code: 'too-many', pages: 31 });
  assert.deepEqual(checkPageCount(0), { code: 'broken' });
  assert.deepEqual(checkPageCount(1.5), { code: 'broken' });
});

test('pageBudget', () => {
  assert.equal(pageBudget(30), 174762);
  assert.equal(pageBudget(1), 204800);
  assert.ok(pageBudget(30) * 30 <= 5242880);
});

test('fitToSlide', () => {
  assert.deepEqual(fitToSlide(1600, 900), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(fitToSlide(1200, 900), { x: 0.125, y: 0, w: 0.75, h: 1 });
  const a4 = fitToSlide(595, 842);
  assert.equal(a4.h, 1);
  assert.equal(a4.w, Number(((595 / 842) / (16 / 9)).toFixed(6)));
  assert.equal(a4.x, (1 - a4.w) / 2);
  const wide = fitToSlide(2000, 500);
  assert.equal(wide.w, 1);
  assert.equal(wide.y, (1 - wide.h) / 2);
});

test('titleFromFileName', () => {
  assert.equal(titleFromFileName('理科 3 章.pdf'), '理科 3 章');
  assert.equal(titleFromFileName('.pdf'), 'PDF の教材');
  assert.equal(titleFromFileName('  x.PDF '), 'x');
  assert.equal(titleFromFileName('a'.repeat(150) + '.pdf').length, 100);
});

test('buildDeckFromPages', () => {
  const pages = [
    { dataUrl: 'data:image/jpeg;base64,AAA', width: 1200, height: 900 },
    { dataUrl: 'data:image/jpeg;base64,BBB', width: 595, height: 842 },
    { dataUrl: 'data:image/jpeg;base64,CCC', width: 1600, height: 900 },
  ];
  let n = 0;
  const makeId = () => 'id' + (n++);
  const deck = buildDeckFromPages('教材', pages, 123, makeId);
  assert.equal(deck.title, '教材');
  assert.equal(deck.updatedAt, 123);
  assert.equal(deck.order.length, 3);
  assert.equal(Object.keys(deck.slides).length, 3);
  deck.order.forEach((sid, i) => {
    const s = deck.slides[sid];
    assert.equal(s.type, 'content');
    assert.equal(s.items.length, 1);
    const it = s.items[0];
    assert.equal(it.kind, 'image');
    assert.equal(deck.images[it.imageId], pages[i].dataUrl);
    const f = fitToSlide(pages[i].width, pages[i].height);
    assert.deepEqual({ x: it.x, y: it.y, w: it.w, h: it.h }, f);
  });
  assert.equal(new Set([...deck.order, ...Object.values(deck.slides).map((s) => s.items[0].id),
    ...Object.keys(deck.images)]).size, 9);
  assert.deepEqual(normalizeDeck(deck), deck);
  assert.deepEqual(validateDeck(deck), []);
});

test('buildDeckFromPages: 既定の ID 作成でも重複しない', () => {
  const pages = Array.from({ length: 5 }, () => ({ dataUrl: 'data:x', width: 100, height: 100 }));
  const deck = buildDeckFromPages('t', pages, 1);
  assert.equal(new Set(deck.order).size, 5);
  assert.equal(Object.keys(deck.images).length, 5);
});

test('importMessage', () => {
  const m = importMessage({ code: 'too-many', pages: 42 });
  assert.ok(m.includes('42') && m.includes('30'));
  assert.equal(importMessage({ code: 'cancelled' }), null);
  for (const code of ['not-pdf', 'too-large', 'password', 'broken']) {
    assert.equal(typeof importMessage({ code }), 'string');
  }
  assert.ok(importMessage({ code: 'too-large' }).includes('50MB'));
});

// 登録されている abort の聞き手の数がわかる合図の代役
function fakeSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    addEventListener: (type, fn) => { if (type === 'abort') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'abort') listeners.delete(fn); },
    abort() { this.aborted = true; for (const fn of [...listeners]) fn(); },
    get count() { return listeners.size; },
  };
}
const cancelError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test('abortable: 中止されなければ、元の結果・失敗をそのまま返し、聞き手を外す', async () => {
  const s = fakeSignal();
  assert.equal(await abortable(Promise.resolve(7), s, cancelError), 7);
  assert.equal(s.count, 0);
  await assert.rejects(abortable(Promise.reject(Object.assign(new Error('x'), { code: 'broken' })), s, cancelError), { code: 'broken' });
  assert.equal(s.count, 0);
  // 合図が無ければ、ただ待つ
  assert.equal(await abortable(Promise.resolve(8), undefined, cancelError), 8);
});

test('abortable: 待っている間に中止されたら、すぐに中止のエラーで終わり、聞き手を外す', async () => {
  const s = fakeSignal();
  const d = deferred();
  const p = abortable(d.promise, s, cancelError);
  assert.equal(s.count, 1);
  s.abort();
  await assert.rejects(p, { code: 'cancelled' });
  assert.equal(s.count, 0);
  d.resolve('おそい'); // あとから終わっても何も起きない
  await new Promise((r) => setTimeout(r, 0));
});

test('abortable: もう中止されている合図なら、待たずに中止のエラー。聞き手は付けない', async () => {
  const s = fakeSignal();
  s.aborted = true;
  const d = deferred();
  await assert.rejects(abortable(d.promise, s, cancelError), { code: 'cancelled' });
  assert.equal(s.count, 0);
  d.reject(new Error('おそい失敗'));
  await new Promise((r) => setTimeout(r, 0));
});

test('abortable: 中止のあとに元の約束が失敗しても、処理されない失敗（unhandledRejection）にならない', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const s = fakeSignal();
    const d = deferred();
    const p = abortable(d.promise, s, cancelError);
    s.abort();
    await assert.rejects(p, { code: 'cancelled' });
    d.reject(new Error('おそい失敗'));
    const s2 = fakeSignal();
    s2.aborted = true;
    const d2 = deferred();
    await assert.rejects(abortable(d2.promise, s2, cancelError), { code: 'cancelled' });
    d2.reject(new Error('おそい失敗 2'));
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('abortable: 本物の AbortController でも動く', async () => {
  const ac = new AbortController();
  const d = deferred();
  const p = abortable(d.promise, ac.signal, cancelError);
  ac.abort();
  await assert.rejects(p, { code: 'cancelled' });
});
