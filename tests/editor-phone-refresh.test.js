import test from 'node:test';
import assert from 'node:assert/strict';
import { editorDom } from './helpers/editor-dom.js';
import { mount } from '../js/views/editor.js';
import { createDeck, createSlide, createTextItem, createShapeItem, addSlide } from '../js/model.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const pointer = (node, name) => node.dispatch(name, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
const row = (root, id = 'text') => root.querySelector(`[data-focus-key="ed-pick:${id}"]`);
const label = (root, id = 'text') => row(root, id)?.children.at(-1).textContent;
let sequence = 0;

async function setup(t, { narrow = true, count = 2, text = '前の文字', geometry = false } = {}) {
  const h = editorDom(t, narrow);
  if (geometry) measureSlides(h);
  let deck = createDeck('更新の確認', 1);
  for (let i = 0; i < count; i++) {
    const slide = i === 0
      ? { type: 'content', items: [{ ...createTextItem('text'), text }, createShapeItem('shape')] }
      : createSlide('content');
    deck = addSlide(deck, slide, `slide-${i}`);
  }
  const saved = [];
  const stop = mount(h.root, {
    params: { deckId: `phone-refresh-${++sequence}` }, auth: { user: { uid: 'editor-test' } },
    repo: { deckState: async () => 'live', loadDeck: async () => deck,
      saveDeck: async (_, next) => { saved.push(structuredClone(next)); } },
  });
  h.cleanup(async () => { stop(); await flush(); });
  await flush();
  const stage = () => h.root.querySelector('.ed-center').querySelector('.slide-stage');
  const select = (id = 'text') => {
    const node = stage().querySelector(`[data-item-id="${id}"]`);
    pointer(node, 'pointerdown'); pointer(node, 'pointerup');
  };
  const chooseSlide = (i) => h.root.querySelector(`[data-slide-id="slide-${i}"]`).click();
  const openSettings = (quick = false) => button(h.root.querySelector(quick ? '.ed-quick' : '.ed-bottom'), '設定').click();
  const type = (value) => {
    const ta = h.root.querySelector('.ed-phone-textarea');
    ta.value = value; ta.dispatch('input');
    return ta;
  };
  return { ...h, saved, stage, select, chooseSlide, openSettings, type };
}

// 非表示の一覧は幅 0。表示後は、各縮小表示の座標に一覧の scrollLeft を反映する。
// ページを送る API と、preventScroll なしの見出しフォーカスも検知する。
function measureSlides(h) {
  window.scrollX = 0; window.scrollY = 0;
  window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
  const create = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const node = create(tag);
    const rect = node.getBoundingClientRect.bind(node);
    const focus = node.focus.bind(node);
    const visible = () => !h.media.matches || node.closest('.ed-left')?.classList.contains('is-open');
    Object.defineProperty(node, 'clientWidth', { get: () => visible() ? 320 : 0 });
    node.getBoundingClientRect = () => {
      if (node.classList.contains('ed-slides')) return { left: 16, right: visible() ? 336 : 16, width: node.clientWidth, top: 400, height: 120 };
      if (node.classList.contains('ed-slide-btn')) {
        const list = node.closest('.ed-slides');
        const at = list.querySelectorAll('.ed-slide-btn').indexOf(node);
        const left = visible() ? 16 + at * 176 - list.scrollLeft : 0;
        return { left, right: left + (visible() ? 168 : 0), width: visible() ? 168 : 0, top: 400, height: 120 };
      }
      return rect();
    };
    node.scrollIntoView = () => window.scrollTo(0, 900);
    node.focus = (options) => {
      if (node.classList.contains('ed-panel-title') && !options?.preventScroll) window.scrollTo(0, 700);
      focus();
    };
    return node;
  };
}

for (const quick of [false, true]) {
  test(`編集の更新: 文字追加→入力→できた→設定で先頭12文字を表示（クイック=${quick}）`, async (t) => {
    const h = await setup(t);
    button(h.root, '文字を追加').click();
    const selected = h.root.querySelector('.ed-item.is-selected').dataset.itemId;
    const before = row(h.root, selected);
    const ta = h.type('あいうえおかきくけこさしす');
    assert.equal(h.root.querySelector('.ed-phone-textarea'), ta);
    assert.equal(row(h.root, selected), before);
    button(h.root, 'できた').click();
    assert.equal(label(h.root, selected), '文字: あいうえおかきくけこさし…');
    assert.equal(h.doc.activeElement, button(h.root, '文字を入力'));
    h.openSettings(quick);
    assert.equal(label(h.root, selected), '文字: あいうえおかきくけこさし…');
    assert.equal(h.root.querySelector('.ed-right').classList.contains('is-open'), true);
  });
}

for (const end of ['escape', 'other', 'blank', 'slide', 'delete']) {
  test(`編集の更新: 入力終了（${end}）で一覧を更新し、消えた行を残さない`, async (t) => {
    const h = await setup(t);
    h.select(); button(h.root, '文字を入力').click();
    const ta = h.type('新しい文字');
    if (end === 'escape') ta.dispatch('keydown', { key: 'Escape' });
    if (end === 'other') h.select('shape');
    if (end === 'blank') pointer(h.stage(), 'pointerdown');
    if (end === 'slide') h.chooseSlide(1);
    if (end === 'delete') button(h.root.querySelector('.ed-right'), 'この要素を削除').click();
    assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
    if (end === 'escape') assert.equal(h.doc.activeElement, button(h.root, '文字を入力'));
    if (end === 'slide' || end === 'delete') assert.equal(row(h.root), null);
    else assert.equal(label(h.root), '文字: 新しい文字');
    if (end === 'slide') h.chooseSlide(0);
    h.openSettings();
    assert.equal(label(h.root), end === 'delete' ? undefined : '文字: 新しい文字');
    ta.value = '遅い入力'; ta.dispatch('input');
    assert.equal(label(h.root), end === 'delete' ? undefined : '文字: 新しい文字');
  });
}

for (const text of ['', ' \n  \t ']) {
  test(`編集の更新: 文字を空にして終えると空の表示になる（${JSON.stringify(text)}）`, async (t) => {
    const h = await setup(t);
    h.select(); button(h.root, '文字を入力').click(); h.type(text);
    button(h.root, 'できた').click();
    assert.equal(label(h.root), '文字: （空）');
    h.openSettings(); assert.equal(label(h.root), '文字: （空）');
  });
}

for (const text of [null, 42, {}, []]) {
  test(`編集の更新: textが文字でない場合も終了・再表示で空の表示（${JSON.stringify(text)}）`, async (t) => {
    const h = await setup(t, { text });
    h.select(); button(h.root, '文字を入力').click();
    button(h.root, 'できた').click();
    assert.equal(label(h.root), '文字: （空）');
    h.openSettings(); assert.equal(label(h.root), '文字: （空）');
  });
}

test('編集の更新: 設定を開いてから変換中の入力をしても欄と一覧を作り直さず、終了・再表示で更新', async (t) => {
  const h = await setup(t); h.select(); h.openSettings();
  const right = h.root.querySelector('.ed-right');
  const head = right.querySelector('.ed-panel-head');
  const content = right.querySelector('.ed-panel-content');
  content.scrollTop = 80;
  button(h.root, '文字を入力').click();
  assert.equal(right.classList.contains('is-open'), false);
  const ta = h.root.querySelector('.ed-phone-textarea');
  const picker = right.querySelector('.ed-item-picker');
  ta.dispatch('compositionstart');
  for (const value of ['に', '日本', '日本語']) {
    ta.value = value; ta.setSelectionRange(0, 1); ta.dispatch('input', { isComposing: true });
    assert.equal(right.querySelector('.ed-item-picker'), picker);
    assert.equal(h.root.querySelector('.ed-phone-textarea'), ta);
    assert.equal(h.doc.activeElement, ta);
    assert.deepEqual([ta.selectionStart, ta.selectionEnd], [0, 1]);
  }
  assert.equal(ta.focusCount, 1);
  ta.dispatch('compositionend'); button(h.root, 'できた').click();
  assert.equal(label(h.root), '文字: 日本語');
  h.openSettings(true);
  assert.equal(label(h.root), '文字: 日本語');
  assert.equal(right.querySelector('.ed-panel-head'), head);
  assert.equal(right.querySelector('.ed-panel-content'), content);
  assert.equal(content.scrollTop, 80);
});

for (const end of ['done', 'escape']) {
  test(`編集の更新: 同じ文字で終了しても入力ボタンへフォーカスを戻す（${end}）`, async (t) => {
    const h = await setup(t); h.select();
    for (let i = 0; i < 2; i++) {
      button(h.root, '文字を入力').click();
      if (end === 'done') button(h.root, 'できた').click();
      else h.root.querySelector('.ed-phone-textarea').dispatch('keydown', { key: 'Escape' });
      assert.equal(label(h.root), '文字: 前の文字');
      assert.equal(h.doc.activeElement, button(h.root, '文字を入力'));
    }
    assert.equal(h.saved.length, 0);
  });
}

for (const quick of [false, true]) {
  test(`編集の更新: 広い画面の入力終了では列を描き直さず、狭くして設定を開くと最新（クイック=${quick}）`, async (t) => {
    const h = await setup(t, { narrow: false }); h.select(); h.select();
    const picker = h.root.querySelector('.ed-item-picker');
    const ta = h.stage().querySelector('textarea');
    ta.value = '広い画面で変更'; ta.dispatch('input'); ta.dispatch('blur');
    assert.equal(h.root.querySelector('.ed-item-picker'), picker);
    assert.equal(h.stage().querySelector('textarea'), null);
    h.width(true);
    assert.equal(h.root.querySelector('.ed-item-picker'), picker);
    h.openSettings(quick);
    assert.equal(label(h.root), '文字: 広い画面で変更');
    assert.equal(h.doc.activeElement, h.root.querySelector('.ed-right').querySelector('.ed-panel-title'));
    // すでに開いている場合も開いたまま更新し、見出しにフォーカスする。
    const currentPicker = h.root.querySelector('.ed-item-picker');
    h.openSettings(true);
    assert.notEqual(h.root.querySelector('.ed-item-picker'), currentPicker);
    assert.equal(label(h.root), '文字: 広い画面で変更');
    assert.equal(h.root.querySelector('.ed-right').classList.contains('is-open'), true);
  });
}

test('編集の更新: 20枚の最後を選び、広い→狭いのあと開くと一覧内だけを送る', async (t) => {
  const h = await setup(t, { narrow: false, count: 20, geometry: true });
  h.chooseSlide(19); h.width(true);
  const left = h.root.querySelector('.ed-left');
  const list = left.querySelector('.ed-slides');
  const content = left.querySelector('.ed-panel-content');
  assert.equal(left.classList.contains('is-open'), false);
  assert.equal(list.clientWidth, 0);
  assert.equal(list.scrollLeft, 0);
  content.scrollTop = 70; window.scrollTo(12, 260);
  const toggle = h.root.querySelector('.ed-bottom').querySelector('button');
  const checkVisible = () => {
    const r = left.querySelector('[aria-current="true"]').getBoundingClientRect();
    const box = list.getBoundingClientRect();
    assert.ok(r.left >= box.left && r.right <= box.right, '選択した縮小表示が一覧の表示範囲に入る');
    assert.deepEqual([window.scrollX, window.scrollY], [12, 260]);
    assert.equal(content.scrollTop, 70);
  };
  toggle.click(); checkVisible();
  assert.ok(list.scrollLeft > 0);
  // 一覧を先頭へ戻して閉じた場合も、開き直せば選択位置へ寄せる。
  list.scrollLeft = 0; button(left, '閉じる').click(); toggle.click(); checkVisible();
  // 逆向きに範囲外になった場合と、すでに見えている場合。
  h.chooseSlide(0);
  const firstList = left.querySelector('.ed-slides');
  firstList.scrollLeft = 400; toggle.click();
  assert.equal(firstList.scrollLeft, 0);
  button(left, '閉じる').click(); toggle.click();
  assert.equal(firstList.scrollLeft, 0);
  assert.deepEqual([window.scrollX, window.scrollY], [12, 260]);
});

for (const count of [0, 1]) {
  test(`編集の更新: ${count}枚で幅変更後に開いても例外・不要なスクロールなし`, async (t) => {
    const h = await setup(t, { narrow: false, count, geometry: true });
    h.width(true); window.scrollTo(12, 260);
    const left = h.root.querySelector('.ed-left');
    h.root.querySelector('.ed-bottom').querySelector('button').click();
    assert.equal(left.classList.contains('is-open'), true);
    assert.equal(left.querySelector('.ed-slides')?.scrollLeft ?? 0, 0);
    assert.deepEqual([window.scrollX, window.scrollY], [12, 260]);
  });
}
