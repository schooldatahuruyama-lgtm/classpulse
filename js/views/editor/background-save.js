// 編集画面を離れたあとも、保存できていない教材を保存し続ける（ブラウザの「戻る」は止められないため）。
// タイマー・通知・「閉じる前の確認」の付けはずしは引数で受け取る（Node のテストでも動かせる）。
//
// hand(deckId, { deck, save, title, failed, after }) … 保存を引きつぐ（同じ教材なら新しい内容に置きかえる）
// track(deckId, promise) … まだ教材に入っていない処理（画像の追加など）を数に入れる
// settle(deckId) … その教材の処理と保存の試みが終わるまで待つ
// adopt(deckId) … 引きついだ内容を返して、引きつぎをやめる（無ければ null）
export function createBackgroundSaver({ setTimeout, clearTimeout, retryMs, onGuard, onEvent }) {
  const entries = new Map(); // deckId → { deck, save, title, failed, warned, timer, running }
  const tasks = new Map();   // deckId → Set<Promise>
  let guardOn = false;

  function updateGuard() {
    let on = entries.size > 0;
    for (const set of tasks.values()) if (set.size) on = true;
    if (on === guardOn) return;
    guardOn = on;
    if (onGuard) onGuard(on);
  }

  const notify = (kind, title) => { if (onEvent) onEvent(kind, title); };

  function attempt(id) {
    const e = entries.get(id);
    if (!e || e.running) return;
    if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
    const deck = e.deck;
    e.running = (async () => {
      let ok = true;
      try { await e.save(deck); } catch { ok = false; }
      e.running = null;
      if (entries.get(id) !== e) return; // 途中で adopt された
      if (!ok) {
        e.failed = true;
        if (!e.warned) { e.warned = true; notify('failing', e.title); }
        e.timer = setTimeout(() => { e.timer = null; attempt(id); }, retryMs);
        return;
      }
      if (e.deck !== deck) { attempt(id); return; } // 保存中に新しい内容が来た
      entries.delete(id);
      updateGuard();
      if (e.failed) notify('saved', e.title);
    })();
  }

  function track(id, promise) {
    if (!tasks.has(id)) tasks.set(id, new Set());
    const set = tasks.get(id);
    const p = Promise.resolve(promise).catch(() => {});
    set.add(p);
    updateGuard();
    p.then(() => {
      set.delete(p);
      if (!set.size) tasks.delete(id);
      updateGuard();
    });
    return p;
  }

  return {
    hand(id, { deck, save, title = '', failed = false, after = null }) {
      let e = entries.get(id);
      if (!e) {
        e = { deck, save, title, failed, warned: false, timer: null, running: null };
        entries.set(id, e);
      } else {
        e.deck = deck;
        e.save = save;
        e.title = title;
        e.failed = e.failed || failed;
      }
      updateGuard();
      if (!after) { attempt(id); return; }
      // 編集画面の保存（after）が終わってから。after が true なら、その内容はもう保存できている
      track(id, Promise.resolve(after).then((alreadySaved) => {
        const cur = entries.get(id);
        if (cur !== e) return;
        if (alreadySaved === true && cur.deck === deck && !cur.running) {
          if (cur.timer !== null) clearTimeout(cur.timer);
          entries.delete(id);
          updateGuard();
          if (cur.failed) notify('saved', cur.title);
          return;
        }
        attempt(id);
      }, () => attempt(id)));
    },

    track,

    async settle(id) {
      for (;;) {
        const waits = [...(tasks.get(id) || [])];
        const e = entries.get(id);
        if (e && e.running) waits.push(e.running);
        if (!waits.length) return;
        await Promise.allSettled(waits);
      }
    },

    adopt(id) {
      const e = entries.get(id);
      if (!e) return null;
      if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
      entries.delete(id);
      updateGuard();
      return e.deck;
    },

    hasPending(id) {
      if (id === undefined) return guardOn;
      return entries.has(id) || Boolean(tasks.get(id)?.size);
    },
  };
}
