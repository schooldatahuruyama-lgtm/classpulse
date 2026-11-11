// スライド編集の画面（#/edit/<deckId>）。上の帯・左の列（スライド一覧）・中央（キャンバス）・右の列（設定）。
// 教材は model.js の関数で新しい値に置きかえ、変更のたびに自動保存へ渡す（その場で書きかえない）。
import { el, confirmDialog, statusChip } from '../ui.js';
import { CONFIG } from '../config.js';
import {
  newId, createSlide, createTextItem, addSlide, removeSlide, moveSlide, duplicateSlide,
  updateSlide, deckImageBytes,
} from '../model.js';
import { createAutosaver } from '../autosave.js';
import { runStartPresenting, reasonsNodes, MSG_ACTIVE, MSG_FAILED } from './start-presenting.js';
import { compressImage, dataUrlBytes } from '../image.js';
import { mountCanvas } from './editor/canvas.js';
import { renderSlideList, updateThumb, addButtons } from './editor/slide-list.js';
import { renderItemInspector, renderPollSettings, renderPollForm } from './editor/inspector.js';

const UNTITLED = '無題の教材';
const LEAVE_TITLE = '保存できていない変更があります。このまま移動しますか？';
const IMAGE_TOO_BIG = '画像の合計が 5MB を超えるため、追加できません。ほかの画像を減らしてください。';
const THUMB_DELAY_MS = 250;

// 保存する形（教材名が空なら「無題の教材」）
function forSave(deck) {
  return { ...deck, title: String(deck.title || '').trim() === '' ? UNTITLED : deck.title };
}

// どのスライドからも使われていない画像を外す
function pruneImages(deck) {
  const used = new Set();
  for (const s of Object.values(deck.slides)) {
    for (const it of (s && s.items) || []) if (it && it.kind === 'image') used.add(it.imageId);
  }
  const images = {};
  for (const [k, v] of Object.entries(deck.images || {})) if (used.has(k)) images[k] = v;
  return { ...deck, images };
}

// データ URL の画像の大きさ（px）
function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => resolve({ width: 4, height: 3 });
    img.src = url;
  });
}

// 16:9 のキャンバスで縦横比を保つ、画像の要素の置き場所
function imageGeometry({ width, height }) {
  const ratio = (height / width) * (16 / 9); // キャンバスの割合での 高さ / 幅
  let w = 0.4;
  let h = w * ratio;
  if (h > 0.8) { h = 0.8; w = h / ratio; }
  w = Math.max(0.05, Math.min(1, w));
  h = Math.max(0.05, Math.min(1, h));
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function simplePage(root, title, text, button) {
  root.replaceChildren(el('div', { class: 'page-pad' },
    el('h2', { text: title }),
    text ? el('p', { role: 'alert', text }) : null,
    el('p', {}, button)));
}

export function mount(root, ctx) {
  const deckId = ctx.params.deckId;
  let alive = true;
  let stopEditor = null;

  async function load() {
    root.replaceChildren(el('p', { class: 'loading', role: 'status', text: '読み込み中…' }));
    let deck;
    try {
      deck = await ctx.repo.loadDeck(deckId);
    } catch {
      if (!alive) return;
      simplePage(root, '読み込めませんでした', '通信できませんでした。接続を確かめてください。',
        el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度読み込む', onclick: load }));
      return;
    }
    if (!alive) return;
    if (!deck) {
      simplePage(root, 'スライド編集', 'この教材は見つかりません。',
        el('button', { type: 'button', class: 'btn btn-primary', text: '一覧へ戻る', onclick: () => ctx.navigate('dashboard') }));
      return;
    }
    stopEditor = startEditor(root, ctx, deckId, deck);
  }

  load();
  return () => {
    alive = false;
    if (stopEditor) stopEditor();
  };
}

function startEditor(root, ctx, deckId, initialDeck) {
  let alive = true;
  let saveState = 'saved';
  let leaving = false;
  let starting = false;
  let canvas = null;
  let thumbTimer = null;

  const state = {
    deck: initialDeck,
    slideId: initialDeck.order[0] ?? null,
    itemId: null,
    editingId: null,
  };

  // ---- 自動保存 ----
  const saveBox = el('div', { class: 'ed-save', 'aria-live': 'polite' });
  const autosaver = createAutosaver({
    save: (deck) => ctx.repo.saveDeck(deckId, forSave(deck), Date.now()),
    delayMs: CONFIG.autosaveDelayMs,
    maxWaitMs: CONFIG.autosaveMaxWaitMs,
    retryMs: CONFIG.autosaveRetryMs,
    onState: (s) => { saveState = s; renderSaveState(); },
    // 画面を離れたあとは再試行しない（次に開いた編集画面の保存と食い違わないように）
    setTimeout: (fn, ms) => window.setTimeout(() => { if (alive) fn(); }, ms),
    clearTimeout: (t) => window.clearTimeout(t),
  });

  function renderSaveState() {
    if (saveState === 'saving') saveBox.replaceChildren(statusChip('info', '保存中…'));
    else if (saveState === 'failed') {
      saveBox.replaceChildren(statusChip('danger', '保存できませんでした'),
        el('button', { type: 'button', class: 'btn', text: 'もう一度保存', onclick: () => autosaver.retry() }));
    } else saveBox.replaceChildren(statusChip('ok', '保存済み'));
  }

  // ---- 画面の骨組み ----
  const titleInput = el('input', {
    type: 'text', class: 'ed-title', 'aria-label': '教材名', placeholder: UNTITLED, value: state.deck.title,
    oninput: () => change({ ...state.deck, title: titleInput.value }),
  });
  const presentBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '発表を開始', onclick: () => startPresent() });
  const messages = el('div', { class: 'ed-messages', role: 'alert' });
  const left = el('aside', { id: 'ed-left', class: 'ed-left', 'aria-label': 'スライド一覧' });
  const center = el('section', { class: 'ed-center', 'aria-label': '編集' });
  const right = el('aside', { id: 'ed-right', class: 'ed-right', 'aria-label': '設定' });

  function panelToggle(label, panel) {
    const btn = el('button', {
      type: 'button', class: 'btn ed-toggle', text: label, 'aria-controls': panel.id, 'aria-expanded': 'false',
      onclick: () => {
        const open = !panel.classList.contains('is-open');
        panel.classList.toggle('is-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? `${label}を閉じる` : label;
      },
    });
    return btn;
  }

  const top = el('header', { class: 'ed-top' },
    el('button', { type: 'button', class: 'btn', text: '← 一覧へ', onclick: () => goTo('dashboard') }),
    titleInput,
    saveBox,
    el('div', { class: 'ed-top-actions' },
      panelToggle('スライド一覧', left),
      panelToggle('設定', right),
      presentBtn));

  root.replaceChildren(el('div', { class: 'editor' }, top, messages, el('div', { class: 'ed-body' }, left, center, right)));
  renderSaveState();

  // ---- 描き直し ----
  const currentSlide = () => (state.slideId ? state.deck.slides[state.slideId] || null : null);

  function renderList() { renderSlideList(left, ed); }

  function renderCenter() {
    canvas = null;
    const slide = currentSlide();
    if (!slide) {
      center.replaceChildren(el('div', { class: 'ed-empty card' },
        el('p', { text: 'スライドがありません。「＋ 資料スライド」か「＋ アンケート」で追加してください。' }),
        addButtons(ed)));
    } else if (slide.type === 'poll') {
      renderPollForm(center, ed);
    } else {
      canvas = mountCanvas(center, ed);
    }
  }

  // 右の列。押したボタンのフォーカスを、描き直したあとも同じボタンに戻す
  function renderSide() {
    const key = document.activeElement && right.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const slide = currentSlide();
    if (!slide) right.replaceChildren(el('h2', { class: 'ed-col-title', text: '設定' }), el('p', { class: 'muted', text: 'スライドを選ぶと、ここで設定できます。' }));
    else if (slide.type === 'poll') renderPollSettings(right, ed);
    else renderItemInspector(right, ed);
    if (key) [...right.querySelectorAll('[data-focus-key]')].find((b) => b.dataset.focusKey === key)?.focus();
  }

  function scheduleThumb(slideId) {
    if (thumbTimer !== null) window.clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(() => {
      thumbTimer = null;
      if (alive && state.deck.slides[slideId]) updateThumb(left, ed, slideId);
    }, THUMB_DELAY_MS);
  }

  // 教材を新しい値にして自動保存へ渡す。parts で描き直す所を選ぶ
  function change(next, parts = {}) {
    state.deck = next;
    autosaver.touch(next);
    if (parts.list) renderList();
    else if (parts.thumb && state.slideId) scheduleThumb(state.slideId);
    if (parts.center) renderCenter();
    if (parts.side) renderSide();
  }

  // ---- 編集の操作（左・中央・右の部品から呼ぶ） ----
  const ed = {
    state,
    currentSlide,

    selectSlide(id) {
      if (canvas) canvas.finishEdit();
      state.slideId = id;
      state.itemId = null;
      state.editingId = null;
      renderList();
      renderCenter();
      renderSide();
    },

    addSlide(type) {
      const id = newId();
      const after = state.slideId ?? undefined;
      state.slideId = id;
      state.itemId = null;
      state.editingId = null;
      change(addSlide(state.deck, createSlide(type), id, after), { list: true, center: true, side: true });
    },

    moveSlide(delta) {
      if (!state.slideId) return;
      change(moveSlide(state.deck, state.slideId, delta), { list: true });
      // 押したボタンにフォーカスを戻す（端まで来て押せなくなったら、スライドへ）
      const btn = left.querySelector(`[data-focus-key="${delta < 0 ? 'up' : 'down'}"]`);
      (btn && !btn.disabled ? btn : left.querySelector('[aria-current="true"]'))?.focus();
    },

    duplicateSlide() {
      if (!state.slideId) return;
      const id = newId();
      const next = duplicateSlide(state.deck, state.slideId, id, () => newId());
      state.slideId = id;
      state.itemId = null;
      state.editingId = null;
      change(next, { list: true, center: true, side: true });
    },

    async deleteSlide() {
      const id = state.slideId;
      if (!id) return;
      const ok = await confirmDialog({
        title: 'このスライドを削除しますか？', body: '削除したスライドは元に戻せません。', okLabel: '削除', danger: true,
      });
      if (!ok || !alive || !state.deck.slides[id]) return;
      const at = state.deck.order.indexOf(id);
      const next = removeSlide(state.deck, id);
      state.slideId = next.order[Math.min(at, next.order.length - 1)] ?? null;
      state.itemId = null;
      state.editingId = null;
      change(next, { list: true, center: true, side: true });
    },

    selectItem(id) {
      state.itemId = id;
      renderSide();
    },

    // 今のスライドの要素を 1 つ置きかえる
    updateItem(item, { refresh = false, side = false } = {}) {
      const slide = currentSlide();
      if (!slide || !Array.isArray(slide.items)) return;
      const items = slide.items.map((it) => (it.id === item.id ? item : it));
      change(updateSlide(state.deck, state.slideId, { ...slide, items }), { thumb: true, side });
      if (refresh && canvas) canvas.refreshItem(item.id);
    },

    removeItem(id) {
      const slide = currentSlide();
      if (!slide || !Array.isArray(slide.items)) return;
      state.itemId = null;
      state.editingId = null;
      const next = updateSlide(state.deck, state.slideId, { ...slide, items: slide.items.filter((it) => it.id !== id) });
      change(pruneImages(next), { thumb: true, center: true, side: true });
    },

    addText() {
      const slide = currentSlide();
      if (!slide || slide.type !== 'content') return;
      if (canvas) canvas.finishEdit();
      const item = createTextItem(newId());
      state.itemId = item.id;
      state.editingId = item.id; // 足したらすぐ入力できるように
      change(updateSlide(state.deck, state.slideId, { ...slide, items: [...slide.items, item] }), { thumb: true, center: true, side: true });
    },

    // 画像を縮めて足す。足せなかったときは画面に出す文を返す
    async addImage(file) {
      const slideId = state.slideId;
      let url;
      try {
        url = await compressImage(file, { maxEdge: CONFIG.image.maxEdge, maxBytes: CONFIG.image.maxBytes });
      } catch {
        return '画像を読み込めませんでした。別の画像を選んでください。';
      }
      if (!alive) return null;
      if (deckImageBytes(state.deck) + dataUrlBytes(url) > CONFIG.image.deckMaxBytes) return IMAGE_TOO_BIG;
      const size = await imageSize(url);
      const slide = state.deck.slides[slideId];
      if (!alive || !slide || slide.type !== 'content') return null; // 縮めている間にスライドが消えた
      const imageId = newId();
      const item = { id: newId(), kind: 'image', ...imageGeometry(size), imageId };
      let next = { ...state.deck, images: { ...state.deck.images, [imageId]: url } };
      next = updateSlide(next, slideId, { ...slide, items: [...slide.items, item] });
      if (canvas) canvas.finishEdit();
      if (state.slideId === slideId) { state.itemId = item.id; state.editingId = null; }
      change(next, { list: state.slideId !== slideId, thumb: true, center: state.slideId === slideId, side: state.slideId === slideId });
      return null;
    },

    // アンケートの一部を変える（入力欄はそのまま。縮小表示だけ描き直す）
    patchSlide(patch) {
      const slide = currentSlide();
      if (!slide) return;
      change(updateSlide(state.deck, state.slideId, { ...slide, ...patch }), { thumb: true });
    },
  };

  // ---- 画面を離れる・発表を開始 ----
  function showMessage(...children) {
    messages.replaceChildren(el('div', { class: 'ed-message card' }, ...children,
      el('button', { type: 'button', class: 'btn', text: '閉じる', onclick: () => messages.replaceChildren() })));
  }

  // 保存を待ち、失敗していれば確かめる。移ってよければ true
  async function readyToLeave() {
    if (canvas) canvas.finishEdit();
    await autosaver.flush();
    if (!alive) return false;
    if (saveState !== 'failed') return true;
    return confirmDialog({ title: LEAVE_TITLE, body: '移動すると、保存できていない変更は失われます。', okLabel: '移動する', danger: true });
  }

  async function goTo(name, params) {
    if (leaving) return;
    leaving = true;
    try {
      if (await readyToLeave() && alive) ctx.navigate(name, params);
    } finally {
      leaving = false;
    }
  }

  async function startPresent() {
    if (starting) return;
    starting = true;
    presentBtn.disabled = true;
    presentBtn.textContent = '準備しています…';
    messages.replaceChildren();
    try {
      const r = await runStartPresenting({
        ctx, deckId, deck: forSave(state.deck), beforeStart: readyToLeave, isAlive: () => alive,
      });
      if (!alive) return;
      if (r.status === 'invalid') showReasons(r.reasons);
      else if (r.status === 'active') {
        showMessage(el('p', { text: MSG_ACTIVE }),
          el('button', { type: 'button', class: 'btn btn-primary', text: '発表中の授業へ', onclick: () => goTo('present', { sid: r.sid }) }));
      } else if (r.status === 'failed') showMessage(el('p', { text: MSG_FAILED }));
      else if (r.status === 'started') ctx.navigate('present', { sid: r.sid });
    } finally {
      starting = false;
      presentBtn.disabled = false;
      presentBtn.textContent = '発表を開始';
    }
  }

  function showReasons(reasons) {
    showMessage(...reasonsNodes(reasons));
  }

  // 先生の骨組みのリンク（ホームなど）も、保存を待ってから移る
  function onLinkClick(ev) {
    const a = ev.target instanceof Element ? ev.target.closest('a[href^="#"]') : null;
    if (!a || root.contains(a) || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    const href = a.getAttribute('href');
    if (leaving) return;
    leaving = true;
    readyToLeave().then((ok) => { if (ok && alive) location.hash = href; }).finally(() => { leaving = false; });
  }

  // タブを閉じる・読み直すとき、保存がまだなら確かめる
  function onBeforeUnload(ev) {
    if (autosaver.hasPending() || saveState === 'failed') {
      ev.preventDefault();
      ev.returnValue = '';
    }
  }

  // 別のアプリに切りかえたときは、すぐ保存する
  function onVisibility() {
    if (document.visibilityState === 'hidden') autosaver.flush();
  }

  document.addEventListener('click', onLinkClick, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);

  renderList();
  renderCenter();
  renderSide();

  return () => {
    if (canvas) canvas.finishEdit();
    document.removeEventListener('click', onLinkClick, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibility);
    if (thumbTimer !== null) window.clearTimeout(thumbTimer);
    // 最後の変更を 1 回だけ保存する（失敗しても、離れたあとは再試行しない）
    autosaver.flush();
    alive = false;
  };
}
