import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildSession, nextPatch, prevPatch, pausePatch, closeAllPatch, endPatch } from '../js/session-logic.js';
import { createSessionClient } from '../js/session-client.js';
import { createFakeNet } from './helpers/fake-net.js';
import { NetError } from '../js/errors.js';
import { fakeStorage } from './helpers/fakes.js';

const SID = 'sess1';
const PUB = `sessions/${SID}/pub`;

// 3 枚の教材: s1 資料、s2 アンケート(2択・manual)、s3 アンケート(3択・live)
function makeDeck() {
  let d = createDeck('テスト教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな数は？', options: ['1', '2', '3'], resultMode: 'live' }, 's3');
  return d;
}

// 偽の匿名ログイン。保存先を渡すと、同じ端末なら同じ uid を返す
function stubAuth(uid = 'stu1', storage = null) {
  return {
    signInAnonymous: async () => {
      if (storage) {
        const saved = storage.getItem('test:uid');
        if (saved) return { uid: saved };
        storage.setItem('test:uid', uid);
      }
      return { uid };
    },
  };
}

// 規則の代わり: 回答の set は「授業が live・その質問が open・今のスライド」のときだけ通す
function setup({ storage = fakeStorage(), auth = stubAuth(), seed = true } = {}) {
  let net;
  const deny = (op, path) => {
    const m = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\/[^/]+$/.exec(path);
    if (op !== 'set' || !m) return false;
    const pub = net.dump()?.sessions?.[m[1]]?.pub;
    return !(pub && pub.state === 'live' && pub.polls?.[m[2]]?.status === 'open' && pub.current?.slideId === m[2]);
  };
  net = createFakeNet({ now: () => 12345, deny });
  const session = buildSession(makeDeck(), 'deck1', 'teacher', 1);
  const order = session.deck.order;
  const answerSets = [];
  const origSet = net.set;
  net.set = async (path, value) => {
    if (path.includes('/inbox/answers/')) answerSets.push({ path, value });
    return origSet(path, value);
  };
  // 先生側の変更が生徒の画面に届くのを止める（画面が古い状態を作る）
  const hold = { on: false, pending: [] };
  const origSubscribe = net.subscribe;
  net.subscribe = (path, onValue, onStatus) => origSubscribe(path, (v) => {
    if (hold.on) hold.pending.push(() => onValue(v)); else onValue(v);
  }, onStatus);
  // pub の読み取りの直前に差しはさむ処理（読んでいる間に状態が変わる場合の再現）
  const hooks = { beforePubGet: null };
  const origGet = net.get;
  net.get = async (path) => {
    if (path === PUB && hooks.beforePubGet) { const f = hooks.beforePubGet; hooks.beforePubGet = null; await f(); }
    return origGet(path);
  };
  const states = [];
  const client = createSessionClient({ net, auth, storage, sid: SID, onChange: (s) => states.push(s) });
  const pubNow = () => net.dump().sessions[SID].pub;
  return {
    net, client, storage, order, states, answerSets, hooks,
    holdUpdates: () => { hold.on = true; },
    releaseUpdates: () => { hold.on = false; const p = hold.pending.splice(0); if (p.length) p[p.length - 1](); },
    last: () => states[states.length - 1],
    // 先生の操作
    ready: async () => {
      if (seed) await net.set(`sessions/${SID}`, session);
    },
    teacher: async (fn) => {
      const patch = fn(pubNow(), order);
      if (patch) await net.update(PUB, patch);
    },
    answers: () => (net.dump().sessions?.[SID]?.inbox?.answers) ?? null,
  };
}

// 先生が s2（最初の質問）まで進める
async function toS2(t) {
  await t.teacher(nextPatch); // s1
  await t.teacher(nextPatch); // s2
}

test('無い授業は not-found', async () => {
  const t = setup({ seed: false });
  await t.client.start();
  assert.equal(t.last().phase, 'not-found');
});

test('終わった授業は ended', async () => {
  const t = setup();
  await t.ready();
  await t.teacher(endPatch);
  await t.client.start();
  assert.equal(t.last().phase, 'ended');
});

test('参加すると参加者に入る', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  assert.equal(t.last().phase, 'live');
  assert.equal(t.last().title, 'テスト教材');
  assert.equal(t.last().total, 3);
  assert.equal(t.last().slide, null);
  assert.equal(t.last().index, -1);
  assert.deepEqual(Object.keys(t.net.dump().sessions[SID].inbox.participants), ['stu1']);
  assert.equal(t.net.dump().sessions[SID].inbox.participants.stu1, 12345);
  // 匿名 ID は state に出さない
  assert.equal(JSON.stringify(t.last()).includes('stu1'), false);
});

test('先生が進めると今のスライドが変わる', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await t.teacher(nextPatch);
  assert.equal(t.last().slideId, 's1');
  assert.equal(t.last().index, 0);
  assert.equal(t.last().slide.type, 'content');
  assert.deepEqual(t.last().slide.items, []);
  assert.equal(t.last().poll, null);
  await t.teacher(nextPatch);
  assert.equal(t.last().slideId, 's2');
  assert.equal(t.last().slide.type, 'poll');
  assert.deepEqual(t.last().slide.options, ['赤', '青']);
  assert.equal(t.last().poll.status, 'open');
});

test('選んだだけでは送らない', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  assert.equal(t.answers(), null);
  assert.equal(t.last().selected, 1);
  assert.equal(t.last().answer, null);
});

test('送ると送信済み', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  assert.deepEqual(t.answers().s2.stu1, { choice: 1, at: 12345 });
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.last().answer.choice, 1);
});

test('変えて送ると上書き', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  t.client.select(0);
  await t.client.submit();
  assert.deepEqual(Object.keys(t.answers().s2), ['stu1']);
  assert.equal(t.answers().s2.stu1.choice, 0);
  assert.deepEqual(t.last().answer, { choice: 0, state: 'sent' });
});

test('受付停止中は送らない', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  assert.equal(t.last().poll.status, 'paused');
  t.client.select(1);
  await t.client.submit();
  assert.equal(t.answerSets.length, 0);
  assert.equal(t.last().answer, null);
});

test('締切後は送らない', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  await t.teacher(closeAllPatch);
  assert.equal(t.last().poll.status, 'closed');
  t.client.select(1);
  await t.client.submit();
  assert.equal(t.answerSets.length, 0);
});

test('切れている間は一時保存し、戻ったら送る', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.net.setOnline(false);
  assert.equal(t.last().connection, 'disconnected');
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  assert.equal(t.last().connection, 'disconnected');
  t.net.setOnline(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.last().connection, 'connected');
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('切れている間に締め切られたら rejected', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates(); // 締切は画面にまだ届かない
  await t.teacher(closeAllPatch);
  t.net.setOnline(false);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  t.net.setOnline(true); // つながったので送り直すが、締切済みなので拒否される
  await new Promise((r) => setImmediate(r));
  assert.equal(t.last().answer.state, 'rejected');
  assert.equal(t.answers(), null);
});

test('停止中に拒否されたら一時保存にする', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates(); // 停止は画面にまだ届かない（画面は open のまま）
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued'); // 拒否されたが停止中なので保留
  assert.equal(t.answers(), null);
  t.releaseUpdates();
  assert.equal(t.last().poll.status, 'paused');
  await t.teacher((pub) => pausePatch(pub, 's2', false)); // 再開
  await new Promise((r) => setImmediate(r));
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('結果は公開中だけ届く', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  assert.equal(t.last().results, null);
  await t.net.update(PUB, { 'polls/s2/resultsVisible': true, 'results/s2': { counts: [3, 1], total: 4 } });
  assert.deepEqual(t.last().results, { counts: [3, 1], total: 4 });
  await t.net.update(PUB, { 'polls/s2/resultsVisible': false, 'results/s2': null });
  assert.equal(t.last().results, null);
});

test('スライドが変わると選択は消える', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  await t.teacher(nextPatch); // s3
  assert.equal(t.last().slideId, 's3');
  assert.equal(t.last().selected, null);
  assert.equal(t.last().answer, null);
  await t.teacher(prevPatch); // s2 へ戻る（締切済み）
  assert.equal(t.last().slideId, 's2');
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
});

test('授業が終わると ended', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  await t.teacher(endPatch);
  assert.equal(t.last().phase, 'ended');
  const n = t.states.length;
  await t.net.update(PUB, { title: '変わった' }); // 購読は止まっている
  assert.equal(t.states.length, n);
});

test('同じ端末で読み直すと参加人数が増えない', async () => {
  const storage = fakeStorage();
  const a = setup({ storage, auth: stubAuth('stuA', storage) });
  await a.ready();
  await a.client.start();
  a.client.stop();
  const states2 = [];
  const client2 = createSessionClient({
    net: a.net, auth: stubAuth('stuB', storage), storage, sid: SID, onChange: (s) => states2.push(s),
  });
  await client2.start();
  assert.deepEqual(Object.keys(a.net.dump().sessions[SID].inbox.participants), ['stuA']);
  client2.stop();
});

test('読み直すと送信済みの回答が戻る', async () => {
  const storage = fakeStorage();
  const a = setup({ storage });
  await a.ready();
  await a.client.start();
  await toS2(a);
  a.client.select(1);
  await a.client.submit();
  a.client.stop();
  const states2 = [];
  const client2 = createSessionClient({
    net: a.net, auth: stubAuth(), storage, sid: SID, onChange: (s) => states2.push(s),
  });
  await client2.start();
  const s = states2[states2.length - 1];
  assert.equal(s.slideId, 's2');
  assert.deepEqual(s.answer, { choice: 1, state: 'sent' });
  client2.stop();
});

test('止めたあとは state を出さない', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  t.client.stop();
  const n = t.states.length;
  await t.teacher(nextPatch);
  assert.equal(t.states.length, n);
});

const settle = () => new Promise((r) => setImmediate(r));

// 回答の set は届くが、応答だけ失われる（1 回だけ）
function loseFirstResponse(net) {
  const orig = net.set;
  let lose = true;
  net.set = async (path, value) => {
    await orig(path, value);
    if (lose && path.includes('/inbox/answers/')) { lose = false; throw new NetError('network'); }
  };
}

test('停止で拒否され、読み直す間に再開されても、rejected にならず送れる', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  t.hooks.beforePubGet = async () => { await t.teacher((pub) => pausePatch(pub, 's2', false)); };
  await t.client.submit();
  await settle();
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('停止中の保留が締切で rejected になる', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  t.releaseUpdates();
  await t.teacher(closeAllPatch);
  await settle();
  assert.equal(t.last().answer.state, 'rejected');
});

test('保留のまま授業が終わると rejected', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  t.releaseUpdates();
  await t.teacher(endPatch);
  assert.equal(t.last().phase, 'ended');
  assert.deepEqual(t.last().answer, { choice: 1, state: 'rejected' });
});

test('保存できず、つながらなければ failed。retry で送り直せる', async () => {
  const base = fakeStorage();
  const storage = { getItem: base.getItem, removeItem: base.removeItem, setItem: () => { throw new Error('容量不足'); } };
  const t = setup({ storage });
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.net.setOnline(false);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'failed');
  t.net.setOnline(true);
  await settle();
  assert.equal(t.last().answer.state, 'failed'); // 自動では送り直さない
  await t.client.retry();
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('応答だけ失われて締め切られたあと、同じ回答なら送信済みにする', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  loseFirstResponse(t.net);
  t.client.select(1);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  t.net.setOnline(false);
  t.net.setOnline(true);
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
});

test('応答だけ失われて締め切られたあと、違う回答なら受信済みの値を送信済みにする', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  loseFirstResponse(t.net);
  t.client.select(1);
  await t.client.submit();
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  t.client.select(0);
  await t.client.submit(); // 画面は受付中のまま。拒否される
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
  assert.equal(t.last().selected, 1);
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('受信済みの回答が無ければ、締切後の拒否は rejected', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'rejected');
});
