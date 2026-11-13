// 図形の要素（kind:'shape'）: 作成・正し方・重なりの順番・描くための座標
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShapeItem, normalizeShapeItem, normalizeDeck, bringToFront, sendToBack,
  shapeGeometry, shapeDrawing, clampItem, duplicateSlide, SHAPE_KINDS, MIN_ITEM_SIZE,
} from '../js/model.js';
import { CONFIG } from '../js/config.js';

const { defaultFill, defaultStroke } = CONFIG.shape;

// ---- 色の一覧 ----

// WCAG の相対輝度とコントラスト比
function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('色の一覧: 値はすべて #RRGGBB（大文字）、名前は空でない、重複が無い', () => {
  const { colors } = CONFIG.shape;
  assert.ok(colors.length >= 5);
  for (const c of colors) {
    assert.match(c.value, /^#[0-9A-F]{6}$/);
    assert.equal(typeof c.name, 'string');
    assert.ok(c.name.trim().length > 0);
  }
  assert.equal(new Set(colors.map((c) => c.value)).size, colors.length);
  assert.equal(new Set(colors.map((c) => c.name)).size, colors.length);
});

test('色の一覧: どの色も線に使える。既定の線の色は、白い背景との差が 3:1 以上', () => {
  // 線の色をしぼらない: 写真や PDF の上に置くので、白い背景との差だけでは決められない（先生がえらぶ）
  for (const c of CONFIG.shape.colors) assert.equal(c.stroke, true, c.name);
  assert.ok(contrast(defaultStroke, '#FFFFFF') >= 3);
});

test('既定の色は一覧にあり、既定の線の色は線に使える色', () => {
  const { colors } = CONFIG.shape;
  assert.ok(colors.some((c) => c.value === defaultFill));
  assert.ok(colors.some((c) => c.value === defaultStroke && c.stroke));
});

test('線の太さは s・m・l の 3 つで、正の数', () => {
  const { widths } = CONFIG.shape;
  assert.deepEqual(Object.keys(widths).sort(), ['l', 'm', 's']);
  assert.ok(widths.s > 0 && widths.s < widths.m && widths.m < widths.l);
});

// ---- 作成 ----

test('createShapeItem: 5 種類の形と既定値（種類に合う項目だけ）', () => {
  assert.deepEqual(SHAPE_KINDS, ['rect', 'ellipse', 'triangle', 'line', 'arrow']);
  for (const shape of ['rect', 'ellipse', 'triangle']) {
    const it = createShapeItem('s1', shape);
    assert.equal(it.id, 's1');
    assert.equal(it.kind, 'shape');
    assert.equal(it.shape, shape);
    assert.equal(it.fill, defaultFill);
    assert.equal(it.stroke, defaultStroke);
    assert.equal(it.strokeWidth, 'm');
    assert.equal('dir' in it, false);
    assert.equal('head' in it, false);
  }
  const line = createShapeItem('l1', 'line');
  assert.equal('fill' in line, false);
  assert.equal(line.dir, 'h');
  assert.equal('head' in line, false);
  assert.equal(line.stroke, defaultStroke);
  const arrow = createShapeItem('a1', 'arrow');
  assert.equal('fill' in arrow, false);
  assert.equal(arrow.dir, 'h');
  assert.equal(arrow.head, 'end');
});

test('createShapeItem: 箱は枠の中で、正しい形のまま（正しても変わらない）', () => {
  for (const shape of SHAPE_KINDS) {
    const it = createShapeItem('x', shape);
    assert.deepEqual(clampItem(it), it);
    assert.deepEqual(normalizeShapeItem(it), it);
    // 中央あたりに置く
    assert.ok(Math.abs(it.x + it.w / 2 - 0.5) < 1e-9);
    assert.ok(Math.abs(it.y + it.h / 2 - 0.5) < 1e-9);
  }
  // 四角形・円・三角形は、画面の上で正方形（16:9 の枠で w*16 = h*9）
  const r = createShapeItem('x', 'rect');
  assert.ok(Math.abs(r.w * 16 - r.h * 9) < 1e-9);
});

test('createShapeItem: 知らない種類は四角形', () => {
  assert.equal(createShapeItem('x', 'star').shape, 'rect');
});

// ---- 読むときの正し方 ----

const rect = (patch = {}) => ({ ...createShapeItem('r', 'rect'), ...patch });

test('normalizeShapeItem: 知らない shape は rect', () => {
  assert.equal(normalizeShapeItem(rect({ shape: 'star' })).shape, 'rect');
  assert.equal(normalizeShapeItem(rect({ shape: '<script>' })).shape, 'rect');
  assert.equal(normalizeShapeItem({ kind: 'shape' }).shape, 'rect');
});

test('normalizeShapeItem: 決まった色に無い値は既定の色、none は残る', () => {
  for (const bad of ['red', '<script>alert(1)</script>', 123, null, '#12345', '#3f63f6x', { a: 1 }]) {
    const n = normalizeShapeItem(rect({ fill: bad, stroke: bad }));
    assert.equal(n.fill, defaultFill, String(bad));
    assert.equal(n.stroke, defaultStroke, String(bad));
  }
  assert.equal(normalizeShapeItem(rect({ fill: 'none' })).fill, 'none');
  assert.equal(normalizeShapeItem(rect({ stroke: 'none' })).stroke, 'none');
  // 小文字の色は大文字にそろえる
  assert.equal(normalizeShapeItem(rect({ fill: '#e8576a' })).fill, '#E8576A');
});

test('normalizeShapeItem: 一覧にある色は、塗りにも線にもそのまま使える', () => {
  const yellow = CONFIG.shape.colors.find((c) => c.name === 'きいろ');
  const n = normalizeShapeItem(rect({ fill: yellow.value, stroke: yellow.value }));
  assert.equal(n.fill, yellow.value);
  assert.equal(n.stroke, yellow.value);
});

test('normalizeShapeItem: 塗りも線も none なら、線を既定の色に', () => {
  const n = normalizeShapeItem(rect({ fill: 'none', stroke: 'none' }));
  assert.equal(n.fill, 'none');
  assert.equal(n.stroke, defaultStroke);
});

test('normalizeShapeItem: 線と矢印の線は none にできない（塗りが無いので見えなくなる）', () => {
  const n = normalizeShapeItem({ ...createShapeItem('l', 'line'), stroke: 'none' });
  assert.equal(n.stroke, defaultStroke);
});

test('normalizeShapeItem: 知らない strokeWidth・dir・head は既定値', () => {
  assert.equal(normalizeShapeItem(rect({ strokeWidth: 'xl' })).strokeWidth, 'm');
  const a = normalizeShapeItem({ ...createShapeItem('a', 'arrow'), dir: 'x', head: 'none' });
  assert.equal(a.dir, 'h');
  assert.equal(a.head, 'end');
  const ok = normalizeShapeItem({ ...createShapeItem('a', 'arrow'), dir: 'd2', head: 'both', strokeWidth: 'l' });
  assert.equal(ok.dir, 'd2');
  assert.equal(ok.head, 'both');
  assert.equal(ok.strokeWidth, 'l');
});

test('normalizeShapeItem: 種類に合わない項目は落とす', () => {
  const r = normalizeShapeItem(rect({ dir: 'v', head: 'both', text: 'x', onclick: 'y' }));
  assert.deepEqual(Object.keys(r).sort(), ['fill', 'h', 'id', 'kind', 'shape', 'stroke', 'strokeWidth', 'w', 'x', 'y']);
  const l = normalizeShapeItem({ ...createShapeItem('l', 'line'), fill: '#3F63F6', head: 'both' });
  assert.deepEqual(Object.keys(l).sort(), ['dir', 'h', 'id', 'kind', 'shape', 'stroke', 'strokeWidth', 'w', 'x', 'y']);
  const a = normalizeShapeItem({ ...createShapeItem('a', 'arrow'), fill: '#3F63F6' });
  assert.deepEqual(Object.keys(a).sort(), ['dir', 'h', 'head', 'id', 'kind', 'shape', 'stroke', 'strokeWidth', 'w', 'x', 'y']);
});

test('normalizeShapeItem: 箱がはみ出す値は clampItem と同じに収まる', () => {
  const bad = rect({ x: 0.9, y: -3, w: 2, h: 0, });
  const n = normalizeShapeItem(bad);
  const c = clampItem(bad);
  assert.deepEqual([n.x, n.y, n.w, n.h], [c.x, c.y, c.w, c.h]);
  assert.ok(n.x >= 0 && n.x + n.w <= 1 && n.y >= 0 && n.y + n.h <= 1);
  const nan = normalizeShapeItem(rect({ x: 'a', w: NaN }));
  assert.ok(Number.isFinite(nan.x) && Number.isFinite(nan.w));
});

test('normalizeShapeItem: 何度通しても変わらない・元を書きかえない', () => {
  const raw = { id: 'q', kind: 'shape', shape: 'arrow', x: 2, y: 0.5, w: 0.3, h: 0.1, stroke: 'blue', dir: 'd1', head: 'x', fill: '#000000' };
  const copy = JSON.parse(JSON.stringify(raw));
  const once = normalizeShapeItem(raw);
  assert.deepEqual(normalizeShapeItem(once), once);
  assert.deepEqual(raw, copy);
});

// ---- normalizeDeck ----

test('normalizeDeck: 図形・文字・画像がまざっていても、文字と画像は今までと同じ結果', () => {
  const text = { id: 't', kind: 'text', x: 1.5, y: 0.1, w: 0.4, h: 0.2, text: 'あ', size: 'zz', bold: 'x', color: 'red', align: 'q', extra: 1 };
  const image = { id: 'i', kind: 'image', x: 0, y: 0, w: 0, h: 2, imageId: 'p1' };
  const shape = { id: 's', kind: 'shape', shape: 'star', x: 0.1, y: 0.1, w: 0.2, h: 0.2, fill: '<script>', stroke: 'none' };
  const only = normalizeDeck({ title: 't', updatedAt: 1, order: ['a'], slides: { a: { type: 'content', items: [text, image] } } });
  const mixed = normalizeDeck({ title: 't', updatedAt: 1, order: ['a'], slides: { a: { type: 'content', items: [text, shape, image] } } });
  const items = mixed.slides.a.items;
  assert.deepEqual(items[0], only.slides.a.items[0]);
  assert.deepEqual(items[2], only.slides.a.items[1]);
  // 文字・画像は clampItem だけ（今までどおり）
  assert.deepEqual(items[0], clampItem(text));
  assert.deepEqual(items[2], clampItem(image));
  assert.equal(items[1].shape, 'rect');
  assert.equal(items[1].fill, defaultFill);
  // もう一度通しても変わらない
  assert.deepEqual(normalizeDeck(mixed), mixed);
});

test('normalizeDeck: 配列に見えるオブジェクトの items の図形も直す', () => {
  const d = normalizeDeck({ order: ['a'], slides: { a: { type: 'content', items: { 0: { id: 's', kind: 'shape', shape: 'line', dir: 'v' } } } } });
  assert.equal(d.slides.a.items[0].shape, 'line');
  assert.equal(d.slides.a.items[0].dir, 'v');
});

// ---- 重なりの順番 ----

const slideOf = (...ids) => ({ type: 'content', items: ids.map((id) => ({ id, kind: 'text' })) });
const ids = (s) => s.items.map((it) => it.id);

test('bringToFront: 最後に動かす。元は書きかえない', () => {
  const s = slideOf('a', 'b', 'c');
  assert.deepEqual(ids(bringToFront(s, 'a')), ['b', 'c', 'a']);
  assert.deepEqual(ids(bringToFront(s, 'b')), ['a', 'c', 'b']);
  assert.deepEqual(ids(bringToFront(s, 'c')), ['a', 'b', 'c']);
  assert.deepEqual(ids(s), ['a', 'b', 'c']);
  assert.equal(bringToFront(s, 'a').type, 'content');
});

test('sendToBack: 最初に動かす。元は書きかえない', () => {
  const s = slideOf('a', 'b', 'c');
  assert.deepEqual(ids(sendToBack(s, 'c')), ['c', 'a', 'b']);
  assert.deepEqual(ids(sendToBack(s, 'b')), ['b', 'a', 'c']);
  assert.deepEqual(ids(sendToBack(s, 'a')), ['a', 'b', 'c']);
  assert.deepEqual(ids(s), ['a', 'b', 'c']);
});

test('bringToFront・sendToBack: 見つからない ID・items が無いスライドは元のまま', () => {
  const s = slideOf('a', 'b');
  assert.deepEqual(bringToFront(s, 'zz'), s);
  assert.deepEqual(sendToBack(s, 'zz'), s);
  const poll = { type: 'poll', question: 'q', options: ['x', 'y'] };
  assert.deepEqual(bringToFront(poll, 'a'), poll);
  assert.deepEqual(sendToBack(poll, 'a'), poll);
});

test('複製したスライドでも、図形と重なりの順番が保たれる', () => {
  const s = { type: 'content', items: [createShapeItem('s1', 'rect'), { id: 't1', kind: 'text' }, createShapeItem('s2', 'arrow')] };
  const deck = { title: 't', updatedAt: 1, order: ['a'], slides: { a: sendToBack(s, 's2') }, images: {} };
  let n = 0;
  const d2 = duplicateSlide(deck, 'a', 'b', () => `n${++n}`);
  assert.deepEqual(d2.slides.b.items.map((it) => it.shape || it.kind), ['arrow', 'rect', 'text']);
  assert.deepEqual(d2.slides.b.items.map((it) => it.id), ['n1', 'n2', 'n3']);
  assert.equal(d2.slides.b.items[0].head, 'end');
});

// ---- 描くための座標 ----

test('shapeGeometry: 線の向き 4 通りの始点と終点（箱を 0〜1 とした座標）', () => {
  const g = (dir) => shapeGeometry({ ...createShapeItem('l', 'line'), dir });
  assert.deepEqual(g('h').line, { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  assert.deepEqual(g('v').line, { x1: 0.5, y1: 0, x2: 0.5, y2: 1 });
  assert.deepEqual(g('d1').line, { x1: 0, y1: 0, x2: 1, y2: 1 });
  assert.deepEqual(g('d2').line, { x1: 0, y1: 1, x2: 1, y2: 0 });
});

test('shapeGeometry: 三角形の 3 点、四角形・円は箱いっぱい', () => {
  assert.deepEqual(shapeGeometry(createShapeItem('t', 'triangle')).points, [[0.5, 0], [1, 1], [0, 1]]);
  assert.deepEqual(shapeGeometry(createShapeItem('r', 'rect')).box, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(shapeGeometry(createShapeItem('e', 'ellipse')).box, { x: 0, y: 0, w: 1, h: 1 });
});

test('shapeGeometry: 矢印の先（終わり・始め・両方）。線には先が無い', () => {
  const a = (head) => shapeGeometry({ ...createShapeItem('a', 'arrow'), head }).heads;
  assert.deepEqual(a('end'), { start: false, end: true });
  assert.deepEqual(a('start'), { start: true, end: false });
  assert.deepEqual(a('both'), { start: true, end: true });
  assert.deepEqual(shapeGeometry(createShapeItem('l', 'line')).heads, { start: false, end: false });
});

test('shapeGeometry: 正していない値でも落ちない（知らない種類は四角形）', () => {
  assert.deepEqual(shapeGeometry({ shape: 'star' }).box, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(shapeGeometry(null).box, { x: 0, y: 0, w: 1, h: 1 });
});

// shapeDrawing: スライドの幅の 1% を 1 とした単位で描く（どの画面でも、線の太さはスライドの幅に比例する）

const near = (a, b) => Math.abs(a - b) < 1e-6;

test('shapeDrawing: 大きさは箱の割合 × スライドの幅（16:9）。線の太さは CONFIG の値そのまま', () => {
  const it = { ...createShapeItem('r', 'rect'), w: 0.5, h: 0.4, strokeWidth: 'l' };
  const d = shapeDrawing(it);
  assert.ok(near(d.width, 50));
  assert.ok(near(d.height, 0.4 * 100 * 9 / 16));
  assert.equal(d.strokeWidth, CONFIG.shape.widths.l);
});

test('shapeDrawing: 線の端・線の太さの分が箱からはみ出さない', () => {
  for (const shape of SHAPE_KINDS) {
    for (const dir of ['h', 'v', 'd1', 'd2']) {
      for (const strokeWidth of ['s', 'm', 'l']) {
        const it = { ...createShapeItem('x', shape), w: 0.3, h: 0.2, strokeWidth, ...(shape === 'line' || shape === 'arrow' ? { dir } : {}) };
        const d = shapeDrawing(it);
        const pad = d.strokeWidth / 2 - 1e-9;
        for (const p of d.parts) {
          const pts = [];
          if (p.tag === 'rect') pts.push([p.attrs.x, p.attrs.y], [p.attrs.x + p.attrs.width, p.attrs.y + p.attrs.height]);
          if (p.tag === 'ellipse') pts.push([p.attrs.cx - p.attrs.rx, p.attrs.cy - p.attrs.ry], [p.attrs.cx + p.attrs.rx, p.attrs.cy + p.attrs.ry]);
          if (p.tag === 'line') pts.push([p.attrs.x1, p.attrs.y1], [p.attrs.x2, p.attrs.y2]);
          if (p.tag === 'polygon' && p.role !== 'head') pts.push(...p.points);
          for (const [x, y] of pts) {
            assert.ok(x >= pad && x <= d.width - pad, `${shape} ${dir} ${strokeWidth} x=${x}`);
            assert.ok(y >= pad && y <= d.height - pad, `${shape} ${dir} ${strokeWidth} y=${y}`);
          }
        }
        // 矢印の先の先端も箱の中
        for (const p of d.parts.filter((q) => q.role === 'head')) {
          const [tx, ty] = p.points[0];
          assert.ok(tx >= 0 && tx <= d.width && ty >= 0 && ty <= d.height);
        }
      }
    }
  }
});

// 箱の大きさの組（最小の大きさを含む）。スライドの端（y:0・y:1-h）に置いても同じ
const SIZES = [MIN_ITEM_SIZE, 0.08, 0.15, 0.4, 1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 図形の部品が描く範囲（箱の単位）。線は太さの半分、丸い端の分だけふくらませる
function extents(d) {
  const r = d.strokeWidth / 2;
  const out = [];
  for (const p of d.parts) {
    const a = p.attrs;
    const sr = a.stroke && a.stroke !== 'none' ? r : 0;
    if (p.tag === 'rect') out.push([a.x - sr, a.y - sr], [a.x + a.width + sr, a.y + a.height + sr]);
    if (p.tag === 'ellipse') out.push([a.cx - a.rx - sr, a.cy - a.ry - sr], [a.cx + a.rx + sr, a.cy + a.ry + sr]);
    if (p.tag === 'line') {
      for (const [x, y] of [[a.x1, a.y1], [a.x2, a.y2]]) out.push([x - sr, y - sr], [x + sr, y + sr]);
    }
    if (p.tag === 'polygon') for (const [x, y] of p.points) out.push([x - sr, y - sr], [x + sr, y + sr]);
  }
  return out;
}

test('shapeDrawing: どの大きさ・向き・矢印の先・太さでも、線と矢印の先の 3 点すべてが箱の中（0〜1）', () => {
  const eps = 1e-9;
  let count = 0;
  for (const shape of SHAPE_KINDS) {
    for (const w of SIZES) {
      for (const h of SIZES) {
        for (const dir of ['h', 'v', 'd1', 'd2']) {
          for (const head of ['end', 'start', 'both']) {
            for (const strokeWidth of ['s', 'm', 'l']) {
              const item = { ...createShapeItem('x', shape), x: 0, y: 1 - h, w, h, strokeWidth, dir, head };
              const d = shapeDrawing(item);
              for (const [x, y] of extents(d)) {
                const u = x / d.width;
                const v = y / d.height;
                assert.ok(u >= -eps && u <= 1 + eps && v >= -eps && v <= 1 + eps,
                  `${shape} w=${w} h=${h} ${dir} ${head} ${strokeWidth}: (${u}, ${v})`);
                count += 1;
              }
              // 矢印の先は、3 点とも（先端だけでなく）箱の中
              for (const p of d.parts.filter((q) => q.role === 'head')) {
                assert.equal(p.points.length, 3);
                for (const [x, y] of p.points) {
                  assert.ok(x >= -eps && x <= d.width + eps && y >= -eps && y <= d.height + eps,
                    `head ${shape} w=${w} h=${h} ${dir} ${head} ${strokeWidth}: (${x}, ${y})`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(count > 1000);
});

test('shapeDrawing: 箱をつぶすと矢印の先は相似のまま小さくなる（形はゆがまない）', () => {
  const shapeOf = (d) => {
    const [t, b1, b2] = d.parts.find((q) => q.role === 'head').points;
    const base = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
    return { len: dist(t, base), half: dist(b1, b2) / 2, sides: [dist(t, b1), dist(t, b2)] };
  };
  const wide = shapeOf(shapeDrawing({ ...createShapeItem('a', 'arrow'), dir: 'h', w: 0.6, h: 0.3, strokeWidth: 'l' }));
  for (const [dir, w, h] of [['h', 0.6, MIN_ITEM_SIZE], ['v', MIN_ITEM_SIZE, 0.6], ['d1', 0.6, MIN_ITEM_SIZE], ['d2', 0.8, 0.08]]) {
    const flat = shapeOf(shapeDrawing({ ...createShapeItem('a', 'arrow'), dir, w, h, strokeWidth: 'l' }));
    assert.ok(flat.len < wide.len, `${dir} ${w}x${h} は小さくなる`);
    assert.ok(near(flat.half / flat.len, wide.half / wide.len), `${dir} 相似`);
    assert.ok(near(flat.sides[0], flat.sides[1]), `${dir} 2 等辺`);
  }
});

test('shapeDrawing: 収まるときの矢印の先は、ふつうの大きさ（線の太さで決まる）', () => {
  for (const strokeWidth of ['s', 'm', 'l']) {
    const sw = CONFIG.shape.widths[strokeWidth];
    for (const [dir, w, h] of [['h', 0.4, 0.1], ['v', 0.1, 0.4], ['d1', 0.4, 0.4], ['d2', 0.5, 0.6]]) {
      const d = shapeDrawing({ ...createShapeItem('a', 'arrow'), head: 'both', dir, strokeWidth, w, h });
      for (const p of d.parts.filter((q) => q.role === 'head')) {
        const [t, b1, b2] = p.points;
        const len = dist(t, [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2]);
        assert.ok(near(len, 1.5 + 3 * sw), `${strokeWidth} ${dir}: ${len}`);
      }
    }
  }
});

test('shapeDrawing: スライドの端の平たい矢印（レビューの例 w:0.4, h:0.05, y:0）も欠けない', () => {
  for (const y of [0, 0.95]) {
    const d = shapeDrawing({ ...createShapeItem('a', 'arrow'), w: 0.4, h: 0.05, y, dir: 'h', strokeWidth: 'm' });
    for (const p of d.parts.filter((q) => q.role === 'head')) {
      for (const [px, py] of p.points) assert.ok(px >= 0 && px <= d.width && py >= 0 && py <= d.height, `(${px}, ${py})`);
    }
  }
});

test('shapeDrawing: 矢印の先は、線の向きの終わり・始め・両方に付く', () => {
  const heads = (head) => shapeDrawing({ ...createShapeItem('a', 'arrow'), head, w: 0.5, h: 0.2 })
    .parts.filter((q) => q.role === 'head').map((q) => q.points[0][0]);
  const [end] = heads('end');
  const [start] = heads('start');
  assert.ok(end > 25 && start < 25);
  assert.equal(heads('both').length, 2);
  assert.equal(shapeDrawing(createShapeItem('l', 'line')).parts.filter((q) => q.role === 'head').length, 0);
});

test('shapeDrawing: 色は正した値だけ（不正な値は属性に出ない）', () => {
  const d = shapeDrawing({ kind: 'shape', shape: 'star', fill: '"><script>alert(1)</script>', stroke: 'javascript:x', x: 0, y: 0, w: 0.2, h: 0.2 });
  const allowed = new Set([...CONFIG.shape.colors.map((c) => c.value), 'none']);
  for (const p of d.parts) {
    for (const [k, v] of Object.entries(p.attrs)) {
      if (k === 'fill' || k === 'stroke') assert.ok(allowed.has(v), `${k}=${v}`);
      else assert.equal(typeof v === 'number' || /^[a-z-]+$/.test(String(v)), true, `${k}=${v}`);
    }
  }
  assert.equal(JSON.stringify(d).includes('script'), false);
});
