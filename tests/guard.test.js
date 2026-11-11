import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTeacherAccess, isStillUser } from '../js/guard.js';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createRepo } from '../js/repo.js';
import { NetError } from '../js/errors.js';

function fakeAuth(user) {
  return { user, signOut() { this.user = null; } };
}
const check = async (auth, repo) => (await checkTeacherAccess({ auth, repo })).verdict;

test('登録された先生は ok（確かめた uid も返る）', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  assert.deepEqual(await checkTeacherAccess({ auth: fakeAuth({ uid: 't1' }), repo: createRepo(net, 't1') }), { verdict: 'ok', uid: 't1' });
});

test('ログインしていなければ signed-out', async () => {
  const net = createMemoryNet();
  assert.deepEqual(await checkTeacherAccess({ auth: fakeAuth(null), repo: createRepo(net, 't1') }), { verdict: 'signed-out', uid: null });
});

test('登録されていなければ not-teacher。判定だけで、ログアウトはしない', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 'x' });
  assert.equal(await check(auth, createRepo(net, 'x')), 'not-teacher');
  assert.deepEqual(auth.user, { uid: 'x' });
});

test('通信できないときは offline（ログインは保たれる）', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  net.setOnline(false);
  const auth = fakeAuth({ uid: 't1' });
  assert.equal(await check(auth, createRepo(net, 't1')), 'offline');
  const failing = { isTeacher: async () => { throw new NetError('network', 'x'); } };
  assert.deepEqual(await checkTeacherAccess({ auth, repo: failing }), { verdict: 'offline', uid: 't1' });
  assert.deepEqual(auth.user, { uid: 't1' });
});

test('ログインは成功したが登録の確認だけ offline → 通信が戻って確かめ直すと ok', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 't1' }); // ログイン直後
  net.setOnline(false);
  assert.equal(await check(auth, createRepo(net, 't1')), 'offline');
  assert.deepEqual(auth.user, { uid: 't1' });
  net.setOnline(true);
  assert.equal(await check(auth, createRepo(net, 't1')), 'ok');
});

test('2 回の移動の間に先生の登録が外されたら、2 回目は not-teacher', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 't1' });
  const repo = createRepo(net, 't1');
  assert.equal(await check(auth, repo), 'ok');
  await net.remove('teacherList/t1');
  assert.equal(await check(auth, repo), 'not-teacher');
});

test('古い確認の応答: A の確認中に B に替わったら、呼び出し側は B を外さない', async () => {
  const auth = fakeAuth({ uid: 'A' });
  let release;
  const repoA = { isTeacher: () => new Promise((r) => { release = r; }) };
  const pending = checkTeacherAccess({ auth, repo: repoA });
  auth.signOut();
  auth.user = { uid: 'B' }; // B がログイン
  release(false);
  const { verdict, uid } = await pending;
  assert.equal(verdict, 'not-teacher');
  assert.equal(uid, 'A');
  // main.js と同じ判断: 今の人が確かめた人と同じときだけ外す
  let notice = '';
  if (isStillUser(auth, uid)) { auth.signOut(); notice = 'x'; }
  assert.deepEqual(auth.user, { uid: 'B' });
  assert.equal(notice, '');
  assert.equal(isStillUser(auth, 'B'), true);
  assert.equal(isStillUser(fakeAuth(null), null), true);
});
