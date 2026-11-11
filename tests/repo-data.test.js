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
