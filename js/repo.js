// 先生のデータ（教材・一覧・授業中の指し先・履歴）の読み書き。
// 通信は net を引数で受け取る。
import { normalizeDeck } from './model.js';

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

    async getHistory(sid) {
      return net.get(`${base}/history/${sid}`);
    },

    async saveHistory(sid, history) {
      await net.set(`${base}/history/${sid}`, history);
    },

    // 履歴と、終わった授業のデータ（sessions/<sid>）を一緒に消す
    async deleteHistory(sid) {
      await net.remove(`${base}/history/${sid}`);
      await net.remove(`sessions/${sid}`);
    },
  };
}
