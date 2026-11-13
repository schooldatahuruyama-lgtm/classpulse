import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openZip } from '../js/zip-read.js';
import { makeZip } from './helpers/pptx-fixture.js';

const central = (b) => b.readUInt32LE(b.length - 6);
const broken = { code: 'broken' };

for (const deflate of [false, true]) {
  test(`ZIP: ${deflate ? 'deflate' : '無圧縮'}・索引・必要な項目だけ展開`, async () => {
    const zip = openZip(makeZip({ 'ppt/a.xml': '日本語', 'ppt/unused': 'x'.repeat(10000) }, { deflate }), { maxTotalBytes: 10 });
    assert.deepEqual(zip.names(), ['ppt/a.xml', 'ppt/unused']);
    assert.equal(zip.has('ppt/a.xml'), true);
    assert.equal(zip.has('missing'), false);
    assert.equal(new TextDecoder().decode(await zip.read('ppt/a.xml', 9)), '日本語');
    await assert.rejects(zip.read('missing'), broken);
  });
}

test('ZIP: データ記述子・コメント・Uint8Array の部分範囲', async () => {
  const src = makeZip({ 'a': 'ok' }, { deflate: true, descriptor: true, comment: '末尾' });
  const b = new Uint8Array(src.length + 9); b.set(src, 5);
  assert.equal(new TextDecoder().decode(await openZip(b.subarray(5, -4)).read('a', 2)), 'ok');
});

for (const [name, mutate] of [
  ['末尾の署名', (b) => b.writeUInt32LE(0, b.length - 22)],
  ['中央の位置が外', (b) => b.writeUInt32LE(b.length + 100, b.length - 6)],
  ['中央の長さが外', (b) => b.writeUInt32LE(b.length, b.length - 10)],
  ['中央の件数が違う', (b) => b.writeUInt16LE(2, b.length - 12)],
  ['中央の暗号化', (b) => b.writeUInt16LE(1, central(b) + 8)],
  ['ローカルの暗号化', (b) => b.writeUInt16LE(1, 6)],
  ['ZIP64 の件数', (b) => b.writeUInt16LE(65535, b.length - 12)],
  ['ZIP64 のサイズ', (b) => b.writeUInt32LE(0xffffffff, central(b) + 24)],
  ['分割 ZIP', (b) => b.writeUInt16LE(1, b.length - 18)],
  ['別ディスクの項目', (b) => b.writeUInt16LE(1, central(b) + 34)],
  ['扱えない圧縮', (b) => b.writeUInt16LE(99, central(b) + 10)],
  ['項目のデータが外', (b) => b.writeUInt32LE(b.length, central(b) + 20)],
  ['項目の名前の長さが外', (b) => b.writeUInt16LE(65535, central(b) + 28)],
  ['ローカルの位置が外', (b) => b.writeUInt32LE(b.length, central(b) + 42)],
  ['ローカルの名前が違う', (b) => { b[30] = 98; }],
]) {
  test(`ZIP: ${name}は読めない`, () => {
    const b = makeZip({ a: 'text' }); mutate(b);
    assert.throws(() => openZip(b), broken);
  });
}

test('ZIP: 切れた末尾・短いファイル・不正な型', () => {
  const b = makeZip({ a: 'text' });
  for (const v of [b.subarray(0, -1), new Uint8Array(2), null]) assert.throws(() => openZip(v), broken);
});

test('ZIP: 項目数・項目ごと・合計の上限', async () => {
  const bytes = makeZip({ a: '1234', b: '5678' });
  assert.throws(() => openZip(bytes, { maxEntries: 1 }), broken);
  await assert.rejects(openZip(bytes).read('a', 3), broken);
  const zip = openZip(bytes, { maxTotalBytes: 7 });
  await zip.read('a', 4);
  await assert.rejects(zip.read('b', 4), broken);
});

test('ZIP: 大きく展開される項目は申告値を偽っても途中で止まる', async () => {
  const bytes = makeZip({ a: 'x'.repeat(2 * 1024 * 1024) }, { deflate: true });
  bytes.writeUInt32LE(8, 22); bytes.writeUInt32LE(8, central(bytes) + 24);
  await assert.rejects(openZip(bytes, { maxTotalBytes: 16 }).read('a', 16), broken);
});

test('ZIP: CRC が合わないデータ・こわれた deflate', async () => {
  for (const deflate of [false, true]) {
    const bytes = makeZip({ a: '12345678' }, { deflate });
    bytes[31] ^= 0xff;
    await assert.rejects(openZip(bytes).read('a', 20), broken);
  }
});

test('ZIP: 展開の部品がないと unsupported', async (t) => {
  t.mock.method(globalThis, 'DecompressionStream', function () { throw new Error('no'); });
  await assert.rejects(openZip(makeZip({ a: 'x' }, { deflate: true })).read('a', 10), { code: 'unsupported' });
});

test('ZIP: 中止の合図は展開より先に調べる', async () => {
  const ac = new AbortController();
  const zip = openZip(makeZip({ a: 'x' }, { deflate: true }), { signal: ac.signal });
  ac.abort();
  await assert.rejects(zip.read('a', 10), { code: 'cancelled' });
});

test('ZIP: ファイル名は辞書の鍵だけで、重複はことわる', async () => {
  const zip = openZip(makeZip({ '__proto__': 'ignored', '../../outside': 'text', constructor: 'value' }));
  assert.equal(new TextDecoder().decode(await zip.read('../../outside')), 'text');
  const b = makeZip({ a: 'x', b: 'y' });
  const p = central(b) + 47;
  b[p + 46] = 97;
  assert.throws(() => openZip(b), broken);
});
