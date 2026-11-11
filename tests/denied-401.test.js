// 実物の Firebase と同じ「規則による拒否は HTTP 401 + {"error":"Permission denied"}」を、
// 通信層（createNet）と生徒のクライアント（createSessionClient）を通して確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildSession, nextPatch, pausePatch } from '../js/session-logic.js';
import { createNet } from '../js/net.js';
import { createSessionClient } from '../js/session-client.js';
import { createFakeNet } from './helpers/fake-net.js';
import { fakeFetch, fakeEventSource, fakeStorage } from './helpers/fakes.js';

const DB = 'https://example-db.firebaseio.com';
const SID = 'sess1';
const PUB = `sessions/${SID}/pub`;
const settle = () => new Promise((r) => setImmediate(r));

function makeDeck() {
  let d = createDeck('テスト教材', 1000);
  d = addSlide(d, createSlide('content'), 's1');
  d = addSlide(d, { ...createSlide('poll'), question: '好きな色は？', options: ['赤', '青'], resultMode: 'manual' }, 's2');
  return d;
}

// メモリ上のデータベースを、REST（fetch）と変化の受信（EventSource）の形で見せる「サーバー」
function fakeServer() {
  let db;
  // 規則の代わり: 回答の set は「授業が live・その質問が open・今のスライド」のときだけ通す
  const deny = (op, path) => {
    const m = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\/[^/]+$/.exec(path);
    if (op !== 'set' || !m) return false;
    const pub = db.dump()?.sessions?.[m[1]]?.pub;
    return !(pub && pub.state === 'live' && pub.polls?.[m[2]]?.status === 'open' && pub.current?.slideId === m[2]);
  };
  db = createFakeNet({ now: () => 12345, deny });
  const requests = [];
  const fetch = fakeFetch(async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\//, '').replace(/\.json$/, '');
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method, path });
    try {
      if (init.method === 'GET') return { status: 200, body: await db.get(path) };
      if (init.method === 'PUT') await db.set(path, body);
      else if (init.method === 'PATCH') await db.update(path, body);
      else if (init.method === 'DELETE') await db.remove(path);
      return { status: 200, body: body ?? null };
    } catch (e) {
      // 実物の Firebase: 規則による拒否は 401 と {"error":"Permission denied"}
      if (e && e.code === 'denied') return { status: 401, body: { error: 'Permission denied' } };
      return { status: 500, body: { error: 'internal' } };
    }
  });
  const ES = fakeEventSource();
  return {
    db, fetch, ES, requests,
    // 今の pub を、開いている接続へ流す
    pushPub: () => ES.last.emit('put', { path: '/', data: db.dump().sessions[SID].pub }),
    teacher: async (fn) => {
      const s = db.dump().sessions[SID];
      const patch = fn(s.pub, s.deck.order);
      if (patch) await db.update(PUB, patch);
    },
  };
}

test('受付停止と送信が重なる: 401 Permission denied → 一時保存（queued）→ 再開で自動再送 → sent', async () => {
  const server = fakeServer();
  await server.db.set(`sessions/${SID}`, buildSession(makeDeck(), 'deck1', 'teacher', 1));
  const auth = {
    refreshes: 0,
    signInAnonymous: async () => ({ uid: 'stu1' }),
    getToken: async () => 'tok',
    forceRefresh: async () => { auth.refreshes += 1; return 'tok2'; },
  };
  const net = createNet({ databaseURL: DB, auth, fetch: server.fetch, EventSource: server.ES, setTimeout: () => 0, clearTimeout: () => {} });
  const states = [];
  const client = createSessionClient({ net, auth, storage: fakeStorage(), sid: SID, onChange: (s) => states.push(s) });
  const last = () => states[states.length - 1];

  await client.start();
  await settle();
  server.ES.last.open();
  await server.teacher(nextPatch); // s1
  await server.teacher(nextPatch); // s2（受付中）
  server.pushPub();
  await settle();
  assert.equal(last().poll.status, 'open');

  // 先生が受付を止めた。生徒の画面にはまだ届いていない
  await server.teacher((pub) => pausePatch(pub, 's2', true));
  client.select(1);
  await client.submit();
  await settle();
  const put = server.requests.filter((r) => r.method === 'PUT' && r.path.includes('/inbox/answers/'));
  assert.equal(put.length, 1);
  assert.equal(auth.refreshes, 0); // 拒否では、トークンを取り直さない
  assert.deepEqual(last().answer, { choice: 1, state: 'queued' }); // failed ではない
  assert.equal(server.db.dump().sessions[SID].inbox?.answers, undefined);

  server.pushPub(); // 停止が画面に届く
  await settle();
  assert.equal(last().poll.status, 'paused');
  assert.deepEqual(last().answer, { choice: 1, state: 'queued' });

  // 再開すると、保留の回答が自動で送られる
  await server.teacher((pub) => pausePatch(pub, 's2', false));
  server.pushPub();
  await settle();
  await settle();
  assert.deepEqual(last().answer, { choice: 1, state: 'sent' });
  assert.equal(server.db.dump().sessions[SID].inbox.answers.s2.stu1.choice, 1);
  client.stop();
});
