// スライドを 16:9 の枠に描く。編集・発表・生徒の画面で共通に使う。
// 文字は textContent で出す。画像の src は教材の images のデータ URL だけ。
// 図形は createElementNS で組み立てた SVG（色・数は model.js で正した値だけを属性に入れる）。
import { el } from './ui.js';
import { clampItem, ratingOptions, normalizeShapeItem, shapeDrawing } from './model.js';
import { youTubeEmbedUrl } from './video.js';
import { clampStep, isItemVisible } from './animation.js';

// 同じ描画先の直前の回数。初回・同じ回数・戻るときには要素をフェードしない。
const renderedSteps = new WeakMap();

// 文字の大きさ（枠の幅に対する %）
export const TEXT_SIZE_PCT = { s: 2.5, m: 4, l: 6, xl: 9 };

// 文字に使える色（要件定義書 7.2 の配色と黒）
export const TEXT_COLORS = [
  { value: '#1F2A6B', label: 'ネイビー' },
  { value: '#3F63F6', label: 'メインブルー' },
  { value: '#45D0C2', label: 'アクセント' },
  { value: '#E8576A', label: '危険' },
  { value: '#A88CF6', label: '補助紫' },
  { value: '#000000', label: '黒' },
];

export const OPTION_MARKS = ['A', 'B', 'C', 'D', 'E', 'F'];

// 図形の種類の名前（編集画面のボタン・読み上げに使う）
export const SHAPE_NAMES = { rect: '四角形', ellipse: '円', triangle: '三角形', line: '線', arrow: '矢印' };

const ALIGNS = ['left', 'center', 'right'];

// コンテナクエリ（cqw）を使えない古いブラウザでは、枠の幅から 1% の大きさを計る
const HAS_CQW = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('width', '1cqw');

function watchWidth(frame) {
  if (HAS_CQW || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver((entries) => {
    // 枠が画面から外れたら見張りをやめる
    if (!frame.isConnected) { ro.disconnect(); return; }
    for (const e of entries) frame.style.setProperty('--unit', `${e.contentRect.width / 100}px`);
  });
  ro.observe(frame);
}

// 要素の位置と大きさ（割合）を style に置く。保存された値がおかしくても、枠の中に最小の大きさで出す
export function placeItem(node, item) {
  const { x, y, w, h } = clampItem(item);
  node.style.left = `${x * 100}%`;
  node.style.top = `${y * 100}%`;
  node.style.width = `${w * 100}%`;
  node.style.height = `${h * 100}%`;
}

// 文字の見た目（大きさ・太字・色・そろえ）を style に置く。編集中の入力欄にも使う
export function styleText(node, item) {
  node.style.setProperty('--fs', String(TEXT_SIZE_PCT[item.size] ?? TEXT_SIZE_PCT.m));
  node.style.fontWeight = item.bold ? '700' : '400';
  const color = TEXT_COLORS.find((c) => c.value === String(item.color).toUpperCase());
  node.style.color = color ? color.value : TEXT_COLORS[0].value;
  node.style.textAlign = ALIGNS.includes(item.align) ? item.align : 'left';
}

function safeImageSrc(images, imageId) {
  const src = images && Object.hasOwn(images, imageId) ? images[imageId] : null;
  return typeof src === 'string' && src.startsWith('data:image/') ? src : null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// 属性に入れる数（長い小数を短くする）
const num = (v) => String(Math.round(v * 1000) / 1000);

// 図形の SVG を node の中に描き直す（編集中に箱の大きさが変わったときにも使う）。
// viewBox は「スライドの幅の 1%」を 1 とした箱の大きさなので、箱いっぱいに広げても縦横の比が変わらない
export function drawShape(node, item) {
  const d = shapeDrawing(item);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'slide-shape-svg');
  svg.setAttribute('viewBox', `0 0 ${num(d.width)} ${num(d.height)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const part of d.parts) {
    const shape = document.createElementNS(SVG_NS, part.tag);
    for (const [k, v] of Object.entries(part.attrs)) shape.setAttribute(k, typeof v === 'number' ? num(v) : v);
    if (part.points) shape.setAttribute('points', part.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' '));
    svg.append(shape);
  }
  node.querySelector('.slide-shape-svg')?.remove();
  node.prepend(svg);
}

function renderItem(item, images) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'shape') {
    const shape = normalizeShapeItem(item);
    const node = el('div', { class: 'slide-item slide-shape', dataset: { itemId: String(item.id ?? '') } });
    placeItem(node, shape);
    drawShape(node, shape);
    return node;
  }
  if (item.kind === 'image') {
    const node = el('div', { class: 'slide-item slide-image', dataset: { itemId: String(item.id ?? '') } });
    const src = safeImageSrc(images, item.imageId);
    if (src) node.append(el('img', { src, alt: 'スライドの画像', draggable: 'false' }));
    else node.append(el('span', { class: 'slide-image-missing', text: '画像がありません' }));
    placeItem(node, item);
    return node;
  }
  if (item.kind === 'text') {
    const node = el('div', { class: 'slide-item slide-text', dataset: { itemId: String(item.id ?? '') } });
    node.append(el('div', { class: 'slide-text-body', text: typeof item.text === 'string' ? item.text : '' }));
    placeItem(node, item);
    styleText(node, item);
    return node;
  }
  return null;
}

// アンケート・クイズのスライド: 質問文と A〜F の選択肢（結果は出さない）。
// correct: クイズの正解の番号。渡されたときだけ、その選択肢に「○ 正解」の印を付ける（渡されなければ印の要素は作らない）
function renderPoll(stage, slide, mode, badge, correct) {
  const options = Array.isArray(slide.options) ? slide.options : [];
  if (mode === 'thumb') stage.append(el('span', { class: 'slide-badge', text: badge }));
  stage.append(el('div', { class: 'slide-poll' },
    el('p', { class: 'slide-poll-question', text: typeof slide.question === 'string' ? slide.question : '' }),
    el('ol', { class: options.length >= 4 ? 'slide-poll-options is-grid' : 'slide-poll-options' },
      options.slice(0, OPTION_MARKS.length).map((opt, i) => el('li', { class: correct === i ? 'slide-poll-option is-correct' : 'slide-poll-option' },
        el('span', { class: 'slide-poll-mark', text: OPTION_MARKS[i] }),
        el('span', { class: 'slide-poll-text', text: typeof opt === 'string' ? opt : String(opt ?? '') }),
        correct === i ? el('span', { class: 'slide-poll-correct', text: '○ 正解' }) : null)))));
}

// 5 段階評価のスライド: 質問文と、横に並ぶ 1〜5 の枠、その下の両はしの言葉（空なら出さない）
function renderRating(stage, slide, mode) {
  const low = typeof slide.lowLabel === 'string' ? slide.lowLabel : '';
  const high = typeof slide.highLabel === 'string' ? slide.highLabel : '';
  if (mode === 'thumb') stage.append(el('span', { class: 'slide-badge', text: '5 段階評価' }));
  stage.append(el('div', { class: 'slide-poll slide-rating' },
    el('p', { class: 'slide-poll-question', text: typeof slide.question === 'string' ? slide.question : '' }),
    el('ol', { class: 'slide-rating-scale' },
      ratingOptions().map((n) => el('li', { class: 'slide-rating-step', text: n }))),
    low || high
      ? el('div', { class: 'slide-rating-ends' },
        el('span', { class: 'slide-rating-low', text: low ? `1：${low}` : '' }),
        el('span', { class: 'slide-rating-high', text: high ? `5：${high}` : '' }))
      : null));
}

// 自由記述・ワードクラウドのスライド: 質問文と、押せない入力欄の見本。
// 見本は .slide-free-sample（まとめて aria-hidden）。生徒・発表の画面は sample: false で見本を出さず、自分の部品を足す
// boxes は見本の入力欄（自由記述は大きい 1 つ、ワードクラウドは 1 行の 3 つ）
function renderAsk(stage, slide, mode, sample, badge, boxes) {
  if (mode === 'thumb') stage.append(el('span', { class: 'slide-badge', text: badge }));
  stage.append(el('div', { class: 'slide-free' },
    el('p', { class: 'slide-free-question', text: typeof slide.question === 'string' ? slide.question : '' }),
    sample
      ? el('div', { class: 'slide-free-sample', 'aria-hidden': 'true' },
        boxes(),
        el('span', { class: 'slide-free-send', text: '送信' }))
      : null));
}

const FREE_BOXES = () => el('div', { class: 'slide-free-box', text: 'ここに答えを書きます' });
const CLOUD_BOXES = () => el('div', { class: 'slide-cloud-boxes' },
  ['言葉 1', '言葉 2', '言葉 3'].map((t) => el('div', { class: 'slide-cloud-box', text: t })));

// container の中身を、slide を描いた 16:9 の枠に置きかえる。mode: 'view'（大きく見せる）か 'thumb'（縮小表示）
// sample: 自由記述・ワードクラウドの入力欄の見本を出すか（既定は出す。縮小表示では常に出す）
// correct: クイズの正解の番号。渡したときだけ正解の印を描く（既定は描かない。
// 発表・生徒の画面は「正解を表示」のあとだけ渡す。編集の画面は先生の準備の画面なので渡してよい）
// player: 明示したときだけ動画を読みこむ。縮小表示には常に見本を出す。
// step: 省略・数でないときは全部を見せる。animate: 途中参加・再接続では false。
export function renderSlide(container, slide, images, { mode = 'view', sample = true, correct = null, player = false, step, slideId = slide, animate = true } = {}) {
  const current = mode !== 'thumb' && Number.isFinite(step) ? clampStep(slide, step) : null;
  const previous = renderedSteps.get(container);
  const fade = animate && previous && previous.slideId === slideId
    && Number.isFinite(previous.step) && current !== null && current > previous.step;
  const stage = el('div', { class: 'slide-stage' });
  const frame = el('div', { class: mode === 'thumb' ? 'slide-frame slide-thumb' : 'slide-frame' }, stage);
  if (mode === 'thumb') frame.setAttribute('aria-hidden', 'true');
  if (slide && slide.type === 'poll') {
    frame.classList.add('slide-is-poll');
    renderPoll(stage, slide, mode, 'アンケート', null);
  } else if (slide && slide.type === 'quiz') {
    frame.classList.add('slide-is-poll', 'slide-is-quiz');
    renderPoll(stage, slide, mode, 'クイズ', Number.isInteger(correct) ? correct : null);
  } else if (slide && slide.type === 'rating') {
    frame.classList.add('slide-is-rating');
    renderRating(stage, slide, mode);
  } else if (slide && slide.type === 'free') {
    frame.classList.add('slide-is-free');
    renderAsk(stage, slide, mode, mode === 'thumb' || sample, '自由記述', FREE_BOXES);
  } else if (slide && slide.type === 'cloud') {
    frame.classList.add('slide-is-cloud');
    renderAsk(stage, slide, mode, mode === 'thumb' || sample, 'ワードクラウド', CLOUD_BOXES);
  } else if (slide && slide.type === 'video') {
    frame.classList.add('slide-is-video');
    const iframe = player === true && mode !== 'thumb' ? createVideoPlayer(slide) : null;
    if (iframe) stage.append(iframe);
    else {
      stage.append(el('div', { class: 'slide-video-sample' },
        el('span', { class: 'slide-video-mark', 'aria-hidden': 'true', text: '▶' }),
        el('p', { class: 'slide-video-label', text: mode === 'thumb' ? '動画' : '動画（YouTube）' }),
        mode !== 'thumb' && slide.caption ? el('p', { class: 'slide-video-caption', text: slide.caption }) : null,
        player === true && mode !== 'thumb' ? el('p', { class: 'slide-video-missing', text: '動画の URL がありません。' }) : null));
    }
  } else if (slide && Array.isArray(slide.items)) {
    for (const item of slide.items) {
      const node = renderItem(item, images);
      if (node) {
        node.hidden = !isItemVisible(slide, item, current);
        if (!node.hidden && fade && !isItemVisible(slide, item, previous.step)) node.classList.add('slide-item-enter');
        stage.append(node);
      }
    }
  }
  container.replaceChildren(frame);
  renderedSteps.set(container, { slideId, step: current });
  watchWidth(frame);
}

// プレーヤーはここだけで作る。保存データの ID も URL の組み立て時に確かめる。
export function createVideoPlayer(slide) {
  const src = youTubeEmbedUrl(slide);
  if (!src) return null;
  return el('iframe', {
    class: 'slide-video-player', src, title: slide.caption || 'YouTube の動画',
    allow: 'encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin',
    sandbox: 'allow-scripts allow-same-origin allow-presentation',
  });
}
