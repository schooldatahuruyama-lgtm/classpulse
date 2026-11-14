// スライド編集: 資料スライドのキャンバス（文字・画像・図形の選択、移動、大きさの変更、文字の入力）。
// 操作は Pointer Events（指でもマウスでも動く）。位置と大きさはキャンバスに対する割合（0〜1）。
import { el } from '../../ui.js';
import { renderSlide, placeItem, styleText, drawShape, SHAPE_NAMES } from '../../slide-render.js';
import { clampItem, normalizeShapeItem, SHAPE_KINDS, MIN_ITEM_SIZE as MIN_SIZE } from '../../model.js';
import { quickActions, shouldMoveOnDown } from './phone-logic.js';

const DRAG_START_PX = 6;          // これより小さい動きはタップとみなす
const KEY_STEP = 0.01;            // 矢印キー 1 回の移動量
const KEY_STEP_BIG = 0.05;        // Shift + 矢印キー
const IMAGE_LABEL = '画像を追加';
const IMAGE_BUSY_LABEL = '画像を読みこんでいます…';

const clamp = (v, lo, hi) => Math.min(Math.max(lo, hi), Math.max(lo, v));

// 図形の種類の一覧に出す小さな印（読み上げない）
const SHAPE_MARKS = { rect: '□', ellipse: '○', triangle: '△', line: '／', arrow: '→' };

function itemLabel(item) {
  if (item.kind === 'image') return '画像';
  if (item.kind === 'shape') return `図形（${SHAPE_NAMES[normalizeShapeItem(item).shape]}）`;
  const t = String(item.text || '').replace(/\s+/g, ' ').trim();
  return t ? `文字「${t.length > 20 ? `${t.slice(0, 20)}…` : t}」` : '文字（空）';
}

// 要素の位置と大きさを置く。図形は、箱の縦横比に合わせて SVG も描き直す（線と矢印の先がのびないように）
function place(node, item) {
  placeItem(node, item);
  if (item.kind === 'shape') drawShape(node, item);
}

// 道具の帯（文字を追加・画像を追加・図形）。画像の追加中かどうかは編集画面が持ち、setImageBusy で知らせる
function buildTools(ed) {
  const file = el('input', { type: 'file', accept: 'image/*', class: 'ed-file', tabindex: '-1', 'aria-hidden': 'true' });
  const error = el('div', { class: 'error', role: 'alert', hidden: true });
  const imgBtn = el('button', { type: 'button', class: 'btn', text: IMAGE_LABEL, onclick: () => file.click() });
  const textBtn = el('button', { type: 'button', class: 'btn', text: '文字を追加', onclick: () => { error.hidden = true; ed.addText(); } });

  // 「図形」: 押すと種類の一覧を開く。選ぶと、その図形を置いて一覧を閉じる
  const shapeMenu = el('div', { id: 'ed-shape-menu', class: 'ed-shape-menu', role: 'group', 'aria-label': '図形の種類', hidden: true },
    SHAPE_KINDS.map((shape) => el('button', {
      type: 'button', class: 'btn ed-shape-pick', dataset: { shape },
      onclick: () => { error.hidden = true; setMenu(false); ed.addShape(shape); },
    }, el('span', { class: 'ed-shape-mark', 'aria-hidden': 'true', text: SHAPE_MARKS[shape] }), el('span', { text: SHAPE_NAMES[shape] }))));
  const shapeBtn = el('button', {
    type: 'button', class: 'btn', text: '図形', 'aria-expanded': 'false', 'aria-controls': 'ed-shape-menu',
    onclick: () => setMenu(shapeMenu.hidden),
  });
  function setMenu(open) {
    shapeMenu.hidden = !open;
    shapeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) shapeMenu.querySelector('button')?.focus();
  }
  shapeMenu.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); setMenu(false); shapeBtn.focus(); }
  });

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
    el('div', { class: 'ed-tools', role: 'toolbar', 'aria-label': '要素を追加' }, textBtn, imgBtn, shapeBtn, file),
    shapeMenu,
    error);
  return { node, setImageBusy, showError };
}

// host にキャンバスを作る。戻り値で、部分的な描き直しをする
export function mountCanvas(host, ed) {
  const wrap = el('div', { class: 'ed-canvas-wrap' });
  const tools = buildTools(ed);
  const phoneInput = el('div', { class: 'ed-phone-edit ed-phone-only', hidden: true });
  const quick = el('div', { class: 'ed-quick ed-phone-only', 'aria-label': '選んだ要素の操作' });
  host.replaceChildren(tools.node, phoneInput, wrap, quick,
    el('p', { class: 'small muted ed-canvas-hint', text: '要素をタップで選び、ドラッグで動かします。右下のつまみで大きさを変えます。選んでいる文字をもう一度タップすると入力できます。' }));

  let stage = null;
  let handle = null;
  let gesture = null;
  let pendingTap = null;
  let phoneEdit = null;
  let desktopEditId = null;
  let disposed = false;
  let quickKey = null;

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
    renderQuickActions();
  }

  function renderQuickActions() {
    const item = findItem(ed.state.itemId);
    const actions = quickActions(item);
    const key = actions.join(',');
    if (key === quickKey) return;
    quickKey = key;
    if (!actions.length) {
      const choose = el('button', { type: 'button', class: 'btn', text: '要素を選ぶ', onclick: () => ed.openSettings(choose) });
      quick.replaceChildren(el('p', { class: 'muted', text: '要素をタップして選びます。選んでからドラッグで動かせます。' }), choose);
      return;
    }
    quick.replaceChildren(...actions.map((action) => {
      const labels = { type: '文字を入力', settings: '設定', deselect: '選択を外す' };
      const button = el('button', { type: 'button', class: 'btn', text: labels[action], dataset: { action }, onclick: () => {
        if (action === 'type') startEdit(ed.state.itemId);
        else if (action === 'settings') ed.openSettings(button);
        else { finishEdit(); select(null); }
      } });
      return button;
    }));
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
    if (phoneEdit?.id === id || desktopEditId === id) return;
    finishEdit();
    ed.state.editingId = id;
    if (ed.isNarrow()) {
      const ta = el('textarea', { class: 'ed-phone-textarea', rows: '4', 'aria-label': '文字を入力', value: String(item.text || '') });
      const session = { slideId: ed.state.slideId, id, ta };
      phoneEdit = session;
      phoneInput.replaceChildren(ta, el('button', {
        type: 'button', class: 'btn btn-primary', text: 'できた', onclick: () => finishEdit({ restoreFocus: true }),
      }));
      phoneInput.hidden = false;
      ed.setPhoneEditing(true);
      ta.addEventListener('input', () => {
        if (phoneEdit !== session || !validateEdit()) return;
        const cur = findItem(id);
        ed.updateItem({ ...cur, text: ta.value }, { group: 'text' });
        updateText(id);
      });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); finishEdit({ restoreFocus: true }); }
      });
      // 入力を始めた操作の中で一度だけ。変換中・blur 後は欄に触れない。
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      return;
    }
    desktopEditId = id;
    node.classList.add('is-editing');
    node.querySelector('.ed-placeholder')?.remove();
    const ta = el('textarea', { class: 'slide-text-body ed-textarea', 'aria-label': '文字を入力', value: String(item.text || '') });
    node.querySelector('.slide-text-body').replaceWith(ta);
    ta.addEventListener('input', () => {
      if (disposed || desktopEditId !== id) return;
      const cur = findItem(id);
      if (cur) ed.updateItem({ ...cur, text: ta.value }, { group: 'text' });
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

  function updateText(id) {
    const node = nodeOf(id);
    const item = findItem(id);
    if (!node || !item) return;
    const body = node.querySelector('.slide-text-body');
    if (body && body.tagName.toLowerCase() !== 'textarea') body.textContent = String(item.text || '');
    decorate(node, item);
  }

  // 入力の終了はここだけ。削除・移動・幅の切りかえ・破棄でも、最後の書き戻しはしない。
  function finishEdit({ restoreFocus = false } = {}) {
    ed.breakGroup?.();
    if (phoneEdit) {
      const id = phoneEdit.id;
      phoneEdit = null;
      if (ed.state.editingId === id) ed.state.editingId = null;
      phoneInput.hidden = true;
      phoneInput.replaceChildren();
      ed.setPhoneEditing(false);
      if (restoreFocus) quick.querySelector('[data-action="type"]')?.focus({ preventScroll: true });
    }
    const id = desktopEditId;
    if (!id) return;
    desktopEditId = null;
    if (ed.state.editingId === id) ed.state.editingId = null;
    const node = nodeOf(id);
    const item = findItem(id);
    if (!node) return;
    node.classList.remove('is-editing');
    const ta = node.querySelector('textarea');
    if (ta) ta.replaceWith(el('div', { class: 'slide-text-body', text: item ? String(item.text || '') : '' }));
    if (item) decorate(node, item);
  }

  function validateEdit() {
    if (disposed) return false;
    if (phoneEdit && (ed.state.slideId !== phoneEdit.slideId || findItem(phoneEdit.id)?.kind !== 'text' || !ed.isNarrow())) finishEdit();
    return !!phoneEdit;
  }

  function resetInteraction() {
    finishEdit();
    pendingTap = null;
    if (gesture) onCancel({ pointerId: gesture.pointerId });
  }

  function destroy() {
    resetInteraction();
    disposed = true;
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
    if (pendingTap && ev.pointerId === pendingTap.pointerId) {
      if (Math.hypot(ev.clientX - pendingTap.x, ev.clientY - pendingTap.y) >= DRAG_START_PX) pendingTap.moved = true;
      return;
    }
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
    if (node) place(node, g.cur);
    placeHandle(g.cur);
  }

  function onUp(ev) {
    if (pendingTap && ev.pointerId === pendingTap.pointerId) {
      const tap = pendingTap;
      pendingTap = null;
      if (!tap.moved && Math.hypot(ev.clientX - tap.x, ev.clientY - tap.y) < DRAG_START_PX && findItem(tap.id)) {
        select(tap.id);
        nodeOf(tap.id)?.focus({ preventScroll: true });
      }
      return;
    }
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
    if (pendingTap && ev.pointerId === pendingTap.pointerId) pendingTap = null;
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    gesture = null;
    const node = nodeOf(g.id);
    if (node) place(node, g.orig);
    placeHandle(g.orig);
  }

  function listenGesture(target) {
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
  }

  function onItemDown(ev, id) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.isPrimary === false) { pendingTap = null; return; }
    if (ed.state.editingId === id) return; // 入力中はテキスト欄の操作にまかせる
    ev.stopPropagation();
    const wasSelected = ed.state.itemId === id;
    if (!shouldMoveOnDown({ narrow: ed.isNarrow(), pointerType: ev.pointerType, wasSelected })) {
      pendingTap = { pointerId: ev.pointerId, id, x: ev.clientX, y: ev.clientY, moved: false };
      return; // preventDefault も選択もしない。スクロールになったら pointercancel で捨てる。
    }
    ev.preventDefault();
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
    nodeOf(id) && place(nodeOf(id), next);
    placeHandle(next);
    ed.updateItem(next, { group: `move:${ev.key}:${ev.shiftKey ? 'big' : 'small'}` });
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
    if (node) place(node, next);
    placeHandle(next);
    ed.updateItem(next, { group: `handle:${ev.key}:${ev.shiftKey ? 'big' : 'small'}` });
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
    place(node, item);
    if (item.kind === 'text') styleText(node, item);
    if (ed.state.itemId === id) placeHandle(item);
  }

  render();
  return { render, refreshItem, applySelection, finishEdit, validateEdit, resetInteraction, destroy, setImageBusy: tools.setImageBusy, showImageError: tools.showError };
}
