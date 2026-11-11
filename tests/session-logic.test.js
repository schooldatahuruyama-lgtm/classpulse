import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import {
  buildSession, goToPatch, nextPatch, prevPatch, pausePatch, resultsVisiblePatch,
  tally, percent, applyPatch, closeAllPatch, endPatch, buildHistory,
} from '../js/session-logic.js';

// 3 枚の教材: s1 資料、s2 アンケート(2択・manual)、s3 アンケート(3択・live)
function makeDeck() {
  let d = createDeck('テスト教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな数は？', options: ['1', '2', '3'], resultMode: 'live' }, 's3');
  return d;
}

function start() {
  const deck = makeDeck();
  const session = buildSession(deck, 'deck1', 'uid1', 5000);
  return { deck, session, pub: session.pub, order: session.deck.order };
}

// パッチがあれば当てて、なければそのまま返す
function step(pub, patch) {
  return patch ? applyPatch(pub, patch) : pub;
}

test('始めたときは参加の画面で、質問は待機中', () => {
  const { session, deck } = start();
  assert.equal(session.owner, 'uid1');
  assert.equal(session.deckId, 'deck1');
  assert.equal(session.startedAt, 5000);
  assert.deepEqual(session.deck.order, deck.order);
  assert.equal(session.pub.title, 'テスト教材');
  assert.equal(session.pub.state, 'live');
  assert.deepEqual(session.pub.current, { slideId: '', index: -1 });
  assert.deepEqual(session.pub.polls.s2, { status: 'waiting', resultsVisible: false });
  assert.equal(session.pub.polls.s3.resultsVisible, true);
  assert.equal(session.pub.polls.s1, undefined);
});

test('アンケートに着くと受付中になる', () => {
  const { pub, order } = start();
  let p = step(pub, nextPatch(pub, order));
  assert.equal(p.current.slideId, 's1');
  p = step(p, nextPatch(p, order));
  assert.equal(p.polls.s2.status, 'open');
  assert.deepEqual(p.current, { slideId: 's2', index: 1 });
});

test('次へ進むと前の質問は締切', () => {
  const { pub, order } = start();
  let p = step(pub, nextPatch(pub, order));
  p = step(p, nextPatch(p, order));
  const patch = nextPatch(p, order);
  assert.equal(patch['polls/s2/status'], 'closed');
  assert.equal(patch['polls/s3/status'], 'open');
  assert.deepEqual(patch.current, { slideId: 's3', index: 2 });
  const q = applyPatch(p, patch);
  assert.equal(q.polls.s2.status, 'closed');
  assert.equal(q.polls.s3.status, 'open');
  assert.equal(q.current.slideId, 's3');
});

test('前へ戻っても締切のまま', () => {
  const { pub, order } = start();
  let p = pub;
  for (let i = 0; i < 3; i++) p = step(p, nextPatch(p, order));
  const patch = prevPatch(p, order);
  assert.equal('polls/s2/status' in patch, false);
  assert.equal(patch['polls/s3/status'], 'closed');
  p = applyPatch(p, patch);
  assert.equal(p.polls.s2.status, 'closed');
  assert.equal(p.polls.s3.status, 'closed');
  p = step(p, nextPatch(p, order));
  assert.equal(p.polls.s3.status, 'closed');
  assert.equal(p.polls.s2.status, 'closed');
});

test('端では動かない', () => {
  const { pub, order } = start();
  let p = pub;
  for (let i = 0; i < 3; i++) p = step(p, nextPatch(p, order));
  assert.equal(nextPatch(p, order), null);
  assert.equal(goToPatch(p, order, 2), null);
  p = applyPatch(p, goToPatch(p, order, 0));
  assert.equal(prevPatch(p, order), null);
  assert.equal(goToPatch(p, order, 0), null);
  assert.equal(goToPatch(p, order, -1), null);
  assert.equal(goToPatch(p, order, 3), null);
});

test('参加の画面からの next は 0 枚目へ、prev は動かない', () => {
  const { pub, order } = start();
  assert.deepEqual(nextPatch(pub, order).current, { slideId: 's1', index: 0 });
  assert.equal(prevPatch(pub, order), null);
});

test('受付の停止と再開は締切前だけ', () => {
  const { pub, order } = start();
  assert.equal(pausePatch(pub, 's2', true), null); // 待機中
  let p = pub;
  for (let i = 0; i < 2; i++) p = step(p, nextPatch(p, order));
  const paused = applyPatch(p, pausePatch(p, 's2', true));
  assert.equal(paused.polls.s2.status, 'paused');
  const resumed = applyPatch(paused, pausePatch(paused, 's2', false));
  assert.equal(resumed.polls.s2.status, 'open');
  const closed = step(p, nextPatch(p, order));
  assert.equal(pausePatch(closed, 's2', true), null);
  assert.equal(pausePatch(closed, 's2', false), null);
});

test('停止中に次へ進むと締切', () => {
  const { pub, order } = start();
  let p = pub;
  for (let i = 0; i < 2; i++) p = step(p, nextPatch(p, order));
  p = applyPatch(p, pausePatch(p, 's2', true));
  p = applyPatch(p, nextPatch(p, order));
  assert.equal(p.polls.s2.status, 'closed');
  assert.equal(p.polls.s3.status, 'open');
});

test('結果をかくすと集計も消す', () => {
  const { pub, order } = start();
  assert.equal(resultsVisiblePatch(pub, 's2', true), null); // 待機中
  let p = pub;
  for (let i = 0; i < 2; i++) p = step(p, nextPatch(p, order));
  p = applyPatch(p, resultsVisiblePatch(p, 's2', true));
  assert.equal(p.polls.s2.resultsVisible, true);
  assert.deepEqual(resultsVisiblePatch(p, 's2', false), {
    'polls/s2/resultsVisible': false,
    'results/s2': null,
  });
});

test('集計は 1 人 1 件、変な値は数えない', () => {
  assert.deepEqual(
    tally({ a: { choice: 0 }, b: { choice: 1 }, c: { choice: 1 }, d: { choice: 5 }, e: { choice: '1' }, f: {} }, 2),
    { counts: [1, 2], total: 3 },
  );
  assert.deepEqual(tally(null, 2), { counts: [0, 0], total: 0 });
  assert.deepEqual(tally({ a: { choice: -1 }, b: { choice: 0.5 } }, 2), { counts: [0, 0], total: 0 });
});

test('割合', () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(0, 0), 0);
});

test('applyPatch は入れ子のパス・オブジェクト・削除を扱い、元を書きかえない', () => {
  const { pub } = start();
  const frozen = JSON.parse(JSON.stringify(pub));
  let p = applyPatch(pub, { 'results/s2': { counts: [1, 0], total: 1 }, 'polls/s2/status': 'open' });
  assert.deepEqual(pub, frozen);
  assert.equal(p.polls.s2.status, 'open');
  assert.deepEqual(p.results.s2, { counts: [1, 0], total: 1 });
  p = applyPatch(p, { 'results/s2': null });
  assert.equal(p.results?.s2, undefined);
  p = applyPatch(p, { current: { slideId: 's3', index: 2 } });
  assert.deepEqual(p.current, { slideId: 's3', index: 2 });
});

test('すべて締め切る', () => {
  const { pub, order } = start();
  let p = pub;
  for (let i = 0; i < 2; i++) p = step(p, nextPatch(p, order)); // s2 受付中、s3 待機中
  p = applyPatch(p, pausePatch(p, 's2', true));
  const patch = closeAllPatch(p);
  assert.equal(patch['polls/s2/status'], 'closed');
  assert.equal(patch['polls/s3/status'], 'closed');
  const q = applyPatch(p, patch);
  assert.equal(q.polls.s2.status, 'closed');
  assert.equal(q.polls.s3.status, 'closed');
  assert.equal(q.state, 'live');
  assert.equal(closeAllPatch(q), null);
});

test('授業の終了', () => {
  const { pub, order } = start();
  let p = pub;
  for (let i = 0; i < 2; i++) p = step(p, nextPatch(p, order));
  p = applyPatch(p, { 'results/s2': { counts: [1, 0], total: 1 } });
  const q = applyPatch(p, endPatch(p));
  assert.equal(q.state, 'ended');
  assert.equal(q.polls.s2.status, 'closed');
  assert.equal(q.polls.s3.status, 'closed');
  assert.equal(q.results, undefined);
});

test('履歴', () => {
  const { session } = start();
  const inbox = {
    participants: { u1: true, u2: true, u3: true },
    answers: { s2: { u1: { choice: 0 }, u2: { choice: 1 }, u3: { choice: 1 } } },
  };
  const h = buildHistory(session, inbox, 9000);
  assert.equal(h.title, 'テスト教材');
  assert.equal(h.deckId, 'deck1');
  assert.equal(h.startedAt, 5000);
  assert.equal(h.endedAt, 9000);
  assert.equal(h.participants, 3);
  assert.equal(h.questions.length, 2);
  assert.deepEqual(h.questions[0], { slideId: 's2', question: '好きな色は？', options: ['赤', '青'], counts: [1, 2], total: 3 });
  assert.deepEqual(h.questions[1].counts, [0, 0, 0]);
  assert.equal(h.questions[1].total, 0);
  const none = buildHistory(session, null, 9000);
  assert.equal(none.participants, 0);
  assert.equal(none.questions.length, 2);
});
