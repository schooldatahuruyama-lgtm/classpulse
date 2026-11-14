import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoBackend, isDemoAllowed } from '../js/dev/demo.js';
import { createRepo } from '../js/repo.js';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { fakeStorage } from './helpers/fakes.js';

test('練習用の先生は管理者。既存のデータにも足され、消去後も残る', async () => {
  const storage = fakeStorage();
  storage.setItem('classpulse:demo:db', JSON.stringify({ teacherList: { 'demo-teacher': true }, keep: 1 }));
  const d = make(storage, null);
  assert.equal(await createRepo(d.net, 'demo-teacher').isAdmin(), true);
  assert.equal(await d.net.get('keep'), 1);
  d.net.clear();
  assert.equal(await createRepo(d.net, 'demo-teacher').isAdmin(), true);
});

test('練習モードの登録とログイン: メールごとに uid が決まり、パスワードを保存しない', async () => {
  const storage = fakeStorage();
  const d = make(storage, null);
  const a = await d.teacherAuth.signUpTeacher('new@example.com', 'fake-signup-pass');
  const b = await d.teacherAuth.signUpTeacher('other@example.com', 'fake-other-pass');
  assert.notEqual(a.uid, b.uid);
  assert.notEqual(a.uid, 'demo-teacher');
  const saved = storage.getItem('classpulse:demo:teacher');
  assert.doesNotMatch(saved, /password|fake-signup-pass|fake-other-pass/);
  assert.deepEqual(JSON.parse(saved), b);
  d.teacherAuth.signOut();
  assert.deepEqual(await make(storage, null).teacherAuth.signInTeacher('new@example.com'), a);
  assert.equal(await createRepo(d.net, a.uid).teacherStatus(), 'none');
  assert.equal(await createRepo(d.net, a.uid).isAdmin(), false);
  await assert.rejects(d.studentAuth.signUpTeacher('new@example.com', 'fake-signup-pass'), { code: 'unknown' });
});

test('練習モードで申しこみ・ことわる・再申請・承認・停止・再開を試せる', async () => {
  const d = make(fakeStorage(), null);
  const user = await d.teacherAuth.signUpTeacher('new@example.com', 'fake-signup-pass');
  const repo = createRepo(d.net, user.uid);
  await repo.requestAccess(user.email);
  d.teacherAuth.signOut();
  const admin = await d.teacherAuth.signInTeacher('a@b.c');
  const manage = createRepo(d.net, admin.uid);
  assert.equal(await manage.isAdmin(), true);
  assert.deepEqual(await manage.listRequests(), [{ uid: user.uid, email: user.email, at: 1000 }]);
  await manage.rejectRequest(user.uid);
  assert.equal(await repo.getMyRequest(), null);
  await d.teacherAuth.signInTeacher(user.email);
  await repo.requestAccess(user.email);
  await d.teacherAuth.signInTeacher('a@b.c');
  await manage.approveTeacher(user.uid, user.email, 2000);
  assert.equal(await repo.teacherStatus(), 'active');
  assert.equal(await repo.getMyRequest(), null);
  await manage.setTeacherActive(user.uid, false);
  assert.equal(await repo.teacherStatus(), 'suspended');
  await manage.setTeacherActive(user.uid, true);
  assert.equal(await repo.teacherStatus(), 'active');
  assert.deepEqual(await d.teacherAuth.signInTeacher(user.email), user);
});

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

test('練習用 getKeys はその場所の子の鍵だけを返し、空・値だけなら空の配列', async () => {
  const { net } = make(fakeStorage(), null);
  await net.set('teachers/t/history', { s1: { title: '授業 1' }, s2: { title: '授業 2' } });
  assert.deepEqual(await net.getKeys('teachers/t/history'), ['s1', 's2']);
  const keys = await net.getKeys('teachers/t/history');
  keys.push('extra');
  assert.deepEqual(await net.getKeys('teachers/t/history'), ['s1', 's2']);
  for (const value of [null, false, true, 42, 'broken', {}, []]) {
    await net.set('empty', value);
    assert.deepEqual(await net.getKeys('empty'), []);
  }
  await net.set('sparse', { 0: true, 2: true });
  assert.deepEqual(await net.getKeys('sparse'), ['0', '2']);
  assert.deepEqual(await net.getKeys('missing'), []);
});

test('練習用 getKeys も読み取りの拒否・通信失敗を返す', async () => {
  const denied = createMemoryNet({ deny: (op, path) => op === 'get' && path === 'teachers/t/history' });
  await assert.rejects(denied.getKeys('teachers/t/history'), { code: 'denied' });
  const offline = createMemoryNet();
  offline.setOnline(false);
  await assert.rejects(offline.getKeys('teachers/t/history'), { code: 'network' });
});

test('練習モードで登録・承認・停止・削除すると、授業と名簿が消え、同じアカウントで再申請できる', async () => {
  const d = make(fakeStorage(), null);
  const user = await d.teacherAuth.signUpTeacher('delete-test@example.com', 'fake-signup-pass');
  const repo = createRepo(d.net, user.uid);
  await repo.requestAccess(user.email);
  const admin = await d.teacherAuth.signInTeacher('a@b.c');
  const manage = createRepo(d.net, admin.uid);
  await manage.approveTeacher(user.uid, user.email, 2000);
  await d.net.set(`teachers/${user.uid}`, {
    decks: { d1: { title: '削除用の教材' } }, history: { s1: { title: '授業' } }, active: { sid: 's2' },
  });
  for (const sid of ['s1', 's2']) await d.net.set(`sessions/${sid}`, { owner: user.uid });
  await manage.setTeacherActive(user.uid, false);
  await manage.deleteTeacher(user.uid);
  assert.equal((await manage.listTeachers()).some((t) => t.uid === user.uid), false);
  for (const path of [`teachers/${user.uid}`, `teacherDirectory/${user.uid}`, `teacherRequests/${user.uid}`, `teacherList/${user.uid}`, 'sessions/s1', 'sessions/s2']) {
    assert.equal(await d.net.get(path), null, path);
  }
  assert.deepEqual(await d.teacherAuth.signInTeacher(user.email), user);
  assert.equal(await repo.teacherStatus(), 'none');
  await repo.requestAccess(user.email);
  assert.deepEqual(await repo.getMyRequest(), { email: user.email, at: 1000 });
});

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

test('従来の練習用メールは同じ先生で、teacherList に登録済み', async () => {
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
    for (const m of ['signUpTeacher', 'signInTeacher', 'signInAnonymous', 'restore', 'getToken', 'forceRefresh', 'signOut']) {
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

// 非同期に届ける BroadcastChannel の代役（本物と同じく、届くのは書いたあと）
function asyncHub() {
  const all = new Set();
  const FakeBC = class {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) {
      for (const c of all) {
        if (c !== this && c.name === this.name) setTimeout(() => { if (c.onmessage) c.onmessage({ data }); }, 0);
      }
    }
    close() { all.delete(this); }
  };
  return FakeBC;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test('非同期の通知: A が x を書き、B が（受け取って）y を書くと、A の購読は y を受け取る', { timeout: 2000 }, async () => {
  const shared = fakeStorage();
  const BC = asyncHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  const seenA = [];
  let received;
  const delivered = new Promise((resolve) => { received = resolve; });
  a.net.subscribe('pub/results', (v) => {
    seenA.push(v);
    if (v?.s1?.n === 7) received();
  });
  b.net.subscribe('inbox/x', async (v) => { if (v === 1) await b.net.set('pub/results/s1', { n: 7 }); });
  await a.net.set('inbox/x', 1);
  // 全体テストの負荷で 30ms を超えても、往復の通知が届くまで待つ
  await delivered;
  assert.deepEqual(seenA[seenA.length - 1], { s1: { n: 7 } });
  assert.deepEqual(await a.net.get('pub/results/s1'), { n: 7 });
});

test('非同期の通知: 自分の書きこみの直後に届いた相手の 2 回の書きこみを、順に全部受け取る', async () => {
  const shared = fakeStorage();
  const BC = asyncHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  const seenA = [];
  a.net.subscribe('r', (v) => seenA.push(v));
  await b.net.set('r', 1);
  await a.net.set('own', 1); // B の通知が届く前の、A 自身の書きこみ
  await b.net.set('r', 2);
  await b.net.set('r', 3);
  await a.net.set('own', 2);
  await tick();
  assert.deepEqual(seenA.filter((v) => v !== null).filter((v, i, arr) => i === 0 || v !== arr[i - 1]), [1, 2, 3]);
  assert.equal(seenA[seenA.length - 1], 3);
});

test('非同期の通知: 3 つの backend で、互いの書きこみが全員の購読に届く', async () => {
  const shared = fakeStorage();
  const BC = asyncHub();
  const [a, b, c] = [make(shared, BC), make(shared, BC), make(shared, BC)];
  const last = { a: null, b: null, c: null };
  a.net.subscribe('k', (v) => { last.a = v; });
  b.net.subscribe('k', (v) => { last.b = v; });
  c.net.subscribe('k', (v) => { last.c = v; });
  await a.net.set('k/a', 1);
  await b.net.set('k/b', 2);
  await c.net.set('k/c', 3);
  await a.net.set('k/a2', 4);
  await tick();
  const want = { a: 1, b: 2, c: 3, a2: 4 };
  assert.deepEqual(last, { a: want, b: want, c: want });
});

test('同期的に届く通知: B の返信の書きこみが A 自身の通知より先に届いても、A は最後の値を受け取る', async () => {
  const shared = fakeStorage();
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  const seenA = [];
  a.net.subscribe('', (v) => seenA.push(v));
  b.net.subscribe('inbox/x', (v) => { if (v === 1) b.net.set('pub/y', 7); });
  await a.net.set('inbox/x', 1);
  assert.deepEqual(seenA[seenA.length - 1], { inbox: { x: 1 }, pub: { y: 7 }, teacherList: { 'demo-teacher': true }, admins: { 'demo-teacher': true } });
  assert.equal(await a.net.get('pub/y'), 7);
  assert.equal(JSON.parse(shared.getItem('classpulse:demo:db')).pub.y, 7);
});

test('かくしている質問の集計は pub に書けない（規則と同じ。公開と同時に書くのは通る。消すのは通る）', async () => {
  const d = make(fakeStorage(), fakeBroadcastHub());
  const { net } = d;
  const PUB = 'sessions/s1/pub';
  await net.set('sessions/s1', { owner: 't', pub: { state: 'live', polls: { p1: { status: 'open', resultsVisible: false }, p2: { status: 'open', resultsVisible: true } } } });
  const r = { counts: [1, 0], total: 1 };
  await assert.rejects(net.update(PUB, { 'results/p1': r }), { code: 'denied' });
  await assert.rejects(net.set(`${PUB}/results/p1`, r), { code: 'denied' });
  await assert.rejects(net.update('', { [`${PUB}/results/p1`]: r }), { code: 'denied' });
  assert.equal(await net.get(`${PUB}/results`), null);
  await net.update(PUB, { 'results/p2': r }); // 公開中の質問は書ける
  await net.update(PUB, { 'polls/p1/resultsVisible': true, 'results/p1': r }); // 公開と同時に書く
  assert.deepEqual(await net.get(`${PUB}/results/p1`), { counts: [1, 0], total: 1 });
  // かくすのと同時に集計を書くのは通らない。消すのは通る
  await assert.rejects(net.update(PUB, { 'polls/p1/resultsVisible': false, 'results/p1': r }), { code: 'denied' });
  await net.update(PUB, { 'polls/p1/resultsVisible': false, 'results/p1': null });
  assert.equal(await net.get(`${PUB}/results/p1`), null);
  await net.update(PUB, { state: 'ended', results: null });
  assert.equal(await net.get(`${PUB}/results`), null);
});

// 入る量に上限がある保存先（localStorage の容量不足の代役）。上限を超える setItem は例外を投げ、中身を変えない
function limitedStorage(limit) {
  const s = fakeStorage();
  const setItem = s.setItem;
  s.setItem = (k, v) => {
    if (String(v).length > limit) throw new Error('QuotaExceededError');
    setItem(k, v);
  };
  return s;
}

test('容量不足で保存できない書きこみは失敗になり、メモリも戻り、購読・ほかのタブに知らせない（set・update）', async () => {
  const shared = limitedStorage(400);
  const BC = fakeBroadcastHub();
  const a = make(shared, BC);
  const b = make(shared, BC);
  await a.net.set('decks/d1', { title: 'もと' });
  const seenA = [];
  const seenB = [];
  a.net.subscribe('decks', (v) => seenA.push(v));
  b.net.subscribe('decks', (v) => seenB.push(v));
  const before = shared.getItem('classpulse:demo:db');
  const big = 'x'.repeat(1000);

  const e1 = await a.net.set('decks/d2', { title: 'おおきい', img: big }).then(() => null, (e) => e);
  assert.equal(e1 && e1.name, 'NetError');
  assert.equal(e1.code, 'unknown');
  const e2 = await a.net.update('decks', { 'd1/title': 'かえた', 'd3/img': big }).then(() => null, (e) => e);
  assert.equal(e2 && e2.code, 'unknown');

  // メモリ・保存先とも、前のまま。購読（自分のタブ・ほかのタブ）には最初の値しか届いていない
  assert.deepEqual(await a.net.get('decks'), { d1: { title: 'もと' } });
  assert.equal(shared.getItem('classpulse:demo:db'), before);
  assert.deepEqual(seenA, [{ d1: { title: 'もと' } }]);
  assert.deepEqual(seenB, [{ d1: { title: 'もと' } }]);

  // 入る大きさの書きこみは、そのあともできて、保存される
  await a.net.update('decks', { 'd1/title': 'あたらしい' });
  assert.deepEqual(await a.net.get('decks'), { d1: { title: 'あたらしい' } });
  assert.deepEqual(JSON.parse(shared.getItem('classpulse:demo:db')).decks, { d1: { title: 'あたらしい' } });
  assert.deepEqual(seenA[seenA.length - 1], { d1: { title: 'あたらしい' } });
  assert.deepEqual(seenB[seenB.length - 1], { d1: { title: 'あたらしい' } });
  assert.deepEqual(await make(shared, BC).net.get('decks'), { d1: { title: 'あたらしい' } });
});

test('容量不足の書きこみの失敗は、BroadcastChannel が無いときも同じ', async () => {
  const shared = limitedStorage(400);
  const a = make(shared, null);
  await a.net.set('decks/d1', { title: 'もと' });
  const seen = [];
  a.net.subscribe('decks', (v) => seen.push(v));
  await assert.rejects(a.net.set('decks/d2', { img: 'x'.repeat(1000) }), { name: 'NetError', code: 'unknown' });
  assert.deepEqual(await a.net.get('decks'), { d1: { title: 'もと' } });
  assert.deepEqual(seen, [{ d1: { title: 'もと' } }]);
  await a.net.set('decks/d2', { title: 'ちいさい' });
  assert.deepEqual(JSON.parse(shared.getItem('classpulse:demo:db')).decks, { d1: { title: 'もと' }, d2: { title: 'ちいさい' } });
});
