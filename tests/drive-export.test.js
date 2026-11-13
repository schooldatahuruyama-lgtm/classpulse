import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CONFIG } from '../js/config.js';
import { NetError } from '../js/errors.js';
import { buildDriveAuthUrl, parseDriveCallback, createDriveExport } from '../js/drive-export.js';
import { handleGoogleCallback } from '../js/google-login.js';
import { historyToCsv, exportFileName } from '../js/results-csv.js';
import { routeHash } from '../js/router.js';
import { formatDateTime } from '../js/format.js';
import { fakeStorage, fakeFetch, fakeClock } from './helpers/fakes.js';

const KEY = CONFIG.driveExport.storageKey;
const LOGIN_KEY = CONFIG.googleLogin.storageKey;
const SAVED = { state: 'fake-drive-state', sid: 'lesson-1', at: 1000 };
const HASH = '#access_token=fake-drive-token&token_type=Bearer&expires_in=3600&state=fake-drive-state';
const MISMATCH = 'Google ドライブへの保存を確かめられませんでした。もう一度ためしてください。';
const LINK = 'https://docs.google.com/spreadsheets/d/fake-sheet/edit';

function harness({ hash = HASH, saved = SAVED, login = null, at = 1001, clientId = 'fake-client', demo = false, response = { status: 200, body: { id: 'fake-sheet', webViewLink: LINK } } } = {}) {
  const events = [];
  const storage = fakeStorage();
  if (saved !== null) storage.setItem(KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
  if (login !== null) storage.setItem(LOGIN_KEY, JSON.stringify(login));
  const clock = fakeClock(at);
  const location = { origin: 'https://app.example.test', pathname: '/classpulse/', search: '?unused=1', hash };
  const fetch = fakeFetch(() => response);
  const deps = {
    clientId, demo, location, fetch,
    replaceState: (_, __, hash) => { events.push(['replace', hash]); location.hash = hash; },
    get sessionStorage() {
      events.push('storage');
      return {
        getItem: (key) => { events.push(['get', key]); return storage.getItem(key); },
        removeItem: (key) => { events.push(['remove', key]); storage.removeItem(key); },
        setItem: (key, value) => { events.push(['set', key, value]); storage.setItem(key, value); },
      };
    },
    now: () => { events.push('now'); return clock.now(); },
    getRandomValues: (bytes) => { events.push('random'); bytes.fill(7); },
    assign: (url) => events.push(['assign', url]),
    getLoginHint: () => 'teacher@example.test',
  };
  const drive = createDriveExport(deps);
  return { drive, deps, events, storage, clock, location, fetch };
}

test('Drive: 設定と認可 URL は drive.file だけを要求する', () => {
  assert.deepEqual(CONFIG.driveExport, { maxAgeMs: 600000, storageKey: 'classpulse:drive-export', scope: 'https://www.googleapis.com/auth/drive.file', tokenMarginMs: 60000 });
  const args = { clientId: 'fake+client', redirectUri: 'https://app.example.test/app/', state: 'state+&=', loginHint: 'teacher@example.test' };
  const url = new URL(buildDriveAuthUrl(args));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: args.clientId, redirect_uri: args.redirectUri, response_type: 'token', scope: CONFIG.driveExport.scope,
    state: args.state, include_granted_scopes: 'true', login_hint: args.loginHint,
  });
  assert.ok(!new URL(buildDriveAuthUrl({ ...args, loginHint: '' })).searchParams.has('login_hint'));
});

test('Drive: 戻りを順序によらず読み、ログインの ID トークンと画面 URL は読まない', () => {
  const expected = { accessToken: 'fake-drive-token', expiresIn: 3600, state: SAVED.state };
  assert.deepEqual(parseDriveCallback(HASH), expected);
  assert.deepEqual(parseDriveCallback('#state=fake-drive-state&expires_in=3600&token_type=bearer&access_token=fake-drive-token'), expected);
  assert.deepEqual(parseDriveCallback('#error=access_denied&state=fake-drive-state'), { error: 'access_denied', state: SAVED.state });
  for (const hash of ['', '#', '#/history', '#/join/x?access_token=fake', '#id_token=fake&state=login', '#id_token=fake&error=access_denied', '#access_tokenx=fake', '#foo=access_token=fake']) {
    assert.equal(parseDriveCallback(hash), null, hash);
  }
});

test('Drive: 重複・空トークン・不正な有効期間・別形式のトークンは拒否する', () => {
  for (const hash of [HASH + '&state=other', HASH + '&access_token=second', HASH + '&id_token=fake', HASH + '&expires_in=100',
    HASH.replace('fake-drive-token', ''), HASH.replace('fake-drive-token', 'fake%0d%0atoken'),
    HASH.replace('Bearer', 'Other'), HASH.replace('&token_type=Bearer', ''),
    ...['', '0', '-1', 'NaN', 'Infinity'].map((n) => HASH.replace('3600', n))]) {
    assert.equal(parseDriveCallback(hash).error, 'invalid_response', hash);
  }
  assert.deepEqual(parseDriveCallback(HASH + '&error='), { error: '', state: SAVED.state });
});

test('Drive: URL 消去 → 保存の取得と消去 → 結果へ移動 → 時計の順で成功する', () => {
  const h = harness();
  assert.deepEqual(h.drive.handleCallback(), { handled: true });
  assert.deepEqual(h.events, [
    ['replace', '#/history'], 'storage', ['get', KEY], ['remove', KEY], ['replace', '#/history/lesson-1'], 'now',
  ]);
  assert.equal(h.storage.getItem(KEY), null);
  assert.equal(h.drive.hasToken(), true);
  assert.equal(h.drive.takePending('other-lesson'), false);
  assert.equal(h.drive.takePending('lesson-1'), true);
  assert.equal(h.drive.takePending('lesson-1'), false);
  assert.deepEqual(h.drive.handleCallback(), { handled: false });
  const reloaded = createDriveExport(h.deps);
  assert.deepEqual(reloaded.handleCallback(), { handled: false });
  assert.equal(reloaded.hasToken(), false);
  assert.equal(reloaded.takePending('lesson-1'), false);
});

for (const [label, options] of [
  ['保存なし', { saved: null }], ['壊れた JSON', { saved: '{bad' }], ['違う state', { saved: { ...SAVED, state: 'other' } }],
  ['state が空', { saved: { ...SAVED, state: '' } }], ['state がない戻り', { hash: HASH.replace('&state=fake-drive-state', '') }],
  ['10 分超過', { at: 601001 }], ['未来の保存', { at: 999 }], ['文字列の時刻', { saved: { ...SAVED, at: '1000' } }],
  ['sid がない', { saved: { state: SAVED.state, at: 1000 } }], ['不正な sid', { saved: { ...SAVED, sid: '../login' } }],
  ['有効期間が短い', { hash: HASH.replace('3600', '59') }], ['有効期間があふれる', { hash: HASH.replace('3600', '1e308') }],
  ['重複する state', { hash: HASH + '&state=other' }], ['Google のエラー', { hash: HASH + '&error=invalid_request' }],
]) {
  test(`Drive: ${label}ならトークンも自動保存の印も持たず、通信しない`, async () => {
    const h = harness(options);
    assert.deepEqual(h.drive.handleCallback(), { handled: true, notice: MISMATCH });
    assert.deepEqual(h.events[0], ['replace', '#/history']);
    assert.ok(!h.location.hash.includes('access_token'));
    assert.equal(h.storage.getItem(KEY), null);
    assert.equal(h.drive.hasToken(), false);
    assert.equal(h.drive.takePending('lesson-1'), false);
    await assert.rejects(h.drive.upload({ name: 'test', csv: 'csv' }), { code: 'drive-auth' });
    assert.equal(h.fetch.calls.length, 0);
  });
}

test('Drive: ちょうど 10 分まで戻れ、トークンは残り 1 分の境界まで使える', () => {
  const h = harness({ at: 601000 });
  assert.deepEqual(h.drive.handleCallback(), { handled: true });
  h.clock.advance(3540000);
  assert.equal(h.drive.hasToken(), true);
  h.clock.advance(1);
  assert.equal(h.drive.hasToken(), false);
  assert.equal(h.drive.takePending('lesson-1'), false);
});

for (const operation of ['getter', 'getItem', 'removeItem', 'now']) {
  test(`Drive: ${operation} が例外でも URL が先に消え、生の例外やトークンを返さない`, async () => {
    const h = harness();
    const fail = () => { throw new Error('fake-drive-token'); };
    const storage = { getItem: () => JSON.stringify(SAVED), removeItem: () => {} };
    if (operation === 'getter') Object.defineProperty(h.deps, 'sessionStorage', { get: fail });
    else if (operation === 'now') h.deps.now = fail;
    else { storage[operation] = fail; Object.defineProperty(h.deps, 'sessionStorage', { value: storage }); }
    assert.deepEqual(h.drive.handleCallback(), { handled: true, notice: MISMATCH });
    assert.deepEqual(h.events[0], ['replace', '#/history']);
    assert.ok(!h.location.hash.includes('fake-drive-token'));
    assert.equal(h.drive.hasToken(), false);
    await assert.rejects(h.drive.upload({ name: 'test', csv: 'csv' }), { code: 'drive-auth' });
    assert.equal(h.fetch.calls.length, 0);
  });
}

test('Drive: URL を置き換えられなければ保存も時計も通信も使わない', () => {
  const h = harness();
  h.deps.replaceState = () => { throw new Error('fake-drive-token'); };
  assert.deepEqual(h.drive.handleCallback(), { handled: true, notice: MISMATCH });
  assert.deepEqual(h.events, []);
  assert.equal(h.drive.hasToken(), false);
});

test('Drive: error の state が Drive の保存と合うときだけ、Drive の取り消しにする', () => {
  const h = harness({ hash: '#error=access_denied&state=fake-drive-state', login: { state: 'login-state' } });
  assert.deepEqual(h.drive.handleCallback(), { handled: true, notice: 'Google ドライブへの保存をやめました。' });
  assert.deepEqual(h.events[0], ['replace', '#/login']);
  assert.equal(h.location.hash, '#/history/lesson-1');
  assert.equal(h.storage.getItem(KEY), null);
  assert.ok(h.storage.getItem(LOGIN_KEY));
  assert.equal(h.drive.hasToken(), false);
});

test('Drive: error の state がログインだけ・どちらでもない・どちらにも合うときはログインへ渡す', async () => {
  for (const [state, login, saved] of [
    ['login-state', { state: 'login-state' }, SAVED], ['unknown', null, SAVED], ['unknown', null, null],
    [SAVED.state, { state: SAVED.state }, SAVED],
  ]) {
    const hash = `#error=access_denied&state=${state}`;
    const h = harness({ hash, login, saved });
    assert.deepEqual(h.drive.handleCallback(), { handled: false });
    assert.equal(h.storage.getItem(KEY), saved ? JSON.stringify(saved) : null);
    // main と同じく、URL 消去前のログイン用 error を渡す。ログインの処理自体は変えない。
    const deps = Object.create(h.deps);
    deps.location = { ...h.location, hash };
    assert.deepEqual(await handleGoogleCallback(deps), { handled: true, notice: 'Google でのログインをやめました。' });
    assert.equal(h.drive.hasToken(), false);
    assert.equal(h.location.hash, '#/login');
  }
});

test('Drive: ID トークン・ふつうの画面では何もせず、設定なし・練習モードなら操作を作らない', () => {
  for (const hash of ['#id_token=fake&state=fake-drive-state', '#/history/lesson-1']) {
    const h = harness({ hash });
    assert.deepEqual(h.drive.handleCallback(), { handled: false });
    assert.deepEqual(h.events, []);
    assert.equal(h.location.hash, hash);
  }
  for (const options of [{ clientId: '' }, { demo: true }]) {
    const h = harness(options);
    Object.defineProperty(h.deps, 'location', { get() { throw new Error('読まない'); } });
    assert.equal(createDriveExport(h.deps), null);
    assert.deepEqual(h.events, []);
  }
});

test('Drive: 開始では state・sid・at だけを保存し、Google へ移動する', () => {
  const h = harness({ hash: '#/history/lesson-1', saved: null });
  h.drive.begin('lesson-1');
  assert.deepEqual(JSON.parse(h.storage.getItem(KEY)), { state: '07'.repeat(16), sid: 'lesson-1', at: 1001 });
  const [, url] = h.events.at(-1);
  const params = new URL(url).searchParams;
  assert.equal(params.get('state'), '07'.repeat(16));
  assert.equal(params.get('redirect_uri'), 'https://app.example.test/classpulse/');
  assert.equal(params.get('login_hint'), 'teacher@example.test');
  assert.equal(h.drive.hasToken(), false);
});

for (const operation of ['getRandomValues', 'now', 'getLoginHint', 'setItem', 'assign']) {
  test(`Drive: 開始の ${operation} の例外は安全なエラーにして保存を残さない`, () => {
    const h = harness({ saved: null });
    const fail = () => { throw new Error('fake-sensitive-text'); };
    if (operation === 'setItem') Object.defineProperty(h.deps, 'sessionStorage', { value: { ...h.storage, setItem: fail } });
    else h.deps[operation] = fail;
    assert.throws(() => h.drive.begin('lesson-1'), (e) => e instanceof NetError && e.code === 'drive-failed' && !e.message.includes('fake-sensitive-text'));
    assert.equal(h.storage.getItem(KEY), null);
    assert.ok(!h.events.some((e) => Array.isArray(e) && e[0] === 'assign'));
  });
}

test('Drive: multipart/related は JSON と BOM なし CSV の 2 部分で、認証はヘッダーだけ', async () => {
  const h = harness();
  h.drive.handleCallback();
  const name = 'ClassPulse_空_2026-11-13';
  const csv = historyToCsv({ title: '空', questions: [{ type: 'free', texts: ['=1+1'], total: 1 }] });
  assert.deepEqual(await h.drive.upload({ name, csv }), { id: 'fake-sheet', webViewLink: LINK });
  const [{ url, init }] = h.fetch.calls;
  const boundary = 'classpulse_' + '07'.repeat(16);
  assert.equal(url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { Authorization: 'Bearer fake-drive-token', 'Content-Type': `multipart/related; boundary=${boundary}` });
  assert.equal(init.body, `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: 'application/vnd.google-apps.spreadsheet' })}\r\n`
    + `--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
  assert.ok(!init.body.includes('\uFEFF'));
  for (const value of [init.body, url, h.location.hash, h.storage.getItem(KEY) || '', JSON.stringify(h.events)]) assert.ok(!value.includes('fake-drive-token'));
});

test('Drive: 本文が境界の候補を含んでも 2 部分を壊さない', async () => {
  const h = harness();
  h.drive.handleCallback();
  const candidate = 'classpulse_' + '07'.repeat(16);
  await h.drive.upload({ name: candidate, csv: candidate + '_' });
  assert.equal(h.fetch.calls[0].init.headers['Content-Type'], `multipart/related; boundary=${candidate}__`);
});

for (const [label, response, code, keepsToken] of [
  ['401', { status: 401, body: { error: 'fake-drive-token' } }, 'drive-auth', false],
  ['403', { status: 403, body: { error: 'fake-drive-token' } }, 'drive-denied', true],
  ['500', { status: 500, body: { error: 'fake-drive-token' } }, 'drive-failed', true],
  ['通信', new Error('fake-drive-token'), 'network', true],
  ['空の返答', { body: null }, 'drive-failed', true],
  ['危険なリンク', { body: { id: 'fake-sheet', webViewLink: 'javascript:alert(1)' } }, 'drive-failed', true],
]) {
  test(`Drive: ${label}の失敗を分類し、生の応答をエラー文に出さない`, async () => {
    const h = harness({ response });
    h.drive.handleCallback();
    await assert.rejects(h.drive.upload({ name: 'name', csv: 'csv' }), (e) => e instanceof NetError && e.code === code && !e.message.includes('fake-drive-token'));
    assert.equal(h.drive.hasToken(), keepsToken);
    if (!keepsToken) {
      await assert.rejects(h.drive.upload({ name: 'name', csv: 'csv' }), { code: 'drive-auth' });
      assert.equal(h.fetch.calls.length, 1);
    }
  });
}

// 既存の画面テストと同じく、DOM と保存先だけを代役にして history.js を動かす。
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const RESULT = { title: '空の学習', endedAt: new Date(2026, 10, 13, 10, 7).getTime(), participants: 3, questions: [] };
function viewHarness({ driveExport = null, sid = 'lesson-1', driveNotice, getHistory = async () => RESULT, deleteHistory = async () => {}, createUrlFails = false, clickFails = false } = {}) {
  const downloads = [];
  const blobs = [];
  const revoked = [];
  const removed = [];
  const navigations = [];
  const dialogs = [];
  const toasts = [];
  const all = (n) => [n, ...(n.children || []).flatMap(all)];
  const el = (tag, props = {}, ...children) => ({
    tag, ...props, textContent: props.text || '', disabled: props.disabled || false,
    children: children.flat(Infinity).filter(Boolean),
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    append(...items) { this.children.push(...items); },
    click() { if (clickFails) throw new Error('failed'); downloads.push(this); },
    remove() { removed.push(this); },
  });
  const root = el('root');
  const sandbox = {
    el, routeHash, historyToCsv, exportFileName, formatDateTime, Blob,
    closeAllDialogs: () => {}, confirmDialog: async (options) => { dialogs.push(options); return true; },
    toast: (text) => toasts.push(text),
    URL: {
      createObjectURL: (blob) => { if (createUrlFails) throw new Error('failed'); blobs.push(blob); return 'blob:fake-csv'; },
      revokeObjectURL: (url) => revoked.push(url),
    },
  };
  const source = readFileSync(new URL('../js/views/history.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\r?$/gm, '').replace('export function mount', 'function mount');
  runInNewContext(source, sandbox);
  const ctx = { params: { sid }, driveExport, driveNotice, repo: { getHistory, deleteHistory, listHistory: async () => [] }, navigate: (name) => navigations.push(name) };
  const cleanup = sandbox.mount(root, ctx);
  const nodes = () => all(root);
  const find = (text) => nodes().find((n) => n.textContent === text);
  return { root, ctx, cleanup, nodes, find, click: (text) => { assert.ok(find(text), text); return find(text).onclick(); }, downloads, blobs, revoked, removed, navigations, dialogs, toasts };
}

test('結果画面: CSV は Drive 設定なしでも使え、BOM・ファイル名・URL の破棄を確かめる', async () => {
  const h = viewHarness();
  await settle();
  assert.ok(!h.find('Google ドライブに保存'));
  const page = h.nodes().find((n) => n.class === 'hist');
  assert.equal(page.children[1].tag, 'h1');
  assert.equal(page.children[3].class, 'hist-export-actions');
  await h.click('CSV をダウンロード');
  assert.equal(h.blobs[0].type, 'text/csv;charset=utf-8');
  assert.deepEqual([...new Uint8Array(await h.blobs[0].arrayBuffer()).slice(0, 3)], [239, 187, 191]);
  assert.equal(await h.blobs[0].text(), historyToCsv(RESULT));
  assert.equal(h.downloads[0].download, 'ClassPulse_空の学習_2026-11-13.csv');
  assert.deepEqual(h.revoked, ['blob:fake-csv']);
  assert.equal(h.removed.length, 1);
});

test('結果画面: CSV ダウンロードの失敗を知らせ、作った URL は失敗時にも捨てる', async () => {
  for (const options of [{ createUrlFails: true }, { clickFails: true }]) {
    const h = viewHarness(options);
    await settle();
    await h.click('CSV をダウンロード');
    assert.ok(h.find('CSV をダウンロードできませんでした。もう一度ためしてください。'));
    assert.ok(h.nodes().some((n) => n.role === 'alert'));
    assert.deepEqual(h.revoked, options.clickFails ? ['blob:fake-csv'] : []);
  }
});

test('結果画面: Drive 保存中は両ボタンを止め、連打で 2 回送らず、成功のリンクを出す', async () => {
  let finish;
  const calls = [];
  const h = viewHarness({ driveExport: {
    hasToken: () => true, takePending: () => false,
    upload: (value) => { calls.push(value); return new Promise((resolve) => { finish = resolve; }); },
  } });
  await settle();
  const waiting = h.click('Google ドライブに保存');
  assert.ok(h.find('保存しています…'));
  assert.equal(h.find('CSV をダウンロード').disabled, true);
  assert.equal(h.find('Google ドライブに保存').disabled, true);
  await h.click('Google ドライブに保存');
  await h.click('CSV をダウンロード');
  assert.equal(calls.length, 1);
  assert.equal(h.downloads.length, 0);
  assert.equal(calls[0].name, exportFileName(RESULT));
  assert.equal(calls[0].csv, historyToCsv(RESULT));
  finish({ id: 'fake-sheet', webViewLink: LINK });
  await waiting;
  assert.ok(h.find('Google ドライブに保存しました。'));
  const link = h.find('スプレッドシートを開く');
  assert.equal(link.href, LINK);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  assert.equal(h.find('CSV をダウンロード').disabled, false);
  assert.equal(h.find('Google ドライブに保存').disabled, false);
  assert.ok(h.nodes().some((n) => n.role === 'status'));
});

test('結果画面: トークンが無いと認可を始め、移動まで連打を止める', async () => {
  const calls = [];
  const h = viewHarness({ driveExport: { hasToken: () => false, takePending: () => false, begin: (sid) => calls.push(sid) } });
  await settle();
  await h.click('Google ドライブに保存');
  await h.click('Google ドライブに保存');
  assert.deepEqual(calls, ['lesson-1']);
  assert.equal(h.find('Google ドライブに保存').disabled, true);
});

for (const [code, message] of [
  ['drive-auth', 'Google の確認が切れました。もう一度「Google ドライブに保存」を押してください。'],
  ['drive-denied', 'Google ドライブに保存できませんでした。Drive の設定（Google Drive API）が有効になっているか、管理者の先生に確かめてください。'],
  ['network', '通信できませんでした。接続を確かめて、もう一度押してください。'],
  ['drive-failed', 'Google ドライブに保存できませんでした。'],
  ['unknown', 'Google ドライブに保存できませんでした。'],
  ['constructor', 'Google ドライブに保存できませんでした。'],
]) {
  test(`結果画面: ${code} を決まった文で知らせ、保存をやり直せる`, async () => {
    const h = viewHarness({ driveExport: {
      hasToken: () => true, takePending: () => false,
      upload: async () => { throw new NetError(code, 'fake-sensitive-text'); },
    } });
    await settle();
    await h.click('Google ドライブに保存');
    assert.ok(h.find(message));
    assert.ok(h.nodes().some((n) => n.role === 'alert'));
    assert.equal(h.find('Google ドライブに保存').disabled, false);
    assert.equal(h.find('CSV をダウンロード').disabled, false);
    assert.ok(!h.nodes().some((n) => n.textContent.includes('fake-sensitive-text')));
  });
}

test('結果画面: 認可を始められなかったときも、ボタンを戻す', async () => {
  const h = viewHarness({ driveExport: {
    hasToken: () => false, takePending: () => false, begin: () => { throw new Error('fake-sensitive-text'); },
  } });
  await settle();
  await h.click('Google ドライブに保存');
  assert.ok(h.find('Google ドライブに保存できませんでした。'));
  assert.equal(h.find('Google ドライブに保存').disabled, false);
});

test('結果画面: 認可の戻りでは読み込み後に該当授業だけを 1 回保存し、再表示・再起動で増やさない', async () => {
  const auth = harness();
  auth.drive.handleCallback();
  const other = viewHarness({ driveExport: auth.drive, sid: 'other' });
  await settle();
  assert.equal(auth.fetch.calls.length, 0);
  other.cleanup();
  let finishLoad;
  const result = viewHarness({ driveExport: auth.drive, getHistory: () => new Promise((resolve) => { finishLoad = resolve; }) });
  assert.equal(auth.fetch.calls.length, 0);
  finishLoad(RESULT);
  await settle();
  assert.equal(auth.fetch.calls.length, 1);
  assert.ok(result.find('Google ドライブに保存しました。'));
  result.cleanup();
  viewHarness({ driveExport: auth.drive });
  await settle();
  assert.equal(auth.fetch.calls.length, 1);
  viewHarness({ driveExport: createDriveExport(auth.deps) });
  await settle();
  assert.equal(auth.fetch.calls.length, 1);
});

test('結果画面: 自動保存に失敗しても、再表示による自動の再送はしない', async () => {
  const auth = harness({ response: new Error('fake-network-error') });
  auth.drive.handleCallback();
  const first = viewHarness({ driveExport: auth.drive });
  await settle();
  assert.equal(auth.fetch.calls.length, 1);
  first.cleanup();
  viewHarness({ driveExport: auth.drive });
  await settle();
  assert.equal(auth.fetch.calls.length, 1);
});

test('結果画面: 離れたあとに成功・失敗しても表示せず、古いボタンも動かない', async () => {
  for (const failure of [false, true]) {
    let finish;
    const h = viewHarness({ driveExport: {
      hasToken: () => true, takePending: () => false,
      upload: () => new Promise((resolve, reject) => { finish = failure ? reject : resolve; }),
    } });
    await settle();
    const waiting = h.click('Google ドライブに保存');
    h.cleanup();
    finish(failure ? new Error('fake-sensitive-text') : { webViewLink: LINK });
    await waiting;
    assert.ok(h.find('保存しています…'));
    assert.ok(!h.find('スプレッドシートを開く'));
    await h.click('CSV をダウンロード');
    assert.equal(h.downloads.length, 0);
  }
});

test('結果画面: 履歴の読み込み中に離れたら自動保存の印を消費しない', async () => {
  const auth = harness();
  auth.drive.handleCallback();
  let resolve;
  const h = viewHarness({ driveExport: auth.drive, getHistory: () => new Promise((r) => { resolve = r; }) });
  h.cleanup();
  resolve(RESULT);
  await settle();
  assert.equal(auth.fetch.calls.length, 0);
  assert.equal(auth.drive.takePending('lesson-1'), true);
});

test('履歴と結果: 戻りの知らせを表示し、一覧・存在しない結果にはボタンを出さない', async () => {
  for (const options of [{ sid: undefined, getHistory: async () => null }, { sid: '', getHistory: async () => RESULT }]) {
    const h = viewHarness({ ...options, driveNotice: MISMATCH });
    await settle();
    assert.ok(h.find(MISMATCH));
    assert.ok(!h.find('CSV をダウンロード'));
    assert.ok(!h.find('Google ドライブに保存'));
  }
  const cancelled = viewHarness({ driveNotice: 'Google ドライブへの保存をやめました。' });
  await settle();
  assert.equal(cancelled.find('Google ドライブへの保存をやめました。').role, 'status');
});

test('結果画面: 記録の削除の位置・確認文・実行を保つ', async () => {
  const deleted = [];
  const h = viewHarness({ deleteHistory: async (sid) => deleted.push(sid) });
  await settle();
  const page = h.nodes().find((n) => n.class === 'hist');
  assert.equal(page.children.at(-1).class, 'hist-foot');
  assert.equal(page.children.at(-1).children[0].textContent, 'この記録を削除');
  await h.click('この記録を削除');
  assert.deepEqual(deleted, ['lesson-1']);
  assert.equal(h.dialogs[0].title, 'この授業の記録を削除しますか？');
  assert.equal(h.dialogs[0].body, '元に戻せません。');
  assert.deepEqual(h.toasts, ['削除しました。']);
  assert.deepEqual(h.navigations, ['history']);
});
