import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../js/auth.js';
import { NetError } from '../js/errors.js';
import { fakeStorage, fakeFetch, fakeClock } from './helpers/fakes.js';

const MIN = 60 * 1000;
const isSignIn = (u) => u.includes('accounts:signInWithPassword');
const isSignUp = (u) => u.includes('accounts:signUp');
const isToken = (u) => u.includes('securetoken.googleapis.com/v1/token');

function teacherHandler(url) {
  if (isSignIn(url)) {
    return { status: 200, body: { localId: 'T1', email: 't@example.com', idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' } };
  }
  if (isToken(url)) {
    return { status: 200, body: { user_id: 'T1', id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' } };
  }
  return { status: 404, body: {} };
}

function make(handler, role = 'teacher', storage = fakeStorage(), clock = fakeClock(1000)) {
  const fetch = fakeFetch(handler);
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: clock.now, role });
  return { auth, fetch, storage, clock };
}

test('先生のログイン: 正しい本文を送り、uid とメールを返す。パスワードは保存しない', async () => {
  const { auth, fetch, storage } = make(teacherHandler);
  const user = await auth.signInTeacher('t@example.com', 'fake-pass-xyz');
  assert.deepEqual(user, { uid: 'T1', email: 't@example.com' });
  assert.deepEqual(auth.user, { uid: 'T1', email: 't@example.com' });
  const call = fetch.calls[0];
  assert.ok(call.url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=FAKE_KEY'));
  assert.deepEqual(JSON.parse(call.init.body), { email: 't@example.com', password: 'fake-pass-xyz', returnSecureToken: true });
  const saved = storage.getItem('classpulse:auth:teacher');
  assert.ok(!saved.includes('fake-pass-xyz'));
  assert.ok(!saved.includes('tok1'));
  assert.deepEqual(JSON.parse(saved), { uid: 'T1', email: 't@example.com', refreshToken: 'r1' });
  assert.equal(await auth.getToken(), 'tok1');
});

for (const msg of ['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD']) {
  test(`まちがったパスワード: ${msg} は bad-credentials`, async () => {
    const { auth } = make(() => ({ status: 400, body: { error: { message: msg } } }));
    await assert.rejects(
      () => auth.signInTeacher('t@example.com', 'wrong'),
      (e) => e instanceof NetError && e.code === 'bad-credentials',
    );
  });
}

test('つながらない: fetch が失敗すると network', async () => {
  const { auth } = make(() => new Error('offline'));
  await assert.rejects(
    () => auth.signInTeacher('t@example.com', 'x'),
    (e) => e instanceof NetError && e.code === 'network',
  );
});

function studentHandler(state = { signUps: 0 }) {
  return (url) => {
    if (isSignUp(url)) {
      state.signUps += 1;
      return { status: 200, body: { localId: state.signUps === 1 ? 'S1' : 'S9', idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' } };
    }
    if (isToken(url)) {
      return { status: 200, body: { user_id: 'S1', id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' } };
    }
    return { status: 404, body: {} };
  };
}

test('生徒は読み直しても同じ ID: 保存した更新用トークンで戻り、signUp は呼ばれない', async () => {
  const storage = fakeStorage();
  const a = make(studentHandler(), 'student', storage);
  assert.deepEqual(await a.auth.signInAnonymous(), { uid: 'S1' });
  assert.ok(isSignUp(a.fetch.calls[0].url));

  const b = make(studentHandler(), 'student', storage);
  assert.deepEqual(await b.auth.signInAnonymous(), { uid: 'S1' });
  assert.equal(b.fetch.calls.filter((c) => isSignUp(c.url)).length, 0);
  assert.equal(b.fetch.calls.filter((c) => isToken(c.url)).length, 1);
  assert.equal(JSON.parse(storage.getItem('classpulse:auth:student')).refreshToken, 'r2');
});

test('保存したトークンが無効なら作り直す。restore は null を返し保存を消す', async () => {
  const bad = (url) => (isToken(url)
    ? { status: 400, body: { error: { message: 'TOKEN_EXPIRED' } } }
    : { status: 200, body: { localId: 'S2', idToken: 'tokN', refreshToken: 'rN', expiresIn: '3600' } });

  const storage = fakeStorage();
  storage.setItem('classpulse:auth:student', JSON.stringify({ uid: 'S1', refreshToken: 'old' }));
  const a = make(bad, 'student', storage);
  assert.deepEqual(await a.auth.signInAnonymous(), { uid: 'S2' });
  assert.equal(a.fetch.calls.filter((c) => isSignUp(c.url)).length, 1);

  const storage2 = fakeStorage();
  storage2.setItem('classpulse:auth:student', JSON.stringify({ uid: 'S1', refreshToken: 'old' }));
  const b = make(bad, 'student', storage2);
  assert.equal(await b.auth.restore(), null);
  assert.equal(storage2.getItem('classpulse:auth:student'), null);
  assert.equal(b.auth.user, null);
});

test('期限が近づくと更新する: 56 分後は更新、54 分後は更新しない', async () => {
  const a = make(teacherHandler);
  await a.auth.signInTeacher('t@example.com', 'x');
  a.clock.advance(56 * MIN);
  assert.equal(await a.auth.getToken(), 'tok2');
  assert.equal(a.fetch.calls.filter((c) => isToken(c.url)).length, 1);

  const b = make(teacherHandler);
  await b.auth.signInTeacher('t@example.com', 'x');
  b.clock.advance(54 * MIN);
  assert.equal(await b.auth.getToken(), 'tok1');
  assert.equal(b.fetch.calls.filter((c) => isToken(c.url)).length, 0);
});

test('getToken を同時に 3 回呼んでも更新は 1 回', async () => {
  const a = make(teacherHandler);
  await a.auth.signInTeacher('t@example.com', 'x');
  a.clock.advance(56 * MIN);
  const tokens = await Promise.all([a.auth.getToken(), a.auth.getToken(), a.auth.getToken()]);
  assert.deepEqual(tokens, ['tok2', 'tok2', 'tok2']);
  assert.equal(a.fetch.calls.filter((c) => isToken(c.url)).length, 1);
});

test('forceRefresh: 期限に関係なく更新する。本文は form-urlencoded', async () => {
  const a = make(teacherHandler);
  await a.auth.signInTeacher('t@example.com', 'x');
  assert.equal(await a.auth.forceRefresh(), 'tok2');
  const call = a.fetch.calls.find((c) => isToken(c.url));
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(call.init.body, 'grant_type=refresh_token&refresh_token=r1');
});

test('先生と生徒の保存は別のキー', async () => {
  const storage = fakeStorage();
  const t = make(teacherHandler, 'teacher', storage);
  await t.auth.signInTeacher('t@example.com', 'x');
  const s = make(studentHandler(), 'student', storage);
  await s.auth.signInAnonymous();
  assert.equal(JSON.parse(storage.getItem('classpulse:auth:teacher')).uid, 'T1');
  assert.equal(JSON.parse(storage.getItem('classpulse:auth:student')).uid, 'S1');
});

test('restore: 保存したトークンで戻る。何も無ければ null', async () => {
  const storage = fakeStorage();
  const t = make(teacherHandler, 'teacher', storage);
  await t.auth.signInTeacher('t@example.com', 'x');
  const t2 = make(teacherHandler, 'teacher', storage);
  assert.deepEqual(await t2.auth.restore(), { uid: 'T1', email: 't@example.com' });
  assert.equal(await t2.auth.getToken(), 'tok2');
  const empty = make(teacherHandler);
  assert.equal(await empty.auth.restore(), null);
});

test('ログアウトで保存が消える', async () => {
  const { auth, storage } = make(teacherHandler);
  await auth.signInTeacher('t@example.com', 'x');
  auth.signOut();
  assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  assert.equal(auth.user, null);
  await assert.rejects(() => auth.getToken(), (e) => e instanceof NetError && e.code === 'auth');
});
