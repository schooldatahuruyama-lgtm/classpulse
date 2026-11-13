import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildHistory } from '../js/session-logic.js';
import { createRepo } from '../js/repo.js';
import { createSessionHost, startSession } from '../js/session-host.js';
import { CONFIG } from '../js/config.js';
import { createFakeNet } from './helpers/fake-net.js';

test('自動チェック: 確認待ちは状態に入らず、heldItems だけが本文を返す', async () => {
  const env = setup();
  const { sid, host, states, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', '死ね', 1);
  await write(env, sid, 's2', 'u2', '空の色', 2);
  assert.equal(last().heldCount, 1);
  assert.equal(last().answerCount, 2);
  assert.equal(last().freeItems, null);
  await host.setResultsVisible(true);
  await env.clock.advance(1000);
  assert.deepEqual(texts(last()), ['空の色']);
  assert.ok(states.every((s) => !JSON.stringify(s).includes('死ね')));
  const held = host.heldItems('s2');
  assert.deepEqual(held, [{ key: 'u1', text: '死ね' }]);
  held[0].text = '書きかえ';
  assert.equal(host.heldItems()[0].text, '死ね');
  await host.next();
  assert.equal(last().heldCount, null);
  await host.stop();
});

test('自動チェック: 映すと間引きを待たず反映。書き直しで確認待ち、かくすが優先', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', '死ね', 1);
  await host.setResultsVisible(true);
  const saved = host.release('s2', 'u1');
  assert.deepEqual(texts(last()), ['死ね']);
  assert.equal(last().heldCount, 0);
  await saved;
  assert.equal(sessionOf(env, sid).host.released.s2.u1, '死ね');
  await write(env, sid, 's2', 'u1', '死ね！', 2);
  assert.equal(last().heldCount, 1);
  assert.deepEqual(texts(last()), []);
  await host.hide('s2', 'u1');
  assert.equal(last().heldCount, 0);
  await host.release('s2', 'u1');
  assert.deepEqual(texts(last()), []);
  await host.end();
  const q = env.net.dump().teachers[UID].history[sid].questions[0];
  assert.deepEqual(q.hiddenTexts, ['死ね！']);
  assert.deepEqual((await env.repo.getHistory(sid)).questions[0].heldTexts, []);
  await assert.rejects(host.release('s2', 'u1'));
  await host.stop();
});

test('自動チェック: release 保存失敗は拒否、手元では映したまま。再試行せず開き直すと確認待ち', async () => {
  const env = setup();
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', '死ね', 1);
  await host.setResultsVisible(true);
  let calls = 0;
  env.ctl.extraDeny = (op, path) => { if (op === 'set' && path.includes('/released/')) { calls++; return true; } return false; };
  await assert.rejects(host.release('s2', 'u1'));
  assert.deepEqual(texts(last()), ['死ね']);
  await env.clock.advance(5000);
  assert.equal(calls, 1);
  await host.stop();
  await assert.rejects(host.release('s2', 'u1'));
  const again = await openHost(env, sid);
  assert.equal(again.last().heldCount, 1);
  assert.deepEqual(texts(again.last()), []);
  await again.host.stop();
});

for (const settings of ['offline', { enabled: 'false', words: ['空'] }, null]) {
  test(`自動チェック: 設定が読めない・こわれていても開始できる (${JSON.stringify(settings)})`, async () => {
    const env = setup();
    env.repo.getModeration = async () => { if (settings === 'offline') throw new Error('offline'); return settings; };
    const { sid, host, last } = await openFree(env);
    await write(env, sid, 's2', 'u1', '死ね', 1);
    await host.setResultsVisible(true);
    assert.equal(last().heldCount, 1);
    assert.deepEqual(texts(last()), []);
    await host.stop();
  });
}

test('自動チェック: 設定は開始時だけ読み、先生の言葉と無効設定も使える', async () => {
  const env = setup();
  await env.repo.saveModeration({ enabled: true, words: ['青空'] });
  const { sid, host, last } = await openFree(env);
  await write(env, sid, 's2', 'u1', '青空', 1);
  assert.equal(last().heldCount, 1);
  await env.repo.saveModeration({ enabled: false, words: [] });
  await write(env, sid, 's2', 'u2', '死ね', 2);
  assert.equal(last().heldCount, 2);
  await host.stop();
  const again = await openHost(env, sid);
  assert.equal(again.last().heldCount, 0);
  await again.host.stop();
});

test('自動チェック: 雲は語数を返し、承認は同じ鍵の別の形にも効く', async () => {
  const env = setup();
  const { sid, host, states, last } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['ＦＵＣＫ', '雲']);
  await say(env, sid, 's2', 'u2', ['fuck']);
  await host.setResultsVisible(true);
  assert.equal(last().heldCount, 1);
  assert.equal(last().answerCount, 2);
  assert.ok(states.every((s) => !/ＦＵＣＫ|fuck/.test(JSON.stringify(s))));
  const held = host.heldItems();
  assert.deepEqual(held, [{ key: hiddenKey('fuck'), text: 'ＦＵＣＫ', count: 2 }]);
  await host.release('s2', held[0].key);
  assert.equal(last().heldCount, 0);
  assert.ok(last().cloudItems.some((x) => x.count === 2));
  assert.equal(sessionOf(env, sid).host.released.s2[held[0].key], true);
  await say(env, sid, 's2', 'u3', ['Fuck']);
  assert.equal(last().heldCount, 0);
  await host.end();
  assert.deepEqual((await env.repo.getHistory(sid)).questions[0].heldWords, []);
  await host.stop();
});

test('自動チェック: 起動時の承認は正しい鍵・値だけ読み、終了時はサーバーと手元を合わせる', async () => {
  const env = setup();
  const sid = await begin(env, freeDeck());
  const path = `sessions/${sid}/host/released`;
  await env.net.set(path, { s2: { u1: '死ね', u2: 1, u3: 'x'.repeat(201), u4: true, 'bad.key': '死ね' }, 'bad.slide': { u1: '死ね' } });
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5']) await write(env, sid, 's2', uid, '死ね', 1);
  assert.equal(last().heldCount, 4);
  await host.release('s2', 'u2');
  // サーバーだけの承認は終了時に読む。手元で承認した u2 はサーバーの古い文より優先する。
  await env.net.set(path, { s2: { u2: '古い文', u3: '死ね' } });
  await host.end();
  const q = env.net.dump().teachers[UID].history[sid].questions[0];
  assert.deepEqual(q.texts, ['死ね', '死ね', '死ね']);
  assert.deepEqual(q.heldTexts, ['死ね', '死ね']);
  assert.equal(sessionOf(env, sid).host, undefined);
  await host.stop();
});

test('自動チェック: 終了は実行中の承認保存を待ち、後片づけで host が復活しない', async () => {
  const env = setup();
  const { sid, host } = await openFree(env);
  await write(env, sid, 's2', 'u1', '死ね', 1);
  const set = env.net.set;
  let resume;
  const wait = new Promise((resolve) => { resume = resolve; });
  env.net.set = async (path, value) => { if (path.includes('/released/')) await wait; return set(path, value); };
  const releasing = host.release('s2', 'u1');
  const ending = host.end();
  await settle();
  await assert.rejects(host.release('s2', 'u1'));
  resume();
  await releasing;
  await ending;
  assert.equal(sessionOf(env, sid).host, undefined);
  assert.deepEqual(env.net.dump().teachers[UID].history[sid].questions[0].texts, ['死ね']);
  await host.stop();
});

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

// ---- ワードクラウド ----
import { hiddenKey } from '../js/session-logic.js';

// s1 資料、s2 ワードクラウド、s3 自由記述、s4 アンケート（manual）
function cloudDeck() {
  let d = createDeck('雲の教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('cloud'), question: '好きな動物は？' }, 's2');
  d = addSlide(d, { ...createSlide('free'), question: '感想は？' }, 's3');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's4');
  return d;
}

const say = (env, sid, slideId, uid, words, at = 1) =>
  env.net.set(`sessions/${sid}/inbox/answers/${slideId}/${uid}`, { words, at });

// s2（ワードクラウド・受付中）にいる host を開く
async function openCloud(env, opts) {
  const sid = await begin(env, cloudDeck());
  const h = await openHost(env, sid, opts);
  await h.host.next(); await h.host.next();
  return { sid, ...h };
}

const cloudWords = (s) => (s.cloudItems || []).map((x) => `${x.word}:${x.count}`);

test('ワードクラウド: 結果を表示する前は、状態に言葉が 1 つも無い（人数だけ）', async () => {
  const env = setup();
  const { sid, host, states, last } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['ひみつA', 'ひみつB'], 10);
  await say(env, sid, 's2', 'u2', ['ひみつA'], 20);
  await say(env, sid, 's2', 'u2', ['ひみつC'], 30); // 書き直し
  await env.clock.advance(5000);
  assert.equal(last().kind, 'cloud');
  assert.equal(last().answerCount, 2);
  assert.equal(last().cloudItems, null);
  assert.equal(last().cloudMore, null);
  assert.equal(last().freeItems, null);
  for (const s of states) assert.ok(!JSON.stringify(s).includes('ひみつ'), '状態に言葉が入っている');
  host.stop();
});

test('ワードクラウド: 表示で cloudItems（人数の多い順）、結果をかくすと消える', async () => {
  const env = setup();
  const { sid, host, states, last } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['ねこ', 'いぬ'], 10);
  await say(env, sid, 's2', 'u2', ['ﾈｺ'], 20);
  await say(env, sid, 's2', 'u3', ['ネコ', 'ねこ'], 30);
  await host.setResultsVisible(true, 's2');
  // ねこ 2 人・ネコ 2 人（ﾈｺ と同じ）・いぬ 1 人。同じ人数なら鍵の順
  assert.deepEqual(last().cloudItems, [
    ...[{ key: hiddenKey('ねこ'), word: 'ねこ', count: 2 }, { key: hiddenKey('ネコ'), word: 'ﾈｺ', count: 2 }]
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    { key: hiddenKey('いぬ'), word: 'いぬ', count: 1 },
  ]);
  assert.equal(last().cloudMore, 0);
  assert.equal(last().answerCount, 3);
  assert.equal(sessionOf(env, sid).pub.polls.s2.resultsVisible, true);
  await host.setResultsVisible(false, 's2');
  assert.equal(last().cloudItems, null);
  assert.equal(last().cloudMore, null);
  const n = states.length;
  await say(env, sid, 's2', 'u4', ['ひみつ'], 40);
  await env.clock.advance(5000);
  for (const s of states.slice(n)) assert.ok(!JSON.stringify(s).includes('ひみつ'));
  assert.equal(last().answerCount, 4);
  host.stop();
});

test('ワードクラウド: 表示中の新しい回答は 500ms 以内の間隔でまとめて反映される', async () => {
  const env = setup();
  const { sid, host, last } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['一'], 10);
  await host.setResultsVisible(true, 's2');
  assert.deepEqual(cloudWords(last()), ['一:1']);
  await env.clock.advance(100);
  await say(env, sid, 's2', 'u2', ['一'], 20);
  assert.deepEqual(cloudWords(last()), ['一:1']); // まだ反映しない
  assert.equal(last().answerCount, 2); // 人数はすぐ変わる
  await env.clock.advance(CONFIG.resultsThrottleMs - 100);
  assert.deepEqual(cloudWords(last()), ['一:2']);
  await env.clock.advance(5000);
  assert.equal(env.clock.pending(), 0);
  host.stop();
});

test('ワードクラウド: hide で言葉が消え、人数は変わらない。あとから同じ言葉（全角・半角・大文字）が届いても出ない', async () => {
  const env = setup();
  const { sid, host, last } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['よい', 'Bad'], 10);
  await say(env, sid, 's2', 'u2', ['よい'], 20);
  await host.setResultsVisible(true, 's2');
  const key = last().cloudItems.find((x) => x.word === 'Bad').key;
  assert.equal(key, hiddenKey('Bad'));
  const p = host.hide('s2', key);
  assert.deepEqual(cloudWords(last()), ['よい:2']); // すぐに消える
  assert.equal(last().answerCount, 2);
  await p;
  assert.equal(last().hiddenUnsaved, false);
  assert.equal(sessionOf(env, sid).host.hidden.s2[key], true);
  await say(env, sid, 's2', 'u3', ['ＢＡＤ'], 30);
  await say(env, sid, 's2', 'u4', ['bad', 'いい'], 40);
  await env.clock.advance(5000);
  assert.deepEqual(cloudWords(last()), ['よい:2', 'いい:1']);
  assert.equal(last().answerCount, 4);
  host.stop();
});

test('ワードクラウド: 作り直した host（再読み込み）でも、かくした言葉が出ない', async () => {
  const env = setup();
  const a = await openCloud(env);
  const { sid } = a;
  await say(env, sid, 's2', 'u1', ['よい', 'Warui'], 10);
  await a.host.setResultsVisible(true, 's2');
  await a.host.hide('s2', hiddenKey('Warui'));
  await a.host.stop();
  const b = await openHost(env, sid);
  assert.equal(b.last().kind, 'cloud');
  assert.deepEqual(cloudWords(b.last()), ['よい:1']);
  await say(env, sid, 's2', 'u2', ['ｗａｒｕｉ'], 20);
  await env.clock.advance(5000);
  assert.deepEqual(cloudWords(b.last()), ['よい:1']);
  assert.equal(b.last().answerCount, 2);
  b.host.stop();
});

test('ワードクラウド: 書けていない hide も、同じ storage で作り直した host で出ず、再送されて書ける', async () => {
  const env = setup();
  const storage = memStorage();
  const a = await openCloud(env, { storage });
  const { sid } = a;
  await say(env, sid, 's2', 'u1', ['よい', 'a.b/c'], 10);
  await a.host.setResultsVisible(true, 's2');
  let fail = true;
  env.ctl.extraDeny = (op, path) => fail && op === 'set' && path.includes('/host/hidden/');
  const key = hiddenKey('a.b/c');
  a.host.hide('s2', key).catch(() => {});
  await settle();
  assert.equal(a.last().hiddenUnsaved, true);
  assert.deepEqual(JSON.parse(storage.getItem(storeKey(sid))), { s2: { [key]: true } });
  await a.host.stop();
  const b = await openHost(env, sid, { storage });
  assert.deepEqual(cloudWords(b.last()), ['よい:1']);
  fail = false;
  await env.clock.advance(CONFIG.reconnectDelayMs);
  assert.equal(b.last().hiddenUnsaved, false);
  assert.equal(sessionOf(env, sid).host.hidden.s2[key], true);
  b.host.stop();
});

test('ワードクラウド: 61 語あると cloudItems は 60 個で cloudMore は 1。かくすと残りが出る', async () => {
  const env = setup();
  const { sid, host, last } = await openCloud(env);
  // w00 は 3 人、w01 は 2 人、ほかは 1 人
  for (let i = 0; i < 61; i += 3) {
    await say(env, sid, 's2', `u${i}`, [i, i + 1, i + 2].filter((n) => n < 61).map((n) => `w${String(n).padStart(2, '0')}`), i);
  }
  await say(env, sid, 's2', 'x1', ['w00', 'w01'], 100);
  await say(env, sid, 's2', 'x2', ['w00'], 101);
  await host.setResultsVisible(true, 's2');
  assert.equal(last().cloudItems.length, CONFIG.cloud.maxShown);
  assert.equal(last().cloudMore, 1);
  assert.deepEqual(last().cloudItems.slice(0, 2).map((x) => `${x.word}:${x.count}`), ['w00:3', 'w01:2']);
  await host.hide('s2', hiddenKey('w00'));
  assert.equal(last().cloudItems.length, 60);
  assert.equal(last().cloudMore, 0);
  assert.equal(last().cloudItems[0].word, 'w01');
  host.stop();
});

test('ワードクラウドでは pub/results に何も書かず、pub に言葉が無い', async () => {
  const env = setup();
  const { sid, host } = await openCloud(env);
  await say(env, sid, 's2', 'u1', ['ことば'], 10);
  await host.setResultsVisible(true, 's2');
  await env.clock.advance(1000);
  await say(env, sid, 's2', 'u2', ['ことば2'], 20);
  await env.clock.advance(1000);
  await host.setResultsVisible(false, 's2');
  await host.setResultsVisible(true, 's2');
  await host.next(); // s3 へ（s2 は締切）
  await env.clock.advance(1000);
  const touches = env.updates.some((u) => Object.keys(u.patch).some((k) => k === 'results/s2' || k.startsWith('results/s2/')));
  assert.equal(touches, false);
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  for (const u of env.updates) assert.ok(!JSON.stringify(u.patch).includes('ことば'));
  assert.ok(!JSON.stringify(sessionOf(env, sid).pub).includes('ことば'));
  host.stop();
});

test('ワードクラウド: end() の履歴で hiddenWords に分かれ、uid も鍵も無く、後片づけのあと host が無い', async () => {
  const env = setup();
  const { sid, host, last } = await openCloud(env);
  await say(env, sid, 's2', 'uidA', ['ねこ', 'わるい'], 10);
  await say(env, sid, 's2', 'uidB', ['ねこ'], 20);
  await say(env, sid, 's2', 'uidC', ['いぬ', 'ﾜﾙｲ'], 30);
  await host.setResultsVisible(true, 's2');
  await host.hide('s2', hiddenKey('わるい'));
  env.ctl.extraDeny = (op, path) => op === 'set' && path.includes('/host/hidden/');
  host.hide('s2', hiddenKey('ﾜﾙｲ')).catch(() => {}); // まだ書けていないもの
  await settle();
  assert.equal(last().hiddenUnsaved, true);
  env.ctl.extraDeny = () => false;
  await host.end();
  const dump = env.net.dump();
  const hist = dump.teachers[UID].history[sid];
  const q = hist.questions.find((x) => x.slideId === 's2');
  assert.equal(q.type, 'cloud');
  assert.equal(q.question, '好きな動物は？');
  assert.deepEqual(q.words, [{ word: 'ねこ', count: 2 }, { word: 'いぬ', count: 1 }]);
  assert.deepEqual(
    [...q.hiddenWords].sort((a, b) => (a.word < b.word ? -1 : 1)),
    [{ word: 'わるい', count: 1 }, { word: 'ﾜﾙｲ', count: 1 }].sort((a, b) => (a.word < b.word ? -1 : 1)),
  );
  assert.equal(q.total, 3);
  const json = JSON.stringify(hist);
  assert.ok(!json.includes('uid'));
  assert.ok(!json.includes(hiddenKey('わるい')));
  assert.equal(dump.sessions[sid].host, undefined);
  assert.equal(dump.sessions[sid].inbox, undefined);
  assert.equal(last().phase, 'ended');
  host.stop();
});

test('ワードクラウド: hide は正しくない鍵・ワードクラウドでないスライドを拒む。自由記述の hide は今までどおり', async () => {
  const env = setup();
  const { sid, host, last } = await openCloud(env);
  await assert.rejects(host.hide('s2', 'a.b'));
  await assert.rejects(host.hide('s2', ''));
  await assert.rejects(host.hide('s4', hiddenKey('x')));
  await host.next(); // s3 自由記述
  await write(env, sid, 's3', 'u1', 'ぶん', 10);
  await host.setResultsVisible(true, 's3');
  assert.equal(last().kind, 'free');
  assert.equal(last().cloudItems, null);
  await host.hide('s3', 'u1');
  assert.deepEqual(last().freeItems, []);
  host.stop();
});

// ---- クイズ（quiz）と 5 段階評価（rating）----

// s1 資料、s2 クイズ（4 択。正解は 3 つ目 = 2）、s3 評価（manual）、s4 評価（live）
function quizDeck() {
  let d = createDeck('クイズの教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('quiz'), question: '富士山がある県は？', options: ['長野', '山梨', '静岡', '東京'], correct: 2 }, 's2');
  d = addSlide(d, { ...createSlide('rating'), question: '満足度は？', lowLabel: 'ふまん', highLabel: 'まんぞく' }, 's3');
  d = addSlide(d, { ...createSlide('rating'), question: 'むずかしさは？', resultMode: 'live' }, 's4');
  return d;
}

// s2（クイズ・受付中）にいる host を開く
async function openQuiz(env, opts) {
  const sid = await begin(env, quizDeck());
  const h = await openHost(env, sid, opts);
  await h.host.next(); await h.host.next();
  return { sid, ...h };
}

// 状態の中に、正解の番号を示す値（correct・correctRate）が無いか
const leaksCorrect = (s) => {
  let found = false;
  JSON.stringify(s, (k, v) => {
    if ((k === 'correct' || k === 'correctRate') && v !== null && v !== undefined) found = true;
    return v;
  });
  return found;
};

test('クイズ: 始めた授業の deck と pub に正解が無く、host/quiz にある', async () => {
  const env = setup();
  const sid = await begin(env, quizDeck());
  const s = sessionOf(env, sid);
  assert.ok(!JSON.stringify(s.deck).includes('correct'));
  assert.ok(!JSON.stringify(s.pub).includes('correct'));
  assert.deepEqual(s.host, { quiz: { s2: 2 } });
  assert.deepEqual(s.deck.slides.s3.options, ['1', '2', '3', '4', '5']);
});

test('クイズ: 表示の前は、状態に正解も内訳（counts）も無く、回答の人数だけ', async () => {
  const env = setup();
  const { sid, host, states, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 2);
  await answer(env, sid, 's2', 'u2', 0);
  await env.clock.advance(5000);
  assert.equal(last().kind, 'quiz');
  assert.equal(last().answerCount, 2);
  assert.deepEqual(last().tallies.s2, { total: 2 });
  assert.equal(last().correct, null);
  assert.equal(last().correctRate, null);
  for (const s of states) {
    assert.ok(!leaksCorrect(s), '状態に正解が入っている');
    assert.equal(s.tallies.s2 && s.tallies.s2.counts, undefined);
    assert.equal(Object.hasOwn(s.slides.s2 || {}, 'correct'), false);
  }
  assert.equal(sessionOf(env, sid).pub.results, undefined);
  host.stop();
});

test('クイズ: 正解を表示は 1 回の書きこみで締め切り、集計と正解を pub/results に書く', async () => {
  const env = setup();
  const { sid, host, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 2);
  await answer(env, sid, 's2', 'u2', 0);
  await answer(env, sid, 's2', 'u3', 2);
  const n = env.updates.length;
  await host.setResultsVisible(true, 's2');
  const writes = env.updates.slice(n);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch['polls/s2/status'], 'closed');
  assert.equal(writes[0].patch['polls/s2/resultsVisible'], true);
  assert.deepEqual(writes[0].patch['results/s2'], { counts: [1, 0, 2, 0], total: 3, correct: 2 });
  const pub = sessionOf(env, sid).pub;
  assert.equal(pub.polls.s2.status, 'closed');
  assert.deepEqual(pub.results.s2, { counts: [1, 0, 2, 0], total: 3, correct: 2 });
  assert.equal(last().correct, 2);
  assert.deepEqual(last().correctRate, { correctCount: 2, total: 3, percent: 67 });
  assert.deepEqual(last().tallies.s2, { counts: [1, 0, 2, 0], total: 3 });
  // 表示のあとの回答は、規則（締切）が拒否する
  await assert.rejects(answer(env, sid, 's2', 'u4', 2));
  await env.clock.advance(5000);
  assert.equal(sessionOf(env, sid).pub.results.s2.total, 3);
  host.stop();
});

test('クイズ: かくすと結果と正解が消え、締切のまま。もう一度表示できる', async () => {
  const env = setup();
  const { sid, host, states, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 1);
  await host.setResultsVisible(true, 's2');
  await host.setResultsVisible(false, 's2');
  let pub = sessionOf(env, sid).pub;
  assert.equal(pub.results, undefined);
  assert.equal(pub.polls.s2.status, 'closed');
  assert.equal(pub.polls.s2.resultsVisible, false);
  assert.equal(last().correct, null);
  assert.equal(last().correctRate, null);
  assert.deepEqual(last().tallies.s2, { total: 1 });
  assert.ok(!leaksCorrect(last()));
  // 停止・再開は締切のあとは効かない
  await host.setPaused(false, 's2');
  await host.setPaused(true, 's2');
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'closed');
  const n = states.length;
  await host.setResultsVisible(true, 's2');
  pub = sessionOf(env, sid).pub;
  assert.equal(pub.polls.s2.status, 'closed');
  assert.deepEqual(pub.results.s2, { counts: [0, 1, 0, 0], total: 1, correct: 2 });
  assert.equal(last().correct, 2);
  assert.deepEqual(last().correctRate, { correctCount: 0, total: 1, percent: 0 });
  assert.ok(states.length > n);
  host.stop();
});

test('クイズ: 次へで締め切ったあと戻っても、正解を表示できる（締切のまま）', async () => {
  const env = setup();
  const { sid, host, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 2);
  await host.next(); // s3 へ（s2 は締切）
  await host.prev(); // s2 に戻る
  assert.equal(last().pub.polls.s2.status, 'closed');
  const n = env.updates.length;
  await host.setResultsVisible(true, 's2');
  const w = env.updates.slice(n);
  assert.equal(w.length, 1);
  assert.equal(w[0].patch['polls/s2/status'], undefined); // すでに締切
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [0, 0, 1, 0], total: 1, correct: 2 });
  assert.equal(last().correct, 2);
  assert.deepEqual(last().correctRate, { correctCount: 1, total: 1, percent: 100 });
  host.stop();
});

test('クイズ: 締切の前に受け付けられた回答が遅れて届いたら、公開中の集計を直す', async () => {
  const env = setup();
  const { sid, host, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 2);
  await host.setResultsVisible(true, 's2');
  // 締切の前にサーバーが受け付けていた回答が、あとから届く
  env.ctl.bypass = true;
  await answer(env, sid, 's2', 'u2', 0);
  env.ctl.bypass = false;
  await env.clock.advance(500);
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [1, 0, 1, 0], total: 2, correct: 2 });
  assert.deepEqual(last().correctRate, { correctCount: 1, total: 2, percent: 50 });
  host.stop();
});

test('クイズ: 開き直した host も host/quiz から正解を読む', async () => {
  const env = setup();
  const { sid, host } = await openQuiz(env);
  await answer(env, sid, 's2', 'u1', 2);
  host.stop();
  const b = await openHost(env, sid);
  assert.equal(b.last().correct, null);
  await b.host.setResultsVisible(true, 's2');
  assert.equal(sessionOf(env, sid).pub.results.s2.correct, 2);
  assert.equal(b.last().correct, 2);
  b.host.stop();
});

test('評価: 表示中は average が入る。かくしている間は null。live の評価は着いたときから書く', async () => {
  const env = setup();
  const { sid, host, last } = await openQuiz(env);
  await host.next(); // s3 評価（manual）
  assert.equal(last().kind, 'rating');
  await answer(env, sid, 's3', 'u1', 4);
  await answer(env, sid, 's3', 'u2', 1);
  await answer(env, sid, 's3', 'u3', 2);
  assert.deepEqual(last().tallies.s3, { counts: [0, 1, 1, 0, 1], total: 3 });
  assert.equal(last().answerCount, 3);
  assert.equal(last().average, null);
  await host.setResultsVisible(true, 's3');
  assert.equal(last().average, 3.3);
  assert.deepEqual(sessionOf(env, sid).pub.results.s3, { counts: [0, 1, 1, 0, 1], total: 3 });
  assert.equal(sessionOf(env, sid).pub.polls.s3.status, 'open'); // 評価は表示で締め切らない
  assert.equal(last().correct, null);
  await host.setResultsVisible(false, 's3');
  assert.equal(last().average, null);
  await host.next(); // s4 評価（live）
  await settle();
  assert.deepEqual(sessionOf(env, sid).pub.results.s4, { counts: [0, 0, 0, 0, 0], total: 0 });
  assert.equal(last().average, null); // 0 人
  await answer(env, sid, 's4', 'u1', 0);
  await env.clock.advance(500);
  assert.deepEqual(sessionOf(env, sid).pub.results.s4, { counts: [1, 0, 0, 0, 0], total: 1 });
  assert.equal(last().average, 1);
  host.stop();
});

test('クイズ・評価: end() の履歴に正解と正解の人数、評価の平均。host/quiz を読み直し、後片づけで host が消える', async () => {
  const env = setup();
  const { sid, host, last } = await openQuiz(env);
  await answer(env, sid, 's2', 'uidA', 2);
  await answer(env, sid, 's2', 'uidB', 1);
  await host.next(); // s3
  await answer(env, sid, 's3', 'uidA', 4);
  await answer(env, sid, 's3', 'uidB', 3);
  const gets = [];
  const origGet = env.net.get;
  env.net.get = async (path) => { gets.push(path); return origGet(path); };
  await host.end();
  assert.ok(gets.includes(`sessions/${sid}/host/quiz`));
  const dump = env.net.dump();
  const hist = dump.teachers[UID].history[sid];
  const q = hist.questions.find((x) => x.slideId === 's2');
  assert.deepEqual(q, {
    slideId: 's2', type: 'quiz', question: '富士山がある県は？', options: ['長野', '山梨', '静岡', '東京'],
    counts: [0, 1, 1, 0], total: 2, correct: 2, correctCount: 1,
  });
  const r = hist.questions.find((x) => x.slideId === 's3');
  assert.deepEqual(r, {
    slideId: 's3', type: 'rating', question: '満足度は？', lowLabel: 'ふまん', highLabel: 'まんぞく',
    counts: [0, 0, 0, 1, 1], total: 2, average: 4.5,
  });
  const r4 = hist.questions.find((x) => x.slideId === 's4');
  assert.equal(r4.total, 0);
  assert.ok(!JSON.stringify(hist).includes('uid'));
  assert.equal(dump.sessions[sid].host, undefined);
  assert.equal(dump.sessions[sid].deck, undefined);
  assert.equal(last().phase, 'ended');
  host.stop();
});

test('クイズの無い授業の end() は host/quiz を読まない', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host } = await openHost(env, sid);
  const gets = [];
  const origGet = env.net.get;
  env.net.get = async (path) => { gets.push(path); return origGet(path); };
  await host.end();
  assert.ok(!gets.some((p) => p.endsWith('/host/quiz')));
  host.stop();
});

test('アンケートは今までどおり: tallies に counts、correct・average は null', async () => {
  const env = setup();
  const sid = await begin(env);
  const { host, last } = await openHost(env, sid);
  await host.next(); await host.next();
  await answer(env, sid, 's2', 'u1', 1);
  await host.setResultsVisible(true, 's2');
  assert.deepEqual(last().tallies.s2, { counts: [0, 1], total: 1 });
  assert.deepEqual(sessionOf(env, sid).pub.results.s2, { counts: [0, 1], total: 1 });
  assert.equal(sessionOf(env, sid).pub.polls.s2.status, 'open');
  assert.equal(last().correct, null);
  assert.equal(last().correctRate, null);
  assert.equal(last().average, null);
  host.stop();
});
