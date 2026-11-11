import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundSaver } from '../js/views/editor/background-save.js';
import { createAutosaver } from '../js/autosave.js';

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

// ---- 保存の関門（guardedSave）と、削除済みの印 ----

// 編集画面と同じ形の保存: 関門を通し、断られたら失敗として扱う
function viewSave(bg, uid, deckId, write) {
  return async (deck) => {
    if (!(await bg.guardedSave(uid, deckId, deck, write))) throw new Error('断られた');
  };
}

test('関門: ふつうは write で書いて true を返す。write の失敗はそのまま投げる', async () => {
  const written = [];
  const { bg } = setup();
  const d = { v: 1 };
  assert.equal(await bg.guardedSave('A', 'a', d, async (deck) => { written.push(deck); }), true);
  assert.deepEqual(written, [d]);
  const err = new Error('通信なし');
  await assert.rejects(bg.guardedSave('A', 'a', d, async () => { throw err; }), (e) => e === err);
  assert.equal(bg.isDeleted('A', 'a'), false);
  assert.equal(bg._hasState('A', 'a'), false);
});

test('関門: 削除に成功したあとは、直接の保存・待っていた再試行・遅れて届いた画像のどれも書かない', async () => {
  let calls = 0;
  let fail = true;
  const write = async () => { calls += 1; if (fail) throw new Error('通信なし'); };
  const { bg, timers, guards } = setup();
  const save = viewSave(bg, 'A', 'a', write);
  bg.hand('A', 'a', { deck: { v: 1 }, save });
  await tick();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1, '再試行を待っている');

  await bg.deleting('A', 'a', async () => {});
  fail = false;
  assert.equal(bg.isDeleted('A', 'a'), true);
  // 待っていた再試行
  timers.runAll();
  await tick();
  // 古い編集画面からの直接の保存
  assert.equal(await bg.guardedSave('A', 'a', { v: 2 }, write), false, '断ったことを返す');
  await assert.rejects(save({ v: 2 }), /断られた/, '編集画面の保存は失敗になる（「保存済み」にならない）');
  // 遅れて届いた画像の結果
  bg.hand('A', 'a', { deck: { v: 3, image: true }, save });
  bg.hand('A', 'a', { deck: { v: 4, image: true }, save, after: Promise.resolve(false) });
  await bg.settle('A', 'a');
  timers.runAll();
  await tick();
  assert.equal(calls, 1, '削除のあとは一度も書かない');
  assert.equal(timers.size, 0);
  assert.equal(bg.adopt('A', 'a'), null);
  assert.equal(bg._hasState('A', 'a'), false, '保存待ちは残さない');
  assert.equal(guards[guards.length - 1], false, '閉じる前の確認も残さない');
});

test('関門: 未保存の変更と処理中の画像 → 離れる → 離れるときの保存が失敗 → 削除成功 → 画像完了、でも書かない', async () => {
  const written = [];
  let fail = true;
  const write = async (deck) => { if (fail) throw new Error('通信なし'); written.push(deck); };
  const { bg, timers } = setup();
  const viewTimers = fakeTimers();
  const states = [];
  const save = viewSave(bg, 'A', 'a', write);
  // 編集画面の自動保存
  const autosaver = createAutosaver({
    save, delayMs: 800, retryMs: 5000, maxWaitMs: 0, onState: (st) => states.push(st),
    setTimeout: viewTimers.setTimeout, clearTimeout: viewTimers.clearTimeout,
  });
  const image = deferred();
  bg.track('A', 'a', image.promise);       // 画像を処理中
  const d1 = { v: 1 };
  autosaver.touch(d1);                     // 未保存の変更
  // 「一覧へ」を押した古い処理は、画像を待っている（待ったあとの確認が抜けていた場合を再現する）
  const staleLeave = image.promise.then(() => autosaver.flush());

  // ブラウザの「戻る」で画面を離れる: 最後の保存を始め、画面の外の保存へ渡す
  const flushDone = autosaver.flush();
  bg.hand('A', 'a', { deck: d1, save, after: flushDone.then(() => false, () => false) });
  await flushDone;                         // 離れるときの保存は失敗
  await tick();
  assert.equal(states[states.length - 1], 'failed');
  assert.deepEqual(written, []);

  // 一覧で削除する（成功）。通信は戻っている
  fail = false;
  let deleteCalls = 0;
  const del = bg.deleting('A', 'a', async () => { deleteCalls += 1; });
  await tick();
  assert.equal(deleteCalls, 1);
  assert.equal(bg.isDeleted('A', 'a'), true, '成功した時点で印が付く（画像を待っている間も）');

  // 画像が完了: 教材に入れて渡し、待っていた古い処理が保存しようとする
  const d2 = { v: 2, image: true };
  autosaver.touch(d2);
  bg.hand('A', 'a', { deck: d2, save, after: flushDone.then(() => false, () => false) });
  image.resolve();
  await staleLeave;
  await del;
  await bg.settle('A', 'a');
  timers.runAll();
  viewTimers.runAll();
  await tick();
  timers.runAll();
  await tick();
  assert.deepEqual(written, [], '削除した教材を書き直さない');
  assert.notEqual(states[states.length - 1], 'saved', '「保存済み」と出さない');
  assert.equal(bg._hasState('A', 'a'), false);
  assert.equal(timers.size, 0);
});

test('関門: 削除の手続き中（終わる前）は書かない。書いている途中の保存は、済んでから doDelete を呼ぶ', async () => {
  const order = [];
  const inFlight = deferred();
  const { bg } = setup();
  const first = bg.guardedSave('A', 'a', { v: 1 }, () => { order.push('write-start'); return inFlight.promise.then(() => { order.push('write-end'); }); });
  const del = deferred();
  const p = bg.deleting('A', 'a', () => { order.push('delete'); return del.promise; });
  await tick();
  assert.deepEqual(order, ['write-start'], '書いている途中は削除を始めない');
  let calls = 0;
  assert.equal(await bg.guardedSave('A', 'a', { v: 2 }, async () => { calls += 1; }), false, '削除を待っている間');
  inFlight.resolve();
  assert.equal(await first, true);
  await tick();
  assert.deepEqual(order, ['write-start', 'write-end', 'delete']);
  assert.equal(await bg.guardedSave('A', 'a', { v: 3 }, async () => { calls += 1; }), false, '削除の要求中');
  assert.equal(bg.isDeleted('A', 'a'), false, 'まだ成功していない');
  del.resolve();
  await p;
  assert.equal(calls, 0);
  assert.equal(bg.isDeleted('A', 'a'), true);
});

test('関門: 削除に失敗したら印は付かず、また書ける。預かっていた未保存の内容は再試行で保存される', async () => {
  const written = [];
  let fail = true;
  const write = async (deck) => { if (fail) throw new Error('通信なし'); written.push(deck); };
  const { bg, timers } = setup();
  const save = viewSave(bg, 'A', 'a', write);
  const kept = { v: 1 };
  bg.hand('A', 'a', { deck: kept, save });
  await tick();
  const del = deferred();
  const p = bg.deleting('A', 'a', () => del.promise);
  await tick();
  assert.equal(await bg.guardedSave('A', 'a', { v: 9 }, write), false, '手続き中は書かない');
  del.reject(new Error('削除できない'));
  await assert.rejects(p);
  assert.equal(bg.isDeleted('A', 'a'), false, '失敗では印を付けない');
  assert.equal(bg.hasPending('A', 'a'), true, '未保存の内容は残っている');
  await bg.settle('A', 'a'); // 削除の失敗の直後に再開した保存（まだ通信なし）が終わるのを待つ
  assert.deepEqual(written, []);
  fail = false;
  timers.runAll();
  await tick();
  assert.deepEqual(written, [kept], '再試行で保存される');
  const direct = { v: 2 };
  assert.equal(await bg.guardedSave('A', 'a', direct, write), true, '直接の保存もまた通る');
  assert.deepEqual(written, [kept, direct]);
  assert.equal(bg._hasState('A', 'a'), false);
});

test('関門: 同じ教材 ID でも、別の先生の教材には影響しない', async () => {
  const written = [];
  const { bg, login } = setup({ uid: 'A' });
  await bg.deleting('A', 'x', async () => {});
  assert.equal(bg.isDeleted('A', 'x'), true);
  assert.equal(bg.isDeleted('B', 'x'), false);
  login.uid = 'B';
  const write = async (deck) => { written.push(deck); };
  const d1 = { t: 'b1' };
  const d2 = { t: 'b2' };
  assert.equal(await bg.guardedSave('B', 'x', d1, write), true);
  bg.hand('B', 'x', { deck: d2, save: viewSave(bg, 'B', 'x', write) });
  await bg.settle('B', 'x');
  assert.deepEqual(written, [d1, d2]);
  assert.equal(await bg.guardedSave('A', 'x', { t: 'a' }, write), false);
  assert.deepEqual(written, [d1, d2]);
});
// ---- ホームから発表を始める前に、背景の保存が落ち着くのを待つ ----

test('whenIdle: 何も預かっていなければ、すぐ true', async () => {
  const { bg } = setup();
  assert.equal(await bg.whenIdle('A', 'a'), true);
});

test('whenIdle: 保存の途中なら終わるまで待ち、保存できたら true', async () => {
  let release;
  const saved = [];
  const save = async (deck) => { await new Promise((r) => { release = r; }); saved.push(deck); };
  const { bg } = setup();
  const d = { title: 't' };
  bg.hand('A', 'a', { deck: d, save, title: 't' });
  let done = null;
  bg.whenIdle('A', 'a').then((v) => { done = v; });
  await tick();
  assert.equal(done, null); // まだ保存中
  release();
  await tick();
  assert.equal(done, true);
  assert.deepEqual(saved, [d]);
});

test('whenIdle: 保存に失敗して再試行を待っているなら false（待ち続けない）', async () => {
  const save = async () => { throw new Error('通信なし'); };
  const { bg, timers } = setup();
  bg.hand('A', 'a', { deck: { title: 't' }, save, title: 't' });
  assert.equal(await bg.whenIdle('A', 'a'), false);
  assert.equal(timers.size, 1); // 再試行は続いている
  assert.equal(await bg.whenIdle('A', 'other'), true); // 別の教材には関係しない
  assert.equal(await bg.whenIdle('B', 'a'), true);     // 別の先生にも関係しない
});

test('whenIdle: 編集画面の最後の保存（after）と画像の追加も待つ', async () => {
  let finishAfter;
  let finishTask;
  const { bg } = setup();
  const save = async () => {};
  bg.track('A', 'a', new Promise((r) => { finishTask = r; }));
  bg.hand('A', 'a', { deck: { title: 't' }, save, title: 't', after: new Promise((r) => { finishAfter = r; }) });
  let done = null;
  bg.whenIdle('A', 'a').then((v) => { done = v; });
  await tick();
  assert.equal(done, null);
  finishAfter(true); // 編集画面の保存で、もう保存できていた
  await tick();
  assert.equal(done, null); // 画像の追加がまだ
  finishTask();
  await tick();
  await tick();
  assert.equal(done, true);
});
