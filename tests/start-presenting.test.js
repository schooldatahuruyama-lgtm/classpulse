import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartPresenting, checkActive, openPresenter } from '../js/views/start-presenting.js';

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

// ---- 「発表中」の印が指す授業が、もう無い・もう終わっている場合 ----

test('印の指す授業が消えていたら、印を外して授業を始める', async () => {
  let active = { sid: 'gone' };
  const cleared = [];
  const r = await runStartPresenting({
    deckId: 'd1', getDeck: () => deckOf('a'),
    getActive: async () => active,
    getSessionState: async (sid) => { assert.equal(sid, 'gone'); return null; },
    clearActive: async (sid) => { cleared.push(sid); active = null; },
    startSession: async () => 'new1',
  });
  assert.deepEqual(cleared, ['gone']);
  assert.deepEqual(r, { status: 'started', sid: 'new1' });
});

test('印の指す授業が終了済み（後片づけが残っている）なら、始めずに ended を返し、印は外さない', async () => {
  let started = false;
  const cleared = [];
  const r = await runStartPresenting({
    deckId: 'd1', getDeck: () => deckOf('a'),
    getActive: async () => ({ sid: 'old' }),
    getSessionState: async () => 'ended',
    clearActive: async (sid) => { cleared.push(sid); },
    startSession: async () => { started = true; return 'x'; },
  });
  assert.deepEqual(r, { status: 'ended', sid: 'old' });
  assert.equal(started, false);
  assert.deepEqual(cleared, []);
});

test('印の指す授業が続いていれば active を返す。確かめられなければ failed（印は外さない）', async () => {
  const cleared = [];
  const base = {
    deckId: 'd1', getDeck: () => deckOf('a'), getActive: async () => ({ sid: 'old' }),
    clearActive: async (sid) => { cleared.push(sid); }, startSession: async () => 'x',
  };
  assert.deepEqual(await runStartPresenting({ ...base, getSessionState: async () => 'live' }), { status: 'active', sid: 'old' });
  assert.deepEqual(await runStartPresenting({ ...base, getSessionState: async () => { throw new Error('offline'); } }), { status: 'failed' });
  assert.deepEqual(cleared, []);
});

test('checkActive: 印が無い・続いている・終了済み・消えている', async () => {
  const cleared = [];
  const clearActive = async (sid) => { cleared.push(sid); };
  assert.deepEqual(await checkActive({ getActive: async () => null, getSessionState: async () => 'live', clearActive }), { kind: 'none' });
  const active = { sid: 's1', startedAt: 5 };
  assert.deepEqual(await checkActive({ getActive: async () => active, getSessionState: async () => 'live', clearActive }), { kind: 'live', active });
  assert.deepEqual(await checkActive({ getActive: async () => active, getSessionState: async () => 'ended', clearActive }), { kind: 'ended', active });
  assert.deepEqual(cleared, []);
  assert.deepEqual(await checkActive({ getActive: async () => active, getSessionState: async () => null, clearActive }), { kind: 'none' });
  assert.deepEqual(cleared, ['s1']);
});

// ---- 授業を作ったあとの画面の移動 ----

test('openPresenter: 画面が替われば true、元の画面のままなら false（授業は作り直さない）', async () => {
  const calls = [];
  let alive = true;
  const moved = await openPresenter({
    navigate: async (name, params) => { calls.push([name, params]); alive = false; },
    sid: 's1', isAlive: () => alive,
  });
  assert.equal(moved, true);
  assert.deepEqual(calls, [['present', { sid: 's1' }]]);
  // 先生の確認に失敗して元の画面に戻された
  assert.equal(await openPresenter({ navigate: async () => 'offline', sid: 's1', isAlive: () => true }), false);
  // 移動そのものが失敗した
  assert.equal(await openPresenter({ navigate: async () => { throw new Error('x'); }, sid: 's1', isAlive: () => true }), false);
  // 結果が返らなくても、元の画面が残っていれば移れていない
  assert.equal(await openPresenter({ navigate: async () => undefined, sid: 's1', isAlive: () => true }), false);
});
