import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../js/net.js';
import { NetError } from '../js/errors.js';
import { fakeFetch, fakeEventSource } from './helpers/fakes.js';

const DB = 'https://example-db.firebaseio.com';

// 数えられるログインの代役
function stubAuth() {
  const auth = {
    refreshes: 0,
    token: 'tok',
    getToken: async () => auth.token,
    forceRefresh: async () => { auth.refreshes += 1; auth.token = 'tok2'; return auth.token; },
  };
  return auth;
}

function make(handler = () => ({ status: 200, body: null })) {
  const auth = stubAuth();
  const fetch = fakeFetch(handler);
  const ES = fakeEventSource();
  const net = createNet({ databaseURL: DB, auth, fetch, EventSource: ES });
  return { net, auth, fetch, ES };
}

const flush = () => new Promise((r) => setImmediate(r));

// 購読を始めて、最初の接続を開いた状態にする
async function subscribed() {
  const m = make();
  const values = [];
  const statuses = [];
  const stop = m.net.subscribe('sessions/x/pub', (v) => values.push(v), (s) => statuses.push(s));
  await flush();
  const es = m.ES.last;
  es.open();
  return { ...m, es, values, statuses, stop };
}

test('読む: GET <databaseURL>/パス.json?auth=トークン を呼び、本文の JSON を返す', async () => {
  const { net, fetch } = make(() => ({ status: 200, body: { x: 1 } }));
  assert.deepEqual(await net.get('a/b'), { x: 1 });
  assert.equal(fetch.calls[0].url, `${DB}/a/b.json?auth=tok`);
  assert.equal(fetch.calls[0].init.method, 'GET');
});

test('読む: 無ければ null を返す', async () => {
  const { net } = make(() => ({ status: 200, body: null }));
  assert.equal(await net.get('a/none'), null);
});

test('書く: set は PUT、update は PATCH、remove は DELETE', async () => {
  const { net, fetch } = make();
  await net.set('a/b', { n: 1 });
  await net.update('a', { 'b/c': 2, d: null });
  await net.remove('a/b');
  assert.deepEqual(fetch.calls.map((c) => c.init.method), ['PUT', 'PATCH', 'DELETE']);
  assert.equal(fetch.calls[0].url, `${DB}/a/b.json?auth=tok`);
  assert.equal(fetch.calls[0].init.body, JSON.stringify({ n: 1 }));
  assert.equal(fetch.calls[2].init.body, undefined);
});

test('一部を書く: 複数パスのキーと null がそのままの JSON で送られる', async () => {
  const { net, fetch } = make();
  const patch = { 'polls/s2/status': 'closed', current: { slideId: 's3', pollId: null } };
  await net.update('sessions/x/pub', patch);
  assert.equal(fetch.calls[0].url, `${DB}/sessions/x/pub.json?auth=tok`);
  assert.equal(fetch.calls[0].init.body, JSON.stringify(patch));
});

test('サーバーの時刻: serverTimestamp は { ".sv": "timestamp" } を返す', () => {
  const { net } = make();
  assert.deepEqual(net.serverTimestamp(), { '.sv': 'timestamp' });
});

test('拒否は denied: 403 で code が denied になる', async () => {
  const { net } = make(() => ({ status: 403, body: { error: 'Permission denied' } }));
  await assert.rejects(net.get('a'), (e) => e instanceof NetError && e.code === 'denied');
});

test('401 は更新して 1 回やり直す: 2 回目で成功し forceRefresh は 1 回、新しいトークンを使う', async () => {
  let n = 0;
  const { net, auth, fetch } = make(() => (++n === 1 ? { status: 401, body: {} } : { status: 200, body: { ok: 1 } }));
  assert.deepEqual(await net.get('a'), { ok: 1 });
  assert.equal(auth.refreshes, 1);
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls[1].url.endsWith('?auth=tok2'));
});

test('401 が 2 回続くと auth になる（やり直しは 1 回だけ）', async () => {
  const { net, auth, fetch } = make(() => ({ status: 401, body: {} }));
  await assert.rejects(net.get('a'), (e) => e.code === 'auth');
  assert.equal(auth.refreshes, 1);
  assert.equal(fetch.calls.length, 2);
});

test('fetch の失敗は network、そのほかの HTTP エラーは unknown', async () => {
  const a = make(() => new Error('offline'));
  await assert.rejects(a.net.set('a', 1), (e) => e.code === 'network');
  const b = make(() => ({ status: 500, body: {} }));
  await assert.rejects(b.net.get('a'), (e) => e.code === 'unknown');
});

test('変化の受信: URL は <databaseURL>/パス.json?auth=トークン', async () => {
  const { es } = await subscribed();
  assert.equal(es.url, `${DB}/sessions/x/pub.json?auth=tok`);
});

test('変化の受信で全体の値を組み立てる: put と patch と削除', async () => {
  const { es, values } = await subscribed();
  es.emit('put', { path: '/', data: { a: 1, b: { c: 2 } } });
  assert.deepEqual(values.at(-1), { a: 1, b: { c: 2 } });
  es.emit('put', { path: '/b/c', data: 3 });
  assert.deepEqual(values.at(-1), { a: 1, b: { c: 3 } });
  es.emit('patch', { path: '/b', data: { d: 4 } });
  assert.deepEqual(values.at(-1), { a: 1, b: { c: 3, d: 4 } });
  es.emit('put', { path: '/a', data: null });
  assert.deepEqual(values.at(-1), { b: { c: 3, d: 4 } });
  es.emit('put', { path: '/', data: null });
  assert.equal(values.at(-1), null);
  assert.equal(values.length, 5);
});

test('変化の受信: keep-alive は無視し、渡した値を変えても内部の値は壊れない', async () => {
  const { es, values } = await subscribed();
  es.emit('put', { path: '/', data: { a: { b: 1 } } });
  es.emit('keep-alive', 'null');
  assert.equal(values.length, 1);
  values[0].a.b = 99;
  es.emit('put', { path: '/z', data: 1 });
  assert.deepEqual(values.at(-1), { a: { b: 1 }, z: 1 });
});

test('接続の状態を知らせる: 開いたら connected、error で disconnected、開き直ったら connected', async () => {
  const { es, statuses } = await subscribed();
  assert.deepEqual(statuses, ['connected']);
  es.fail();
  assert.deepEqual(statuses, ['connected', 'disconnected']);
  es.open();
  assert.deepEqual(statuses, ['connected', 'disconnected', 'connected']);
});

test('cancel は disconnected を知らせて接続を閉じる', async () => {
  const { es, statuses } = await subscribed();
  es.emit('cancel', 'null');
  assert.equal(statuses.at(-1), 'disconnected');
  assert.equal(es.closed, true);
});

test('期限切れでつなぎ直す: auth_revoked で今の接続を閉じ、forceRefresh のあと新しいトークンで開き直す', async () => {
  const { es, auth, ES } = await subscribed();
  es.emit('auth_revoked', 'null');
  assert.equal(es.closed, true);
  await flush();
  assert.equal(auth.refreshes, 1);
  assert.equal(ES.instances.length, 2);
  assert.equal(ES.last.url, `${DB}/sessions/x/pub.json?auth=tok2`);
});

test('購読をやめると close が呼ばれ、以後 onValue は呼ばれない', async () => {
  const { es, values, stop } = await subscribed();
  es.emit('put', { path: '/', data: { a: 1 } });
  stop();
  assert.equal(es.closed, true);
  es.emit('put', { path: '/a', data: 2 });
  assert.equal(values.length, 1);
});

test('接続の前に購読をやめると、接続を作らない', async () => {
  const { net, ES } = make();
  const stop = net.subscribe('a', () => {});
  stop();
  await flush();
  assert.equal(ES.instances.length, 0);
});
