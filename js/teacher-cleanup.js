// 停止中の先生の削除日と、自動削除。画面の表示は呼び出し元が行う。
import { CONFIG } from './config.js';

const DAY_MS = 86400000;
const MAX_TIME = 8640000000000000;
let running = false; // 画面ごとに repo が作り直されても、同じタブでは重ねて始めない
const validTime = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= MAX_TIME;
const deleteDays = (days) => typeof days === 'number' && Number.isFinite(days) && days > 0 && days * DAY_MS <= MAX_TIME
  ? days : CONFIG.teacher.deleteDays;

export function deleteDate(suspendedAt, days) {
  if (!validTime(suspendedAt)) return null;
  const at = suspendedAt + deleteDays(days) * DAY_MS;
  return validTime(at) ? new Date(at) : null;
}

export function isDue(suspendedAt, now, days) {
  const date = deleteDate(suspendedAt, days);
  return date !== null && validTime(now) && suspendedAt <= now && now >= date.getTime();
}

export function daysLeft(suspendedAt, now, days) {
  const date = deleteDate(suspendedAt, days);
  if (!date || !validTime(now) || suspendedAt > now) return null;
  return Math.max(0, Math.ceil((date.getTime() - now) / DAY_MS));
}

export function deleteNote(suspendedAt, now, days) {
  const left = daysLeft(suspendedAt, now, days);
  if (left === null) return null;
  const date = deleteDate(suspendedAt, days);
  const today = new Date(now);
  if (left === 0 || date.toDateString() === today.toDateString()) return 'まもなく自動で削除されます。';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日に、自動で削除されます（あと ${left} 日）。`;
}

// current は画面移動・ログアウトの確認用。始めた 1 人ぶんの後は続けない。
export async function runTeacherCleanup({ repo, uid, days, current = () => true }) {
  let deleted = 0;
  if (running) return { deleted };
  running = true;
  try {
    if (!current() || !(await repo.isAdmin()) || !current()) return { deleted };
    const teachers = await repo.listTeachers();
    if (!current()) return { deleted };
    const candidates = [];
    for (const teacher of teachers) {
      if (!current()) return { deleted };
      if (teacher.active === true) {
        if (teacher.suspendedAt != null) {
          try { await repo.clearSuspended(teacher.uid); }
          catch { /* 古い時刻を消せなくても、ほかの先生は続ける */ }
        }
        continue;
      }
      if (teacher.uid === uid || teacher.active !== false || !teacher.hasDirectory) continue;
      if (!deleteDate(teacher.suspendedAt, days)) await repo.markSuspended(teacher.uid);
      else candidates.push(teacher);
    }
    if (!current()) return { deleted };
    const now = await repo.serverNow();
    if (!validTime(now) || !current()) return { deleted };
    // 未来の記録も先に直す。書けなければ、その回は誰も消さない。
    for (const teacher of candidates) {
      if (!current()) return { deleted };
      if (teacher.suspendedAt > now) await repo.markSuspended(teacher.uid);
    }
    for (const teacher of candidates) {
      if (!current()) break;
      if (!isDue(teacher.suspendedAt, now, days)) continue;
      try {
        if (await repo.deleteIfStillSuspended(teacher.uid, teacher.suspendedAt)) deleted += 1;
      } catch { /* 1 人が失敗しても、ほかの先生は続ける */ }
    }
  } catch { /* 通信や規則の失敗は出さず、次に開いたときに試す */ }
  finally { running = false; }
  return { deleted };
}
