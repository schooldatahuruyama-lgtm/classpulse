// 教材（デッキ）のデータ。DOM・通信・グローバルに触れない純粋なモジュール。
// どの関数も引数を書きかえず、新しい値を返す。
import { CONFIG } from './config.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 英数字だけの ID。乱数は引数で受け取る
export function newId(random = Math.random, length = CONFIG.idLength) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length))];
  }
  return s;
}

// 授業 ID。crypto.getRandomValues を受け取る（偏りが出ないよう 248 以上の値は捨てる）
export function newSessionId(getRandomValues) {
  let s = '';
  while (s.length < CONFIG.sessionIdLength) {
    const bytes = getRandomValues(new Uint8Array(CONFIG.sessionIdLength * 2));
    for (const b of bytes) {
      if (b < 248 && s.length < CONFIG.sessionIdLength) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return s;
}

export function createDeck(title, now) {
  return { title, updatedAt: now, order: [], slides: {}, images: {} };
}

export function createSlide(type) {
  if (type === 'poll') return { type: 'poll', question: '', options: ['', ''], resultMode: 'manual' };
  return { type: 'content', items: [] };
}

export function createTextItem(id) {
  return {
    id, kind: 'text', x: 0.1, y: 0.1, w: 0.8, h: 0.2,
    text: '', size: 'm', bold: false, color: '#1F2A6B', align: 'left',
  };
}

// 要素の最小の大きさ（キャンバスの幅・高さに対する割合）
export const MIN_ITEM_SIZE = 0.05;

// 要素を枠の中に収める（大きさを MIN_ITEM_SIZE〜1 にしてから、x は 0〜1-w、y は 0〜1-h）。
// 数でない値は文字の箱の既定値にする。元の要素は書きかえない
export function clampItem(item) {
  const src = item && typeof item === 'object' ? item : {};
  const d = createTextItem('');
  const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const w = Math.min(1, Math.max(MIN_ITEM_SIZE, num(src.w, d.w)));
  const h = Math.min(1, Math.max(MIN_ITEM_SIZE, num(src.h, d.h)));
  const x = Math.min(1 - w, Math.max(0, num(src.x, d.x)));
  const y = Math.min(1 - h, Math.max(0, num(src.y, d.y)));
  return { ...src, x, y, w, h };
}

// afterId が無い（または見つからない）ときは最後に足す
export function addSlide(deck, slide, id, afterId) {
  const order = [...deck.order];
  const at = afterId === undefined ? -1 : order.indexOf(afterId);
  if (at < 0) order.push(id);
  else order.splice(at + 1, 0, id);
  return { ...deck, order, slides: { ...deck.slides, [id]: slide } };
}

function usedImageIds(slide) {
  const ids = new Set();
  for (const it of (slide && slide.items) || []) {
    if (it && it.kind === 'image' && it.imageId) ids.add(it.imageId);
  }
  return ids;
}

export function removeSlide(deck, id) {
  const slides = { ...deck.slides };
  const removed = usedImageIds(slides[id]);
  delete slides[id];
  const stillUsed = new Set();
  for (const s of Object.values(slides)) for (const i of usedImageIds(s)) stillUsed.add(i);
  const images = { ...deck.images };
  for (const i of removed) if (!stillUsed.has(i)) delete images[i];
  return { ...deck, order: deck.order.filter((x) => x !== id), slides, images };
}

export function moveSlide(deck, id, delta) {
  const from = deck.order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= deck.order.length) return { ...deck, order: [...deck.order] };
  const order = [...deck.order];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { ...deck, order };
}

// 複製は元のすぐ後ろ。要素の id は付けかえ、画像の imageId は共有する
export function duplicateSlide(deck, id, newSlideId, newItemId) {
  const src = deck.slides[id];
  const copy = JSON.parse(JSON.stringify(src));
  if (Array.isArray(copy.items)) copy.items = copy.items.map((it) => ({ ...it, id: newItemId() }));
  return addSlide(deck, copy, newSlideId, id);
}

export function updateSlide(deck, id, slide) {
  return { ...deck, slides: { ...deck.slides, [id]: slide } };
}

// Realtime Database は空の配列を落とし、配列を {0:…,1:…} で返すことがある
function toArray(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => v[k]);
  }
  return [];
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function normalizeSlide(raw) {
  const s = plainObject(raw);
  if (s.type === 'poll') {
    return {
      ...s,
      type: 'poll',
      question: typeof s.question === 'string' ? s.question : '',
      options: toArray(s.options),
      resultMode: s.resultMode === 'live' ? 'live' : 'manual',
    };
  }
  // 保存された位置が枠の外・大きさ 0 でも、表示と編集で困らないように直す
  const items = toArray(s.items).map((it) => (it && typeof it === 'object' ? clampItem(it) : it));
  return { ...s, type: 'content', items };
}

export function normalizeDeck(raw) {
  const r = plainObject(raw);
  const rawSlides = plainObject(r.slides);
  const slides = {};
  for (const id of Object.keys(rawSlides)) slides[id] = normalizeSlide(rawSlides[id]);
  const order = toArray(r.order).filter((id) => typeof id === 'string' && Object.hasOwn(slides, id));
  return {
    title: typeof r.title === 'string' ? r.title : '',
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    order,
    slides,
    images: { ...plainObject(r.images) },
  };
}

// 発表を始められない理由。問題がなければ空
export function validateDeck(deck) {
  if (!deck.order.length) return ['スライドがありません。'];
  const problems = [];
  deck.order.forEach((id, i) => {
    const s = deck.slides[id];
    if (!s || s.type !== 'poll') return;
    const n = `${i + 1} 枚目`;
    const options = s.options || [];
    const filled = options.filter((o) => String(o).trim() !== '').length;
    if (String(s.question || '').trim() === '') problems.push(`${n}: 質問文を入れてください。`);
    if (options.length > CONFIG.poll.maxOptions) problems.push(`${n}: 選択肢は ${CONFIG.poll.maxOptions} つまでです。`);
    if (filled < CONFIG.poll.minOptions) problems.push(`${n}: 選択肢を ${CONFIG.poll.minOptions} つ以上入れてください。`);
    else if (filled < options.length) problems.push(`${n}: 空の選択肢を消してください。`);
  });
  return problems;
}

export function deckImageBytes(deck) {
  return Object.values(deck.images || {}).reduce((sum, d) => sum + String(d).length, 0);
}
