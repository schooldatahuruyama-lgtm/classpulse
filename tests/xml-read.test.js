import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../js/xml-read.js';

test('XML: 宣言・要素・属性・CDATA・コメント・処理命令・実体', () => {
  const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?><!--前--><p:sp x='&quot;&apos;' __proto__="ok"><a:t>&amp;&lt;&gt;&#65;&#x1F600;<![CDATA[<script>]]></a:t><?done now?></p:sp>`);
  assert.equal(root.name, 'p:sp');
  assert.equal(root.attrs.x, '"\'');
  assert.equal(root.attrs.__proto__, 'ok');
  assert.equal(root.children[0].text, '&<>A😀<script>');
  assert.equal(root.children.length, 1);
});

test('XML: UTF-8・BOM・改行と属性の空白', () => {
  const root = parseXml(new TextEncoder().encode('\uFEFF<x a="a\r\nb\tc">日本語\r\n行</x>'));
  assert.equal(root.text, '日本語\n行');
  assert.equal(root.attrs.a, 'a b c');
});

for (const [name, xml] of [
  ['DOCTYPE', '<!DOCTYPE x><x/>'], ['実体定義', '<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>'],
  ['外部実体', '<!DOCTYPE x SYSTEM "https://example.invalid/x"><x/>'],
  ['未知の実体', '<x>&unknown;</x>'], ['裸の &', '<x>&</x>'], ['不正な数値実体', '<x>&#xD800;</x>'],
  ['ゼロの実体', '<x>&#0;</x>'], ['範囲外の実体', '<x>&#x110000;</x>'],
  ['閉じ忘れ', '<x>'], ['終了名の不一致', '<x></y>'], ['根が複数', '<x/><y/>'],
  ['属性の重複', '<x a="1" a="2"/>'], ['引用符なし', '<x a=1/>'], ['属性の区切りなし', '<x a="1"b="2"/>'],
  ['属性に裸の <', '<x a="<"/>'], ['閉じないコメント', '<x><!--</x>'],
  ['閉じない CDATA', '<x><![CDATA[x</x>'], ['根の外の文字', 'x<x/>'], ['空', ''],
  ['宣言でない <! 要素', '<!ENTITY x "a"><x/>'], ['不正な制御文字', '<x>\u0001</x>'],
]) test(`XML: ${name}は読めない`, () => assert.throws(() => parseXml(xml), { code: 'broken' }));

test('XML: 深さ 200 まで・201 と非常に深い木をことわる', () => {
  assert.equal(parseXml('<x>'.repeat(200) + '</x>'.repeat(200)).name, 'x');
  for (const depth of [201, 10000]) assert.throws(() => parseXml('<x>'.repeat(depth) + '</x>'.repeat(depth)), { code: 'broken' });
});

test('XML: こわれた UTF-8 を置きかえずことわる', () => {
  assert.throws(() => parseXml(new Uint8Array([0xff, 0xfe])), { code: 'broken' });
});
