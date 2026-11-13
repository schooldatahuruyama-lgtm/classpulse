import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../js/config.js';
import { normalizeDeck, validateDeck } from '../js/model.js';
import { openZip } from '../js/zip-read.js';
import { importPptx } from '../js/pptx-import.js';
import { mount as mountDashboard } from '../js/views/dashboard.js';
import { closeAllDialogs, confirmDialog } from '../js/ui.js';
import { checkPptxFile, titleFromFileName, imageType, imageBudget, resolveTarget, readPptx, buildDeckFromPptx, summaryMessage, importMessage } from '../js/pptx-import-logic.js';
import { TEXT_COLORS, TEXT_SIZE_PCT } from '../js/slide-render.js';
import { makeZip, rels, xfrm, sp, pic, slide, layout, pptxEntries, fileFrom } from './helpers/pptx-fixture.js';

const read = (entries, options = {}) => readPptx(openZip(makeZip(entries, { deflate: true })), { name: '授業.PPTX', ...options });
const only = async (xml, options) => (await read(pptxEntries([slide(xml)], options))).slides[0].items[0];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const contained = (item) => {
  for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(item[key]) && item[key] >= 0 && item[key] <= 1, key);
  assert.ok(item.x + item.w <= 1 && item.y + item.h <= 1);
};
const group = (items, { x = 1000000, y = 900000, w = 8000000, h = 4500000, cx = 0, cy = 0, cw = 4000000, ch = 2250000, attrs = '' } = {}) => `<p:grpSp ${attrs}><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/><a:chOff x="${cx}" y="${cy}"/><a:chExt cx="${cw}" cy="${ch}"/></a:xfrm></p:grpSpPr>${items}</p:grpSp>`;

test('PPTX: CONFIG の上限・ファイルの検査', () => {
  assert.deepEqual(CONFIG.pptx, { maxSlides: 100, maxFileBytes: 52428800, maxEntries: 5000,
    maxXmlBytes: 5242880, maxImageBytes: 31457280, maxTotalBytes: 209715200, maxXmlDepth: 200, maxTextLength: 2000 });
  assert.equal(checkPptxFile({ name: 'a.PPTX', size: 52428800 }), null);
  assert.deepEqual(checkPptxFile({ name: 'a.pptx', size: 52428801 }), { code: 'too-large' });
  for (const name of ['a.ppt', 'a.pdf', 'a.zip', '']) assert.deepEqual(checkPptxFile({ name }), { code: 'not-pptx' });
  assert.deepEqual(checkPptxFile({ name: 'a.ppt', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), { code: 'not-pptx' });
  assert.equal(titleFromFileName('  実験.PPTX  '), '実験');
  assert.equal(titleFromFileName('.pptx'), 'PowerPoint の教材');
  assert.equal(titleFromFileName('a'.repeat(110) + '.pptx').length, 100);
  assert.equal(imageBudget(1), 204800);
  assert.equal(imageBudget(100), 52428);
  assert.ok(imageBudget(100) * 100 <= CONFIG.image.deckMaxBytes);
});

test('PPTX: 宣言された順番・非表示・空スライド・項目の重なり順', async () => {
  const entries = pptxEntries([slide(sp('一') + '<p:cxnSp/>' + sp('二')), slide(sp('非表示'), 'show="0"'), slide('')], { order: [3, 2, 1] });
  const r = await read(entries);
  assert.equal(r.title, '授業');
  assert.equal(r.slides.length, 2);
  assert.equal(r.slides[0].items.length, 0);
  assert.deepEqual(r.slides[1].items.map((i) => i.text), ['一', '二']);
  assert.equal(r.skipped.hiddenSlide, 1);
  assert.equal(r.skipped.line, 1);
});

test('PPTX: 非表示を除いて 100 枚まで・超過時は実際の枚数', async () => {
  const hidden = slide('', 'show="0"');
  const entries = pptxEntries([...Array(100).fill(slide('')), hidden]);
  assert.equal((await read(entries)).slides.length, 100);
  await assert.rejects(read(pptxEntries([...Array(102).fill(slide('')), hidden])), { code: 'too-many', slides: 102 });
  await assert.rejects(read(pptxEntries([hidden])), { code: 'broken' });
});

test('PPTX: ふつうの箱と 16:9 の位置', async () => {
  const item = await only(sp('短文', { transform: xfrm(1600000, 900000, 8000000, 4500000) }));
  assert.deepEqual([item.x, item.y, item.w, item.h], [0.1, 0.1, 0.5, 0.5]);
});

test('PPTX: 箱の既定・題・中央の題', async () => {
  const a = await only(sp('題', { ph: 'type="title"' }));
  assert.equal(a.x, 0.05); assert.equal(a.y, 0.05); assert.equal(a.w, 0.9); assert.equal(a.h, 0.18);
  assert.equal(a.size, 'l'); assert.equal(a.bold, true);
  const b = await only(sp('本文'));
  assert.deepEqual([b.x, b.y, b.w, b.h], [0.05, 0.25, 0.9, 0.65]);
  assert.equal(b.size, 'm'); assert.equal(b.bold, false);
  assert.equal((await only(sp('中央', { ph: 'type="ctrTitle"' }))).align, 'center');
});

test('PPTX: レイアウト・マスターの箱を type と idx で継承、直接の箱を優先', async () => {
  const extra = {
    'ppt/slides/_rels/slide1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/layout1.xml']]),
    'ppt/slideLayouts/layout1.xml': layout(sp('', { ph: 'type="title"', transform: xfrm(3200000, 900000, 9600000, 3600000) }) + sp('', { ph: 'idx="2"' })),
    'ppt/slideLayouts/_rels/layout1.xml.rels': rels([['master', 'slideMaster', '../slideMasters/master1.xml']]),
    'ppt/slideMasters/master1.xml': layout(sp('', { ph: 'idx="2"', transform: xfrm(1600000, 1800000, 8000000, 4500000) }), true),
    // 実際のマスターが持つレイアウトへの戻り参照は継承の循環ではない。
    'ppt/slideMasters/_rels/master1.xml.rels': rels([['layout', 'slideLayout', '../slideLayouts/layout1.xml']]),
  };
  const r = await read(pptxEntries([slide(sp('題', { ph: 'type="title"' }) + sp('本文', { ph: 'idx="2"' }) + sp('直接', { ph: 'type="title"', transform: xfrm(0, 0, 16000000, 9000000) }))], { extra }));
  assert.deepEqual(r.slides[0].items.map(({ x, y, w, h }) => [x, y, w, h]), [[0.2, 0.1, 0.6, 0.4], [0.1, 0.2, 0.5, 0.5], [0, 0, 1, 1]]);
});

for (const [label, ph, layoutPh, masterPh, expected] of [
  ['レイアウトの type がなければ idx、マスターの type より先', 'type="body" idx="1"', ['idx="1"'], ['type="body"'], [0.2, 0.1, 0.6, 0.4]],
  ['レイアウトの idx が合っても type を優先', 'type="body" idx="1"', ['type="body" idx="2"', 'idx="1"'], [], [0.2, 0.1, 0.6, 0.4]],
  ['レイアウトに合う箱がなければマスターの type', 'type="body" idx="1"', ['type="title" idx="2"'], ['type="body" idx="3"'], [0.1, 0.2, 0.5, 0.5]],
  ['マスターでも type がなければ idx', 'type="body" idx="1"', ['idx="2"'], ['idx="1"'], [0.1, 0.2, 0.5, 0.5]],
  ['マスターでも idx より type を優先', 'type="body" idx="1"', [], ['type="body" idx="2"', 'idx="1"'], [0.1, 0.2, 0.5, 0.5]],
  ['type があり idx がなければ番号 0 を使わずマスターへ', 'type="body"', ['idx="0"'], ['type="body"'], [0.1, 0.2, 0.5, 0.5]],
  ['type も idx もなければ番号 0', 'sz="full"', ['type="obj"'], [], [0.2, 0.1, 0.6, 0.4]],
  ['両方に合う箱がなければ既定の位置', 'type="body" idx="1"', ['idx="2"'], ['idx="3"'], [0.05, 0.25, 0.9, 0.65]],
]) {
  test(`PPTX: プレースホルダーは ${label}`, async () => {
    const extra = {
      'ppt/slides/_rels/slide1.xml.rels': rels([['l', 'slideLayout', '../slideLayouts/l.xml']]),
      'ppt/slideLayouts/l.xml': layout(layoutPh.map((ph, i) => sp('', { ph, transform: xfrm(3200000 + i * 1600000, 900000, 9600000, 3600000) })).join('')),
      'ppt/slideLayouts/_rels/l.xml.rels': rels([['m', 'slideMaster', '../slideMasters/m.xml']]),
      'ppt/slideMasters/m.xml': layout(masterPh.map((ph, i) => sp('', { ph, transform: xfrm(1600000 + i * 1600000, 1800000, 8000000, 4500000) })).join(''), true),
    };
    const item = await only(sp('本文', { ph }), { extra });
    assert.deepEqual([item.x, item.y, item.w, item.h], expected);
  });
}

test('PPTX: スライド・レイアウト・マスターの継承以外の関係は読み取りを妨げない', async () => {
  const extra = {
    'ppt/slides/_rels/slide1.xml.rels': rels([
      ['notes', 'notesSlide', '../notesSlides/n.xml'], ['image', 'image', '../media/a.png'],
      ['link', 'hyperlink', 'https://example.invalid/', 'External'], ['chart', 'chart', '../charts/c.xml'],
      ['video', 'video', '../media/v.mp4'], ['l', 'slideLayout', '../slideLayouts/l.xml'],
    ]),
    'ppt/slideLayouts/l.xml': layout(),
    'ppt/slideLayouts/_rels/l.xml.rels': rels([
      ['image', 'image', '../media/a.png'], ['theme', 'theme', '../theme/t.xml'], ['m', 'slideMaster', '../slideMasters/m.xml'],
    ]),
    'ppt/slideMasters/m.xml': layout(sp('', { ph: 'type="body"', transform: xfrm(1600000, 1800000, 8000000, 4500000) }), true),
    'ppt/slideMasters/_rels/m.xml.rels': rels([
      ['image', 'image', '../media/a.png'], ['theme', 'theme', '../theme/t.xml'], ['l', 'slideLayout', '../slideLayouts/l.xml'],
    ]),
    'ppt/notesSlides/n.xml': '<p:notes/>', 'ppt/charts/c.xml': '<c:chartSpace/>',
    'ppt/theme/t.xml': '<a:theme/>', 'ppt/media/a.png': 'image bytes', 'ppt/media/v.mp4': 'video bytes',
  };
  const zip = openZip(makeZip(pptxEntries([slide(sp('本文', { ph: 'type="body"' }) + pic('image'))], { extra })));
  const reads = [];
  const r = await readPptx({ has: zip.has, read: (name, max) => { reads.push(name); return zip.read(name, max); } });
  const [text, image] = r.slides[0].items;
  assert.equal(text.text, '本文');
  assert.deepEqual([text.x, text.y, text.w, text.h], [0.1, 0.2, 0.5, 0.5]);
  assert.equal(image.media, 'ppt/media/a.png');
  assert.deepEqual(reads, ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slideLayouts/l.xml',
    'ppt/slideLayouts/_rels/l.xml.rels', 'ppt/slideMasters/m.xml', 'ppt/slideMasters/_rels/m.xml.rels']);
});

for (const descriptor of [false, true]) {
  test(`PPTX: ppt/ 外の項目とデータ記述子${descriptor ? 'あり' : 'なし'}の ZIP を読める`, async () => {
    const entries = pptxEntries([slide(sp('本文'))], { extra: {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      '_rels/.rels': rels([['r1', 'officeDocument', 'ppt/presentation.xml']]),
      'docProps/': '', 'docProps/core.xml': '<cp:coreProperties/>', 'docProps/app.xml': '<Properties/>',
    } });
    const zip = openZip(makeZip(entries, { deflate: true, descriptor }));
    const reads = [];
    const r = await readPptx({ has: zip.has, read: (name, max) => { reads.push(name); return zip.read(name, max); } });
    assert.equal(r.slides[0].items[0].text, '本文');
    assert.ok(reads.every((name) => name.startsWith('ppt/')));
  });
}

test('PPTX: 4:3 とサイズ省略時は中央に収める', async () => {
  for (const options of [{ width: 12000000, height: 9000000 }, { width: null }]) {
    const item = await only(sp('本文'), options);
    near(item.x, 0.125 + 0.05 * 0.75); near(item.w, 0.9 * 0.75);
    assert.equal(item.y, 0.25); contained(item);
  }
});

test('PPTX: 入れ子グループの倍率と原点・chOff', async () => {
  const shape = sp('短文', { transform: xfrm(200000, 200000, 400000, 500000) });
  const nested = group(group(shape, { x: 500000, y: 300000, w: 2000000, h: 1125000, cw: 1000000, ch: 562500, cx: 100000, cy: 100000 }));
  const item = await only(nested);
  near(item.x, (1000000 + (500000 + (200000 - 100000) * 2) * 2) / 16000000);
  near(item.y, (900000 + (300000 + (200000 - 100000) * 2) * 2) / 9000000);
  near(item.w, 400000 * 4 / 16000000);
  contained(item);
});

test('PPTX: 0 のグループと枠外の箱でも有限で枠内', async () => {
  const r = await read(pptxEntries([slide(group(sp('短文', { transform: xfrm(-2000000, 99999999, 0, 0) }), { cw: 0, ch: 0, w: 0, h: 0 }) + sp('大きい', { transform: xfrm(-1, -1, 99999999, 99999999) }))]));
  r.slides[0].items.forEach(contained);
});

test('PPTX: 通常の箱・グループ・継承した箱の負の a:off を読める', async () => {
  const transform = xfrm(-1600000, -900000, 8000000, 4500000);
  const extra = {
    'ppt/slides/_rels/slide1.xml.rels': rels([['l', 'slideLayout', '../slideLayouts/l.xml']]),
    'ppt/slideLayouts/l.xml': layout(sp('', { ph: 'idx="1"', transform })),
  };
  const items = sp('箱', { transform }) + group(sp('組', { transform }), { x: -1000000, y: -900000 }) + sp('継承', { ph: 'idx="1"' });
  const r = await read(pptxEntries([slide(items)], { extra }));
  assert.deepEqual(r.slides[0].items.map((item) => item.text), ['箱', '組', '継承']);
  for (const item of r.slides[0].items) {
    contained(item); assert.equal(item.x, 0); assert.equal(item.y, 0);
  }
});

test('PPTX: 段落・改行・フィールド・末尾の空行と HTML 風の文字', async () => {
  const body = '<a:p><a:r><a:t>&lt;script&gt;</a:t></a:r><a:r><a:t>&amp;lt;img onerror&amp;gt;</a:t></a:r><a:br/><a:fld><a:t>3</a:t></a:fld></a:p><a:p><a:r><a:t><![CDATA[<img onerror>]]></a:t></a:r></a:p><a:p/>';
  const item = await only(sp('', { body }));
  assert.equal(item.text, '<script>&lt;img onerror&gt;\n3\n<img onerror>');
});

test('PPTX: 文字の最初の書式・サイズ・太字・そろえ・RGB の近似', async () => {
  const body = '<a:p><a:pPr algn="r"/><a:r><a:rPr sz="5040" b="1"><a:solidFill><a:srgbClr val="E85769"/></a:solidFill></a:rPr><a:t>色</a:t></a:r><a:r><a:rPr sz="1000"/><a:t>文</a:t></a:r></a:p>';
  const item = await only(sp('', { body }));
  assert.equal(item.size, 'm'); assert.equal(item.bold, true); assert.equal(item.align, 'right'); assert.equal(item.color, '#E8576A');
  for (const [sz, expected] of [['2000', 's'], ['7500', 'l'], ['11000', 'xl']]) {
    assert.equal((await only(sp('', { body: `<a:p><a:r><a:rPr sz="${sz}"/><a:t>x</a:t></a:r></a:p>` }))).size, expected);
  }
});

test('PPTX: 白に近い色・色なし・テーマ色はネイビー', async () => {
  for (const fill of ['<a:srgbClr val="FFFFFF"/>', '<a:srgbClr val="E0E0E0"/>', '<a:schemeClr val="tx1"/>', '']) {
    const item = await only(sp('', { body: `<a:p><a:r><a:rPr><a:solidFill>${fill}</a:solidFill></a:rPr><a:t>文</a:t></a:r></a:p>` }));
    assert.equal(item.color, '#1F2A6B');
  }
});

test('PPTX: 2000 文字で切り、サロゲートを割らず、そのほかを一件数える', async () => {
  const r = await read(pptxEntries([slide(sp('あ'.repeat(1999) + '😀後'))]));
  assert.equal(r.slides[0].items[0].text, 'あ'.repeat(1999));
  assert.equal(r.skipped.other, 1);
});

test('PPTX: 長い改行列と最後の文字で固まらず、上限までに切る', async () => {
  const r = await read(pptxEntries([slide(sp('\n'.repeat(200000) + '終'))]));
  assert.equal(r.slides[0].items[0].text.length, 2000);
  assert.equal(r.skipped.other, 1);
});

test('PPTX: 色と文字サイズは表示側で使える値にそろう', async () => {
  for (const { value } of TEXT_COLORS) {
    const item = await only(sp('', { body: `<a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="${value.slice(1)}"/></a:solidFill></a:rPr><a:t>文</a:t></a:r></a:p>` }));
    assert.equal(item.color, value);
  }
  for (const [size, pct] of Object.entries(TEXT_SIZE_PCT)) {
    const sz = Math.round(pct * 16000000 / 12700);
    const item = await only(sp('', { body: `<a:p><a:r><a:rPr sz="${sz}"/><a:t>文</a:t></a:r></a:p>` }));
    assert.equal(item.size, size);
  }
});

test('PPTX: 画像形式の判定にオブジェクトの組み込み名を使わない', async () => {
  for (const suffix of ['constructor', '__proto__', 'toString']) assert.equal(imageType(`ppt/media/a.${suffix}`), null);
});

test('PPTX: 複数のレイアウト・マスターを重ねて参照する不正な関係をことわる', async () => {
  const extra = {
    'ppt/slides/_rels/slide1.xml.rels': rels([['a', 'slideLayout', '../slideLayouts/l.xml'], ['b', 'slideLayout', '../slideLayouts/l.xml']]),
    'ppt/slideLayouts/l.xml': layout(),
  };
  await assert.rejects(read(pptxEntries([slide(sp())], { extra })), { code: 'broken' });
  extra['ppt/slides/_rels/slide1.xml.rels'] = rels([['a', 'slideLayout', '../slideLayouts/l.xml']]);
  extra['ppt/slideLayouts/_rels/l.xml.rels'] = rels([['a', 'slideMaster', '../slideMasters/m.xml'], ['b', 'slideMaster', '../slideMasters/m.xml']]);
  extra['ppt/slideMasters/m.xml'] = layout('', true);
  await assert.rejects(read(pptxEntries([slide(sp())], { extra })), { code: 'broken' });
});

test('PPTX: 高さを行数に合わせて広げる、半角は半分・下端まで', async () => {
  const transform = xfrm(1600000, 900000, 8000000, 450000);
  const full = await only(sp('あ'.repeat(24), { transform }));
  const half = await only(sp('a'.repeat(24), { transform }));
  assert.ok(full.h > half.h); assert.ok(half.h > 0.05);
  const long = await only(sp('あ'.repeat(2000), { transform }));
  near(long.h, 1 - long.y);
});

test('PPTX: 図形・表とグラフ・線・画像・そのほかの数え方', async () => {
  const r = await read(pptxEntries([slide(sp(' ') + sp('文字がある図形') + '<p:graphicFrame/>' + '<p:cxnSp/>' + pic('missing') + '<p:contentPart/>')]));
  assert.deepEqual(r.skipped, { shape: 1, chart: 1, line: 1, image: 1, other: 1, hiddenSlide: 0 });
  assert.equal(r.slides[0].items.length, 1);
});

test('PPTX: 画像の形式・参照解決と危険な参照を数えて飛ばす', async () => {
  const targets = [
    ['png', '../media/a.png'], ['jpg', '../media/a.JPG'], ['jpeg', '../media/a.jpeg'], ['gif', '../media/a.gif'], ['bmp', '../media/a.bmp'], ['webp', '../media/a.webp'],
    ['svg', '../media/a.svg'], ['wmf', '../media/a.wmf'], ['emf', '../media/a.emf'], ['tiff', '../media/a.tiff'],
    ['outside', '../../x.png'], ['absolute', '/x.png'], ['external', 'https://example.invalid/x.png', 'External'],
    ['externalLocal', '../media/a.png', 'External'], ['encoded', '%2e%2e/%2e%2e/x.png'], ['missing', '../media/missing.png'],
  ];
  const extra = { 'ppt/slides/_rels/slide1.xml.rels': rels(targets.map(([id, target, mode]) => [id, 'image', target, mode])),
    ...Object.fromEntries(['png', 'JPG', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'wmf', 'emf', 'tiff'].map((ext) => [`ppt/media/a.${ext}`, 'bytes'])) };
  const entries = pptxEntries([slide(targets.map(([id]) => pic(id)).join(''))], { extra });
  const zip = openZip(makeZip(entries));
  const reads = [];
  const r = await readPptx({ has: zip.has, read: (name, max) => { reads.push(name); return zip.read(name, max); } });
  assert.equal(r.slides[0].items.length, 6);
  assert.equal(r.skipped.image, 10);
  assert.ok(reads.every((p) => p.startsWith('ppt/') && /\.xml(?:\.rels)?$/.test(p)));
  assert.equal(resolveTarget('ppt/slides/slide1.xml', '../media/image%201.png'), 'ppt/media/image 1.png');
  for (const v of ['../../x', '/x', '\\x', 'https://x', '..%5c..%5cx', '../media/x#y', '%00']) assert.equal(resolveTarget('ppt/slides/slide1.xml', v), null);
});

test('PPTX: 自分を指すレイアウトとスライドをことわる', async () => {
  for (const target of ['../slides/slide1.xml', '../slideLayouts/layout1.xml']) {
    const extra = {
      'ppt/slides/_rels/slide1.xml.rels': rels([['l', 'slideLayout', '../slideLayouts/layout1.xml']]),
      'ppt/slideLayouts/layout1.xml': layout(),
      'ppt/slideLayouts/_rels/layout1.xml.rels': rels([['self', 'slideLayout', target]]),
    };
    await assert.rejects(read(pptxEntries([slide(sp())], { extra })), { code: 'broken' });
  }
});

test('PPTX: 図形の ID が重複していても、通常の箱とグループの箱を両方取りこめる', async () => {
  const boxes = sp('一', { id: '1' }) + sp('二', { id: '1' });
  for (const xml of [boxes, group(boxes)]) {
    const r = await read(pptxEntries([slide(xml)]));
    assert.deepEqual(r.slides[0].items.map((item) => item.text), ['一', '二']);
    const deck = buildDeckFromPptx(r, 123);
    assert.notEqual(deck.slides[deck.order[0]].items[0].id, deck.slides[deck.order[0]].items[1].id);
    assert.deepEqual(normalizeDeck(deck), deck);
  }
});

test('PPTX: グループの自己参照・深すぎるグループをことわる', async () => {
  for (const xml of [group(sp(), { attrs: 'r:id="self"' }), '<p:grpSp>'.repeat(201) + sp() + '</p:grpSp>'.repeat(201)]) {
    await assert.rejects(read(pptxEntries([slide(xml)])), { code: 'broken' });
  }
});

test('PPTX: 不正な寸法・DOCTYPE・必須の部分の欠落は読めない', async () => {
  const variants = [pptxEntries([slide(sp())], { width: 0 }), pptxEntries([slide(sp())], { width: 'NaN' }),
    pptxEntries(['<!DOCTYPE p:sld>' + slide(sp())]), pptxEntries(['<p:sld/>']), {}];
  for (const entries of variants) await assert.rejects(read(entries), { code: 'broken' });
  await assert.rejects(readPptx({ read: async () => { throw new TypeError('bad'); } }), { code: 'broken' });
});

test('PPTX: 同じ画像を共有して教材に組み立て、normalizeDeck で変わらない', () => {
  const text = { kind: 'text', x: 0.1, y: 0.2, w: 0.8, h: 0.3, text: '<script>&lt;img onerror&gt;', size: 'm', bold: false, color: '#1F2A6B', align: 'left' };
  const image = { kind: 'image', x: 0.1, y: 0.1, w: 0.5, h: 0.5, media: 'ppt/media/a.png' };
  let id = 0;
  const r = { title: '教材', slides: [{ items: [text, image] }, { items: [image] }, { items: [] }], images: { [image.media]: 'data:image/jpeg;base64,AAA' } };
  const deck = buildDeckFromPptx(r, 123, () => `id${++id}`);
  assert.equal(deck.updatedAt, 123); assert.equal(deck.order.length, 3); assert.equal(Object.keys(deck.images).length, 1);
  assert.equal(deck.slides[deck.order[0]].items[1].imageId, deck.slides[deck.order[1]].items[0].imageId);
  assert.notEqual(deck.slides[deck.order[0]].items[1].id, deck.slides[deck.order[1]].items[0].id);
  assert.deepEqual(normalizeDeck(deck), deck); assert.deepEqual(validateDeck(deck), []);
  assert.ok(!JSON.stringify(deck).includes('ppt/media'));
  assert.equal(r.slides[0].items[0], text);
});

test('PPTX: まとめの文・0 は表示しない・各失敗の文', () => {
  const r = { slides: Array(12), skipped: { shape: 5, chart: 2, line: 3, image: 1, other: 1, hiddenSlide: 1 } };
  assert.equal(summaryMessage(r), '12 枚のスライドを取りこみました。文字と画像だけを取りこんでいます。配置や文字の大きさは、元と同じにはなりません。見た目をそのまま使いたいときは、PowerPoint で PDF に書き出して「PDF から作る」を使ってください。\n取りこめなかったもの: 図形 5、表・グラフ 2、線 3、画像 1、そのほか 1、非表示のスライド 1');
  assert.ok(!summaryMessage({ slides: [1], skipped: { shape: 0 } }).includes('取りこめなかったもの'));
  assert.equal(importMessage({ code: 'too-large' }), 'ファイルが大きすぎます（50MB まで）。');
  assert.equal(importMessage({ code: 'too-many', slides: 101 }), 'このファイルは 101 枚あります。取りこめるのは 100 枚までです。');
  assert.equal(importMessage({ code: 'cancelled' }), 'PowerPoint の取りこみをやめました。教材は作っていません。');
  assert.match(importMessage({ code: 'not-pptx' }), /古い形式（.ppt）/);
  assert.match(importMessage({ code: 'unsupported' }), /ブラウザを新しくするか/);
  assert.match(importMessage({ code: 'broken' }), /パスワード/);
});

test('PPTX: DOM に依存せず、ホームからは遅延読みこみ', () => {
  const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const f of ['zip-read', 'xml-read', 'pptx-import-logic']) {
    assert.doesNotMatch(source(`js/${f}.js`), /\b(?:document|window|DOMParser|Image|Blob)\b|innerHTML|fetch\(/);
  }
  const dash = source('js/views/dashboard.js');
  assert.match(dash, /import\('\.\.\/pptx-import\.js'\)/);
  assert.doesNotMatch(dash, /from ['"][^'"]*pptx/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test('PPTX 本体: 文字だけのファイル・進みぐあい・教材の正規化', async () => {
  const progress = [];
  const result = await importPptx(fileFrom(pptxEntries([slide(sp('文字')), slide('')])), { onProgress: (...p) => progress.push(p) });
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
  const deck = buildDeckFromPptx(result, 1);
  assert.deepEqual(normalizeDeck(deck), deck);
});

test('PPTX 本体: ファイルの読みこみ中に中止し、遅い成功・失敗から通知しない', async () => {
  for (const reject of [false, true]) {
    const d = deferred(), ac = new AbortController(), progress = [];
    const p = importPptx({ name: 'a.pptx', size: 10, arrayBuffer: () => d.promise }, { signal: ac.signal, onProgress: (...args) => progress.push(args) });
    ac.abort(); await assert.rejects(p, { code: 'cancelled' });
    if (reject) d.reject(new Error('遅い失敗')); else d.resolve(new ArrayBuffer(10));
    await flush(); assert.deepEqual(progress, []);
  }
});

test('PPTX 本体: 枚数の途中で中止したら以降の通知を出さない', async () => {
  const ac = new AbortController(), progress = [];
  await assert.rejects(importPptx(fileFrom(pptxEntries([slide(sp()), slide(sp())])), {
    signal: ac.signal, onProgress: (done) => { progress.push(done); if (done === 1) ac.abort(); },
  }), { code: 'cancelled' });
  assert.deepEqual(progress, [0, 1]);
});

test('PPTX 本体: 読み取り途中の中止は XML の完了を待たず、それ以上読まない', async () => {
  const ac = new AbortController(), d = deferred(); let reads = 0;
  const p = readPptx({ read: () => { reads++; return d.promise; } }, { signal: ac.signal });
  ac.abort(); await assert.rejects(p, { code: 'cancelled' });
  d.resolve(new TextEncoder().encode('<p:presentation/>')); await flush();
  assert.equal(reads, 1);
});

test('PPTX 本体: 検査・展開できない環境・読めないファイルは code を持つ', async (t) => {
  await assert.rejects(importPptx({ name: 'a.ppt' }), { code: 'not-pptx' });
  await assert.rejects(importPptx({ name: 'a.pptx', size: 52428801 }), { code: 'too-large' });
  await assert.rejects(importPptx({ name: 'a.pptx', size: 3, arrayBuffer: async () => new ArrayBuffer(3) }), { code: 'broken' });
  t.mock.method(globalThis, 'DecompressionStream', function () { throw new Error(); });
  await assert.rejects(importPptx(fileFrom(pptxEntries())), { code: 'unsupported' });
});

// Image と canvas だけを代役にし、Blob の型・compressImage・予算の計算は本体を通す。
function imageEnvironment(t, { fail = false, hold = false, dataLength = 30 } = {}) {
  const previous = Object.fromEntries(['Image', 'document'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const blobs = [], pending = [], qualities = [], paints = [];
  const canvas = { getContext: () => ({ fillRect: () => paints.push('white'), drawImage() {}, set fillStyle(v) { assert.equal(v, '#FFFFFF'); } }),
    toDataURL: (type, quality) => { assert.equal(type, 'image/jpeg'); qualities.push(quality); return 'data:image/jpeg;base64,' + 'A'.repeat(dataLength); } };
  globalThis.document = { createElement: (tag) => { assert.equal(tag, 'canvas'); return canvas; } };
  globalThis.Image = class {
    constructor() { this.naturalWidth = 400; this.naturalHeight = 300; }
    set src(value) {
      assert.match(value, /^blob:/);
      const done = () => fail ? this.onerror() : this.onload();
      pending.push(done);
      if (!hold) queueMicrotask(done);
    }
  };
  t.mock.method(URL, 'createObjectURL', (blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.after(() => {
    for (const [key, desc] of Object.entries(previous)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  return { blobs, pending, qualities, paints };
}

function withImages({ count = 1, shared = true } = {}) {
  const names = Array.from({ length: shared ? 1 : count }, (_, i) => `image${i}.png`);
  return pptxEntries([slide(Array.from({ length: count }, (_, i) => pic(shared ? 'i0' : `i${i}`)).join(''))], {
    extra: { 'ppt/slides/_rels/slide1.xml.rels': rels(names.map((n, i) => [`i${i}`, 'image', `../media/${n}`])),
      ...Object.fromEntries(names.map((n) => [`ppt/media/${n}`, new Uint8Array([1, 2, 3])])) },
  });
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('待っていた処理が終わらない');
}

test('PPTX 画像: 拡張子の型の Blob・白い背景・JPEG・共有画像は一度だけ変換', async (t) => {
  const env = imageEnvironment(t);
  const result = await importPptx(fileFrom(withImages({ count: 3 })));
  assert.equal(env.blobs.length, 1); assert.equal(env.blobs[0].type, 'image/png');
  assert.deepEqual(new Uint8Array(await env.blobs[0].arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(env.paints, ['white']); assert.deepEqual(env.qualities, [0.85]);
  assert.equal(result.slides[0].items.length, 3);
  assert.equal(Object.keys(buildDeckFromPptx(result, 1).images).length, 1);
});

test('PPTX 画像: 変換失敗は出現回数を数え、空のスライドを残す', async (t) => {
  const env = imageEnvironment(t, { fail: true });
  const result = await importPptx(fileFrom(withImages({ count: 3 })));
  assert.equal(env.blobs.length, 1); assert.equal(result.skipped.image, 3);
  assert.equal(result.slides.length, 1); assert.equal(result.slides[0].items.length, 0);
});

test('PPTX 画像: 画像数に応じた予算より大きい JPEG は採用しない', async (t) => {
  imageEnvironment(t, { dataLength: 180000 });
  const result = await importPptx(fileFrom(withImages({ count: 30, shared: false })));
  assert.equal(result.skipped.image, 30); assert.equal(result.slides[0].items.length, 0);
});

test('PPTX 画像: ZIP の展開上限を超えた画像はスキップではなく全体の失敗', async (t) => {
  imageEnvironment(t);
  const bytes = makeZip(withImages(), { deflate: true });
  let at = bytes.readUInt32LE(bytes.length - 6);
  while (bytes.readUInt32LE(at) === 0x02014b50) {
    const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString();
    if (name.endsWith('.png')) {
      bytes.writeUInt32LE(CONFIG.pptx.maxImageBytes + 1, bytes.readUInt32LE(at + 42) + 22);
      bytes.writeUInt32LE(CONFIG.pptx.maxImageBytes + 1, at + 24);
      break;
    }
    at += 46 + length;
  }
  await assert.rejects(importPptx({ name: 'a.pptx', size: bytes.length, arrayBuffer: async () => bytes }), { code: 'broken' });
});

test('PPTX 画像: 変換中に中止した後の成功・失敗は進捗に出さない', async (t) => {
  const env = imageEnvironment(t, { hold: true });
  const ac = new AbortController(), progress = [];
  const p = importPptx(fileFrom(withImages()), { signal: ac.signal, onProgress: (done) => progress.push(done) });
  await until(() => env.pending.length === 1);
  ac.abort(); await assert.rejects(p, { code: 'cancelled' });
  env.pending[0](); await flush(); await flush();
  assert.deepEqual(progress, [0]);
});

// ダッシュボードを実際に mount し、保存の呼び出しと中止後の表示まで確かめる小さな DOM。
function dashboardEnvironment(t, { saveError = false } = {}) {
  const previous = Object.fromEntries(['Node', 'document'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  class TestNode {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.parentNode = null; }
    get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(value) { if (this.tagName === '#text') this.text = String(value); else this.replaceChildren(String(value)); }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    append(...nodes) { for (let node of nodes) { if (!(node instanceof TestNode)) node = document.createTextNode(String(node)); node.parentNode = this; this.childNodes.push(node); } }
    replaceChildren(...nodes) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; this.append(...nodes); }
    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(this), 1, ...nodes);
      nodes.forEach((n) => { n.parentNode = parent; }); this.parentNode = null;
    }
    addEventListener(k, fn) { (this.events[k] ??= new Set()).add(fn); }
    removeEventListener(k, fn) { this.events[k]?.delete(fn); }
    fire(k) { for (const fn of this.events[k] || []) fn({ target: this, preventDefault() {} }); }
    click() { if (!this.disabled) this.fire('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this); this.parentNode = null; }
    querySelectorAll(selector) {
      const matches = (node) => selector === 'button[data-dash-action]' ? node.tagName === 'button' && Object.hasOwn(node.attributes, 'data-dash-action')
        : selector.startsWith('.') ? (node.className || '').split(' ').includes(selector.slice(1)) : node.tagName === selector;
      return this.childNodes.flatMap((n) => [...(matches(n) ? [n] : []), ...n.querySelectorAll(selector)]);
    }
  }
  globalThis.Node = TestNode;
  globalThis.document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => { const n = new TestNode('#text'); n.text = text; return n; } };
  document.body = new TestNode('body');
  const root = new TestNode('main'); document.body.append(root);
  const saved = [], navigated = [];
  const cleanup = mountDashboard(root, {
    auth: null, navigate: (...args) => navigated.push(args),
    repo: { listDecks: async () => [], getActive: async () => null, listHistory: async () => [], purgeExpiredTrash: async () => {},
      saveDeck: async (...args) => { if (saveError) throw new Error('保存失敗'); saved.push(args); } },
  });
  t.after(() => {
    cleanup(); closeAllDialogs();
    for (const [key, desc] of Object.entries(previous)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  const button = (label) => document.body.querySelectorAll('button').find((b) => b.textContent === label);
  const choose = (file) => { const input = root.querySelectorAll('input').find((n) => n.getAttribute('accept') === '.pptx'); input.files = [file]; input.fire('change'); };
  return { root, saved, navigated, button, choose, cleanup };
}

test('PPTX ホーム: 成功時だけ一度保存し、まとめを読んでから編集へ移る', async (t) => {
  const env = dashboardEnvironment(t);
  env.choose(fileFrom(pptxEntries([slide(sp('文') + '<p:cxnSp/>')])));
  assert.equal(env.button('PDF から作る').disabled, true);
  assert.equal(env.button('PowerPoint から作る').disabled, true);
  await until(() => env.button('教材を開く'));
  assert.equal(env.saved.length, 1); assert.equal(env.navigated.length, 0);
  assert.match(document.body.textContent, /取りこめなかったもの: 線 1/);
  assert.match(document.body.textContent, /配置や文字の大きさは、元と同じにはなりません/);
  assert.deepEqual(document.body.querySelectorAll('.confirm')[0].querySelectorAll('p').map((p) => p.textContent),
    summaryMessage({ slides: [1], skipped: { line: 1 } }).split('\n'));
  assert.deepEqual(normalizeDeck(env.saved[0][1]), env.saved[0][1]);
  env.button('教材を開く').click(); await flush();
  assert.deepEqual(env.navigated, [['editor', { deckId: env.saved[0][0] }]]);
});

test('PPTX ホーム: 取りこめなかったものがなければまとめは 1 段落', async (t) => {
  const env = dashboardEnvironment(t);
  env.choose(fileFrom(pptxEntries()));
  await until(() => env.button('教材を開く'));
  const paragraphs = document.body.querySelectorAll('.confirm')[0].querySelectorAll('p');
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].textContent, summaryMessage({ slides: [1], skipped: {} }));
});

test('PPTX ホーム: 別の確認ダイアログの本文と段落は変えない', async (t) => {
  const env = dashboardEnvironment(t);
  const other = confirmDialog({ title: '別の確認', body: '前の文\n次の文' });
  const original = document.body.querySelectorAll('.confirm')[0];
  const paragraph = original.querySelectorAll('p')[0];
  env.choose(fileFrom(pptxEntries([slide(sp('文') + '<p:cxnSp/>')])));
  await until(() => env.button('教材を開く'));
  assert.deepEqual(original.querySelectorAll('p'), [paragraph]);
  assert.equal(paragraph.textContent, '前の文\n次の文');
  const summary = document.body.querySelectorAll('.confirm')[1];
  assert.equal(summary.querySelectorAll('p').length, 2);
  assert.equal(document.activeElement, env.button('ホームに戻る'));
  closeAllDialogs();
  assert.equal(await other, false);
  await flush();
  assert.equal(document.body.querySelectorAll('.confirm').length, 0);
});

test('PPTX ホーム: 中止中の遅い成功・失敗は保存も表示もしない、次の取りこみを妨げない', async (t) => {
  const env = dashboardEnvironment(t);
  const first = deferred(); let started = false;
  env.choose({ name: 'a.pptx', size: 1, arrayBuffer: () => { started = true; return first.promise; } });
  await until(() => started);
  // PDF の change が後から届いても、同時に読み始めない。
  const pdf = env.root.querySelectorAll('input').find((n) => n.getAttribute('accept').includes('.pdf'));
  pdf.files = [{ name: 'a.pdf', arrayBuffer: () => assert.fail('同時に PDF を読まない') }]; pdf.fire('change');
  env.button('やめる').click();
  await until(() => !env.button('PowerPoint から作る').disabled);
  assert.match(env.root.textContent, /教材は作っていません/);
  assert.equal(env.saved.length, 0);
  const text = env.root.textContent;
  first.reject(new Error('遅い失敗')); await flush(); await flush();
  assert.equal(env.root.textContent, text); assert.equal(env.saved.length, 0);
  env.choose(fileFrom(pptxEntries()));
  await until(() => env.button('教材を開く'));
  assert.equal(env.saved.length, 1);
  env.button('ホームに戻る').click(); await flush();
  assert.equal(env.navigated.length, 0);
});

test('PPTX ホーム: 中止のあと成功しても保存しない', async (t) => {
  const env = dashboardEnvironment(t), d = deferred(); let started = false;
  env.choose({ name: 'a.pptx', size: 1, arrayBuffer: () => { started = true; return d.promise; } });
  await until(() => started); env.button('やめる').click();
  await until(() => !env.button('PowerPoint から作る').disabled);
  const text = env.root.textContent;
  d.resolve(await fileFrom(pptxEntries()).arrayBuffer()); await flush(); await flush();
  assert.equal(env.saved.length, 0); assert.equal(env.root.textContent, text);
});

test('PPTX ホーム: 画面を離れた後は保存も案内もしない', async (t) => {
  const env = dashboardEnvironment(t), d = deferred(); let started = false;
  env.choose({ name: 'a.pptx', size: 1, arrayBuffer: () => { started = true; return d.promise; } });
  await until(() => started); env.cleanup();
  const text = env.root.textContent;
  d.resolve(await fileFrom(pptxEntries()).arrayBuffer()); await flush(); await flush();
  assert.equal(env.saved.length, 0); assert.equal(env.root.textContent, text); assert.equal(env.navigated.length, 0);
});

test('PPTX ホーム: 読み取り失敗は保存せず、操作できる状態へ戻す', async (t) => {
  const env = dashboardEnvironment(t);
  env.choose(fileFrom({}));
  await until(() => !env.button('PowerPoint から作る').disabled);
  assert.equal(env.saved.length, 0); assert.equal(env.navigated.length, 0);
  assert.match(env.root.textContent, /この PowerPoint を読みこめませんでした/);
});

test('PPTX ホーム: 保存失敗は PDF と同じ文、成功のまとめや画面移動はしない', async (t) => {
  const env = dashboardEnvironment(t, { saveError: true });
  env.choose(fileFrom(pptxEntries()));
  await until(() => !env.button('PowerPoint から作る').disabled);
  assert.equal(env.navigated.length, 0); assert.equal(env.button('教材を開く'), undefined);
  assert.match(env.root.textContent, /作れませんでした。接続を確かめて、もう一度押してください。/);
});
