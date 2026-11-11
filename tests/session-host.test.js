import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildHistory } from '../js/session-logic.js';
import { createRepo } from '../js/repo.js';
import { createSessionHost, startSession } from '../js/session-host.js';
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
  net.update = async (path, patch) => {
    if (path.endsWith('/pub')) updates.push({ at: clock.now(), patch });
    return origUpdate(path, patch);
  };
  return { net, repo, clock, ctl, updates };
}

async function begin(env, deck = makeDeck()) {
  return startSession({ net: env.net, repo: env.repo, uid: UID, deckId: 'deck1', deck, now: env.clock.now, getRandomValues: rnd });
}

async function openHost(env, sid) {
  const states = [];
  const host = createSessionHost({
    net: env.net, repo: env.repo, sid, onChange: (s) => states.push(s),
    now: env.clock.now, setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout,
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
