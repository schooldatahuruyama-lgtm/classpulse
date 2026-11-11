// 回答の一時保存と再送。DOM・通信・グローバルに触れない（保存先と送信は引数で受け取る）。
// 同じ質問への回答は 1 件だけ持ち、選びなおしたら前の未送信は置きかえる（最後の回答が勝つ）。
// state: 'sending'（送信中）、'sent'（送信済み）、'queued'（つながらず保留。あとで送り直す）、
//        'rejected'（規則に拒否された。締切など。送り直さない）、'failed'（そのほかの失敗）
const STATES = new Set(['sending', 'sent', 'queued', 'rejected', 'failed']);

export function createOutbox({ storage, send }) {
  const cache = new Map();   // sid -> { [slideId]: { choice, state } }
  const active = new Map();  // `${sid}\n${slideId}` -> 送信中の Promise

  const keyOf = (sid) => `classpulse:outbox:${sid}`;

  function load(sid) {
    if (cache.has(sid)) return cache.get(sid);
    const data = {};
    try {
      const raw = storage.getItem(keyOf(sid));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        for (const [slideId, e] of Object.entries(parsed)) {
          if (!e || !Number.isInteger(e.choice) || !STATES.has(e.state)) continue;
          // 前回の送信が終わったか分からないものは、保留として送り直す
          data[slideId] = { choice: e.choice, state: e.state === 'sending' ? 'queued' : e.state };
        }
      }
    } catch { /* こわれたデータは無いものとして扱う */ }
    cache.set(sid, data);
    return data;
  }

  function save(sid) {
    try { storage.setItem(keyOf(sid), JSON.stringify(load(sid))); } catch { /* 保存できなくても動かす */ }
  }

  const copy = (e) => (e ? { choice: e.choice, state: e.state } : null);

  function classify(e) {
    if (e && e.name === 'NetError' && e.code === 'network') return 'queued';
    if (e && e.name === 'NetError' && e.code === 'denied') return 'rejected';
    return 'failed';
  }

  // 1 つの質問について、最後に選んだ値になるまで順番に送る（古い送信が後から追いつかないように）
  function drive(sid, slideId) {
    const id = `${sid}\n${slideId}`;
    if (active.has(id)) return active.get(id);
    const data = load(sid);
    const run = (async () => {
      try {
        for (;;) {
          const entry = data[slideId];
          if (!entry || entry.state !== 'sending') break;
          const sentChoice = entry.choice;
          let result = 'sent';
          try {
            await send(sid, slideId, sentChoice);
          } catch (e) {
            result = classify(e);
          }
          if (cache.get(sid) !== data) break; // 送信中に clear された
          const now = data[slideId];
          if (!now) break;
          if (now.choice !== sentChoice) continue; // 送信中に選びなおされた。新しい値を送る
          now.state = result;
          save(sid);
          break;
        }
      } finally {
        active.delete(id);
      }
      return copy(cache.get(sid) === data ? data[slideId] : null);
    })();
    active.set(id, run);
    return run;
  }

  return {
    async put(sid, slideId, choice) {
      load(sid)[slideId] = { choice, state: 'sending' };
      save(sid);
      return drive(sid, slideId);
    },
    async flush(sid) {
      const data = load(sid);
      const jobs = [];
      for (const [slideId, e] of Object.entries(data)) {
        if (e.state !== 'queued') continue;
        e.state = 'sending';
        jobs.push(drive(sid, slideId));
      }
      save(sid);
      await Promise.all(jobs);
    },
    get(sid, slideId) {
      return copy(load(sid)[slideId]);
    },
    clear(sid) {
      cache.delete(sid);
      try { storage.removeItem(keyOf(sid)); } catch { /* 無視 */ }
    },
  };
}
