// 実際の host・client をメモリ通信につなぐ。外部のサービスには接続しない
import { performance } from 'node:perf_hooks';
import { createMemoryNet } from '../../js/dev/memory-net.js';
import { createSessionHost, startSession } from '../../js/session-host.js';
import { createSessionClient } from '../../js/session-client.js';
import { createRepo } from '../../js/repo.js';
import { createDeck, createSlide, addSlide } from '../../js/model.js';
import { NetError } from '../../js/errors.js';
import { fakeStorage } from './fakes.js';
import { fakeScheduler, flush } from './resilience.js';

// 1 人の端末だけを切る包み。復帰時には、古い通知の列ではなく最新の全体を渡す
export function clientConnection(net, onReceive = () => {}) {
  let online = true;
  const subscriptions = new Set();
  const guard = () => { if (!online) throw new NetError('network', 'シミュレーションの通信断'); };
  const wrapped = {
    async get(path) { guard(); return net.get(path); },
    async set(path, value) { guard(); return net.set(path, value); },
    async update(path, patch) { guard(); return net.update(path, patch); },
    async remove(path) { guard(); return net.remove(path); },
    serverTimestamp: () => net.serverTimestamp(),
    subscribe(path, onValue, onStatus) {
      const sub = { onStatus, latest: null, receive(value) { onReceive(path, value); onValue(value); } };
      subscriptions.add(sub);
      const stop = net.subscribe(path, (value) => {
        sub.latest = value;
        if (online) sub.receive(value);
      }, (status) => { if (online && onStatus) onStatus(status); });
      return () => { subscriptions.delete(sub); stop(); };
    },
  };
  return {
    net: wrapped,
    get subscriptions() { return subscriptions.size; },
    setOnline(value) {
      if (online === value) return;
      online = value;
      for (const sub of [...subscriptions]) {
        if (online) sub.receive(sub.latest);
        if (subscriptions.has(sub) && sub.onStatus) sub.onStatus(online ? 'connected' : 'disconnected');
      }
    },
  };
}

function makeDeck() {
  let deck = createDeck('負荷確認用の教材', 1000);
  for (const type of ['poll', 'quiz', 'rating', 'free', 'cloud']) {
    const slide = { ...createSlide(type), question: `${type} の確認用の質問` };
    if (type === 'poll' || type === 'quiz') slide.options = ['選択肢 1', '選択肢 2'];
    if (type === 'quiz') slide.correct = 1;
    if (type === 'poll' || type === 'rating') slide.resultMode = 'live';
    deck = addSlide(deck, slide, type);
  }
  return deck;
}

export async function runLoadSimulation(count = 30) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('人数は 1 以上の整数にしてください');
  const clock = fakeScheduler(1000);
  let currentRoot = null;
  let pubWrites = 0;
  let hostChanges = 0;
  let hostState;
  const resultsWrites = {};
  const net = createMemoryNet({
    now: clock.now,
    // 締切後の送信が成功したように見えないよう、回答の受付条件も再現する
    deny(op, path) {
      const match = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\//.exec(path);
      if (op !== 'set' || !match) return false;
      const pub = currentRoot?.sessions?.[match[1]]?.pub;
      return !(pub?.state === 'live' && pub.current?.slideId === match[2] && pub.polls?.[match[2]]?.status === 'open');
    },
    onChange(root, writes) {
      currentRoot = root;
      if (writes.some(([path]) => /\/pub(?:\/|$)/.test(path))) pubWrites++;
      for (const [path, value] of writes) {
        const match = /\/pub\/results\/([^/]+)$/.exec(path);
        if (match && value !== null) resultsWrites[match[1]] = (resultsWrites[match[1]] || 0) + 1;
      }
    },
  });
  const repo = createRepo(net, 'load-teacher');
  const deck = makeDeck();
  const sid = await startSession({
    net, repo, uid: 'load-teacher', deckId: 'load-deck', deck, now: clock.now,
    getRandomValues: (bytes) => { bytes.forEach((_, i) => { bytes[i] = i + 1; }); return bytes; },
  });
  const deckCharacters = JSON.stringify(await net.get(`sessions/${sid}/deck`)).length;
  const host = createSessionHost({ net, repo, sid, ...clock, onChange: (state) => { hostChanges++; hostState = state; } });
  const students = [];
  const questions = [];
  let queued = 0;
  let recovered = 0;
  let behind = 0;
  let caughtUp = 0;
  let participants = 0;
  const startedAt = performance.now();
  try {
    await host.start();
    for (let i = 0; i < count; i++) {
      const student = { state: null, pubEvents: 0, pubCharacters: 0 };
      student.connection = clientConnection(net, (path, value) => {
        if (path.endsWith('/pub')) { student.pubEvents++; student.pubCharacters += JSON.stringify(value).length; }
      });
      student.client = createSessionClient({
        net: student.connection.net, auth: { signInAnonymous: async () => ({ uid: `load-student-${i}` }) },
        storage: fakeStorage(), sid, ...clock, random: () => 0,
        onChange: (state) => { student.state = state; },
      });
      students.push(student);
    }
    await Promise.all(students.map((s) => s.client.start()));
    participants = hostState.participants;
    const interrupted = students.slice(0, Math.min(5, count));
    for (const type of deck.order) {
      // スライド移動中の断と、回答が未送信になる断を分け、締切済みの回答は再送しない
      if (type === 'quiz') interrupted.forEach((s) => s.connection.setOnline(false));
      await host.next();
      if (type === 'quiz') {
        behind = interrupted.filter((s) => s.state.slideId === 'poll').length;
        interrupted.forEach((s) => s.connection.setOnline(true));
        await flush();
        caughtUp = interrupted.filter((s) => s.state.slideId === type).length;
      }
      if (type === 'free' || type === 'cloud') await host.setResultsVisible(true);
      if (type === 'poll') interrupted.forEach((s) => s.connection.setOnline(false));
      const answer = (student, index, changed = false) => {
        if (type === 'free') return student.client.submitText(`確認文 ${index}${changed ? ' 改訂' : ''}`);
        if (type === 'cloud') return student.client.submitWords(changed ? ['空', '雨'] : ['空', '雲']);
        student.client.select((index + (changed ? 1 : 0)) % (type === 'rating' ? 5 : 2));
        return student.client.submit();
      };
      await Promise.all(students.map((s, i) => answer(s, i)));
      if (type === 'poll') {
        queued = interrupted.filter((s) => s.state.answer?.state === 'queued').length;
        interrupted.forEach((s) => s.connection.setOnline(true));
        await flush();
        recovered = interrupted.filter((s) => s.state.answer?.state === 'sent').length;
      }
      await Promise.all(students.slice(0, Math.min(5, count)).map((s, i) => answer(s, i, true)));
      await clock.advance(500);
      if (type === 'quiz') await host.setResultsVisible(true);
      const answers = await net.get(`sessions/${sid}/inbox/answers/${type}`);
      const pubResult = await net.get(`sessions/${sid}/pub/results/${type}`);
      questions.push({
        type, total: hostState.answerCount ?? hostState.tallies[type]?.total,
        stored: Object.keys(answers || {}).length,
        resultsWrites: resultsWrites[type] || 0,
        publishedTotal: pubResult?.total ?? null,
      });
    }
    await host.end();
    await flush();
    const processingMs = performance.now() - startedAt;
    const history = await repo.getHistory(sid);
    const result = {
      count, processingMs, hostChanges, pubWrites,
      // 通信を切らなかった最後の 1 人（5 人以下なら復帰した最後の 1 人）
      studentPubEvents: students.at(-1).pubEvents,
      studentPubCharacters: students.at(-1).pubCharacters,
      deckCharacters, participants, questions, history,
      recovery: { interrupted: interrupted.length, queued, recovered, behind, caughtUp },
      finalStates: students.map((s) => ({ phase: s.state.phase, slideId: s.state.slideId, pollStatus: s.state.poll?.status })),
      hostFinal: { phase: hostState.phase, slideId: hostState.pub.current.slideId },
    };
    return result;
  } finally {
    students.forEach((s) => s.client.stop());
    await host.stop();
    if (clock.count !== 0 || students.some((s) => s.connection.subscriptions !== 0)) throw new Error('終了後にタイマーか購読が残っています');
  }
}
