// ゴミ箱（#/trash）。ゴミ箱に移した教材の一覧。元に戻す・完全に削除・空にする。
// 入れてから決まった日数がたった教材は、この画面か授業ダッシュボードを開いたときに完全に削除する。
import { el, confirmDialog, closeAllDialogs, toast } from '../ui.js';
import { CONFIG } from '../config.js';
import { daysLeft } from '../trash.js';
import { backgroundSaver, useAuth } from './editor/background.js';

const UNTITLED = '無題の教材';
const RETRY = '接続を確かめて、もう一度押してください。';

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 「スライド n 枚 ・ 〇年〇月〇日 にゴミ箱へ ・ あと n 日で完全に削除」
export function trashMeta(d, now) {
  const left = daysLeft(d.deletedAt, now);
  return [
    `スライド ${d.slideCount} 枚`,
    d.deletedAt === null ? null : `${formatDate(d.deletedAt)} にゴミ箱へ`,
    left > 0 ? `あと ${left} 日で完全に削除` : 'まもなく完全に削除',
  ].filter(Boolean).join(' ・ ');
}

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const uid = ctx.auth.user.uid;
  useAuth(ctx.auth);
  const bg = backgroundSaver();

  const message = el('div', { class: 'trash-message' });
  const listBox = el('div', { class: 'trash-list-box' });
  const emptyButton = el('button', {
    type: 'button', class: 'btn trash-danger', text: 'ゴミ箱を空にする', 'data-trash-action': '', hidden: true,
    onclick: () => emptyAll(),
  });
  let shown = []; // 今、画面に出している教材

  function setBusy(v) {
    busy = v;
    root.querySelectorAll('button[data-trash-action]').forEach((b) => { b.disabled = v; });
  }

  function showError(text) {
    message.replaceChildren(el('div', { class: 'notice', role: 'alert' }, el('p', { text })));
  }

  // 1 つの操作。終わったら一覧を読み直す
  async function run(action, doneText, failText) {
    if (busy || !alive) return;
    setBusy(true);
    message.replaceChildren();
    try {
      await action();
      if (!alive) return;
      toast(doneText);
      await load();
    } catch {
      if (alive) showError(`${failText}${RETRY}`);
    } finally {
      if (alive) setBusy(false);
    }
  }

  function restore(d) {
    return run(async () => {
      await ctx.repo.restoreDeck(d.id);
      bg.undelete(uid, d.id); // このタブでゴミ箱に移した教材を、また開けるようにする
    }, '元に戻しました。', '元に戻せませんでした。');
  }

  async function purge(d) {
    if (busy) return;
    const ok = await confirmDialog({
      title: 'この教材を完全に削除しますか？',
      body: `「${d.title || UNTITLED}」を完全に削除します。元に戻せません。授業の記録は残ります。`,
      okLabel: '完全に削除', danger: true,
    });
    if (!ok || !alive) return;
    // 編集画面を離れたあとの保存と、1 つの手続きで削除する
    await run(() => bg.deleting(uid, d.id, () => ctx.repo.deleteDeck(d.id)), '完全に削除しました。', '削除できませんでした。');
  }

  async function emptyAll() {
    if (busy || !shown.length) return;
    const ok = await confirmDialog({
      title: 'ゴミ箱を空にしますか？',
      body: `ゴミ箱の教材 ${shown.length} 個を完全に削除します。元に戻せません。`,
      okLabel: '空にする', danger: true,
    });
    if (!ok || !alive) return;
    await run(() => ctx.repo.emptyTrash(), 'ゴミ箱を空にしました。', '空にできませんでした。');
  }

  function card(d, now) {
    const act = (label, onclick, cls) => el('button', { type: 'button', class: cls, text: label, 'data-trash-action': '', disabled: busy, onclick });
    return el('li', { class: 'trash-item card' },
      el('h2', { class: 'trash-item-title', text: d.title || UNTITLED }),
      el('p', { class: 'muted trash-item-meta', text: trashMeta(d, now) }),
      el('div', { class: 'trash-item-actions' },
        act('元に戻す', () => restore(d), 'btn btn-primary'),
        act('完全に削除', () => purge(d), 'btn trash-danger')));
  }

  function render(items) {
    shown = items;
    emptyButton.hidden = !items.length;
    const now = Date.now();
    listBox.replaceChildren(items.length
      ? el('ul', { class: 'trash-list' }, items.map((d) => card(d, now)))
      : el('p', { class: 'card trash-empty', text: 'ゴミ箱は空です。' }));
  }

  function renderFailure() {
    shown = [];
    emptyButton.hidden = true;
    listBox.replaceChildren(el('div', { class: 'notice', role: 'alert' },
      el('p', { text: '読みこめませんでした。' }),
      el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度', onclick: () => { loading(); load(); } })));
  }

  function loading() {
    listBox.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' }));
  }

  async function load() {
    // 日数がたった教材を先に消す（失敗しても画面には出さない。次に開いたときにやり直す）
    try { await ctx.repo.purgeExpiredTrash(Date.now()); } catch { /* 次の機会に */ }
    try {
      const items = await ctx.repo.listTrash();
      if (alive) render(items);
    } catch {
      if (alive) renderFailure();
    }
  }

  root.replaceChildren(el('div', { class: 'trash' },
    el('div', { class: 'trash-head' },
      el('div', {},
        el('h1', { class: 'trash-h1', text: 'ゴミ箱' }),
        el('p', { class: 'muted', text: `ゴミ箱に入れてから ${CONFIG.trash.keepDays} 日たった教材は、自動で完全に削除されます。` })),
      emptyButton),
    message, listBox));
  loading();
  load();
  return () => { alive = false; closeAllDialogs(); };
}
