import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../js/auth.js';
import { NetError } from '../js/errors.js';
import { fakeStorage, fakeFetch, fakeClock } from './helpers/fakes.js';

const MIN = 60 * 1000;

const GOOGLE_TOKEN = 'fake-google-id-token+with&reserved=characters';
const GOOGLE_URI = 'https://app.example.test/classpulse/';
const googleBody = () => ({
  localId: 'GOOGLE', email: 'google@example.com', idToken: 'fake-firebase-id-token',
  refreshToken: 'fake-google-refresh', expiresIn: '3600', oauthIdToken: GOOGLE_TOKEN,
});

test('Google: signInWithIdp に URL エンコードした本文を送り、ID トークンを保存しない', async () => {
  const { auth, fetch, storage } = make(() => ({ status: 200, body: googleBody() }));
  const user = await auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI);
  assert.deepEqual(user, { uid: 'GOOGLE', email: 'google@example.com' });
  assert.deepEqual(auth.user, user);
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=FAKE_KEY');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const payload = JSON.parse(call.init.body);
  assert.deepEqual(payload, {
    postBody: 'id_token=fake-google-id-token%2Bwith%26reserved%3Dcharacters&providerId=google.com',
    requestUri: GOOGLE_URI, returnSecureToken: true, returnIdpCredential: true,
  });
  assert.equal(new URLSearchParams(payload.postBody).get('id_token'), GOOGLE_TOKEN);
  const saved = storage.getItem('classpulse:auth:teacher');
  assert.deepEqual(JSON.parse(saved), { uid: 'GOOGLE', email: 'google@example.com', refreshToken: 'fake-google-refresh' });
  assert.ok(!saved.includes(GOOGLE_TOKEN));
  assert.ok(!saved.includes('fake-firebase-id-token'));
  assert.equal(await auth.getToken(), 'fake-firebase-id-token');
});

for (const body of [{ needConfirmation: true }, { ...googleBody(), needConfirmation: true }]) {
  test(`Google: needConfirmation は保存も採用もしない（資格情報${body.idToken ? 'あり' : 'なし'}）`, async () => {
    const { auth, storage } = make(() => ({ status: 200, body }));
    await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), { code: 'account-exists' });
    assert.equal(auth.user, null);
    assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  });
}

for (const [message, code] of [
  ['EMAIL_EXISTS', 'account-exists'], ['FEDERATED_USER_ID_ALREADY_LINKED', 'account-exists'],
  ['OPERATION_NOT_ALLOWED', 'google-failed'], ['INVALID_IDP_RESPONSE', 'google-failed'],
  ['INVALID_ID_TOKEN', 'google-failed'], [GOOGLE_TOKEN, 'google-failed'],
]) {
  test(`Google: Firebase の失敗を ${code} に直す（${message === GOOGLE_TOKEN ? '生の入力' : message}）`, async () => {
    const { auth, storage } = make(() => ({ status: 400, body: { error: { message }, oauthIdToken: GOOGLE_TOKEN } }));
    await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), (e) => {
      assert.ok(e instanceof NetError);
      assert.equal(e.code, code);
      assert.ok(!(e.message + e.stack + JSON.stringify(e)).includes(GOOGLE_TOKEN));
      assert.equal(e.firebaseMessage, undefined);
      return true;
    });
    assert.equal(auth.user, null);
    assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  });
}

for (const errorMessage of ['EMAIL_EXISTS', 'FEDERATED_USER_ID_ALREADY_LINKED', GOOGLE_TOKEN]) {
  test(`Google: 200 応答の errorMessage も拒否する（${errorMessage === GOOGLE_TOKEN ? '生の入力' : errorMessage}）`, async () => {
    const { auth, storage } = make(() => ({ status: 200, body: { ...googleBody(), errorMessage } }));
    await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), (e) => {
      assert.equal(e.code, errorMessage === GOOGLE_TOKEN ? 'google-failed' : 'account-exists');
      assert.ok(!(e.message + JSON.stringify(e)).includes(GOOGLE_TOKEN));
      return true;
    });
    assert.equal(auth.user, null);
    assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  });
}

test('Google: needConfirmation でも既存のログイン状態と保存を上書きしない', async () => {
  const { auth, storage } = make((url) => isSignIn(url) ? teacherHandler(url) : { status: 200, body: { ...googleBody(), needConfirmation: true } });
  await auth.signInTeacher('t@example.com', 'fake-pass');
  const saved = storage.getItem('classpulse:auth:teacher');
  await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), { code: 'account-exists' });
  assert.deepEqual(auth.user, { uid: 'T1', email: 't@example.com' });
  assert.equal(storage.getItem('classpulse:auth:teacher'), saved);
  assert.equal(await auth.getToken(), 'tok1');
});

test('Google: 通信と応答の読み取りの失敗は network、生の例外を外へ出さない', async () => {
  const offline = make(() => new Error(GOOGLE_TOKEN));
  const unreadable = createAuth({ apiKey: 'FAKE_KEY', role: 'teacher', storage: fakeStorage(), now: () => 1000,
    fetch: async () => ({ ok: true, json: async () => { throw new Error(GOOGLE_TOKEN); } }),
  });
  for (const auth of [offline.auth, unreadable]) {
    await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), (e) => {
      assert.equal(e.code, 'network');
      assert.ok(!(e.message + e.stack + JSON.stringify(e)).includes(GOOGLE_TOKEN));
      return true;
    });
    assert.equal(auth.user, null);
  }
});

for (const body of [null, {}, { ...googleBody(), refreshToken: null }, { ...googleBody(), expiresIn: 'bad' }]) {
  test('Google: 必須項目が壊れた成功応答は google-failed で採用しない', async () => {
    const { auth, storage } = make(() => ({ status: 200, body }));
    await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), { code: 'google-failed' });
    assert.equal(auth.user, null);
    assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  });
}

test('Google: 生徒の auth は通信も保存もしない', async () => {
  const { auth, fetch, storage } = make(() => ({ status: 200, body: googleBody() }), 'student');
  await assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), { code: 'google-failed' });
  assert.equal(fetch.calls.length, 0);
  assert.equal(auth.user, null);
  assert.equal(storage.getItem('classpulse:auth:student'), null);
});

for (const otherLogin of [false, true]) {
  test(`Google: 待っている間の${otherLogin ? '別の人のログイン' : 'ログアウト'}を古い応答で上書きしない`, async () => {
    const fetch = deferredFetch();
    const storage = fakeStorage();
    const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: () => 1000, role: 'teacher' });
    const rejected = assert.rejects(auth.signInWithGoogleIdToken(GOOGLE_TOKEN, GOOGLE_URI), { code: 'auth' });
    if (otherLogin) {
      const login = auth.signInTeacher('other@example.com', 'fake-pass');
      fetch.respond(1, 200, { localId: 'OTHER', idToken: 'other-token', refreshToken: 'other-refresh', expiresIn: '3600' });
      await login;
    } else auth.signOut();
    fetch.respond(0, 200, googleBody());
    await rejected;
    assert.deepEqual(auth.user, otherLogin ? { uid: 'OTHER', email: 'other@example.com' } : null);
    assert.deepEqual(JSON.parse(storage.getItem('classpulse:auth:teacher')), otherLogin
      ? { uid: 'OTHER', email: 'other@example.com', refreshToken: 'other-refresh' } : null);
  });
}

test('先生の登録: signUp に本文を送り、ログイン状態と更新用トークンだけを保存する', async () => {
  const { auth, fetch, storage } = make(() => ({ status: 200, body: {
    localId: 'NEW', email: 'new@example.com', idToken: 'new-token', refreshToken: 'new-refresh', expiresIn: '3600',
  } }));
  const user = await auth.signUpTeacher('new@example.com', 'fake-signup-pass');
  assert.deepEqual(user, { uid: 'NEW', email: 'new@example.com' });
  assert.deepEqual(auth.user, user);
  assert.ok(isSignUp(fetch.calls[0].url));
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { email: 'new@example.com', password: 'fake-signup-pass', returnSecureToken: true });
  const saved = storage.getItem('classpulse:auth:teacher');
  assert.doesNotMatch(saved, /password|fake-signup-pass|new-token/);
  assert.deepEqual(JSON.parse(saved), { uid: 'NEW', email: 'new@example.com', refreshToken: 'new-refresh' });
  assert.equal(await auth.getToken(), 'new-token');
});

for (const [message, code] of [
  ['EMAIL_EXISTS', 'email-exists'], ['INVALID_EMAIL', 'invalid-email'], ['MISSING_EMAIL', 'invalid-email'],
  ['WEAK_PASSWORD', 'weak-password'], ['WEAK_PASSWORD : Password should be stronger', 'weak-password'],
  ['OPERATION_NOT_ALLOWED', 'signup-disabled'], ['ADMIN_ONLY_OPERATION', 'signup-disabled'], ['OTHER', 'unknown'],
]) {
  test(`先生の登録: ${message} は ${code}`, async () => {
    const { auth, storage } = make(() => ({ status: 400, body: { error: { message } } }));
    await assert.rejects(auth.signUpTeacher('new@example.com', 'fake-signup-pass'), (e) => e instanceof NetError && e.code === code);
    assert.equal(auth.user, null);
    assert.equal(storage.getItem('classpulse:auth:teacher'), null);
  });
}

test('先生の登録: 通信できないと network。サーバーの生のエラー文は残さない', async () => {
  const offline = make(() => new Error('offline'));
  await assert.rejects(offline.auth.signUpTeacher('new@example.com', 'fake-signup-pass'), { code: 'network' });
  const failed = make(() => ({ status: 400, body: { error: { message: 'fake-signup-pass' } } }));
  await assert.rejects(failed.auth.signUpTeacher('new@example.com', 'fake-signup-pass'), (e) => {
    assert.equal(e.code, 'unknown');
    assert.doesNotMatch(e.message + JSON.stringify(e), /fake-signup-pass/);
    return true;
  });
});

test('生徒の auth では先生を登録できず、通信も保存もしない', async () => {
  const { auth, fetch, storage } = make(() => ({ status: 200, body: {} }), 'student');
  await assert.rejects(auth.signUpTeacher('new@example.com', 'fake-signup-pass'), { code: 'unknown' });
  assert.equal(fetch.calls.length, 0);
  assert.equal(auth.user, null);
  assert.equal(storage.getItem('classpulse:auth:student'), null);
});

test('登録中にログアウトしたら、古い応答でログインしない', async () => {
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage: fakeStorage(), now: () => 1000, role: 'teacher' });
  const rejected = assert.rejects(auth.signUpTeacher('new@example.com', 'fake-signup-pass'), { code: 'auth' });
  auth.signOut();
  fetch.respond(0, 200, { localId: 'NEW', idToken: 'tok', refreshToken: 'ref', expiresIn: '3600' });
  await rejected;
  assert.equal(auth.user, null);
});

test('登録中に別の人がログインしたら、古い登録の応答で上書きしない', async () => {
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage: fakeStorage(), now: () => 1000, role: 'teacher' });
  const rejected = assert.rejects(auth.signUpTeacher('new@example.com', 'fake-signup-pass'), { code: 'auth' });
  const login = auth.signInTeacher('b@example.com', 'fake-login-pass');
  fetch.respond(1, 200, { localId: 'B', idToken: 'tokB', refreshToken: 'refB', expiresIn: '3600' });
  await login;
  fetch.respond(0, 200, { localId: 'NEW', idToken: 'tok', refreshToken: 'ref', expiresIn: '3600' });
  await rejected;
  assert.deepEqual(auth.user, { uid: 'B', email: 'b@example.com' });
});
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

// ---- 修正ラウンド 1: 一時的な失敗・古い応答・壊れた本文 ----

// 応答を手で返せる fetch（このファイル内だけで使う）
function deferredFetch(handler) {
  const pending = [];
  const calls = [];
  const fn = (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject }));
  };
  fn.calls = calls;
  fn.pending = pending;
  fn.respond = (i, status, body) => pending[i].resolve({ ok: status < 300, status, json: async () => body });
  return fn;
}

const SAVED = JSON.stringify({ uid: 'S1', refreshToken: 'old' });
const tick = () => new Promise((r) => setImmediate(r));

for (const status of [503, 429]) {
  test(`一時的な HTTP エラー ${status}: 保存を残し、signUp せず、拒否する`, async () => {
    const storage = fakeStorage();
    storage.setItem('classpulse:auth:student', SAVED);
    const { auth, fetch } = make((url) => (isToken(url) ? { status, body: { error: { message: 'BUSY' } } } : { status: 200, body: {} }), 'student', storage);
    await assert.rejects(() => auth.signInAnonymous(), (e) => e instanceof NetError && e.code === 'unknown');
    assert.equal(storage.getItem('classpulse:auth:student'), SAVED);
    assert.equal(fetch.calls.filter((c) => isSignUp(c.url)).length, 0);
  });
}

test('更新中にログアウトすると、後から届いた応答で復活しない', async () => {
  const storage = fakeStorage();
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: fakeClock(1000).now, role: 'teacher' });
  const p = auth.signInTeacher('t@example.com', 'x');
  fetch.respond(0, 200, { localId: 'T1', email: 't@example.com', idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' });
  await p;
  const r = auth.forceRefresh();
  const rejected = assert.rejects(r, (e) => e instanceof NetError);
  await tick();
  auth.signOut();
  fetch.respond(1, 200, { user_id: 'T1', id_token: 'tok2', refresh_token: 'r2', expires_in: '3600' });
  await rejected;
  assert.equal(auth.user, null);
  assert.equal(storage.getItem('classpulse:auth:teacher'), null);
});

test('更新中に別のアカウントでログインしても、古い応答で上書きされない', async () => {
  const storage = fakeStorage();
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: fakeClock(1000).now, role: 'teacher' });
  const a = auth.signInTeacher('a@example.com', 'x');
  fetch.respond(0, 200, { localId: 'A', email: 'a@example.com', idToken: 'tokA', refreshToken: 'rA', expiresIn: '3600' });
  await a;
  const r = auth.forceRefresh();
  const rejected = assert.rejects(r, (e) => e instanceof NetError);
  await tick();
  const b = auth.signInTeacher('b@example.com', 'x');
  fetch.respond(2, 200, { localId: 'B', email: 'b@example.com', idToken: 'tokB', refreshToken: 'rB', expiresIn: '3600' });
  await b;
  fetch.respond(1, 200, { user_id: 'A', id_token: 'tokA2', refresh_token: 'rA2', expires_in: '3600' });
  await rejected;
  assert.deepEqual(auth.user, { uid: 'B', email: 'b@example.com' });
  assert.deepEqual(JSON.parse(storage.getItem('classpulse:auth:teacher')), { uid: 'B', email: 'b@example.com', refreshToken: 'rB' });
  assert.equal(await auth.getToken(), 'tokB');
});

test('本文を読めない応答: network で拒否し、保存を残し、signUp しない', async () => {
  const storage = fakeStorage();
  storage.setItem('classpulse:auth:student', SAVED);
  const fetch = fakeFetch((url) => (isToken(url) ? { status: 200, body: null } : { status: 200, body: {} }));
  const broken = async (url, init) => {
    const res = await fetch(url, init);
    return { ...res, json: async () => { throw new Error('切断'); } };
  };
  broken.calls = fetch.calls;
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch: broken, storage, now: fakeClock(1000).now, role: 'student' });
  await assert.rejects(() => auth.signInAnonymous(), (e) => e instanceof NetError && e.code === 'network');
  assert.equal(storage.getItem('classpulse:auth:student'), SAVED);
  assert.equal(fetch.calls.filter((c) => isSignUp(c.url)).length, 0);
});

test('必須項目が足りない 200 応答: unknown で拒否し、保存を残し、signUp しない', async () => {
  const storage = fakeStorage();
  storage.setItem('classpulse:auth:student', SAVED);
  const { auth, fetch } = make((url) => (isToken(url) ? { status: 200, body: { user_id: 'S1', id_token: 'tok2' } } : { status: 200, body: {} }), 'student', storage);
  await assert.rejects(() => auth.signInAnonymous(), (e) => e instanceof NetError && e.code === 'unknown');
  assert.equal(storage.getItem('classpulse:auth:student'), SAVED);
  assert.equal(fetch.calls.filter((c) => isSignUp(c.url)).length, 0);
});

// ---- 修正ラウンド 2: 開始直後のログアウト、古い更新の共有 ----

test('signInAnonymous の直後に signOut しても、後から届く signUp の応答で復活しない', async () => {
  const storage = fakeStorage();
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: fakeClock(1000).now, role: 'student' });
  const p = auth.signInAnonymous();
  const rejected = assert.rejects(p, (e) => e instanceof NetError && e.code === 'auth');
  auth.signOut();
  await tick();
  fetch.respond(0, 200, { localId: 'S1', idToken: 'tok1', refreshToken: 'r1', expiresIn: '3600' });
  await rejected;
  assert.equal(auth.user, null);
  assert.equal(storage.getItem('classpulse:auth:student'), null);
});

test('A の更新が保留中でも、B でログインすれば forceRefresh は B の新しい更新を送る', async () => {
  const storage = fakeStorage();
  const fetch = deferredFetch();
  const auth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: fakeClock(1000).now, role: 'teacher' });
  const a = auth.signInTeacher('a@example.com', 'x');
  fetch.respond(0, 200, { localId: 'A', email: 'a@example.com', idToken: 'tokA', refreshToken: 'rA', expiresIn: '3600' });
  await a;
  const aRefresh = auth.forceRefresh(); // pending[1]
  const aRejected = assert.rejects(aRefresh, (e) => e instanceof NetError);
  await tick();
  const b = auth.signInTeacher('b@example.com', 'x'); // pending[2]
  fetch.respond(2, 200, { localId: 'B', email: 'b@example.com', idToken: 'tokB', refreshToken: 'rB', expiresIn: '3600' });
  await b;
  const bRefresh = auth.forceRefresh(); // pending[3]（A の保留を使い回さない）
  await tick();
  assert.equal(fetch.pending.length, 4);
  assert.equal(fetch.calls[3].init.body, 'grant_type=refresh_token&refresh_token=rB');
  fetch.respond(3, 200, { user_id: 'B', id_token: 'tokB2', refresh_token: 'rB2', expires_in: '3600' });
  assert.equal(await bRefresh, 'tokB2');
  // 古い A の応答が後から届いても何も変わらない
  fetch.respond(1, 200, { user_id: 'A', id_token: 'tokA2', refresh_token: 'rA2', expires_in: '3600' });
  await aRejected;
  assert.deepEqual(auth.user, { uid: 'B', email: 'b@example.com' });
  assert.deepEqual(JSON.parse(storage.getItem('classpulse:auth:teacher')), { uid: 'B', email: 'b@example.com', refreshToken: 'rB2' });
});
