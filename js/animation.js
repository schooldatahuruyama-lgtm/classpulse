// 順番表示の計算。DOM・通信に触れず、引数を書きかえない。
export const MAX_STEP = 20;

export function normalizeStep(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_STEP, Math.max(0, Math.floor(value))) : 0;
}

function steps(slide) {
  if (!slide || slide.type !== 'content' || !Array.isArray(slide.items)) return [];
  return [...new Set(slide.items.map((item) => normalizeStep(item?.step)).filter((n) => n > 0))].sort((a, b) => a - b);
}

export function stepCount(slide) {
  return steps(slide).length;
}

export function itemRank(slide, item) {
  const n = normalizeStep(item?.step);
  return n ? steps(slide).indexOf(n) + 1 : 0;
}

export function clampStep(slide, step) {
  return Math.min(stepCount(slide), normalizeStep(step));
}

export function isItemVisible(slide, item, step) {
  // 古い先生の画面から届いた「回数なし」は、全部を見せる。
  return !Number.isFinite(step) || itemRank(slide, item) <= clampStep(slide, step);
}

export function advance({ order, slides, slideId, step }, dir) {
  const index = order.indexOf(slideId);
  const slide = slides[slideId];
  const count = stepCount(slide);
  const current = Number.isFinite(step) ? clampStep(slide, step) : count;
  const stay = (next) => ({ slideId, step: next, moved: false });
  if (dir > 0 && current < count) return stay(current + 1);
  if (dir < 0 && current > 0) return stay(current - 1);
  const target = index + (dir > 0 ? 1 : dir < 0 ? -1 : 0);
  if (!dir || target < 0 || target >= order.length || target === index) return stay(current);
  const id = order[target];
  return { slideId: id, step: dir > 0 ? 0 : stepCount(slides[id]), moved: id !== slideId };
}
