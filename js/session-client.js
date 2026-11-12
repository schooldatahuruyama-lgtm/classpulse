// 生徒側: 授業に参加し、先生の今のスライドを追い、回答を送る。
// DOM・グローバルに触れない（net・auth・storage は引数で受け取る）。
// 画面には state を 1 つだけ onChange で渡す。生徒の匿名 ID は state に入れない。
import { NetError } from './errors.js';
import { normalizeDeck } from './model.js';
import { createOutbox } from './outbox.js';
import { normalizeText, normalizeWords, sameWords } from './session-logic.js';
import { CONFIG } from './config.js';

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
  // 値の種類: 'words'（言葉の配列）、'text'（文章）、'choice'（選択）
  const kindOf = (value) => (Array.isArray(value) ? 'words' : typeof value === 'string' ? 'text' : 'choice');

  // 同じ値で 1 回だけ再送するための鍵（選択の 1 と文章の "1" を分ける。言葉の配列は中身で作る）
  const retryKey = (slideId, value) => (Array.isArray(value)
    ? `${slideId}:words:${JSON.stringify(value)}`
    : `${slideId}:${typeof value}:${value}`);

  // サーバーに残っていた自分の回答から、送った値と同じ種類（選択・文章・言葉）の値を取り出す。無ければ null。
  // 言葉はデータベースの形（{ 0: …, 1: … }）でも読めるよう、normalizeWords を通して比べる
  function serverValue(mine, kind) {
    if (!mine || typeof mine !== 'object') return null;
    if (kind === 'words') return normalizeWords(mine.words);
    if (kind === 'text') return normalizeText(mine.text);
    return Number.isInteger(mine.choice) ? mine.choice : null;
  }

  // value は選択（整数）か文章（normalizeText を通った文字列）か言葉の配列（normalizeWords を通ったもの）
  async function sendAnswer(slideId, value) {
    const answerPath = `sessions/${sid}/inbox/answers/${slideId}/${uid}`;
    const kind = kindOf(value);
    try {
      const at = net.serverTimestamp();
      await net.set(answerPath, { [kind]: value, at });
      openRetried.delete(retryKey(slideId, value));
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
      const key = retryKey(slideId, value);
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
    const server = serverValue(mine, kind);
    if (server !== null) {
      // 文章・言葉は outbox の記録から state.text / state.words になる
      if (kind !== 'choice') return { [kind]: server };
      const cur = pub && pub.current;
      if (server !== value && cur && cur.slideId === slideId) selected = server;
      return { choice: server };
    }
    throw new NetError('denied', '受付が終わっています');
  }

  const outbox = createOutbox({
    storage,
    send: (_sid, slideId, value) => sendAnswer(slideId, value),
    // 送信が終わるたびに、締切になっていないか見なおす（送信中に締切が届いた場合）
    onSettle: () => { reconcile(); },
    canSend: (_sid, slideId) => !ended && !isClosedSlide(slideId),
  });

  // 授業の終了。送れていない回答は未確認にして、以後は読まず・送らない
  function markEnded() {
    ended = true;
    outbox.freeze(okey());
    clearDrafts();
  }

  // 書きかけ（自由記述は文字列、ワードクラウドは入力欄ごとの文字列の配列）。
  // { [slideId]: 文字列 | [文字列, …] } を端末に保存する。授業が終わったら消す。
  // 保存できない端末でも、このページの中では覚えておく
  const draftKey = () => `classpulse:draft:${sid}:${uid}`;
  let drafts = null; // 読みこんだ書きかけ（uid が決まってから読む）
  // 書きかけとして残す形に整える。空の文字列・全部空の配列・それ以外の値は null（消す）。
  // 配列は maxWords 個の文字列にそろえる（文字列でない要素は空、多い分は捨てる）
  function cleanDraft(v) {
    if (typeof v === 'string') return v === '' ? null : v;
    if (Array.isArray(v)) {
      const a = Array.from({ length: CONFIG.cloud.maxWords }, (_, i) => (typeof v[i] === 'string' ? v[i] : ''));
      return a.some((s) => s !== '') ? a : null;
    }
    return null;
  }
  function loadDrafts() {
    if (drafts) return drafts;
    drafts = {};
    try {
      const parsed = JSON.parse(storage.getItem(draftKey()) || 'null');
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const d = cleanDraft(v);
          if (d !== null) drafts[k] = d;
        }
      }
    } catch { /* こわれたデータは無いものとして扱う */ }
    return drafts;
  }
  const isCloudSlide = (slideId) => !!deck && Object.hasOwn(deck.slides, slideId) && deck.slides[slideId].type === 'cloud';
  function clearDrafts() {
    drafts = {};
    try { storage.removeItem(draftKey()); } catch { /* 無視 */ }
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
        // 保管中の回答と同じ種類（選択・文章・言葉）の値だけを照合に使う
        const pending = outbox.get(okey(), slideId);
        const kind = !pending ? 'choice' : Array.isArray(pending.words) ? 'words' : typeof pending.text === 'string' ? 'text' : 'choice';
        const server = serverValue(mine, kind);
        if (outbox.settle(okey(), slideId, server)) {
          const cur = pub && pub.current;
          if (kind === 'choice' && server !== null && cur && cur.slideId === slideId) selected = server;
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
      // 自由記述: 今のスライドが自由記述なら kind は 'free'、ワードクラウドなら 'cloud'（ほかは null）。
      // text は、送信済み・送信中など、最後に送ろうとした文章（無ければ null）。answer.text と同じ。
      // words は、ワードクラウドで最後に送ろうとした言葉の配列（無ければ null）。answer.words と同じ
      kind: null, text: null, words: null,
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
    if (base.slide && base.slide.type === 'free') {
      base.kind = 'free';
      base.selected = null;
      base.text = base.answer && typeof base.answer.text === 'string' ? base.answer.text : null;
    }
    if (base.slide && base.slide.type === 'cloud') {
      base.kind = 'cloud';
      base.selected = null;
      base.words = base.answer && Array.isArray(base.answer.words) ? [...base.answer.words] : null;
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
    selected = prev && Number.isInteger(prev.choice) ? prev.choice : null; // 文章の回答は選択に戻さない
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

  // 自由記述・ワードクラウドの送信。今のスライドが type で受付中のときだけ、整えた値（value）を送る。
  // value が null なら何もしない。今の記録が same(記録) で送信済み・送信中なら送らない
  async function submitValue(type, value, same) {
    if (stopped || !pub || !deck || phase !== 'live') return;
    const slideId = (pub.current && pub.current.slideId) || '';
    const poll = slideId && pub.polls ? pub.polls[slideId] : null;
    const slide = slideId ? deck.slides[slideId] : null;
    if (!poll || poll.status !== 'open' || !slide || slide.type !== type) return;
    if (value === null) return;
    const cur = outbox.get(okey(), slideId);
    if (cur && same(cur) && (cur.state === 'sent' || cur.state === 'sending')) return;
    const p = outbox.put(okey(), slideId, value);
    emit(); // 送信中
    await p;
    emit();
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
      const slide = slideId && deck ? deck.slides[slideId] : null;
      if (!poll || poll.status !== 'open' || selected === null || !slide || slide.type !== 'poll') return;
      const p = outbox.put(okey(), slideId, selected);
      emit(); // 送信中
      await p;
      emit();
    },

    // 自由記述: 今のスライドが自由記述で受付中のときだけ、normalizeText を通った文章を送る。
    // 通らない（空白だけ・上限をこえる・文字列でない）なら何もしない。送信済み・送信中と同じ文章なら送らない
    submitText(raw) {
      const text = normalizeText(raw);
      return submitValue('free', text, (cur) => cur.text === text);
    },

    // ワードクラウド: 今のスライドがワードクラウドで受付中のときだけ、normalizeWords を通った言葉を送る
    // （空の欄・空白だけ・上限をこえる言葉・同じ言葉の 2 つ目・4 つ目からは落とす）。
    // 1 つも残らなければ何もしない。送信済み・送信中と中身が同じなら送らない
    submitWords(rawList) {
      const words = normalizeWords(rawList);
      return submitValue('cloud', words, (cur) => sameWords(cur.words, words));
    },

    // 書きかけ。自由記述は文字列（無ければ ''）、ワードクラウドのスライドは入力欄ごとの maxWords 個の文字列の配列
    // （無ければ ['', '', '']）。参加する前（uid が決まる前）と、授業が終わったあとは空
    draft(slideId) {
      const cloud = isCloudSlide(slideId);
      const empty = () => (cloud ? Array(CONFIG.cloud.maxWords).fill('') : '');
      if (!uid || ended) return empty();
      const v = loadDrafts()[slideId];
      if (cloud) return Array.isArray(v) ? [...v] : empty();
      return typeof v === 'string' ? v : '';
    },

    // 書きかけを端末に保存する（文字列か、入力欄ごとの文字列の配列。空なら消す）。授業が終わったあとは保存しない
    setDraft(slideId, raw) {
      if (!uid || ended || typeof slideId !== 'string' || !slideId) return;
      const d = loadDrafts();
      const v = cleanDraft(raw);
      if (v !== null) d[slideId] = v; else delete d[slideId];
      try {
        if (Object.keys(d).length) storage.setItem(draftKey(), JSON.stringify(d));
        else storage.removeItem(draftKey());
      } catch { /* 保存できなくても、このページの中では覚えている */ }
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
