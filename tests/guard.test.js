import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTeacherAccess } from '../js/guard.js';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createRepo } from '../js/repo.js';
import { NetError } from '../js/errors.js';

function fakeAuth(user) {
  return { user, signOut() { this.user = null; } };
}

test('登録された先生は ok', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  assert.equal(await checkTeacherAccess({ auth: fakeAuth({ uid: 't1' }), repo: createRepo(net, 't1') }), 'ok');
});

test('ログインしていなければ signed-out', async () => {
  const net = createMemoryNet();
  assert.equal(await checkTeacherAccess({ auth: fakeAuth(null), repo: createRepo(net, 't1') }), 'signed-out');
});

test('登録されていなければ not-teacher で、ログアウトする', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 'x' });
  assert.equal(await checkTeacherAccess({ auth, repo: createRepo(net, 'x') }), 'not-teacher');
  assert.equal(auth.user, null);
});

test('通信できないときは offline で、ログアウトしない', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  net.setOnline(false);
  const auth = fakeAuth({ uid: 't1' });
  assert.equal(await checkTeacherAccess({ auth, repo: createRepo(net, 't1') }), 'offline');
  assert.deepEqual(auth.user, { uid: 't1' });
  const failing = { isTeacher: async () => { throw new NetError('network', 'x'); } };
  assert.equal(await checkTeacherAccess({ auth, repo: failing }), 'offline');
});

test('2 回の移動の間に先生の登録が外されたら、2 回目は not-teacher', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 't1' });
  const repo = createRepo(net, 't1');
  assert.equal(await checkTeacherAccess({ auth, repo }), 'ok');
  await net.remove('teacherList/t1');
  assert.equal(await checkTeacherAccess({ auth, repo }), 'not-teacher');
  assert.equal(auth.user, null);
});
