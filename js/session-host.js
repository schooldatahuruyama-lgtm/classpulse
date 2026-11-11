// 先生側: 授業を始め、スライドを進め、受付を止め、結果を公開し、授業を終える。
// DOM・グローバルに触れない（net・repo・タイマー・now は引数で受け取る）。
// 状態の変更は、すべて session-logic のパッチを通す（規則をここで作り直さない）。
// 同じ授業を別のタブでも開けるので、pub は自分の書きこみだけで決めない:
// - pub を購読して、別のタブの変更（かくす・進める・終える）を state.pub に取りこむ
// - 操作（次へ・停止・公開など）は、順番が来た時点でサーバーの最新の pub を読んでからパッチを作る
// - 集計を書くかどうかは、その時点の state.pub で決める（かくした質問の集計は、規則でも書けない）
import { CONFIG } from './config.js';
import { validateDeck, newSessionId, normalizeDeck } from './model.js';
import {
  buildSession, nextPatch, prevPatch, pausePatch, resultsVisiblePatch,
  tally, applyPatch, closeAllPatch, endPatch, buildHistory,
} from './session-logic.js';

// 教材を検査し、通れば授業を書いて「発表中」の印を付ける。授業 ID を返す
export async function startSession({ net, repo, uid, deckId, deck, now, getRandomValues }) {
  const reasons = validateDeck(deck);
  if (reasons.length) {
    const err = new Error(reasons.join('\n'));
    err.reasons = reasons;
    throw err;
  }
  const sid = newSessionId(getRandomValues);
  const startedAt = now();
  await net.set(`sessions/${sid}`, buildSession(deck, deckId, uid, startedAt));
  await repo.setActive({ sid, deckId, startedAt });
  return sid;
}

// 停止した host の未完了の書きこみ（sid → Promise）。同じ授業を開く次の host は、これを待ってから状態を読む
const drains = new Map();

function stoppedError() {
  return new Error('この画面は閉じられました');
}

export function createSessionHost({ net, repo, sid, onChange, now, setTimeout: setT, clearTimeout: clearT }) {
  const base = `sessions/${sid}`;
  const pubPath = `${base}/pub`;
  const inboxPath = `${base}/inbox`;

  const state = {
    phase: 'loading', connection: 'connected', title: '',
    order: [], slides: {}, images: {},
    pub: null, participants: 0, tallies: {},
  };
  let meta = { deckId: '', startedAt: 0 };
  let inbox = null;
  let unsubscribe = null;      // inbox の購読
  let unsubscribePub = null;   // pub の購読（別のタブの変更を知る）
  const online = { inbox: true, pub: true };
  let stopped = false;
  let ending = false;          // end の途中は結果を書かない
  const pendingResults = new Set(); // 結果の書きこみが順番待ち・実行中の質問
  const timers = new Map();    // slideId → タイマー
  const lastWriteAt = new Map();

  // 操作は 1 つずつ。失敗しても次の操作は止めない
  let tail = Promise.resolve();
  function enqueue(fn) {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  }

  function emit() {
    if (stopped) return;
    onChange({ ...state, tallies: { ...state.tallies } });
  }

  function currentSlideId() {
    const cur = state.pub && state.pub.current;
    return cur && typeof cur.slideId === 'string' ? cur.slideId : '';
  }

  // 回答の箱から、質問ごとの集計と人数を作り直す
  function recompute() {
    const answers = (inbox && inbox.answers) || {};
    const tallies = {};
    for (const id of state.order) {
      const s = state.slides[id];
      if (s && s.type === 'poll') tallies[id] = tally(answers[id], (s.options || []).length);
    }
    state.tallies = tallies;
    state.participants = Object.keys((inbox && inbox.participants) || {}).length;
  }

  // pub に書いてある集計と食い違っているか
  function writtenResults(id) {
    const r = state.pub && state.pub.results && state.pub.results[id];
    return r ? JSON.stringify({ counts: r.counts, total: r.total }) : '';
  }
  function needsResults(id) {
    const poll = state.pub && state.pub.polls && state.pub.polls[id];
    const t = state.tallies[id];
    if (!poll || !t || !poll.resultsVisible || poll.status === 'waiting') return false;
    return JSON.stringify({ counts: t.counts, total: t.total }) !== writtenResults(id);
  }

  function clearTimers() {
    for (const t of timers.values()) clearT(t);
    timers.clear();
  }

  // 公開中の質問の集計を pub に書く（500ms に 1 回まで。最後の値は必ず書く）
  function syncResults() {
    if (stopped || ending || state.phase !== 'live') return;
    for (const id of Object.keys(state.tallies)) {
      if (timers.has(id) || pendingResults.has(id) || !needsResults(id)) continue;
      const last = lastWriteAt.get(id);
      const wait = last === undefined ? 0 : Math.max(0, last + CONFIG.resultsThrottleMs - now());
      if (wait === 0) {
        writeResults(id);
      } else {
        timers.set(id, setT(() => { timers.delete(id); syncResults(); }, wait));
      }
    }
  }

  function writeResults(id) {
    pendingResults.add(id);
    enqueue(async () => {
      // 順番が来た時点で、まだ公開中かを確かめる（かくした直後に書かない）
      if (stopped || ending || state.phase !== 'live' || !needsResults(id)) return;
      // 実際に送る時刻を基準に、間隔が足りなければ待ち直す
      const last = lastWriteAt.get(id);
      const wait = last === undefined ? 0 : last + CONFIG.resultsThrottleMs - now();
      if (wait > 0) {
        if (!timers.has(id)) timers.set(id, setT(() => { timers.delete(id); syncResults(); }, wait));
        return;
      }
      const t = state.tallies[id];
      const patch = { [`results/${id}`]: { counts: t.counts, total: t.total } };
      lastWriteAt.set(id, now());
      await net.update(pubPath, patch);
      state.pub = applyPatch(state.pub, patch);
      emit();
    }).catch(async (e) => {
      // 規則に拒否された: 別のタブがかくしたのかもしれない。最新の pub を読み直す（読めなければ下の再試行に任せる）
      if (e && e.code === 'denied') { try { await refreshPub(); } catch { /* あとでやり直す */ } }
      // 書けなかったら、少し待ってもう一度試す
      if (stopped || ending || timers.has(id)) return;
      timers.set(id, setT(() => { timers.delete(id); syncResults(); }, CONFIG.resultsThrottleMs));
    }).finally(() => {
      pendingResults.delete(id);
      // 書いている間に集計が変わっていたら、もう一度書く
      syncResults();
    });
  }

  function onInbox(value) {
    if (stopped || state.phase !== 'live') return;
    inbox = value && typeof value === 'object' ? value : null;
    recompute();
    emit();
    syncResults();
  }

  // 2 つの購読（inbox と pub）の両方がつながっていれば connected
  function onStatus(which, status) {
    if (stopped) return;
    online[which] = status === 'connected';
    state.connection = online.inbox && online.pub ? 'connected' : 'disconnected';
    emit();
  }

  function unsubscribeAll() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubscribePub) { unsubscribePub(); unsubscribePub = null; }
  }

  // サーバーの pub を state.pub に取りこむ。変わったら true。
  // 別のタブが授業を終えていたら、このタブも ended にする（以後は集計を書かない）
  function adoptPub(value) {
    if (value === null || typeof value !== 'object' || !state.pub) return false;
    if (JSON.stringify(value) === JSON.stringify(state.pub)) return false;
    state.pub = value;
    if (value.state === 'ended' && state.phase === 'live') {
      state.phase = 'ended';
      clearTimers();
      unsubscribeAll();
    }
    return true;
  }

  // pub の購読。自分の書きこみも、別のタブの書きこみも届く
  function onPub(value) {
    if (stopped || state.phase !== 'live') return;
    if (!adoptPub(value)) return;
    emit();
    syncResults();
  }

  // サーバーの最新の pub を読んで取りこむ（購読が遅れていても、古い状態からパッチを作らないように）
  async function refreshPub() {
    const latest = await net.get(pubPath);
    if (stopped) return;
    if (latest === null || typeof latest !== 'object') throw new Error('授業が見つかりません');
    if (adoptPub(latest)) emit();
  }

  // パッチを書き、成功してから state.pub を変える
  async function commit(patch) {
    if (!patch) return;
    if (stopped) throw stoppedError();
    if (Object.keys(patch).some((k) => k.startsWith('results/') && patch[k] !== null)) {
      for (const k of Object.keys(patch)) if (k.startsWith('results/')) lastWriteAt.set(k.slice(8), now());
    }
    await net.update(pubPath, patch);
    state.pub = applyPatch(state.pub, patch);
    emit();
    syncResults();
  }

  function operate(makePatch) {
    return enqueue(async () => {
      if (stopped) throw stoppedError();
      if (state.phase !== 'live' || ending) return;
      // 別のタブの操作も含めた最新の状態から、パッチを作る
      await refreshPub();
      if (stopped) throw stoppedError();
      if (state.phase !== 'live') return;
      await commit(makePatch(state.pub));
    });
  }

  function guard() {
    if (stopped) throw stoppedError();
  }

  async function finish() {
    if (state.pub.state !== 'ended') {
      // 1. すべての質問を締め切る（これ以後、規則が新しい回答を拒否する）
      await commit(closeAllPatch(state.pub));
      // 2. 締め切りが書けてから、回答を読み直す
      guard();
      const finalInbox = await net.get(inboxPath);
      guard();
      const history = buildHistory(
        {
          deckId: meta.deckId, startedAt: meta.startedAt, pub: state.pub,
          deck: { order: state.order, slides: state.slides, images: state.images },
        },
        finalInbox, now(),
      );
      // 3. 履歴を保存できなければここで止める（live のまま、inbox も残す）
      await repo.saveHistory(sid, history);
      await commit(endPatch(state.pub));
      state.phase = 'ended';
      unsubscribeAll();
      emit();
    }
    // 4. 回答と教材の写しを消し、発表中の印を外す（どこで失敗しても end をやり直せる）
    guard();
    await net.remove(inboxPath);
    guard();
    await net.remove(`${base}/deck`);
    guard();
    const active = await repo.getActive();
    guard();
    if (active && active.sid === sid) await repo.setActive(null);
  }

  return {
    async start() {
      const prev = drains.get(sid);
      if (prev) await prev; // 前の host の書きこみが終わってから読む
      if (stopped) return;
      state.phase = 'loading';
      emit();
      const session = await net.get(base);
      if (stopped) return;
      if (session === null || typeof session !== 'object' || !session.pub) {
        state.phase = 'not-found';
        emit();
        return;
      }
      state.pub = session.pub;
      state.title = String(session.pub.title || '');
      meta = { deckId: String(session.deckId || ''), startedAt: Number(session.startedAt) || 0 };
      if (session.deck) {
        const deck = normalizeDeck(session.deck);
        state.order = deck.order;
        state.slides = deck.slides;
        state.images = deck.images;
      }
      if (session.pub.state === 'ended') {
        state.phase = 'ended';
        emit();
        return;
      }
      state.phase = 'live';
      inbox = session.inbox || null;
      recompute();
      emit();
      unsubscribe = net.subscribe(inboxPath, onInbox, (st) => onStatus('inbox', st));
      if (!stopped && state.phase === 'live') unsubscribePub = net.subscribe(pubPath, onPub, (st) => onStatus('pub', st));
      if (stopped || state.phase !== 'live') unsubscribeAll();
      syncResults();
    },

    next() { return operate((pub) => nextPatch(pub, state.order)); },
    prev() { return operate((pub) => prevPatch(pub, state.order)); },
    // slideId を渡すと、順番が来た時点でそのスライドが今のスライドでなければ何も書かない
    // （「次へ」の通信待ちの間に押された操作が、移動先の質問に効かないように）
    setPaused(paused, slideId) {
      return operate((pub) => {
        const id = currentSlideId();
        if (slideId !== undefined && slideId !== id) return null;
        return pausePatch(pub, id, paused);
      });
    },

    setResultsVisible(visible, slideId) {
      return operate((pub) => {
        const id = currentSlideId();
        if (slideId !== undefined && slideId !== id) return null;
        const patch = resultsVisiblePatch(pub, id, visible);
        // 公開するときは、今の集計も同時に書く
        if (patch && visible && state.tallies[id]) {
          const t = state.tallies[id];
          patch[`results/${id}`] = { counts: t.counts, total: t.total };
        }
        return patch;
      });
    },

    end() {
      return enqueue(async () => {
        if (stopped) throw new Error('画面を閉じています');
        if (state.phase !== 'live' && state.phase !== 'ended') throw new Error('授業が開かれていません');
        ending = true;
        clearTimers();
        try {
          // 別のタブがもう終えていたら、残りの後片づけだけを行う
          if (state.phase === 'live') await refreshPub();
          guard();
          await finish();
        } finally {
          ending = false;
          syncResults();
        }
      });
    },

    // 画面を離れる。授業は終わらせない。実行中の書きこみが落ち着いたら解決する
    stop() {
      stopped = true;
      clearTimers();
      unsubscribeAll();
      // 前の host の分と自分の分をつなぐ（置きかえない）。登録中のものが済んだら表から消す
      const own = tail.then(() => {}, () => {});
      const earlier = drains.get(sid);
      const chained = earlier ? Promise.all([earlier, own]).then(() => {}) : own;
      drains.set(sid, chained);
      chained.then(() => { if (drains.get(sid) === chained) drains.delete(sid); });
      return chained;
    },
  };
}
