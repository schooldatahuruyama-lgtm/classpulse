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
  // クイズは作った直後、1 つ目の選択肢が正解
  if (type === 'quiz') return { type: 'quiz', question: '', options: ['', ''], correct: 0 };
  if (type === 'rating') return { type: 'rating', question: '', lowLabel: '', highLabel: '', resultMode: 'manual' };
  if (type === 'free') return { type: 'free', question: '' };
  if (type === 'cloud') return { type: 'cloud', question: '' };
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

// ---- 図形（kind:'shape'）----

// 図形の種類（四角形・円・三角形・線・矢印）
export const SHAPE_KINDS = ['rect', 'ellipse', 'triangle', 'line', 'arrow'];
// 線の向き（よこ・たて・左上から右下・左下から右上）と、矢印の先（終わり・始め・両方）
export const SHAPE_DIRS = ['h', 'v', 'd1', 'd2'];
export const ARROW_HEADS = ['end', 'start', 'both'];

const isLineShape = (shape) => shape === 'line' || shape === 'arrow';

// 決まった色の値（大文字）か 'none'。どちらでもなければ null。
// forStroke: 線に使える色（stroke: true）だけを認める
function shapeColor(v, forStroke) {
  if (v === 'none') return 'none';
  if (typeof v !== 'string') return null;
  const up = v.toUpperCase();
  const c = CONFIG.shape.colors.find((x) => x.value === up && (!forStroke || x.stroke));
  return c ? c.value : null;
}

// 図形の要素を作る。置く場所はスライドの中央あたり。
// 四角形・円・三角形は画面の上で正方形（16:9 の枠なので h = w × 16 / 9）、線と矢印は横長の箱
export function createShapeItem(id, shape) {
  const s = SHAPE_KINDS.includes(shape) ? shape : 'rect';
  const { defaultFill, defaultStroke } = CONFIG.shape;
  if (s === 'line') {
    return { id, kind: 'shape', shape: s, x: 0.3, y: 0.45, w: 0.4, h: 0.1, stroke: defaultStroke, strokeWidth: 'm', dir: 'h' };
  }
  if (s === 'arrow') {
    return { id, kind: 'shape', shape: s, x: 0.3, y: 0.45, w: 0.4, h: 0.1, stroke: defaultStroke, strokeWidth: 'm', dir: 'h', head: 'end' };
  }
  return { id, kind: 'shape', shape: s, x: 0.3875, y: 0.3, w: 0.225, h: 0.4, fill: defaultFill, stroke: defaultStroke, strokeWidth: 'm' };
}

// 保存された図形を正す（元は書きかえない）。種類に合う項目だけを残し、知らない値は既定値にする。
// 色は決まった色か 'none' だけ。塗りも線も 'none'（見えない）にはしない。線と矢印の線は 'none' にしない
export function normalizeShapeItem(item) {
  const src = item && typeof item === 'object' ? item : {};
  const { x, y, w, h } = clampItem(src);
  const { defaultFill, defaultStroke, widths } = CONFIG.shape;
  const shape = SHAPE_KINDS.includes(src.shape) ? src.shape : 'rect';
  const out = { ...(src.id !== undefined ? { id: src.id } : {}), kind: 'shape', shape, x, y, w, h };
  const strokeWidth = typeof src.strokeWidth === 'string' && Object.hasOwn(widths, src.strokeWidth) ? src.strokeWidth : 'm';
  let stroke = shapeColor(src.stroke, true) ?? defaultStroke;
  if (isLineShape(shape)) {
    if (stroke === 'none') stroke = defaultStroke;
    out.stroke = stroke;
    out.strokeWidth = strokeWidth;
    out.dir = SHAPE_DIRS.includes(src.dir) ? src.dir : 'h';
    if (shape === 'arrow') out.head = ARROW_HEADS.includes(src.head) ? src.head : 'end';
    return out;
  }
  const fill = shapeColor(src.fill, false) ?? defaultFill;
  if (fill === 'none' && stroke === 'none') stroke = defaultStroke;
  out.fill = fill;
  out.stroke = stroke;
  out.strokeWidth = strokeWidth;
  return out;
}

// 描くための座標（箱を 0〜1 とした座標）。正していない値でもよい（中で正す）。
// box: 四角形・円の範囲、points: 三角形の頂点、line: 線の始点と終点、heads: 矢印の先の有無
export function shapeGeometry(item) {
  const n = normalizeShapeItem(item);
  const heads = {
    start: n.shape === 'arrow' && (n.head === 'start' || n.head === 'both'),
    end: n.shape === 'arrow' && (n.head === 'end' || n.head === 'both'),
  };
  if (n.shape === 'triangle') return { shape: n.shape, points: [[0.5, 0], [1, 1], [0, 1]], heads };
  if (isLineShape(n.shape)) {
    const line = {
      h: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
      v: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 },
      d1: { x1: 0, y1: 0, x2: 1, y2: 1 },
      d2: { x1: 0, y1: 1, x2: 1, y2: 0 },
    }[n.dir];
    return { shape: n.shape, line, heads };
  }
  return { shape: n.shape, box: { x: 0, y: 0, w: 1, h: 1 }, heads };
}

// SVG に描く部品（純粋な関数）。単位は「スライドの幅の 1%」。スライドは 16:9 なので、
// 箱の大きさは width = w × 100、height = h × 100 × 9 / 16 で、画面の上の縦横比と同じになる。
// そのため viewBox を箱いっぱいに広げても、線の太さ・矢印の先はのびず、どの画面でもスライドの幅に比例する。
// 線の端が切れないよう、線の太さの半分だけ内側に描く（角と端は丸める）。
// parts: [{ tag, attrs, points?, role? }]。attrs の値は数か決まった文字だけ（色は正した値）
export function shapeDrawing(item) {
  const n = normalizeShapeItem(item);
  const g = shapeGeometry(n);
  const width = n.w * 100;
  const height = n.h * 100 * 9 / 16;
  const sw = CONFIG.shape.widths[n.strokeWidth];
  const p = sw / 2;
  const iw = Math.max(0, width - 2 * p);
  const ih = Math.max(0, height - 2 * p);
  const X = (u) => p + u * iw;
  const Y = (v) => p + v * ih;
  const paint = {
    fill: isLineShape(n.shape) ? 'none' : n.fill,
    stroke: n.stroke,
    'stroke-width': sw,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  };
  const parts = [];
  if (n.shape === 'rect') {
    parts.push({ tag: 'rect', attrs: { x: X(0), y: Y(0), width: iw, height: ih, ...paint } });
  } else if (n.shape === 'ellipse') {
    parts.push({ tag: 'ellipse', attrs: { cx: width / 2, cy: height / 2, rx: iw / 2, ry: ih / 2, ...paint } });
  } else if (n.shape === 'triangle') {
    parts.push({ tag: 'polygon', role: 'body', points: g.points.map(([u, v]) => [X(u), Y(v)]), attrs: paint });
  } else {
    let x1 = X(g.line.x1); let y1 = Y(g.line.y1);
    let x2 = X(g.line.x2); let y2 = Y(g.line.y2);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const count = (g.heads.start ? 1 : 0) + (g.heads.end ? 1 : 0);
    if (count && len > 0) {
      // 矢印の先: 線の太さに合った大きさの 2 等辺三角形。線が短いときは形を保ったまま小さくする
      let headLen = 1.5 + 3 * sw;
      if (count * headLen > 0.8 * len) headLen = (0.8 * len) / count;
      const half = headLen * 0.55;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const head = (tx, ty, dx, dy) => {
        const bx = tx - dx * headLen;
        const by = ty - dy * headLen;
        parts.push({
          tag: 'polygon', role: 'head',
          points: [[tx, ty], [bx - dy * half, by + dx * half], [bx + dy * half, by - dx * half]],
          attrs: { fill: n.stroke, stroke: 'none' },
        });
        return [bx, by];
      };
      // 線は先の底辺まで（先の三角形の先端に、線の丸い端が出ないように）
      if (g.heads.end) [x2, y2] = head(x2, y2, ux, uy);
      if (g.heads.start) [x1, y1] = head(x1, y1, -ux, -uy);
    }
    parts.unshift({ tag: 'line', attrs: { x1, y1, x2, y2, ...paint } });
  }
  return { width, height, strokeWidth: sw, parts };
}

// 要素を、重なりのいちばん前（items の最後）・いちばん後ろ（最初）へ動かした新しいスライド。
// 見つからなければ元のまま（中身の同じ新しい値）
function moveItemTo(slide, itemId, front) {
  if (!slide || !Array.isArray(slide.items)) return { ...slide };
  const items = [...slide.items];
  const at = items.findIndex((it) => it && it.id === itemId);
  if (at < 0) return { ...slide, items };
  const [it] = items.splice(at, 1);
  if (front) items.push(it);
  else items.unshift(it);
  return { ...slide, items };
}

export function bringToFront(slide, itemId) {
  return moveItemTo(slide, itemId, true);
}

export function sendToBack(slide, itemId) {
  return moveItemTo(slide, itemId, false);
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

// ---- 選ぶ種類の質問（アンケート・クイズ・5 段階評価）----
// どれも回答は { choice, at }、集計は { counts, total } で、アンケートのしくみに乗せる

const CHOICE_TYPES = new Set(['poll', 'quiz', 'rating']);

// 選択肢から 1 つ選ぶ種類のスライドか（poll・quiz・rating）
export function isChoiceSlide(slide) {
  return !!slide && typeof slide === 'object' && CHOICE_TYPES.has(slide.type);
}

// 5 段階評価の選択肢の文（'1'〜'5'）。授業の写しの options にも使う
export function ratingOptions() {
  return Array.from({ length: CONFIG.rating.steps }, (_, i) => String(i + 1));
}

// 選べる選択肢の数。評価は options によらず段階の数。選ぶ種類でなければ 0
export function choiceCount(slide) {
  if (!isChoiceSlide(slide)) return 0;
  if (slide.type === 'rating') return CONFIG.rating.steps;
  return toArray(slide.options).length;
}

// クイズの正解の番号。0 以上・選択肢の数未満の整数でなければ 0
export function quizCorrect(slide) {
  const c = slide && slide.correct;
  const n = toArray(slide && slide.options).length;
  return Number.isInteger(c) && c >= 0 && c < n ? c : 0;
}

// 選択肢を 1 つ消したスライド（元は書きかえない）。範囲外なら何も消さない。
// クイズは、正解を消したら 1 つ目を正解にし、正解より前を消したら番号を 1 減らす（正解が別の選択肢にずれない）
export function removeOption(slide, index) {
  const options = toArray(slide.options);
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return { ...slide, options };
  const next = options.filter((_, k) => k !== index);
  if (slide.type !== 'quiz') return { ...slide, options: next };
  const c = quizCorrect(slide);
  const correct = c === index ? 0 : c > index ? c - 1 : c;
  return { ...slide, options: next, correct };
}

// クイズのスライドから correct を外した教材（授業の写し・生徒と発表画面に渡す教材に使う）。元は書きかえない
export function withoutCorrect(deck) {
  const slides = {};
  for (const [id, s] of Object.entries(deck.slides || {})) {
    if (s && s.type === 'quiz') {
      const rest = { ...s };
      delete rest.correct;
      slides[id] = rest;
    } else {
      slides[id] = s;
    }
  }
  return { ...deck, slides };
}

// 文字列を max 文字までに切る（対になる文字を半分にしない）
function cutText(v, max) {
  if (typeof v !== 'string') return '';
  if (v.length <= max) return v;
  let t = v.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return t;
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
  // クイズはアンケートと同じに正し、正解の番号を範囲に収める（結果の出し方は持たない）
  if (s.type === 'quiz') {
    const rest = { ...s };
    delete rest.resultMode;
    const options = toArray(s.options);
    return {
      ...rest,
      type: 'quiz',
      question: typeof s.question === 'string' ? s.question : '',
      options,
      correct: quizCorrect({ options, correct: s.correct }),
    };
  }
  // 評価は質問文・両はしの言葉・結果の出し方だけを残す（授業の写しの options も落とす。数は段階の数で決まる）
  if (s.type === 'rating') {
    const max = CONFIG.rating.labelMaxLength;
    return {
      type: 'rating',
      question: typeof s.question === 'string' ? s.question : '',
      lowLabel: cutText(s.lowLabel, max),
      highLabel: cutText(s.highLabel, max),
      resultMode: s.resultMode === 'live' ? 'live' : 'manual',
    };
  }
  // 自由記述・ワードクラウドは質問文だけを残す（ほかの項目は落とす）
  if (s.type === 'free' || s.type === 'cloud') {
    return { type: s.type, question: typeof s.question === 'string' ? s.question : '' };
  }
  // 保存された位置が枠の外・大きさ 0 でも、表示と編集で困らないように直す
  // 図形は、種類・色などの値も正す（文字・画像は今までどおり位置と大きさだけ）
  const items = toArray(s.items).map((it) => {
    if (!it || typeof it !== 'object') return it;
    return it.kind === 'shape' ? normalizeShapeItem(it) : clampItem(it);
  });
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
    if (!s || (!isChoiceSlide(s) && s.type !== 'free' && s.type !== 'cloud')) return;
    const n = `${i + 1} 枚目`;
    // 自由記述・ワードクラウド・評価は質問文だけを確かめる（評価の選択肢は 1〜5 で決まっている）
    if (s.type === 'free' || s.type === 'cloud' || s.type === 'rating') {
      if (String(s.question || '').trim() === '') problems.push(`${n}: 質問文を入れてください。`);
      return;
    }
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
