// 先生のデータ（教材・一覧・授業中の指し先・履歴）の読み書き。
// 通信は net を引数で受け取る。
import { normalizeDeck } from './model.js';

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
  const options = toIndexed(src.options).map((o) => (typeof o === 'string' ? o : o == null ? '' : String(o)));
  const rawCounts = toIndexed(src.counts);
  const counts = Array.from({ length: Math.max(options.length, rawCounts.length) }, (_, i) =>
    (typeof rawCounts[i] === 'number' ? rawCounts[i] : 0));
  return { options, counts, total: typeof src.total === 'number' ? src.total : 0 };
}

export function createRepo(net, uid) {
  const base = `teachers/${uid}`;

  return {
    async isTeacher() {
      return (await net.get(`teacherList/${uid}`)) === true;
    },

    // 一覧は deckIndex から（教材そのものは読まない）。新しい順
    async listDecks() {
      const index = (await net.get(`${base}/deckIndex`)) || {};
      return Object.entries(index)
        .map(([id, e]) => ({
          id,
          title: typeof e.title === 'string' ? e.title : '',
          updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
          slideCount: typeof e.slideCount === 'number' ? e.slideCount : 0,
        }))
        .sort(byNewest('updatedAt'));
    },

    async loadDeck(id) {
      const raw = await net.get(`${base}/decks/${id}`);
      return raw === null ? null : normalizeDeck(raw);
    },

    // 教材と一覧の項目は 1 回の update で書く（食い違わないように）
    async saveDeck(id, deck, now) {
      const saved = { ...deck, updatedAt: now };
      await net.update(base, {
        [`decks/${id}`]: saved,
        [`deckIndex/${id}`]: { title: saved.title, updatedAt: now, slideCount: saved.order.length },
      });
    },

    async deleteDeck(id) {
      await net.update(base, { [`decks/${id}`]: null, [`deckIndex/${id}`]: null });
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
