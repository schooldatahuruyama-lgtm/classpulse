// PDF から教材を作るときの、判定・大きさ・教材の組み立て・知らせる文。
// DOM・pdf.js・通信に触れない純粋なモジュール。
import { CONFIG } from './config.js';
import { createDeck, newId, MIN_ITEM_SIZE } from './model.js';

const DEFAULT_TITLE = 'PDF の教材';
const TITLE_MAX = 100; // 今の教材名には上限が無いので 100

// ファイルの検査。よければ null
export function checkPdfFile({ name, type, size }) {
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(String(name || ''));
  if (!isPdf) return { code: 'not-pdf' };
  if (size > CONFIG.pdf.maxFileBytes) return { code: 'too-large' };
  return null;
}

// ページ数の検査。よければ null
export function checkPageCount(n) {
  if (!Number.isInteger(n) || n < 1) return { code: 'broken' };
  if (n > CONFIG.pdf.maxPages) return { code: 'too-many', pages: n };
  return null;
}

// 1 枚の画像の大きさ（文字数）の上限。全ページの合計が教材の上限に収まるようにする
export function pageBudget(pageCount) {
  return Math.min(CONFIG.image.maxBytes, Math.floor(CONFIG.image.deckMaxBytes / pageCount));
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ページを 16:9 のスライドに、縦横比を保って収まる最大の大きさで中央に置く（割合 0〜1）。
// 4:3 などが正確な値になるよう、大きさは小数 6 けたで丸める。
// 極端に細長いページは、編集画面の clampItem と同じ最小の大きさ（MIN_ITEM_SIZE）にそろえる
export function fitToSlide(pageWidth, pageHeight) {
  const r = (pageWidth / pageHeight) / (16 / 9); // スライドに対するページの 幅 / 高さ
  let w = 1;
  let h = 1;
  if (r < 1) w = round6(r);
  else h = round6(1 / r);
  w = Math.min(1, Math.max(MIN_ITEM_SIZE, w));
  h = Math.min(1, Math.max(MIN_ITEM_SIZE, h));
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// ファイル名から教材名を作る
export function titleFromFileName(name) {
  const t = String(name || '').trim().replace(/\.pdf$/i, '').trim().slice(0, TITLE_MAX).trim();
  return t === '' ? DEFAULT_TITLE : t;
}

// pages: [{ dataUrl, width, height }]。1 ページ = 画像の要素 1 つの content スライド 1 枚
export function buildDeckFromPages(title, pages, now, makeId = newId) {
  let deck = createDeck(title, now);
  const order = [];
  const slides = {};
  const images = {};
  for (const p of pages) {
    const slideId = makeId();
    const imageId = makeId();
    const itemId = makeId();
    order.push(slideId);
    images[imageId] = p.dataUrl;
    slides[slideId] = {
      type: 'content',
      items: [{ id: itemId, kind: 'image', ...fitToSlide(p.width, p.height), imageId }],
    };
  }
  deck = { ...deck, order, slides, images };
  return deck;
}

// 画面に出す文。cancelled は何も出さない（null）
export function importMessage(error) {
  const code = error && error.code;
  if (code === 'cancelled') return null;
  if (code === 'too-many') {
    return `この PDF は ${error.pages} ページあります。取り込めるのは ${CONFIG.pdf.maxPages} ページまでです。ページを減らした PDF で、もう一度ためしてください。`;
  }
  if (code === 'password') return 'パスワードの付いた PDF は取り込めません。';
  if (code === 'too-large') return `ファイルが大きすぎます（${Math.floor(CONFIG.pdf.maxFileBytes / 1048576)}MB まで）。`;
  if (code === 'not-pdf') return 'PDF ファイルを選んでください。';
  return 'この PDF を読みこめませんでした。ファイルがこわれていないか確かめてください。';
}
