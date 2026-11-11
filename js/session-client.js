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
  let uid = null;
  let deck = null;          // 正規化した教材（1 回だけ読む）
  let pub = null;           // 最新の pub
  let unsubscribe = null;
  let stopped = false;
  let joined = false;
  let slideKey = null;      // 直前に表示していたスライドの id（変わったら選択を消す）
  let selected = null;
  let phase = 'loading';
  let connection = 'connected';

  const outbox = createOutbox({
    storage,
    send: async (_sid, slideId, choice) => {
      try {
        await net.set(`sessions/${sid}/inbox/answers/${slideId}/${uid}`, { choice, at: net.serverTimestamp() });
      } catch (e) {
        if (!(e instanceof NetError) || e.code !== 'denied') throw e;
        // 拒否されたとき、その質問が停止中なら一時保存にして、再開後に送り直す。締切などはそのまま拒否
        let latest = pub;
        try { latest = await net.get(pubPath); } catch { /* 読めなければ手元の最新を使う */ }
        const status = latest && latest.polls && latest.polls[slideId] && latest.polls[slideId].status;
        if (status === 'paused') throw new NetError('network', '受付が止まっています');
        throw e;
      }
    },
  });

  function buildState() {
    const base = {
      phase, connection, title: pub ? String(pub.title || '') : '',
      slide: null, slideId: '', index: -1, total: deck ? deck.order.length : 0,
      images: deck ? deck.images : {}, poll: null, results: null, selected: null, answer: null,
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
      base.answer = outbox.get(sid, slideId);
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
    const prev = key ? outbox.get(sid, key) : null;
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
      phase = 'ended';
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      syncSlide();
      emit();
      return;
    }
    phase = 'live';
    syncSlide();
    emit();
    // 質問が受付中に戻ったら、保留の回答を送り直す
    const cur = pub.current || {};
    const poll = pub.polls && pub.polls[cur.slideId];
    if (poll && poll.status === 'open') flush();
  }

  function flush() {
    return outbox.flush(sid).then(emit, emit);
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
        if (first.state === 'ended') { pub = first; phase = 'ended'; emit(); return; }
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
      const p = outbox.put(sid, slideId, selected);
      emit(); // 送信中
      await p;
      emit();
    },

    stop() {
      stopped = true;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
  };
}
