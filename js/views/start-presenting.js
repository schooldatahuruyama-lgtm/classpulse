// 「発表を開始」の共通の流れ（編集画面とダッシュボードで使う）。
// 検査 → （移動前の準備）→ 発表中の授業の確認 → 授業を始める。
import { el } from '../ui.js';
import { validateDeck } from '../model.js';
import { startSession } from '../session-host.js';

export const MSG_ACTIVE = '発表中の授業があります。先にその授業を終了してください。';
export const MSG_FAILED = '発表を開始できませんでした。接続を確かめて、もう一度押してください。';
export const MSG_REASONS = '発表を開始できません。次のところを直してください。';
export const MSG_CREATED = '発表は作成済みです。';
export const LABEL_OPEN_CREATED = '発表の画面を開く';
export const MSG_ENDED_PENDING = '前の授業の終了の処理が、最後まで終わっていません。発表の画面を開くと、残りの処理が行われます。';
export const LABEL_FINISH_ENDED = '発表の画面を開いて終わらせる';
export const MSG_UNSAVED = 'この教材には、まだ保存できていない変更があります。通信が戻って保存されてから、もう一度押してください。';

// 画面の ctx から、通信まわりの部品（発表中の確認と授業の開始）を作る
export function sessionDeps(ctx) {
  return {
    getActive: () => ctx.repo.getActive(),
    // 授業の状態（'live' / 'ended'。授業が無ければ null）。pub はログインしていれば読める。
    // 授業の根（sessions/<sid>）は、授業が無いと持ち主でも読めない規則なので読まない
    getSessionState: (sid) => ctx.net.get(`sessions/${sid}/pub/state`),
    clearActive: (sid) => ctx.repo.clearActiveIf(sid),
    startSession: (deckId, deck) => startSession({
      net: ctx.net, repo: ctx.repo, uid: ctx.auth.user.uid, deckId, deck,
      now: () => Date.now(), getRandomValues: (a) => crypto.getRandomValues(a),
    }),
  };
}

// 「発表中」の印が指す授業が、いまも続いているかを確かめる。
// { kind: 'none' }（印が無い。または、指す授業が消えていたので印を外した）
// { kind: 'live', active }（続いている） / { kind: 'ended', active }（終了済みで、後片づけが残っている）
// 終了済みの印はここでは外さない（発表の画面を開くと、残りの後片づけをして印も外す）。
// getSessionState が無ければ、続いているものとして扱う。読めなかったときは例外をそのまま投げる
export async function checkActive({ getActive, getSessionState, clearActive }) {
  const active = await getActive();
  if (!active || !active.sid) return { kind: 'none' };
  if (!getSessionState) return { kind: 'live', active };
  const state = await getSessionState(active.sid);
  if (state === null || state === undefined) {
    if (clearActive) await clearActive(active.sid);
    return { kind: 'none' };
  }
  return { kind: state === 'ended' ? 'ended' : 'live', active };
}

// 作成済みの授業の発表画面へ移る。移れたら true。
// navigate は描き直しが済むと解決する。移れたときは元の画面が片づけられている（isAlive が false）。
// 元の画面が残っていれば移れていない（先生の確認ができず戻された、など）。授業は作り直さず、同じ sid で開き直す
export async function openPresenter({ navigate, sid, isAlive }) {
  try {
    await navigate('present', { sid });
  } catch {
    return false;
  }
  return !isAlive();
}

// 結果は { status: 'started', sid } / { status: 'invalid', reasons } / { status: 'active', sid }
// / { status: 'ended', sid }（前の授業が終了済みで、後片づけが残っている）
// / { status: 'cancelled' }（beforeStart が false、または画面が閉じられた） / { status: 'failed' }
// getDeck: いまの教材を返す関数。待ったあとに必ず呼び直し、最新の教材を検査して始める
// beforeStart: 非同期の関数。教材を保存して待つ（編集画面）。false を返すと中止する。
//   待っている間に教材が変わったら、もう一度呼んでから始める（保存した教材と発表する教材を同じにする）
// getActive / getSessionState(sid) / clearActive(sid) / startSession(deckId, deck): 通信（テストでは差しかえる）
// isAlive: 画面が閉じられていたら false を返す関数
export async function runStartPresenting({ deckId, getDeck, beforeStart, getActive, getSessionState, clearActive, startSession: start, isAlive = () => true }) {
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
    // 印が指す授業が消えていれば、印を外して先へ進む（消えた授業の印で、次の授業が止まらないように）
    const found = await checkActive({ getActive, getSessionState, clearActive });
    if (!isAlive()) return { status: 'cancelled' };
    if (found.kind !== 'none') return { status: found.kind === 'ended' ? 'ended' : 'active', sid: found.active.sid };
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
