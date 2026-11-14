import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createMemoryNet } from '../js/dev/memory-net.js';
import { createRepo } from '../js/repo.js';
import { CONFIG } from '../js/config.js';
import { isStillUser } from '../js/guard.js';
import { deleteNote, runTeacherCleanup } from '../js/teacher-cleanup.js';

const DAY = 86400000;
const NOW = new Date(2026, 11, 2, 12).getTime();
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// 本物の画面の処理と自動削除を動かす。DOM・確認・通知・端末の時計だけを代役にする。
function view(name, repo) {
  const all = (n) => [n, ...(n.children || []).flatMap(all)];
  const el = (tag, props = {}, ...children) => ({
    tag, ...props, textContent: props.text || '', children: children.flat(Infinity).filter(Boolean),
    replaceChildren(...items) { this.children = items.flat(Infinity).filter(Boolean); },
    querySelectorAll() { return all(this).filter((n) => n.tag === 'button'); },
    addEventListener() {},
  });
  const root = el('root');
  const auth = { user: { uid: 'admin', email: 'admin@example.com' } };
  const toasts = [], dialogs = [], tasks = [];
  const sandbox = {
    el, CONFIG, isStillUser, deleteNote, closeAllDialogs: () => {},
    Date: class extends Date { static now() { return NOW; } },
    toast: (message) => toasts.push(message),
    confirmDialog: async (options) => { dialogs.push(options); return true; },
    runTeacherCleanup: (options) => { const task = runTeacherCleanup(options); tasks.push(task); return task; },
  };
  const source = readFileSync(new URL(`../js/views/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?$/gm, '').replace('export function mount', 'function mount');
  runInNewContext(source, sandbox);
  const cleanup = sandbox.mount(root, { auth, repo });
  return {
    auth, root, toasts, dialogs, tasks, cleanup,
    text: () => all(root).map((n) => n.textContent).join('\n'),
    click: (label) => {
      const button = all(root).find((n) => n.tag === 'button' && n.textContent === label);
      assert.ok(button, label);
      return button.onclick();
    },
  };
}

function fixture(count = 1, at = NOW - 31 * DAY, options = {}) {
  const teacherList = { admin: true }, teacherDirectory = {};
  for (let i = 0; i < count; i++) {
    const uid = `target${i}`;
    teacherList[uid] = false;
    teacherDirectory[uid] = { email: `${uid}@example.com`, approvedAt: 1, suspendedAt: at };
  }
  const net = createMemoryNet({ now: () => NOW, initial: { admins: { admin: true }, teacherList, teacherDirectory }, ...options });
  const repo = createRepo(net, 'admin');
  let reads = 0;
  const original = repo.listTeachers;
  repo.listTeachers = () => { reads += 1; return original.call(repo); };
  return { net, repo, reads: () => reads };
}

for (const name of ['teachers', 'dashboard']) {
  for (const count of [0, 1, 10]) {
    test(`${name}: ${count} 人を消したときの通知は ${count ? '人数を 1 回だけ' : 'なし'}`, async () => {
      const f = fixture(count);
      const h = view(name, f.repo);
      await settle();
      assert.equal(h.tasks.length, 1);
      assert.deepEqual(h.toasts, count ? [`利用停止から 30 日たった先生 ${count} 人を、削除しました。`] : []);
      assert.equal(f.reads(), name === 'teachers' ? 2 + Number(count > 0) : 1);
      if (name === 'teachers') assert.doesNotMatch(h.text(), /target\d+@example.com/);
      for (let i = 0; i < count; i++) assert.equal(await f.net.get(`teacherList/target${i}`), null);
      h.cleanup();
    });
  }

  test(`${name}: 自動削除を待たずに画面を表示する`, async () => {
    const f = fixture(), wait = deferred();
    f.repo.serverNow = () => wait.promise;
    const h = view(name, f.repo);
    await settle();
    assert.match(h.text(), name === 'teachers' ? /target0@example.com/ : /まだ教材がありません/);
    assert.doesNotMatch(h.text(), /読みこんでいます/);
    assert.deepEqual(h.toasts, []);
    wait.resolve(NOW);
    await settle();
    assert.equal(h.toasts.length, 1);
    h.cleanup();
  });

  for (const failed of ['serverNow', 'deleteIfStillSuspended', 'markSuspended']) {
    test(`${name}: ${failed} の失敗は画面に出さない`, async () => {
      const f = fixture(1, failed === 'markSuspended' ? null : NOW - 31 * DAY);
      f.repo[failed] = async () => { throw new Error('test failure'); };
      const h = view(name, f.repo);
      await settle();
      assert.deepEqual(h.toasts, []);
      assert.doesNotMatch(h.text(), /できませんでした|読みこめませんでした|test failure/);
      assert.equal(await f.net.get('teacherList/target0'), false);
      h.cleanup();
    });
  }

  for (const leave of ['画面移動', 'ログアウト', '別の人へ変更']) {
    for (const fails of [false, true]) {
      test(`${name}: 削除中に${leave}したら、残りをやめ、${fails ? '失敗' : '成功'}も表示しない`, async () => {
        const f = fixture(2), wait = deferred(), entered = deferred();
        const original = f.repo.deleteIfStillSuspended;
        const deleted = [];
        f.repo.deleteIfStillSuspended = async (...args) => {
          deleted.push(args[0]); entered.resolve(); await wait.promise;
          if (fails) throw new Error('test failure');
          return original.apply(f.repo, args);
        };
        const h = view(name, f.repo);
        await entered.promise;
        const reads = f.reads();
        if (leave === '画面移動') h.cleanup();
        else h.auth.user = leave === 'ログアウト' ? null : { uid: 'other' };
        wait.resolve();
        await settle();
        assert.deepEqual(deleted, ['target0']);
        assert.deepEqual(h.toasts, []);
        assert.equal(f.reads(), reads);
        assert.doesNotMatch(h.text(), /できませんでした|test failure/);
        assert.equal(await f.net.get('teacherList/target1'), false);
        h.cleanup();
      });
    }
  }

  test(`${name}: 同じ repo で開き直しても前回の実行中は始めず、離れた画面には通知しない`, async () => {
    const f = fixture(2), wait = deferred(), entered = deferred();
    const original = f.repo.deleteIfStillSuspended;
    let deletes = 0;
    f.repo.deleteIfStillSuspended = async (...args) => {
      deletes += 1; entered.resolve(); await wait.promise;
      return original.apply(f.repo, args);
    };
    const first = view(name, f.repo);
    await entered.promise;
    first.cleanup();
    const second = view(name, f.repo);
    assert.deepEqual(await second.tasks[0], { deleted: 0 });
    wait.resolve();
    await settle();
    assert.equal(deletes, 1);
    assert.deepEqual(first.toasts, []);
    assert.deepEqual(second.toasts, []);
    second.cleanup();
  });
}

test('ホーム: 管理者でなければ先生の一覧は読まず、削除も通知もしない', async () => {
  const f = fixture();
  await f.net.set('admins/admin', false);
  const h = view('dashboard', f.repo);
  await settle();
  assert.equal(f.reads(), 0);
  assert.deepEqual(h.toasts, []);
  assert.equal(await f.net.get('teacherList/target0'), false);
  h.cleanup();
});

for (const [at, expected] of [
  [NOW - 18 * DAY, '2026年12月14日に、自動で削除されます（あと 12 日）。'],
  [NOW - 30 * DAY + 1, 'まもなく自動で削除されます。'],
  [NOW - 31 * DAY, 'まもなく自動で削除されます。'],
  [null, null],
]) {
  test(`管理画面: カードに ${expected || '記録なしなら文を出さない'}`, async () => {
    const f = fixture(1, at);
    f.repo.deleteIfStillSuspended = async () => false;
    const h = view('teachers', f.repo);
    await settle();
    if (expected) assert.ok(h.text().includes(expected));
    else assert.doesNotMatch(h.text(), /自動で削除/);
    h.cleanup();
  });
}

test('管理画面: 停止の確認文と日付、再開すると日付が消える', async () => {
  const f = fixture(1, null);
  await f.net.set('teacherList/target0', true);
  const h = view('teachers', f.repo);
  await settle();
  assert.doesNotMatch(h.text(), /自動で削除/);
  await h.click('利用を停止');
  assert.equal(h.dialogs[0].body, 'この先生は ClassPulse を開けなくなります。止めてから 30 日たつと、この先生の教材と授業の記録は、自動で削除されます。それまでは「再開」で元に戻せます。');
  assert.match(h.text(), /2027年1月1日に、自動で削除されます（あと 30 日）。/);
  await h.click('再開');
  assert.doesNotMatch(h.text(), /自動で削除/);
  assert.equal(await f.net.get('teacherDirectory/target0/suspendedAt'), null);
  h.cleanup();
});

for (const active of [true, false]) {
  test(`管理画面: ${active ? '停止' : '再開'}の両方の書きこみが失敗したら今までの文を出す`, async () => {
    const f = fixture(1, NOW, { deny: (op, path) => op === 'update' || (op === 'set' && path === 'teacherList/target0') });
    if (active) f.net.applyRemote([['teacherList/target0', true]]);
    const h = view('teachers', f.repo);
    await settle();
    await h.click(active ? '利用を停止' : '再開');
    assert.ok(h.text().includes(`${active ? '利用を停止' : '再開'}できませんでした。接続を確かめて、もう一度押してください。`));
    assert.deepEqual(h.toasts, []);
    h.cleanup();
  });
}

test('管理画面: 自動削除用の一覧だけ失敗しても、表示済みの画面に失敗を出さない', async () => {
  const f = fixture();
  const original = f.repo.listTeachers;
  const requests = f.repo.listRequests;
  let display = false;
  f.repo.listRequests = () => { display = true; return requests.call(f.repo); };
  f.repo.listTeachers = () => {
    const displaying = display;
    display = false;
    return displaying ? original() : Promise.reject(new Error('test failure'));
  };
  const h = view('teachers', f.repo);
  await settle();
  assert.match(h.text(), /target0@example.com/);
  assert.doesNotMatch(h.text(), /読みこめませんでした/);
  assert.deepEqual(h.toasts, []);
  h.cleanup();
});

test('管理画面: 一覧の表示後は、自動削除後の再読みこみが失敗してもエラーの文を出さない', async () => {
  const f = fixture();
  const original = f.repo.listTeachers;
  let reads = 0;
  f.repo.listTeachers = () => {
    if (++reads === 3) return Promise.reject(new Error('test failure'));
    return original();
  };
  const h = view('teachers', f.repo);
  await settle();
  assert.equal(h.toasts.length, 1);
  assert.match(h.text(), /先生の一覧|target0@example.com/);
  assert.doesNotMatch(h.text(), /読みこんでいます/);
  assert.doesNotMatch(h.text(), /読みこめませんでした|test failure/);
  h.cleanup();
});

for (const reloadFails of [false, true]) {
  for (const firstFails of [false, true]) {
    test(`管理画面: 後続の一覧が先に${reloadFails ? '失敗' : '成功'}し、初回が遅れて${firstFails ? '失敗' : '成功'}しても読みこみ中に残らない`, async () => {
      const f = fixture(), first = deferred(), reload = deferred();
      const original = f.repo.listTeachers;
      const before = await original();
      const requests = f.repo.listRequests;
      let display = false, reads = 0;
      f.repo.listRequests = () => { display = true; return requests.call(f.repo); };
      f.repo.listTeachers = () => {
        const displaying = display;
        display = false;
        if (displaying) {
          reads += 1;
          if (reads === 1) return first.promise;
          if (reads === 2) return reload.promise;
        }
        return original();
      };
      const h = view('teachers', f.repo);
      await settle();
      assert.equal(reads, 2);
      assert.match(h.text(), /読みこんでいます/);
      const after = await original();
      if (reloadFails) reload.reject(new Error('test failure'));
      else reload.resolve(after);
      await settle();
      assert.doesNotMatch(h.text(), /読みこんでいます/);
      if (reloadFails) {
        assert.match(h.text(), /読みこめませんでした。接続を確かめて、もう一度押してください。/);
        assert.match(h.text(), /もう一度/);
      } else {
        assert.match(h.text(), /先生の一覧/);
        assert.doesNotMatch(h.text(), /target0@example.com|読みこめませんでした/);
      }
      const displayed = h.text();
      if (firstFails) first.reject(new Error('initial failure'));
      else first.resolve(before);
      await settle();
      assert.equal(h.text(), displayed);
      assert.doesNotMatch(h.text(), /test failure|initial failure/);
      if (reloadFails) {
        await h.click('もう一度');
        assert.match(h.text(), /先生の一覧/);
        assert.doesNotMatch(h.text(), /読みこめませんでした|読みこんでいます|target0@example.com/);
      }
      assert.deepEqual(h.toasts, ['利用停止から 30 日たった先生 1 人を、削除しました。']);
      h.cleanup();
    });
  }
}

for (const failed of ['listRequests', 'listTeachers']) {
  test(`管理画面: 一覧が一度も出ていないときの ${failed} の失敗は再試行を表示する`, async () => {
    const f = fixture(0);
    const original = f.repo[failed];
    f.repo[failed] = async () => { throw new Error('test failure'); };
    const h = view('teachers', f.repo);
    await settle();
    assert.match(h.text(), /読みこめませんでした。/);
    assert.match(h.text(), /もう一度/);
    assert.doesNotMatch(h.text(), /読みこんでいます|test failure/);
    assert.deepEqual(h.toasts, []);
    f.repo[failed] = original;
    await h.click('もう一度');
    assert.match(h.text(), /先生の一覧/);
    assert.doesNotMatch(h.text(), /読みこめませんでした|読みこんでいます/);
    h.cleanup();
  });
}

for (const autoFirst of [false, true]) {
  for (const latestFirst of [false, true]) {
    test(`管理画面: ${autoFirst ? '自動削除' : '手動操作'}後の読み直しを先に始め、${latestFirst ? '新しい' : '古い'}応答が先でも最後に始めた結果を表示する`, async () => {
      const f = fixture(2), clock = deferred();
      await f.net.set('teacherDirectory/target0/suspendedAt', NOW);
      f.repo.serverNow = () => clock.promise;
      const original = f.repo.listTeachers, requests = f.repo.listRequests;
      const reloads = [];
      let display = false, first = true;
      f.repo.listRequests = () => { display = true; return requests.call(f.repo); };
      f.repo.listTeachers = () => {
        const displaying = display;
        display = false;
        if (displaying && !first) {
          const wait = deferred(), snapshot = original();
          reloads.push({ wait, snapshot });
          return wait.promise;
        }
        if (displaying) first = false;
        return original();
      };
      const h = view('teachers', f.repo);
      await settle();
      assert.match(h.text(), /target0@example.com/);
      let manual;
      if (autoFirst) {
        clock.resolve(NOW);
        await settle();
        manual = h.click('再開');
      } else {
        manual = h.click('再開');
        await settle();
        clock.resolve(NOW);
      }
      await settle();
      assert.equal(reloads.length, 2);
      for (const i of latestFirst ? [1, 0] : [0, 1]) {
        reloads[i].wait.resolve(await reloads[i].snapshot);
        await settle();
      }
      await manual;
      assert.match(h.text(), /target0@example.com/);
      assert.doesNotMatch(h.text(), /target1@example.com|利用停止中|読みこんでいます|読みこめませんでした/);
      assert.equal(h.toasts.filter((text) => text === '再開しました。').length, 1);
      assert.equal(h.toasts.filter((text) => text === '利用停止から 30 日たった先生 1 人を、削除しました。').length, 1);
      h.cleanup();
    });
  }
}

test('管理画面: 最初の一覧が遅れて返っても、削除後の一覧を上書きしない', async () => {
  const f = fixture(), wait = deferred();
  const original = f.repo.listTeachers;
  const before = await original();
  const requests = f.repo.listRequests;
  let display = false;
  let first = true;
  f.repo.listRequests = () => { display = true; return requests.call(f.repo); };
  f.repo.listTeachers = () => {
    const displaying = display;
    display = false;
    if (displaying && first) { first = false; return wait.promise; }
    return original();
  };
  const h = view('teachers', f.repo);
  await settle();
  assert.equal(h.toasts.length, 1);
  assert.doesNotMatch(h.text(), /target0@example.com/);
  wait.resolve(before);
  await settle();
  assert.doesNotMatch(h.text(), /target0@example.com/);
  h.cleanup();
});
