import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSession } from '../js/session-logic.js';
import { createSessionHost } from '../js/session-host.js';
import { createSessionClient } from '../js/session-client.js';
import { isItemVisible } from '../js/animation.js';
import { createFakeNet } from './helpers/fake-net.js';
import { fakeStorage } from './helpers/fakes.js';
import { fakeScheduler, flush } from './helpers/resilience.js';

const deck = {
  title: '順番の確認', order: ['a', 'q', 'b'], images: {},
  slides: {
    a: { type: 'content', items: [{ id: 'a1', kind: 'text', text: '最初' }, { id: 'a2', kind: 'text', text: '一回目', step: 1 }, { id: 'a3', kind: 'text', text: '二回目', step: 3 }] },
    q: { type: 'poll', question: '確認', options: ['はい', 'いいえ'], resultMode: 'manual' },
    b: { type: 'content', items: [{ id: 'b1', kind: 'text', text: '最後', step: 1 }] },
  },
};

async function setup(t, current) {
  const session = buildSession(deck, 'deck', 'teacher-test', 1);
  if (current) session.pub.current = current;
  const net = createFakeNet({ initial: { sessions: { animation: session } } });
  const subscribe = net.subscribe;
  net.subscribe = (path, onValue, onStatus) => {
    let online = true;
    return subscribe(path, (value) => { if (online) onValue(value); }, (status) => {
      online = status === 'connected'; onStatus(status);
    });
  };
  const clock = fakeScheduler();
  const hostStates = [], clientStates = [];
  const host = createSessionHost({ net, repo: { getModeration: async () => null }, sid: 'animation', onChange: (s) => hostStates.push(s), ...clock });
  const client = createSessionClient({ net, auth: { signInAnonymous: async () => ({ uid: 'student-test' }) }, storage: fakeStorage(), sid: 'animation', onChange: (s) => clientStates.push(s), ...clock });
  t.after(async () => { client.stop(); await host.stop(); });
  await host.start();
  await client.start();
  await flush();
  return { net, host, client, hostStates, clientStates, hostState: () => hostStates.at(-1), clientState: () => clientStates.at(-1) };
}

test('先生と生徒: 連打は一回ずつ直列。資料中は締切なし、最後でも授業を終えない', async (t) => {
  const h = await setup(t);
  await h.host.next();
  assert.equal(h.clientState().step, 0);
  await Promise.all([h.host.next(), h.host.next()]);
  assert.equal(h.hostState().pub.current.slideId, 'a');
  assert.equal(h.clientState().step, 2);
  assert.equal(h.hostState().pub.polls.q.status, 'waiting');
  assert.deepEqual([...new Set(h.clientStates.filter((s) => s.slideId === 'a').map((s) => s.step))], [0, 1, 2]);
  await h.host.next();
  assert.equal(h.hostState().pub.polls.q.status, 'open');
  await h.host.prev();
  assert.equal(h.clientState().step, 2);
  assert.equal(h.hostState().pub.polls.q.status, 'closed');
  await h.host.prev();
  assert.equal(h.clientState().step, 1);
  assert.equal(h.hostState().pub.polls.q.status, 'closed');
  await h.host.next(); await h.host.next(); await h.host.next();
  assert.equal(h.clientState().slideId, 'b');
  assert.equal(h.clientState().step, 0);
  await h.host.next(); await h.host.next();
  assert.equal(h.clientState().step, 1);
  assert.equal(h.hostState().pub.state, 'live');
});

for (const [step, expected, visible] of [[undefined, null, 3], ['文字', null, 3], ['3', null, 3], [null, null, 3], [-1, 0, 1], [999, 2, 3], [1.7, 1, 2]]) {
  test(`生徒の受信: step=${String(step)} (${typeof step}) は ${String(expected)}。新しい失敗表示なし`, async (t) => {
    const h = await setup(t, { slideId: 'a', index: 0, step });
    const s = h.clientState();
    assert.equal(s.phase, 'live');
    assert.equal(s.step, expected);
    assert.equal(s.slide.items.filter((item) => isItemVisible(s.slide, item, s.step)).length, visible);
    assert.equal(h.clientStates.find((state) => state.phase === 'live').animate, false);
  });
}

test('途中参加・つなぎ直しは今の回数を動かさず受信。その後の次へは動かす', async (t) => {
  const h = await setup(t, { slideId: 'a', index: 0, step: 1 });
  assert.equal(h.clientStates.find((s) => s.phase === 'live').animate, false);
  await h.host.next();
  assert.equal(h.clientState().step, 2);
  assert.equal(h.clientState().animate, true);
  h.net.setOnline(false);
  const remote = h.net.dump();
  remote.sessions.animation.pub.current.step = 0;
  h.net.replaceRoot(remote);
  h.net.setOnline(true);
  assert.equal(h.clientState().step, 0);
  assert.equal(h.clientState().animate, false);
  assert.equal(h.hostState().animate, false);
  await h.host.next();
  assert.equal(h.clientState().step, 1);
  assert.equal(h.clientState().animate, true);
  assert.equal(h.hostState().animate, true);
});

test('先生を開き直しても今の回数から続ける。古いデータは全部出た状態から次へ', async (t) => {
  const h = await setup(t, { slideId: 'a', index: 0, step: 1 });
  assert.equal(h.hostState().pub.current.step, 1);
  await h.host.next();
  assert.equal(h.hostState().pub.current.step, 2);
  await h.net.set('sessions/animation/pub/current', { slideId: 'a', index: 0 });
  await h.host.next();
  assert.equal(h.hostState().pub.current.slideId, 'q');
  assert.equal(h.hostState().pub.current.step, 0);
});
