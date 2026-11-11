import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../js/outbox.js';
import { NetError } from '../js/errors.js';
import { fakeStorage } from './helpers/fakes.js';

const tick = () => new Promise((r) => setImmediate(r));

// 送信の代役。呼び出しを記録し、behavior(sid, slideId, choice) の結果で成功・失敗する
function makeSender(behavior = async () => {}) {
  const calls = [];
  const send = async (sid, slideId, choice) => {
    calls.push({ sid, slideId, choice });
    return behavior(sid, slideId, choice);
  };
  return { send, calls };
}

test('送れたら sent', async () => {
  const { send, calls } = makeSender();
  const ob = createOutbox({ storage: fakeStorage(), send });
  const e = await ob.put('s', 'q1', 1);
  assert.deepEqual(e, { choice: 1, state: 'sent' });
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'sent' });
  assert.equal(calls.length, 1);
});

test('つながらなければ queued で、flush で送る', async () => {
  let online = false;
  const { send, calls } = makeSender(async () => { if (!online) throw new NetError('network'); });
  const ob = createOutbox({ storage: fakeStorage(), send });
  await ob.put('s', 'q1', 1);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'queued' });
  online = true;
  await ob.flush('s');
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'sent' });
  assert.equal(calls.length, 2);
});

test('締切で拒否されたら rejected で、flush しても送らない', async () => {
  const { send, calls } = makeSender(async () => { throw new NetError('denied'); });
  const ob = createOutbox({ storage: fakeStorage(), send });
  await ob.put('s', 'q1', 1);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'rejected' });
  await ob.flush('s');
  assert.equal(calls.length, 1);
  assert.equal(ob.get('s', 'q1').state, 'rejected');
});

test('そのほかの失敗は failed', async () => {
  const { send } = makeSender(async () => { throw new Error('変なエラー'); });
  const ob = createOutbox({ storage: fakeStorage(), send });
  await ob.put('s', 'q1', 1);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'failed' });
});

test('続けて送ると最後の 1 つだけが残る', async () => {
  const gates = [];
  const { send, calls } = makeSender(() => new Promise((resolve) => gates.push(resolve)));
  const ob = createOutbox({ storage: fakeStorage(), send });
  const p1 = ob.put('s', 'q1', 1); // 1 回目の送信は終わっていない
  const p2 = ob.put('s', 'q1', 0);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 0, state: 'sending' });
  for (let i = 0; i < 5; i++) {
    await tick();
    const g = gates.shift();
    if (g) g();
  }
  await Promise.all([p1, p2]);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 0, state: 'sent' });
  assert.equal(calls[calls.length - 1].choice, 0);
});

test('続けて 3 回送ると、途中のものは送らず最後の値で終わる', async () => {
  const gates = [];
  const { send, calls } = makeSender(() => new Promise((resolve) => gates.push(resolve)));
  const ob = createOutbox({ storage: fakeStorage(), send });
  const ps = [ob.put('s', 'q1', 1), ob.put('s', 'q1', 2), ob.put('s', 'q1', 0)];
  for (let i = 0; i < 5; i++) {
    await tick();
    const g = gates.shift();
    if (g) g();
  }
  await Promise.all(ps);
  assert.deepEqual(calls.map((c) => c.choice), [1, 0]);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 0, state: 'sent' });
});

test('読み直しても送信済みが戻る', async () => {
  const storage = fakeStorage();
  const a = createOutbox({ storage, send: makeSender().send });
  await a.put('s', 'q1', 1);
  const b = createOutbox({ storage, send: makeSender().send });
  assert.deepEqual(b.get('s', 'q1'), { choice: 1, state: 'sent' });
});

test('読み直したとき sending のままのものは queued として扱う', async () => {
  const storage = fakeStorage();
  const a = createOutbox({ storage, send: () => new Promise(() => {}) }); // 終わらない送信
  a.put('s', 'q1', 1);
  assert.equal(a.get('s', 'q1').state, 'sending');
  const b = createOutbox({ storage, send: makeSender().send });
  assert.deepEqual(b.get('s', 'q1'), { choice: 1, state: 'queued' });
  await b.flush('s');
  assert.deepEqual(b.get('s', 'q1'), { choice: 1, state: 'sent' });
});

test('授業ごとに別', async () => {
  const storage = fakeStorage();
  const ob = createOutbox({ storage, send: makeSender().send });
  await ob.put('a', 'q1', 1);
  assert.equal(ob.get('b', 'q1'), null);
  await ob.put('b', 'q1', 0);
  ob.clear('a');
  assert.equal(ob.get('a', 'q1'), null);
  assert.deepEqual(ob.get('b', 'q1'), { choice: 0, state: 'sent' });
  assert.equal(storage.getItem('classpulse:outbox:a'), null);
  assert.notEqual(storage.getItem('classpulse:outbox:b'), null);
});

test('こわれた保存データは無いものとして扱う', () => {
  const storage = fakeStorage();
  storage.setItem('classpulse:outbox:s', '{こわれた');
  const ob = createOutbox({ storage, send: makeSender().send });
  assert.equal(ob.get('s', 'q1'), null);
});

test('送信中に再送の要求があり、その後に通信エラーで終わっても、送り直す', async () => {
  let first = true;
  const gates = [];
  const { send, calls } = makeSender(() => new Promise((resolve, reject) => {
    if (first) { first = false; gates.push(() => reject(new NetError('network'))); } else resolve();
  }));
  const ob = createOutbox({ storage: fakeStorage(), send });
  const p = ob.put('s', 'q1', 1);
  const f = ob.flush('s'); // 再接続の通知が先に届く
  gates.shift()(); // そのあと元の送信が通信エラーで終わる
  await Promise.all([p, f]);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'sent' });
  assert.equal(calls.length, 2);
});

test('送信中に clear して同じ質問を送りなおしても、新しい回答が送られる', async () => {
  const gates = [];
  const { send, calls } = makeSender(() => new Promise((resolve) => gates.push(resolve)));
  const ob = createOutbox({ storage: fakeStorage(), send });
  const old = ob.put('s', 'q1', 1); // 終わらない送信
  ob.clear('s');
  const fresh = ob.put('s', 'q1', 0);
  await tick();
  assert.deepEqual(calls.map((c) => c.choice), [1, 0]);
  gates.forEach((g) => g());
  await Promise.all([old, fresh]);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 0, state: 'sent' });
});

test('保存できないまま通信エラーなら failed で、読み直しても出ない。retry で送れる', async () => {
  const base = fakeStorage();
  const storage = { getItem: base.getItem, removeItem: base.removeItem, setItem: () => { throw new Error('容量不足'); } };
  let online = false;
  const { send } = makeSender(async () => { if (!online) throw new NetError('network'); });
  const ob = createOutbox({ storage, send });
  await ob.put('s', 'q1', 1);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'failed' });
  assert.equal(createOutbox({ storage, send }).get('s', 'q1'), null);
  await ob.flush('s');
  assert.equal(ob.get('s', 'q1').state, 'failed'); // flush は failed を送らない
  online = true;
  await ob.retry('s', 'q1');
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'sent' });
});

test('保存できないまま送れたら sent', async () => {
  const storage = { getItem: () => null, removeItem() {}, setItem: () => { throw new Error('容量不足'); } };
  const ob = createOutbox({ storage, send: makeSender().send });
  await ob.put('s', 'q1', 1);
  assert.deepEqual(ob.get('s', 'q1'), { choice: 1, state: 'sent' });
});

test('rejectPending は queued と failed だけを rejected にする', async () => {
  const { send } = makeSender(async (sid, slideId) => { if (slideId !== 'ok') throw new NetError('network'); });
  const ob = createOutbox({ storage: fakeStorage(), send });
  await ob.put('s', 'ok', 0);
  await ob.put('s', 'q', 1);
  assert.equal(ob.get('s', 'q').state, 'queued');
  assert.equal(ob.rejectPending('s', () => true), true);
  assert.equal(ob.get('s', 'q').state, 'rejected');
  assert.equal(ob.get('s', 'ok').state, 'sent');
  assert.equal(ob.rejectPending('s', () => true), false);
});
