import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet } from './helpers/fake-net.js';
import { createRepo } from '../js/repo.js';
import { NetError } from '../js/errors.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isStillUser } from '../js/guard.js';

// 画面の処理をそのまま動かし、DOM と確認ダイアログだけを代役にする
function viewHarness(name, ctx, confirmation = async () => true) {
  const element = (tag, props = {}, ...children) => {
    const n = {
      tag, ...props, children: children.flat(Infinity).filter(Boolean), handlers: {},
      value: props.value ?? '', hidden: props.hidden ?? false, disabled: props.disabled ?? false,
      textContent: props.text ?? '',
      replaceChildren(...items) { this.children = items.flat(Infinity).filter(Boolean); },
      addEventListener(event, fn) { this.handlers[event] = fn; },
      focus() {},
      querySelectorAll(selector) { return all(this).filter((x) => x.tag === 'button' && (!selector.includes('[') || 'data-teacher-action' in x)); },
    };
    return n;
  };
  const all = (n) => [n, ...(n.children || []).flatMap(all)];
  const root = element('root');
  const toasts = [];
  const dialogs = [];
  const sandbox = {
    el: element, isStillUser, toast: (message) => toasts.push(message), closeAllDialogs: () => {},
    confirmDialog: async (options) => { dialogs.push(options); return confirmation(); },
  };
  const source = readFileSync(new URL(`../js/views/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace('export function mount', 'function mount');
  runInNewContext(source, sandbox);
  const cleanup = sandbox.mount(root, ctx);
  return {
    root, toasts, dialogs, cleanup,
    nodes: () => all(root),
    find: (text) => all(root).find((n) => n.textContent === text),
    input: (id) => all(root).find((n) => n.id === id),
    text: () => all(root).map((n) => n.textContent).join('\n'),
    submit: () => all(root).find((n) => n.tag === 'form').handlers.submit({ preventDefault() {} }),
    click: (text) => {
      const n = all(root).find((x) => x.tag === 'button' && x.textContent === text);
      assert.ok(n, text);
      return n.onclick();
    },
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const authFor = (uid = 'self') => ({ user: { uid, email: `${uid}@example.com` }, signOut() { this.user = null; } });

test('登録画面: label と新規パスワード欄を持ち、空欄・短い・不一致を通信前に止める', async () => {
  let calls = 0;
  const h = viewHarness('signup', { auth: { signUpTeacher: async () => { calls += 1; } } });
  for (const id of ['signup-email', 'signup-password', 'signup-confirm']) assert.ok(h.nodes().some((n) => n.tag === 'label' && n.for === id));
  for (const id of ['signup-password', 'signup-confirm']) {
    assert.equal(h.input(id).type, 'password');
    assert.equal(h.input(id).autocomplete, 'new-password');
  }
  await h.submit();
  assert.ok(h.find('メールアドレスとパスワードを入れてください。'));
  h.input('signup-email').value = 'new@example.com';
  h.input('signup-password').value = 'short';
  await h.submit();
  assert.ok(h.find('パスワードは 8 文字以上にしてください。'));
  h.input('signup-password').value = 'fake-signup-pass';
  await h.submit();
  assert.ok(h.find('パスワードが同じではありません。'));
  assert.equal(calls, 0);
});

function signupHarness(auth, requestAccess, navigate) {
  const h = viewHarness('signup', { auth, requestAccess, navigate });
  h.input('signup-email').value = 'new@example.com';
  h.input('signup-password').value = 'fake-signup-pass';
  h.input('signup-confirm').value = 'fake-signup-pass';
  return h;
}

for (const failRequest of [false, true]) {
  test(`登録画面: 申しこみの保存が${failRequest ? '失敗しても' : '成功したら'} pending へ進む`, async () => {
    const auth = authFor('new');
    const actions = [];
    auth.signUpTeacher = async () => { actions.push('signup'); return auth.user; };
    const h = signupHarness(auth, async (email, uid) => {
      actions.push(['request', email, uid]);
      if (failRequest) throw new NetError('network');
    }, async (name) => actions.push(name));
    await h.submit();
    assert.deepEqual(actions, ['signup', ['request', 'new@example.com', 'new'], 'pending']);
    assert.equal(h.input('signup-password').value, '');
    assert.equal(h.input('signup-confirm').value, '');
  });
}

test('登録画面: 画面を離れたあとの登録成功は捨て、別の人をログアウトしない', async () => {
  for (const changed of [false, true]) {
    const auth = authFor('new');
    let release;
    auth.signUpTeacher = () => new Promise((r) => { release = r; });
    let requested = false;
    const h = signupHarness(auth, async () => { requested = true; }, async () => {});
    const pending = h.submit();
    h.cleanup();
    if (changed) auth.user = { uid: 'other' };
    release({ uid: 'new', email: 'new@example.com' });
    await pending;
    assert.equal(auth.user?.uid ?? null, changed ? 'other' : null);
    assert.equal(requested, false);
  }
});

test('登録画面: 登録後の確認だけ offline なら、登録し直さず再確認できる', async () => {
  const auth = authFor('new');
  let registrations = 0;
  let navigations = 0;
  auth.signUpTeacher = async () => { registrations += 1; return auth.user; };
  const h = signupHarness(auth, async () => {}, async () => { navigations += 1; return 'offline'; });
  await h.submit();
  assert.ok(h.find('通信できませんでした。'));
  h.click('もう一度確かめる');
  await settle();
  assert.equal(registrations, 1);
  assert.equal(navigations, 2);
});

test('承認待ち画面: 申しこみあり・なし・停止・通信失敗の 4 通り', async () => {
  for (const state of ['requested', 'none', 'suspended', 'offline']) {
    const navigations = [];
    const auth = authFor();
    const h = viewHarness('pending', {
      auth, status: state === 'suspended' ? 'suspended' : 'pending', navigate: (name) => navigations.push(name),
      repo: { getMyRequest: async () => {
        if (state === 'offline') throw new NetError('network');
        return state === 'requested' ? { email: auth.user.email, at: 1 } : null;
      } },
    });
    await settle();
    const texts = {
      requested: 'self@example.comで登録を申しこみました。管理者の先生の承認を待っています。',
      none: 'このアカウントは、まだ ClassPulse の先生として登録されていません。',
      suspended: 'このアカウントは、利用を停止されています。管理者の先生に確かめてください。',
      offline: '通信できませんでした。',
    };
    assert.ok(h.find(texts[state]), state);
    assert.equal(!!h.find('利用を申しこむ'), state === 'none');
    if (state === 'requested' || state === 'offline') {
      h.click('もう一度確かめる');
      assert.deepEqual(navigations, ['dashboard']);
    }
    h.click('ログアウト');
    assert.equal(auth.user, null);
    assert.equal(navigations.at(-1), 'login');
  }
});

test('承認待ち画面: 再申請に成功したら待機の表示になる', async () => {
  let request = null;
  const h = viewHarness('pending', {
    auth: authFor(), status: 'pending', navigate: () => {},
    repo: { getMyRequest: async () => request, requestAccess: async (email) => { request = { email, at: 1 }; } },
  });
  await settle();
  h.click('利用を申しこむ');
  await settle();
  assert.ok(h.find('もう一度確かめる'));
  assert.equal(h.find('利用を申しこむ'), undefined);
});

test('管理画面: 管理者でなければ一覧の読みこみもしない', async () => {
  let reads = 0;
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => false, listRequests: async () => { reads += 1; }, listTeachers: async () => { reads += 1; },
  } });
  await settle();
  assert.ok(h.find('この画面は、管理者の先生だけが使えます。'));
  assert.equal(reads, 0);
});

test('管理画面: 自分のメールと印を出すが、停止・再開ボタンは出さない', async () => {
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => true, listRequests: async () => [],
    listTeachers: async () => [{ uid: 'self', email: '', active: true, approvedAt: 0 }],
  } });
  await settle();
  assert.ok(h.find('self@example.com'));
  assert.ok(h.find('（自分・管理者）'));
  assert.equal(h.find('利用を停止'), undefined);
  assert.equal(h.find('再開'), undefined);
  assert.ok(h.find('承認待ちの人はいません。'));
});

test('管理画面: 確認と操作の間は二重送信せず、承認後に一覧を読み直す', async () => {
  let release;
  let writes = 0;
  let reads = 0;
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => true,
    listRequests: async () => { reads += 1; return writes ? [] : [{ uid: 'new', email: 'new@example.com', at: 1 }]; },
    listTeachers: async () => [], approveTeacher: async () => { writes += 1; },
  } }, () => new Promise((r) => { release = r; }));
  await settle();
  const first = h.click('承認する');
  assert.ok(h.nodes().filter((n) => n.tag === 'button').every((n) => n.disabled));
  await h.click('承認する');
  assert.equal(h.dialogs.length, 1);
  assert.equal(writes, 0);
  assert.match(h.dialogs[0].body, /本人に確かめてから承認/);
  release(true);
  await first;
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.deepEqual(h.toasts, ['承認しました。']);
});

test('管理画面: 操作失敗を知らせ、ボタンを戻す', async () => {
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => true, listRequests: async () => [],
    listTeachers: async () => [{ uid: 'other', email: '', active: false, approvedAt: 0 }],
    setTeacherActive: async () => { throw new NetError('network'); },
  } });
  await settle();
  assert.ok(h.find('メールアドレスの記録なし'));
  await h.click('再開');
  assert.ok(h.find('再開できませんでした。接続を確かめて、もう一度押してください。'));
  assert.equal(h.find('再開').disabled, false);
});

test('先生の状態: true・false・未登録・こわれた値を区別する。isTeacher も残る', async () => {
  const net = createFakeNet({ initial: { teacherList: { active: true, suspended: false, broken: 'true' } } });
  for (const [uid, status] of [['active', 'active'], ['suspended', 'suspended'], ['missing', 'none'], ['broken', 'none']]) {
    const repo = createRepo(net, uid);
    assert.equal(await repo.teacherStatus(), status);
    assert.equal(await repo.isTeacher(), status === 'active');
  }
  net.setOnline(false);
  await assert.rejects(createRepo(net, 'active').teacherStatus(), { code: 'network' });
});

test('isAdmin: true だけが管理者。拒否・通信失敗は false', async () => {
  const net = createFakeNet({ initial: { admins: { yes: true, no: false, broken: 'true' } } });
  for (const uid of ['yes', 'no', 'missing', 'broken']) assert.equal(await createRepo(net, uid).isAdmin(), uid === 'yes');
  for (const code of ['denied', 'network']) {
    const repo = createRepo({ get: async () => { throw new NetError(code); } }, 'yes');
    assert.equal(await repo.isAdmin(), false);
  }
});

test('申しこみは本人の場所へサーバー時刻で書き、読み直せる', async () => {
  const net = createFakeNet({ now: () => 1234 });
  const repo = createRepo(net, 'new');
  assert.equal(await repo.getMyRequest(), null);
  const calls = [];
  const set = net.set;
  net.set = (path, value) => { calls.push([path, value]); return set(path, value); };
  await repo.requestAccess('new@example.com');
  assert.deepEqual(calls, [['teacherRequests/new', { email: 'new@example.com', at: { '.sv': 'timestamp' } }]]);
  assert.deepEqual(await repo.getMyRequest(), { email: 'new@example.com', at: 1234 });
  assert.equal(await createRepo(net, 'other').getMyRequest(), null);
});

test('申しこみは古い順。こわれた項目を落とし、メール・時刻を整える', async () => {
  const net = createFakeNet({ initial: { teacherRequests: {
    newer: { email: 'b@example.com', at: 20 }, older: { email: 'a@example.com', at: 10 },
    broken: 'x', fields: { email: 42, at: 'x' },
  } } });
  const repo = createRepo(net, 'fields');
  assert.deepEqual(await repo.listRequests(), [
    { uid: 'fields', email: '', at: 0 }, { uid: 'older', email: 'a@example.com', at: 10 }, { uid: 'newer', email: 'b@example.com', at: 20 },
  ]);
  assert.deepEqual(await repo.getMyRequest(), { email: '', at: 0 });
  assert.equal(await createRepo(net, 'broken').getMyRequest(), null);
});

test('一覧の親や項目がこわれていても画面用の形を返す', async () => {
  for (const value of [null, false, 'broken', []]) {
    const repo = createRepo({ get: async () => value }, 'u');
    assert.deepEqual(await repo.listRequests(), []);
    assert.deepEqual(await repo.listTeachers(), []);
    assert.equal(await repo.getMyRequest(), null);
  }
  const repo = createRepo({ get: async () => ({ u: { email: [], at: Infinity }, bad: [] }) }, 'u');
  assert.deepEqual(await repo.listRequests(), [{ uid: 'u', email: '', at: 0 }]);
});

test('先生の一覧: 状態と名簿を合わせ、メールあり・メールの順。名簿だけの人は出さない', async () => {
  const net = createFakeNet({ initial: {
    teacherList: { z: true, b: false, a: true, missing: false, broken: 'yes' },
    teacherDirectory: { z: { email: 42, approvedAt: 'x' }, b: { email: 'b@example.com', approvedAt: 20 }, a: { email: 'a@example.com', approvedAt: 10 }, only: { email: 'only@example.com' } },
  } });
  assert.deepEqual(await createRepo(net, 'u').listTeachers(), [
    { uid: 'a', email: 'a@example.com', active: true, approvedAt: 10 },
    { uid: 'b', email: 'b@example.com', active: false, approvedAt: 20 },
    { uid: 'missing', email: '', active: false, approvedAt: 0 },
    { uid: 'z', email: '', active: true, approvedAt: 0 },
  ]);
  await net.set('teacherDirectory', 'broken');
  assert.ok((await createRepo(net, 'u').listTeachers()).every((t) => t.email === '' && t.approvedAt === 0));
});

test('承認はルートへの 1 回の update で 3 パスだけを書く', async () => {
  const net = createFakeNet({ initial: { teacherRequests: { new: { email: 'new@example.com', at: 1 } }, teachers: { new: { keep: true } } } });
  const calls = [];
  for (const op of ['set', 'update', 'remove']) {
    const original = net[op];
    net[op] = (...args) => { calls.push([op, ...args]); return original(...args); };
  }
  await createRepo(net, 'admin').approveTeacher('new', 'new@example.com', 99);
  assert.deepEqual(calls, [['update', '', {
    'teacherList/new': true, 'teacherDirectory/new': { email: 'new@example.com', approvedAt: 99 }, 'teacherRequests/new': null,
  }]]);
  assert.deepEqual(net.dump(), { teacherList: { new: true }, teacherDirectory: { new: { email: 'new@example.com', approvedAt: 99 } }, teachers: { new: { keep: true } } });
});

test('承認の update が失敗したら、申しこみを残して途中の状態を作らない', async () => {
  const net = createFakeNet({ initial: { teacherRequests: { new: { email: 'new@example.com', at: 1 } } }, deny: (op) => op === 'update' });
  const before = net.dump();
  await assert.rejects(createRepo(net, 'admin').approveTeacher('new', 'new@example.com', 99), { code: 'denied' });
  assert.deepEqual(net.dump(), before);
});

test('ことわると対象の申しこみだけを消す', async () => {
  const net = createFakeNet({ initial: { teacherRequests: { a: { email: 'a@example.com' }, b: { email: 'b@example.com' } }, teacherList: { a: true } } });
  await createRepo(net, 'admin').rejectRequest('a');
  assert.deepEqual(net.dump(), { teacherRequests: { b: { email: 'b@example.com' } }, teacherList: { a: true } });
});

test('停止・再開は teacherList だけを変え、教材と授業を残す', async () => {
  const keep = { teachers: { t: { decks: { keep: true } } }, sessions: { s: { owner: 't' } } };
  const net = createFakeNet({ initial: { ...keep, teacherList: { t: true } } });
  const repo = createRepo(net, 'admin');
  await repo.setTeacherActive('t', false);
  assert.deepEqual(net.dump(), { ...keep, teacherList: { t: false } });
  await repo.setTeacherActive('t', true);
  assert.deepEqual(net.dump(), { ...keep, teacherList: { t: true } });
});

test('自分自身の停止・再開は書きこまず例外にする', async () => {
  const calls = [];
  const repo = createRepo({ set: async (...args) => calls.push(args) }, 'self');
  await assert.rejects(repo.setTeacherActive('self', false), /自分自身/);
  await assert.rejects(repo.setTeacherActive('self', true), /自分自身/);
  assert.deepEqual(calls, []);
});
