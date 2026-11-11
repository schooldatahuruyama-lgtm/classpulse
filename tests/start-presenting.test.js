import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartPresenting } from '../js/views/start-presenting.js';

const deckOf = (title) => ({ title, order: ['s1'], slides: { s1: { type: 'content', items: [] } }, images: {} });
const emptyDeck = { title: 'x', order: [], slides: {}, images: {} };

test('保存待ちの間に教材が編集されたら、編集後の教材で授業を始める', async () => {
  let current = deckOf('前');
  const saved = [];
  let release;
  let first = true;
  const beforeStart = async () => {
    const snapshot = current;
    if (first) { first = false; await new Promise((r) => { release = r; }); }
    saved.push(snapshot);
    return true;
  };
  let started = null;
  const p = runStartPresenting({
    deckId: 'd1', getDeck: () => current, beforeStart,
    getActive: async () => null,
    startSession: async (id, deck) => { started = deck; return 'sid1'; },
  });
  await new Promise((r) => setImmediate(r));
  current = deckOf('後'); // 保存を待っている間の編集
  release();
  const r = await p;
  assert.deepEqual(r, { status: 'started', sid: 'sid1' });
  assert.equal(started.title, '後');
  assert.equal(saved.at(-1), started); // 保存した教材と発表する教材が同じ
});

test('待ったあとの最新の教材が不正なら、理由を返して授業を始めない', async () => {
  let current = deckOf('前');
  let started = false;
  const r = await runStartPresenting({
    deckId: 'd1', getDeck: () => current,
    beforeStart: async () => { current = emptyDeck; return true; },
    getActive: async () => null,
    startSession: async () => { started = true; return 'x'; },
  });
  assert.equal(r.status, 'invalid');
  assert.deepEqual(r.reasons, ['スライドがありません。']);
  assert.equal(started, false);
});

test('発表中の授業があるときは active を返して授業を始めない', async () => {
  let started = false;
  const r = await runStartPresenting({
    deckId: 'd1', getDeck: () => deckOf('a'),
    getActive: async () => ({ sid: 'old' }),
    startSession: async () => { started = true; return 'x'; },
  });
  assert.deepEqual(r, { status: 'active', sid: 'old' });
  assert.equal(started, false);
});

test('beforeStart が false なら中止する', async () => {
  const r = await runStartPresenting({
    deckId: 'd1', getDeck: () => deckOf('a'), beforeStart: async () => false,
    getActive: async () => { throw new Error('呼ばれない'); },
    startSession: async () => 'x',
  });
  assert.deepEqual(r, { status: 'cancelled' });
});
