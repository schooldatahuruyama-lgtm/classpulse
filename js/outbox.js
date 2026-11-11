// 回答の一時保存と再送。DOM・通信・グローバルに触れない（保存先と送信は引数で受け取る）。
// 同じ質問への回答は 1 件だけ持ち、選びなおしたら前の未送信は置きかえる（最後の回答が勝つ）。
// state: 'sending'（送信中）、'sent'（送信済み）、'queued'（つながらず保留。あとで送り直す）、
//        'rejected'（規則に拒否された。締切など。送り直さない）、
//        'failed'（そのほかの失敗、または保存できていないままつながらなかったもの。手動で retry する）
// send は成功したら何も返さないか、サーバーに別の回答が残っていたとき { choice } を返す（その値を送信済みとする）。
const STATES = new Set(['sending', 'sent', 'queued', 'rejected', 'failed']);

export function createOutbox({ storage, send }) {
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
    const b = { data, active: new Map(), want: new Set() };
    buckets.set(sid, b);
    return b;
  }

  // 保存できたかを返す
  function save(sid) {
    const out = {};
    for (const [k, e] of Object.entries(bucket(sid).data)) out[k] = { choice: e.choice, state: e.state };
    try { storage.setItem(keyOf(sid), JSON.stringify(out)); return true; } catch { return false; }
  }

  const copy = (e) => (e ? { choice: e.choice, state: e.state } : null);

  function classify(e) {
    if (e && e.name === 'NetError' && e.code === 'network') return 'queued';
    if (e && e.name === 'NetError' && e.code === 'denied') return 'rejected';
    return 'failed';
  }

  // 1 つの質問について、最後に選んだ値になるまで順番に送る（古い送信が後から追いつかないように）
  function drive(sid, slideId) {
    const b = bucket(sid);
    if (b.active.has(slideId)) return b.active.get(slideId);
    const run = (async () => {
      try {
        for (;;) {
          const entry = b.data[slideId];
          if (!entry || entry.state !== 'sending') break;
          const sentChoice = entry.choice;
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
          if (!now) break;
          if (now.choice !== sentChoice) continue; // 送信中に選びなおされた。新しい値を送る
          if (confirmed !== null) now.choice = confirmed;
          // 保存できていない回答は、つながらなかったときに「保留」と言えない（再読み込みで消える）
          if (result === 'queued' && now.unsaved) result = 'failed';
          if (result === 'queued' && b.want.delete(slideId)) { // 送信中に再送の要求があった
            continue;
          }
          now.state = result;
          if (result === 'sent') now.unsaved = false;
          if (save(sid)) now.unsaved = false;
          break;
        }
      } finally {
        b.active.delete(slideId);
        b.want.delete(slideId);
      }
      return copy(buckets.get(sid) === b ? b.data[slideId] : null);
    })();
    b.active.set(slideId, run);
    return run;
  }

  return {
    async put(sid, slideId, choice) {
      const b = bucket(sid);
      b.data[slideId] = { choice, state: 'sending', unsaved: false };
      b.data[slideId].unsaved = !save(sid);
      return drive(sid, slideId);
    },
    // 保留（queued）のものを送り直す。送信中のものは、終わったあとに保留になれば送り直す
    async flush(sid) {
      const b = bucket(sid);
      const jobs = [];
      let changed = false;
      for (const [slideId, e] of Object.entries(b.data)) {
        if (e.state === 'queued') {
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
      if (!e || e.state !== 'failed') return copy(e);
      e.state = 'sending';
      save(sid);
      return drive(sid, slideId);
    },
    // 締切・終了が分かった質問の、送れていない回答（queued / failed）を rejected にする。変えたら true
    rejectPending(sid, isClosed) {
      const b = bucket(sid);
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
    get(sid, slideId) {
      return copy(bucket(sid).data[slideId]);
    },
    clear(sid) {
      buckets.delete(sid);
      try { storage.removeItem(keyOf(sid)); } catch { /* 無視 */ }
    },
  };
}
