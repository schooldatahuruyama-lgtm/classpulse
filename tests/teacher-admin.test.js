import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet } from './helpers/fake-net.js';
import { createRepo } from '../js/repo.js';
import { NetError } from '../js/errors.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isStillUser } from '../js/guard.js';
import { CONFIG } from '../js/config.js';
import { deleteNote } from '../js/teacher-cleanup.js';

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
    CONFIG, deleteNote,
    // 手動操作のテストでは自動削除を分ける。実際の処理は teacher-cleanup-view.test.js で確認する。
    runTeacherCleanup: async () => ({ deleted: 0 }),
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

test('管理画面: 自分のメールと印を出すが、停止・再開・削除ボタンは出さない', async () => {
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => true, listRequests: async () => [],
    listTeachers: async () => [{ uid: 'self', email: '', active: true, approvedAt: 0 }],
  } });
  await settle();
  assert.ok(h.find('self@example.com'));
  assert.ok(h.find('（自分・管理者）'));
  assert.equal(h.find('利用を停止'), undefined);
  assert.equal(h.find('再開'), undefined);
  assert.equal(h.find('削除'), undefined);
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
    { uid: 'a', email: 'a@example.com', active: true, approvedAt: 10, suspendedAt: null, hasDirectory: true },
    { uid: 'b', email: 'b@example.com', active: false, approvedAt: 20, suspendedAt: null, hasDirectory: true },
    { uid: 'missing', email: '', active: false, approvedAt: 0, suspendedAt: null, hasDirectory: false },
    { uid: 'z', email: '', active: true, approvedAt: 0, suspendedAt: null, hasDirectory: true },
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

test('停止・再開は利用状態と停止日時を変え、教材と授業を残す', async () => {
  const keep = { teachers: { t: { decks: { keep: true } } }, sessions: { s: { owner: 't' } } };
  const directory = { email: 't@example.com', approvedAt: 1 };
  const net = createFakeNet({ now: () => 99, initial: { ...keep, teacherList: { t: true }, teacherDirectory: { t: directory } } });
  const repo = createRepo(net, 'admin');
  await repo.setTeacherActive('t', false);
  assert.deepEqual(net.dump(), { ...keep, teacherList: { t: false }, teacherDirectory: { t: { ...directory, suspendedAt: 99 } } });
  await repo.setTeacherActive('t', true);
  assert.deepEqual(net.dump(), { ...keep, teacherList: { t: true }, teacherDirectory: { t: directory } });
});

test('自分自身の停止・再開は書きこまず例外にする', async () => {
  const calls = [];
  const repo = createRepo({ set: async (...args) => calls.push(args) }, 'self');
  await assert.rejects(repo.setTeacherActive('self', false), /自分自身/);
  await assert.rejects(repo.setTeacherActive('self', true), /自分自身/);
  assert.deepEqual(calls, []);
});

// 削除で読んだ場所と、書きこみの回数を確かめる
function recordedNet(initial) {
  const net = createFakeNet({ initial });
  const calls = [];
  for (const op of ['get', 'getKeys', 'set', 'update', 'remove']) {
    const original = net[op];
    net[op] = (...args) => { calls.push([op, ...args]); return original(...args); };
  }
  return { net, calls };
}

test('索引が無い古いデータも history と active の持ち主を確かめ、本人の授業と先生の 4 パスだけを 1 回の update で消す', async () => {
  const keep = {
    admins: { admin: true, target: true },
    teacherList: { other: true }, teacherDirectory: { other: { email: 'other@example.com' } },
    teacherRequests: { other: { email: 'other@example.com' } },
    teachers: { other: { decks: { d: { title: '残す教材' } } } },
    sessions: { other: { owner: 'other' } },
  };
  const initial = structuredClone(keep);
  initial.teacherList.target = false;
  initial.teacherDirectory.target = { email: 'target@example.com' };
  initial.teacherRequests.target = { email: 'target@example.com' };
  initial.teachers.target = {
    decks: { d: { title: '消す教材' } }, deckIndex: { d: { title: '消す教材' } },
    settings: { moderation: { enabled: true } },
    history: { 'old-1': { title: '授業 1' }, missing_2: { title: 'もう無い授業' } },
    active: { sid: 'active_3' },
  };
  initial.sessions['old-1'] = { owner: 'target' };
  initial.sessions.active_3 = { owner: 'target' };
  const { net, calls } = recordedNet(initial);
  assert.equal(await createRepo(net, 'admin').deleteTeacher('target'), undefined);
  assert.deepEqual(calls, [
    ['get', 'teacherList/target'], ['getKeys', 'teachers/target/history'], ['get', 'teachers/target/active'],
    ['getKeys', 'teachers/target/sessions'],
    ['get', 'sessions/old-1/owner'], ['get', 'sessions/missing_2/owner'], ['get', 'sessions/active_3/owner'],
    ['update', '', {
      'sessions/old-1': null, 'sessions/active_3': null,
      'teachers/target': null, 'teacherDirectory/target': null, 'teacherRequests/target': null, 'teacherList/target': null,
    }],
  ]);
  assert.deepEqual(net.dump(), keep);
});

test('同時開始で索引に 2 件、active に 1 件、履歴が無いときも両方の授業を削除する', async () => {
  const { net, calls } = recordedNet({
    teacherList: { target: false },
    teachers: { target: { sessions: { tab_1: true, tab_2: true }, active: { sid: 'tab_2' } } },
    sessions: {
      tab_1: { owner: 'target', inbox: { answers: { p1: { u1: { choice: 0, at: 1 } } } }, pub: { results: { p1: { counts: [1, 0], total: 1 } } } },
      tab_2: { owner: 'target' },
    },
  });
  await createRepo(net, 'admin').deleteTeacher('target');
  assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
    'sessions/tab_1': null, 'sessions/tab_2': null,
    'teachers/target': null, 'teacherDirectory/target': null, 'teacherRequests/target': null, 'teacherList/target': null,
  }]]);
  assert.equal(calls.filter(([op, path]) => op === 'get' && path === 'sessions/tab_2/owner').length, 1);
  assert.equal(net.dump(), null);
});

for (const active of [true, false]) {
  test(`索引に他の先生（${active ? '利用中' : '停止中'}）の授業や存在しない授業がまざっても消さない`, async () => {
    const { net, calls } = recordedNet({
      teacherList: { target: false, other: active },
      teachers: { target: { sessions: { own_session: true, other_session: true, missing_session: true } } },
      sessions: { own_session: { owner: 'target' }, other_session: { owner: 'other' } },
    });
    await createRepo(net, 'admin').deleteTeacher('target');
    assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
      'sessions/own_session': null, 'teachers/target': null, 'teacherDirectory/target': null,
      'teacherRequests/target': null, 'teacherList/target': null,
    }]]);
    assert.deepEqual(net.dump(), { teacherList: { other: active }, sessions: { other_session: { owner: 'other' } } });
  });
}

for (const active of [true, false]) {
  test(`history に他の先生（${active ? '利用中' : '停止中'}）の授業がまざっても消さない`, async () => {
    const keep = {
      teacherList: { other: active },
      teachers: { other: { decks: { d: { title: '残す教材' } } } },
      sessions: { other_session: { owner: 'other' } },
    };
    const initial = structuredClone(keep);
    initial.teacherList.target = false;
    initial.teachers.target = { history: { own_session: true, other_session: true } };
    initial.sessions.own_session = { owner: 'target' };
    const { net, calls } = recordedNet(initial);
    await createRepo(net, 'admin').deleteTeacher('target');
    assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
      'sessions/own_session': null, 'teachers/target': null, 'teacherDirectory/target': null,
      'teacherRequests/target': null, 'teacherList/target': null,
    }]]);
    assert.deepEqual(net.dump(), keep);
  });
}

test('active.sid が他の先生の授業でも、本人の履歴の授業だけを消す', async () => {
  const { net, calls } = recordedNet({
    teacherList: { target: false, other: false },
    teachers: { target: { history: { own_session: true }, active: { sid: 'other_session' } } },
    sessions: { own_session: { owner: 'target' }, other_session: { owner: 'other' } },
  });
  await createRepo(net, 'admin').deleteTeacher('target');
  assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
    'sessions/own_session': null, 'teachers/target': null, 'teacherDirectory/target': null,
    'teacherRequests/target': null, 'teacherList/target': null,
  }]]);
  assert.deepEqual(net.dump(), { teacherList: { other: false }, sessions: { other_session: { owner: 'other' } } });
});

test('自分自身の削除は読み取りも書きこみもしない', async () => {
  const { net, calls } = recordedNet({ teacherList: { self: false } });
  await assert.rejects(createRepo(net, 'self').deleteTeacher('self'), /自分自身/);
  assert.deepEqual(calls, []);
});

test('停止中でない先生（true・null・こわれた値）は状態だけ確認し、削除しない', async () => {
  for (const status of [true, null, 'false', 0]) {
    const { net, calls } = recordedNet({ teacherList: { target: status } });
    const before = net.dump();
    await assert.rejects(createRepo(net, 'admin').deleteTeacher('target'), /利用停止中/);
    assert.deepEqual(calls, [['get', 'teacherList/target']]);
    assert.deepEqual(net.dump(), before);
  }
});

test('記録も active も無い先生は、sessions を含めず 4 パスだけを削除する', async () => {
  const { net, calls } = recordedNet({ teacherList: { target: false } });
  await createRepo(net, 'admin').deleteTeacher('target');
  assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
    'teachers/target': null, 'teacherDirectory/target': null, 'teacherRequests/target': null, 'teacherList/target': null,
  }]]);
});

test('削除は不正な history と索引の鍵を除き、history・active・索引の同じ授業を重ねない', async () => {
  const { net, calls } = recordedNet({
    teacherList: { target: false }, teachers: { target: {
      history: { good_1: { title: '授業' }, 'a/b': true, '..': true, '': true, 'a.b': true, '日本語': true },
      active: { sid: 'good_1' },
      sessions: { good_1: true, 'a/b': true, '..': true, '': true, 'a.b': true, '日本語': true },
    } }, sessions: { good_1: { owner: 'target' } },
  });
  await createRepo(net, 'admin').deleteTeacher('target');
  assert.deepEqual(calls.filter(([op, path]) => op === 'get' && path.startsWith('sessions/')), [
    ['get', 'sessions/good_1/owner'],
  ]);
  const updates = calls.filter(([op]) => op === 'update');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0][2], {
    'sessions/good_1': null, 'teachers/target': null, 'teacherDirectory/target': null,
    'teacherRequests/target': null, 'teacherList/target': null,
  });
});

for (const sid of [42, 'a/b', '', '..']) {
  test(`不正な active.sid（${JSON.stringify(sid)}）を削除のパスに含めない`, async () => {
    const { net, calls } = recordedNet({ teacherList: { target: false }, teachers: { target: { active: { sid } } } });
    await createRepo(net, 'admin').deleteTeacher('target');
    assert.equal(calls.some(([op, path]) => op === 'get' && path.startsWith('sessions/')), false);
    assert.deepEqual(calls.find(([op]) => op === 'update')[2], {
      'teachers/target': null, 'teacherDirectory/target': null, 'teacherRequests/target': null, 'teacherList/target': null,
    });
  });
}

test('削除は何百件の授業も 1 回の update にまとめる', async () => {
  const history = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`s_${i}`, { title: '授業' }]));
  const sessions = Object.fromEntries(Object.keys(history).map((sid) => [sid, { owner: 'target' }]));
  const { net, calls } = recordedNet({ teacherList: { target: false }, teachers: { target: { history } }, sessions });
  await createRepo(net, 'admin').deleteTeacher('target');
  const updates = calls.filter(([op]) => op === 'update');
  assert.equal(updates.length, 1);
  assert.equal(Object.keys(updates[0][2]).length, 504);
  for (const sid of Object.keys(history)) assert.equal(updates[0][2][`sessions/${sid}`], null);
});

test('履歴と索引の 20 件の授業の owner は同時に 6 件まで読み、全部確かめてから 1 回だけ削除する', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `s_${i}`);
  const history = Object.fromEntries(ids.slice(0, 10).map((sid) => [sid, true]));
  const index = Object.fromEntries(ids.map((sid) => [sid, true]));
  const sessions = Object.fromEntries(ids.map((sid) => [sid, { owner: 'target' }]));
  const { net, calls } = recordedNet({ teacherList: { target: false }, teachers: { target: { history, sessions: index } }, sessions });
  const get = net.get;
  const update = net.update;
  let pending = 0;
  let maximum = 0;
  let completed = 0;
  net.get = async (path) => {
    if (!path.startsWith('sessions/')) return get(path);
    pending += 1;
    maximum = Math.max(maximum, pending);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await get(path);
    } finally {
      pending -= 1;
      completed += 1;
    }
  };
  net.update = async (...args) => {
    assert.equal(pending, 0);
    assert.equal(completed, 20);
    return update(...args);
  };
  await createRepo(net, 'admin').deleteTeacher('target');
  assert.equal(maximum, 6);
  assert.deepEqual(calls.filter(([op, path]) => op === 'get' && path.startsWith('sessions/')),
    ids.map((sid) => ['get', `sessions/${sid}/owner`]));
  assert.deepEqual(calls.filter(([op]) => op === 'update'), [['update', '', {
    ...Object.fromEntries(ids.map((sid) => [`sessions/${sid}`, null])),
    'teachers/target': null, 'teacherDirectory/target': null, 'teacherRequests/target': null, 'teacherList/target': null,
  }]]);
});

for (const code of ['denied', 'network']) {
  test(`owner の 2 組目の読み取りが ${code} でも、途中まで削除せず同じ例外を返す`, async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `s_${i}`);
    const history = Object.fromEntries(ids.map((sid) => [sid, true]));
    const sessions = Object.fromEntries(ids.map((sid) => [sid, { owner: 'target' }]));
    const { net, calls } = recordedNet({ teacherList: { target: false }, teachers: { target: { history } }, sessions });
    const before = net.dump();
    const get = net.get;
    const error = new NetError(code);
    net.get = async (path) => {
      if (path === 'sessions/s_7/owner') throw error;
      return get(path);
    };
    await assert.rejects(createRepo(net, 'admin').deleteTeacher('target'), (e) => e === error);
    assert.equal(calls.filter(([op, path]) => op === 'get' && path.startsWith('sessions/')).length, 7);
    assert.equal(calls.some(([op]) => ['set', 'update', 'remove'].includes(op)), false);
    assert.deepEqual(net.dump(), before);
  });
}

test('管理画面: 削除は停止中の他の先生だけに表示する（自分は停止中でも出さない）', async () => {
  for (const selfActive of [true, false]) {
    const h = viewHarness('teachers', { auth: authFor(), repo: {
      isAdmin: async () => true, listRequests: async () => [],
      listTeachers: async () => [
        { uid: 'self', active: selfActive }, { uid: 'active', active: true },
        { uid: 'missing', active: null }, { uid: 'suspended', active: false },
      ],
    } });
    await settle();
    const cards = h.nodes().filter((n) => n.tag === 'li');
    const hasDelete = (card) => card.children.some((n) => n.children.some((b) => b.textContent === '削除'));
    assert.deepEqual(cards.map(hasDelete), [false, false, false, true]);
    assert.equal(h.find('削除').class, 'btn teacher-danger');
  }
});

test('管理画面: 削除の確認文・危険色と二重送信防止。成功したら通知して一覧を読み直す', async () => {
  let confirm;
  let finish;
  let writes = 0;
  let reads = 0;
  const h = viewHarness('teachers', { auth: authFor(), repo: {
    isAdmin: async () => true, listRequests: async () => [],
    listTeachers: async () => { reads += 1; return writes ? [] : [{ uid: 'target', email: 'target@example.com', active: false }]; },
    deleteTeacher: async (uid) => {
      assert.equal(uid, 'target');
      writes += 1;
      await new Promise((r) => { finish = r; });
    },
  } }, () => new Promise((r) => { confirm = r; }));
  await settle();
  const pending = h.click('削除');
  await h.click('削除');
  assert.equal(writes, 0);
  assert.equal(h.dialogs.length, 1);
  const dialog = h.dialogs[0];
  assert.equal(dialog.title, 'target@example.comを削除しますか？');
  assert.equal(dialog.body, 'この先生の教材・授業の記録・設定が、すべて消えます。元に戻せません。ログインのためのアカウント（Firebase の Authentication）は、この画面では消えません。');
  assert.equal(dialog.okLabel, '削除する');
  assert.equal(dialog.cancelLabel, 'やめる');
  assert.equal(dialog.danger, true);
  assert.ok(h.nodes().filter((n) => n.tag === 'button').every((n) => n.disabled));
  confirm(true);
  await settle();
  await h.click('削除');
  assert.equal(writes, 1);
  assert.equal(h.find('削除').disabled, true);
  finish();
  await pending;
  assert.equal(reads, 2);
  assert.deepEqual(h.toasts, ['削除しました。']);
  assert.equal(h.find('target@example.com'), undefined);
});

test('管理画面: 削除の確認でやめると通信せず、ボタンが戻る', async () => {
  const { net, calls } = recordedNet({ admins: { self: true }, teacherList: { target: false } });
  const h = viewHarness('teachers', { auth: authFor(), repo: createRepo(net, 'self') }, async () => false);
  await settle();
  calls.length = 0;
  await h.click('削除');
  assert.deepEqual(calls, []);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.find('削除').disabled, false);
});

for (const code of ['denied', 'network']) {
  for (const [op, path] of [
    ['get', 'teacherList/target'], ['getKeys', 'teachers/target/history'], ['get', 'teachers/target/active'],
    ['getKeys', 'teachers/target/sessions'],
    ['get', 'sessions/s1/owner'], ['get', 'sessions/s2/owner'], ['get', 'sessions/s3/owner'], ['update', ''],
  ]) {
    test(`削除の ${op}（${path || 'ルート'}）が ${code}: 例外を伝え、画面に 2 文を出して再試行できる`, async () => {
      const { net, calls } = recordedNet({
        admins: { self: true }, teacherList: { target: false },
        teachers: { target: { history: { s1: { title: '授業' } }, active: { sid: 's2' }, sessions: { s3: true } } },
        sessions: { s1: { owner: 'target' }, s2: { owner: 'target' }, s3: { owner: 'target' } },
      });
      const before = net.dump();
      const repo = createRepo(net, 'self');
      const h = viewHarness('teachers', { auth: authFor(), repo });
      await settle();
      const original = net[op];
      const error = new NetError(code);
      net[op] = async (...args) => { if (args[0] === path) throw error; return original(...args); };
      calls.length = 0;
      await assert.rejects(repo.deleteTeacher('target'), (e) => e === error);
      await h.click('削除');
      assert.deepEqual(net.dump(), before);
      assert.equal(calls.some(([operation]) => ['set', 'update', 'remove'].includes(operation)), false);
      assert.ok(h.find('削除できませんでした。接続を確かめて、もう一度押してください。何度も失敗するときは、Firebase のルールが新しいものになっているか確かめてください。'));
      assert.deepEqual(h.toasts, []);
      assert.equal(h.find('削除').disabled, false);
      assert.equal(h.find('再開').disabled, false);
      net[op] = original;
      await h.click('削除');
      assert.deepEqual(h.toasts, ['削除しました。']);
      assert.equal(h.find('削除'), undefined);
    });
  }
}

test('管理画面: 確認中に再開された先生は消さず、削除失敗を表示する', async () => {
  const { net, calls } = recordedNet({ admins: { self: true }, teacherList: { target: false } });
  const h = viewHarness('teachers', { auth: authFor(), repo: createRepo(net, 'self') }, async () => {
    await net.set('teacherList/target', true);
    return true;
  });
  await settle();
  await h.click('削除');
  assert.equal(await net.get('teacherList/target'), true);
  assert.equal(calls.some(([op]) => op === 'update'), false);
  assert.match(h.text(), /削除できませんでした。/);
});

for (const leave of ['画面を離れる', 'ログアウト']) {
  for (const failed of [false, true]) {
    test(`削除中に${leave}: 遅い${failed ? '失敗' : '成功'}を表示しない`, async () => {
      const auth = authFor();
      let finish;
      let reads = 0;
      const h = viewHarness('teachers', { auth, repo: {
        isAdmin: async () => true, listRequests: async () => [],
        listTeachers: async () => { reads += 1; return [{ uid: 'target', active: false }]; },
        deleteTeacher: () => new Promise((resolve, reject) => { finish = () => failed ? reject(new NetError('network')) : resolve(); }),
      } });
      await settle();
      const pending = h.click('削除');
      await settle();
      if (leave === '画面を離れる') h.cleanup(); else auth.signOut();
      finish();
      await pending;
      assert.deepEqual(h.toasts, []);
      assert.equal(reads, 1);
      assert.doesNotMatch(h.text(), /削除できませんでした/);
    });
  }
}
