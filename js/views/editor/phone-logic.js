// せまい編集画面の表示と操作の決まり。DOM や保存には触れない。
import { clampItem, MIN_ITEM_SIZE } from '../../model.js';
import { SHAPE_NAMES } from '../../slide-render.js';

export const NARROW_QUERY = '(max-width: 899px)';

export function slideBarLabel(order, slideId) {
  const ids = Array.isArray(order) ? order : [];
  if (!ids.length) return 'スライド（0 枚）';
  const at = ids.indexOf(slideId);
  return at < 0 ? `スライド（${ids.length} 枚）` : `スライド（${at + 1}／${ids.length} 枚）`;
}

export function quickActions(item) {
  if (!item) return [];
  return item.kind === 'text' ? ['type', 'settings', 'deselect'] : ['settings', 'deselect'];
}

export function itemRows(items, selectedId) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === 'object').slice().reverse().map((item) => {
    let label = '要素';
    if (item.kind === 'text') {
      const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
      const chars = Array.from(text);
      label = `文字: ${chars.length ? chars.slice(0, 12).join('') + (chars.length > 12 ? '…' : '') : '（空）'}`;
    } else if (item.kind === 'image') label = '画像';
    else if (item.kind === 'shape') label = `図形: ${Object.hasOwn(SHAPE_NAMES, item.shape) ? SHAPE_NAMES[item.shape] : SHAPE_NAMES.rect}`;
    return { id: item.id, label, selected: item.id === selectedId };
  });
}

export function nudge(item, dir) {
  const d = { left: [-0.01, 0], right: [0.01, 0], up: [0, -0.01], down: [0, 0.01] };
  if (!Object.hasOwn(d, dir)) return item;
  const cur = clampItem(item);
  return clampItem({ ...cur, x: cur.x + d[dir][0], y: cur.y + d[dir][1] });
}

export function resize(item, kind) {
  if (!['bigger', 'smaller', 'wider', 'narrower', 'taller', 'shorter'].includes(kind)) return item;
  const cur = clampItem(item);
  // 0.1 + 0.9 のような端では、引き算の丸め誤差だけで左上を動かさない。
  if (Number.isFinite(item?.x) && item.x >= 0 && item.x + cur.w <= 1) cur.x = item.x;
  if (Number.isFinite(item?.y) && item.y >= 0 && item.y + cur.h <= 1) cur.y = item.y;
  let { w, h } = cur;
  if (kind === 'bigger' || kind === 'smaller') {
    const scale = kind === 'bigger'
      ? Math.min(1.05, (1 - cur.x) / w, (1 - cur.y) / h)
      : Math.max(1 / 1.05, MIN_ITEM_SIZE / w, MIN_ITEM_SIZE / h);
    w *= scale;
    h *= scale;
  } else {
    if (kind === 'wider') w += 0.02;
    if (kind === 'narrower') w -= 0.02;
    if (kind === 'taller') h += 0.02;
    if (kind === 'shorter') h -= 0.02;
  }
  // 大きさを先に止め、clampItem が左上を動かすことを防ぐ。
  return { ...cur, w: Math.max(MIN_ITEM_SIZE, Math.min(1 - cur.x, w)), h: Math.max(MIN_ITEM_SIZE, Math.min(1 - cur.y, h)) };
}

export function shouldMoveOnDown({ narrow, pointerType, wasSelected }) {
  return !narrow || pointerType === 'mouse' || !!wasSelected;
}

export function shouldCloseSlidePanel(action) {
  return ['select', 'add', 'duplicate'].includes(action);
}
