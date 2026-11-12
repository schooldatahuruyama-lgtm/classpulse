import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildHistory } from '../js/session-logic.js';
import { createRepo } from '../js/repo.js';
import { createSessionHost, startSession } from '../js/session-host.js';
import { CONFIG } from '../js/config.js';
import { createFakeNet } from './helpers/fake-net.js';

const UID = 'teacher1';

// 3 枚の教材: s1 資料、s2 アンケート(2択・manual)、s3 アンケート(3択・live)
function makeDeck() {
  let d = createDeck('テスト教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな数は？', options: ['1', '2', '3'], resultMode: 'live' }, 's3');
  return d;
}

// 手で進める時計とタイマー
function fakeClock() {
  let t = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    // 時間を進め、期限が来たタイマーを順に動かす
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await settle();
      }
      t = end;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const rnd = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 3) % 256; return arr; };

// 規則の代わり: 回答の書きこみは、その質問が open のときだけ通す（bypass 中は通す）
function setup() {
  const clock = fakeClock();
  const ctl = { bypass: false, extraDeny: () => false };
  let net;
  const deny = (op, path, value) => {
    if (ctl.extraDeny(op, path, value)) return true;
    const m = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\/[^/]+$/.exec(path);
    if (op !== 'set' || !m || ctl.bypass) return false;
    const pub = net.dump()?.sessions?.[m[1]]?.pub;
    return !(pub && pub.state === 'live' && pub.polls?.[m[2]]?.status === 'open');
  };
  net = createFakeNet({ now: clock.now, deny });
  const repo = createRepo(net, UID);
  const updates = []; // pub への update の記録
  const origUpdate = net.update;
  const hasResults = (patch) => Object.keys(patch).some((k) => k.startsWith('results/') && patch[k] !== null);
  net.update = async (path, patch) => {
    if (path.endsWith('/pub')) updates.push({ at: clock.now(), patch });
    // pub への書きこみをすべて保留する（スライドの移動の通信待ちを作る）
    if (path.endsWith('/pub') && ctl.holdPub) await ctl.holdPub();
    // 結果の書きこみを保留する（呼ばれた時刻が送信時刻。保留が解けたあとで届く）
    if (path.endsWith('/pub') && hasResults(patch) && ctl.holdResults) await ctl.holdResults();
    return origUpdate(path, patch);
  };
  const origGet = net.get;
  net.get = async (path) => {
    if (path.endsWith('/inbox') && ctl.holdInboxGet) await ctl.holdInboxGet();
    return origGet(path);
  };
  return { net, repo, clock, ctl, updates };
}

async function begin(env, deck = makeDeck()) {
  return startSession({ net: env.net, repo: env.repo, uid: UID, deckId: 'deck1', deck, now: env.clock.now, getRandomValues: rnd });
}

async function openHost(env, sid, { storage } = {}) {
  const states = [];
  const host = createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: (s) => states.push(s),
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
    storage,
  });
  await host.start();
  return { host, states, last: () => states[states.length - 1] };
}

const sessionOf = (env, sid) => env.net.dump()?.sessions?.[sid];
const answer = (env, sid, slideId, uid, choice) =>
  env.net.set(`sessions/${sid}/inbox/answers/${slideId}/${uid}`, { choice, at: 1 });

test('検査に通らない教材は始められない', async () => {
  const env = setup();
  const bad = addSlide(createDeck('x', 1), { ...createSlide('poll'), question: '', options: ['a'], resultMode: 'manual' }, 'p1');
  await assert.rejects(begin(env, bad), (e) => Array.isArray(e.reasons) && e.reasons.length === 2
    && e.reasons[0] === '1 枚目: 質問文を入れてください。');
  assert.equal(env.net.dump(), null);
  const empty = createDeck('空', 1);
  await assert.rejects(begin(env, empty), (e) => e.reasons[0] === 'スライドがありません。');
  assert.equal(env.net.dump(), null);
});

test('始めると授業と、発表中の印ができる', async () => {
  const env = setup();
  const sid = await begin(env);
  assert.equal(sessionOf(env, sid).owner, UID);
  assert.equal(sessionOf(env, sid).pub.state, 'live');
  assert.equal(env.net.dump().teachers[UID].active.sid, sid);
});

test('次へ・前へで pub が変わる', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  assert.equal(last().phase, 'live');
  assert.equal(last().pub.current.index, -1);
  await host.next();
  assert.deepEqual(last().pub.current, { slideId: 's1', index: 0 });
  await host.next();
  assert.deepEqual(last().pub.current, { slideId: 's2', index: 1 });
  assert.equal(last().pub.polls.s2.status, 'open');
  assert.equal(sessionOf(env, sid).pub.current.index, 1);
  await host.prev();
  assert.equal(last().pub.current.index, 0);
  assert.equal(sessionOf(env, sid).pub.current.index, 0);
});

test('前へ戻っても締切のまま', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next(); await host.next(); // s3
  assert.equal(last().pub.polls.s2.status, 'closed');
  await host.prev(); // s2 に戻る
  assert.equal(last().pub.current.slideId, 's2');
  assert.equal(last().pub.polls.s2.status, 'closed');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'closed');
});

test('続けて 2 回押しても状態がこわれない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  const a = host.next();
  const b = host.next();
  await Promise.all([a, b]);
  assert.equal(last().pub.current.index, 1);
  assert.equal(sessionOf(env, sid).pub.current.index, 1);
  const c = host.next();
  await c;
  assert.equal(last().pub.current.index, 2);
  assert.equal(last().pub.polls.s2.status, 'closed');
  assert.equal(last().pub.polls.s3.status, 'open');
});

test('続けて 3 回押しても、s2 は締切、s3 は受付中になる', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await Promise.all([host.next(), host.next(), host.next()]);
  assert.equal(last().pub.current.index, 2);
  assert.equal(last().pub.polls.s2.status, 'closed');
  assert.equal(last().pub.polls.s3.status, 'open');
});

test('受付を止めて、再開できる', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await host.setPaused(true);
  assert.equal(last().pub.polls.s2.status, 'paused');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'paused');
  await host.setPaused(false);
  assert.equal(last().pub.polls.s2.status, 'open');
});

test('回答が届くと集計が変わる', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await env.net.set(`sessions/${sid}/inbox/participants/u1`, 5);
  await env.net.set(`sessions/${sid}/inbox/participants/u2`, 6);
  await answer(env, sid, 's2', 'u1', 1);
  assert.deepEqual(last().tallies.s2, { counts: [0, 1], total: 1 });
  assert.equal(last().participants, 2);
});

test('非公開の間は pub に集計を書かない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  await env.clock.advance(5000);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(env.clock.pending(), 0);
});

test('公開すると書き、かくすと消す', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  await host.setResultsVisible(true);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 0], total: 1 });
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, true);
  await answer(env, sid, 's2', 'u2', 1);
  assert.equal(sessionOf(env, sid).pub.results.s2.total, 1); // まだ 500ms たっていない
  await env.clock.advance(500);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 1], total: 2 });
  assert.deepEqual(last().pub.results.s2, { counts: [1, 1], total: 2 });
  await host.setResultsVisible(false);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, false);
  await answer(env, sid, 's2', 'u3', 1);
  await env.clock.advance(5000);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
});

test('すぐ表示の質問は、着いたときから書く', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  assert.equal(sessionOf(env, sid).pub.results, undefined); // s3 にはまだ着いていない
  await host.next(); // s3
  await settle(); // 結果の書きこみは、進める操作のあとに順番が来る
  assert.deepEqual(sessionOf(env, sid).pub.results.s3, { counts: [0, 0, 0], total: 0 });
  await answer(env, sid, 's3', 'u1', 2);
  await env.clock.advance(500);
  assert.deepEqual(sessionOf(env, sid).pub.results.s3, { counts: [0, 0, 1], total: 1 });
});

test('短い間に何件届いても、書きこみは 500ms に 1 回で、最後の値になる', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await host.setResultsVisible(true);
  const resultWrites = () => env.updates.filter((u) => Object.keys(u.patch).some((k) => k.startsWith('results/'))).length;
  const before = resultWrites();
  await env.clock.advance(100);
  for (let i = 0; i < 10; i++) { await answer(env, sid, 's2', `u${i}`, i % 2); await env.clock.advance(10); }
  assert.equal(resultWrites(), before); // 500ms たつまでは書かない
  await env.clock.advance(400);
  assert.equal(resultWrites(), before + 1);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [5, 5], total: 10 });
  await env.clock.advance(5000);
  assert.equal(resultWrites(), before + 1);
});

test('つながっていないときは進めない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next();
  env.net.setOnline(false);
  await assert.rejects(host.next(), (e) => e.code === 'network');
  assert.deepEqual(last().pub.current, { slideId: 's1', index: 0 });
  assert.equal(last().connection, 'disconnected');
  env.net.setOnline(true);
  await host.next(); // 失敗した操作が次の操作を止めない
  assert.equal(last().pub.current.index, 1);
  assert.equal(last().connection, 'connected');
});

test('開き直すと続きから', async () => {
  const env = setup();
  const sid = await begin(env);
  const first = await openHost(env, sid);
  await first.host.next(); await first.host.next();
  await answer(env, sid, 's2', 'u1', 0);
  await first.host.setResultsVisible(true);
  first.host.stop();
  assert.equal(env.clock.pending(), 0);

  const second = await openHost(env, sid);
  assert.equal(second.last().phase, 'live');
  assert.equal(second.last().pub.current.index, 1);
  assert.equal(second.last().pub.polls.s2.status, 'open');
  assert.deepEqual(second.last().pub.results.s2, { counts: [1, 0], total: 1 });
  assert.deepEqual(second.last().tallies.s2, { counts: [1, 0], total: 1 });
  await second.host.next(); // s2 を締め切る
  second.host.stop();

  const third = await openHost(env, sid);
  assert.equal(third.last().pub.polls.s2.status, 'closed');
  assert.equal(third.last().pub.current.index, 2);
  third.host.stop();
});

test('stop は授業を終わらせず、以後の通知を止める', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, states } = await openHost(env, sid);
  host.stop();
  const n = states.length;
  await answer(env, sid, 's2', 'u1', 0).catch(() => {});
  assert.equal(states.length, n);
  assert.equal(sessionOf(env, sid).pub.state, 'live');
  assert.ok(env.net.dump().teachers[UID].active);
});

test('終了すると履歴が残り、回答と教材の写しが消える', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await env.net.set(`sessions/${sid}/inbox/participants/u1`, 5);
  await answer(env, sid, 's2', 'u1', 1);
  await host.end();
  const dump = env.net.dump();
  const expected = buildHistory(
    { deckId: 'deck1', startedAt: 1000, pub: { title: 'テスト教材' }, deck: makeDeck() },
    { participants: { u1: 5 }, answers: { s2: { u1: { choice: 1, at: 1 } } } },
    env.clock.now(),
  );
  assert.deepEqual(dump.teachers[UID].history[sid], expected);
  assert.equal(dump.sessions[sid].pub.state, 'ended');
  assert.equal(dump.sessions[sid].inbox, undefined);
  assert.equal(dump.sessions[sid].deck, undefined);
  assert.equal(dump.teachers[UID].active, undefined);
  assert.equal(last().phase, 'ended');
});

test('履歴を保存できなければ終わらせない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  env.ctl.extraDeny = (op, path) => op === 'set' && path.includes('/history/');
  await assert.rejects(host.end());
  assert.equal(last().phase, 'live');
  assert.equal(sessionOf(env, sid).pub.state, 'live');
  assert.ok(sessionOf(env, sid).inbox);
  assert.ok(sessionOf(env, sid).deck);
  assert.ok(env.net.dump().teachers[UID].active);

  env.ctl.extraDeny = () => false;
  await host.end();
  const dump = env.net.dump();
  assert.equal(dump.sessions[sid].pub.state, 'ended');
  assert.equal(dump.teachers[UID].history[sid].questions[0].total, 1);
  assert.equal(dump.teachers[UID].active, undefined);
});

test('終了の処理の途中で届いた回答を失わない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  let denied = null;
  const origUpdate = env.net.update;
  env.net.update = async (path, patch) => {
    await origUpdate(path, patch);
    if (path.endsWith('/pub') && patch['polls/s2/status'] === 'closed' && denied === null) {
      // 締め切ったあとの回答は、規則の代わりの deny が拒否する
      denied = await answer(env, sid, 's2', 'late', 1).then(() => false, (e) => e.code === 'denied');
      // 締め切りより前に送られ、まだ届いていなかった回答（inbox を読む前に届く）
      env.ctl.bypass = true;
      await answer(env, sid, 's2', 'u9', 1);
      env.ctl.bypass = false;
    }
  };
  await host.end();
  assert.equal(denied, true);
  const q = env.net.dump().teachers[UID].history[sid].questions.find((x) => x.slideId === 's2');
  assert.deepEqual(q.counts, [1, 1]);
  assert.equal(q.total, 2);
});

test('終わった授業を開くと ended になる', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  await a.host.end();
  a.host.stop();
  const b = await openHost(env, sid);
  assert.equal(b.last().phase, 'ended');
});

test('無い授業は not-found', async () => {
  const env = setup();
  const { last } = await openHost(env, 'nothing');
  assert.equal(last().phase, 'not-found');
});

// 手で解く保留
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { wait: () => p, open };
}

test('停止した host の保留中の結果の書きこみが、新しい host の「かくす」を覆さない', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  await a.host.next(); await a.host.next();
  await a.host.setResultsVisible(true);
  const g = gate();
  env.ctl.holdResults = g.wait;
  await answer(env, sid, 's2', 'u1', 0);
  await env.clock.advance(500); // 旧 host の書きこみが保留のまま
  const stopping = a.host.stop();
  env.ctl.holdResults = null;
  const b = createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: () => {},
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
  });
  const starting = b.start();
  g.open();
  await stopping;
  await starting;
  await b.setResultsVisible(false);
  await env.clock.advance(5000);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, false);
  b.stop();
});

test('停止した host の end が回答の読み直しで止まっていても、新しい host の履歴を上書きしない', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  await a.host.next(); await a.host.next();
  await answer(env, sid, 's2', 'u1', 0);
  let saves = 0;
  const origSave = env.repo.saveHistory;
  env.repo.saveHistory = async (...args) => { saves += 1; return origSave(...args); };
  const g = gate();
  env.ctl.holdInboxGet = g.wait;
  const ending = a.host.end();
  await settle(); // 旧 host は inbox の読み直しで止まっている
  const stopping = a.host.stop();
  env.ctl.holdInboxGet = null;
  const b = createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: () => {},
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
  });
  const starting = b.start();
  g.open();
  await assert.rejects(ending);
  await stopping;
  await starting;
  await b.end();
  assert.equal(saves, 1);
  const q = env.net.dump().teachers[UID].history[sid].questions.find((x) => x.slideId === 's2');
  assert.equal(q.total, 1);
  assert.equal(sessionOf(env, sid).inbox, undefined);
  b.stop();
});

test('停止したあとに残った操作は失敗し、書きこみを始めない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  const first = host.next();
  const second = host.next();
  host.stop();
  await first.catch(() => {});
  await assert.rejects(second);
  await assert.rejects(host.next());
  assert.ok(sessionOf(env, sid).pub.current.index <= 0);
});

test('書きこみの間に回答が元に戻っても、公開中の集計が古いまま残らない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  await host.setResultsVisible(true); // 公開中は [1,0]
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 0], total: 1 });
  const g = gate();
  env.ctl.holdResults = g.wait;
  await answer(env, sid, 's2', 'u1', 1); // [0,1]
  await env.clock.advance(500); // [0,1] の書きこみが保留
  await answer(env, sid, 's2', 'u1', 0); // [1,0] に戻る
  env.ctl.holdResults = null;
  g.open();
  await settle();
  await env.clock.advance(5000);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 0], total: 1 });
});

test('書きこみが遅れても、実際の送信の間隔は 500ms を下回らず、最後は最新の値', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await host.setResultsVisible(true);
  const g = gate();
  env.ctl.holdResults = g.wait;
  await env.clock.advance(100);
  await answer(env, sid, 's2', 'u1', 0);
  await env.clock.advance(400); // 書きこみが始まって保留
  await answer(env, sid, 's2', 'u2', 1);
  await env.clock.advance(200);
  await answer(env, sid, 's2', 'u3', 1);
  env.ctl.holdResults = null;
  g.open();
  await settle();
  await env.clock.advance(5000);
  const times = env.updates
    .filter((u) => Object.keys(u.patch).some((k) => k.startsWith('results/') && u.patch[k] !== null))
    .map((u) => u.at);
  assert.ok(times.length >= 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 500, `間隔 ${times[i] - times[i - 1]}`);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 2], total: 3 });
});

test('発表中の印を外せなかったあと、開き直して end すると片づけが終わる', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  await a.host.next();
  let failed = 0;
  env.ctl.extraDeny = (op, path) => {
    if (op === 'remove' && path.endsWith(`teachers/${UID}/active`) && failed === 0) { failed += 1; return true; }
    return false;
  };
  await assert.rejects(a.host.end());
  assert.equal(sessionOf(env, sid).pub.state, 'ended');
  assert.ok(env.net.dump().teachers[UID].active);
  await a.host.stop();
  const b = await openHost(env, sid);
  assert.equal(b.last().phase, 'ended');
  await b.host.end();
  assert.equal(env.net.dump().teachers[UID].active, undefined);
  b.host.stop();
});

test('A を止め、B を開いて待たせたまま B も止めても、C は A の書きこみが済むまで読まない', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  await a.host.next(); await a.host.next();
  await a.host.setResultsVisible(true);
  const g = gate();
  env.ctl.holdResults = g.wait;
  await answer(env, sid, 's2', 'u1', 0);
  await env.clock.advance(500); // A の書きこみが保留
  env.ctl.holdResults = null;
  const stopA = a.host.stop();
  let reads = 0;
  const origGet = env.net.get;
  env.net.get = async (path) => { if (path === `sessions/${sid}`) reads += 1; return origGet(path); };
  const mk = () => createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: () => {},
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
  });
  const b = mk();
  const startB = b.start();
  await settle();
  const stopB = b.stop();
  const c = mk();
  const startC = c.start();
  await settle();
  assert.equal(reads, 0); // B も C もまだ読んでいない
  g.open();
  await Promise.all([stopA, stopB, startB, startC]);
  assert.equal(reads, 1); // 読んだのは C だけ
  await c.setResultsVisible(false);
  await env.clock.advance(5000);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, false);
  c.stop();
});

// s1 資料、s2・s3 とも「先生が表示するまで出さない」アンケート
function manualDeck() {
  let d = createDeck('テスト教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('poll'), question: '問1', options: ['赤', '青'], resultMode: 'manual' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '問2', options: ['1', '2', '3'], resultMode: 'manual' }, 's3');
  return d;
}

// s2 にいる状態で「次へ」を通信待ちにし、その間に s2 への操作を頼む
async function opWhileMoving(op) {
  const env = setup();
  const sid = await begin(env, manualDeck());
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 0);
  const g = gate();
  env.ctl.holdPub = g.wait;
  const moving = host.next();
  await settle();
  const acting = op(host);
  await settle();
  env.ctl.holdPub = null;
  g.open();
  await Promise.all([moving, acting]);
  await answer(env, sid, 's3', 'u1', 1);
  await env.clock.advance(5000);
  host.stop();
  return sessionOf(env, sid).pub;
}

test('「次へ」の通信待ちの間に押した「結果を表示」（s2 向け）は、移動先の s3 を公開しない', async () => {
  const pub = await opWhileMoving((host) => host.setResultsVisible(true, 's2'));
  assert.deepEqual(pub.current, { slideId: 's3', index: 2 });
  assert.equal(pub.polls.s3.resultsVisible, false);
  assert.equal(pub.results, undefined);
  assert.equal(pub.polls.s2.resultsVisible, false); // s2 はもう今のスライドではないので、何も書かない
  assert.equal(pub.polls.s2.status, 'closed');
});

test('「次へ」の通信待ちの間に押した「受付を止める」（s2 向け）は、移動先の s3 を止めない', async () => {
  const pub = await opWhileMoving((host) => host.setPaused(true, 's2'));
  assert.deepEqual(pub.current, { slideId: 's3', index: 2 });
  assert.equal(pub.polls.s3.status, 'open');
  assert.equal(pub.polls.s2.status, 'closed');
});

test('slideId を渡し、それが今のスライドなら、受付の停止と結果の表示はそのまま効く', async () => {
  const env = setup();
  const sid = await begin(env, manualDeck());
  const { host } = await openHost(env, sid);
  await host.next(); await host.next();
  await host.setPaused(true, 's2');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'paused');
  await host.setResultsVisible(true, 's2');
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, true);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [0, 0], total: 0 });
  host.stop();
});

// ---- 同じ授業を 2 つのタブで開いている（公開の状態を、pub の購読で合わせる） ----

test('別のタブが結果をかくしたあとは、回答が変わっても集計を pub に書かない', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  const b = await openHost(env, sid);
  await a.host.next();
  await a.host.next(); // s2（manual）
  await answer(env, sid, 's2', 'u1', 0);
  await a.host.setResultsVisible(true);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 0], total: 1 });
  assert.equal(b.last().pub.current.slideId, 's2'); // B も、A の移動を知っている
  assert.equal(b.last().pub.polls.s2.resultsVisible, true);

  await b.host.setResultsVisible(false); // 別のタブでかくす
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(a.last().pub.polls.s2.resultsVisible, false); // A も、かくされたことを知っている

  const before = env.updates.length;
  await answer(env, sid, 's2', 'u2', 1); // 回答が変わる
  await env.clock.advance(5000);
  await settle();
  assert.equal(sessionOf(env, sid).pub.results, undefined); // A は集計を書き直さない
  assert.equal(env.updates.slice(before).some((u) => Object.keys(u.patch).some((k) => k.startsWith('results/'))), false);
  assert.equal(a.last().pub.results, undefined);
  await a.host.stop();
  await b.host.stop();
});

test('別のタブがスライドを進めていたら、その続きから操作する（古い位置から計算しない）', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  const b = await openHost(env, sid);
  await a.host.next(); // s1
  await a.host.next(); // s2（受付中）
  await b.host.next(); // B からは s3 へ（s2 は締切）
  const pub = sessionOf(env, sid).pub;
  assert.deepEqual(pub.current, { slideId: 's3', index: 2 });
  assert.equal(pub.polls.s2.status, 'closed');
  assert.equal(a.last().pub.current.slideId, 's3');
  await a.host.setPaused(true); // A の「受付を止める」は、今のスライド（s3）に効く
  assert.equal(sessionOf(env, sid).pub.polls.s3.status, 'paused');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'closed'); // 締切済みは開かない
  await a.host.stop();
  await b.host.stop();
});

test('購読が届いていなくても、操作の直前に最新の pub を読んでから計算する', async () => {
  const env = setup();
  const sid = await begin(env);
  // pub の購読を止める（別のタブの変更が届かない状態）
  const origSubscribe = env.net.subscribe;
  env.net.subscribe = (path, onValue, onStatus) => (path.endsWith('/pub') ? () => {} : origSubscribe(path, onValue, onStatus));
  const a = await openHost(env, sid);
  env.net.subscribe = origSubscribe;
  const b = await openHost(env, sid);
  await b.host.next(); // s1
  await b.host.next(); // s2
  await b.host.next(); // s3（s2 は締切）
  assert.equal(a.last().pub.current.index, -1); // A には届いていない
  await a.host.prev(); // 最新（s3）から計算して s2 へ戻る。締切済みの s2 は開かない
  const pub = sessionOf(env, sid).pub;
  assert.deepEqual(pub.current, { slideId: 's2', index: 1 });
  assert.equal(pub.polls.s2.status, 'closed');
  await a.host.stop();
  await b.host.stop();
});

test('別のタブが授業を終えたら、このタブも ended になり、集計を書かない', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  const b = await openHost(env, sid);
  await a.host.next();
  await a.host.next();
  await a.host.next(); // s3（live）
  await b.host.end();
  assert.equal(a.last().phase, 'ended');
  const before = env.updates.length;
  await env.clock.advance(5000);
  assert.equal(env.updates.length, before);
  await a.host.end(); // 残りの後片づけは、やり直しても失敗しない
  assert.equal(env.net.dump().teachers[UID].active, undefined);
  await a.host.stop();
  await b.host.stop();
});

test('画面を離れたあとは、別のタブの変更で state を出さない（pub の購読も解除する）', async () => {
  const env = setup();
  const sid = await begin(env);
  const a = await openHost(env, sid);
  const b = await openHost(env, sid);
  await a.host.stop();
  const n = a.states.length;
  await b.host.next();
  assert.equal(a.states.length, n);
  await b.host.stop();
});

test('集計の書きこみが規則に拒否されたら、最新の pub を読み直して、かくされていれば書くのをやめる', async () => {
  const env = setup();
  const sid = await begin(env);
  // pub の購読を止める（かくされたことが届かない状態）
  const origSubscribe = env.net.subscribe;
  env.net.subscribe = (path, onValue, onStatus) => (path.endsWith('/pub') ? () => {} : origSubscribe(path, onValue, onStatus));
  const a = await openHost(env, sid);
  env.net.subscribe = origSubscribe;
  // 規則の代わり: かくしている質問の集計は書けない
  env.ctl.extraDeny = (op, path, value) => {
    if (op !== 'update' || !path.endsWith('/pub')) return false;
    const pub = sessionOf(env, sid).pub;
    return Object.keys(value).some((k) => {
      if (!k.startsWith('results/') || value[k] === null) return false;
      const id = k.slice(8);
      const vis = value[`polls/${id}/resultsVisible`];
      return !(vis === undefined ? pub.polls?.[id]?.resultsVisible === true : vis === true);
    });
  };
  await a.host.next();
  await a.host.next(); // s2
  await a.host.setResultsVisible(true);
  await env.net.update(`sessions/${sid}/pub`, { 'polls/s2/resultsVisible': false, 'results/s2': null }); // 別のタブがかくした
  await answer(env, sid, 's2', 'u1', 0);
  await settle();
  await env.clock.advance(600);
  await settle();
  const tries = env.updates.filter((u) => u.patch['results/s2']).length;
  await env.clock.advance(10000); // 拒否され続けて書こうとし続けない
  await settle();
  assert.equal(env.updates.filter((u) => u.patch['results/s2']).length, tries);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  assert.equal(a.last().pub.polls.s2.resultsVisible, false);
  await a.host.stop();
});

// ---- 自由記述 ----

// s1 資料、s2 自由記述、s3 アンケート（manual）
function freeDeck() {
  let d = createDeck('自由記述の教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('free'), question: '感想は？' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's3');
  return d;
}

const write = (env, sid, slideId, uid, text, at) =>
  env.net.set(`sessions/${sid}/inbox/answers/${slideId}/${uid}`, { text, at });

// s2（自由記述・受付中）にいる host を開く
async function openFree(env, opts) {
  const sid = await begin(env, freeDeck());
  const h = await openHost(env, sid, opts);
  await h.host.next(); await h.host.next();
  return { sid, ...h };
}

const texts = (s) => (s.freeItems || []).map((x) => x.text);

test('自由記述: 結果を表示する前は、状態に文章が 1 つも無い（件数だけ）', async () => {
  const env = setup();
  const { sid, host, states, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'ひみつのぶんしょうA', 10);
  await write(env, sid, 's2', 'u2', 'ひみつのぶんしょうB', 20);
  await write(env, sid, 's2', 'u2', 'ひみつのぶんしょうC', 30); // 書き直し
  await env.clock.advance(5000);
  assert.equal(last().kind, 'free');
  assert.equal(last().answerCount, 2);
  assert.equal(last().freeItems, null);
  for (const s of states) assert.ok(!JSON.stringify(s).includes('ひみつ'), '状態に文章が入っている');
  host.stop();
});

test('自由記述: 表示にすると freeItems が古い順で入り、結果をかくすと消える', async () => {
  const env = setup();
  const { sid, host, states, last } = await openFree(env);
  await write(env, sid, 's2', 'u2', 'あと', 20);
  await write(env, sid, 's2', 'u1', 'さき', 10);
  await host.setResultsVisible(true, 's2');
  assert.deepEqual(last().freeItems, [{ uid: 'u1', text: 'さき' }, { uid: 'u2', text: 'あと' }]);
  assert.equal(last().answerCount, 2);
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, true);
  await host.setResultsVisible(false, 's2');
  assert.equal(last().freeItems, null);
  const n = states.length;
  await write(env, sid, 's2', 'u3', 'ひみつ', 40);
  await env.clock.advance(5000);
  for (const s of states.slice(n)) assert.ok(!JSON.stringify(s).includes('ひみつ'));
  assert.equal(last().answerCount, 3);
  host.stop();
});

test('自由記述: 表示中の新しい回答・書き直しは 500ms 以内の間隔でまとめて反映される', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', '一', 10);
  await host.setResultsVisible(true, 's2');
  assert.deepEqual(texts(last()), ['一']);
  await env.clock.advance(100);
  await write(env, sid, 's2', 'u2', '二', 20);
  await write(env, sid, 's2', 'u1', '一（直した）', 30);
  assert.deepEqual(texts(last()), ['一']); // まだ反映しない
  assert.equal(last().answerCount, 2); // 件数は文章ではないので、すぐ変わる
  await env.clock.advance(CONFIG.resultsThrottleMs - 101);
  assert.deepEqual(texts(last()), ['一']);
  await env.clock.advance(1);
  assert.deepEqual(texts(last()), ['二', '一（直した）']);
  await env.clock.advance(5000);
  assert.equal(env.clock.pending(), 0);
  host.stop();
});

test('自由記述: hide のあと freeItems から消え、件数は変わらない。書き直しても出てこない', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await host.setResultsVisible(true, 's2');
  const p = host.hide('s2', 'u2');
  assert.deepEqual(texts(last()), ['よい']); // すぐに消える
  assert.equal(last().answerCount, 2);
  await p;
  assert.equal(last().hiddenUnsaved, false);
  assert.equal(sessionOf(env, sid).host.hidden.s2.u2, true);
  await write(env, sid, 's2', 'u2', 'わるい2', 30);
  await env.clock.advance(5000);
  assert.deepEqual(texts(last()), ['よい']);
  assert.equal(last().answerCount, 2);
  host.stop();
});

test('自由記述: hide の書きこみが失敗すると hiddenUnsaved、再試行で成功すると false', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await host.setResultsVisible(true, 's2');
  let fail = true;
  let tries = 0;
  env.ctl.extraDeny = (op, path) => {
    if (op === 'set' && path.includes('/host/hidden/')) { tries += 1; return fail; }
    return false;
  };
  let saved = false;
  const p = host.hide('s2', 'u2').then(() => { saved = true; });
  await settle();
  assert.equal(last().hiddenUnsaved, true);
  assert.deepEqual(texts(last()), ['よい']);
  assert.equal(tries, 1);
  await env.clock.advance(CONFIG.reconnectDelayMs);
  assert.equal(tries, 2);
  assert.equal(last().hiddenUnsaved, true);
  // 書けていなくても、「次へ」「前へ」で戻っても出さない
  await host.next(); await host.prev();
  assert.deepEqual(texts(last()), ['よい']);
  fail = false;
  await env.clock.advance(CONFIG.reconnectDelayMs);
  await p;
  assert.equal(saved, true);
  assert.equal(last().hiddenUnsaved, false);
  assert.equal(sessionOf(env, sid).host.hidden.s2.u2, true);
  assert.equal(env.clock.pending(), 0);
  host.stop();
});

test('自由記述: 作り直した host（再読み込み）でも、かくしたものが出ない', async () => {
  const env = setup();
  const a = await openFree(env);
  const { sid } = a;
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await a.host.setResultsVisible(true, 's2');
  await a.host.hide('s2', 'u2');
  await a.host.stop();
  const b = await openHost(env, sid);
  assert.equal(b.last().kind, 'free');
  assert.deepEqual(texts(b.last()), ['よい']);
  assert.equal(b.last().answerCount, 2);
  assert.equal(b.last().hiddenUnsaved, false);
  b.host.stop();
});

test('自由記述: stop は hide の再試行も止める', async () => {
  const env = setup();
  const { sid, host } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'よい', 10);
  let tries = 0;
  env.ctl.extraDeny = (op, path) => { if (path.includes('/host/hidden/')) { tries += 1; return true; } return false; };
  const p = host.hide('s2', 'u1');
  await settle();
  assert.equal(tries, 1);
  await host.stop();
  await assert.rejects(p);
  assert.equal(env.clock.pending(), 0);
  await env.clock.advance(CONFIG.reconnectDelayMs * 3);
  assert.equal(tries, 1);
});

test('自由記述: 停止した host の書きこみ中の hide は、次の host が読む前に済む', async () => {
  const env = setup();
  const a = await openFree(env);
  const { sid } = a;
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await a.host.setResultsVisible(true, 's2');
  const g = gate();
  const origSet = env.net.set;
  env.net.set = async (path, value) => {
    if (path.includes('/host/hidden/')) await g.wait();
    return origSet(path, value);
  };
  const hiding = a.host.hide('s2', 'u2');
  await settle();
  const stopping = a.host.stop();
  const states = [];
  const b = createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: (s) => states.push(s),
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
  });
  const starting = b.start();
  await settle();
  g.open();
  await assert.rejects(hiding); // 書けたかどうかを、閉じた画面は知らせない
  await stopping;
  await starting;
  assert.deepEqual(texts(states[states.length - 1]), ['よい']);
  b.stop();
});

test('自由記述では pub/results に何も書かない。アンケートは今までどおり書く', async () => {
  const env = setup();
  const { sid, host } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'ぶんしょう', 10);
  await host.setResultsVisible(true, 's2');
  await env.clock.advance(1000);
  await write(env, sid, 's2', 'u2', 'ぶんしょう2', 20);
  await env.clock.advance(1000);
  await host.setResultsVisible(false, 's2');
  await host.setResultsVisible(true, 's2');
  await host.next(); // s3 へ（s2 は締切）
  await env.clock.advance(1000);
  const touchesFree = env.updates.some((u) => Object.keys(u.patch).some((k) => k === 'results/s2' || k.startsWith('results/s2/')));
  assert.equal(touchesFree, false);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  for (const u of env.updates) assert.ok(!JSON.stringify(u.patch).includes('ぶんしょう'));
  assert.ok(!JSON.stringify(sessionOf(env, sid).pub).includes('ぶんしょう'));
  // アンケート
  await answer(env, sid, 's3', 'u1', 1);
  await host.setResultsVisible(true, 's3');
  assert.deepEqual(sessionOf(env, sid).pub.results.s3, { counts: [0, 1], total: 1 });
  host.stop();
});

test('自由記述: end() の履歴で hiddenTexts に分かれ、uid が無く、後片づけのあと host が無い', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'uidA', 'よい', 10);
  await write(env, sid, 's2', 'uidB', 'わるい', 20);
  await write(env, sid, 's2', 'uidC', 'ふつう', 30);
  await write(env, sid, 's2', 'uidD', 'のこる', 40);
  await host.setResultsVisible(true, 's2');
  await host.hide('s2', 'uidB'); // 保存できたもの
  env.ctl.extraDeny = (op, path) => op === 'set' && path.includes('/host/hidden/');
  host.hide('s2', 'uidC').catch(() => {}); // まだ書けていないもの
  await settle();
  assert.equal(last().hiddenUnsaved, true);
  env.ctl.extraDeny = () => false;
  const g = gate();
  env.ctl.holdInboxGet = g.wait;
  const ending = host.end();
  await settle();
  // 締切のあと、読み直す前に（別のタブなどが）書いたもの: end のときに読み直して使う
  await env.net.set(`sessions/${sid}/host/hidden/s2/uidA`, true);
  env.ctl.holdInboxGet = null;
  g.open();
  await ending;
  const dump = env.net.dump();
  const hist = dump.teachers[UID].history[sid];
  const q = hist.questions.find((x) => x.slideId === 's2');
  assert.equal(q.type, 'free');
  assert.deepEqual(q.texts, ['のこる']);
  assert.deepEqual(q.hiddenTexts, ['よい', 'わるい', 'ふつう']);
  assert.equal(q.total, 4);
  assert.ok(!JSON.stringify(hist).includes('uid'));
  assert.equal(dump.sessions[sid].host, undefined);
  assert.equal(dump.sessions[sid].inbox, undefined);
  assert.equal(last().phase, 'ended');
  assert.equal(last().hiddenUnsaved, false);
  await env.clock.advance(CONFIG.reconnectDelayMs * 3);
  assert.equal(env.net.dump().sessions[sid].host, undefined); // 再試行で host を作り直さない
  assert.equal(env.clock.pending(), 0);
  host.stop();
});

test('自由記述: host を消せなかった end は、やり直すと片づけが終わる', async () => {
  const env = setup();
  const { sid, host } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await host.hide('s2', 'u1');
  let failed = 0;
  env.ctl.extraDeny = (op, path) => {
    if (op === 'remove' && path === `sessions/${sid}/host` && failed === 0) { failed += 1; return true; }
    return false;
  };
  await assert.rejects(host.end());
  assert.ok(sessionOf(env, sid).host);
  await host.end();
  assert.equal(sessionOf(env, sid).host, undefined);
  assert.equal(env.net.dump().teachers[UID].active, undefined);
  assert.deepEqual(env.net.dump().teachers[UID].history[sid].questions[0].hiddenTexts, ['よい']);
  host.stop();
});

test('自由記述: 締切済みに戻ったとき、表示中なら freeItems が入り、status は closed のまま', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await host.setResultsVisible(true, 's2');
  await host.next(); // s3
  assert.equal(last().kind, 'poll');
  assert.equal(last().freeItems, null);
  assert.equal(last().answerCount, null);
  await host.prev(); // s2 に戻る
  assert.equal(last().pub.polls.s2.status, 'closed');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'closed');
  assert.equal(last().kind, 'free');
  assert.deepEqual(texts(last()), ['よい']);
  await host.hide('s2', 'u1'); // 締切後もかくせる
  assert.deepEqual(last().freeItems, []);
  assert.equal(last().answerCount, 1);
  host.stop();
});

test('自由記述: 結果をかくしたまま締切済みに戻っても、文章は状態に無い', async () => {
  const env = setup();
  const { sid, host, states } = await openFree(env);
  await write(env, sid, 's2', 'u1', 'ひみつ', 10);
  await host.next(); await host.prev();
  assert.equal(states[states.length - 1].freeItems, null);
  for (const s of states) assert.ok(!JSON.stringify(s).includes('ひみつ'));
  host.stop();
});

// ---- 自由記述: かくしたものを端末にも残す（storage） ----

// localStorage の代わり（メモリ上）
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}
const storeKey = (sid) => `classpulse:hidden:${sid}`;

test('自由記述: 書けていない hide は、同じ storage で作り直した host でも出ず、再送されて書ける', async () => {
  const env = setup();
  const storage = memStorage();
  const a = await openFree(env, { storage });
  const { sid } = a;
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await a.host.setResultsVisible(true, 's2');
  let fail = true;
  env.ctl.extraDeny = (op, path) => fail && op === 'set' && path.includes('/host/hidden/');
  a.host.hide('s2', 'u2').catch(() => {});
  await settle();
  assert.equal(a.last().hiddenUnsaved, true);
  assert.deepEqual(JSON.parse(storage.getItem(storeKey(sid))), { s2: { u2: true } });
  await a.host.stop(); // 再読み込み
  assert.equal(sessionOf(env, sid).host?.hidden, undefined);
  const b = await openHost(env, sid, { storage });
  assert.equal(b.last().kind, 'free');
  assert.deepEqual(texts(b.last()), ['よい']);
  for (const s of b.states) assert.ok(!JSON.stringify(s.freeItems || []).includes('わるい'));
  assert.equal(b.last().hiddenUnsaved, true);
  fail = false;
  await env.clock.advance(CONFIG.reconnectDelayMs);
  assert.equal(b.last().hiddenUnsaved, false);
  assert.equal(sessionOf(env, sid).host.hidden.s2.u2, true);
  assert.equal(env.clock.pending(), 0);
  b.host.stop();
});

test('自由記述: storage の中身がこわれていても無視する', async () => {
  for (const bad of ['{こわれた', '[1,2]', '"s2"', 'null', '{"s2":{"u1":"yes"}}', '{"s2":5}']) {
    const env = setup();
    const storage = memStorage();
    const sid = await begin(env, freeDeck());
    storage.setItem(storeKey(sid), bad);
    const h = await openHost(env, sid, { storage });
    await h.host.next(); await h.host.next();
    await write(env, sid, 's2', 'u1', 'よい', 10);
    await h.host.setResultsVisible(true, 's2');
    assert.deepEqual(texts(h.last()), ['よい'], bad);
    assert.equal(h.last().hiddenUnsaved, false, bad);
    await h.host.hide('s2', 'u1');
    assert.deepEqual(h.last().freeItems, []);
    assert.deepEqual(JSON.parse(storage.getItem(storeKey(sid))), { s2: { u1: true } }, bad);
    h.host.stop();
  }
});

test('自由記述: storage が例外を投げても、hide・開き直し・end は動く', async () => {
  const env = setup();
  const boom = () => { throw new Error('使えません'); };
  const storage = { getItem: boom, setItem: boom, removeItem: boom };
  const a = await openFree(env, { storage });
  const { sid } = a;
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  await a.host.setResultsVisible(true, 's2');
  await a.host.hide('s2', 'u2');
  assert.deepEqual(texts(a.last()), ['よい']);
  assert.equal(sessionOf(env, sid).host.hidden.s2.u2, true);
  await a.host.stop();
  const b = await openHost(env, sid, { storage });
  assert.deepEqual(texts(b.last()), ['よい']);
  await b.host.end();
  assert.equal(b.last().phase, 'ended');
  assert.deepEqual(env.net.dump().teachers[UID].history[sid].questions[0].hiddenTexts, ['わるい']);
  b.host.stop();
});

test('自由記述: end() は storage のかくしたものを履歴に入れ、片づけのあとキーを消す', async () => {
  const env = setup();
  const storage = memStorage();
  const a = await openFree(env, { storage });
  const { sid } = a;
  storage.setItem('classpulse:hidden:ほかの授業', '{"s2":{"x":true}}');
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await write(env, sid, 's2', 'u2', 'わるい', 20);
  env.ctl.extraDeny = (op, path) => op === 'set' && path.includes('/host/hidden/');
  a.host.hide('s2', 'u2').catch(() => {});
  await settle();
  await a.host.stop();
  const b = await openHost(env, sid, { storage });
  // 後片づけの途中で失敗した end では、キーを残す
  let failed = 0;
  env.ctl.extraDeny = (op, path) => {
    if (op === 'set' && path.includes('/host/hidden/')) return true;
    if (op === 'remove' && path === `sessions/${sid}/deck` && failed === 0) { failed += 1; return true; }
    return false;
  };
  await assert.rejects(b.host.end());
  assert.ok(storage.getItem(storeKey(sid)));
  await b.host.end();
  assert.equal(storage.getItem(storeKey(sid)), null);
  assert.ok(storage.getItem('classpulse:hidden:ほかの授業')); // ほかの授業のものは残す
  const q = env.net.dump().teachers[UID].history[sid].questions[0];
  assert.deepEqual(q.texts, ['よい']);
  assert.deepEqual(q.hiddenTexts, ['わるい']);
  b.host.stop();
});

test('自由記述: 別のタブが授業を終えたら、storage のキーを消す（開いたときに終わっていた場合も）', async () => {
  const env = setup();
  const storage = memStorage();
  const a = await openFree(env, { storage });
  const { sid } = a;
  await write(env, sid, 's2', 'u1', 'よい', 10);
  await a.host.hide('s2', 'u1');
  assert.ok(storage.getItem(storeKey(sid)));
  const other = await openHost(env, sid);
  await other.host.end();
  assert.equal(a.last().phase, 'ended');
  assert.equal(storage.getItem(storeKey(sid)), null);
  await a.host.stop();
  // 終わった授業を開いたとき
  storage.setItem(storeKey(sid), '{"s2":{"u1":true}}');
  const c = await openHost(env, sid, { storage });
  assert.equal(c.last().phase, 'ended');
  assert.equal(storage.getItem(storeKey(sid)), null);
  c.host.stop();
  other.host.stop();
});
