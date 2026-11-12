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
  assert.deepEqual(h.questions[0], { slideId: 's2', type: 'poll', question: '好きな色は？', options: ['赤', '青'], counts: [1, 2], total: 3 });
  assert.deepEqual(h.questions[1].counts, [0, 0, 0]);
  assert.equal(h.questions[1].total, 0);
  const none = buildHistory(session, null, 9000);
  assert.equal(none.participants, 0);
  assert.equal(none.questions.length, 2);
});

// ---- 自由記述（free）----
import { normalizeText, freeList } from '../js/session-logic.js';
import { CONFIG } from '../js/config.js';

function makeMixedDeck() {
  let d = createDeck('まぜた教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { type: 'free', question: '感想は？' }, 'f1');
  d = addSlide(d, { ...createSlide('poll'), question: '色は？', options: ['赤', '青'], resultMode: 'live' }, 'p1');
  return d;
}

test('CONFIG.free.maxLength は 200', () => {
  assert.equal(CONFIG.free.maxLength, 200);
});

test('normalizeText: 前後の空白を取り、空・長すぎ・文字列でないものは null', () => {
  assert.equal(normalizeText('  あ  '), 'あ');
  assert.equal(normalizeText('   '), null);
  assert.equal(normalizeText(''), null);
  assert.equal(normalizeText('あ'.repeat(200)), 'あ'.repeat(200));
  assert.equal(normalizeText('あ'.repeat(201)), null);
  assert.equal(normalizeText(` ${'あ'.repeat(200)} `), 'あ'.repeat(200));
  assert.equal(normalizeText(5), null);
  assert.equal(normalizeText(null), null);
  assert.equal(normalizeText(undefined), null);
  assert.equal(normalizeText({ a: 1 }), null);
});

test('buildSession: free は結果が出ていない状態で待機、live のアンケートは今までどおり', () => {
  const s = buildSession(makeMixedDeck(), 'deck1', 'owner1', 5000);
  assert.deepEqual(s.pub.polls.f1, { status: 'waiting', resultsVisible: false });
  assert.deepEqual(s.pub.polls.p1, { status: 'waiting', resultsVisible: true });
  assert.equal(s.pub.polls.s1, undefined);
});

test('goToPatch: free のスライドに着くと open、離れると closed', () => {
  const deck = makeMixedDeck();
  const { pub } = buildSession(deck, 'deck1', 'owner1', 5000);
  const order = deck.order;
  const at = applyPatch(pub, goToPatch(pub, order, 1));
  assert.equal(at.polls.f1.status, 'open');
  const away = applyPatch(at, goToPatch(at, order, 2));
  assert.equal(away.polls.f1.status, 'closed');
  assert.equal(away.polls.p1.status, 'open');
  // 締切後に戻っても open にしない
  const back = applyPatch(away, goToPatch(away, order, 1));
  assert.equal(back.polls.f1.status, 'closed');
});

test('freeList: at の古い順（同じなら uid 順）、かくす、total、不正な text は数えない', () => {
  const answers = {
    u3: { text: ' 三 ', at: 30 },
    u1: { text: '一', at: 10 },
    u2: { text: 'に', at: 10 },
    u4: { text: '   ', at: 5 },
    u5: { text: 'あ'.repeat(201), at: 6 },
    u6: { text: 7, at: 7 },
    u7: { choice: 1, at: 8 },
    u8: null,
    u9: { text: '九', at: 40 },
  };
  const r = freeList(answers, { u2: true, u9: true, nobody: true });
  assert.deepEqual(r.items, [{ uid: 'u1', text: '一' }, { uid: 'u3', text: '三' }]);
  assert.deepEqual(r.hiddenItems, [{ uid: 'u2', text: 'に' }, { uid: 'u9', text: '九' }]);
  assert.equal(r.total, 4);
  assert.deepEqual(freeList(undefined, undefined), { items: [], hiddenItems: [], total: 0 });
});

test('buildHistory: free は texts / hiddenTexts / total を持ち、uid を含まない。poll は type:poll が付く', () => {
  const deck = makeMixedDeck();
  const session = buildSession(deck, 'deck1', 'ownerX', 5000);
  const inbox = {
    participants: { uidAAA: 1, uidBBB: 2, uidCCC: 3 },
    answers: {
      f1: {
        uidAAA: { text: '一番', at: 1 },
        uidBBB: { text: '二番', at: 2 },
        uidCCC: { text: '三番', at: 3 },
      },
      p1: { uidAAA: { choice: 0 }, uidBBB: { choice: 1 } },
    },
  };
  const h = buildHistory(session, inbox, 9000, { f1: { uidBBB: true } });
  assert.equal(h.questions.length, 2);
  assert.deepEqual(h.questions[0], {
    slideId: 'f1', type: 'free', question: '感想は？',
    texts: ['一番', '三番'], hiddenTexts: ['二番'], total: 3,
  });
  assert.deepEqual(h.questions[1], {
    slideId: 'p1', type: 'poll', question: '色は？', options: ['赤', '青'], counts: [1, 1], total: 2,
  });
  const json = JSON.stringify(h);
  for (const uid of ['uidAAA', 'uidBBB', 'uidCCC']) assert.equal(json.includes(uid), false);
  // 第 4 引数は省略できる
  const h2 = buildHistory(session, inbox, 9000);
  assert.deepEqual(h2.questions[0].hiddenTexts, []);
  assert.deepEqual(h2.questions[0].texts, ['一番', '二番', '三番']);
});

// ---- ワードクラウド（cloud）----
import { normalizeWords, wordKey, hiddenKey, cloudList } from '../js/session-logic.js';

function makeCloudDeck() {
  let d = createDeck('雲の教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { type: 'cloud', question: '好きな動物は？' }, 'c1');
  d = addSlide(d, { type: 'free', question: '感想は？' }, 'f1');
  d = addSlide(d, { ...createSlide('poll'), question: '色は？', options: ['赤', '青'], resultMode: 'live' }, 'p1');
  return d;
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

test('CONFIG.cloud は 3 語・20 文字・60 語', () => {
  assert.deepEqual(CONFIG.cloud, { maxWords: 3, maxLength: 20, maxShown: 60 });
});

test('normalizeWords: 前後の空白を取り、同じ鍵は先のものを残し、4 個目以降は捨てる', () => {
  // 'ネコ' は NFKC で 'ねこ' と同じにならないので残る。とり は 4 個目なので捨てる
  assert.deepEqual(normalizeWords(['  ねこ ', 'ネコ', 'いぬ', 'とり']), ['ねこ', 'ネコ', 'いぬ']);
  // 半角カナと全角カナは同じ鍵
  assert.deepEqual(normalizeWords(['ﾈｺ', 'ネコ']), ['ﾈｺ']);
  assert.deepEqual(normalizeWords(['ABC', 'abc', 'ａｂｃ']), ['ABC']);
  assert.deepEqual(normalizeWords(['a  b', 'A B', 'a　b']), ['a  b']);
});

test('normalizeWords: 空白だけ・21 文字・文字列でないものは捨て、全部だめなら null', () => {
  assert.deepEqual(normalizeWords(['   ', 'あ'.repeat(21), 5, null, 'よい', {}]), ['よい']);
  assert.deepEqual(normalizeWords([` ${'あ'.repeat(20)} `]), ['あ'.repeat(20)]);
  assert.equal(normalizeWords(['   ', 'あ'.repeat(21), 5]), null);
  assert.equal(normalizeWords([]), null);
  assert.equal(normalizeWords(null), null);
  assert.equal(normalizeWords('ねこ'), null);
  assert.equal(normalizeWords(5), null);
  // 対にならないサロゲートは送らない（データベースに書けない）
  assert.equal(normalizeWords(['\uD83D']), null);
});

test('normalizeWords: 0・1・2 の鍵を持つもの（データベースの形）も読める', () => {
  assert.deepEqual(normalizeWords({ 0: 'a', 2: 'b' }), ['a', 'b']);
  assert.deepEqual(normalizeWords({ 1: 'b', 0: 'a' }), ['a', 'b']);
  assert.equal(normalizeWords({ x: 'a' }), null);
});

test('wordKey: NFKC・つづく空白を 1 つに・小文字', () => {
  assert.equal(wordKey('  Ａ  b '), 'a b');
  assert.equal(wordKey('ﾈｺ'), wordKey('ネコ'));
  assert.notEqual(wordKey('ネコ'), wordKey('ねこ'));
  assert.equal(wordKey('ABC'), wordKey('ａｂｃ'));
  assert.equal(wordKey('a　　b'), 'a b');
});

test('hiddenKey: データベースの鍵に使えない文字を含まない', () => {
  for (const w of ['a.b/c', 'x$y#z', '[a]', '..', 'a\u0001b', 'ねこ', '%2E', 'Ｈｅｌｌｏ　Ｗｏｒｌｄ']) {
    const k = hiddenKey(w);
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
    assert.ok(!/[.$#[\]/\u0000-\u001f\u007f]/.test(k), `${w} → ${k}`);
  }
  // 言葉の鍵が同じなら同じ
  assert.equal(hiddenKey('ﾈｺ'), hiddenKey('ネコ'));
  assert.equal(hiddenKey(' ABC '), hiddenKey('ａｂｃ'));
  assert.notEqual(hiddenKey('a.b'), hiddenKey('a%2Eb'));
  assert.equal(typeof hiddenKey('\uD83D'), 'string'); // 例外を投げない
});

test('cloudList: 人数・1 人の重複は 1・並び・かくす・total', () => {
  const answers = {
    u1: { words: ['ねこ', 'いぬ'], at: 10 },
    u2: { words: ['ねこ'], at: 20 },
    u3: { words: ['ネコ', 'ﾈｺ'], at: 30 },
    u4: { words: ['   ', 5], at: 40 }, // 正しい言葉が無い
    u5: { text: 'ねこ', at: 50 },
    u6: null,
  };
  const r = cloudList(answers, {});
  assert.deepEqual(r.items, [
    { key: hiddenKey('ねこ'), word: 'ねこ', count: 2 },
    ...[
      { key: hiddenKey('いぬ'), word: 'いぬ', count: 1 },
      { key: hiddenKey('ネコ'), word: 'ネコ', count: 1 },
    ].sort(byKey),
  ]);
  assert.deepEqual(r.hiddenItems, []);
  assert.equal(r.total, 3);
  // かくした鍵は hiddenItems へ（total は変わらない。true 以外はかくさない）
  const h = cloudList(answers, { [hiddenKey('ねこ')]: true, other: true, [hiddenKey('いぬ')]: 'yes' });
  assert.deepEqual(h.items.map((x) => x.word).sort(), ['いぬ', 'ネコ']);
  assert.deepEqual(h.hiddenItems, [{ key: hiddenKey('ねこ'), word: 'ねこ', count: 2 }]);
  assert.equal(h.total, 3);
  assert.deepEqual(cloudList(undefined, undefined), { items: [], hiddenItems: [], total: 0 });
});

test('cloudList: 表示の形は多く書かれた形、同じ数なら先に届いた形。データベースの形も読む', () => {
  const r = cloudList({
    a: { words: ['ﾈｺ'], at: 30 },
    b: { words: { 0: 'ネコ' }, at: 20 },
    c: { words: ['ネコ'], at: 40 },
    d: { words: ['Dog'], at: 50 },
    e: { words: ['dog'], at: 10 },
    f: { words: ['DOG'], at: 60 },
    g: { words: ['Dog'], at: 70 },
  });
  // Dog 2 人・dog 1 人・DOG 1 人 → 'Dog'。ネコ 2 人・ﾈｺ 1 人 → 'ネコ'
  assert.deepEqual(r.items.map((x) => [x.word, x.count]), [['Dog', 4], ['ネコ', 3]]);
  // 同じ数（1 人ずつ）なら先に届いた形
  const t = cloudList({ a: { words: ['Cat'], at: 20 }, b: { words: ['cat'], at: 10 } });
  assert.deepEqual(t.items.map((x) => x.word), ['cat']);
  assert.equal(r.total, 7);
});

test('buildSession・goToPatch: cloud は結果を出さずに待機し、着くと open、離れると closed', () => {
  const deck = makeCloudDeck();
  const { pub } = buildSession(deck, 'deck1', 'owner1', 5000);
  assert.deepEqual(pub.polls.c1, { status: 'waiting', resultsVisible: false });
  const order = deck.order;
  const at = applyPatch(pub, goToPatch(pub, order, 1));
  assert.equal(at.polls.c1.status, 'open');
  const away = applyPatch(at, goToPatch(at, order, 2));
  assert.equal(away.polls.c1.status, 'closed');
  const back = applyPatch(away, goToPatch(away, order, 1));
  assert.equal(back.polls.c1.status, 'closed');
});

test('buildHistory: cloud は words・hiddenWords・total を持ち、uid も鍵も含まない', () => {
  const deck = makeCloudDeck();
  const session = buildSession(deck, 'deck1', 'ownerX', 5000);
  const inbox = {
    participants: { uidAAA: 1, uidBBB: 2, uidCCC: 3 },
    answers: {
      c1: {
        uidAAA: { words: ['ねこ', 'いぬ'], at: 1 },
        uidBBB: { words: ['ねこ', 'a.b'], at: 2 },
        uidCCC: { words: ['ﾈｺ'], at: 3 },
      },
      f1: { uidAAA: { text: 'ふつう', at: 1 } },
      p1: { uidAAA: { choice: 0 } },
    },
  };
  const h = buildHistory(session, inbox, 9000, { c1: { [hiddenKey('a.b')]: true } });
  assert.equal(h.questions.length, 3);
  const ones = [{ key: hiddenKey('いぬ'), word: 'いぬ' }, { key: hiddenKey('ﾈｺ'), word: 'ﾈｺ' }].sort(byKey);
  assert.deepEqual(h.questions[0], {
    slideId: 'c1', type: 'cloud', question: '好きな動物は？',
    words: [{ word: 'ねこ', count: 2 }, ...ones.map((x) => ({ word: x.word, count: 1 }))],
    hiddenWords: [{ word: 'a.b', count: 1 }],
    total: 3,
  });
  assert.equal(h.questions[1].type, 'free');
  assert.equal(h.questions[2].type, 'poll');
  const json = JSON.stringify(h);
  for (const uid of ['uidAAA', 'uidBBB', 'uidCCC']) assert.equal(json.includes(uid), false);
  assert.equal(json.includes(hiddenKey('a.b')), false);
  assert.equal(json.includes('"key"'), false);
  const h2 = buildHistory(session, inbox, 9000);
  assert.deepEqual(h2.questions[0].hiddenWords, []);
});
