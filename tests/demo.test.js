import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoBackend, isDemoAllowed } from '../js/dev/demo.js';
import { createRepo } from '../js/repo.js';
import { fakeStorage } from './helpers/fakes.js';

// 同じ名前の BroadcastChannel どうしで届け合う代役
function fakeBroadcastHub() {
  const all = new Set();
  return class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) {
      for (const c of all) if (c !== this && c.name === this.name && c.onmessage) c.onmessage({ data });
    }
    close() { all.delete(this); }
  };
}

function make(shared, BC, session = fakeStorage()) {
  return createDemoBackend({ storage: shared, sessionStorage: session, BroadcastChannel: BC, now: () => 1000 });
}

test('片方の書きこみが、もう片方の購読に届く', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  const seen = [];
  b.net.subscribe('x/y', (v) => seen.push(v));
  await a.net.set('x/y', 5);
  assert.deepEqual(seen, [null, 5]);
});

test('読み直し（新しい backend）でもデータが残る', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  await make(shared, BC).net.set('a/b', { c: 1 });
  assert.deepEqual(await make(shared, BC).net.get('a/b'), { c: 1 });
  assert.ok(shared.getItem('classpulse:demo:db'));
});

test('先生は何でもログインでき、teacherList に登録済み', async () => {
  const d = make(fakeStorage(), fakeBroadcastHub());
  const u = await d.teacherAuth.signInTeacher('a@b.c', 'zzz');
  assert.equal(u.uid, 'demo-teacher');
  assert.equal(d.teacherAuth.user.uid, 'demo-teacher');
  assert.equal(await createRepo(d.net, 'demo-teacher').isTeacher(), true);
  assert.equal(await createRepo(d.net, 'other').isTeacher(), false);
  d.teacherAuth.signOut();
  assert.equal(d.teacherAuth.user, null);
  assert.equal(await d.teacherAuth.getToken().catch(() => 'ng'), 'ng');
});

test('先生の restore は、ログイン済みのときだけ user を返す', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const d1 = make(shared, BC);
  assert.equal(await d1.teacherAuth.restore(), null);
  await d1.teacherAuth.signInTeacher('a@b.c', 'p');
  assert.equal((await make(shared, BC).teacherAuth.restore()).uid, 'demo-teacher');
});

test('生徒の uid はタブごとに別で、同じタブの読み直しでは同じ', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const tab1 = fakeStorage();
  const tab2 = fakeStorage();
  const u1 = (await make(shared, BC, tab1).studentAuth.signInAnonymous()).uid;
  const u1b = (await make(shared, BC, tab1).studentAuth.signInAnonymous()).uid;
  const u2 = (await make(shared, BC, tab2).studentAuth.signInAnonymous()).uid;
  assert.equal(u1, u1b);
  assert.notEqual(u1, u2);
  assert.notEqual(u1, 'demo-teacher');
});

test('auth の形は本物と同じメソッドを持つ', () => {
  const d = make(fakeStorage(), fakeBroadcastHub());
  for (const a of [d.teacherAuth, d.studentAuth]) {
    for (const m of ['signInTeacher', 'signInAnonymous', 'restore', 'getToken', 'forceRefresh', 'signOut']) {
      assert.equal(typeof a[m], 'function', m);
    }
    assert.ok('user' in a);
  }
});

test('受付中でない質問への回答、live でない授業への参加は拒否される', async () => {
  const d = make(fakeStorage(), fakeBroadcastHub());
  const { net } = d;
  await net.set('sessions/s1/pub', { state: 'live', polls: { p1: { status: 'closed' }, p2: { status: 'open' } } });
  await assert.rejects(net.set('sessions/s1/inbox/answers/p1/u1', { v: 1 }), { code: 'denied' });
  await net.set('sessions/s1/inbox/answers/p2/u1', { v: 1 });
  assert.deepEqual(await net.get('sessions/s1/inbox/answers/p2/u1'), { v: 1 });
  await net.set('sessions/s1/inbox/participants/u1', net.serverTimestamp());
  await net.set('sessions/s1/pub', { state: 'ended', polls: { p2: { status: 'open' } } });
  await assert.rejects(net.set('sessions/s1/inbox/answers/p2/u2', { v: 1 }), { code: 'denied' });
  await assert.rejects(net.set('sessions/s1/inbox/participants/u2', net.serverTimestamp()), { code: 'denied' });
});

test('isDemoAllowed は localhost 系の ?demo=1 だけ許す', () => {
  assert.equal(isDemoAllowed('example.github.io', '?demo=1'), false);
  assert.equal(isDemoAllowed('localhost', '?demo=1'), true);
  assert.equal(isDemoAllowed('127.0.0.1', '?demo=1'), true);
  assert.equal(isDemoAllowed('[::1]', '?demo=1'), true);
  assert.equal(isDemoAllowed('localhost', ''), false);
  assert.equal(isDemoAllowed('localhost', '?demo=0'), false);
  assert.equal(isDemoAllowed('localhost.evil.com', '?demo=1'), false);
  assert.equal(isDemoAllowed('localhost', '?x=1&demo=1'), true);
});

test('更新する場所を購読し、通知のたびに net.get しても、書きこみが巻き戻らない（set・update・remove）', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  const stored = () => JSON.parse(shared.getItem('classpulse:demo:db'));
  const seen = [];
  const gets = [];
  a.net.subscribe('x', (v) => {
    seen.push({ v, stored: stored().x ?? null });
    gets.push(a.net.get('x'));
  });
  await a.net.set('x', 1);
  assert.equal(await a.net.get('x'), 1);
  assert.equal(stored().x, 1);
  await a.net.update('', { x: 2 });
  assert.equal(await a.net.get('x'), 2);
  assert.equal(stored().x, 2);
  assert.equal(await b.net.get('x'), 2);
  await a.net.remove('x');
  assert.equal(await a.net.get('x'), null);
  assert.equal(stored().x ?? null, null);
  assert.equal(await b.net.get('x'), null);
  // 通知（最初の null、1、2、削除の null）の時点で、保存先も同じ値になっている
  assert.deepEqual(seen.map((s) => [s.v, s.stored]), [[null, null], [1, 1], [2, 2], [null, null]]);
  assert.deepEqual(await Promise.all(gets), [null, 1, 2, null]);
});

test('データを消すと、別の backend にも届き、消えたまま戻らない', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  await a.net.set('data/k', 1);
  const seen = [];
  b.net.subscribe('data/k', (v) => seen.push(v));
  a.net.clear();
  assert.deepEqual(seen, [1, null]);
  assert.equal(await b.net.get('data/k'), null);
  await b.net.set('other', 2);
  assert.equal(await b.net.get('data/k'), null);
  assert.equal(await a.net.get('data/k'), null);
  assert.equal(await createRepo(b.net, 'demo-teacher').isTeacher(), true);
});

test('保存先が壊れていても、今のデータを残す', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  await a.net.set('k', 1);
  shared.setItem('classpulse:demo:db', '{broken');
  assert.equal(await b.net.get('k'), 1);
});
