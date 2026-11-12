import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet } from './helpers/fake-net.js';
import { createRepo } from '../js/repo.js';
import { createDeck, createSlide, addSlide } from '../js/model.js';

function setup() {
  const net = createFakeNet();
  const repo = createRepo(net, 'u1');
  return { net, repo };
}

function sampleDeck(title = '算数') {
  let deck = createDeck(title, 1);
  deck = addSlide(deck, createSlide('content'), 's1');
  deck = addSlide(deck, createSlide('poll'), 's2');
  return deck;
}

test('保存すると一覧にも出る', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 5000);
  assert.deepEqual(await repo.listDecks(), [{ id: 'd1', title: '算数', updatedAt: 5000, slideCount: 2 }]);
  const loaded = await repo.loadDeck('d1');
  assert.equal(loaded.updatedAt, 5000);
  assert.deepEqual(loaded.order, ['s1', 's2']);
});

test('教材と一覧は 1 回の update で書く', async () => {
  const { net, repo } = setup();
  const calls = [];
  const orig = net.update.bind(net);
  net.update = (path, patch) => { calls.push([path, Object.keys(patch).sort()]); return orig(path, patch); };
  net.set = async () => { throw new Error('set は使わない'); };
  await repo.saveDeck('d1', sampleDeck(), 5000);
  await repo.deleteDeck('d1');
  assert.deepEqual(calls, [
    ['teachers/u1', ['deckIndex/d1', 'decks/d1']],
    ['teachers/u1', ['deckIndex/d1', 'decks/d1']],
  ]);
});

test('スライドのない教材を保存して読み直せる', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', createDeck('空', 1), 7);
  const loaded = await repo.loadDeck('d1');
  assert.deepEqual(loaded.order, []);
  assert.deepEqual(loaded.slides, {});
  assert.deepEqual(loaded.images, {});
  assert.equal(loaded.title, '空');
  assert.deepEqual(await repo.listDecks(), [{ id: 'd1', title: '空', updatedAt: 7, slideCount: 0 }]);
});

test('消すと一覧からも消える', async () => {
  const { net, repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 5000);
  await repo.deleteDeck('d1');
  assert.deepEqual(await repo.listDecks(), []);
  assert.equal(await repo.loadDeck('d1'), null);
  assert.equal(net.dump(), null);
});

test('無い教材は null', async () => {
  const { repo } = setup();
  assert.equal(await repo.loadDeck('nothing'), null);
});

test('一覧は新しい順', async () => {
  const { repo } = setup();
  await repo.saveDeck('a', sampleDeck('A'), 100);
  await repo.saveDeck('b', sampleDeck('B'), 300);
  await repo.saveDeck('c', sampleDeck('C'), 200);
  assert.deepEqual((await repo.listDecks()).map((d) => d.id), ['b', 'c', 'a']);
});

test('保存しても渡した教材は書きかわらない', async () => {
  const { repo } = setup();
  const deck = sampleDeck();
  await repo.saveDeck('d1', deck, 5000);
  assert.equal(deck.updatedAt, 1);
});

test('授業中の教材の指し先を保存・取得・消去できる', async () => {
  const { repo } = setup();
  assert.equal(await repo.getActive(), null);
  await repo.setActive({ sid: 'S1', deckId: 'd1', startedAt: 10 });
  assert.deepEqual(await repo.getActive(), { sid: 'S1', deckId: 'd1', startedAt: 10 });
  await repo.setActive(null);
  assert.equal(await repo.getActive(), null);
});

test('履歴の保存・一覧・削除', async () => {
  const { net, repo } = setup();
  const h = (title, endedAt, participants) => ({
    title, deckId: 'd1', startedAt: endedAt - 10, endedAt, participants,
    questions: [{ slideId: 's2', question: 'Q', options: ['a', 'b'], counts: [1, 2], total: 3 }],
  });
  await repo.saveHistory('S1', h('一回目', 100, 5));
  await repo.saveHistory('S2', h('二回目', 200, 7));
  assert.deepEqual(await repo.listHistory(), [
    { sid: 'S2', title: '二回目', endedAt: 200, participants: 7 },
    { sid: 'S1', title: '一回目', endedAt: 100, participants: 5 },
  ]);
  assert.equal((await repo.getHistory('S1')).questions[0].total, 3);
  assert.equal(await repo.getHistory('nope'), null);

  await net.set('sessions/S1', { state: 'ended' });
  await repo.deleteHistory('S1');
  assert.equal(await repo.getHistory('S1'), null);
  assert.equal(await net.get('sessions/S1'), null);
  assert.deepEqual((await repo.listHistory()).map((x) => x.sid), ['S2']);
});

test('履歴の削除は 1 回の update で、失敗したら履歴も授業も残る', async () => {
  const net = createFakeNet({ deny: (op) => op === 'update' });
  const repo = createRepo(net, 'u1');
  await repo.saveHistory('S1', { title: 'T', deckId: 'd1', startedAt: 1, endedAt: 2, participants: 1, questions: [] });
  await net.set('sessions/S1', { state: 'ended' });
  await assert.rejects(() => repo.deleteHistory('S1'));
  assert.notEqual(await repo.getHistory('S1'), null);
  assert.deepEqual(await net.get('sessions/S1'), { state: 'ended' });
});

test('質問のない履歴は questions: [] で読み戻せる', async () => {
  const { repo } = setup();
  await repo.saveHistory('S1', { title: 'T', deckId: 'd1', startedAt: 1, endedAt: 2, participants: 0, questions: [] });
  const h = await repo.getHistory('S1');
  assert.deepEqual(h.questions, []);
  assert.equal(h.participants, 0);
});

test('履歴の質問の options と counts は配列で返る', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: { 0: { slideId: 'a', question: 'Q', options: { 0: 'x', 1: 'y' }, counts: { 1: 4 }, total: 4 } },
  });
  const h = await repo.getHistory('S1');
  assert.deepEqual(h.questions[0].options, ['x', 'y']);
  assert.deepEqual(h.questions[0].counts, [0, 4]);
  assert.equal(h.participants, 0);
});

test('選択肢が多く疎なオブジェクトで返る counts も、添字の位置を保って 0 で埋める', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [{ slideId: 'a', question: 'Q', options: ['a', 'b', 'c', 'd', 'e', 'f'], counts: { 5: 2 } }],
  });
  const q = (await repo.getHistory('S1')).questions[0];
  assert.deepEqual(q.counts, [0, 0, 0, 0, 0, 2]);
  assert.equal(q.total, 0);
});

test('履歴が無ければ一覧は空', async () => {
  const { repo } = setup();
  assert.deepEqual(await repo.listHistory(), []);
});

test('登録されていない uid は先生でない', async () => {
  const { net, repo } = setup();
  assert.equal(await repo.isTeacher(), false);
  await net.set('teacherList/u1', true);
  assert.equal(await repo.isTeacher(), true);
  assert.equal(await createRepo(net, 'u2').isTeacher(), false);
});

// ---- 終了の後片づけが途中で止まった授業（履歴と「発表中」の印が両方ある） ----

test('履歴を消すとき、その授業を指す「発表中」の印も同じ update で消す', async () => {
  const { net, repo } = setup();
  await repo.saveHistory('S1', { title: 'T', deckId: 'd1', startedAt: 1, endedAt: 2, participants: 1, questions: [] });
  await net.set('sessions/S1', { owner: 'u1', pub: { state: 'ended' } });
  await repo.setActive({ sid: 'S1', deckId: 'd1', startedAt: 1 });
  const calls = [];
  const orig = net.update.bind(net);
  net.update = (path, patch) => { calls.push([path, Object.keys(patch).sort()]); return orig(path, patch); };
  net.remove = async () => { throw new Error('remove は使わない（1 回の update で消す）'); };
  await repo.deleteHistory('S1');
  assert.deepEqual(calls, [['', ['sessions/S1', 'teachers/u1/active', 'teachers/u1/history/S1']]]);
  assert.equal(await repo.getActive(), null);
  assert.equal(await net.get('sessions/S1'), null);
});

test('履歴を消しても、別の授業を指す「発表中」の印は残す', async () => {
  const { net, repo } = setup();
  await repo.saveHistory('S1', { title: 'T', deckId: 'd1', startedAt: 1, endedAt: 2, participants: 1, questions: [] });
  await net.set('sessions/S1', { owner: 'u1', pub: { state: 'ended' } });
  await repo.setActive({ sid: 'S2', deckId: 'd1', startedAt: 5 });
  await repo.deleteHistory('S1');
  assert.deepEqual(await repo.getActive(), { sid: 'S2', deckId: 'd1', startedAt: 5 });
});

test('clearActiveIf: 印がその授業を指しているときだけ外す', async () => {
  const { repo } = setup();
  await repo.setActive({ sid: 'S1', deckId: 'd1', startedAt: 1 });
  assert.equal(await repo.clearActiveIf('S2'), false);
  assert.equal((await repo.getActive()).sid, 'S1');
  assert.equal(await repo.clearActiveIf('S1'), true);
  assert.equal(await repo.getActive(), null);
  assert.equal(await repo.clearActiveIf('S1'), false);
});

test('type の無い古い履歴は poll として読める', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [{ slideId: 'a', question: 'Q', options: ['x', 'y'], counts: [1, 2], total: 3 }],
  });
  const q = (await repo.getHistory('S1')).questions[0];
  assert.equal(q.type, 'poll');
  assert.deepEqual(q.options, ['x', 'y']);
});

test('free の履歴の texts・hiddenTexts は配列に正される', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [
      { slideId: 'f', type: 'free', question: 'Q', texts: { 0: 'あ', 1: 'い' }, total: 3 },
      { slideId: 'g', type: 'free', question: 'R', total: 0 },
    ],
  });
  const qs = (await repo.getHistory('S1')).questions;
  assert.equal(qs[0].type, 'free');
  assert.deepEqual(qs[0].texts, ['あ', 'い']);
  assert.deepEqual(qs[0].hiddenTexts, []);
  assert.equal(qs[0].total, 3);
  assert.deepEqual(qs[1].texts, []);
  assert.deepEqual(qs[1].hiddenTexts, []);
});

test('cloud の履歴の words・hiddenWords は配列に正され、各要素は { word, count }', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [
      {
        slideId: 'c', type: 'cloud', question: 'Q',
        words: { 0: { word: 'ねこ', count: 2 }, 2: { word: 'いぬ', count: '1' }, 3: 'へん', 4: { count: 1 } },
        hiddenWords: [{ word: 'わるい', count: 1 }],
        total: 3,
      },
      { slideId: 'd', type: 'cloud', question: 'R', total: 0 },
    ],
  });
  const qs = (await repo.getHistory('S1')).questions;
  assert.equal(qs[0].type, 'cloud');
  assert.equal(qs[0].question, 'Q');
  assert.deepEqual(qs[0].words, [{ word: 'ねこ', count: 2 }, { word: 'いぬ', count: 0 }]);
  assert.deepEqual(qs[0].hiddenWords, [{ word: 'わるい', count: 1 }]);
  assert.equal(qs[0].total, 3);
  assert.deepEqual(qs[1].words, []);
  assert.deepEqual(qs[1].hiddenWords, []);
  assert.equal(qs[1].total, 0);
});

test('quiz の履歴は options・counts を配列に、correct を番号か null に、correctCount を数に正す', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [
      { slideId: 'q', type: 'quiz', question: 'Q', options: { 0: 'a', 1: 'b', 2: 'c' }, counts: { 1: 2 }, total: 3, correct: 1, correctCount: 2 },
      // データベースは null を落とす（正解の分からないクイズ）
      { slideId: 'q2', type: 'quiz', question: 'R', options: ['a', 'b'], total: 0 },
      { slideId: 'q3', type: 'quiz', question: 'S', options: ['a', 'b'], counts: [1, 1], total: 2, correct: 5, correctCount: 'x' },
    ],
  });
  const qs = (await repo.getHistory('S1')).questions;
  assert.equal(qs[0].type, 'quiz');
  assert.equal(qs[0].question, 'Q');
  assert.deepEqual(qs[0].options, ['a', 'b', 'c']);
  assert.deepEqual(qs[0].counts, [0, 2, 0]);
  assert.equal(qs[0].total, 3);
  assert.equal(qs[0].correct, 1);
  assert.equal(qs[0].correctCount, 2);
  assert.deepEqual(qs[1].counts, [0, 0]);
  assert.equal(qs[1].correct, null);
  assert.equal(qs[1].correctCount, 0);
  assert.equal(qs[2].correct, null); // 範囲外
  assert.equal(qs[2].correctCount, 0);
});

test('rating の履歴は counts を 5 個の数の配列に、average を数か null に、言葉を文字列に正す', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [
      { slideId: 'r', type: 'rating', question: 'Q', lowLabel: 'ひくい', highLabel: 'たかい', counts: { 0: 1, 4: 2 }, total: 3, average: 3.7 },
      { slideId: 'r2', type: 'rating', question: 'R', total: 0 },
      { slideId: 'r3', type: 'rating', question: 'S', lowLabel: 3, counts: [1, 'x', 0, 0, 0, 9], total: 1, average: 'x' },
    ],
  });
  const qs = (await repo.getHistory('S1')).questions;
  assert.equal(qs[0].type, 'rating');
  assert.equal(qs[0].lowLabel, 'ひくい');
  assert.equal(qs[0].highLabel, 'たかい');
  assert.deepEqual(qs[0].counts, [1, 0, 0, 0, 2]);
  assert.equal(qs[0].total, 3);
  assert.equal(qs[0].average, 3.7);
  assert.deepEqual(qs[1].counts, [0, 0, 0, 0, 0]);
  assert.equal(qs[1].average, null);
  assert.equal(qs[1].lowLabel, '');
  assert.equal(qs[1].highLabel, '');
  assert.deepEqual(qs[2].counts, [1, 0, 0, 0, 0]);
  assert.equal(qs[2].average, null);
  assert.equal(qs[2].lowLabel, '');
});

test('アンケート・自由記述・ワードクラウドとまざった履歴も、それぞれの形で読める', async () => {
  const { net, repo } = setup();
  await net.set('teachers/u1/history/S1', {
    title: 'T', endedAt: 2,
    questions: [
      { slideId: 'a', question: 'Q', options: ['x', 'y'], counts: [1, 2], total: 3 },
      { slideId: 'q', type: 'quiz', question: 'Q', options: ['a', 'b'], counts: [1, 0], total: 1, correct: 0, correctCount: 1 },
      { slideId: 'r', type: 'rating', question: 'R', counts: [0, 0, 1, 0, 0], total: 1, average: 3 },
      { slideId: 'f', type: 'free', question: 'F', texts: ['あ'], total: 1 },
    ],
  });
  const qs = (await repo.getHistory('S1')).questions;
  assert.deepEqual(qs.map((q) => q.type), ['poll', 'quiz', 'rating', 'free']);
  assert.deepEqual(qs[0].counts, [1, 2]);
  assert.equal(qs[0].correct, undefined);
});
