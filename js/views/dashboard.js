// 授業ダッシュボード（#/）。教材の一覧、発表中の授業の帯、最近の授業。
// 左のナビゲーションとログアウトは先生の骨組み（main.js）が出す。
import { el, confirmDialog, toast } from '../ui.js';
import { createDeck, newId } from '../model.js';
import { buildDeckFromPages, importMessage } from '../pdf-import-logic.js';
import { formatDateTime } from '../format.js';
import { routeHash } from '../router.js';
import { backgroundSaver, useAuth } from './editor/background.js';
import {
  runStartPresenting, sessionDeps, reasonsNodes, checkActive, openPresenter,
  MSG_ACTIVE, MSG_FAILED, MSG_CREATED, LABEL_OPEN_CREATED, MSG_ENDED_PENDING, LABEL_FINISH_ENDED, MSG_UNSAVED,
} from './start-presenting.js';

const UNTITLED = '無題の教材';
const RECENT_COUNT = 5;

export function mount(root, ctx) {
  let alive = true;
  let busy = false; // 作成・発表開始・削除の最中は、ほかの操作を受けつけない
  let createdSid = null; // 作ったが、まだ発表の画面へ移れていない授業（作り直さず、これを開き直す）
  let opening = false;
  let importing = null; // PDF の取込みの最中なら、その中止用の AbortController
  const message = el('div', { class: 'dash-message' });
  const progressBox = el('div', { class: 'dash-progress', role: 'status', 'aria-live': 'polite' });
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

  const MSG_CREATE_FAILED = '作れませんでした。接続を確かめて、もう一度押してください。';

  async function create() {
    if (busy) return;
    setBusy(true);
    message.replaceChildren();
    try {
      const id = newId();
      await ctx.repo.saveDeck(id, createDeck(UNTITLED, Date.now()), Date.now());
      if (alive) ctx.navigate('editor', { deckId: id });
    } catch {
      if (alive) showMessage(el('p', { text: MSG_CREATE_FAILED }));
    } finally {
      if (alive) setBusy(false);
    }
  }

  // PDF を選ぶ（見えないファイルの入力を使う）
  const pdfInput = el('input', {
    type: 'file', accept: 'application/pdf,.pdf', class: 'dash-pdf-input', tabindex: '-1', 'aria-hidden': 'true',
    onchange: () => {
      const file = pdfInput.files && pdfInput.files[0];
      pdfInput.value = ''; // 同じファイルをもう一度選んでも change が起きるように
      if (file) importFromPdf(file);
    },
  });

  function choosePdf() {
    if (busy) return;
    pdfInput.click();
  }

  // 進みぐあいの表示。ac を渡すと「やめる」を出す（ほかのボタンと違い、取込みの最中も押せる）。
  // ページが進んでも文だけを書きかえる（ボタンを作り直すと、押している最中に消えて押せないことがある）
  let progressText = null;
  let progressAc = null;
  function showProgress(text, ac) {
    if (progressText && progressAc === ac && progressText.isConnected) {
      progressText.textContent = text;
      return;
    }
    progressText = el('span', { class: 'dash-progress-text', text });
    progressAc = ac;
    progressBox.replaceChildren(el('div', { class: 'dash-progress-card' },
      progressText,
      ac ? el('button', { type: 'button', class: 'btn', text: 'やめる', onclick: () => ac.abort() }) : null));
  }

  // PDF から教材を作る。全ページを画像にしてから 1 回で保存する。やめたとき・失敗したときは教材を作らない
  async function importFromPdf(file) {
    if (busy || !alive) return;
    setBusy(true);
    message.replaceChildren();
    const ac = new AbortController();
    importing = ac;
    showProgress('PDF を読みこんでいます…', ac);
    try {
      let result;
      try {
        const { importPdf } = await import('../pdf-import.js');
        if (!alive || ac.signal.aborted) return;
        result = await importPdf(file, {
          signal: ac.signal,
          onProgress: (done, total) => {
            if (alive && !ac.signal.aborted) showProgress(`PDF を読みこんでいます… ${done} / ${total} ページ`, ac);
          },
        });
      } catch (e) {
        if (!alive) return;
        const text = importMessage(e && e.code ? e : { code: 'broken' });
        if (text) showMessage(el('p', { text }));
        else showMessage(el('p', { text: 'PDF の取込みをやめました。教材は作っていません。' }));
        return;
      }
      if (!alive || ac.signal.aborted) return;
      // ここからは保存。やめられない（保存は 1 回で、途中まで残ることはない）
      importing = null;
      showProgress('教材を保存しています…', null);
      const id = newId();
      const now = Date.now();
      try {
        await ctx.repo.saveDeck(id, buildDeckFromPages(result.title, result.pages, now), now);
        if (alive) ctx.navigate('editor', { deckId: id });
      } catch {
        if (alive) showMessage(el('p', { text: MSG_CREATE_FAILED }));
      }
    } finally {
      if (importing === ac) importing = null;
      if (alive) {
        progressBox.replaceChildren();
        setBusy(false);
      }
    }
  }

  // 作成済みの授業の発表画面へ移る。移れなかったら（通信できないなど）、同じ授業を開き直すボタンを出す。
  // 授業はもう作ってあるので、作り直さない
  async function openCreated(sid) {
    if (opening || !alive) return;
    opening = true;
    createdSid = sid;
    try {
      const moved = await openPresenter({ navigate: ctx.navigate, sid, isAlive: () => alive });
      if (moved || !alive) return;
      showMessage(el('p', { text: MSG_CREATED }),
        el('button', { type: 'button', class: 'btn btn-primary', text: LABEL_OPEN_CREATED, onclick: () => openCreated(sid) }));
    } finally {
      opening = false;
    }
  }

  async function startPresent(d) {
    if (busy) return;
    setBusy(true);
    message.replaceChildren();
    try {
      // 前に作った授業へまだ移れていなければ、新しく作らずにそれを開く
      if (createdSid) { await openCreated(createdSid); return; }
      // 編集画面を離れたあとの保存が済むのを待つ（保存の前の古い教材で、授業の写しを作らないように）
      useAuth(ctx.auth);
      const saved = await backgroundSaver().whenIdle(ctx.auth.user.uid, d.id);
      if (!alive) return;
      if (!saved) { showMessage(el('p', { text: MSG_UNSAVED })); return; }
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
      if (r.status === 'started') await openCreated(r.sid);
      else if (r.status === 'invalid') showMessage(...reasonsNodes(r.reasons));
      else if (r.status === 'active') {
        showMessage(el('p', { text: MSG_ACTIVE }),
          el('button', { type: 'button', class: 'btn btn-primary', text: '発表中の授業へ', onclick: () => ctx.navigate('present', { sid: r.sid }) }));
      } else if (r.status === 'ended') {
        showMessage(el('p', { text: MSG_ENDED_PENDING }),
          el('button', { type: 'button', class: 'btn btn-primary', text: LABEL_FINISH_ENDED, onclick: () => ctx.navigate('present', { sid: r.sid }) }));
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
    // 作成・取込みなどの最中に一覧を描き直しても、押せない状態のままにする
    const act = (label, onclick, cls = 'btn') => el('button', { type: 'button', class: cls, text: label, 'data-dash-action': '', disabled: busy, onclick });
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

  // ended: 授業は終了済みで、後片づけが残っている（発表の画面を開くと、残りの処理が行われる）
  function renderActive(active, ended = false) {
    if (!(active && active.sid)) { activeBox.replaceChildren(); return; }
    const label = ended ? '終了の処理が終わっていない授業' : '発表中の授業';
    activeBox.replaceChildren(el('div', { class: 'dash-active-card', role: 'region', 'aria-label': label },
      el('div', {},
        el('strong', { text: ended ? '終了の処理が終わっていない授業があります' : '発表中の授業があります' }),
        active.startedAt ? el('span', { class: 'small', text: ` （${formatDateTime(active.startedAt)} 開始）` }) : null),
      el('a', { class: 'btn btn-primary', href: routeHash('present', { sid: active.sid }), text: ended ? LABEL_FINISH_ENDED : '発表に戻る' })));
  }

  // 「発表中」の印が指す授業が、いまも続いているかを確かめる（帯を出す前に。あとから帯が入ると、ボタンの位置がずれる）。
  // 授業が消えていれば印を外して帯を出さない。確かめられないときは、発表中として出す
  async function findActive(active) {
    if (!(active && active.sid)) return { kind: 'none' };
    try {
      return await checkActive({ ...sessionDeps(ctx), getActive: async () => active });
    } catch {
      return { kind: 'live', active };
    }
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
      const found = await findActive(active);
      if (!alive) return;
      if (found.kind === 'none') renderActive(null);
      else renderActive(found.active, found.kind === 'ended');
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
      el('div', { class: 'dash-create-actions' },
        el('button', { type: 'button', class: 'btn btn-primary dash-create', text: '＋ 新規作成', 'data-dash-action': '', onclick: create }),
        el('button', { type: 'button', class: 'btn dash-create', text: 'PDF から作る', 'data-dash-action': '', onclick: choosePdf }),
        pdfInput)),
    activeBox, progressBox, message,
    el('div', { class: 'dash-body' }, decksBox, recentBox)));
  decksBox.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' }));
  load();
  return () => {
    alive = false;
    if (importing) importing.abort(); // 画面を離れたら取込みをやめる（教材は作らない）
  };
}
