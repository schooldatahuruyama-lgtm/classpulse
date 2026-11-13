import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTeacherAccess, isStillUser } from '../js/guard.js';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createRepo } from '../js/repo.js';
import { NetError } from '../js/errors.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseRoute, routeHash, needsTeacher, viewFile } from '../js/router.js';

function fakeAuth(user) {
  return { user, signOut() { this.user = null; } };
}
const check = async (auth, repo) => (await checkTeacherAccess({ auth, repo })).verdict;

// main.js 本体を使い、ブラウザの入出力と画面の読みこみだけを代役にする
async function mainHarness({ user = { uid: 'A' }, initial = {}, net = createMemoryNet({ initial }), hash = '#/', loadView } = {}) {
  const node = (tag, props = {}, ...children) => ({
    tag, props, children: children.flat(Infinity).filter(Boolean),
    replaceChildren(...items) { this.children = items; },
    querySelector(selector) {
      for (const child of this.children.flat(Infinity)) {
        if (child?.props?.class === selector.slice(1)) return child;
        const found = child?.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    },
  });
  const app = node('root');
  const banner = node('root');
  const auth = { ...fakeAuth(user), restore: async () => auth.user };
  const location = { hash, hostname: 'localhost', search: '?demo=1' };
  const mounted = [];
  const notices = [];
  const events = {};
  let cleanups = 0;
  const context = {
    document: { getElementById: (id) => id === 'app' ? app : banner }, location,
    history: { pushState: (_, __, next) => { location.hash = next; }, replaceState: (_, __, next) => { location.hash = next; } },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    console, FIREBASE: {}, isDemoAllowed: () => true,
    createDemoBackend: () => ({ net, teacherAuth: auth, studentAuth: {} }),
    createRepo, parseRoute, routeHash, needsTeacher, viewFile, checkTeacherAccess, isStillUser,
    el: node, toast: (text) => notices.push(text), confirmDialog: async () => false,
    loadTestView: async (name) => {
      if (loadView) await loadView(name);
      return { mount: (root, ctx) => { mounted.push({ name, ctx, shell: root !== app }); return () => { cleanups += 1; }; } };
    },
  };
  let source = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?$/gm, '');
  const dynamicImport = 'return await import(`./views/${viewFile(name)}.js`);';
  assert.ok(source.includes(dynamicImport));
  source = source.replace(dynamicImport, 'return await loadTestView(name);');
  runInNewContext(source, context);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  return {
    app, auth, net, location, mounted, notices, settle,
    get last() { return mounted.at(-1); }, get cleanups() { return cleanups; },
    async open(next) { location.hash = next; await events.hashchange(); await settle(); },
  };
}

for (const [value, verdict] of [[null, 'pending'], [false, 'suspended']]) {
  test(`入口: ${verdict} の人は、どの先生用 URL もメニューのない pending に移る`, async () => {
    for (const hash of ['#/', '#/edit/d', '#/present/s', '#/history', '#/history/s', '#/trash', '#/teachers', '#/login', '#/signup', '#/pending']) {
      const h = await mainHarness({ initial: { teacherList: { A: value } }, hash });
      assert.deepEqual(h.mounted.map((x) => x.name), ['pending'], hash);
      assert.equal(h.last.shell, false);
      assert.equal(h.last.ctx.status, verdict);
      assert.equal(h.location.hash, '#/pending');
      assert.equal(h.auth.user.uid, 'A');
    }
  });
}

test('入口: 未ログインで signup は開ける。pending は login。利用中の先生はホーム', async () => {
  const signup = await mainHarness({ user: null, hash: '#/signup' });
  assert.equal(signup.last.name, 'signup');
  assert.equal(signup.last.shell, false);
  const pending = await mainHarness({ user: null, hash: '#/pending' });
  assert.equal(pending.last.name, 'login');
  for (const hash of ['#/login', '#/signup', '#/pending']) {
    const h = await mainHarness({ initial: { teacherList: { A: true } }, hash });
    assert.equal(h.last.name, 'dashboard');
    assert.equal(h.location.hash, '#/');
  }
});

for (const failure of ['denied', 'network']) {
  test(`入口: 管理者の読みこみが ${failure} でもホームを開け、管理メニューは出ない`, async () => {
    const net = createMemoryNet({ initial: { teacherList: { A: true } } });
    const get = net.get;
    net.get = async (path) => { if (path.startsWith('admins/')) throw new NetError(failure); return get(path); };
    const h = await mainHarness({ net });
    assert.equal(h.last.name, 'dashboard');
    assert.doesNotMatch(JSON.stringify(h.app), /先生の管理/);
    assert.equal(h.auth.user.uid, 'A');
  });
}

test('入口: メニューの管理者確認は uid ごとに 1 回。人が替われば読み直す', async () => {
  const net = createMemoryNet({ initial: { teacherList: { A: true, B: true }, admins: { A: true } } });
  const gets = [];
  const get = net.get;
  net.get = async (path) => { gets.push(path); return get(path); };
  const h = await mainHarness({ net });
  assert.match(JSON.stringify(h.app), /先生の管理/);
  await h.last.ctx.navigate('history');
  await h.last.ctx.navigate('trash');
  assert.equal(gets.filter((p) => p === 'admins/A').length, 1);
  h.auth.user = { uid: 'B' };
  await h.open('#/');
  assert.equal(gets.filter((p) => p === 'admins/B').length, 1);
  assert.doesNotMatch(JSON.stringify(h.app), /先生の管理/);
});

test('入口: offline では今の画面・URL・ログインを残し、片づけない', async () => {
  const h = await mainHarness({ initial: { teacherList: { A: true } } });
  h.net.setOnline(false);
  assert.equal(await h.last.ctx.navigate('history'), 'offline');
  assert.equal(h.location.hash, '#/');
  assert.equal(h.mounted.length, 1);
  assert.equal(h.cleanups, 0);
  assert.equal(h.auth.user.uid, 'A');
});

test('入口: 管理者確認中に別の人に替わったら、古いメニューも画面も出さない', async () => {
  const net = createMemoryNet({ initial: { teacherList: { A: true, B: true } } });
  const get = net.get;
  let release;
  net.get = (path) => path === 'admins/A' ? new Promise((r) => { release = r; }) : get(path);
  const h = await mainHarness({ net });
  assert.equal(h.mounted.length, 0);
  h.auth.user = { uid: 'B' };
  release(true);
  await h.settle();
  assert.equal(h.last.ctx.auth.user.uid, 'B');
  assert.doesNotMatch(JSON.stringify(h.app), /先生の管理/);
  assert.equal(h.mounted.length, 1);
});

test('入口: 画面の読みこみ中に別の人に替わったら、前の先生の画面を出さない', async () => {
  let release;
  const h = await mainHarness({ initial: { teacherList: { A: true } }, loadView: (name) => name === 'dashboard' ? new Promise((r) => { release = r; }) : undefined });
  assert.equal(h.mounted.length, 0);
  h.auth.user = { uid: 'B' };
  release();
  await h.settle();
  assert.deepEqual(h.mounted.map((x) => x.name), ['pending']);
  assert.equal(h.auth.user.uid, 'B');
});

test('登録された先生は ok（確かめた uid も返る）', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  assert.deepEqual(await checkTeacherAccess({ auth: fakeAuth({ uid: 't1' }), repo: createRepo(net, 't1') }), { verdict: 'ok', uid: 't1' });
});

test('ログインしていなければ signed-out', async () => {
  const net = createMemoryNet();
  assert.deepEqual(await checkTeacherAccess({ auth: fakeAuth(null), repo: createRepo(net, 't1') }), { verdict: 'signed-out', uid: null });
});

test('登録されていなければ pending。判定だけで、ログアウトはしない', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 'x' });
  assert.equal(await check(auth, createRepo(net, 'x')), 'pending');
  assert.deepEqual(auth.user, { uid: 'x' });
});

test('通信できないときは offline（ログインは保たれる）', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  net.setOnline(false);
  const auth = fakeAuth({ uid: 't1' });
  assert.equal(await check(auth, createRepo(net, 't1')), 'offline');
  const failing = { teacherStatus: async () => { throw new NetError('network', 'x'); } };
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

test('2 回の移動の間に先生の登録が外されたら、2 回目は pending', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t1: true } } });
  const auth = fakeAuth({ uid: 't1' });
  const repo = createRepo(net, 't1');
  assert.equal(await check(auth, repo), 'ok');
  await net.remove('teacherList/t1');
  assert.equal(await check(auth, repo), 'pending');
});

test('古い確認の応答: A の確認中に B に替わったら、呼び出し側は B を外さない', async () => {
  const auth = fakeAuth({ uid: 'A' });
  let release;
  const repoA = { teacherStatus: () => new Promise((r) => { release = r; }) };
  const pending = checkTeacherAccess({ auth, repo: repoA });
  auth.signOut();
  auth.user = { uid: 'B' }; // B がログイン
  release('none');
  const { verdict, uid } = await pending;
  assert.equal(verdict, 'pending');
  assert.equal(uid, 'A');
  // main.js と同じ判断: 今の人が確かめた人と同じときだけ画面を出す
  let shown = '';
  if (isStillUser(auth, uid)) shown = verdict;
  assert.deepEqual(auth.user, { uid: 'B' });
  assert.equal(shown, '');
  assert.equal(isStillUser(auth, 'B'), true);
  assert.equal(isStillUser(fakeAuth(null), null), true);
});

test('停止された先生は suspended。再開後は ok。どちらもログインを保つ', async () => {
  const net = createMemoryNet({ initial: { teacherList: { t: false } } });
  const auth = fakeAuth({ uid: 't' });
  const repo = createRepo(net, 't');
  assert.deepEqual(await checkTeacherAccess({ auth, repo }), { verdict: 'suspended', uid: 't' });
  assert.deepEqual(auth.user, { uid: 't' });
  await net.set('teacherList/t', true);
  assert.equal(await check(auth, repo), 'ok');
});

for (const status of ['active', 'suspended']) {
  test(`古い ${status} の応答も、確認中に人が替わったら使わない`, async () => {
    const auth = fakeAuth({ uid: 'A' });
    let release;
    const pending = checkTeacherAccess({ auth, repo: { teacherStatus: () => new Promise((r) => { release = r; }) } });
    auth.user = { uid: 'B' };
    release(status);
    const result = await pending;
    assert.equal(result.uid, 'A');
    assert.equal(isStillUser(auth, result.uid), false);
    assert.deepEqual(auth.user, { uid: 'B' });
  });
}
