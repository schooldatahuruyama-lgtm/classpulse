import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createRepo } from '../js/repo.js';
import { CONFIG } from '../js/config.js';
import { isDue, deleteDate, daysLeft, deleteNote, runTeacherCleanup } from '../js/teacher-cleanup.js';

const DAY = 86400000;
const NOW = new Date(2026, 11, 2, 12).getTime();
const OLD = NOW - 31 * DAY;
const invalid = [null, undefined, 'broken', String(OLD), -1, 0, NaN, Infinity, Number.MAX_VALUE, 8640000000000000, NOW + 1];
const suspended = (uid = 'target', at = OLD) => ({ uid, active: false, hasDirectory: true, suspendedAt: at });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(teachers = [suspended()], overrides = {}) {
  const calls = [];
  const repo = {
    isAdmin: async () => { calls.push(['admin']); return true; },
    listTeachers: async () => { calls.push(['list']); return teachers; },
    markSuspended: async (uid) => { calls.push(['mark', uid]); },
    clearSuspended: async (uid) => { calls.push(['clear', uid]); },
    serverNow: async () => { calls.push(['now']); return NOW; },
    deleteIfStillSuspended: async (uid, at) => { calls.push(['delete', uid, at]); return true; },
    ...overrides,
  };
  return { repo, calls, run: (options = {}) => runTeacherCleanup({ repo, uid: 'admin', days: 30, ...options }) };
}

function memory(initial = {}, options = {}) {
  const net = createMemoryNet({ now: () => NOW, initial: {
    admins: { admin: true }, teacherList: { target: false },
    teacherDirectory: { target: { email: 'target@example.com', approvedAt: 1, suspendedAt: OLD } },
    ...initial,
  }, ...options });
  const calls = [];
  for (const op of ['get', 'getKeys', 'set', 'update', 'remove']) {
    const original = net[op];
    net[op] = (...args) => { calls.push([op, ...args]); return original(...args); };
  }
  return { net, calls, repo: createRepo(net, 'admin') };
}

test('先生の削除日数は 30 日', () => assert.equal(CONFIG.teacher.deleteDays, 30));

for (const [elapsed, expected] of [[30 * DAY, true], [30 * DAY - 1, false], [31 * DAY, true]]) {
  test(`境界 ${elapsed} ミリ秒: 削除判定と実行が ${expected}`, async () => {
    const at = NOW - elapsed;
    assert.equal(isDue(at, NOW, 30), expected);
    const h = fixture([{ ...suspended(), suspendedAt: at }]);
    assert.deepEqual(await h.run(), { deleted: Number(expected) });
  });
}

for (const at of invalid) {
  test(`不正な停止日時 ${String(at)}: 表示せず、記録し直し、その回は消さない`, async () => {
    assert.equal(isDue(at, NOW, 30), false);
    assert.equal(daysLeft(at, NOW, 30), null);
    assert.equal(deleteNote(at, NOW, 30), null);
    const h = fixture([{ ...suspended(), suspendedAt: at }]);
    assert.deepEqual(await h.run(), { deleted: 0 });
    assert.deepEqual(h.calls.filter(([op]) => op === 'mark'), [['mark', 'target']]);
    assert.equal(h.calls.some(([op]) => op === 'delete'), false);
  });
}

for (const days of [0, -1, '1', 'bad', NaN, Infinity, Number.MAX_VALUE, null, undefined]) {
  test(`不正な日数 ${String(days)}: 30 日を使い、すぐには消さない`, async () => {
    assert.equal(isDue(NOW - DAY, NOW, days), false);
    assert.equal(isDue(NOW - 30 * DAY, NOW, days), true);
    assert.equal(deleteDate(NOW, days).getTime(), NOW + 30 * DAY);
    assert.equal(daysLeft(NOW - DAY, NOW, days), 29);
    const h = fixture([suspended('target', NOW - DAY)]);
    assert.deepEqual(await h.run({ days }), { deleted: 0 });
  });
}

test('表示: あと 12 日・今日（期限時刻の前）・期限切れ・記録なし', () => {
  const at = new Date(2026, 10, 14, 12).getTime();
  assert.equal(deleteNote(at, NOW, 30), '2026年12月14日に、自動で削除されます（あと 12 日）。');
  assert.equal(daysLeft(at, NOW - 1, 30), 13);
  const due = deleteDate(at, 30).getTime();
  assert.equal(deleteNote(at, due - 1, 30), 'まもなく自動で削除されます。');
  assert.equal(isDue(at, due - 1, 30), false);
  assert.equal(deleteNote(at, due, 30), 'まもなく自動で削除されます。');
  assert.equal(deleteNote(at, due + DAY, 30), 'まもなく自動で削除されます。');
  assert.equal(deleteNote(null, NOW, 30), null);
  assert.equal(deleteDate(null, 30), null);
});

test('自分・利用中・承認待ち・名簿なしは、記録も削除もしない', async () => {
  const h = fixture([
    suspended('admin', null), { ...suspended('active', null), active: true },
    { ...suspended('pending', null), active: null },
    { ...suspended('missing', null), hasDirectory: false },
    { ...suspended('missing-old'), hasDirectory: false },
  ]);
  assert.deepEqual(await h.run(), { deleted: 0 });
  assert.equal(h.calls.some(([op]) => ['mark', 'clear', 'delete'].includes(op)), false);
});

for (const fails of [false, true]) {
  test(`利用中に古い停止日時が残っていても消さず、日時を消す処理が${fails ? '失敗' : '成功'}しても次の先生を処理する`, async () => {
    const { net, repo, calls } = memory({
      teacherList: { active1: true, active2: true, due: false },
      teacherDirectory: Object.fromEntries(['active1', 'active2', 'due'].map((uid) => [uid, {
        email: `${uid}@example.com`, approvedAt: 1, suspendedAt: OLD,
      }])),
      teachers: { active1: { decks: { d: { title: '練習' } } } },
    }, { deny: (op, path) => fails && op === 'set' && path === 'teacherDirectory/active1/suspendedAt' });
    assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 1 });
    assert.deepEqual(calls.filter(([op, path]) => op === 'set' && path.startsWith('teacherDirectory/')), [
      ['set', 'teacherDirectory/active1/suspendedAt', null],
      ['set', 'teacherDirectory/active2/suspendedAt', null],
    ]);
    assert.equal(await net.get('teacherList/active1'), true);
    assert.equal(await net.get('teacherList/active2'), true);
    assert.equal(await net.get('teachers/active1/decks/d/title'), '練習');
    assert.equal(await net.get('teacherDirectory/active1/suspendedAt'), fails ? OLD : null);
    assert.equal(await net.get('teacherDirectory/active2/suspendedAt'), null);
    assert.equal(await net.get('teacherList/due'), null);
  });
}

test('手順: 管理者・一覧・記録なしの補記・サーバー時刻・未来の補記・削除', async () => {
  const h = fixture([suspended('missing', null), suspended('future', NOW + DAY), suspended('due')]);
  assert.deepEqual(await h.run(), { deleted: 1 });
  assert.deepEqual(h.calls, [['admin'], ['list'], ['mark', 'missing'], ['now'], ['mark', 'future'], ['delete', 'due', OLD]]);
});

test('管理者でなければ、名簿・時刻の読みこみと書きこみをしない', async () => {
  const h = fixture([], { isAdmin: async () => false });
  assert.deepEqual(await h.run(), { deleted: 0 });
  assert.deepEqual(h.calls, []);
});

for (const failed of ['isAdmin', 'listTeachers', 'serverNow', 'markSuspended']) {
  test(`${failed} の失敗: 例外を出さず誰も消さず、次回は実行できる`, async () => {
    const h = fixture([suspended('due'), suspended('missing', null)]);
    const original = h.repo[failed];
    h.repo[failed] = async () => { throw new Error('test failure'); };
    assert.deepEqual(await h.run(), { deleted: 0 });
    assert.equal(h.calls.some(([op]) => op === 'delete'), false);
    h.repo[failed] = original;
    assert.deepEqual(await h.run(), { deleted: 1 });
  });
}

test('未来の記録を直せないときも、ほかの期限切れを消さない', async () => {
  const h = fixture([suspended('due'), suspended('future', NOW + 1)], {
    markSuspended: async () => { throw new Error('old rules'); },
  });
  assert.deepEqual(await h.run(), { deleted: 0 });
  assert.equal(h.calls.some(([op]) => op === 'delete'), false);
});

for (const now of [null, '123', NaN, Infinity, -1, 0, Number.MAX_VALUE]) {
  test(`サーバー時刻が不正 ${String(now)}: 消さない`, async () => {
    const h = fixture([suspended()], { serverNow: async () => now });
    assert.deepEqual(await h.run(), { deleted: 0 });
    assert.equal(h.calls.some(([op]) => op === 'delete'), false);
  });
}

test('1 人目が失敗しても 2 人目を消し、deleted: 1 を返す', async () => {
  const seen = [];
  const h = fixture([suspended('a'), suspended('b')], { deleteIfStillSuspended: async (uid) => {
    seen.push(uid);
    if (uid === 'a') throw new Error('test failure');
    return true;
  } });
  assert.deepEqual(await h.run(), { deleted: 1 });
  assert.deepEqual(seen, ['a', 'b']);
});

test('10 人を 1 人ずつ消し終わってから合計を返す', async () => {
  let inFlight = 0;
  const h = fixture(Array.from({ length: 10 }, (_, i) => suspended(`t${i}`)), { deleteIfStillSuspended: async () => {
    assert.equal(inFlight++, 0);
    await Promise.resolve();
    inFlight -= 1;
    return true;
  } });
  assert.deepEqual(await h.run(), { deleted: 10 });
});

test('同じ repo の前回が動いている間は始めず、終了後はまた始められる', async () => {
  const wait = deferred();
  const h = fixture([], { isAdmin: () => wait.promise });
  const first = h.run();
  assert.deepEqual(await h.run(), { deleted: 0 });
  assert.deepEqual(h.calls, []);
  wait.resolve(true);
  await first;
  await h.run();
  assert.equal(h.calls.filter(([op]) => op === 'list').length, 2);
});

test('画面を開き直して repo が別になっても、同じタブの前回が動いている間は始めない', async () => {
  const wait = deferred();
  const first = fixture([], { isAdmin: () => wait.promise });
  const next = fixture();
  const task = first.run();
  assert.deepEqual(await next.run(), { deleted: 0 });
  assert.deepEqual(next.calls, []);
  wait.resolve(true);
  await task;
  assert.deepEqual(await next.run(), { deleted: 1 });
});

for (const stage of ['isAdmin', 'listTeachers', 'markSuspended', 'clearSuspended', 'serverNow', 'deleteIfStillSuspended']) {
  test(`${stage} の待機中に離れたら、始めている 1 人以外は処理しない`, async () => {
    let current = true;
    const wait = deferred();
    const entered = deferred();
    const first = suspended('a', stage === 'markSuspended' ? null : OLD);
    if (stage === 'clearSuspended') first.active = true;
    const h = fixture([first, suspended('b')]);
    const original = h.repo[stage];
    h.repo[stage] = async (...args) => { entered.resolve(); await wait.promise; return original(...args); };
    const task = h.run({ current: () => current });
    await entered.promise;
    current = false;
    wait.resolve();
    const expected = stage === 'deleteIfStillSuspended' ? 1 : 0;
    assert.deepEqual(await task, { deleted: expected });
    assert.equal(h.calls.filter(([op]) => op === 'delete').length, expected);
  });
}

for (const active of [false, true]) {
  test(`${active ? '再開' : '停止'}: ルートへの 1 回の書きこみで状態とサーバー時刻を更新`, async () => {
    const { net, repo, calls } = memory();
    await repo.setTeacherActive('target', active);
    assert.deepEqual(calls, [['update', '', {
      'teacherList/target': active, 'teacherDirectory/target/suspendedAt': active ? null : { '.sv': 'timestamp' },
    }]]);
    assert.equal(await net.get('teacherDirectory/target/suspendedAt'), active ? null : NOW);
    assert.equal(await net.get('teacherDirectory/target/approvedAt'), 1);
  });
  for (const reason of ['denied', 'network']) {
    for (const bothFail of [false, true]) {
      test(`${active ? '再開' : '停止'} ${reason}: 時刻つき失敗後は旧方式を 1 回だけ${bothFail ? '試し、例外' : '試して成功'}`, async () => {
        const { net, repo, calls } = memory();
        const before = net.dump();
        net.update = async (...args) => { calls.push(['update', ...args]); throw new Error(reason); };
        if (bothFail) net.set = async (...args) => { calls.push(['set', ...args]); throw new Error(reason); };
        if (bothFail) await assert.rejects(repo.setTeacherActive('target', active), new RegExp(reason));
        else await repo.setTeacherActive('target', active);
        const marks = !bothFail && active === false;
        assert.deepEqual(calls.map(([op]) => op), marks ? ['update', 'set', 'set'] : ['update', 'set']);
        assert.deepEqual(calls[1], ['set', 'teacherList/target', active]);
        if (marks) {
          assert.deepEqual(calls[2], ['set', 'teacherDirectory/target/suspendedAt', { '.sv': 'timestamp' }]);
          assert.equal(await net.get('teacherDirectory/target/suspendedAt'), NOW);
        }
        if (bothFail) assert.deepEqual(net.dump(), before);
        else assert.equal(await net.get('teacherList/target'), active);
      });
    }
  }
}

for (const reason of ['denied', 'network']) {
  test(`停止の旧方式が成功したら、markSuspended が ${reason} でも例外にしない`, async () => {
    const { net, repo, calls } = memory({ teacherList: { target: true } });
    const set = net.set;
    net.update = async (...args) => { calls.push(['update', ...args]); throw new Error(reason); };
    net.set = async (...args) => {
      if (args[0] === 'teacherDirectory/target/suspendedAt') {
        calls.push(['set', ...args]); throw new Error(reason);
      }
      return set(...args);
    };
    await assert.doesNotReject(repo.setTeacherActive('target', false));
    assert.deepEqual(calls.map(([op]) => op), ['update', 'set', 'set']);
    assert.deepEqual(calls[2], ['set', 'teacherDirectory/target/suspendedAt', { '.sv': 'timestamp' }]);
    assert.equal(await net.get('teacherList/target'), false);
    assert.equal(await net.get('teacherDirectory/target/suspendedAt'), OLD);
    // 新しい規則では状態だけの書きこみが拒否される。この不正な状態の防止は rules.test.js で確かめる。
  });
}

test('自分の利用状態は、どちらの書きこみもせず例外', async () => {
  const { repo, calls } = memory();
  await assert.rejects(repo.setTeacherActive('admin', false), /自分自身/);
  await assert.rejects(repo.setTeacherActive('admin', true), /自分自身/);
  assert.deepEqual(calls, []);
});

for (const at of [...invalid, OLD]) {
  test(`一覧の日時 ${String(at)}: 正の有限数だけを保持する`, async () => {
    const { repo } = memory({ teacherDirectory: { target: { email: '', approvedAt: 1, suspendedAt: at } } });
    const [teacher] = await repo.listTeachers();
    assert.equal(teacher.suspendedAt, typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null);
    assert.equal(teacher.hasDirectory, true);
  });
}

test('名簿に行がない停止中と名簿だけの承認待ちは、書きこみも削除もしない', async () => {
  const { repo, calls } = memory({ teacherDirectory: { pending: { email: 'pending@example.com', approvedAt: 1 } } });
  const list = await repo.listTeachers();
  assert.equal(list.length, 1);
  assert.equal(list[0].hasDirectory, false);
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin', days: 30 }), { deleted: 0 });
  assert.equal(calls.some(([op, path]) => op === 'update' || (op === 'set' && path.startsWith('teacherDirectory/'))), false);
});

test('serverNow は自分の check に .sv を書いてから読み、練習用の時刻を返す', async () => {
  const { net, repo, calls } = memory();
  assert.equal(await repo.serverNow(), NOW);
  assert.deepEqual(calls, [['set', 'check/admin', { '.sv': 'timestamp' }], ['get', 'check/admin']]);
  assert.equal(net.dump().check.admin, NOW);
});

for (const value of ['123', null, { '.sv': 'timestamp' }, NaN, Infinity]) {
  test(`serverNow が数値でない ${String(value)}: 例外`, async () => {
    const repo = createRepo({ set: async () => {}, serverTimestamp: () => ({ '.sv': 'timestamp' }), get: async () => value }, 'admin');
    await assert.rejects(repo.serverNow(), /サーバーの時刻/);
  });
}

test('markSuspended は停止日時だけをサーバー時刻で書き、名簿のほかの値を残す', async () => {
  const { net, repo, calls } = memory();
  await repo.markSuspended('target');
  assert.deepEqual(calls, [['set', 'teacherDirectory/target/suspendedAt', { '.sv': 'timestamp' }]]);
  assert.deepEqual(net.dump().teacherDirectory.target, { email: 'target@example.com', approvedAt: 1, suspendedAt: NOW });
});

test('clearSuspended は停止日時だけを消し、利用状態と名簿のほかの値を残す', async () => {
  const { net, repo, calls } = memory({ teacherList: { target: true } });
  await repo.clearSuspended('target');
  assert.deepEqual(calls, [['set', 'teacherDirectory/target/suspendedAt', null]]);
  assert.deepEqual(net.dump().teacherDirectory.target, { email: 'target@example.com', approvedAt: 1 });
  assert.equal(await net.get('teacherList/target'), true);
});

for (const state of ['resumed', 'restopped', 'missing', 'self']) {
  test(`消す前に再確認: ${state} は false で何も書かない`, async () => {
    const { net, repo, calls } = memory();
    if (state === 'resumed') await net.set('teacherList/target', true);
    if (state === 'restopped') await net.set('teacherDirectory/target/suspendedAt', NOW);
    if (state === 'missing') await net.remove('teacherList/target');
    if (state === 'resumed') assert.equal(await net.get('teacherDirectory/target/suspendedAt'), OLD);
    calls.length = 0;
    assert.equal(await repo.deleteIfStillSuspended(state === 'self' ? 'admin' : 'target', OLD), false);
    assert.equal(calls.some(([op]) => ['set', 'update', 'remove'].includes(op)), false);
  });
}

test('同じ停止日時なら既存の deleteTeacher を呼び、消えた先生をもう一度は数えない', async () => {
  const { net, repo, calls } = memory({ teachers: { target: { decks: { d: { title: '練習' } } } } });
  assert.equal(await repo.deleteIfStillSuspended('target', OLD), true);
  assert.equal(await net.get('teachers/target'), null);
  assert.equal(await repo.deleteIfStillSuspended('target', OLD), false);
  assert.equal(calls.filter(([op]) => op === 'update').length, 1);
});

test('2 タブ・2 管理者: 片方が先に消したら、後の削除は false で人数に数えない', async () => {
  const { net, repo } = memory();
  const second = createRepo(net, 'admin2');
  const entered = deferred(), wait = deferred();
  const original = repo.deleteTeacher;
  repo.deleteTeacher = async (uid) => { entered.resolve(); await wait.promise; return original.call(repo, uid); };
  const task = repo.deleteIfStillSuspended('target', OLD);
  await entered.promise;
  assert.equal(await second.deleteIfStillSuspended('target', OLD), true);
  wait.resolve();
  assert.equal(await task, false);
});

test('実際の repo でも 1 人目の削除失敗後に 2 人目を消す', async () => {
  const { net, repo } = memory({
    teacherList: { a: false, b: false },
    teacherDirectory: Object.fromEntries(['a', 'b'].map((uid) => [uid, { email: `${uid}@example.com`, approvedAt: 1, suspendedAt: OLD }])),
  }, { deny: (op, path) => op === 'get' && path === 'teachers/a/history' });
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 1 });
  assert.equal(await net.get('teacherList/a'), false);
  assert.equal(await net.get('teacherList/b'), null);
});

test('練習用通信: 停止・再開・止め直しから 30 日。端末でなく通信の時計で判定する', async () => {
  let now = NOW;
  const { net, repo } = memory({}, { now: () => now });
  await repo.setTeacherActive('target', false);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), NOW);
  now += 20 * DAY;
  await repo.setTeacherActive('target', true);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), null);
  await repo.setTeacherActive('target', false);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), now);
  now += 30 * DAY - 1;
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 0 });
  now += 1;
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 1 });
  assert.equal(await repo.teacherStatus(), 'none');
  assert.equal(await createRepo(net, 'target').teacherStatus(), 'none');
});

test('再開と止め直しの時刻つき書きこみが失敗しても、補記で時刻が新しくなり直後に消えない', async () => {
  let now = OLD;
  const { net, repo, calls } = memory({ teacherList: { target: true } }, { now: () => now });
  await repo.setTeacherActive('target', false);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), OLD);
  now = NOW;
  const update = net.update;
  net.update = async (path, patch) => {
    if (typeof patch['teacherList/target'] === 'boolean') {
      calls.push(['update', path, patch]); throw new Error('denied');
    }
    return update(path, patch);
  };
  await repo.setTeacherActive('target', true);
  assert.equal(await net.get('teacherList/target'), true);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), OLD);
  await repo.setTeacherActive('target', false);
  assert.equal(await net.get('teacherList/target'), false);
  assert.equal(await net.get('teacherDirectory/target/suspendedAt'), NOW);
  assert.equal(calls.filter(([op, path]) => op === 'set' && path === 'teacherDirectory/target/suspendedAt').length, 1);
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 0 });
  assert.equal(await net.get('teacherList/target'), false);
  now += 30 * DAY - 1;
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 0 });
  now += 1;
  assert.deepEqual(await runTeacherCleanup({ repo, uid: 'admin' }), { deleted: 1 });
});
