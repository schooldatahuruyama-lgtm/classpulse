import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet } from './helpers/fake-net.js';
import { createRepo } from '../js/repo.js';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { isTrashed, isExpired, daysLeft } from '../js/trash.js';
import { CONFIG } from '../js/config.js';
import { createBackgroundSaver } from '../js/views/editor/background-save.js';

const DAY = 86400000;
const T0 = 1800000000000;

function setup() {
  const net = createFakeNet();
  return { net, repo: createRepo(net, 'u1') };
}

function sampleDeck(title = '算数') {
  let deck = createDeck(title, 1);
  deck = addSlide(deck, createSlide('content'), 's1');
  return deck;
}

test('ゴミ箱に残す日数は 30 日', () => {
  assert.equal(CONFIG.trash.keepDays, 30);
});

test('isTrashed: 印があればゴミ箱の中', () => {
  assert.equal(isTrashed({ title: 'a' }), false);
  assert.equal(isTrashed({ title: 'a', deletedAt: T0 }), true);
  assert.equal(isTrashed({ deletedAt: 'こわれた値' }), true);
  assert.equal(isTrashed({ deletedAt: false }), true);
  assert.equal(isTrashed({ deletedAt: 0 }), true);
  assert.equal(isTrashed({ deletedAt: null }), false);
  assert.equal(isTrashed(null), false);
  assert.equal(isTrashed('x'), false);
});

test('isExpired: 30 日たったら true。数でない・未来の時刻は false', () => {
  assert.equal(isExpired(T0, T0 + 29 * DAY), false);
  assert.equal(isExpired(T0, T0 + 30 * DAY - 1), false);
  assert.equal(isExpired(T0, T0 + 30 * DAY), true);
  assert.equal(isExpired(T0, T0 + 400 * DAY), true);
  assert.equal(isExpired('x', T0), false);
  assert.equal(isExpired(null, T0), false);
  assert.equal(isExpired(NaN, T0), false);
  assert.equal(isExpired(T0 + DAY, T0), false);
  assert.equal(isExpired(T0, NaN), false);
});

test('daysLeft: 残りの日数（切り上げ、0〜30）', () => {
  assert.equal(daysLeft(T0, T0), 30);
  assert.equal(daysLeft(T0, T0 + 1), 30);
  assert.equal(daysLeft(T0, T0 + DAY), 29);
  assert.equal(daysLeft(T0, T0 + 29 * DAY + 1), 1);
  assert.equal(daysLeft(T0, T0 + 30 * DAY), 0);
  assert.equal(daysLeft(T0, T0 + 99 * DAY), 0);
  assert.equal(daysLeft('x', T0), 30);
  assert.equal(daysLeft(T0 + 5 * DAY, T0), 30);
});

test('ゴミ箱に移すと一覧から消えてゴミ箱に出る。教材の中身は動かさない', async () => {
  const { net, repo } = setup();
  await repo.saveDeck('d1', sampleDeck('A'), 100);
  await repo.saveDeck('d2', sampleDeck('B'), 200);
  const touched = [];
  for (const m of ['get', 'set', 'update', 'remove']) {
    const orig = net[m].bind(net);
    net[m] = (path, ...rest) => { touched.push(`${m} ${path} ${rest[0] && typeof rest[0] === 'object' ? Object.keys(rest[0]).join(',') : ''}`); return orig(path, ...rest); };
  }
  await repo.trashDeck('d1', T0);
  assert.ok(touched.length > 0);
  for (const t of touched) assert.doesNotMatch(t, /decks\//, t);
  assert.deepEqual((await repo.listDecks()).map((d) => d.id), ['d2']);
  assert.deepEqual(await repo.listTrash(), [{ id: 'd1', title: 'A', slideCount: 1, deletedAt: T0 }]);
  assert.notEqual(net.dump().teachers.u1.decks.d1, undefined);
});

test('ゴミ箱の教材は loadDeck が null。戻すと読める', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', sampleDeck('A'), 100);
  await repo.trashDeck('d1', T0);
  assert.equal(await repo.loadDeck('d1'), null);
  await repo.restoreDeck('d1');
  const deck = await repo.loadDeck('d1');
  assert.equal(deck.title, 'A');
  assert.deepEqual(await repo.listDecks(), [{ id: 'd1', title: 'A', updatedAt: 100, slideCount: 1 }]);
  assert.deepEqual(await repo.listTrash(), []);
});

test('ゴミ箱の教材を（別のタブが）保存しても、ゴミ箱の印は消えない', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', sampleDeck('A'), 100);
  await repo.trashDeck('d1', T0);
  await repo.saveDeck('d1', sampleDeck('書きかえた'), 300);
  assert.deepEqual(await repo.listDecks(), []);
  assert.deepEqual(await repo.listTrash(), [{ id: 'd1', title: '書きかえた', slideCount: 1, deletedAt: T0 }]);
});

test('ゴミ箱は新しく入れた順。時刻がこわれた項目も出す（deletedAt は null）', async () => {
  const { net, repo } = setup();
  for (const id of ['a', 'b', 'c']) await repo.saveDeck(id, sampleDeck(id), 100);
  await repo.trashDeck('a', T0);
  await repo.trashDeck('b', T0 + 500);
  await net.set('teachers/u1/deckIndex/c/deletedAt', 'こわれた値');
  const list = await repo.listTrash();
  assert.deepEqual(list.map((d) => d.id), ['b', 'a', 'c']);
  assert.equal(list[2].deletedAt, null);
});

test('完全に削除すると、教材も一覧の項目も消える', async () => {
  const { net, repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 100);
  await repo.trashDeck('d1', T0);
  await repo.deleteDeck('d1');
  assert.deepEqual(await repo.listTrash(), []);
  assert.equal(net.dump(), null);
});

test('ゴミ箱を空にする: ゴミ箱の教材だけを消す', async () => {
  const { net, repo } = setup();
  for (const id of ['a', 'b', 'c']) await repo.saveDeck(id, sampleDeck(id), 100);
  await repo.trashDeck('a', T0);
  await repo.trashDeck('c', T0);
  assert.equal(await repo.emptyTrash(), 2);
  assert.deepEqual((await repo.listDecks()).map((d) => d.id), ['b']);
  assert.deepEqual(Object.keys(net.dump().teachers.u1.decks), ['b']);
  assert.equal(await repo.emptyTrash(), 0);
});

test('30 日たった教材だけを自動で消す', async () => {
  const { net, repo } = setup();
  for (const id of ['old', 'recent', 'broken', 'future', 'live']) await repo.saveDeck(id, sampleDeck(id), 100);
  await repo.trashDeck('old', T0);
  await repo.trashDeck('recent', T0 + 2 * DAY);
  await net.set('teachers/u1/deckIndex/broken/deletedAt', 'x');
  await repo.trashDeck('future', T0 + 500 * DAY);
  const now = T0 + 30 * DAY;
  assert.equal(await repo.purgeExpiredTrash(now), 1);
  assert.deepEqual((await repo.listTrash()).map((d) => d.id).sort(), ['broken', 'future', 'recent']);
  assert.deepEqual(Object.keys(net.dump().teachers.u1.decks).sort(), ['broken', 'future', 'live', 'recent']);
  assert.equal(await repo.purgeExpiredTrash(now), 0);
});

test('消すものが無いとき、自動削除は書きこまない', async () => {
  const { net, repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 100);
  net.update = async () => { throw new Error('書かない'); };
  assert.equal(await repo.purgeExpiredTrash(T0), 0);
  assert.equal(await repo.emptyTrash(), 0);
});

test('undelete: 削除済みの印を外すと、また保存できる', async () => {
  const bg = createBackgroundSaver({
    setTimeout: () => 1, clearTimeout: () => {}, retryMs: 5000, getCurrentUid: () => 'A',
  });
  await bg.deleting('A', 'a', async () => {});
  assert.equal(bg.isDeleted('A', 'a'), true);
  assert.equal(await bg.guardedSave('A', 'a', {}, async () => {}), false);
  bg.undelete('A', 'a');
  assert.equal(bg.isDeleted('A', 'a'), false);
  assert.equal(await bg.guardedSave('A', 'a', {}, async () => {}), true);
  bg.undelete('A', 'zzz'); // 印の無いものは何もしない
});

test('deckState: 一覧・ゴミ箱・無い', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 100);
  assert.equal(await repo.deckState('d1'), 'live');
  await repo.trashDeck('d1', T0);
  assert.equal(await repo.deckState('d1'), 'trashed');
  assert.equal(await repo.deckState('nothing'), 'missing');
});

test('purgeDeck: 元に戻されていた教材は消さない（false）。ゴミ箱の教材は消す（true）', async () => {
  const { repo } = setup();
  await repo.saveDeck('d1', sampleDeck('A'), 100);
  await repo.trashDeck('d1', T0);
  await repo.restoreDeck('d1'); // 別のタブで元に戻された
  assert.equal(await repo.purgeDeck('d1'), false);
  assert.equal((await repo.loadDeck('d1')).title, 'A');
  await repo.trashDeck('d1', T0);
  assert.equal(await repo.purgeDeck('d1'), true);
  assert.deepEqual(await repo.listTrash(), []);
  assert.equal(await repo.deckState('d1'), 'missing');
});

test('deletedAt が false の項目もゴミ箱に出し、開かず、自動では消さない', async () => {
  const { net, repo } = setup();
  await repo.saveDeck('d1', sampleDeck(), 100);
  await net.set('teachers/u1/deckIndex/d1/deletedAt', false);
  assert.deepEqual(await repo.listDecks(), []);
  assert.deepEqual((await repo.listTrash()).map((d) => [d.id, d.deletedAt]), [['d1', null]]);
  assert.equal(await repo.loadDeck('d1'), null);
  assert.equal(await repo.purgeExpiredTrash(T0 + 999 * DAY), 0);
});

test('ゴミ箱に移す手続きの途中で whenNotDeleting を待てば、undelete のあとに削除済みの印が付かない', async () => {
  const bg = createBackgroundSaver({
    setTimeout: () => 1, clearTimeout: () => {}, retryMs: 5000, getCurrentUid: () => 'A',
  });
  let finish;
  const moving = bg.deleting('A', 'a', () => new Promise((r) => { finish = r; }));
  await new Promise((r) => setTimeout(r, 0));
  const restoring = (async () => { await bg.whenNotDeleting('A', 'a'); bg.undelete('A', 'a'); })();
  finish();
  await moving;
  await restoring;
  assert.equal(bg.isDeleted('A', 'a'), false);
});
