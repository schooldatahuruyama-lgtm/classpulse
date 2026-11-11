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

// uid は「今ログインしている先生」。既定は A
function setup({ uid = 'A' } = {}) {
  const timers = fakeTimers();
  const guards = [];
  const events = [];
  const login = { uid };
  const bg = createBackgroundSaver({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, retryMs: 5000,
    onGuard: (on) => guards.push(on), onEvent: (kind, title) => events.push([kind, title]),
    getCurrentUid: () => login.uid,
  });
  return { bg, timers, guards, events, login };
}

test('背景の保存: 失敗のあと成功すると、最新の内容で 1 回だけ保存され、知らせが出る', async () => {
  const calls = [];
  const saved = [];
  let fail = true;
  const save = async (deck) => { calls.push(deck); if (fail) throw new Error('通信なし'); saved.push(deck); };
  const { bg, timers, guards, events } = setup();
  const d1 = { title: '光' };
  const d2 = { title: '光2' };
  bg.hand('A', 'a', { deck: d1, save, title: '光', failed: true });
  await tick();
  assert.deepEqual(events, [['failing', '光']]);
  assert.equal(timers.size, 1);
  bg.hand('A', 'a', { deck: d2, save, title: '光2' }); // 新しい内容が来た（保存中でなければすぐ試す）
  await tick();
  fail = false;
  timers.runAll();
  await tick();
  timers.runAll();
  await tick();
  assert.deepEqual(saved, [d2], '保存できたのは最新の内容で 1 回だけ');
  assert.equal(timers.size, 0);
  assert.equal(bg.hasPending('A', 'a'), false);
  assert.deepEqual(events.filter(([k]) => k === 'failing').length, 1, '失敗の知らせは 1 回だけ');
  assert.deepEqual(events[events.length - 1], ['saved', '光2']);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: 成功したら 1 回だけ保存し、失敗がなければ「保存しました」は出さない', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg, events, guards } = setup();
  const d = { title: 't' };
  bg.hand('A', 'a', { deck: d, save, title: 't' });
  await tick();
  assert.deepEqual(calls, [d]);
  assert.deepEqual(events, []);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: adopt は引きついだ（新しい）内容を返し、再試行をやめる', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); throw new Error('通信なし'); };
  const { bg, timers, guards } = setup();
  const d = { title: 'x' };
  bg.hand('A', 'a', { deck: d, save, title: 'x' });
  await bg.settle('A', 'a');
  assert.equal(bg.adopt('A', 'a'), d);
  assert.equal(timers.size, 0);
  assert.equal(bg.adopt('A', 'a'), null);
  assert.equal(bg.hasPending('A', 'a'), false);
  assert.deepEqual(guards, [true, false]);
  assert.equal(calls.length, 1);
});

test('背景の保存: 何も引きついでいなければ、閉じる前の確認を付けない', async () => {
  const { bg, guards } = setup();
  assert.equal(bg.adopt('A', 'a'), null);
  await bg.settle('A', 'a');
  assert.equal(bg.hasPending(), false);
  assert.deepEqual(guards, []);
});

test('背景の保存: after が「保存済み」を返せば、保存し直さない', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg, guards } = setup();
  bg.hand('A', 'a', { deck: { title: 'y' }, save, after: Promise.resolve(true) });
  await bg.settle('A', 'a');
  assert.deepEqual(calls, []);
  assert.equal(bg.hasPending('A', 'a'), false);
  assert.deepEqual(guards, [true, false]);
});

test('背景の保存: after が失敗を返せば保存する。track 中の処理は settle が待つ', async () => {
  const calls = [];
  const save = async (deck) => { calls.push(deck); };
  const { bg } = setup();
  let finishTask;
  const task = new Promise((r) => { finishTask = r; });
  bg.track('A', 'a', task);
  assert.equal(bg.hasPending('A', 'a'), true);
  const d = { title: 'z' };
  bg.hand('A', 'a', { deck: d, save, after: Promise.resolve(false) });
  let settled = false;
  const s = bg.settle('A', 'a').then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, '画像の追加などが終わるまで待つ');
  finishTask();
  await s;
  assert.deepEqual(calls, [d]);
  assert.equal(bg.hasPending('A', 'a'), false);
});

// ---- 持ち主ごとに分ける ----

test('背景の保存: 別の先生（B）がログイン中は保存せず、B は引きつげない。A に戻ると 1 回だけ保存する', async () => {
  const savedA = [];
  let fail = true;
  const saveA = async (deck) => { if (fail) throw new Error('通信なし'); savedA.push(deck); };
  const { bg, timers, events, login } = setup({ uid: 'A' });
  const d = { title: 'Aの教材' };
  bg.hand('A', 'deck1', { deck: d, save: saveA, title: 'Aの教材', failed: true });
  await tick();
  assert.equal(events.length, 1, 'A がログイン中の失敗は知らせる');

  fail = false;
  login.uid = 'B'; // A がログアウトし、B がログインした
  timers.runAll();
  await tick();
  timers.runAll();
  await tick();
  assert.deepEqual(savedA, [], 'B のログイン中は A の教材を書かない');
  assert.equal(events.length, 1, 'B には知らせない');
  assert.equal(bg.adopt('B', 'deck1'), null, 'B の編集画面は A の内容を引きつがない');
  assert.equal(bg.hasPending('A', 'deck1'), true);

  login.uid = null; // ログアウト中も書かない
  timers.runAll();
  await tick();
  assert.deepEqual(savedA, []);

  login.uid = 'A'; // A が戻った
  timers.runAll();
  await tick();
  timers.runAll();
  await tick();
  assert.deepEqual(savedA, [d], 'A に戻ると 1 回だけ保存する');
  assert.equal(bg.hasPending('A', 'deck1'), false);
  assert.deepEqual(events[events.length - 1], ['saved', 'Aの教材']);
});

test('背景の保存: 同じ教材 ID でも、持ち主が違えば別のもの。保存はそれぞれの save で書く', async () => {
  const log = [];
  const { bg, login } = setup({ uid: 'A' });
  bg.hand('A', 'x', { deck: { t: 'a' }, save: async (d) => log.push(['A', d.t]) });
  await tick();
  login.uid = 'B';
  bg.hand('B', 'x', { deck: { t: 'b' }, save: async (d) => log.push(['B', d.t]) });
  await tick();
  assert.deepEqual(log, [['A', 'a'], ['B', 'b']]);
});


// ---- 削除の手続き（deleting） ----

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('削除: 削除の要求が終わるまで whenNotDeleting は待つ。成功のあとは、遅れて届いた画像の結果も含めて保存しない', async () => {
  let calls = 0;
  const save = async () => { calls += 1; throw new Error('通信なし'); };
  const { bg, timers, guards } = setup();
  bg.hand('A', 'a', { deck: { v: 1 }, save });
  await tick();
  assert.equal(calls, 1);
  const image = deferred();
  bg.track('A', 'a', image.promise); // 離れたあとも画像の追加が続いている

  const del = deferred();
  const p = bg.deleting('A', 'a', () => del.promise);
  let opened = false;
  const editor = bg.whenNotDeleting('A', 'a').then(() => { opened = true; });
  await tick();
  timers.runAll(); // 削除中は再試行しない
  await tick();
  assert.equal(calls, 1);
  assert.equal(opened, false, '編集画面は削除の手続きが終わるまで待つ');
  assert.equal(bg.adopt('A', 'a'), null, '削除中は引きつがない');

  del.resolve();
  await tick();
  // 画像の追加が終わり、教材を渡してくる
  bg.hand('A', 'a', { deck: { v: 2, image: true }, save });
  image.resolve();
  await p;
  await editor;
  assert.equal(opened, true);
  timers.runAll();
  await tick();
  assert.equal(calls, 1, '削除のあとは一度も保存しない');
  assert.equal(timers.size, 0);
  assert.equal(bg._hasState('A', 'a'), false, '何も残さない');
  assert.deepEqual(guards, [true, false]);
});

test('削除: 失敗したら、預かっていた最新の内容が保存待ちに戻り、再試行で保存される', async () => {
  const saved = [];
  let fail = true;
  const save = async (deck) => { if (fail) throw new Error('通信なし'); saved.push(deck); };
  const { bg, timers } = setup();
  const latest = { v: 3 };
  bg.hand('A', 'a', { deck: { v: 1 }, save });
  await tick();
  bg.hand('A', 'a', { deck: latest, save });
  await tick();
  const err = new Error('削除できない');
  await assert.rejects(bg.deleting('A', 'a', async () => { throw err; }), (e) => e === err);
  assert.equal(bg.hasPending('A', 'a'), true, '未保存の内容は残っている');
  await bg.whenNotDeleting('A', 'a');
  fail = false;
  timers.runAll();
  await tick();
  assert.deepEqual(saved, [latest]);
  assert.equal(bg._hasState('A', 'a'), false, '保存できたら何も残さない');
});

test('削除: 失敗したら、預かっていた最新の内容を引きつげる', async () => {
  const save = async () => { throw new Error('通信なし'); };
  const { bg, timers } = setup();
  const latest = { v: 9 };
  bg.hand('A', 'a', { deck: latest, save });
  await tick();
  await assert.rejects(bg.deleting('A', 'a', async () => { throw new Error('削除できない'); }));
  await bg.whenNotDeleting('A', 'a');
  await bg.settle('A', 'a');
  assert.equal(bg.adopt('A', 'a'), latest);
  assert.equal(timers.size, 0);
  assert.equal(bg._hasState('A', 'a'), false);
});

test('削除: 失敗のあとに届いた画像の結果は、ふつうに保存される', async () => {
  const saved = [];
  const save = async (deck) => { saved.push(deck); };
  const { bg } = setup();
  const image = deferred();
  bg.track('A', 'a', image.promise);
  await assert.rejects(bg.deleting('A', 'a', async () => { throw new Error('削除できない'); }));
  const withImage = { image: true };
  bg.hand('A', 'a', { deck: withImage, save });
  image.resolve();
  await bg.settle('A', 'a');
  assert.deepEqual(saved, [withImage]);
  assert.equal(bg._hasState('A', 'a'), false);
});

test('削除: 保存中に削除を始めると、その保存が済んでから doDelete を呼ぶ', async () => {
  const order = [];
  const inFlight = deferred();
  const save = () => { order.push('save-start'); return inFlight.promise.then(() => order.push('save-end')); };
  const { bg, timers } = setup();
  bg.hand('A', 'a', { deck: { v: 1 }, save });
  await tick();
  bg.hand('A', 'a', { deck: { v: 2 }, save }); // 保存中に新しい内容
  const p = bg.deleting('A', 'a', async () => { order.push('delete'); });
  await tick();
  assert.deepEqual(order, ['save-start']);
  inFlight.resolve();
  await p;
  timers.runAll();
  await tick();
  assert.deepEqual(order, ['save-start', 'save-end', 'delete'], '削除のあとに新しい内容を書かない');
  assert.equal(bg._hasState('A', 'a'), false);
});

test('削除: 編集画面の最後の保存（after）が済んでから doDelete を呼ぶ', async () => {
  const order = [];
  const flush = deferred();
  const { bg } = setup();
  bg.hand('A', 'a', { deck: { v: 1 }, save: async () => order.push('bg-save'), after: flush.promise.then(() => { order.push('flush'); return false; }) });
  const p = bg.deleting('A', 'a', async () => { order.push('delete'); });
  await tick();
  assert.deepEqual(order, []);
  flush.resolve();
  await p;
  await tick();
  assert.deepEqual(order, ['flush', 'delete']);
  assert.equal(bg._hasState('A', 'a'), false);
});

test('削除: 保存待ちが無くても、成功・失敗のどちらのあとも何も残さない', async () => {
  const { bg, guards } = setup();
  await bg.deleting('A', 'a', async () => {});
  assert.equal(bg._hasState('A', 'a'), false);
  await assert.rejects(bg.deleting('A', 'a', async () => { throw new Error('x'); }));
  assert.equal(bg._hasState('A', 'a'), false);
  assert.deepEqual(guards, []);
});