// 先生のデータ（教材・一覧・授業中の指し先・履歴）の読み書き。
// 通信は net を引数で受け取る。
import { normalizeDeck } from './model.js';
import { CONFIG } from './config.js';
import { isTrashed, isExpired } from './trash.js';

function toArray(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  }
  return [];
}

// 添字つきの配列にする（{5:2} のような疎なオブジェクトも、添字の位置を保つ）
function toIndexed(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    const out = new Array(keys.length ? Math.max(...keys) + 1 : 0).fill(null);
    for (const k of keys) out[k] = v[k];
    return out;
  }
  return [];
}

const byNewest = (key) => (a, b) => (b[key] || 0) - (a[key] || 0);

function normalizeQuestion(q) {
  const src = q && typeof q === 'object' ? q : {};
  // 自由記述は文の配列で持つ。type の無い（試作1 の）項目はアンケートとして読む
  if (src.type === 'free') {
    const texts = (v) => toIndexed(v).filter((t) => typeof t === 'string');
    return {
      type: 'free',
      texts: texts(src.texts),
      hiddenTexts: texts(src.hiddenTexts),
      total: typeof src.total === 'number' ? src.total : 0,
    };
  }
  // ワードクラウドは { word, count } の配列で持つ。word が文字列でないものは落とし、count は数でなければ 0
  if (src.type === 'cloud') {
    const words = (v) => toIndexed(v)
      .filter((x) => x && typeof x === 'object' && typeof x.word === 'string')
      .map((x) => ({ word: x.word, count: typeof x.count === 'number' ? x.count : 0 }));
    return {
      type: 'cloud',
      words: words(src.words),
      hiddenWords: words(src.hiddenWords),
      total: typeof src.total === 'number' ? src.total : 0,
    };
  }
  const total = typeof src.total === 'number' ? src.total : 0;
  const rawCounts = toIndexed(src.counts);
  const countAt = (i) => (typeof rawCounts[i] === 'number' ? rawCounts[i] : 0);
  // 5 段階評価は 5 個の人数と平均（データベースは null を落とすので、無ければ null）。言葉は文字列
  if (src.type === 'rating') {
    const label = (v) => (typeof v === 'string' ? v : '');
    return {
      type: 'rating',
      lowLabel: label(src.lowLabel),
      highLabel: label(src.highLabel),
      counts: Array.from({ length: CONFIG.rating.steps }, (_, i) => countAt(i)),
      total,
      average: typeof src.average === 'number' && Number.isFinite(src.average) ? src.average : null,
    };
  }
  const options = toIndexed(src.options).map((o) => (typeof o === 'string' ? o : o == null ? '' : String(o)));
  const counts = Array.from({ length: Math.max(options.length, rawCounts.length) }, (_, i) => countAt(i));
  // クイズは正解の番号（選択肢の範囲の整数でなければ null）と正解の人数
  if (src.type === 'quiz') {
    const c = src.correct;
    const correct = Number.isInteger(c) && c >= 0 && c < options.length ? c : null;
    return {
      type: 'quiz', options, counts, total, correct,
      correctCount: correct !== null && typeof src.correctCount === 'number' ? src.correctCount : 0,
    };
  }
  return { type: 'poll', options, counts, total };
}

export function createRepo(net, uid) {
  const base = `teachers/${uid}`;

  // 一覧の項目（[id, 項目] の配列。オブジェクトでない項目は落とす）
  async function readIndex() {
    const index = (await net.get(`${base}/deckIndex`)) || {};
    return Object.entries(index).filter(([, e]) => e && typeof e === 'object');
  }

  const entryFields = (e) => ({
    title: typeof e.title === 'string' ? e.title : '',
    slideCount: typeof e.slideCount === 'number' ? e.slideCount : 0,
  });

  // ゴミ箱の中で、条件に合う教材を 1 回の update で完全に削除する（無ければ書かない）
  async function purgeWhere(match) {
    const ids = (await readIndex()).filter(([, e]) => isTrashed(e) && match(e)).map(([id]) => id);
    if (!ids.length) return 0;
    const patch = {};
    for (const id of ids) { patch[`decks/${id}`] = null; patch[`deckIndex/${id}`] = null; }
    await net.update(base, patch);
    return ids.length;
  }

  return {
    async isTeacher() {
      return (await net.get(`teacherList/${uid}`)) === true;
    },

    // 一覧は deckIndex から（教材そのものは読まない）。新しい順。ゴミ箱の中の教材は出さない
    async listDecks() {
      return (await readIndex())
        .filter(([, e]) => !isTrashed(e))
        .map(([id, e]) => ({ id, ...entryFields(e), updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 }))
        .sort(byNewest('updatedAt'));
    },

    // ゴミ箱の中の教材。新しく入れた順（入れた時刻がこわれているものは最後。deletedAt は null）
    async listTrash() {
      return (await readIndex())
        .filter(([, e]) => isTrashed(e))
        .map(([id, e]) => ({ id, ...entryFields(e), deletedAt: typeof e.deletedAt === 'number' && Number.isFinite(e.deletedAt) ? e.deletedAt : null }))
        .sort(byNewest('deletedAt'));
    },

    // ゴミ箱の中の教材は開かない（null）。印の確認は小さな読みこみで、教材の読みこみと並べて行う
    async loadDeck(id) {
      const [raw, deletedAt] = await Promise.all([
        net.get(`${base}/decks/${id}`),
        net.get(`${base}/deckIndex/${id}/deletedAt`),
      ]);
      if (raw === null || isTrashed({ deletedAt })) return null;
      return normalizeDeck(raw);
    },

    // 教材と一覧の項目は 1 回の update で書く（食い違わないように）。
    // 一覧の項目は 1 つずつ書く（まるごと書くと、別のタブが付けたゴミ箱の印を消してしまう）
    async saveDeck(id, deck, now) {
      const saved = { ...deck, updatedAt: now };
      await net.update(base, {
        [`decks/${id}`]: saved,
        [`deckIndex/${id}/title`]: saved.title,
        [`deckIndex/${id}/updatedAt`]: now,
        [`deckIndex/${id}/slideCount`]: saved.order.length,
      });
    },

    // 完全に削除する（元に戻せない）
    async deleteDeck(id) {
      await net.update(base, { [`decks/${id}`]: null, [`deckIndex/${id}`]: null });
    },

    // 教材が今どこにあるか: 'live'（一覧）・'trashed'（ゴミ箱）・'missing'（無い）
    async deckState(id) {
      const e = await net.get(`${base}/deckIndex/${id}`);
      if (e === null || typeof e !== 'object') return 'missing';
      return isTrashed(e) ? 'trashed' : 'live';
    },

    // ゴミ箱の教材を完全に削除する。消す直前に確かめ直し、（別のタブで）元に戻されていたら消さずに false
    async purgeDeck(id) {
      if ((await this.deckState(id)) === 'live') return false;
      await this.deleteDeck(id);
      return true;
    },

    // ゴミ箱に移す・戻す。一覧の項目の印だけを書く（教材の中身は読み書きしない）
    async trashDeck(id, now) {
      await net.set(`${base}/deckIndex/${id}/deletedAt`, now);
    },

    async restoreDeck(id) {
      await net.remove(`${base}/deckIndex/${id}/deletedAt`);
    },

    // ゴミ箱の中の教材をすべて完全に削除する。消した数を返す
    async emptyTrash() {
      return purgeWhere(() => true);
    },

    // ゴミ箱に入れてから決まった日数がたった教材を完全に削除する。消した数を返す
    async purgeExpiredTrash(now) {
      return purgeWhere((e) => isExpired(e.deletedAt, now));
    },

    async getActive() {
      return net.get(`${base}/active`);
    },

    async setActive(value) {
      if (value === null) await net.remove(`${base}/active`);
      else await net.set(`${base}/active`, value);
    },

    async listHistory() {
      const all = (await net.get(`${base}/history`)) || {};
      return Object.entries(all)
        .map(([sid, h]) => ({
          sid,
          title: typeof h.title === 'string' ? h.title : '',
          endedAt: typeof h.endedAt === 'number' ? h.endedAt : 0,
          participants: typeof h.participants === 'number' ? h.participants : 0,
        }))
        .sort(byNewest('endedAt'));
    },

    // データベースは空の配列を落とし、配列を {0:…} で返すことがあるので形を戻す
    async getHistory(sid) {
      const h = await net.get(`${base}/history/${sid}`);
      if (h === null) return null;
      return {
        ...h,
        participants: typeof h.participants === 'number' ? h.participants : 0,
        questions: toArray(h.questions).map((q) => ({
          ...q,
          ...normalizeQuestion(q),
        })),
      };
    },

    async saveHistory(sid, history) {
      await net.set(`${base}/history/${sid}`, history);
    },

    // 履歴と、終わった授業のデータ（sessions/<sid>）を、ルートへの 1 回の update で一緒に消す。
    // 終了の後片づけが途中で止まっていて「発表中」の印がこの授業を指したままなら、その印も一緒に消す
    // （消えた授業を指す印が残ると、次の授業を始められなくなる）
    async deleteHistory(sid) {
      const patch = { [`${base}/history/${sid}`]: null, [`sessions/${sid}`]: null };
      const active = await net.get(`${base}/active`);
      if (active && active.sid === sid) patch[`${base}/active`] = null;
      await net.update('', patch);
    },

    // 「発表中」の印が sid を指しているときだけ外す。外したら true
    async clearActiveIf(sid) {
      const active = await net.get(`${base}/active`);
      if (!active || active.sid !== sid) return false;
      await net.remove(`${base}/active`);
      return true;
    },
  };
}
