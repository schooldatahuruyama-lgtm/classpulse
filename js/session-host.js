// 先生側: 授業を始め、スライドを進め、受付を止め、結果を公開し、授業を終える。
// DOM・グローバルに触れない（net・repo・タイマー・now は引数で受け取る）。
// 状態の変更は、すべて session-logic のパッチを通す（規則をここで作り直さない）。
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
  let unsubscribe = null;
  let stopped = false;
  let ending = false;          // end の途中は結果を書かない
  let cleaned = false;         // 終了後の片づけまで済んだか
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
      if (timers.has(id) || !needsResults(id)) continue;
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
    lastWriteAt.set(id, now());
    enqueue(async () => {
      // 順番が来た時点で、まだ公開中かを確かめる（かくした直後に書かない）
      if (stopped || ending || state.phase !== 'live' || !needsResults(id)) return;
      const t = state.tallies[id];
      const patch = { [`results/${id}`]: { counts: t.counts, total: t.total } };
      await net.update(pubPath, patch);
      state.pub = applyPatch(state.pub, patch);
      emit();
    }).catch(() => {
      // 書けなかったら、少し待ってもう一度試す
      if (stopped || ending || timers.has(id)) return;
      timers.set(id, setT(() => { timers.delete(id); syncResults(); }, CONFIG.resultsThrottleMs));
    });
  }

  function onInbox(value) {
    if (stopped || state.phase !== 'live') return;
    inbox = value && typeof value === 'object' ? value : null;
    recompute();
    emit();
    syncResults();
  }

  function onStatus(status) {
    if (stopped) return;
    state.connection = status === 'connected' ? 'connected' : 'disconnected';
    emit();
  }

  // パッチを書き、成功してから state.pub を変える
  async function commit(patch) {
    if (!patch) return;
    await net.update(pubPath, patch);
    state.pub = applyPatch(state.pub, patch);
    emit();
    syncResults();
  }

  function operate(makePatch) {
    return enqueue(async () => {
      if (stopped || state.phase !== 'live' || ending) return;
      await commit(makePatch(state.pub));
    });
  }

  async function finish() {
    if (state.pub.state !== 'ended') {
      // 1. すべての質問を締め切る（これ以後、規則が新しい回答を拒否する）
      await commit(closeAllPatch(state.pub));
      // 2. 締め切りが書けてから、回答を読み直す
      const finalInbox = await net.get(inboxPath);
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
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      emit();
    }
    // 4. 回答と教材の写しを消し、発表中の印を外す（失敗したら end をやり直せる）
    if (!cleaned) {
      await net.remove(inboxPath);
      await net.remove(`${base}/deck`);
      await repo.setActive(null);
      cleaned = true;
    }
  }

  return {
    async start() {
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
        cleaned = !session.deck && !session.inbox;
        emit();
        return;
      }
      state.phase = 'live';
      inbox = session.inbox || null;
      recompute();
      emit();
      unsubscribe = net.subscribe(inboxPath, onInbox, onStatus);
      if (stopped && unsubscribe) { unsubscribe(); unsubscribe = null; }
      syncResults();
    },

    next() { return operate((pub) => nextPatch(pub, state.order)); },
    prev() { return operate((pub) => prevPatch(pub, state.order)); },
    setPaused(paused) { return operate((pub) => pausePatch(pub, currentSlideId(), paused)); },

    setResultsVisible(visible) {
      return operate((pub) => {
        const id = currentSlideId();
        const patch = resultsVisiblePatch(pub, id, visible);
        // 公開するときは、今の集計も同時に書く
        if (patch && visible && state.tallies[id]) {
          const t = state.tallies[id];
          patch[`results/${id}`] = { counts: t.counts, total: t.total };
          lastWriteAt.set(id, now());
        }
        return patch;
      });
    },

    end() {
      return enqueue(async () => {
        if (stopped) throw new Error('画面を閉じています');
        if (state.phase === 'ended' && cleaned) return;
        if (state.phase !== 'live' && state.phase !== 'ended') throw new Error('授業が開かれていません');
        ending = true;
        clearTimers();
        try {
          await finish();
        } finally {
          ending = false;
          syncResults();
        }
      });
    },

    // 画面を離れる。授業は終わらせない
    stop() {
      stopped = true;
      clearTimers();
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
  };
}
