// 教材のゴミ箱の日数の計算（純粋な関数）。
// 一覧の項目（deckIndex/<id>）に deletedAt（ゴミ箱に入れた時刻）があれば、ゴミ箱の中。
import { CONFIG } from './config.js';

const DAY_MS = 86400000;
const keepMs = () => CONFIG.trash.keepDays * DAY_MS;

const validTime = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0;

// 印があればゴミ箱の中（値がこわれていても — false や文字列でも — 一覧には出さない）
export function isTrashed(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.deletedAt !== undefined && entry.deletedAt !== null);
}

// 自動で完全に消してよいか。時刻が数でない・未来のものは消さない
export function isExpired(deletedAt, now) {
  if (!validTime(deletedAt) || !validTime(now) || deletedAt > now) return false;
  return now - deletedAt >= keepMs();
}

// 完全に消えるまでの残りの日数（0〜keepDays の整数。切り上げ）。時刻が分からなければ keepDays
export function daysLeft(deletedAt, now) {
  const max = CONFIG.trash.keepDays;
  if (!validTime(deletedAt) || !validTime(now) || deletedAt > now) return max;
  const left = Math.ceil((deletedAt + keepMs() - now) / DAY_MS);
  return Math.min(max, Math.max(0, left));
}
