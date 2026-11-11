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

const byNewest = (key) => (a, b) => (b[key] || 0) - (a[key] || 0);

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
          options: toArray(q && q.options),
          counts: toArray(q && q.counts),
        })),
      };
    },

    async saveHistory(sid, history) {
      await net.set(`${base}/history/${sid}`, history);
    },

    // 履歴と、終わった授業のデータ（sessions/<sid>）を、ルートへの 1 回の update で一緒に消す
    async deleteHistory(sid) {
      await net.update('', { [`${base}/history/${sid}`]: null, [`sessions/${sid}`]: null });
    },
  };
}
