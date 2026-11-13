// 編集画面を離れたあとも、保存できていない教材を保存し続ける（ブラウザの「戻る」は止められないため）。
// タイマー・通知・「閉じる前の確認」の付けはずし・今ログインしている先生の uid は引数で受け取る
// （Node のテストでも動かせる）。
//
// 保存待ちは「持ち主の uid + 教材 ID」で分ける。保存は、作ったときの save（持ち主の repo）で書く。
//
// 編集から教材を書く道は guardedSave だけ（編集画面の自動保存・離れるときの保存・ここの再試行・遅れて届いた画像）。
// 削除の手続き中と、このタブで削除に成功した教材（uid + 教材 ID）には書かない。
// 削除に成功した印はページを開いている間ずっと残す（教材 ID は使い回さない）。失敗した削除では印を付けない。
// 持ち主がログインしていない間（ログアウト中・別の先生がログイン中）は、保存も知らせも止める。
//
// hand(uid, deckId, { deck, save, title, failed, after }) … 保存を引きつぐ（同じ教材なら新しい内容に置きかえる）
// track(uid, deckId, promise) … まだ教材に入っていない処理（画像の追加など）を数に入れる
// settle(uid, deckId) … その教材の処理と保存の試みが終わるまで待つ
// adopt(uid, deckId) … 持ち主がログイン中なら、引きついだ内容を返して引きつぎをやめる（無ければ null）
// guardedSave(uid, deckId, deck, write) … write(deck) で書く。書いたら true。断ったら書かずに false（write の失敗は投げる）
// isDeleted(uid, deckId) … このタブで削除に成功した教材なら true
// undelete(uid, deckId) … ゴミ箱から戻した教材の、削除済みの印を外す
// deleting(uid, deckId, doDelete) … 教材の削除を 1 つの手続きで行う（下の説明）
// whenNotDeleting(uid, deckId) … 削除の手続き中なら、終わるまで待つ
// whenIdle(uid, deckId) … 進行中の処理と保存の試みが済むまで待つ。保存待ちが残っていなければ true。
//   保存に失敗して再試行を待っている（まだ保存できていない）なら false（発表を始める前に確かめる）
export function createBackgroundSaver({ setTimeout, clearTimeout, retryMs, onGuard, onEvent, getCurrentUid }) {
  const entries = new Map();   // key → { owner, deck, save, title, failed, warned, timer, running }
  const tasks = new Map();     // key → Set<Promise>（画像の追加など、外から数に入れた処理）
  const afters = new Map();    // key → Set<Promise>（編集画面の最後の保存を待つもの）
  const deletes = new Map();   // key → Promise（削除の手続き中。終われば成否にかかわらず解決）
  const writes = new Map();    // key → Set<Promise>（guardedSave で書いている途中のもの）
  const deleted = new Set();   // key（このタブで削除に成功した教材。ページを開いている間ずっと残す）
  let guardOn = false;

  const keyOf = (uid, deckId) => `${uid}\u0000${deckId}`;
  const currentUid = () => (getCurrentUid ? getCurrentUid() : null);

  function updateGuard() {
    let on = entries.size > 0;
    for (const m of [tasks, afters]) for (const set of m.values()) if (set.size) on = true;
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

  // 教材を書くただ 1 つの関門。削除中・削除済みなら書かずに false を返す。
  // write が false を返したとき（内側の関門が断ったとき）も false。
  async function guarded(key, deck, write) {
    if (deletes.has(key) || deleted.has(key)) return false;
    let done;
    const mark = new Promise((r) => { done = r; });
    if (!writes.has(key)) writes.set(key, new Set());
    const set = writes.get(key);
    set.add(mark); // 削除の手続きは、書いている途中のものが済むまで待つ
    try {
      return (await write(deck)) !== false;
    } finally {
      set.delete(mark);
      if (!set.size && writes.get(key) === set) writes.delete(key);
      done();
    }
  }

  function later(key, e) {
    e.timer = setTimeout(() => { e.timer = null; attempt(key); }, retryMs);
  }

  function attempt(key) {
    const e = entries.get(key);
    if (!e || e.running) return;
    if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
    if (deleted.has(key)) { remove(key, e); return; } // 削除済みの教材には書かない
    if (deletes.has(key)) return; // 削除の手続き中は書かない（失敗したら、手続きが再開する）
    // 持ち主がログインしていない間は書かない（古いログインで書かない）。あとで確かめ直す
    if (currentUid() !== e.owner) { later(key, e); return; }
    const deck = e.deck;
    e.running = (async () => {
      let ok = true;
      let written = false;
      try { written = await guarded(key, deck, e.save); } catch { ok = false; }
      e.running = null;
      if (entries.get(key) !== e) return; // 途中で adopt された
      if (deleted.has(key)) { remove(key, e); return; } // 削除済み
      if (deletes.has(key)) return;       // 削除の手続きが始まった
      if (ok && !written) ok = false;     // 断られた（書いていない）。保存できたことにしない
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

  // 処理を数に入れる（終われば外す）
  function add(map, key, promise) {
    if (!map.has(key)) map.set(key, new Set());
    const set = map.get(key);
    const p = Promise.resolve(promise).catch(() => {});
    set.add(p);
    updateGuard();
    p.then(() => {
      set.delete(p);
      if (!set.size && map.get(key) === set) map.delete(key);
      updateGuard();
    });
    return p;
  }

  // 保存の試み（と、編集画面の最後の保存）が済むまで待つ。withTasks なら画像の追加なども待つ
  async function settleKey(key, { withTasks = true } = {}) {
    for (;;) {
      const waits = [...(afters.get(key) || []), ...(writes.get(key) || [])];
      if (withTasks) waits.push(...(tasks.get(key) || []));
      const e = entries.get(key);
      if (e && e.running) waits.push(e.running);
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  function hand(uid, deckId, { deck, save, title = '', failed = false, after = null }) {
    const key = keyOf(uid, deckId);
    if (deleted.has(key)) return; // 削除済みの教材は預からない
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
    // 削除の手続き中は、内容だけ預かる（成功したら捨て、失敗したら保存を再開する）
    if (!after) { attempt(key); return; }
    // 編集画面の保存（after）が終わってから。after が true なら、その内容はもう保存できている
    add(afters, key, Promise.resolve(after).then((alreadySaved) => {
      const cur = entries.get(key);
      if (cur !== e) return;
      if (alreadySaved === true && cur.deck === deck && !cur.running) {
        remove(key, cur);
        if (cur.failed && currentUid() === cur.owner) notify('saved', cur.title);
        return;
      }
      attempt(key);
    }, () => attempt(key)));
  }

  // 教材の削除を 1 つの手続きで行う。
  // 手続きの間は「削除中」にして保存を止める（未保存の内容と画像の追加は預かったまま）。
  // 進行中の保存が済んでから doDelete を呼ぶ。
  // 成功: 削除済みの印を付け（これより後は guardedSave が書かない）、預かった内容を捨てる。
//       手続き中に始まっていた画像の追加も、終わるのを待つ。保存待ちは何も残さない。
  // 失敗: 印は付けない。預かった内容を保存待ちに戻して保存を再開し、例外をそのまま投げる。
  async function deleting(uid, deckId, doDelete) {
    const key = keyOf(uid, deckId);
    while (deletes.has(key)) await deletes.get(key); // 同じ教材の削除が重なったら、前のを待つ
    let finish;
    const mark = new Promise((r) => { finish = r; });
    deletes.set(key, mark);
    const unmark = () => {
      if (deletes.get(key) === mark) deletes.delete(key);
      finish();
    };
    let ok = false;
    try {
      const e = entries.get(key);
      if (e && e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
      await settleKey(key, { withTasks: false }); // 書いている途中の保存を待つ（そのあとは書かない）
      await doDelete();
      ok = true;
      deleted.add(key); // 成功したときだけ。これより後、この教材には書かない
      const cur = entries.get(key);
      if (cur) remove(key, cur);
      await settleKey(key); // 画像の追加などが終わるのを待つ（届いた内容は預からない）
    } finally {
      unmark();
      // 失敗: 預かった内容を保存待ちに戻して、保存を再開する（例外はそのまま投げる）
      if (!ok && entries.has(key)) attempt(key);
    }
  }

  return {
    hand,
    track(uid, deckId, promise) { return add(tasks, keyOf(uid, deckId), promise); },
    settle(uid, deckId) { return settleKey(keyOf(uid, deckId)); },

    adopt(uid, deckId) {
      const key = keyOf(uid, deckId);
      const e = entries.get(key);
      if (!e || e.owner !== uid || currentUid() !== uid || deletes.has(key)) return null;
      remove(key, e);
      return e.deck;
    },

    deleting,

    guardedSave(uid, deckId, deck, write) { return guarded(keyOf(uid, deckId), deck, write); },
    isDeleted(uid, deckId) { return deleted.has(keyOf(uid, deckId)); },
    // ゴミ箱から戻した教材: 削除済みの印を外す（また開ける・保存できる）
    undelete(uid, deckId) { deleted.delete(keyOf(uid, deckId)); },

    async whenNotDeleting(uid, deckId) {
      const key = keyOf(uid, deckId);
      while (deletes.has(key)) await deletes.get(key);
    },

    async whenIdle(uid, deckId) {
      const key = keyOf(uid, deckId);
      for (;;) {
        while (deletes.has(key)) await deletes.get(key);
        await settleKey(key);
        if (!deletes.has(key)) break;
      }
      return !entries.has(key);
    },

    hasPending(uid, deckId) {
      if (uid === undefined) return guardOn;
      const key = keyOf(uid, deckId);
      return entries.has(key) || Boolean(tasks.get(key)?.size) || Boolean(afters.get(key)?.size);
    },

    // テスト用: この教材について何か残っているか（削除済みの印は数えない）
    _hasState(uid, deckId) {
      const key = keyOf(uid, deckId);
      return entries.has(key) || tasks.has(key) || afters.has(key) || deletes.has(key) || writes.has(key);
    },
  };
}
