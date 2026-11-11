import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundSaver } from '../js/views/editor/background-save.js';

// 手で進めるタイマー
function fakeTimers() {
  let next = 1;
  const queue = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; queue.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { queue.delete(id); },
    runAll() { const items = [...queue.values()]; queue.clear(); items.forEach((t) => t.fn()); },
    get size() { return queue.size; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(saveImpl) {
  const timers = fakeTimers();
  const guards = [];
  const events = [];
  const bg = createBackgroundSaver({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, retryMs: 5000,
    onGuard: (on) => guards.push(on), onEvent: (kind, title) => events.push([kind, title]),
  });
  return { bg, timers, guards, events };
}

test('背景の保存: 失敗のあと成功すると、最新の内容で 1 回だけ保存され、知らせが出る', async () => {
  const calls = [];
  const saved = [];
  let fail = true;
  const save = async (deck) => { calls.push(deck); if (fail) throw new Error('通信なし'); saved.push(deck); };
  const { bg, timers, guards, events } = setup(save);
  const d1 = { title: '光' };
  const d2 = { title: '光2' };
  bg.hand('a', { deck: d1, save, title: '光', failed: true });
  await tick();
  assert.deepEqual(events, [['failing', '光']]);
  assert.equal(timers.size, 1);
  bg.hand('a', { deck: d2, save, title: '光2' }); // 新しい内容が来た（保存中でなければすぐ試す）
  await tick();
  fail = false;
  timers.runAll();
  await tick();
  timers.runAll();
  await tick();
  assert.deepEqual(saved, [d2], '保存できたのは最新の内容で 1 回だけ');
  assert.equal(timers.size, 0);
  assert.equal(bg.hasPending('a'), false);
  assert.deepEqual(events.filter(([k]) => k === 'failing').length, 1, '失敗の知らせは 1 回だけ');
  assert.deepEqual(events[events.length - 1], ['saved', '光2']);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: 成功したら 1 回だけ保存し、失敗がなければ「保存しました」は出さない', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg, events, guards } = setup(save);
  const d = { title: 't' };
  bg.hand('a', { deck: d, save, title: 't' });
  await tick();
  assert.deepEqual(calls, [d]);
  assert.deepEqual(events, []);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: adopt は引きついだ（新しい）内容を返し、再試行をやめる', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); throw new Error('通信なし'); };
  const { bg, timers, guards } = setup(save);
  const d = { title: 'x' };
  bg.hand('a', { deck: d, save, title: 'x' });
  await bg.settle('a');
  assert.equal(bg.adopt('a'), d);
  assert.equal(timers.size, 0);
  assert.equal(bg.adopt('a'), null);
  assert.equal(bg.hasPending('a'), false);
  assert.deepEqual(guards, [true, false]);
  assert.equal(calls.length, 1);
});

test('背景の保存: 何も引きついでいなければ、閉じる前の確認を付けない', async () => {
  const { bg, guards } = setup(async () => {});
  assert.equal(bg.adopt('a'), null);
  await bg.settle('a');
  assert.equal(bg.hasPending(), false);
  assert.deepEqual(guards, []);
});

test('背景の保存: after が「保存済み」を返せば、保存し直さない', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg, guards } = setup(save);
  bg.hand('a', { deck: { title: 'y' }, save, after: Promise.resolve(true) });
  await bg.settle('a');
  assert.deepEqual(calls, []);
  assert.equal(bg.hasPending('a'), false);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: after が失敗を返せば保存する。track 中の処理は settle が待つ', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg } = setup(save);
  let finishTask;
  const task = new Promise((r) => { finishTask = r; });
  bg.track('a', task);
  assert.equal(bg.hasPending('a'), true);
  const d = { title: 'z' };
  bg.hand('a', { deck: d, save, after: Promise.resolve(false) });
  let settled = false;
  const s = bg.settle('a').then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, '画像の追加などが終わるまで待つ');
  finishTask();
  await s;
  assert.deepEqual(calls, [d]);
  assert.equal(bg.hasPending('a'), false);
});
