// スライド編集: 資料スライドのキャンバス（文字・画像の選択、移動、大きさの変更、文字の入力）。
// 操作は Pointer Events（指でもマウスでも動く）。位置と大きさはキャンバスに対する割合（0〜1）。
import { el } from '../../ui.js';
import { renderSlide, placeItem, styleText } from '../../slide-render.js';
import { clampItem, MIN_ITEM_SIZE as MIN_SIZE } from '../../model.js';

const DRAG_START_PX = 6;          // これより小さい動きはタップとみなす
const KEY_STEP = 0.01;            // 矢印キー 1 回の移動量
const KEY_STEP_BIG = 0.05;        // Shift + 矢印キー
const IMAGE_LABEL = '画像を追加';
const IMAGE_BUSY_LABEL = '画像を読みこんでいます…';

const clamp = (v, lo, hi) => Math.min(Math.max(lo, hi), Math.max(lo, v));

function itemLabel(item) {
  if (item.kind === 'image') return '画像';
  const t = String(item.text || '').replace(/\s+/g, ' ').trim();
  return t ? `文字「${t.length > 20 ? `${t.slice(0, 20)}…` : t}」` : '文字（空）';
}

// 道具の帯（文字を追加・画像を追加）。画像の追加中かどうかは編集画面が持ち、setImageBusy で知らせる
function buildTools(ed) {
  const file = el('input', { type: 'file', accept: 'image/*', class: 'ed-file', tabindex: '-1', 'aria-hidden': 'true' });
  const error = el('div', { class: 'error', role: 'alert', hidden: true });
  const imgBtn = el('button', { type: 'button', class: 'btn', text: IMAGE_LABEL, onclick: () => file.click() });
  const textBtn = el('button', { type: 'button', class: 'btn', text: '文字を追加', onclick: () => { error.hidden = true; ed.addText(); } });

  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    error.hidden = true;
    ed.addImage(f);
  });

  const setImageBusy = (busy) => {
    imgBtn.disabled = busy;
    imgBtn.textContent = busy ? IMAGE_BUSY_LABEL : IMAGE_LABEL;
  };
  const showError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
  };
  setImageBusy(ed.isImageBusy());

  const node = el('div', { class: 'ed-tools-wrap' },
    el('div', { class: 'ed-tools', role: 'toolbar', 'aria-label': '要素を追加' }, textBtn, imgBtn, file),
    error);
  return { node, setImageBusy, showError };
}

// host にキャンバスを作る。戻り値で、部分的な描き直しをする
export function mountCanvas(host, ed) {
  const wrap = el('div', { class: 'ed-canvas-wrap' });
  const tools = buildTools(ed);
  host.replaceChildren(tools.node, wrap,
    el('p', { class: 'small muted ed-canvas-hint', text: '要素をタップで選び、ドラッグで動かします。右下のつまみで大きさを変えます。選んでいる文字をもう一度タップすると入力できます。' }));

  let stage = null;
  let handle = null;
  let gesture = null;

  const findItem = (id) => (ed.currentSlide()?.items || []).find((it) => it.id === id) || null;
  const nodeOf = (id) => (stage ? [...stage.querySelectorAll('[data-item-id]')].find((n) => n.dataset.itemId === id) : null);

  function placeHandle(item) {
    if (!handle) return;
    if (!item) { handle.hidden = true; return; }
    handle.hidden = false;
    handle.style.left = `${(item.x + item.w) * 100}%`;
    handle.style.top = `${(item.y + item.h) * 100}%`;
  }

  // 文字の箱が空のとき、編集画面だけに案内を出す
  function decorate(node, item) {
    node.classList.add('ed-item');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', itemLabel(item));
    const body = node.querySelector('.slide-text-body');
    node.querySelector('.ed-placeholder')?.remove();
    if (item.kind === 'text' && body && !String(item.text || '')) {
      node.append(el('span', { class: 'ed-placeholder', 'aria-hidden': 'true', text: '（文字を入力）' }));
    }
  }

  // 選んでいる要素の枠とつまみ（描き直さずに付けかえる）
  function applySelection() {
    if (!stage) return;
    const sel = ed.state.itemId;
    for (const n of stage.querySelectorAll('[data-item-id]')) {
      const on = n.dataset.itemId === sel;
      n.classList.toggle('is-selected', on);
      n.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    placeHandle(sel ? findItem(sel) : null);
  }

  function select(id) {
    if (ed.state.editingId && ed.state.editingId !== id) finishEdit();
    if (ed.state.itemId !== id) ed.selectItem(id);
    applySelection();
  }

  // ---- 文字の入力 ----
  function startEdit(id) {
    const node = nodeOf(id);
    const item = findItem(id);
    if (!node || !item || item.kind !== 'text') return;
    ed.state.editingId = id;
    node.classList.add('is-editing');
    node.querySelector('.ed-placeholder')?.remove();
    const ta = el('textarea', { class: 'slide-text-body ed-textarea', 'aria-label': '文字を入力', value: String(item.text || '') });
    node.querySelector('.slide-text-body').replaceWith(ta);
    ta.addEventListener('input', () => {
      const cur = findItem(id);
      if (cur) ed.updateItem({ ...cur, text: ta.value });
    });
    ta.addEventListener('blur', () => { if (ed.state.editingId === id) finishEdit(); });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); finishEdit(); node.focus(); }
    });
    ta.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }

  function finishEdit() {
    const id = ed.state.editingId;
    if (!id) return;
    ed.state.editingId = null;
    const node = nodeOf(id);
    const item = findItem(id);
    if (!node) return;
    node.classList.remove('is-editing');
    const ta = node.querySelector('textarea');
    if (ta) ta.replaceWith(el('div', { class: 'slide-text-body', text: item ? String(item.text || '') : '' }));
    if (item) decorate(node, item);
  }

  // ---- ドラッグ（移動・大きさ） ----
  function beginGesture(ev, target, id, kind, wasSelected) {
    const item = findItem(id);
    if (!item || !stage) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    gesture = {
      pointerId: ev.pointerId, target, id, kind, wasSelected, rect,
      sx: ev.clientX, sy: ev.clientY, orig: clampItem(item), cur: clampItem(item), moved: false,
    };
    try { target.setPointerCapture(ev.pointerId); } catch { /* 取れなくても続ける */ }
  }

  function onMove(ev) {
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    const px = ev.clientX - g.sx;
    const py = ev.clientY - g.sy;
    if (!g.moved && Math.hypot(px, py) < DRAG_START_PX) return;
    g.moved = true;
    const dx = px / g.rect.width;
    const dy = py / g.rect.height;
    const o = g.orig;
    if (g.kind === 'move') {
      g.cur = { ...o, x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) };
    } else {
      g.cur = { ...o, w: clamp(o.w + dx, MIN_SIZE, 1 - o.x), h: clamp(o.h + dy, MIN_SIZE, 1 - o.y) };
    }
    const node = nodeOf(g.id);
    if (node) placeItem(node, g.cur);
    placeHandle(g.cur);
  }

  function onUp(ev) {
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    gesture = null;
    if (g.moved) {
      ed.updateItem(g.cur);
    } else if (g.kind === 'move' && g.wasSelected) {
      // 選んでいる文字をもう一度タップ → 入力
      const item = findItem(g.id);
      if (item && item.kind === 'text') startEdit(g.id);
    }
  }

  function onCancel(ev) {
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    gesture = null;
    const node = nodeOf(g.id);
    if (node) placeItem(node, g.orig);
    placeHandle(g.orig);
  }

  function listenGesture(target) {
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
  }

  function onItemDown(ev, id) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ed.state.editingId === id) return; // 入力中はテキスト欄の操作にまかせる
    ev.preventDefault();
    ev.stopPropagation();
    const wasSelected = ed.state.itemId === id;
    select(id);
    nodeOf(id)?.focus({ preventScroll: true });
    beginGesture(ev, ev.currentTarget, id, 'move', wasSelected);
  }

  // キーボード: 矢印で動かす、Enter で文字を入力
  function onItemKey(ev, id) {
    if (ed.state.editingId === id) return;
    const item = findItem(id);
    if (!item) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      select(id);
      if (item.kind === 'text') startEdit(id);
      return;
    }
    const step = ev.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    select(id);
    const next = clampItem({ ...item, x: item.x + d[0], y: item.y + d[1] });
    nodeOf(id) && placeItem(nodeOf(id), next);
    placeHandle(next);
    ed.updateItem(next);
  }

  function onHandleKey(ev) {
    const id = ed.state.itemId;
    const item = id && findItem(id);
    if (!item) return;
    const step = ev.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    const o = clampItem(item);
    const next = { ...o, w: clamp(o.w + d[0], MIN_SIZE, 1 - o.x), h: clamp(o.h + d[1], MIN_SIZE, 1 - o.y) };
    const node = nodeOf(id);
    if (node) placeItem(node, next);
    placeHandle(next);
    ed.updateItem(next);
  }

  // キャンバスを作り直す
  function render() {
    gesture = null;
    const slide = ed.currentSlide();
    renderSlide(wrap, slide, ed.state.deck.images, { mode: 'view' });
    const frame = wrap.firstElementChild;
    frame.classList.add('ed-frame');
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', 'キャンバス');
    stage = frame.querySelector('.slide-stage');

    for (const node of stage.querySelectorAll('[data-item-id]')) {
      const id = node.dataset.itemId;
      const item = findItem(id);
      if (!item) continue;
      decorate(node, item);
      node.addEventListener('pointerdown', (ev) => onItemDown(ev, id));
      node.addEventListener('keydown', (ev) => onItemKey(ev, id));
      listenGesture(node);
    }

    handle = el('div', { class: 'ed-handle', role: 'button', tabindex: '0', 'aria-label': '大きさを変える（矢印キーでも変えられます）', hidden: true },
      el('span', { class: 'ed-handle-dot', 'aria-hidden': 'true' }));
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const id = ed.state.itemId;
      if (!id) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ed.state.editingId) finishEdit();
      beginGesture(ev, handle, id, 'resize', true);
    });
    handle.addEventListener('keydown', onHandleKey);
    listenGesture(handle);
    stage.append(handle);

    // 何もない所をタップ → 選択を外す
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.target !== stage) return;
      finishEdit();
      select(null);
    });

    applySelection();
    if (ed.state.editingId) {
      const id = ed.state.editingId;
      ed.state.editingId = null;
      startEdit(id);
    }
  }

  // 1 つの要素の見た目だけ直す（入力中でも消さない）
  function refreshItem(id) {
    const node = nodeOf(id);
    const item = findItem(id);
    if (!node || !item) return;
    placeItem(node, item);
    if (item.kind === 'text') styleText(node, item);
    if (ed.state.itemId === id) placeHandle(item);
  }

  render();
  return { render, refreshItem, applySelection, finishEdit, setImageBusy: tools.setImageBusy, showImageError: tools.showError };
}
