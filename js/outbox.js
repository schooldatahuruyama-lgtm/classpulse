// 回答の一時保存と再送。DOM・通信・グローバルに触れない（保存先と送信は引数で受け取る）。
// 同じ質問への回答は 1 件だけ持ち、選びなおしたら前の未送信は置きかえる（最後の回答が勝つ）。
// state: 'sending'（送信中）、'sent'（送信済み）、'queued'（つながらず保留。あとで送り直す）、
//        'rejected'（規則に拒否された。締切など。送り直さない）、
//        'failed'（そのほかの失敗、または保存できていないままつながらなかったもの。手動で retry する）、
//        'unconfirmed'（授業が終わったあとに、届いたか確かめられないもの。送り直さない。freeze で決まる）
// 不変条件: freeze(sid) のあとは、新しい送信を始めない。すでに送信中のものが成功したら sent、
// それ以外（保留・失敗・拒否・照合の結果・送られなかった選びなおし）は unconfirmed になる。
// 終了後の「回答が無い」は、受信されなかったことの証拠にならない（先生が回答を消すため）。
// freeze の前に sent / rejected だったものは変えない。
// send は成功したら何も返さないか、サーバーに別の回答が残っていたとき { choice } を返す（その値を送信済みとする）。
const STATES = new Set(['sending', 'sent', 'queued', 'rejected', 'failed', 'unconfirmed']);

// onSettle(sid, slideId): 送信が終わって状態が決まるたびに呼ぶ（締切の再評価などに使う）
// canSend(sid, slideId): 偽なら、送信中に出た再送の要求では送り直さない（締切済みの質問など）
export function createOutbox({ storage, send, onSettle = () => {}, canSend = () => true }) {
  // 同じ質問の送信の順番（clear をまたいでも保つ）。sid|slideId -> 最後の送信の Promise
  const chains = new Map();
  // sid -> { data: { [slideId]: entry }, active: Map(slideId -> Promise), want: Set(slideId) }
  // clear すると bucket ごと捨てる（古い送信の結果が新しい回答に混ざらないよう、世代で分ける）
  const buckets = new Map();

  const keyOf = (sid) => `classpulse:outbox:${sid}`;

  function bucket(sid) {
    if (buckets.has(sid)) return buckets.get(sid);
    const data = {};
    try {
      const raw = storage.getItem(keyOf(sid));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        for (const [slideId, e] of Object.entries(parsed)) {
          if (!e || !Number.isInteger(e.choice) || !STATES.has(e.state)) continue;
          // 前回の送信が終わったか分からないものは、保留として送り直す
          data[slideId] = { choice: e.choice, state: e.state === 'sending' ? 'queued' : e.state, unsaved: false };
        }
      }
    } catch { /* こわれたデータは無いものとして扱う */ }
    const b = { data, active: new Map(), want: new Set(), frozen: false };
    buckets.set(sid, b);
    return b;
  }

  // 保存できたかを返す
  function save(sid) {
    const out = {};
    const b = bucket(sid);
    for (const [k, e] of Object.entries(b.data)) {
      out[k] = { choice: e.choice, state: b.frozen && e.state === 'sending' ? 'unconfirmed' : e.state };
    }
    try { storage.setItem(keyOf(sid), JSON.stringify(out)); return true; } catch { return false; }
  }

  // 終了後は、まだ決まっていない送信中のものも未確認として見せる（成功すれば sent になる）
  const view = (b, e) => (e ? { choice: e.choice, state: b.frozen && e.state === 'sending' ? 'unconfirmed' : e.state } : null);

  function classify(e) {
    if (e && e.name === 'NetError' && e.code === 'network') return 'queued';
    if (e && e.name === 'NetError' && e.code === 'denied') return 'rejected';
    return 'failed';
  }

  // 1 つの質問について、最後に選んだ値になるまで順番に送る（古い送信が後から追いつかないように）
  function drive(sid, slideId) {
    const b = bucket(sid);
    if (b.active.has(slideId)) return b.active.get(slideId);
    const chainKey = `${sid}|${slideId}`;
    const prev = chains.get(chainKey);
    const run = (async () => {
      // 同じ質問の前の送信（clear 前のもの）が終わってから送る。最後に put したものが最後の書き込みになる
      if (prev) await prev;
      try {
        for (;;) {
          const entry = b.data[slideId];
          if (!entry || entry.state !== 'sending') break;
          if (b.frozen) { // 終わった授業へは、新しい送信を始めない
            entry.state = 'unconfirmed';
            save(sid);
            onSettle(sid, slideId);
            break;
          }
          const sentChoice = entry.choice;
          entry.inflight = sentChoice;
          let result = 'sent';
          let confirmed = null;
          try {
            const r = await send(sid, slideId, sentChoice);
            if (r && Number.isInteger(r.choice)) confirmed = r.choice;
          } catch (e) {
            result = classify(e);
          }
          if (buckets.get(sid) !== b) break; // 送信中に clear された
          const now = b.data[slideId];
          if (!now || now.state !== 'sending') break;
          if (now.choice !== sentChoice) continue; // 送信中に選びなおされた。新しい値を送る
          if (confirmed !== null) now.choice = confirmed;
          now.inflight = null;
          if (b.frozen) { // 授業が終わった。実際に送った値が成功したときだけ sent。それ以外は未確認
            now.choice = sentChoice;
            now.state = result === 'sent' && confirmed === null ? 'sent' : 'unconfirmed';
            save(sid);
            onSettle(sid, slideId);
            break;
          }
          // 保存できていない回答は、つながらなかったときに「保留」と言えない（再読み込みで消える）
          if (result === 'queued' && now.unsaved) result = 'failed';
          if (result === 'queued' && b.want.delete(slideId) && canSend(sid, slideId)) { // 送信中に再送の要求があった
            continue;
          }
          now.state = result;
          if (result === 'sent') now.unsaved = false;
          if (save(sid)) now.unsaved = false;
          onSettle(sid, slideId);
          break;
        }
      } finally {
        b.active.delete(slideId);
        b.want.delete(slideId);
      }
      return buckets.get(sid) === b ? view(b, b.data[slideId]) : null;
    })();
    b.active.set(slideId, run);
    const tail = run.then(() => {}, () => {}).then(() => { if (chains.get(chainKey) === tail) chains.delete(chainKey); });
    chains.set(chainKey, tail);
    return run;
  }

  return {
    async put(sid, slideId, choice) {
      const b = bucket(sid);
      if (b.frozen) { // 終わった授業には送らない
        b.data[slideId] = { choice, state: 'unconfirmed', unsaved: false };
        save(sid);
        return view(b, b.data[slideId]);
      }
      const inflight = b.data[slideId] ? b.data[slideId].inflight ?? null : null; // 送信中のものは引き継ぐ
      b.data[slideId] = { choice, state: 'sending', unsaved: false, inflight };
      b.data[slideId].unsaved = !save(sid);
      return drive(sid, slideId);
    },
    // 保留（queued）のものを送り直す。送信中のものは、終わったあとに保留になれば送り直す
    // skip(slideId) が真の質問は送らない（締切が分かっている質問へ再送しないため）
    async flush(sid, skip = () => false) {
      const b = bucket(sid);
      const jobs = [];
      let changed = false;
      for (const [slideId, e] of Object.entries(b.data)) {
        if (e.state === 'queued') {
          if (skip(slideId)) continue;
          e.state = 'sending';
          changed = true;
          jobs.push(drive(sid, slideId));
        } else if (e.state === 'sending' && b.active.has(slideId)) {
          b.want.add(slideId);
          jobs.push(b.active.get(slideId));
        }
      }
      if (changed) save(sid);
      await Promise.all(jobs);
    },
    // failed のものを手動で送り直す
    async retry(sid, slideId) {
      const b = bucket(sid);
      const e = b.data[slideId];
      if (!e || e.state !== 'failed') return view(b, e);
      e.state = 'sending';
      if (save(sid)) e.unsaved = false;
      return drive(sid, slideId);
    },
    // 授業が終わった。送れていないもの（queued / failed）は未確認にし、以後は送り直さない。
    // 送信中のものは、終わった時点で未確認にする。sent / rejected は変えない
    freeze(sid) {
      const b = bucket(sid);
      b.frozen = true;
      let changed = false;
      for (const [slideId, e] of Object.entries(b.data)) {
        if (e.state === 'queued' || e.state === 'failed') { e.state = 'unconfirmed'; changed = true; }
        else if (e.state === 'sending') {
          if (b.active.has(slideId) && Number.isInteger(e.inflight)) {
            e.choice = e.inflight; // 実際に送った値。結果は送信が終わったときに決まる
          } else { e.state = 'unconfirmed'; changed = true; } // まだ送っていない（順番待ち）
        }
      }
      changed = true;
      if (changed) save(sid);
      return changed;
    },
    // 締切・終了が分かった質問の、送れていない回答（queued / failed）を rejected にする。変えたら true
    rejectPending(sid, isClosed) {
      const b = bucket(sid);
      if (b.frozen) return false;
      let changed = false;
      for (const [slideId, e] of Object.entries(b.data)) {
        if ((e.state === 'queued' || e.state === 'failed') && isClosed(slideId)) {
          e.state = 'rejected';
          changed = true;
        }
      }
      if (changed) save(sid);
      return changed;
    },
    // 条件に合う質問のうち、送れていない（queued / failed）ものの id
    pendingIds(sid, isClosed) {
      return Object.entries(bucket(sid).data)
        .filter(([slideId, e]) => (e.state === 'queued' || e.state === 'failed') && isClosed(slideId))
        .map(([slideId]) => slideId);
    },
    // サーバーとの照合結果を反映する。choice が数ならその値を送信済みに、null なら rejected。変えたら true
    settle(sid, slideId, choice) {
      const b = bucket(sid);
      const e = b.data[slideId];
      if (b.frozen || !e || (e.state !== 'queued' && e.state !== 'failed')) return false;
      if (Number.isInteger(choice)) { e.choice = choice; e.state = 'sent'; } else e.state = 'rejected';
      e.unsaved = false;
      save(sid);
      return true;
    },
    get(sid, slideId) {
      const b = bucket(sid);
      return view(b, b.data[slideId]);
    },
    clear(sid) {
      buckets.delete(sid);
      try { storage.removeItem(keyOf(sid)); } catch { /* 無視 */ }
    },
  };
}
