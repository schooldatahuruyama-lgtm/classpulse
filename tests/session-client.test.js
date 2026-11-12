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
function setup({ storage = fakeStorage(), auth = stubAuth(), seed = true, deck = makeDeck() } = {}) {
  let net;
  const deny = (op, path) => {
    const m = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\/[^/]+$/.exec(path);
    if (op !== 'set' || !m) return false;
    const pub = net.dump()?.sessions?.[m[1]]?.pub;
    return !(pub && pub.state === 'live' && pub.polls?.[m[2]]?.status === 'open' && pub.current?.slideId === m[2]);
  };
  net = createFakeNet({ now: () => 12345, deny });
  const session = buildSession(deck, 'deck1', 'teacher', 1);
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

test('応答が失われた回答は、締切を受けると照合して送信済みになる', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  loseFirstResponse(t.net);
  t.client.select(1);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  await t.teacher(closeAllPatch);
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
});

test('締切を受けたとき、サーバーに別の値があればその値を送信済みにし、選択も合わせる', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  loseFirstResponse(t.net);
  t.client.select(1);
  await t.client.submit(); // サーバーには 1 がある。画面は queued
  t.client.select(0);
  t.holdUpdates();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  await t.client.submit(); // 停止中の拒否で 0 も queued
  assert.deepEqual(t.last().answer, { choice: 0, state: 'queued' });
  t.releaseUpdates();
  await t.teacher(closeAllPatch);
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
  assert.equal(t.last().selected, 1);
});

test('サーバーに無い保留は、締切を受けると rejected', async () => {
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

test('切れている間に締切を受けたら保留のまま、つながったら照合する（再送はしない）', async () => {
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
  t.releaseUpdates(); // 切れている間に締切を知る
  await settle();
  assert.equal(t.last().answer.state, 'queued');
  const sets = t.answerSets.length;
  t.net.setOnline(true);
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
  assert.equal(t.answerSets.length, sets); // 締切済みの質問へ送り直していない
});

// 回答の set を gate が開くまで止め（applied なら先にサーバーへ届かせて）、開いたら通信エラーで終える
function holdAnswerSend(net, { applied }) {
  const orig = net.set;
  let release;
  const gate = new Promise((r) => { release = r; });
  net.set = async (path, value) => {
    if (!path.includes('/inbox/answers/')) return orig(path, value);
    if (applied) await orig(path, value); // サーバーには届くが、応答が戻らない
    await gate;
    throw new NetError('network');
  };
  return release;
}

test('保留のまま授業が終わると未確認になり、終わったあとは読みも送りもしない', async () => {
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
  const reads = [];
  const origGet = t.net.get;
  t.net.get = async (path) => { reads.push(path); return origGet(path); };
  const sets = t.answerSets.length;
  await t.teacher(endPatch);
  assert.equal(t.last().phase, 'ended');
  assert.deepEqual(t.last().answer, { choice: 1, state: 'unconfirmed' });
  t.net.setOnline(false);
  t.net.setOnline(true);
  await settle();
  assert.equal(reads.length, 0);
  assert.equal(t.answerSets.length, sets);
  assert.equal(t.last().answer.state, 'unconfirmed');
});

test('終わった授業に入ると、保存されていた保留は未確認になる', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({ s2: { choice: 1, state: 'queued' }, s3: { choice: 0, state: 'sent' } }));
  const t = setup({ storage });
  await t.ready();
  await t.teacher(endPatch);
  await t.client.start();
  assert.equal(t.last().phase, 'ended');
  const saved = JSON.parse(storage.getItem(`classpulse:outbox:${SID}:stu1`));
  assert.deepEqual(saved.s2, { choice: 1, state: 'unconfirmed' });
  assert.deepEqual(saved.s3, { choice: 0, state: 'sent' });
  assert.equal(t.answerSets.length, 0);
});

test('送信済みは授業が終わっても sent のまま', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  await t.teacher(endPatch);
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
});

test('送信中に締切が届き、あとで通信エラーになっても照合される（届いていれば sent）', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  const release = holdAnswerSend(t.net, { applied: true });
  t.client.select(1);
  const p = t.client.submit();
  await t.teacher(closeAllPatch); // 送信中に締切を知る
  assert.equal(t.last().poll.status, 'closed');
  release();
  await p;
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
});

test('送信中に締切が届き、届いていなければ rejected', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  const release = holdAnswerSend(t.net, { applied: false });
  t.client.select(1);
  const p = t.client.submit();
  await t.teacher(closeAllPatch);
  release();
  await p;
  await settle();
  assert.equal(t.last().answer.state, 'rejected');
});

// 読み取りを gate が開くまで止める。pub は止める前の写しを返す（終了前の状態）。回答は開いてから読む
function holdRead(net, kind) {
  const origGet = net.get;
  const reads = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = false;
  net.get = async (path) => {
    const isPub = path === PUB;
    const isAnswer = path.includes('/inbox/answers/');
    if (isAnswer) reads.push(path);
    if (!held && ((kind === 'pub' && isPub) || (kind === 'answer' && isAnswer))) {
      held = true;
      const snap = isPub ? await origGet(path) : null;
      await gate;
      return isPub ? snap : origGet(path);
    }
    return origGet(path);
  };
  return { release, reads };
}

test('拒否後の pub の読み取り中に授業が終わり回答も消えても、未確認になり回答は読まない', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher(closeAllPatch); // 画面は受付中のまま
  const h = holdRead(t.net, 'pub');
  const p = t.client.submit(); // 拒否 → pub を読み直す（止まる）
  await settle();
  t.releaseUpdates();
  await t.teacher(endPatch);
  await t.net.remove(`sessions/${SID}/inbox`);
  h.release(); // 終了前（closed）の写しが返る
  await p;
  await settle();
  assert.equal(t.last().phase, 'ended');
  assert.deepEqual(t.last().answer, { choice: 1, state: 'unconfirmed' });
  assert.equal(h.reads.length, 0);
});

test('回答の読み取り中に授業が終わり回答が消えても、rejected ではなく未確認', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  const h = holdRead(t.net, 'answer');
  const p = t.client.submit(); // 拒否 → 締切と分かる → 自分の回答を読む（止まる）
  await settle();
  t.releaseUpdates();
  await t.teacher(endPatch);
  await t.net.remove(`sessions/${SID}/inbox`);
  h.release(); // 削除後なので null が返る
  await p;
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'unconfirmed' });
});

test('同じ保存先を共有する別の ID の回答は、読み直しても見えない', async () => {
  const storage = fakeStorage();
  const a = setup({ storage, auth: stubAuth('uidA') });
  await a.ready();
  await a.client.start();
  await toS2(a);
  a.client.select(1);
  await a.client.submit();
  assert.equal(a.last().answer.state, 'sent');
  a.client.stop();
  // 別の ID（同じ授業・同じ保存先）
  const statesB = [];
  const clientB = createSessionClient({ net: a.net, auth: stubAuth('uidB'), storage, sid: SID, onChange: (s) => statesB.push(s) });
  await clientB.start();
  const b = statesB[statesB.length - 1];
  assert.equal(b.slideId, 's2');
  assert.equal(b.answer, null);
  assert.equal(b.selected, null);
  assert.equal(JSON.stringify(b).includes('uidA') || JSON.stringify(b).includes('uidB'), false);
  clientB.stop();
  // 元の ID は読み直すと送信済みが戻る
  const statesA = [];
  const clientA = createSessionClient({ net: a.net, auth: stubAuth('uidA'), storage, sid: SID, onChange: (s) => statesA.push(s) });
  await clientA.start();
  assert.deepEqual(statesA[statesA.length - 1].answer, { choice: 1, state: 'sent' });
  clientA.stop();
});

// ---- 同じタブで出て入り直したとき（クライアントの作り直し）の送信の順番 ----

test('入り直す前の遅い送信は、入り直したあとの新しい回答を上書きしない', async () => {
  const storage = fakeStorage();
  const a = setup({ storage });
  await a.ready();
  await a.client.start();
  await toS2(a);
  // 回答の書きこみを 1 回だけ止める（古いクライアントの送信 A が通信の途中で止まる）
  let release = null;
  const origSet = a.net.set;
  a.net.set = async (path, value) => {
    if (path.includes('/inbox/answers/') && release === null) await new Promise((r) => { release = r; });
    return origSet(path, value);
  };
  a.client.select(0);
  const sendA = a.client.submit();
  await settle();
  assert.equal(typeof release, 'function');
  a.client.stop(); // 画面を離れる（送信は止められない）

  const states2 = [];
  const client2 = createSessionClient({ net: a.net, auth: stubAuth(), storage, sid: SID, onChange: (s) => states2.push(s) });
  await client2.start();
  client2.select(1);
  const sendB = client2.submit();
  await settle();
  assert.equal(a.answers(), null); // B は、A が終わるのを待っている
  release(); // 古い送信 A が、あとから届く
  await Promise.all([sendA, sendB]);
  await settle();
  assert.equal(a.answers().s2.stu1.choice, 1); // サーバーに最後に残るのは B
  assert.deepEqual(states2[states2.length - 1].answer, { choice: 1, state: 'sent' });
  assert.deepEqual(JSON.parse(storage.getItem(`classpulse:outbox:${SID}:stu1`)).s2, { choice: 1, state: 'sent' });
  client2.stop();
});

// ---- 授業全体の、確かめられなかった回答の数 ----

test('終わった授業を開き直すと、教材を読まなくても未確認の数が分かる', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({
    s2: { choice: 1, state: 'queued' }, s3: { choice: 0, state: 'failed' }, s9: { choice: 0, state: 'sent' },
  }));
  const t = setup({ storage });
  await t.ready();
  await t.teacher(endPatch);
  await t.client.start();
  assert.equal(t.last().phase, 'ended');
  assert.equal(t.last().answer, null); // 教材は読んでいない
  assert.equal(t.last().unconfirmedCount, 2);
});

test('前の質問に未確認が残ったまま終わると、今のスライドが別でも数に入る', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  // 回答の書きこみだけ、つながらないことにする
  const origSet = t.net.set;
  t.net.set = async (path, value) => {
    if (path.includes('/inbox/answers/')) throw new NetError('network', 'つながりません');
    return origSet(path, value);
  };
  t.client.select(1);
  await t.client.submit();
  assert.equal(t.last().answer.state, 'queued');
  assert.equal(t.last().unconfirmedCount, 0);
  t.holdUpdates(); // 次のスライドへ進んだことが届く前に、授業が終わる
  await t.teacher(nextPatch); // s3
  await t.teacher(endPatch);
  t.releaseUpdates();
  await settle();
  assert.equal(t.last().phase, 'ended');
  assert.equal(t.last().slideId, 's3');
  assert.equal(t.last().answer, null); // 今のスライド（s3）には回答が無い
  assert.equal(t.last().unconfirmedCount, 1); // s2 の回答が未確認
});

test('送信済みだけなら、未確認の数は 0', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  await t.teacher(endPatch);
  assert.equal(t.last().unconfirmedCount, 0);
});

// ---- 自由記述 ----

// 3 枚の教材: s1 資料、s2 自由記述、s3 アンケート(2択・manual)
function makeFreeDeck() {
  let d = createDeck('自由記述の教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('free'), question: 'りゆうを書こう' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's3');
  return d;
}

async function freeAtS2(opts = {}) {
  const t = setup({ ...opts, deck: makeFreeDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  return t;
}

test('自由記述: 文章を送ると前後の空白を取って送り、sent と text になる', async () => {
  const t = await freeAtS2();
  assert.equal(t.last().kind, 'free');
  assert.equal(t.last().text, null);
  await t.client.submitText('  こんにちは  ');
  assert.deepEqual(t.answers().s2.stu1, { text: 'こんにちは', at: 12345 });
  assert.equal(t.last().kind, 'free');
  assert.equal(t.last().text, 'こんにちは');
  assert.deepEqual(t.last().answer, { text: 'こんにちは', state: 'sent' });
  assert.equal(t.last().selected, null);
  assert.equal(JSON.stringify(t.last()).includes('stu1'), false);
});

test('自由記述: 送信中に別の文章を送ると、最後の文章がサーバーと状態に残る', async () => {
  const t = await freeAtS2();
  // 回答の書きこみを、gate を開くまで 1 つずつ止める
  const gates = [];
  const origSet = t.net.set;
  t.net.set = async (path, value) => {
    if (path.includes('/inbox/answers/')) await new Promise((r) => gates.push(r));
    return origSet(path, value);
  };
  const p1 = t.client.submitText('はじめの文');
  await settle();
  const p2 = t.client.submitText('二つ目の文');
  const p3 = t.client.submitText('さいごの文');
  assert.equal(t.last().text, 'さいごの文');
  assert.equal(t.last().answer.state, 'sending');
  for (let i = 0; i < 6; i++) {
    await settle();
    const g = gates.shift();
    if (g) g();
  }
  await Promise.all([p1, p2, p3]);
  await settle();
  assert.equal(t.answers().s2.stu1.text, 'さいごの文');
  assert.deepEqual(t.last().answer, { text: 'さいごの文', state: 'sent' });
  assert.equal(t.last().text, 'さいごの文');
  assert.deepEqual(t.answerSets.map((s) => s.value.text), ['はじめの文', 'さいごの文']);
});

test('自由記述: 送信済みと同じ文章なら送らない。違えば送り直して上書き', async () => {
  const t = await freeAtS2();
  await t.client.submitText('おなじ');
  await t.client.submitText('  おなじ ');
  assert.equal(t.answerSets.length, 1);
  await t.client.submitText('ちがう');
  assert.equal(t.answerSets.length, 2);
  assert.deepEqual(Object.keys(t.answers().s2), ['stu1']);
  assert.equal(t.answers().s2.stu1.text, 'ちがう');
  assert.equal(t.last().text, 'ちがう');
});

test('自由記述: 切れている間は queued、つながると送られる', async () => {
  const t = await freeAtS2();
  t.net.setOnline(false);
  await t.client.submitText('ほかん');
  assert.deepEqual(t.last().answer, { text: 'ほかん', state: 'queued' });
  assert.equal(t.last().text, 'ほかん');
  t.net.setOnline(true);
  await settle();
  assert.deepEqual(t.last().answer, { text: 'ほかん', state: 'sent' });
  assert.equal(t.answers().s2.stu1.text, 'ほかん');
});

test('自由記述: 保管中に書き直すと、最後の文章だけを送る', async () => {
  const t = await freeAtS2();
  t.net.setOnline(false);
  await t.client.submitText('まえ');
  await t.client.submitText('あと');
  assert.deepEqual(t.last().answer, { text: 'あと', state: 'queued' });
  const n = t.answerSets.length;
  t.net.setOnline(true);
  await settle();
  assert.deepEqual(t.answerSets.slice(n).map((s) => s.value.text), ['あと']);
  assert.deepEqual(t.last().answer, { text: 'あと', state: 'sent' });
});

test('自由記述: 締切後に届いた送信は rejected（画面は受付中のまま）', async () => {
  const t = await freeAtS2();
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  await t.client.submitText('おそい');
  assert.deepEqual(t.last().answer, { text: 'おそい', state: 'rejected' });
  assert.equal(t.answers(), null);
});

test('自由記述: 締切・一時停止が分かっていれば送らない', async () => {
  const t = await freeAtS2();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  assert.equal(t.last().poll.status, 'paused');
  await t.client.submitText('ていし');
  assert.equal(t.answerSets.length, 0);
  assert.equal(t.last().answer, null);
  await t.teacher(closeAllPatch);
  await t.client.submitText('しめきり');
  assert.equal(t.answerSets.length, 0);
});

test('自由記述: 空白だけ・201 文字・文字列でないものは送らない。200 文字は送る', async () => {
  const t = await freeAtS2();
  await t.client.submitText('   \n  ');
  await t.client.submitText('あ'.repeat(201));
  await t.client.submitText(5);
  await t.client.submitText(null);
  assert.equal(t.answerSets.length, 0);
  assert.equal(t.last().answer, null);
  await t.client.submitText('あ'.repeat(200));
  assert.equal(t.answers().s2.stu1.text, 'あ'.repeat(200));
});

test('アンケートで submitText、自由記述で select・submit をしても何もしない', async () => {
  const t = await freeAtS2();
  t.client.select(0);
  assert.equal(t.last().selected, null);
  await t.client.submit();
  assert.equal(t.answerSets.length, 0);
  await t.teacher(nextPatch); // s3 アンケート
  assert.equal(t.last().kind, null);
  assert.equal(t.last().text, null);
  await t.client.submitText('アンケートに文章');
  assert.equal(t.answerSets.length, 0);
  t.client.select(1);
  await t.client.submit();
  assert.deepEqual(t.answers().s3.stu1, { choice: 1, at: 12345 });
});

test('自由記述: 応答が失われ、締切を受けると照合して sent と text になる', async () => {
  const t = await freeAtS2();
  loseFirstResponse(t.net);
  await t.client.submitText('とどいた');
  assert.deepEqual(t.last().answer, { text: 'とどいた', state: 'queued' });
  await t.teacher(closeAllPatch);
  await settle();
  assert.deepEqual(t.last().answer, { text: 'とどいた', state: 'sent' });
  assert.equal(t.last().text, 'とどいた');
});

test('自由記述: サーバーに自分の別の文章があれば、照合のあとその文章で sent', async () => {
  const t = await freeAtS2();
  loseFirstResponse(t.net);
  await t.client.submitText('サーバーの文'); // 届いたが、端末は queued
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  await t.client.submitText('端末の文'); // 画面は受付中のまま。拒否 → 照合
  await settle();
  assert.deepEqual(t.last().answer, { text: 'サーバーの文', state: 'sent' });
  assert.equal(t.last().text, 'サーバーの文');
  assert.equal(t.answers().s2.stu1.text, 'サーバーの文');
});

test('自由記述: 送信済みの記録が無い端末でも、保留の照合でサーバーの文章が sent になる', async () => {
  const storage = fakeStorage();
  // 端末の記録は保留の別の文章だけ（送信済みの記録は消えた）。サーバーには自分の文章がある
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({ s2: { text: '端末', state: 'queued' } }));
  const t = setup({ storage, deck: makeFreeDeck() });
  await t.ready();
  await toS2(t);
  await t.net.set(`sessions/${SID}/inbox/answers/s2/stu1`, { text: 'サーバー', at: 1 });
  await t.teacher(closeAllPatch);
  await t.client.start();
  await settle();
  assert.deepEqual(t.last().answer, { text: 'サーバー', state: 'sent' });
  assert.equal(t.last().text, 'サーバー');
});

test('自由記述: 保存できず failed のとき、retry で最後の文章を送り直す', async () => {
  const base = fakeStorage();
  const storage = { getItem: base.getItem, removeItem: base.removeItem, setItem: () => { throw new Error('容量不足'); } };
  const t = await freeAtS2({ storage });
  t.net.setOnline(false);
  await t.client.submitText('いちど目');
  await t.client.submitText('さいご');
  assert.deepEqual(t.last().answer, { text: 'さいご', state: 'failed' });
  t.net.setOnline(true);
  await settle();
  await t.client.retry();
  assert.deepEqual(t.last().answer, { text: 'さいご', state: 'sent' });
  assert.equal(t.answers().s2.stu1.text, 'さいご');
});

test('古い形の保管（choice だけ）も読める', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({ s2: { choice: 1, state: 'queued' } }));
  const t = setup({ storage });
  await t.ready();
  await toS2(t);
  await t.client.start();
  await settle();
  assert.deepEqual(t.last().answer, { choice: 1, state: 'sent' });
  assert.equal(t.last().selected, 1);
  assert.equal(t.answers().s2.stu1.choice, 1);
});

test('書きかけの文章: 保存され、作り直した client で読め、授業の終了で消える', async () => {
  const storage = fakeStorage();
  const t = await freeAtS2({ storage });
  assert.equal(t.client.draft('s2'), '');
  t.client.setDraft('s2', '書きかけ ');
  assert.equal(t.client.draft('s2'), '書きかけ ');
  assert.notEqual(storage.getItem(`classpulse:draft:${SID}:stu1`), null);
  t.client.stop();
  const states2 = [];
  const client2 = createSessionClient({ net: t.net, auth: stubAuth(), storage, sid: SID, onChange: (s) => states2.push(s) });
  await client2.start();
  assert.equal(client2.draft('s2'), '書きかけ ');
  assert.equal(client2.draft('s3'), '');
  await t.teacher(endPatch);
  assert.equal(states2[states2.length - 1].phase, 'ended');
  assert.equal(storage.getItem(`classpulse:draft:${SID}:stu1`), null);
  assert.equal(client2.draft('s2'), '');
  client2.setDraft('s2', 'おわったあと'); // 終わったあとは保存しない
  assert.equal(storage.getItem(`classpulse:draft:${SID}:stu1`), null);
  client2.stop();
});

test('書きかけの文章: 終わった授業に入ると消える', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:draft:${SID}:stu1`, JSON.stringify({ s2: 'のこり' }));
  const t = setup({ storage, deck: makeFreeDeck() });
  await t.ready();
  await t.teacher(endPatch);
  await t.client.start();
  assert.equal(t.last().phase, 'ended');
  assert.equal(storage.getItem(`classpulse:draft:${SID}:stu1`), null);
});

// ---- ワードクラウド ----

// 3 枚の教材: s1 資料、s2 ワードクラウド、s3 アンケート(2択・manual)
function makeCloudDeck() {
  let d = createDeck('雲の教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('cloud'), question: '好きな動物は？' }, 's2');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's3');
  return d;
}

async function cloudAtS2(opts = {}) {
  const t = setup({ ...opts, deck: makeCloudDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  return t;
}

test('ワードクラウド: 言葉を送ると整えて送り、sent と words になる', async () => {
  const t = await cloudAtS2();
  assert.equal(t.last().kind, 'cloud');
  assert.equal(t.last().words, null);
  assert.equal(t.last().text, null);
  await t.client.submitWords(['  ねこ ', '', 'ﾈｺ', 'いぬ']);
  assert.deepEqual(t.answers().s2.stu1, { words: ['ねこ', 'ﾈｺ', 'いぬ'], at: 12345 });
  assert.equal(t.last().kind, 'cloud');
  assert.deepEqual(t.last().words, ['ねこ', 'ﾈｺ', 'いぬ']);
  assert.deepEqual(t.last().answer, { words: ['ねこ', 'ﾈｺ', 'いぬ'], state: 'sent' });
  assert.equal(t.last().selected, null);
  assert.equal(t.last().text, null);
  assert.equal(JSON.stringify(t.last()).includes('stu1'), false);
});

test('ワードクラウド: 送信済みと同じ言葉（中身が同じ）なら送らない。違えば送り直して上書き', async () => {
  const t = await cloudAtS2();
  await t.client.submitWords(['ねこ', 'いぬ']);
  await t.client.submitWords([' ねこ', 'いぬ ', '']);
  await t.client.submitWords(['ねこ', 'いぬ', 'ねこ']);
  assert.equal(t.answerSets.length, 1);
  await t.client.submitWords(['いぬ', 'ねこ']); // 並びがちがう
  assert.equal(t.answerSets.length, 2);
  await t.client.submitWords(['とり']);
  assert.equal(t.answerSets.length, 3);
  assert.deepEqual(Object.keys(t.answers().s2), ['stu1']);
  assert.deepEqual(t.answers().s2.stu1.words, ['とり']);
  assert.deepEqual(t.last().words, ['とり']);
});

test('ワードクラウド: 4 個以上・21 文字は送る前に落ち、全部だめなら送らない', async () => {
  const t = await cloudAtS2();
  await t.client.submitWords(['   ', 'あ'.repeat(21), 5]);
  await t.client.submitWords([]);
  await t.client.submitWords('ねこ');
  await t.client.submitWords(null);
  assert.equal(t.answerSets.length, 0);
  assert.equal(t.last().answer, null);
  await t.client.submitWords(['a', 'b', 'c', 'd', 'あ'.repeat(21)]);
  assert.deepEqual(t.answers().s2.stu1.words, ['a', 'b', 'c']);
  await t.client.submitWords(['あ'.repeat(21), 'あ'.repeat(20)]);
  assert.deepEqual(t.answers().s2.stu1.words, ['あ'.repeat(20)]);
});

test('ワードクラウド: 送信中に別の言葉へ書き直すと、最後の言葉がサーバーと状態に残る', async () => {
  const t = await cloudAtS2();
  const gates = [];
  const origSet = t.net.set;
  t.net.set = async (path, value) => {
    if (path.includes('/inbox/answers/')) await new Promise((r) => gates.push(r));
    return origSet(path, value);
  };
  const p1 = t.client.submitWords(['はじめ']);
  await settle();
  const p2 = t.client.submitWords(['つぎ']);
  const p3 = t.client.submitWords(['さいご', 'です']);
  assert.deepEqual(t.last().words, ['さいご', 'です']);
  assert.equal(t.last().answer.state, 'sending');
  for (let i = 0; i < 6; i++) {
    await settle();
    const g = gates.shift();
    if (g) g();
  }
  await Promise.all([p1, p2, p3]);
  await settle();
  assert.deepEqual(t.answers().s2.stu1.words, ['さいご', 'です']);
  assert.deepEqual(t.last().answer, { words: ['さいご', 'です'], state: 'sent' });
  assert.deepEqual(t.answerSets.map((s) => s.value.words), [['はじめ'], ['さいご', 'です']]);
});

test('ワードクラウド: 切れている間は queued、つながると最後の言葉だけ送られる', async () => {
  const t = await cloudAtS2();
  t.net.setOnline(false);
  await t.client.submitWords(['まえ']);
  await t.client.submitWords(['あと']);
  assert.deepEqual(t.last().answer, { words: ['あと'], state: 'queued' });
  const n = t.answerSets.length;
  t.net.setOnline(true);
  await settle();
  assert.deepEqual(t.answerSets.slice(n).map((s) => s.value.words), [['あと']]);
  assert.deepEqual(t.last().answer, { words: ['あと'], state: 'sent' });
});

test('ワードクラウド: 締切後に届いた送信は rejected、締切・一時停止が分かっていれば送らない', async () => {
  const t = await cloudAtS2();
  await t.teacher((pub) => pausePatch(pub, 's2', true));
  await t.client.submitWords(['ていし']);
  assert.equal(t.answerSets.length, 0);
  await t.teacher((pub) => pausePatch(pub, 's2', false));
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  await t.client.submitWords(['おそい']);
  assert.deepEqual(t.last().answer, { words: ['おそい'], state: 'rejected' });
  assert.equal(t.answers(), null);
  t.releaseUpdates();
  await settle();
  const n = t.answerSets.length;
  await t.client.submitWords(['しめきり']);
  assert.equal(t.answerSets.length, n);
});

test('アンケート・自由記述で submitWords、ワードクラウドで submitText・submit をしても何もしない', async () => {
  const t = await cloudAtS2();
  await t.client.submitText('ぶんしょう');
  t.client.select(0);
  await t.client.submit();
  assert.equal(t.answerSets.length, 0);
  await t.teacher(nextPatch); // s3 アンケート
  assert.equal(t.last().kind, null);
  assert.equal(t.last().words, null);
  await t.client.submitWords(['ことば']);
  assert.equal(t.answerSets.length, 0);
  const f = await freeAtS2();
  await f.client.submitWords(['ことば']);
  assert.equal(f.answerSets.length, 0);
  assert.equal(f.last().words, null);
});

test('ワードクラウド: 応答が失われ、締切を受けると照合して sent になる（中身で比べる）', async () => {
  const t = await cloudAtS2();
  loseFirstResponse(t.net);
  await t.client.submitWords(['とどいた', 'ことば']);
  assert.deepEqual(t.last().answer, { words: ['とどいた', 'ことば'], state: 'queued' });
  await t.teacher(closeAllPatch);
  await settle();
  assert.deepEqual(t.last().answer, { words: ['とどいた', 'ことば'], state: 'sent' });
  assert.deepEqual(t.last().words, ['とどいた', 'ことば']);
});

test('ワードクラウド: サーバーに自分の別の言葉があれば、照合のあとその言葉で sent', async () => {
  const t = await cloudAtS2();
  loseFirstResponse(t.net);
  await t.client.submitWords(['サーバー']); // 届いたが、端末は queued
  t.holdUpdates();
  await t.teacher(closeAllPatch);
  await t.client.submitWords(['端末']); // 画面は受付中のまま。拒否 → 照合
  await settle();
  assert.deepEqual(t.last().answer, { words: ['サーバー'], state: 'sent' });
  assert.deepEqual(t.answers().s2.stu1.words, ['サーバー']);
});

test('ワードクラウド: 保留の照合で、データベースの形（0・1 の鍵）の自分の言葉も sent になる', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({ s2: { words: ['端末'], state: 'queued' } }));
  const t = setup({ storage, deck: makeCloudDeck() });
  await t.ready();
  await toS2(t);
  await t.net.set(`sessions/${SID}/inbox/answers/s2/stu1`, { words: { 0: ' サーバー', 2: 'ことば' }, at: 1 });
  await t.teacher(closeAllPatch);
  await t.client.start();
  await settle();
  assert.deepEqual(t.last().answer, { words: ['サーバー', 'ことば'], state: 'sent' });
  assert.deepEqual(t.last().words, ['サーバー', 'ことば']);
});

test('ワードクラウド: 保存できず failed のとき、retry で最後の言葉を送り直す', async () => {
  const base = fakeStorage();
  const storage = { getItem: base.getItem, removeItem: base.removeItem, setItem: () => { throw new Error('容量不足'); } };
  const t = await cloudAtS2({ storage });
  t.net.setOnline(false);
  await t.client.submitWords(['いちど目']);
  await t.client.submitWords(['さいご']);
  assert.deepEqual(t.last().answer, { words: ['さいご'], state: 'failed' });
  t.net.setOnline(true);
  await settle();
  await t.client.retry();
  assert.deepEqual(t.last().answer, { words: ['さいご'], state: 'sent' });
  assert.deepEqual(t.answers().s2.stu1.words, ['さいご']);
});

test('ワードクラウド: 古い形の保管（choice・text）がまざっていても読める', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:outbox:${SID}:stu1`, JSON.stringify({
    s2: { words: ['ほかん'], state: 'queued' }, s3: { choice: 1, state: 'sent' }, x: { text: 'まえ', state: 'sent' },
  }));
  const t = setup({ storage, deck: makeCloudDeck() });
  await t.ready();
  await toS2(t);
  await t.client.start();
  await settle();
  assert.deepEqual(t.last().answer, { words: ['ほかん'], state: 'sent' });
  assert.deepEqual(t.answers().s2.stu1.words, ['ほかん']);
});

test('ワードクラウドの書きかけ: 3 つの欄の配列で保存され、作り直した client で読め、終了で消える', async () => {
  const storage = fakeStorage();
  const t = await cloudAtS2({ storage });
  assert.deepEqual(t.client.draft('s2'), ['', '', '']);
  t.client.setDraft('s2', ['ねこ ', '', 'い']);
  assert.deepEqual(t.client.draft('s2'), ['ねこ ', '', 'い']);
  t.client.setDraft('s3', 'ぶんしょう'); // 文字列の書きかけと共存する
  t.client.stop();
  const states2 = [];
  const client2 = createSessionClient({ net: t.net, auth: stubAuth(), storage, sid: SID, onChange: (s) => states2.push(s) });
  await client2.start();
  assert.deepEqual(client2.draft('s2'), ['ねこ ', '', 'い']);
  assert.equal(client2.draft('s3'), 'ぶんしょう');
  client2.setDraft('s2', ['', '', '']); // 全部空なら消す
  assert.deepEqual(client2.draft('s2'), ['', '', '']);
  assert.deepEqual(JSON.parse(storage.getItem(`classpulse:draft:${SID}:stu1`)), { s3: 'ぶんしょう' });
  client2.setDraft('s2', ['a', 5, 'b', 'c']); // 文字列でないものは空、4 つ目は捨てる
  assert.deepEqual(client2.draft('s2'), ['a', '', 'b']);
  await t.teacher(endPatch);
  assert.equal(storage.getItem(`classpulse:draft:${SID}:stu1`), null);
  assert.deepEqual(client2.draft('s2'), ['', '', '']);
  client2.stop();
});

test('ワードクラウドの書きかけ: 保存された中身がこわれていても 3 つの文字列で返す', async () => {
  const storage = fakeStorage();
  storage.setItem(`classpulse:draft:${SID}:stu1`, JSON.stringify({ s2: 'もじれつ', s3: ['x'] }));
  const t = await cloudAtS2({ storage });
  assert.deepEqual(t.client.draft('s2'), ['', '', '']);
  assert.equal(t.client.draft('s3'), ''); // アンケートの所に配列があっても文字列で返す
});

// ---- クイズ（quiz）と 5 段階評価（rating）----

// s1 資料、s2 クイズ（3 択。正解は 3 つ目）、s3 評価（manual）
function quizDeck() {
  let d = createDeck('クイズの教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('quiz'), question: '富士山がある県は？', options: ['長野', '山梨', '静岡'], correct: 2 }, 's2');
  d = addSlide(d, { ...createSlide('rating'), question: '満足度は？', lowLabel: 'ふまん', highLabel: 'まんぞく' }, 's3');
  return d;
}

// 先生の「正解を表示」（締切と表示を 1 回で、そのあと集計と正解）
async function reveal(t, slideId, results) {
  await t.net.update(PUB, { [`polls/${slideId}/status`]: 'closed', [`polls/${slideId}/resultsVisible`]: true });
  await t.net.update(PUB, { [`results/${slideId}`]: results });
}

test('クイズ: 選んで送れる。表示の前は correct も isCorrect も null で、スライドに正解が無い', async () => {
  const t = setup({ deck: quizDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  assert.equal(t.last().kind, 'quiz');
  assert.equal(Object.hasOwn(t.last().slide, 'correct'), false);
  assert.deepEqual(t.last().slide.options, ['長野', '山梨', '静岡']);
  t.client.select(3); // 範囲外は選べない
  assert.equal(t.last().selected, null);
  t.client.select(1);
  await t.client.submit();
  assert.deepEqual(t.answers().s2.stu1, { choice: 1, at: 12345 });
  assert.equal(t.last().answer.state, 'sent');
  assert.equal(t.last().correct, null);
  assert.equal(t.last().isCorrect, null);
  for (const s of t.states) {
    assert.equal(s.correct ?? null, null);
    assert.ok(!JSON.stringify(s.slide ?? null).includes('correct'));
  }
});

test('クイズ: 正解の表示のあと correct と isCorrect が入り、もう送れない・選べない', async () => {
  const t = setup({ deck: quizDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(1);
  await t.client.submit();
  await reveal(t, 's2', { counts: [0, 1, 0], total: 1, correct: 2 });
  assert.equal(t.last().poll.status, 'closed');
  assert.deepEqual(t.last().results, { counts: [0, 1, 0], total: 1 });
  assert.equal(t.last().correct, 2);
  assert.equal(t.last().isCorrect, false);
  const n = t.answerSets.length;
  t.client.select(2);
  assert.equal(t.last().selected, 1);
  await t.client.submit();
  assert.equal(t.answerSets.length, n);
  assert.equal(t.answers().s2.stu1.choice, 1);
  // かくすと消える
  await t.net.update(PUB, { 'polls/s2/resultsVisible': false, 'results/s2': null });
  assert.equal(t.last().correct, null);
  assert.equal(t.last().isCorrect, null);
});

test('クイズ: 正解なら isCorrect は true、答えていなければ null', async () => {
  const a = setup({ deck: quizDeck() });
  await a.ready();
  await a.client.start();
  await toS2(a);
  a.client.select(2);
  await a.client.submit();
  await reveal(a, 's2', { counts: [0, 0, 1], total: 1, correct: 2 });
  assert.equal(a.last().correct, 2);
  assert.equal(a.last().isCorrect, true);

  const b = setup({ deck: quizDeck() });
  await b.ready();
  await b.client.start();
  await toS2(b);
  b.client.select(0); // 選んだが送っていない
  await reveal(b, 's2', { counts: [0, 0, 0], total: 0, correct: 2 });
  assert.equal(b.last().correct, 2);
  assert.equal(b.last().isCorrect, null);
});

test('クイズ: 正しくない correct（範囲外・文字列）は null として扱う', async () => {
  const t = setup({ deck: quizDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  await reveal(t, 's2', { counts: [0, 0, 0], total: 0, correct: 3 });
  assert.equal(t.last().correct, null);
  await t.net.update(PUB, { 'results/s2': { counts: [0, 0, 0], total: 0, correct: '1' } });
  assert.equal(t.last().correct, null);
});

test('クイズ: 送信中に正解が表示されて拒否されたら、もう送り直さない', async () => {
  const t = setup({ deck: quizDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  t.client.select(0);
  t.holdUpdates(); // 締切は画面にまだ届かない
  await reveal(t, 's2', { counts: [0, 0, 0], total: 0, correct: 2 });
  await t.client.submit();
  assert.equal(t.last().answer.state, 'rejected');
  assert.equal(t.answers(), null);
  t.releaseUpdates();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.answers(), null);
  assert.equal(t.last().isCorrect, null);
});

test('評価: 1〜5（choice 0〜4）を選んで送れる。5 以上は選べない', async () => {
  const t = setup({ deck: quizDeck() });
  await t.ready();
  await t.client.start();
  await toS2(t);
  await t.teacher(nextPatch); // s3 評価
  assert.equal(t.last().kind, 'rating');
  assert.equal(t.last().slide.lowLabel, 'ふまん');
  t.client.select(5);
  assert.equal(t.last().selected, null);
  t.client.select(4);
  await t.client.submit();
  assert.deepEqual(t.answers().s3.stu1, { choice: 4, at: 12345 });
  assert.equal(t.last().answer.state, 'sent');
  t.client.select(0);
  await t.client.submit();
  assert.equal(t.answers().s3.stu1.choice, 0);
  assert.equal(t.last().correct, null);
  assert.equal(t.last().isCorrect, null);
  await t.net.update(PUB, { 'polls/s3/resultsVisible': true, 'results/s3': { counts: [1, 0, 0, 0, 0], total: 1 } });
  assert.deepEqual(t.last().results, { counts: [1, 0, 0, 0, 0], total: 1 });
  assert.equal(t.last().correct, null);
});

test('アンケートは kind が null のまま、correct・isCorrect も null', async () => {
  const t = setup();
  await t.ready();
  await t.client.start();
  await toS2(t);
  assert.equal(t.last().kind, null);
  await t.net.update(PUB, { 'polls/s2/resultsVisible': true, 'results/s2': { counts: [1, 0], total: 1, correct: 0 } });
  assert.equal(t.last().correct, null);
  assert.equal(t.last().isCorrect, null);
});
