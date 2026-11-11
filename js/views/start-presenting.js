// 「発表を開始」の共通の流れ（編集画面とダッシュボードで使う）。
// 検査 → （移動前の準備）→ 発表中の授業の確認 → 授業を始める。
import { el } from '../ui.js';
import { validateDeck } from '../model.js';
import { startSession } from '../session-host.js';

export const MSG_ACTIVE = '発表中の授業があります。先にその授業を終了してください。';
export const MSG_FAILED = '発表を開始できませんでした。接続を確かめて、もう一度押してください。';
export const MSG_REASONS = '発表を開始できません。次のところを直してください。';

// 結果は { status: 'started', sid } / { status: 'invalid', reasons } / { status: 'active', sid }
// / { status: 'cancelled' }（beforeStart が false） / { status: 'failed' }
// beforeStart: 検査のあとに呼ぶ非同期の関数。false を返すと中止する（編集画面の保存待ちなど）
// isAlive: 画面が閉じられていたら false を返す関数（閉じたあとは何も始めない）
export async function runStartPresenting({ ctx, deckId, deck, beforeStart, isAlive = () => true }) {
  try {
    const reasons = validateDeck(deck);
    if (reasons.length) return { status: 'invalid', reasons };
    if (beforeStart && !(await beforeStart())) return { status: 'cancelled' };
    const active = await ctx.repo.getActive();
    if (!isAlive()) return { status: 'cancelled' };
    if (active && active.sid) return { status: 'active', sid: active.sid };
    const sid = await startSession({
      net: ctx.net, repo: ctx.repo, uid: ctx.auth.user.uid, deckId, deck,
      now: () => Date.now(), getRandomValues: (a) => crypto.getRandomValues(a),
    });
    return { status: 'started', sid };
  } catch (e) {
    if (e && Array.isArray(e.reasons)) return { status: 'invalid', reasons: e.reasons };
    return { status: 'failed' };
  }
}

// 理由の一覧（見出し + 箇条書き）の DOM
export function reasonsNodes(reasons) {
  return [
    el('p', { class: 'ed-message-title', text: MSG_REASONS }),
    el('ul', {}, reasons.map((r) => el('li', { text: r }))),
  ];
}
