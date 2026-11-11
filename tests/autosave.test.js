import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaver } from '../js/autosave.js';

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// 手で進める代役のタイマー
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

// 完了を手で決められる save
function setup({ delayMs = 1000, retryMs = 5000 } = {}) {
  const timers = fakeTimers();
  const saved = [];
  const states = [];
  const pendingSaves = [];
  let mode = 'auto'; // auto: すぐ成功 / manual: resolve を待つ / fail: 失敗
  const save = (deck) => {
    saved.push(deck);
    if (mode === 'fail') return Promise.reject(new Error('失敗'));
    if (mode === 'manual') return new Promise((resolve) => pendingSaves.push(resolve));
    return Promise.resolve();
  };
  const saver = createAutosaver({
    save, delayMs, retryMs,
    onState: (s) => states.push(s),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return { timers, saver, saved, states, pendingSaves, setMode: (m) => { mode = m; } };
}

test('1 秒まとめて 1 回だけ保存する', async () => {
  const { timers, saver, saved, states } = setup();
  saver.touch({ v: 1 });
  saver.touch({ v: 2 });
  saver.touch({ v: 3 });
  assert.equal(saver.hasPending(), true);
  await timers.advance(999);
  assert.equal(saved.length, 0);
  await timers.advance(1);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { v: 3 });
  assert.deepEqual(states, ['saving', 'saved']);
  assert.equal(saver.hasPending(), false);
});

test('保存中の変更は、終わってからもう 1 回保存する', async () => {
  const { timers, saver, saved, states, pendingSaves, setMode } = setup();
  setMode('manual');
  saver.touch({ v: 1 });
  await timers.advance(1000);
  assert.equal(saved.length, 1);
  saver.touch({ v: 2 });
  await timers.advance(5000);
  assert.equal(saved.length, 1, '保存中は 2 つ目を始めない');
  assert.equal(saver.hasPending(), true);
  pendingSaves[0]();
  await settle();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1], { v: 2 });
  pendingSaves[1]();
  await settle();
  assert.equal(saver.hasPending(), false);
  assert.equal(states[states.length - 1], 'saved');
});

test('失敗したら変更を持ったまま再試行する', async () => {
  const { timers, saver, saved, states, setMode } = setup();
  setMode('fail');
  saver.touch({ v: 1 });
  await timers.advance(1000);
  assert.deepEqual(states, ['saving', 'failed']);
  assert.equal(saver.hasPending(), true);
  setMode('auto');
  await timers.advance(4999);
  assert.equal(saved.length, 1);
  await timers.advance(1);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1], { v: 1 });
  assert.deepEqual(states, ['saving', 'failed', 'saving', 'saved']);
  assert.equal(saver.hasPending(), false);
});

test('retry() ですぐ再試行する', async () => {
  const { timers, saver, saved, states, setMode } = setup();
  setMode('fail');
  saver.touch({ v: 1 });
  await timers.advance(1000);
  setMode('auto');
  saver.retry();
  await settle();
  assert.equal(saved.length, 2);
  assert.equal(states[states.length - 1], 'saved');
  await timers.advance(10000);
  assert.equal(saved.length, 2, '予約していた再試行は取り消される');
});

test('失敗中に変更があれば新しい内容で再試行する', async () => {
  const { timers, saver, saved, setMode } = setup();
  setMode('fail');
  saver.touch({ v: 1 });
  await timers.advance(1000);
  saver.touch({ v: 2 });
  setMode('auto');
  await timers.advance(1000);
  assert.deepEqual(saved[saved.length - 1], { v: 2 });
});

test('flush はすぐ保存して、終わるまで待つ', async () => {
  const { timers, saver, saved, states, pendingSaves, setMode } = setup();
  setMode('manual');
  saver.touch({ v: 1 });
  let done = false;
  const p = saver.flush().then(() => { done = true; });
  await settle();
  assert.equal(saved.length, 1, '1 秒待たずに保存する');
  assert.equal(done, false);
  pendingSaves[0]();
  await p;
  assert.equal(done, true);
  assert.equal(saver.hasPending(), false);
  assert.equal(states[states.length - 1], 'saved');
  await timers.advance(5000);
  assert.equal(saved.length, 1);
});

test('変更が無ければ flush はすぐ終わる', async () => {
  const { saver, saved } = setup();
  await saver.flush();
  assert.equal(saved.length, 0);
});
