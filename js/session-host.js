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
  tally, applyPatch, closeAllPatch, endPatch, buildHistory, freeList,
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

// Firebase のキーに使えるか（host/hidden のパスに入れる）
function validKey(k) {
  return typeof k === 'string' && k !== '' && !/[.#$[\]/]/.test(k);
}

// かくした回答の表 { <slideId>: { <uid>: true } } を作り直す（true 以外は捨てる）。
// __proto__ などのキーでこわれないよう、プロトタイプの無いオブジェクトにする
function cleanHidden(...sources) {
  const out = Object.create(null);
  for (const v of sources) {
    if (!v || typeof v !== 'object') continue;
    for (const [slideId, m] of Object.entries(v)) {
      if (!m || typeof m !== 'object') continue;
      for (const [uid, flag] of Object.entries(m)) {
        if (flag !== true) continue;
        if (!out[slideId]) out[slideId] = Object.create(null);
        out[slideId][uid] = true;
      }
    }
  }
  return out;
}

// かくした回答の表から、Firebase のキーに使えないものを外す（端末に残した値は信用しない）
function validHidden(v) {
  const out = Object.create(null);
  const all = cleanHidden(v);
  for (const slideId of Object.keys(all)) {
    if (!validKey(slideId)) continue;
    for (const uid of Object.keys(all[slideId])) {
      if (!validKey(uid)) continue;
      if (!out[slideId]) out[slideId] = Object.create(null);
      out[slideId][uid] = true;
    }
  }
  return out;
}

// storage（localStorage と同じ形。無くてもよい）: この端末でかくした回答を授業ごとに残す。
// 再読み込みのとき、host/hidden に書けていなかったものを失わないため。
// storage の操作はどれも例外を投げうるので、失敗しても無視する（無いときと同じに動く）
export function createSessionHost({ net, repo, sid, onChange, now, setTimeout: setT, clearTimeout: clearT, storage }) {
  const base = `sessions/${sid}`;
  const pubPath = `${base}/pub`;
  const inboxPath = `${base}/inbox`;
  const hostPath = `${base}/host`;
  const hiddenPath = `${hostPath}/hidden`;
  const storeKey = `classpulse:hidden:${sid}`;

  // 端末に残したかくした回答を読む。無い・こわれている・読めないときは空
  function readStored() {
    if (!storage) return cleanHidden();
    try {
      const raw = storage.getItem(storeKey);
      if (typeof raw !== 'string') return cleanHidden();
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? validHidden(v) : cleanHidden();
    } catch {
      return cleanHidden();
    }
  }
  // 端末に 1 件足す（この端末でかくしたものをすべて残す）
  function addStored(slideId, uid) {
    if (!storage) return;
    try {
      storage.setItem(storeKey, JSON.stringify(cleanHidden(readStored(), { [slideId]: { [uid]: true } })));
    } catch { /* 残せなくても、かくすことは続ける */ }
  }
  // 授業が終わったら、端末に残したものを消す
  function removeStored() {
    if (!storage) return;
    try { storage.removeItem(storeKey); } catch { /* 消せなくても続ける */ }
  }

  // onChange に渡す状態。自由記述のための項目（kind・answerCount・freeItems・hiddenUnsaved）は
  // emit のときに freeState() で足す。文章は「結果を表示」中の freeItems にだけ入れる
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

  // 自由記述: かくした回答（手元のもの。まだ書けていないものも入る）。start で 1 回読み、end で読み直す
  let hidden = cleanHidden();
  const unsaved = new Map();    // "slideId/uid" → { slideId, uid, promise, resolve, reject }（host/hidden に書けていないもの）
  const hideTimers = new Map(); // "slideId/uid" → 再試行のタイマー
  const hideWrites = new Set(); // 実行中の host/hidden の書きこみ
  let hideClosed = false;       // 授業が終わったら、host/hidden に書かない（後片づけで消した host を作り直さない）
  // 表示中の一覧の写し（新しい回答・書き直しは resultsThrottleMs に 1 回まで反映する）
  let freeView = null;          // { slideId, items: [{ uid, text }], at }
  let freeTimer = null;

  // 操作は 1 つずつ。失敗しても次の操作は止めない
  let tail = Promise.resolve();
  function enqueue(fn) {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  }

  function emit() {
    if (stopped) return;
    onChange({ ...state, tallies: { ...state.tallies }, ...freeState() });
  }

  function currentSlideId() {
    const cur = state.pub && state.pub.current;
    return cur && typeof cur.slideId === 'string' ? cur.slideId : '';
  }

  function clearFreeTimer() {
    if (freeTimer !== null) { clearT(freeTimer); freeTimer = null; }
  }
  function dropFreeView() {
    freeView = null;
    clearFreeTimer();
  }

  // 今のスライドが自由記述のときの項目。結果を表示していない間は、文章も uid も 1 つも入れない
  // （一覧の写しも捨てる）。freeItems の uid は hide に渡すためだけのもの（画面の DOM には入れない）
  function freeState() {
    const id = currentSlideId();
    const slide = id ? state.slides[id] : null;
    const out = {
      kind: slide ? slide.type : null,
      answerCount: null,
      freeItems: null,
      hiddenUnsaved: unsaved.size > 0,
    };
    if (!slide || slide.type !== 'free' || state.phase !== 'live') { dropFreeView(); return out; }
    const answers = (inbox && inbox.answers) || {};
    const list = freeList(answers[id], hidden[id]);
    out.answerCount = list.total;
    const poll = state.pub && state.pub.polls && state.pub.polls[id];
    if (!poll || poll.resultsVisible !== true) { dropFreeView(); return out; }
    const t = now();
    if (!freeView || freeView.slideId !== id) {
      // 表示を始めた・スライドが変わった: すぐに今の一覧を出す
      clearFreeTimer();
      freeView = { slideId: id, items: list.items, at: t };
    } else if (freeTimer === null && JSON.stringify(list.items) !== JSON.stringify(freeView.items)) {
      const wait = freeView.at + CONFIG.resultsThrottleMs - t;
      if (wait <= 0) freeView = { slideId: id, items: list.items, at: t };
      else freeTimer = setT(() => { freeTimer = null; emit(); }, wait);
    }
    // かくしたものは、写しを作ったあとでも、すぐに外す
    const hid = hidden[id] || {};
    out.freeItems = freeView.items.filter((x) => hid[x.uid] !== true).map((x) => ({ uid: x.uid, text: x.text }));
    return out;
  }

  // host/hidden/<slideId>/<uid> に書く。失敗したら reconnectDelayMs ごとに再試行する
  function saveHidden(key) {
    const e = unsaved.get(key);
    if (!e || stopped || hideClosed) return;
    const done = net.set(`${hiddenPath}/${e.slideId}/${e.uid}`, true).then(() => {
      if (unsaved.get(key) !== e) return;
      unsaved.delete(key);
      emit();
      e.resolve();
    }, () => {
      if (stopped || hideClosed || unsaved.get(key) !== e || hideTimers.has(key)) return;
      hideTimers.set(key, setT(() => { hideTimers.delete(key); saveHidden(key); }, CONFIG.reconnectDelayMs));
    });
    hideWrites.add(done);
    const forget = () => { hideWrites.delete(done); };
    done.then(forget, forget);
  }

  // 書けていないものとして登録し、host/hidden への書きこみを始める。返すのは登録したもの
  function queueHide(slideId, uid) {
    const key = `${slideId}/${uid}`;
    const e = { slideId, uid };
    e.promise = new Promise((resolve, reject) => { e.resolve = resolve; e.reject = reject; });
    e.promise.catch(() => {}); // 呼び出し側が待たなくても、未処理の拒否にしない
    unsaved.set(key, e);
    saveHidden(key);
    return e;
  }

  // 実行中の host/hidden の書きこみが、成否にかかわらず落ち着くまで待つ
  function settledHideWrites() {
    return Promise.all([...hideWrites].map((p) => p.then(() => {}, () => {}))).then(() => {});
  }

  // host/hidden への書きこみをやめる。書けていないものは、settle(entry) で決着させる
  function closeHide(settleEntry) {
    hideClosed = true;
    for (const t of hideTimers.values()) clearT(t);
    hideTimers.clear();
    const left = [...unsaved.values()];
    unsaved.clear();
    for (const e of left) settleEntry(e);
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
    clearFreeTimer();
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
      // 別のタブが後片づけで host を消している。書けていないかくしたものは、もう書かない
      closeHide((e) => e.reject(new Error('授業は終わっています')));
      // 端末に残したものも消す。自分の end の途中なら、後片づけが済んでから finish で消す
      if (!ending) removeStored();
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
      // かくした回答も読み直し、手元でかくしたもの（まだ書けていないものも）と合わせる
      const finalHidden = await net.get(hiddenPath);
      guard();
      const history = buildHistory(
        {
          deckId: meta.deckId, startedAt: meta.startedAt, pub: state.pub,
          deck: { order: state.order, slides: state.slides, images: state.images },
        },
        finalInbox, now(), cleanHidden(finalHidden, hidden),
      );
      // 3. 履歴を保存できなければここで止める（live のまま、inbox も残す）
      await repo.saveHistory(sid, history);
      await commit(endPatch(state.pub));
      state.phase = 'ended';
      unsubscribeAll();
      emit();
    }
    // 4. 回答・かくした回答・教材の写しを消し、発表中の印を外す（どこで失敗しても end をやり直せる）
    guard();
    await net.remove(inboxPath);
    guard();
    // かくしたものは履歴に入れた（または別のタブが終えた）。再試行を止め、実行中の書きこみを待ってから host を消す
    closeHide((e) => e.resolve());
    await settledHideWrites();
    guard();
    await net.remove(hostPath);
    guard();
    await net.remove(`${base}/deck`);
    guard();
    const active = await repo.getActive();
    guard();
    if (active && active.sid === sid) await repo.setActive(null);
    // 後片づけが済んだ。端末に残したかくしたものも消す（履歴に入れてある）
    removeStored();
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
        removeStored(); // 授業はもう無い
        emit();
        return;
      }
      state.pub = session.pub;
      state.title = String(session.pub.title || '');
      // かくした回答（host/hidden）は、開いたときに 1 回だけ読む（授業全体の読みこみに含まれる）。
      // 端末に残したもの（前の画面で書けていなかったかもしれない）も合わせ、サーバーに無いものは下で再送する
      const serverHidden = cleanHidden(session.host && session.host.hidden);
      const stored = readStored();
      hidden = cleanHidden(serverHidden, stored, hidden);
      meta = { deckId: String(session.deckId || ''), startedAt: Number(session.startedAt) || 0 };
      if (session.deck) {
        const deck = normalizeDeck(session.deck);
        state.order = deck.order;
        state.slides = deck.slides;
        state.images = deck.images;
      }
      if (session.pub.state === 'ended') {
        state.phase = 'ended';
        removeStored(); // 授業は終わっている（かくしたものは、終えたタブが履歴に入れた）
        emit();
        return;
      }
      state.phase = 'live';
      inbox = session.inbox || null;
      // 端末にだけあるかくしたものを、hide と同じ再試行で書く（書けるまで hiddenUnsaved が true）
      for (const slideId of Object.keys(stored)) {
        for (const uid of Object.keys(stored[slideId])) {
          if (serverHidden[slideId] && serverHidden[slideId][uid] === true) continue;
          if (!unsaved.has(`${slideId}/${uid}`)) queueHide(slideId, uid);
        }
      }
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
        // 自由記述は resultsVisible だけを書く（pub/results/<slideId> には、消すことも含めて触れない）
        const slide = state.slides[id];
        if (patch && slide && slide.type === 'free') {
          delete patch[`results/${id}`];
          return patch;
        }
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

    // 自由記述の 1 件をかくす。すぐに手元でかくして onChange を呼び、host/hidden への書きこみは裏で行う
    // （失敗したら reconnectDelayMs ごとに再試行。書けていない間は hiddenUnsaved が true）。
    // 返す Promise は、書けたとき（または授業の終了で履歴に入れたとき）に解決する。
    // 画面を閉じた・別のタブが授業を終えたなどで書けなくなったら拒否する
    hide(slideId, uid) {
      if (stopped) return Promise.reject(stoppedError());
      const slide = state.slides[slideId];
      if (state.phase !== 'live' || hideClosed || !slide || slide.type !== 'free' || !validKey(slideId) || !validKey(uid)) {
        return Promise.reject(new Error('この回答はかくせません'));
      }
      const key = `${slideId}/${uid}`;
      if (hidden[slideId] && hidden[slideId][uid] === true) {
        const e = unsaved.get(key);
        return e ? e.promise : Promise.resolve();
      }
      // 先に端末にも残す（書けないまま再読み込みしても、かくしたままにするため）
      addStored(slideId, uid);
      hidden = cleanHidden(hidden, { [slideId]: { [uid]: true } });
      if (freeView && freeView.slideId === slideId) {
        freeView = { ...freeView, items: freeView.items.filter((x) => x.uid !== uid) };
      }
      const e = queueHide(slideId, uid);
      emit();
      return e.promise;
    },

    // 画面を離れる。授業は終わらせない。実行中の書きこみが落ち着いたら解決する
    stop() {
      stopped = true;
      clearTimers();
      unsubscribeAll();
      // かくしたものの再試行も止める（書けていないものは拒否する）
      closeHide((e) => e.reject(stoppedError()));
      // 前の host の分と自分の分をつなぐ（置きかえない）。登録中のものが済んだら表から消す
      const own = Promise.all([tail.then(() => {}, () => {}), settledHideWrites()]).then(() => {});
      const earlier = drains.get(sid);
      const chained = earlier ? Promise.all([earlier, own]).then(() => {}) : own;
      drains.set(sid, chained);
      chained.then(() => { if (drains.get(sid) === chained) drains.delete(sid); });
      return chained;
    },
  };
}
