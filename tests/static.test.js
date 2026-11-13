import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('sw.js はルートに置き、index.html の script にせず、外部 URL を持たない', () => {
  assert.ok(existsSync(join(root, 'sw.js')));
  assert.doesNotMatch(read('index.html'), /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\bsw\.js/i);
  assert.doesNotMatch(read('sw.js'), /https?:\/\//i);
  assert.doesNotMatch(read('sw.js'), /\bimport\b|importScripts/);
});

test('index.html が base.css と main.js（module）を読みこむ', () => {
  const html = read('index.html');
  assert.match(html, /<link[^>]+href="css\/base\.css"/);
  assert.match(html, /<script[^>]+type="module"[^>]+src="js\/main\.js"|<script[^>]+src="js\/main\.js"[^>]+type="module"/);
});

test('index.html に外部 URL の src / href が無い', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']\s*https?:\/\//i);
});

test('base.css に配色 10 色・書体・font-display: swap がある', () => {
  const css = read('css/base.css');
  for (const c of ['#3F63F6', '#1F2A6B', '#45D0C2', '#52C97A', '#F4C94A', '#E8576A', '#A88CF6', '#F6F8FF', '#FFFFFF', '#DCE4F5']) {
    assert.ok(css.toUpperCase().includes(c), c);
  }
  assert.match(css, /BIZ UDPGothic/);
  assert.match(css, /font-display:\s*swap/);
});

test('CSS に外部 URL が無い', () => {
  for (const f of ['css/base.css', 'css/app.css', 'css/present.css']) assert.doesNotMatch(read(f), /https?:\/\//i, f);
});

test('QR コードのライブラリ（js/lib/qrcode.js）とライセンス文がある', () => {
  assert.ok(existsSync(join(root, 'js/lib/qrcode.js')));
  assert.ok(existsSync(join(root, 'js/lib/qrcode.LICENSE.txt')));
  assert.match(read('js/lib/qrcode.js'), /var qrcode = function/);
  const license = read('js/lib/qrcode.LICENSE.txt');
  assert.match(license, /MIT/);
  assert.match(license, /Kazuhiko Arase/);
});

test('index.html が qrcode.js を main.js より前に、ふつうのスクリプトとして読みこむ', () => {
  const html = read('index.html');
  const qr = html.search(/<script src="js\/lib\/qrcode\.js"><\/script>/);
  const main = html.search(/<script[^>]+src="js\/main\.js"/);
  assert.ok(qr >= 0, 'qrcode.js の script タグがない');
  assert.ok(qr < main, 'qrcode.js は main.js より前に置く');
  assert.match(html, /<link[^>]+href="css\/present\.css"/);
});

test('発表の画面は innerHTML を使わない', () => {
  assert.doesNotMatch(read('js/views/present.js'), /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('OFL.txt があり、@font-face の url() のファイルが実在する', () => {
  assert.ok(existsSync(join(root, 'assets/fonts/OFL.txt')));
  const css = read('css/base.css');
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.ok(existsSync(join(root, 'css', u)), u);
});
