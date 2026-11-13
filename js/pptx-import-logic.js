// PowerPoint の読み取り・座標・教材の組み立て・案内文。DOM と通信は使わない。
import { CONFIG } from './config.js';
import { createDeck, createTextItem, clampItem, newId } from './model.js';
import { fitToSlide, abortable } from './pdf-import-logic.js';
import { parseXml } from './xml-read.js';

// slide-render.js と同じ値。描画モジュールを読み取り側に読みこまないため、ここにも置く。
const SIZES = { s: 2.5, m: 4, l: 6, xl: 9 };
const COLORS = ['#1F2A6B', '#3F63F6', '#45D0C2', '#E8576A', '#A88CF6', '#000000'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
const child = (node, name) => node?.children.find((n) => n.name === name);
const path = (node, ...names) => names.reduce((n, name) => child(n, name), node);
const error = (code = 'broken', extra = {}) => Object.assign(new Error(code), { code }, extra);

function descendants(node, name) {
  const found = [], pending = node ? [node] : [], seen = new Set();
  while (pending.length) {
    const n = pending.pop();
    if (seen.has(n)) throw error();
    seen.add(n);
    if (n.name === name) found.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) pending.push(n.children[i]);
  }
  return found;
}

export function checkPptxFile({ name, size } = {}) {
  if (!/\.pptx$/i.test(String(name || ''))) return { code: 'not-pptx' };
  if (size > CONFIG.pptx.maxFileBytes) return { code: 'too-large' };
  return null;
}

export function titleFromFileName(name) {
  return String(name || '').trim().replace(/\.pptx$/i, '').trim().slice(0, 100).trim() || 'PowerPoint の教材';
}

export function imageType(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return Object.hasOwn(MIME, ext) ? MIME[ext] : null;
}

export function imageBudget(count) {
  return Math.min(CONFIG.image.maxBytes, Math.floor(CONFIG.image.deckMaxBytes / Math.max(1, count)));
}

// パッケージ内の参照だけを認める。ppt/ の外へ出る途中の経路も認めない。
export function resolveTarget(part, target, mode) {
  if (mode === 'External' || typeof target !== 'string') return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  if (!target || target.startsWith('/') || /[\\:#?\u0000-\u001f]/.test(target)) return null;
  const parts = part.split('/').slice(0, -1);
  if (parts[0] !== 'ppt') return null;
  for (const bit of target.split('/')) {
    if (bit === '..') { if (parts.length <= 1) return null; parts.pop(); }
    else if (bit && bit !== '.') parts.push(bit);
  }
  return parts.length > 1 ? parts.join('/') : null;
}

const relsName = (part) => part.replace(/([^/]+)$/, '_rels/$1.rels');
function number(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw error();
  const n = Number(value);
  if (!Number.isFinite(n)) throw error();
  return n;
}
function box(xfrm) {
  const off = child(xfrm, 'a:off'), ext = child(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const b = { x: number(off.attrs.x, 0), y: number(off.attrs.y, 0), w: number(ext.attrs.cx, 0), h: number(ext.attrs.cy, 0) };
  if (b.w < 0 || b.h < 0) throw error();
  return b;
}
const placeholder = (node) => descendants(node, 'p:ph')[0];
const ownBox = (node) => box(path(node, 'p:spPr', 'a:xfrm'));
function placeholderBoxes(root) {
  const types = new Map(), indices = new Map();
  for (const node of descendants(root, 'p:sp')) {
    const ph = placeholder(node), b = ownBox(node);
    if (!ph || !b) continue;
    if (ph.attrs.type && !types.has(ph.attrs.type)) types.set(ph.attrs.type, b);
    const idx = ph.attrs.idx || '0';
    if (!indices.has(idx)) indices.set(idx, b);
  }
  return { types, indices };
}

function nearestColor(hex) {
  if (!/^[0-9a-f]{6}$/i.test(hex || '')) return COLORS[0];
  const rgb = (s) => [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
  const v = rgb(hex);
  // 背景を読まないため、各成分が 224 以上の色は白に近い色として扱う。
  if (v.every((n) => n >= 224)) return COLORS[0];
  const distance = (c) => rgb(c.slice(1)).reduce((sum, n, i) => sum + (n - v[i]) ** 2, 0);
  return COLORS.reduce((a, b) => distance(a) <= distance(b) ? a : b);
}

function textItem(node, geometry, width, skipped) {
  const body = child(node, 'p:txBody');
  if (!body) return null;
  const linesOfText = body.children.filter((n) => n.name === 'a:p').map((p) => p.children.map((n) => {
    if (n.name === 'a:br') return '\n';
    if (n.name === 'a:r' || n.name === 'a:fld') return child(n, 'a:t')?.text || '';
    return '';
  }).join('')).join('\n').split('\n');
  // 正規表現の後戻りを避け、長い改行列も一度ずつだけ調べる。
  while (linesOfText.length && /^[\t ]*$/.test(linesOfText[linesOfText.length - 1])) linesOfText.pop();
  let text = linesOfText.join('\n');
  if (!text.trim()) return null;
  if (text.length > CONFIG.pptx.maxTextLength) {
    text = text.slice(0, CONFIG.pptx.maxTextLength).replace(/[\uD800-\uDBFF]$/, '');
    skipped.other++;
  }
  const type = placeholder(node)?.attrs.type;
  const title = type === 'title' || type === 'ctrTitle';
  const rPr = descendants(body, 'a:rPr')[0];
  const pPr = descendants(body, 'a:pPr')[0];
  let size = title ? 'l' : 'm';
  if (rPr?.attrs.sz !== undefined) {
    const pct = number(rPr.attrs.sz, 0) / 100 * 12700 / width * 100;
    size = Object.keys(SIZES).reduce((a, b) => Math.abs(SIZES[a] - pct) <= Math.abs(SIZES[b] - pct) ? a : b);
  }
  const item = clampItem({
    ...createTextItem(''), ...geometry, text, size,
    bold: title || rPr?.attrs.b === '1',
    align: type === 'ctrTitle' || pPr?.attrs.algn === 'ctr' ? 'center' : pPr?.attrs.algn === 'r' ? 'right' : 'left',
    color: nearestColor(path(rPr, 'a:solidFill', 'a:srgbClr')?.attrs.val),
  });
  // 表示側の余白（左右 0.6%）と行高 1.35 も入れて、下端まで箱を広げる。
  const capacity = Math.max(0.5, (item.w * 100 - 1.2) / SIZES[size]);
  const lines = text.split('\n').reduce((sum, line) => {
    const units = [...line].reduce((n, c) => n + (/[\u0000-\u007f\uff61-\uff9f]/.test(c) ? 0.5 : 1), 0);
    return sum + Math.max(1, Math.ceil(units / capacity));
  }, 0);
  item.h = Math.min(1 - item.y, Math.max(item.h, (lines * SIZES[size] * 1.35 + 1.2) / 100 * 16 / 9));
  return clampItem(item);
}

// ZIP の読み手だけを受け取る。yieldTask はブラウザが中止の操作を受けるための休止。
export async function readPptx(zip, { name, signal, yieldTask = async () => {} } = {}) {
  const stop = () => { if (signal?.aborted) throw error('cancelled'); };
  const wait = (p) => abortable(p, signal, () => error('cancelled'));
  const readXml = async (part) => {
    stop();
    const data = await wait(zip.read(part, CONFIG.pptx.maxXmlBytes));
    stop();
    return parseXml(data);
  };
  const readRels = async (part, required = false) => {
    const rel = relsName(part);
    if (!zip.has(rel)) { if (required) throw error(); return new Map(); }
    const root = await readXml(rel);
    if (root.name !== 'Relationships') throw error();
    const result = new Map();
    for (const n of root.children) {
      if (n.name !== 'Relationship') continue;
      const { Id, Target, Type, TargetMode } = n.attrs;
      if (!Id || !Type || result.has(Id)) throw error();
      result.set(Id, { type: Type.split('/').pop(), target: resolveTarget(part, Target, TargetMode) });
    }
    return result;
  };
  // レイアウトとマスターは共有されるので、一度だけ読み、循環はキャッシュより先に調べる。
  const inherited = new Map();
  async function inheritance(part, expected, active) {
    if (active.has(part) || active.size >= CONFIG.pptx.maxXmlDepth) throw error();
    if (inherited.has(part)) return inherited.get(part);
    const next = new Set(active).add(part);
    const root = await readXml(part);
    if (root.name !== expected) throw error();
    const rels = await readRels(part);
    const nodes = [root];
    for (const rel of rels.values()) {
      if (!['slideLayout', 'slideMaster'].includes(rel.type) || !rel.target) continue;
      // マスターは所属する全レイアウトへの戻り参照を持つ。継承としてはたどらない。
      if (expected === 'p:sldMaster' && rel.type === 'slideLayout') continue;
      if (rel.type !== 'slideMaster' || expected !== 'p:sldLayout') throw error();
      if (nodes.length !== 1) throw error(); // 1 つのレイアウトが継承するマスターは 1 つ
      nodes.push(...await inheritance(rel.target, 'p:sldMaster', next));
    }
    inherited.set(part, nodes);
    return nodes;
  }
  try {
    stop();
    const presentation = await readXml('ppt/presentation.xml');
    if (presentation.name !== 'p:presentation') throw error();
    const rels = await readRels('ppt/presentation.xml', true);
    const sz = child(presentation, 'p:sldSz');
    const width = number(sz?.attrs.cx, 9144000), height = number(sz?.attrs.cy, 6858000);
    if (width <= 0 || height <= 0) throw error();
    const frame = fitToSlide(width, height);
    const skipped = { shape: 0, chart: 0, line: 0, image: 0, other: 0, hiddenSlide: 0 };
    const slides = [];
    let visible = 0;
    const ids = child(presentation, 'p:sldIdLst')?.children.filter((n) => n.name === 'p:sldId');
    if (!ids?.length || ids.length > CONFIG.pptx.maxEntries) throw error();
    const seenSlides = new Set();
    for (const id of ids) {
      await wait(yieldTask());
      stop();
      const rel = rels.get(id.attrs['r:id']);
      if (rel?.type !== 'slide' || !rel.target || seenSlides.has(rel.target)) throw error();
      seenSlides.add(rel.target);
      const root = await readXml(rel.target);
      if (root.name !== 'p:sld') throw error();
      if (root.attrs.show === '0' || root.attrs.show === 'false') { skipped.hiddenSlide++; continue; }
      visible++;
      if (visible > CONFIG.pptx.maxSlides) continue; // 全可視枚数を数えてから知らせる
      const slideRels = await readRels(rel.target);
      const ancestors = [];
      for (const r of slideRels.values()) {
        if (r.type !== 'slideLayout' || !r.target) continue;
        if (ancestors.length) throw error();
        ancestors.push(...await inheritance(r.target, 'p:sldLayout', new Set([rel.target])));
      }
      // 箱ごとにレイアウト全体を再探索しないよう、種類と番号の索引にする。
      const placeholders = ancestors.map(placeholderBoxes);
      const geometry = (node, transform) => {
        let b = ownBox(node);
        const ph = placeholder(node);
        if (!b && ph) {
          for (const { types, indices } of placeholders) {
            if (ph.attrs.type) {
              b = types.get(ph.attrs.type);
              if (!b && ph.attrs.idx !== undefined) b = indices.get(ph.attrs.idx);
            } else b = indices.get(ph.attrs.idx || '0');
            if (b) break;
          }
        }
        if (!b) b = { x: width * 0.05, y: height * (['title', 'ctrTitle'].includes(ph?.attrs.type) ? 0.05 : 0.25), w: width * 0.9, h: height * (['title', 'ctrTitle'].includes(ph?.attrs.type) ? 0.18 : 0.65) };
        const out = {
          x: frame.x + (transform.x + b.x * transform.sx) / width * frame.w,
          y: frame.y + (transform.y + b.y * transform.sy) / height * frame.h,
          w: b.w * transform.sx / width * frame.w, h: b.h * transform.sy / height * frame.h,
        };
        if (!Object.values(out).every(Number.isFinite)) throw error();
        return clampItem(out);
      };
      const tree = path(root, 'p:cSld', 'p:spTree');
      if (!tree) throw error();
      const items = [];
      const active = new Set();
      const walk = (parent, transform, depth = 0) => {
        if (active.has(parent) || depth > CONFIG.pptx.maxXmlDepth) throw error();
        active.add(parent);
        for (const n of parent.children) {
          if (['p:nvGrpSpPr', 'p:grpSpPr', 'p:extLst'].includes(n.name)) continue;
          if (n.name === 'p:grpSp') {
            if (n.attrs['r:id']) throw error(); // グループは木の中に書かれる。参照で再帰させない
            const xfrm = path(n, 'p:grpSpPr', 'a:xfrm');
            const b = box(xfrm), off = child(xfrm, 'a:chOff'), ext = child(xfrm, 'a:chExt');
            let next = transform;
            if (b && off && ext) {
              const cw = number(ext.attrs.cx, 0), ch = number(ext.attrs.cy, 0);
              if (cw < 0 || ch < 0) throw error();
              // 0 のときは、その軸を倍率 1 として扱う（0 で割らない）。
              const sx = cw === 0 ? 1 : b.w / cw, sy = ch === 0 ? 1 : b.h / ch;
              next = { x: transform.x + (b.x - number(off.attrs.x, 0) * sx) * transform.sx,
                y: transform.y + (b.y - number(off.attrs.y, 0) * sy) * transform.sy,
                sx: transform.sx * sx, sy: transform.sy * sy };
              if (!Object.values(next).every(Number.isFinite)) throw error();
            }
            walk(n, next, depth + 1);
          } else if (n.name === 'p:sp') {
            const item = textItem(n, geometry(n, transform), width, skipped);
            if (item) items.push(item);
            else skipped.shape++;
          } else if (n.name === 'p:pic') {
            const blip = path(n, 'p:blipFill', 'a:blip');
            const image = slideRels.get(blip?.attrs['r:embed']);
            const media = image?.type === 'image' ? image.target : null;
            if (!media || !imageType(media) || !zip.has(media)) skipped.image++;
            else items.push({ kind: 'image', ...geometry(n, transform), media });
          } else if (n.name === 'p:graphicFrame') skipped.chart++;
          else if (n.name === 'p:cxnSp') skipped.line++;
          else skipped.other++;
        }
        active.delete(parent);
      };
      walk(tree, { x: 0, y: 0, sx: 1, sy: 1 });
      slides.push({ items });
    }
    stop();
    if (visible > CONFIG.pptx.maxSlides) throw error('too-many', { slides: visible });
    if (!visible) throw error();
    return { title: titleFromFileName(name), slides, skipped };
  } catch (e) {
    stop();
    if (['cancelled', 'unsupported', 'too-many', 'broken'].includes(e?.code)) throw e;
    throw error();
  }
}

// images は media → JPEG のデータ URL。編集画面は全スライドの参照を調べるので共有できる。
export function buildDeckFromPptx(result, now, makeId = newId) {
  const deck = createDeck(result.title, now);
  const imageIds = new Map();
  for (const slide of result.slides) {
    const sid = makeId();
    const items = slide.items.map((item) => {
      if (item.kind === 'text') return clampItem({ ...item, id: makeId() });
      const dataUrl = result.images?.[item.media];
      if (!dataUrl) throw error();
      if (!imageIds.has(item.media)) {
        const iid = makeId();
        imageIds.set(item.media, iid);
        deck.images[iid] = dataUrl;
      }
      const { x, y, w, h } = clampItem(item);
      return { id: makeId(), kind: 'image', x, y, w, h, imageId: imageIds.get(item.media) };
    });
    deck.order.push(sid);
    deck.slides[sid] = { type: 'content', items };
  }
  return deck;
}

export function summaryMessage(result) {
  const labels = { shape: '図形', chart: '表・グラフ', line: '線', image: '画像', other: 'そのほか', hiddenSlide: '非表示のスライド' };
  const counts = Object.entries(labels).filter(([key]) => result.skipped[key] > 0).map(([key, label]) => `${label} ${result.skipped[key]}`);
  return `${result.slides.length} 枚のスライドを取りこみました。文字と画像だけを取りこんでいます。配置や文字の大きさは、元と同じにはなりません。見た目をそのまま使いたいときは、PowerPoint で PDF に書き出して「PDF から作る」を使ってください。${counts.length ? '\n取りこめなかったもの: ' + counts.join('、') : ''}`;
}

export function importMessage(e) {
  if (e?.code === 'not-pptx') return 'PowerPoint（.pptx）のファイルを選んでください。古い形式（.ppt）は、PowerPoint で .pptx に保存し直してください。';
  if (e?.code === 'too-large') return `ファイルが大きすぎます（${Math.floor(CONFIG.pptx.maxFileBytes / 1048576)}MB まで）。`;
  if (e?.code === 'too-many') return `このファイルは ${e.slides} 枚あります。取りこめるのは ${CONFIG.pptx.maxSlides} 枚までです。`;
  if (e?.code === 'unsupported') return 'このブラウザでは PowerPoint を取りこめません。ブラウザを新しくするか、PDF に書き出して「PDF から作る」を使ってください。';
  if (e?.code === 'cancelled') return 'PowerPoint の取りこみをやめました。教材は作っていません。';
  return 'この PowerPoint を読みこめませんでした。パスワードが付いていないか、ファイルがこわれていないか確かめてください。';
}
