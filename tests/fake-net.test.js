import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet } from './helpers/fake-net.js';

test('複数パスの update: 各パスが書かれ、null は削除される', async () => {
  const net = createFakeNet();
  await net.set('s/pub', { polls: { p1: { status: 'open' } }, old: 1 });
  await net.update('s/pub', { 'polls/p1/status': 'closed', 'polls/p2/status': 'open', old: null });
  assert.deepEqual(await net.get('s/pub'), { polls: { p1: { status: 'closed' }, p2: { status: 'open' } } });
});

test('remove と null: 消すと get は null、親が空になれば親も消える', async () => {
  const net = createFakeNet();
  await net.set('a/b/c', 1);
  await net.remove('a/b/c');
  assert.equal(await net.get('a'), null);
  assert.equal(net.dump(), null);
});

test('空のオブジェクトと空の配列は保存されない', async () => {
  const net = createFakeNet();
  await net.set('a', { b: {} });
  assert.equal(await net.get('a'), null);
  await net.set('a', { b: [], c: 1 });
  assert.deepEqual(await net.get('a'), { c: 1 });
  await net.update('a', { c: {} });
  assert.equal(await net.get('a'), null);
});

test('サーバーの時刻は now() の値に置きかわる', async () => {
  const net = createFakeNet({ now: () => 12345 });
  await net.set('a', { at: net.serverTimestamp(), n: { t: net.serverTimestamp() } });
  await net.update('a', { 'm/t': net.serverTimestamp() });
  assert.deepEqual(await net.get('a'), { at: 12345, n: { t: 12345 }, m: { t: 12345 } });
});

test('get は写しを返す: 変えても中身は変わらない', async () => {
  const net = createFakeNet();
  await net.set('a', { b: 1 });
  const v = await net.get('a');
  v.b = 2;
  assert.equal((await net.get('a')).b, 1);
  net.dump().a.b = 3;
  assert.equal((await net.get('a')).b, 1);
});

test('購読: 最初の値、自分・親・子の変更を受け取り、関係ない場所の変更は受け取らない', async () => {
  const net = createFakeNet();
  const got = [];
  net.subscribe('a/b', (v) => got.push(v));
  assert.deepEqual(got, [null]);
  await net.set('a/b/c', 1); // 子
  await net.set('a/b', { c: 2 }); // 自分
  await net.set('a', { b: { c: 3 } }); // 親
  await net.set('z', 1); // 関係ない
  assert.deepEqual(got, [null, { c: 1 }, { c: 2 }, { c: 3 }]);
});

test('購読: 渡された値を変えても内部は変わらない。やめると届かない', async () => {
  const net = createFakeNet();
  await net.set('a', { b: 1 });
  const got = [];
  const stop = net.subscribe('a', (v) => got.push(v));
  got[0].b = 99;
  assert.equal((await net.get('a')).b, 1);
  stop();
  await net.set('a/b', 2);
  assert.equal(got.length, 1);
});

test('update は複数パスを書いても購読者に 1 回だけ知らせる', async () => {
  const net = createFakeNet();
  const got = [];
  net.subscribe('a', (v) => got.push(v));
  await net.update('a', { x: 1, y: 2 });
  assert.equal(got.length, 2);
  assert.deepEqual(got[1], { x: 1, y: 2 });
});

test('deny が真なら NetError(denied) で、何も書かれない', async () => {
  const calls = [];
  const net = createFakeNet({ deny: (op, path, value) => { calls.push([op, path, value]); return path.startsWith('locked'); } });
  await assert.rejects(net.set('locked/a', 1), (e) => e.name === 'NetError' && e.code === 'denied');
  await assert.rejects(net.get('locked/a'), (e) => e.code === 'denied');
  await assert.rejects(net.update('locked', { a: 1 }), (e) => e.code === 'denied');
  await assert.rejects(net.remove('locked/a'), (e) => e.code === 'denied');
  assert.equal(net.dump(), null);
  assert.deepEqual(calls[2], ['update', 'locked', { a: 1 }]);
  await net.set('open/a', 1);
  assert.equal(await net.get('open/a'), 1);
});

test('setOnline(false): 読み書きは network、購読には disconnected、戻すと connected と今の値', async () => {
  const net = createFakeNet();
  await net.set('a', 1);
  const values = [];
  const statuses = [];
  net.subscribe('a', (v) => values.push(v), (s) => statuses.push(s));
  assert.deepEqual(statuses, ['connected']);
  net.setOnline(false);
  assert.deepEqual(statuses, ['connected', 'disconnected']);
  await assert.rejects(net.get('a'), (e) => e.code === 'network');
  await assert.rejects(net.set('a', 2), (e) => e.code === 'network');
  await assert.rejects(net.update('a', { b: 1 }), (e) => e.code === 'network');
  await assert.rejects(net.remove('a'), (e) => e.code === 'network');
  net.setOnline(true);
  assert.deepEqual(statuses, ['connected', 'disconnected', 'connected']);
  assert.equal(values.at(-1), 1);
  assert.equal(await net.get('a'), 1);
});

test('配列は添字キーで保存される: 最後の要素を消すと親も消え、購読には null が届く', async () => {
  const net = createFakeNet();
  await net.set('a', [null, 1]);
  const got = [];
  net.subscribe('a', (v) => got.push(v));
  await net.remove('a/1');
  assert.equal(await net.get('a'), null);
  assert.equal('a' in (net.dump() ?? {}), false);
  assert.equal(got.at(-1), null);
});

test('配列の読み出し: 半分より多く埋まっていれば欠けを null にした配列（get・dump・購読で同じ）', async () => {
  const net = createFakeNet();
  await net.set('a', ['x', 'y', 'z']);
  assert.deepEqual(await net.get('a'), ['x', 'y', 'z']);
  const got = [];
  net.subscribe('a', (v) => got.push(v));
  await net.remove('a/1');
  assert.deepEqual(await net.get('a'), ['x', null, 'z']);
  assert.deepEqual(net.dump().a, ['x', null, 'z']);
  assert.deepEqual(got.at(-1), ['x', null, 'z']);
});

test('配列の読み出し: 半分以下しか埋まっていなければオブジェクトのまま', async () => {
  const net = createFakeNet();
  await net.set('a/0', 'x');
  await net.set('a/5', 'y');
  assert.deepEqual(await net.get('a'), { 0: 'x', 5: 'y' });
  await net.set('b', [null, 'q']);
  assert.deepEqual(await net.get('b'), { 1: 'q' });
  assert.deepEqual(net.dump().b, { 1: 'q' });
  await net.remove('b/1');
  assert.equal(await net.get('b'), null);
});
