// 「発表を開始」の共通の流れ（編集画面とダッシュボードで使う）。
// 検査 → （移動前の準備）→ 発表中の授業の確認 → 授業を始める。
import { el } from '../ui.js';
import { validateDeck } from '../model.js';
import { startSession } from '../session-host.js';

export const MSG_ACTIVE = '発表中の授業があります。先にその授業を終了してください。';
export const MSG_FAILED = '発表を開始できませんでした。接続を確かめて、もう一度押してください。';
export const MSG_REASONS = '発表を開始できません。次のところを直してください。';

// 画面の ctx から、通信まわりの部品（発表中の確認と授業の開始）を作る
export function sessionDeps(ctx) {
  return {
    getActive: () => ctx.repo.getActive(),
    startSession: (deckId, deck) => startSession({
      net: ctx.net, repo: ctx.repo, uid: ctx.auth.user.uid, deckId, deck,
      now: () => Date.now(), getRandomValues: (a) => crypto.getRandomValues(a),
    }),
  };
}

// 結果は { status: 'started', sid } / { status: 'invalid', reasons } / { status: 'active', sid }
// / { status: 'cancelled' }（beforeStart が false、または画面が閉じられた） / { status: 'failed' }
// getDeck: いまの教材を返す関数。待ったあとに必ず呼び直し、最新の教材を検査して始める
// beforeStart: 非同期の関数。教材を保存して待つ（編集画面）。false を返すと中止する。
//   待っている間に教材が変わったら、もう一度呼んでから始める（保存した教材と発表する教材を同じにする）
// getActive / startSession(deckId, deck): 通信（テストでは差しかえる）
// isAlive: 画面が閉じられていたら false を返す関数
export async function runStartPresenting({ deckId, getDeck, beforeStart, getActive, startSession: start, isAlive = () => true }) {
  // 検査して、保存を待つ。教材が変わっていたら、安定するまで繰り返す
  async function settle() {
    let flushed = null;
    for (let i = 0; i < 5; i++) {
      const deck = getDeck();
      const reasons = validateDeck(deck);
      if (reasons.length) return { result: { status: 'invalid', reasons } };
      if (!beforeStart || deck === flushed) return { deck };
      flushed = deck;
      if (!(await beforeStart()) || !isAlive()) return { result: { status: 'cancelled' } };
    }
    return { result: { status: 'failed' } };
  }

  try {
    let step = await settle();
    if (step.result) return step.result;
    const active = await getActive();
    if (!isAlive()) return { status: 'cancelled' };
    if (active && active.sid) return { status: 'active', sid: active.sid };
    step = await settle(); // getActive を待つ間の編集も含める
    if (step.result) return step.result;
    if (!isAlive()) return { status: 'cancelled' };
    const sid = await start(deckId, step.deck);
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
