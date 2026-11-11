// 編集画面を離れたあとも、保存できていない教材を保存し続ける（ブラウザの「戻る」は止められないため）。
// タイマー・通知・「閉じる前の確認」の付けはずし・今ログインしている先生の uid は引数で受け取る
// （Node のテストでも動かせる）。
//
// 保存待ちは「持ち主の uid + 教材 ID」で分ける。保存は、作ったときの save（持ち主の repo）で書く。
// 持ち主がログインしていない間（ログアウト中・別の先生がログイン中）は、保存も知らせも止める。
//
// hand(uid, deckId, { deck, save, title, failed, after }) … 保存を引きつぐ（同じ教材なら新しい内容に置きかえる）
// track(uid, deckId, promise) … まだ教材に入っていない処理（画像の追加など）を数に入れる
// settle(uid, deckId) … その教材の処理と保存の試みが終わるまで待つ
// adopt(uid, deckId) … 持ち主がログイン中なら、引きついだ内容を返して引きつぎをやめる（無ければ null）
// discard(uid, deckId) … 教材を削除する前に呼ぶ。保存待ちを取り消し、進行中の保存が済むまで待つ。
//                        このあと届いた内容（遅れて終わった画像の追加など）は保存しない
export function createBackgroundSaver({ setTimeout, clearTimeout, retryMs, onGuard, onEvent, getCurrentUid }) {
  const entries = new Map();   // key → { owner, deck, save, title, failed, warned, timer, running }
  const tasks = new Map();     // key → Set<Promise>
  const discarded = new Set(); // 削除した教材の key
  let guardOn = false;

  const keyOf = (uid, deckId) => `${uid}\u0000${deckId}`;
  const currentUid = () => (getCurrentUid ? getCurrentUid() : null);

  function updateGuard() {
    let on = entries.size > 0;
    for (const set of tasks.values()) if (set.size) on = true;
    if (on === guardOn) return;
    guardOn = on;
    if (onGuard) onGuard(on);
  }

  const notify = (kind, title) => { if (onEvent) onEvent(kind, title); };

  function remove(key, e) {
    if (entries.get(key) !== e) return;
    if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
    entries.delete(key);
    updateGuard();
  }

  function later(key, e) {
    e.timer = setTimeout(() => { e.timer = null; attempt(key); }, retryMs);
  }

  function attempt(key) {
    const e = entries.get(key);
    if (!e || e.running || discarded.has(key)) return;
    if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
    // 持ち主がログインしていない間は書かない（古いログインで書かない）。あとで確かめ直す
    if (currentUid() !== e.owner) { later(key, e); return; }
    const deck = e.deck;
    e.running = (async () => {
      let ok = true;
      try { await e.save(deck); } catch { ok = false; }
      e.running = null;
      if (entries.get(key) !== e || discarded.has(key)) return; // 途中で adopt・discard された
      if (!ok) {
        e.failed = true;
        if (!e.warned && currentUid() === e.owner) { e.warned = true; notify('failing', e.title); }
        later(key, e);
        return;
      }
      if (e.deck !== deck) { attempt(key); return; } // 保存中に新しい内容が来た
      remove(key, e);
      if (e.failed && currentUid() === e.owner) notify('saved', e.title);
    })();
  }

  function track(uid, deckId, promise) {
    const key = keyOf(uid, deckId);
    if (!tasks.has(key)) tasks.set(key, new Set());
    const set = tasks.get(key);
    const p = Promise.resolve(promise).catch(() => {});
    set.add(p);
    updateGuard();
    p.then(() => {
      set.delete(p);
      if (!set.size) tasks.delete(key);
      updateGuard();
    });
    return p;
  }

  async function settleKey(key) {
    for (;;) {
      const waits = [...(tasks.get(key) || [])];
      const e = entries.get(key);
      if (e && e.running) waits.push(e.running);
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  return {
    hand(uid, deckId, { deck, save, title = '', failed = false, after = null }) {
      const key = keyOf(uid, deckId);
      if (discarded.has(key)) return; // 削除した教材には書かない
      let e = entries.get(key);
      if (!e) {
        e = { owner: uid, deck, save, title, failed, warned: false, timer: null, running: null };
        entries.set(key, e);
      } else {
        e.deck = deck;
        e.save = save;
        e.title = title;
        e.failed = e.failed || failed;
      }
      updateGuard();
      if (!after) { attempt(key); return; }
      // 編集画面の保存（after）が終わってから。after が true なら、その内容はもう保存できている
      track(uid, deckId, Promise.resolve(after).then((alreadySaved) => {
        const cur = entries.get(key);
        if (cur !== e || discarded.has(key)) return;
        if (alreadySaved === true && cur.deck === deck && !cur.running) {
          remove(key, cur);
          if (cur.failed && currentUid() === cur.owner) notify('saved', cur.title);
          return;
        }
        attempt(key);
      }, () => attempt(key)));
    },

    track,

    settle(uid, deckId) {
      return settleKey(keyOf(uid, deckId));
    },

    adopt(uid, deckId) {
      const key = keyOf(uid, deckId);
      const e = entries.get(key);
      if (!e || e.owner !== uid || currentUid() !== uid) return null;
      remove(key, e);
      return e.deck;
    },

    async discard(uid, deckId) {
      const key = keyOf(uid, deckId);
      discarded.add(key);
      const e = entries.get(key);
      if (e && e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
      // 進行中の保存と、数に入れた処理（編集画面の最後の保存・画像の追加）が済むまで待つ。
      // そのあいだに届いた内容は、discarded なので保存しない
      await settleKey(key);
      const cur = entries.get(key);
      if (cur) remove(key, cur);
    },

    // 削除が取りやめ・失敗で、教材がまだあるとき（編集画面で開けたとき）に、取り消しの印を外す
    undiscard(uid, deckId) {
      discarded.delete(keyOf(uid, deckId));
    },

    hasPending(uid, deckId) {
      if (uid === undefined) return guardOn;
      const key = keyOf(uid, deckId);
      return entries.has(key) || Boolean(tasks.get(key)?.size);
    },
  };
}
