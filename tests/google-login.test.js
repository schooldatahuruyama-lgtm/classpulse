import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CONFIG } from '../js/config.js';
import { NetError } from '../js/errors.js';
import { createDemoBackend } from '../js/dev/demo.js';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createAuth } from '../js/auth.js';
import { createRepo } from '../js/repo.js';
import { checkTeacherAccess, isStillUser } from '../js/guard.js';
import { parseRoute, routeHash, needsTeacher, viewFile } from '../js/router.js';
import { fakeStorage, fakeFetch } from './helpers/fakes.js';
import { createDriveExport } from '../js/drive-export.js';
import {
  randomToken, buildGoogleAuthUrl, redirectUriFrom, parseGoogleCallback, jwtPayload,
  checkGoogleCallback, handleGoogleCallback, createGoogleLogin,
} from '../js/google-login.js';

const KEY = 'classpulse:google-login';
const SAVED = { state: 'fake-state', nonce: 'fake-nonce', at: 1000 };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (value = { nonce: SAVED.nonce }) => `${encode({ alg: 'RS256' })}.${encode(value)}.fake-signature`;
const HASH = `#state=${SAVED.state}&id_token=${jwt()}`;
const MISMATCH = 'Google でのログインを確かめられませんでした。もう一度ためしてください。';

test('乱数は 16 バイト以上を使い、URL に使える文字だけで表す', () => {
  let count;
  const value = randomToken((bytes) => { count = bytes.length; bytes.forEach((_, i) => { bytes[i] = i * 17; }); });
  assert.ok(count >= 16);
  assert.equal(value, '00112233445566778899aabbccddeeff');
  assert.match(value, /^[A-Za-z0-9_-]+$/);
});

test('Google の URL は指定した項目だけを持ち、戻る場所に query・hash を入れない', () => {
  const redirectUri = redirectUriFrom({ origin: 'https://app.example.test', pathname: '/classpulse/', search: '?demo=1', hash: '#/signup' });
  assert.equal(redirectUri, 'https://app.example.test/classpulse/');
  const url = new URL(buildGoogleAuthUrl({ clientId: 'fake-client+&', redirectUri, state: 'state+&=', nonce: 'nonce+&=' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'fake-client+&', redirect_uri: redirectUri, response_type: 'id_token',
    scope: 'openid email', nonce: 'nonce+&=', state: 'state+&=', prompt: 'select_account',
  });
  assert.deepEqual(CONFIG.googleLogin, { maxAgeMs: 600000, storageKey: KEY });
});

test('Google の戻りは項目の順序にかかわらず読み、エラーを優先する', () => {
  for (const hash of [HASH, `#id_token=${jwt()}&state=${SAVED.state}`]) {
    assert.deepEqual(parseGoogleCallback(hash), { idToken: jwt(), state: SAVED.state });
  }
  assert.deepEqual(parseGoogleCallback('#error=access_denied&state=fake-state'), { error: 'access_denied', state: SAVED.state });
  assert.deepEqual(parseGoogleCallback(`${HASH}&error=invalid_request`), { error: 'invalid_request', state: SAVED.state });
  assert.equal(parseGoogleCallback(`${HASH}&state=other`).error, 'invalid_response');
});

const unrelated = ['', '#', '#/login', '#/edit/abc', '#/join/xyz', '#/join/xyz?id_token=fake', '#/join/xyz&error=denied', '#id_tokenx', '#id_tokenx=fake', '#id_token', '#errorx=fake', '#foo=id_token=fake'];
for (const hash of unrelated) {
  test(`関係のないハッシュを戻りと間違えない: ${hash || '空'}`, async () => {
    assert.equal(parseGoogleCallback(hash), null);
    const h = callbackHarness({ hash });
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: false });
    assert.deepEqual(h.events, []);
    assert.equal(h.location.hash, hash);
    assert.deepEqual(JSON.parse(h.storage.getItem(KEY)), SAVED);
  });
}

test('JWT の payload を base64url と UTF-8 で読める（署名はここでは確認しない）', () => {
  const payload = { nonce: '確認用😀', email: 'test@example.com' };
  assert.deepEqual(jwtPayload(jwt(payload)), payload);
});

const brokenTokens = [null, '', 'onepart', 'one.two', 'one.two.three.four', 'a.@@@.b', 'a.A.b',
  `a.${Buffer.from('not json').toString('base64url')}.b`, 'a._w.b', jwt(null), jwt([]), jwt('text')];
test('壊れた JWT は例外を出さず null にする', () => {
  for (const token of brokenTokens) assert.equal(jwtPayload(token), null);
});

test('確認: 有効期限のちょうど 10 分までは成功する', () => {
  for (const now of [SAVED.at, SAVED.at + CONFIG.googleLogin.maxAgeMs]) {
    assert.deepEqual(checkGoogleCallback({ saved: SAVED, parsed: parseGoogleCallback(HASH), now, maxAgeMs: CONFIG.googleLogin.maxAgeMs }), { ok: true, idToken: jwt() });
  }
});

test('確認: access_denied は保存なしでも cancelled、そのほかのエラーは mismatch', () => {
  for (const [error, reason] of [['access_denied', 'cancelled'], ['invalid_request', 'mismatch'], ['', 'mismatch']]) {
    assert.deepEqual(checkGoogleCallback({ saved: null, parsed: { error }, now: 1000, maxAgeMs: 600000 }), { ok: false, reason });
  }
});

// ハッシュを消す前に保存先・時計・認証へ触れた場合も、記録の順序で検出する。
function callbackHarness({ hash = HASH, saved = SAVED, now = 1001, clientId = 'fake-client', demo = false, failure } = {}) {
  const events = [];
  const storage = fakeStorage();
  if (saved !== null) storage.setItem(KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const location = { origin: 'https://app.example.test', pathname: '/classpulse/', search: '?unused=1', hash };
  const deps = {
    clientId, demo, location,
    replaceState: (state, title, url) => { events.push(['replace', state, title, url]); location.hash = url; },
    get sessionStorage() {
      events.push('storage');
      return {
        getItem: (key) => { events.push('get'); assert.equal(key, KEY); return storage.getItem(key); },
        removeItem: (key) => { events.push('remove'); storage.removeItem(key); },
      };
    },
    now: () => { events.push('now'); return now; },
    auth: { signInWithGoogleIdToken: async (token, uri) => {
      events.push(['auth', token, uri]);
      assert.equal(storage.getItem(KEY), null);
      assert.equal(location.hash, '#/login');
      if (failure) throw failure;
    } },
  };
  return { deps, storage, location, events };
}

test('戻りの成功: URL の置き換え、保存の取得・消去、時計、認証の順で処理する', async () => {
  const h = callbackHarness();
  assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true });
  assert.deepEqual(h.events, [
    ['replace', null, '', '#/login'], 'storage', 'get', 'remove', 'now',
    ['auth', jwt(), 'https://app.example.test/classpulse/'],
  ]);
  assert.equal(h.storage.getItem(KEY), null);
  assert.deepEqual(await handleGoogleCallback(h.deps), { handled: false });
  assert.equal(h.events.filter((e) => Array.isArray(e) && e[0] === 'auth').length, 1);
});

const invalidCallbacks = [
  ['保存なし', { saved: null }], ['保存が JSON でない', { saved: '{broken' }],
  ['state ちがい', { saved: { ...SAVED, state: 'other' } }], ['state なし', { hash: `#id_token=${jwt()}` }],
  ['nonce ちがい', { saved: { ...SAVED, nonce: 'other' } }], ['nonce なし', { hash: `#state=${SAVED.state}&id_token=${jwt({})}` }],
  ['期限切れ', { now: SAVED.at + 600001 }], ['未来の保存', { now: SAVED.at - 1 }],
  ['時刻が文字列', { saved: { ...SAVED, at: '1000' } }], ['nonce が空', { saved: { ...SAVED, nonce: '' } }],
  ['空の ID トークン', { hash: `#id_token=&state=${SAVED.state}` }],
  ['空のエラー', { hash: `${HASH}&error=` }], ['state の重複', { hash: `${HASH}&state=${SAVED.state}` }],
  ['Google のエラー', { hash: '#error=invalid_request&state=fake-state' }],
];
for (const [label, options] of invalidCallbacks) {
  test(`戻りの確認失敗（${label}）は URL と保存を消し、認証しない`, async () => {
    const h = callbackHarness(options);
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true, notice: MISMATCH });
    assert.deepEqual(h.events[0], ['replace', null, '', '#/login']);
    assert.ok(!h.events.some((e) => Array.isArray(e) && e[0] === 'auth'));
    assert.equal(h.location.hash, '#/login');
    assert.equal(h.storage.getItem(KEY), null);
  });
}

test('壊れた ID トークンの戻りはすべて確認失敗になり、認証しない', async () => {
  for (const token of [...brokenTokens, jwt({})]) {
    const h = callbackHarness({ hash: `#id_token=${encodeURIComponent(token ?? '')}&state=${SAVED.state}` });
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true, notice: MISMATCH });
    assert.ok(!h.events.some((e) => Array.isArray(e) && e[0] === 'auth'));
    assert.equal(h.location.hash, '#/login');
  }
});

test('Google でやめた場合も URL と保存を消して、お知らせを返す', async () => {
  const h = callbackHarness({ hash: '#error=access_denied&state=fake-state' });
  assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true, notice: 'Google でのログインをやめました。' });
  assert.equal(h.storage.getItem(KEY), null);
  assert.ok(!h.events.some((e) => Array.isArray(e) && e[0] === 'auth'));
});

for (const [label, options] of [['設定が空', { clientId: '' }], ['練習モード', { demo: {} }]]) {
  test(`${label}なら戻りもボタンの操作も無効で、ハッシュ・保存先へ触れない`, async () => {
    const h = callbackHarness(options);
    Object.defineProperty(h.deps, 'location', { get() { throw new Error('location を読まない'); } });
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: false });
    assert.equal(createGoogleLogin(h.deps), null);
    assert.deepEqual(h.events, []);
    assert.deepEqual(JSON.parse(h.storage.getItem(KEY)), SAVED);
  });
}

for (const operation of ['getItem', 'removeItem']) {
  test(`保存先の ${operation} が失敗しても、先に URL を消し、認証しない`, async () => {
    const h = callbackHarness();
    const storage = { getItem: () => JSON.stringify(SAVED), removeItem: () => {} };
    storage[operation] = () => { throw new Error(jwt()); };
    Object.defineProperty(h.deps, 'sessionStorage', { value: storage });
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true, notice: MISMATCH });
    assert.deepEqual(h.events, [['replace', null, '', '#/login']]);
    assert.equal(h.location.hash, '#/login');
  });
}

for (const [code, notice] of [
  ['account-exists', 'このメールアドレスは、パスワードでのログインに登録されています。メールアドレスとパスワードでログインしてください。'],
  ['network', '通信できませんでした。接続を確かめて、もう一度ためしてください。'],
  ['google-failed', 'Google でログインできませんでした。管理者の先生に知らせてください。'],
  ['unknown', 'Google でログインできませんでした。管理者の先生に知らせてください。'],
]) {
  test(`認証の失敗 ${code} は決まった文だけを返す`, async () => {
    const h = callbackHarness({ failure: new NetError(code, jwt()) });
    assert.deepEqual(await handleGoogleCallback(h.deps), { handled: true, notice });
    assert.equal(h.location.hash, '#/login');
    assert.equal(h.storage.getItem(KEY), null);
  });
}

test('開始: 別々の乱数と時刻だけを保存してから Google に移動する', () => {
  const storage = fakeStorage();
  let count = 0;
  let moved;
  const login = createGoogleLogin({
    clientId: 'fake-client', location: { origin: 'https://app.example.test', pathname: '/classpulse/', hash: '#/signup', search: '?unused=1' },
    getRandomValues: (bytes) => bytes.fill(++count), now: () => 1234, sessionStorage: storage,
    assign: (url) => { assert.ok(storage.getItem(KEY)); moved = new URL(url); },
  });
  login();
  const saved = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(saved, { state: '01'.repeat(16), nonce: '02'.repeat(16), at: 1234 });
  assert.equal(moved.searchParams.get('state'), saved.state);
  assert.equal(moved.searchParams.get('nonce'), saved.nonce);
  assert.equal(moved.searchParams.get('redirect_uri'), 'https://app.example.test/classpulse/');
  assert.equal(moved.searchParams.get('scope'), 'openid email');
  assert.equal(moved.searchParams.get('response_type'), 'id_token');
  assert.equal(moved.searchParams.get('prompt'), 'select_account');
  assert.equal(count, 2);
});

for (const operation of ['random', 'storage', 'assign']) {
  test(`開始時の ${operation} の失敗は生の例外を出さず、移動待ちの保存を消す`, () => {
    const storage = fakeStorage();
    const fail = () => { throw new Error('fake-sensitive-text'); };
    let assigned = false;
    const login = createGoogleLogin({
      clientId: 'fake-client', location: { origin: 'https://app.example.test', pathname: '/' }, now: () => 1000,
      getRandomValues: operation === 'random' ? fail : (bytes) => bytes.fill(1),
      sessionStorage: operation === 'storage' ? { ...storage, setItem: fail } : storage,
      assign: operation === 'assign' ? fail : () => { assigned = true; },
    });
    assert.throws(login, (e) => e.code === 'google-failed' && !e.message.includes('fake-sensitive-text'));
    assert.equal(assigned, false);
    assert.equal(storage.getItem(KEY), null);
  });
}

test('練習モードの先生・生徒の auth では Google ログインを使えない', async () => {
  const demo = createDemoBackend({ storage: fakeStorage(), sessionStorage: fakeStorage(), now: () => 1000 });
  for (const auth of [demo.teacherAuth, demo.studentAuth]) {
    await assert.rejects(auth.signInWithGoogleIdToken(jwt(), 'https://app.example.test/'), { code: 'google-failed', message: '練習モードでは使えません' });
    assert.equal(auth.user, null);
  }
});

// 既存の画面テストと同じく、DOM だけを代役にして画面のコードを実行する。
function viewHarness(name, googleLogin, notice) {
  const el = (tag, props = {}, ...children) => ({
    tag, ...props, textContent: props.text || '', value: '', disabled: false,
    children: children.flat(Infinity).filter(Boolean), handlers: {},
    replaceChildren(...items) { this.children = items; },
    addEventListener(event, handler) { this.handlers[event] = handler; }, focus() {},
  });
  const root = el('root');
  const sandbox = { el };
  const source = readFileSync(new URL(`../js/views/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace('export function mount', 'function mount');
  runInNewContext(source, sandbox);
  sandbox.mount(root, { googleLogin, notice });
  const all = (n) => [n, ...(n.children || []).flatMap(all)];
  return { nodes: () => all(root) };
}

for (const name of ['login', 'signup']) {
  test(`${name}: 操作が無ければ区切りも Google のボタンも出さない`, () => {
    for (const operation of [null, undefined]) {
      const h = viewHarness(name, operation);
      assert.ok(!h.nodes().some((n) => /Google|または/.test(n.textContent)));
    }
  });

  test(`${name}: 指定した位置と文のボタンは、押すと移動まで無効になり連打を防ぐ`, async () => {
    let calls = 0;
    let button;
    const h = viewHarness(name, () => { assert.equal(button.disabled, true); calls += 1; });
    const nodes = h.nodes();
    button = nodes.find((n) => n.tag === 'button' && n.textContent.startsWith('Google'));
    assert.equal(button.textContent, name === 'login' ? 'Google でログイン' : 'Google で登録・ログイン');
    assert.equal(button.type, 'button');
    const card = nodes.find((n) => n.class === 'card');
    assert.equal(card.children[0].tag, 'form');
    assert.equal(card.children[1].class, 'google-login');
    assert.equal(card.children[1].children[0].textContent, 'または');
    assert.equal(card.children[2].children[0].tag, 'a');
    if (name === 'signup') assert.ok(nodes.some((n) => n.textContent === 'Google アカウントを使うと、パスワードを決めなくても登録できます。'));
    await button.onclick();
    await button.onclick();
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    assert.ok(nodes.filter((n) => n.tag === 'input').every((n) => n.disabled));
  });

  test(`${name}: 移動に失敗したら安全な文を出し、ボタンを押し直せる`, async () => {
    const h = viewHarness(name, () => { throw new Error('fake-sensitive-text'); });
    const button = h.nodes().find((n) => n.tag === 'button' && n.textContent.startsWith('Google'));
    await button.onclick();
    assert.equal(button.disabled, false);
    const error = h.nodes().find((n) => n.class === 'error');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Google でログインできませんでした。管理者の先生に知らせてください。');
  });
}

test('ログイン画面は戻りの notice を表示する', () => {
  const h = viewHarness('login', null, MISMATCH);
  assert.ok(h.nodes().some((n) => n.class === 'notice' && n.role === 'alert' && n.textContent === MISMATCH));
});

// main.js から認証・入口の確認まで動かす。通信・DOM・画面の読みこみだけを代役にする。
async function mainHarness({ hash = HASH, clientId = 'fake-client', demo = false, approved, response, driveSaved, loginSaved = SAVED, signedIn = false } = {}) {
  const events = [];
  const storage = fakeStorage();
  const sessionStorage = fakeStorage();
  if (loginSaved) sessionStorage.setItem(KEY, JSON.stringify(loginSaved));
  if (driveSaved) sessionStorage.setItem(CONFIG.driveExport.storageKey, JSON.stringify(driveSaved));
  if (signedIn) storage.setItem('classpulse:auth:teacher', JSON.stringify({ uid: 'GOOGLE', email: 'teacher@example.test', refreshToken: 'fake-refresh' }));
  const fetch = fakeFetch((url) => {
    events.push('fetch');
    if (signedIn && url.includes('securetoken.googleapis.com')) return { status: 200, body: {
      user_id: 'GOOGLE', id_token: 'fake-firebase-token', refresh_token: 'fake-refresh', expires_in: '3600',
    } };
    assert.ok(url.includes('accounts:signInWithIdp'), 'ログイン直後は restore の通信をしない');
    return response || { status: 200, body: {
      localId: 'GOOGLE', email: 'google@example.com', idToken: 'fake-firebase-token', refreshToken: 'fake-refresh', expiresIn: '3600',
    } };
  });
  const teacherAuth = createAuth({ apiKey: 'FAKE_KEY', fetch, storage, now: () => 1001, role: 'teacher' });
  const studentAuth = {};
  const net = createMemoryNet({ initial: { teacherList: approved === undefined ? {} : { GOOGLE: approved } } });
  const el = (tag, props = {}, ...children) => ({
    tag, props, children: children.flat(Infinity).filter(Boolean),
    replaceChildren(...items) { this.children = items; }, querySelector() { return null; },
  });
  const app = el('root');
  const banner = el('root');
  const location = { origin: 'https://app.example.test', pathname: '/classpulse/', search: '', hostname: 'app.example.test', hash };
  const mounted = [];
  const sandbox = {
    document: { getElementById: (id) => id === 'app' ? app : banner }, location,
    history: {
      replaceState: (_, __, next) => { events.push('replace'); location.hash = next; },
      pushState: (_, __, next) => { location.hash = next; },
    },
    window: { localStorage: storage, sessionStorage, fetch, addEventListener: () => {} },
    FIREBASE: { apiKey: 'FAKE_KEY', databaseURL: 'https://db.example.test', googleClientId: clientId },
    Date: { now: () => 1001 }, console,
    isDemoAllowed: () => demo,
    createDemoBackend: () => ({ net, teacherAuth, studentAuth }),
    createAuth: ({ role }) => role === 'teacher' ? teacherAuth : studentAuth,
    createNet: () => net, createRepo, checkTeacherAccess, isStillUser,
    handleGoogleCallback, createGoogleLogin, parseGoogleCallback, createDriveExport,
    parseRoute: (value) => { events.push('route'); return parseRoute(value); }, routeHash, needsTeacher, viewFile,
    el, toast: () => {}, confirmDialog: async () => false,
    loadTestView: async (name) => ({ mount: (_, ctx) => { mounted.push({ name, ctx }); return () => {}; } }),
  };
  const source = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '')
    .replace('return await import(`./views/${viewFile(name)}.js`);', 'return await loadTestView(name);');
  runInNewContext(source, sandbox);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  return { events, storage, sessionStorage, fetch, location, mounted, teacherAuth };
}

for (const [approved, destination, status] of [[true, 'dashboard', undefined], [undefined, 'pending', 'pending'], [false, 'pending', 'suspended']]) {
  test(`起動: Google で入った先生の状態 ${approved} に合わせて ${destination} へ進む`, async () => {
    const h = await mainHarness({ approved });
    assert.equal(h.mounted.length, 1);
    assert.equal(h.mounted[0].name, destination);
    assert.equal(h.mounted[0].ctx.status, status);
    assert.equal(typeof h.mounted[0].ctx.googleLogin, 'function');
    assert.equal(h.fetch.calls.length, 1);
    assert.deepEqual(h.events.slice(0, 3), ['replace', 'fetch', 'route']);
    assert.equal(h.sessionStorage.getItem(KEY), null);
    assert.ok(!h.location.hash.includes(jwt()));
    assert.deepEqual(h.teacherAuth.user, { uid: 'GOOGLE', email: 'google@example.com' });
  });
}

test('起動: Google のキャンセルはログイン画面の ctx.notice に届く', async () => {
  const h = await mainHarness({ hash: '#error=access_denied&state=fake-state' });
  assert.equal(h.mounted[0].name, 'login');
  assert.equal(h.mounted[0].ctx.notice, 'Google でのログインをやめました。');
  assert.equal(h.fetch.calls.length, 0);
  assert.equal(h.location.hash, '#/login');
});

test('起動: needConfirmation はホームへ進まずログイン画面に案内を出す', async () => {
  const h = await mainHarness({ response: { status: 200, body: { needConfirmation: true } } });
  assert.equal(h.mounted[0].name, 'login');
  assert.equal(h.mounted[0].ctx.notice, 'このメールアドレスは、パスワードでのログインに登録されています。メールアドレスとパスワードでログインしてください。');
  assert.equal(h.teacherAuth.user, null);
  assert.equal(h.storage.getItem('classpulse:auth:teacher'), null);
});

for (const options of [{ clientId: '' }, { demo: true }]) {
  test(`起動: ${options.demo ? '練習モード' : '設定が空'}なら操作は null、戻りも処理しない`, async () => {
    const login = await mainHarness({ ...options, hash: '#/login' });
    assert.equal(login.mounted[0].ctx.googleLogin, null);
    const callback = await mainHarness(options);
    assert.equal(callback.location.hash, HASH);
    assert.equal(callback.fetch.calls.length, 0);
    assert.deepEqual(JSON.parse(callback.sessionStorage.getItem(KEY)), SAVED);
    assert.deepEqual(callback.events, ['route']);
  });
}

test('起動: Google が有効でも生徒の参加 URL はそのまま開き、認証しない', async () => {
  const h = await mainHarness({ hash: '#/join/xyz' });
  assert.equal(h.mounted[0].name, 'join');
  assert.equal(h.location.hash, '#/join/xyz');
  assert.equal(h.fetch.calls.length, 0);
  assert.deepEqual(JSON.parse(h.sessionStorage.getItem(KEY)), SAVED);
});

const DRIVE_SAVED = { state: 'drive-state', sid: 'lesson-1', at: 1000 };
const DRIVE_HASH = '#access_token=fake-drive-token&token_type=Bearer&expires_in=3600&state=drive-state';

test('起動: Drive の成功は Google ログインに渡さず、先生のログインを戻して該当の結果を開く', async () => {
  const h = await mainHarness({ hash: DRIVE_HASH, driveSaved: DRIVE_SAVED, signedIn: true, approved: true });
  assert.equal(h.location.hash, '#/history/lesson-1');
  assert.equal(h.mounted[0].name, 'result');
  assert.equal(h.mounted[0].ctx.driveExport.hasToken(), true);
  assert.equal(h.mounted[0].ctx.driveExport.takePending('other'), false);
  assert.equal(h.mounted[0].ctx.driveExport.takePending('lesson-1'), true);
  assert.equal(h.mounted[0].ctx.driveExport.takePending('lesson-1'), false);
  assert.deepEqual(JSON.parse(h.sessionStorage.getItem(KEY)), SAVED);
  assert.equal(h.sessionStorage.getItem(CONFIG.driveExport.storageKey), null);
  assert.equal(h.fetch.calls.length, 1);
  assert.ok(h.fetch.calls[0].url.includes('securetoken.googleapis.com'));
});

test('起動: Drive の保存があっても ID トークンは Google ログインが処理する', async () => {
  const h = await mainHarness({ driveSaved: DRIVE_SAVED, approved: true });
  assert.equal(h.mounted[0].name, 'dashboard');
  assert.equal(h.mounted[0].ctx.driveExport.hasToken(), false);
  assert.deepEqual(JSON.parse(h.sessionStorage.getItem(CONFIG.driveExport.storageKey)), DRIVE_SAVED);
  assert.equal(h.sessionStorage.getItem(KEY), null);
});

test('起動: Drive の取り消しの知らせは、結果・履歴の画面に 1 回だけ渡す', async () => {
  const h = await mainHarness({ hash: '#error=access_denied&state=drive-state', driveSaved: DRIVE_SAVED, signedIn: true, approved: true });
  const ctx = h.mounted[0].ctx;
  assert.equal(h.mounted[0].name, 'result');
  assert.equal(ctx.driveNotice, 'Google ドライブへの保存をやめました。');
  assert.equal(ctx.notice, undefined);
  assert.equal(ctx.driveExport.hasToken(), false);
  await ctx.navigate('history');
  assert.equal(h.mounted.at(-1).ctx.driveNotice, undefined);
});

test('起動: 保存がない Drive の戻りは履歴の画面で知らせ、ログインの失敗と混同しない', async () => {
  const h = await mainHarness({ hash: DRIVE_HASH, signedIn: true, approved: true });
  assert.equal(h.mounted[0].name, 'history');
  assert.equal(h.mounted[0].ctx.driveNotice, 'Google ドライブへの保存を確かめられませんでした。もう一度ためしてください。');
  assert.equal(h.mounted[0].ctx.driveExport.hasToken(), false);
  assert.ok(h.sessionStorage.getItem(KEY));
});

test('起動: error がログインの state と合う・どちらにも合わないときは従来のログインの失敗にする', async () => {
  for (const [state, loginSaved] of [[SAVED.state, SAVED], ['unknown', SAVED], ['unknown', null]]) {
    const h = await mainHarness({ hash: `#error=invalid_request&state=${state}`, driveSaved: DRIVE_SAVED, loginSaved });
    assert.equal(h.mounted[0].name, 'login');
    assert.equal(h.mounted[0].ctx.notice, MISMATCH);
    assert.equal(h.mounted[0].ctx.driveNotice, undefined);
    assert.deepEqual(JSON.parse(h.sessionStorage.getItem(CONFIG.driveExport.storageKey)), DRIVE_SAVED);
    assert.equal(h.location.hash, '#/login');
  }
});

test('起動: 設定なし・練習モードは Drive のトークンの戻りも処理しない', async () => {
  for (const options of [{ clientId: '' }, { demo: true }]) {
    const h = await mainHarness({ ...options, hash: DRIVE_HASH, driveSaved: DRIVE_SAVED });
    assert.equal(h.location.hash, DRIVE_HASH);
    assert.equal(h.fetch.calls.length, 0);
    assert.deepEqual(JSON.parse(h.sessionStorage.getItem(CONFIG.driveExport.storageKey)), DRIVE_SAVED);
    const screen = await mainHarness({ ...options, hash: '#/login' });
    assert.equal(screen.mounted[0].ctx.driveExport, null);
  }
});
