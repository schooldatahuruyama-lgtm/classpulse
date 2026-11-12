// スライドを 16:9 の枠に描く。編集・発表・生徒の画面で共通に使う。
// 文字は textContent で出す。画像の src は教材の images のデータ URL だけ。
import { el } from './ui.js';
import { clampItem } from './model.js';

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

function renderItem(item, images) {
  if (!item || typeof item !== 'object') return null;
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

function renderPoll(stage, slide, mode) {
  const options = Array.isArray(slide.options) ? slide.options : [];
  if (mode === 'thumb') stage.append(el('span', { class: 'slide-badge', text: 'アンケート' }));
  stage.append(el('div', { class: 'slide-poll' },
    el('p', { class: 'slide-poll-question', text: typeof slide.question === 'string' ? slide.question : '' }),
    el('ol', { class: options.length >= 4 ? 'slide-poll-options is-grid' : 'slide-poll-options' },
      options.slice(0, OPTION_MARKS.length).map((opt, i) => el('li', { class: 'slide-poll-option' },
        el('span', { class: 'slide-poll-mark', text: OPTION_MARKS[i] }),
        el('span', { class: 'slide-poll-text', text: typeof opt === 'string' ? opt : String(opt ?? '') }))))));
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
export function renderSlide(container, slide, images, { mode = 'view', sample = true } = {}) {
  const stage = el('div', { class: 'slide-stage' });
  const frame = el('div', { class: mode === 'thumb' ? 'slide-frame slide-thumb' : 'slide-frame' }, stage);
  if (mode === 'thumb') frame.setAttribute('aria-hidden', 'true');
  if (slide && slide.type === 'poll') {
    frame.classList.add('slide-is-poll');
    renderPoll(stage, slide, mode);
  } else if (slide && slide.type === 'free') {
    frame.classList.add('slide-is-free');
    renderAsk(stage, slide, mode, mode === 'thumb' || sample, '自由記述', FREE_BOXES);
  } else if (slide && slide.type === 'cloud') {
    frame.classList.add('slide-is-cloud');
    renderAsk(stage, slide, mode, mode === 'thumb' || sample, 'ワードクラウド', CLOUD_BOXES);
  } else if (slide && Array.isArray(slide.items)) {
    for (const item of slide.items) {
      const node = renderItem(item, images);
      if (node) stage.append(node);
    }
  }
  container.replaceChildren(frame);
  watchWidth(frame);
}
