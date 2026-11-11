// 生徒側: 授業に参加し、先生の今のスライドを追い、回答を送る。
// DOM・グローバルに触れない（net・auth・storage は引数で受け取る）。
// 画面には state を 1 つだけ onChange で渡す。生徒の匿名 ID は state に入れない。
import { NetError } from './errors.js';
import { normalizeDeck } from './model.js';
import { createOutbox } from './outbox.js';

function toArray(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  }
  return [];
}

export function createSessionClient({ net, auth, storage, sid, onChange }) {
  const pubPath = `sessions/${sid}/pub`;
  // 一時保存の鍵は授業と生徒の ID の組（同じ保存先を共有する別の ID の回答が見えないように）。画面には出さない
  const okey = () => `${sid}:${uid}`;
  let uid = null;
  let deck = null;          // 正規化した教材（1 回だけ読む）
  let pub = null;           // 最新の pub
  let unsubscribe = null;
  let stopped = false;
  let joined = false;
  let ended = false;        // 授業の終了を知ったか（終了後は自分の回答を読まない。先生が回答を消すため）
  let slideKey = null;      // 直前に表示していたスライドの id（変わったら選択を消す）
  let selected = null;
  let phase = 'loading';
  let connection = 'connected';

  // 拒否されたあとの再送は、受付中のまま拒否され続けても無限に繰り返さない
  const openRetried = new Set();

  async function sendAnswer(slideId, choice) {
    const answerPath = `sessions/${sid}/inbox/answers/${slideId}/${uid}`;
    try {
      await net.set(answerPath, { choice, at: net.serverTimestamp() });
      openRetried.delete(`${slideId}:${choice}`);
      return undefined;
    } catch (e) {
      if (!(e instanceof NetError) || e.code !== 'denied') throw e;
    }
    // 終了を知っていれば、読み取りも再送もしない（未確認として扱われる）
    if (ended) throw new NetError('network', '授業が終わりました');
    // 拒否された。最新の pub を読みなおして、締切（最終）か、あとで送れる（再試行）かを決める
    let latest;
    try {
      latest = await net.get(pubPath);
    } catch {
      throw new NetError('network', '状態を確かめられません'); // 締切の証拠がないので断定しない
    }
    // 読んでいる間に授業が終わったかもしれない。終わっていたら、回答は読まず、結果は outbox が未確認にする
    if (ended) throw new NetError('network', '授業が終わりました');
    const poll = latest && latest.polls ? latest.polls[slideId] : null;
    const isCurrent = latest && latest.current && latest.current.slideId === slideId;
    if (latest && latest.state === 'ended') {
      markEnded();
      throw new NetError('network', '授業が終わりました'); // 届いたか確かめられない。未確認になる
    }
    const final = !latest || !poll || poll.status === 'closed' || !isCurrent;
    if (!final) {
      if (poll.status === 'paused') throw new NetError('network', '受付が止まっています');
      // open で今のスライド: 読み直している間に再開された。すぐ送り直す（同じ値で 1 回だけ）
      const key = `${slideId}:${choice}`;
      if (openRetried.has(key)) throw new Error('受付中なのに拒否されました');
      openRetried.add(key);
      flush();
      throw new NetError('network', '受付が再開されました');
    }
    // 最終の拒否。ただし以前の送信がサーバーに届いていた（応答だけ失われた）かもしれないので照合する
    let mine;
    try {
      mine = await net.get(answerPath);
    } catch {
      throw new NetError('network', '受信結果を確かめられません'); // 確かめられるまで保留
    }
    // 読んでいる間に授業が終わったら、「無い」は削除されただけかもしれないので結果を使わない
    if (ended) throw new NetError('network', '授業が終わりました');
    if (mine && Number.isInteger(mine.choice)) {
      const cur = pub && pub.current;
      if (mine.choice !== choice && cur && cur.slideId === slideId) selected = mine.choice;
      return { choice: mine.choice };
    }
    throw new NetError('denied', '受付が終わっています');
  }

  const outbox = createOutbox({
    storage,
    send: (_sid, slideId, choice) => sendAnswer(slideId, choice),
    // 送信が終わるたびに、締切になっていないか見なおす（送信中に締切が届いた場合）
    onSettle: () => { reconcile(); },
    canSend: (_sid, slideId) => !ended && !isClosedSlide(slideId),
  });

  // 授業の終了。送れていない回答は未確認にして、以後は読まず・送らない
  function markEnded() {
    ended = true;
    outbox.freeze(okey());
  }

  const isClosedSlide = (slideId) => {
    if (!pub) return false;
    if (ended || pub.state === 'ended') return true;
    const p = pub.polls && pub.polls[slideId];
    return !!p && p.status === 'closed';
  };

  // 締切・終了が分かったら、送れていない回答（保留・失敗）をサーバーの記録と照合してから確定する。
  // 読めなかったとき（つながらない）は保留のまま残し、次の接続・更新でもう一度照合する。再送はしない
  const reconciling = new Set();
  async function reconcile() {
    if (!pub || stopped || ended) return;
    // 終了していない授業で締切になった質問だけを照合する（終了後は読まない）
    for (const slideId of outbox.pendingIds(okey(), isClosedSlide)) {
      if (ended) return;
      if (reconciling.has(slideId)) continue;
      reconciling.add(slideId);
      try {
        let mine = null;
        try {
          mine = await net.get(`sessions/${sid}/inbox/answers/${slideId}/${uid}`);
        } catch (e) {
          if (!(e instanceof NetError) || e.code !== 'denied') continue; // 読めない。あとでやり直す
        }
        if (stopped || ended) return; // 終了をまたいだ照合は使わない
        const server = mine && Number.isInteger(mine.choice) ? mine.choice : null;
        if (outbox.settle(okey(), slideId, server)) {
          const cur = pub && pub.current;
          if (server !== null && cur && cur.slideId === slideId) selected = server;
          emit();
        }
      } finally {
        reconciling.delete(slideId);
      }
    }
  }

  function flush() {
    return outbox.flush(okey(), isClosedSlide).then(emit, emit);
  }

  function buildState() {
    const base = {
      phase, connection, title: pub ? String(pub.title || '') : '',
      slide: null, slideId: '', index: -1, total: deck ? deck.order.length : 0,
      images: deck ? deck.images : {}, poll: null, results: null, selected: null, answer: null,
      // この授業で、届いたか確かめられなかった回答の数（今のスライドや、教材を読めたかによらない）
      unconfirmedCount: uid ? outbox.unconfirmedCount(okey()) : 0,
    };
    if (!pub || !deck) return base;
    const cur = pub.current || {};
    const index = Number.isInteger(cur.index) ? cur.index : -1;
    const slideId = index >= 0 && typeof cur.slideId === 'string' ? cur.slideId : '';
    base.index = index;
    base.slideId = slideId;
    base.slide = slideId ? deck.slides[slideId] || null : null;
    const poll = slideId && pub.polls ? pub.polls[slideId] : null;
    if (poll) {
      base.poll = { status: poll.status, resultsVisible: !!poll.resultsVisible };
      const r = poll.resultsVisible && pub.results ? pub.results[slideId] : null;
      if (r) base.results = { counts: toArray(r.counts), total: Number(r.total) || 0 };
    }
    if (slideId) {
      base.answer = outbox.get(okey(), slideId);
      base.selected = selected;
    }
    return base;
  }

  function emit() {
    if (stopped) return;
    onChange(buildState());
  }

  // スライドが変わったら、選択を消す（送ったことのある質問は、その選択を戻す）
  function syncSlide() {
    const cur = (pub && pub.current) || {};
    const key = Number.isInteger(cur.index) && cur.index >= 0 ? String(cur.slideId || '') : '';
    if (key === slideKey) return;
    slideKey = key;
    const prev = key ? outbox.get(okey(), key) : null;
    selected = prev ? prev.choice : null;
  }

  function onPub(value) {
    if (stopped) return;
    if (value === null || typeof value !== 'object') {
      phase = 'not-found';
      pub = null;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      emit();
      return;
    }
    pub = value;
    if (pub.state === 'ended') {
      markEnded();
      phase = 'ended';
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      syncSlide();
      emit();
      return;
    }
    phase = 'live';
    syncSlide();
    reconcile();
    emit();
    // 質問が受付中に戻ったら、保留の回答を送り直す
    const cur = pub.current || {};
    const poll = pub.polls && pub.polls[cur.slideId];
    if (poll && poll.status === 'open') flush();
  }

  async function join() {
    if (joined || stopped) return;
    try {
      await net.set(`sessions/${sid}/inbox/participants/${uid}`, net.serverTimestamp());
      joined = true;
    } catch { /* つながったときにもう一度試す */ }
  }

  function onStatus(status) {
    if (stopped) return;
    connection = status === 'connected' ? 'connected' : 'disconnected';
    emit();
    if (connection === 'connected') {
      join();
      reconcile();
      flush();
    }
  }

  return {
    async start() {
      phase = 'loading';
      emit();
      try {
        uid = (await auth.signInAnonymous()).uid;
        const first = await net.get(pubPath);
        if (stopped) return;
        if (first === null || typeof first !== 'object') { phase = 'not-found'; emit(); return; }
        if (first.state === 'ended') { pub = first; phase = 'ended'; markEnded(); emit(); return; }
        const rawDeck = await net.get(`sessions/${sid}/deck`);
        if (stopped) return;
        if (rawDeck === null) throw new NetError('unknown', '教材が見つかりません');
        deck = normalizeDeck(rawDeck);
        await join();
        if (stopped) return;
      } catch {
        if (!stopped) { phase = 'error'; emit(); }
        return;
      }
      unsubscribe = net.subscribe(pubPath, onPub, onStatus);
      if (stopped && unsubscribe) { unsubscribe(); unsubscribe = null; }
    },

    select(choice) {
      if (stopped || !Number.isInteger(choice) || !pub || !deck) return;
      const cur = pub.current || {};
      const poll = pub.polls && pub.polls[cur.slideId];
      const slide = cur.slideId ? deck.slides[cur.slideId] : null;
      if (!poll || poll.status === 'closed' || !slide || slide.type !== 'poll') return;
      if (choice < 0 || choice >= slide.options.length) return;
      selected = choice;
      emit();
    },

    async submit() {
      if (stopped || !pub || phase !== 'live') return;
      const cur = pub.current || {};
      const slideId = cur.slideId;
      const poll = slideId && pub.polls ? pub.polls[slideId] : null;
      if (!poll || poll.status !== 'open' || selected === null) return;
      const p = outbox.put(okey(), slideId, selected);
      emit(); // 送信中
      await p;
      emit();
    },

    // 保存できなかった、そのほかの失敗（failed）の回答を、今のスライドについて送り直す
    async retry() {
      if (stopped || !pub || phase !== 'live') return;
      const slideId = (pub.current && pub.current.slideId) || '';
      if (!slideId) return;
      const p = outbox.retry(okey(), slideId);
      emit();
      await p;
      emit();
    },

    stop() {
      stopped = true;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
  };
}
