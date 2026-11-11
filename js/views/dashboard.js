// 授業ダッシュボード（#/）。教材の一覧、発表中の授業の帯、最近の授業。
// 左のナビゲーションとログアウトは先生の骨組み（main.js）が出す。
import { el, confirmDialog, toast } from '../ui.js';
import { createDeck, newId } from '../model.js';
import { formatDateTime } from '../format.js';
import { routeHash } from '../router.js';
import { backgroundSaver, useAuth } from './editor/background.js';
import { runStartPresenting, sessionDeps, reasonsNodes, MSG_ACTIVE, MSG_FAILED } from './start-presenting.js';

const UNTITLED = '無題の教材';
const RECENT_COUNT = 5;

export function mount(root, ctx) {
  let alive = true;
  let busy = false; // 作成・発表開始・削除の最中は、ほかの操作を受けつけない
  const message = el('div', { class: 'dash-message' });
  const activeBox = el('div', { class: 'dash-active' });
  const decksBox = el('div', { class: 'dash-decks' });
  const recentBox = el('section', { class: 'dash-recent card', 'aria-labelledby': 'dash-recent-title' });
  const email = ctx.auth && ctx.auth.user && ctx.auth.user.email;

  function showMessage(...children) {
    message.replaceChildren(el('div', { class: 'notice', role: 'alert' }, ...children));
  }

  function setBusy(v) {
    busy = v;
    root.querySelectorAll('button[data-dash-action]').forEach((b) => { b.disabled = v; });
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    message.replaceChildren();
    try {
      const id = newId();
      await ctx.repo.saveDeck(id, createDeck(UNTITLED, Date.now()), Date.now());
      if (alive) ctx.navigate('editor', { deckId: id });
    } catch {
      if (alive) showMessage(el('p', { text: '作れませんでした。接続を確かめて、もう一度押してください。' }));
    } finally {
      if (alive) setBusy(false);
    }
  }

  async function startPresent(d) {
    if (busy) return;
    setBusy(true);
    message.replaceChildren();
    try {
      let deck;
      try {
        deck = await ctx.repo.loadDeck(d.id);
      } catch {
        if (alive) showMessage(el('p', { text: MSG_FAILED }));
        return;
      }
      if (!alive) return;
      if (!deck) { showMessage(el('p', { text: 'この教材が見つかりません。' })); return; }
      const r = await runStartPresenting({ ...sessionDeps(ctx), deckId: d.id, getDeck: () => deck, isAlive: () => alive });
      if (!alive) return;
      if (r.status === 'started') ctx.navigate('present', { sid: r.sid });
      else if (r.status === 'invalid') showMessage(...reasonsNodes(r.reasons));
      else if (r.status === 'active') {
        showMessage(el('p', { text: MSG_ACTIVE }),
          el('button', { type: 'button', class: 'btn btn-primary', text: '発表中の授業へ', onclick: () => ctx.navigate('present', { sid: r.sid }) }));
      } else if (r.status === 'failed') showMessage(el('p', { text: MSG_FAILED }));
    } finally {
      if (alive) setBusy(false);
    }
  }

  async function remove(d) {
    if (busy) return;
    const title = d.title || UNTITLED;
    const ok = await confirmDialog({
      title: 'この教材を削除しますか？',
      body: `「${title}」を削除します。元に戻せません。授業の記録は残ります。`,
      okLabel: '削除する', danger: true,
    });
    if (!ok || !alive) return;
    setBusy(true);
    message.replaceChildren();
    try {
      // 編集画面を離れたあとの保存と、1 つの手続きで削除する（成功したら保存待ちを捨て、失敗したら戻す）
      useAuth(ctx.auth);
      await backgroundSaver().deleting(ctx.auth.user.uid, d.id, () => ctx.repo.deleteDeck(d.id));
      if (!alive) return;
      toast('削除しました。');
      await load();
    } catch {
      if (alive) showMessage(el('p', { text: '削除できませんでした。接続を確かめて、もう一度押してください。' }));
    } finally {
      if (alive) setBusy(false);
    }
  }

  function deckCard(d) {
    const act = (label, onclick, cls = 'btn') => el('button', { type: 'button', class: cls, text: label, 'data-dash-action': '', onclick });
    const title = d.title || UNTITLED;
    return el('li', { class: 'dash-deck card' },
      el('h3', { class: 'dash-deck-title', text: title }),
      el('p', { class: 'dash-deck-meta muted', text: `スライド ${d.slideCount} 枚 ・ 最終更新 ${formatDateTime(d.updatedAt)}` }),
      el('div', { class: 'dash-deck-actions' },
        act('編集', () => ctx.navigate('editor', { deckId: d.id })),
        act('発表を開始', () => startPresent(d), 'btn btn-primary'),
        act('結果を見る', () => ctx.navigate('history')),
        act('削除', () => remove(d), 'btn dash-delete')));
  }

  function renderActive(active) {
    if (!(active && active.sid)) { activeBox.replaceChildren(); return; }
    activeBox.replaceChildren(el('div', { class: 'dash-active-card', role: 'region', 'aria-label': '発表中の授業' },
      el('div', {},
        el('strong', { text: '発表中の授業があります' }),
        active.startedAt ? el('span', { class: 'small', text: ` （${formatDateTime(active.startedAt)} 開始）` }) : null),
      el('a', { class: 'btn btn-primary', href: routeHash('present', { sid: active.sid }), text: '発表に戻る' })));
  }

  function renderDecks(decks) {
    if (!decks.length) {
      decksBox.replaceChildren(el('p', { class: 'dash-empty card', text: 'まだ教材がありません。「＋ 新規作成」から作れます。' }));
      return;
    }
    decksBox.replaceChildren(el('ul', { class: 'dash-deck-list' }, decks.map(deckCard)));
  }

  function renderRecent(history) {
    const items = history.slice(0, RECENT_COUNT);
    recentBox.replaceChildren(
      el('h2', { id: 'dash-recent-title', class: 'dash-h2', text: '最近の授業' }),
      items.length
        ? el('ul', { class: 'dash-recent-list' }, items.map((h) => el('li', {},
          el('a', { class: 'dash-recent-link', href: routeHash('result', { sid: h.sid }) },
            el('span', { class: 'dash-recent-title', text: h.title || UNTITLED }),
            el('span', { class: 'small muted', text: `${formatDateTime(h.endedAt)} ・ 参加 ${h.participants} 人` })))))
        : el('p', { class: 'muted', text: 'まだ授業の記録がありません。' }));
  }

  function renderFailure() {
    activeBox.replaceChildren();
    recentBox.replaceChildren();
    decksBox.replaceChildren(el('div', { class: 'notice', role: 'alert' },
      el('p', { text: '読みこめませんでした。' }),
      el('button', {
        type: 'button', class: 'btn btn-primary', text: 'もう一度',
        onclick: () => { decksBox.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' })); load(); },
      })));
  }

  async function load() {
    try {
      const [decks, active, history] = await Promise.all([ctx.repo.listDecks(), ctx.repo.getActive(), ctx.repo.listHistory()]);
      if (!alive) return;
      renderActive(active);
      renderDecks(decks);
      renderRecent(history);
    } catch {
      if (alive) renderFailure();
    }
  }

  root.replaceChildren(el('div', { class: 'dash' },
    el('div', { class: 'dash-head' },
      el('div', {},
        el('h1', { class: 'dash-h1', text: '教材' }),
        email ? el('p', { class: 'small muted', text: `ログイン中: ${email}` }) : null),
      el('button', { type: 'button', class: 'btn btn-primary dash-create', text: '＋ 新規作成', 'data-dash-action': '', onclick: create })),
    activeBox, message,
    el('div', { class: 'dash-body' }, decksBox, recentBox)));
  decksBox.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' }));
  load();
  return () => { alive = false; };
}
