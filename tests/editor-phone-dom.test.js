import test from 'node:test';
import assert from 'node:assert/strict';
import { editorDom } from './helpers/editor-dom.js';
import { mount as mountEditor } from '../js/views/editor.js';
import { mountCanvas } from '../js/views/editor/canvas.js';
import { createDeck, createSlide, createTextItem, createShapeItem, addSlide } from '../js/model.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const pointer = (node, name, fields = {}) => node.dispatch(name, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10, ...fields });
let sequence = 0;

async function setup(t, { narrow = true, empty = false } = {}) {
  const h = editorDom(t, narrow);
  let deck = createDeck('編集の確認', 1);
  if (!empty) {
    deck = addSlide(deck, { type: 'content', items: [createTextItem('text'), createShapeItem('shape')] }, 'one');
    for (const type of ['content', 'poll', 'quiz', 'rating', 'free', 'cloud', 'video']) deck = addSlide(deck, createSlide(type), type);
  }
  const saved = [];
  let fail = false;
  const stop = mountEditor(h.root, {
    params: { deckId: `phone-test-${++sequence}` }, auth: { user: { uid: 'editor-test' } },
    repo: { deckState: async () => 'live', loadDeck: async () => structuredClone(deck), saveDeck: async (_, value) => {
      if (fail) throw new Error('test-save');
      saved.push(structuredClone(value));
    } },
  });
  let stopped = false;
  const cleanup = () => { if (!stopped) { stop(); stopped = true; } };
  h.cleanup(async () => { fail = false; cleanup(); await flush(); });
  await flush();
  const stage = () => h.root.querySelector('.ed-center').querySelector('.slide-stage');
  const item = (id = 'text') => stage().querySelector(`[data-item-id="${id}"]`);
  const select = (id = 'text') => { pointer(item(id), 'pointerdown'); pointer(item(id), 'pointerup'); };
  const chooseSlide = (id) => h.root.querySelector(`[data-slide-id="${id}"]`).click();
  const save = async () => { h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); await flush(); };
  return { ...h, saved, stage, item, select, chooseSlide, save, stop: cleanup, failSave: (on) => { fail = on; } };
}

test('編集 DOM: 文字入力は同じ欄・選択範囲を保ち、本文だけ更新。blur では終わらない', async (t) => {
  const h = await setup(t);
  h.select();
  button(h.root, '文字を入力').click();
  const ta = h.root.querySelector('.ed-phone-textarea');
  const body = h.item().querySelector('.slide-text-body');
  assert.ok(ta);
  assert.equal(h.stage().querySelector('textarea'), null);
  assert.ok(h.root.querySelector('.editor').classList.contains('is-phone-editing'));
  ta.dispatch('compositionstart');
  for (const text of ['に', '日本', '日本語']) {
    ta.value = text; ta.setSelectionRange(1, 2); ta.dispatch('input', { isComposing: true });
    assert.equal(h.root.querySelector('.ed-phone-textarea'), ta);
    assert.equal(h.item().querySelector('.slide-text-body'), body);
    assert.equal(body.textContent, text);
    assert.equal(ta.selectionStart, 1);
    assert.equal(ta.selectionEnd, 2);
  }
  assert.equal(ta.focusCount, 1);
  ta.dispatch('blur');
  assert.equal(h.root.querySelector('.ed-phone-textarea'), ta);
  ta.value = ''; ta.dispatch('input');
  assert.equal(h.item().querySelector('.ed-placeholder').textContent, '（文字を入力）');
  button(h.root, 'できた').click();
  assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
  assert.equal(h.doc.activeElement, button(h.root, '文字を入力'));
  assert.equal(h.root.querySelector('.editor').classList.contains('is-phone-editing'), false);
  button(h.root, '文字を入力').click();
  h.root.querySelector('.ed-phone-textarea').dispatch('keydown', { key: 'Escape' });
  assert.equal(h.doc.activeElement, button(h.root, '文字を入力'));
});

for (const end of ['blank', 'other', 'delete', 'slide', 'width', 'leave']) {
  test(`編集 DOM: 入力終了（${end}）後の遅い input で書き戻さない`, async (t) => {
    const h = await setup(t);
    h.select(); button(h.root, '文字を入力').click();
    const ta = h.root.querySelector('.ed-phone-textarea');
    ta.value = '残す文字'; ta.dispatch('input');
    if (end === 'blank') pointer(h.stage(), 'pointerdown');
    if (end === 'other') h.select('shape');
    if (end === 'delete') button(h.root.querySelector('.ed-right'), 'この要素を削除').click();
    if (end === 'slide') h.chooseSlide('content');
    if (end === 'width') h.width(false);
    if (end === 'leave') h.stop();
    assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
    ta.value = '遅い入力'; ta.dispatch('input');
    if (end !== 'leave') await h.save(); else await flush();
    const items = h.saved.at(-1).slides.one.items;
    assert.equal(items.find((it) => it.id === 'text')?.text, end === 'delete' ? undefined : '残す文字');
  });
}

test('キャンバス DOM: 入力中に対象が外から消えた場合も、例外なく閉じて書かない', (t) => {
  const h = editorDom(t);
  let items = [createTextItem('text')]; let writes = 0;
  const ed = { state: { deck: { images: {} }, slideId: 's', itemId: 'text', editingId: 'text' },
    currentSlide: () => ({ type: 'content', items }), isNarrow: () => true, isImageBusy: () => false,
    setPhoneEditing() {}, updateItem() { writes++; } };
  const canvas = mountCanvas(h.root, ed);
  const ta = h.root.querySelector('.ed-phone-textarea');
  items = []; ta.value = '対象なし'; ta.dispatch('input');
  assert.equal(writes, 0);
  assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
  canvas.destroy();
});

for (const pointerType of ['touch', 'pen']) {
  test(`編集 DOM: ${pointerType} の未選択スワイプ・cancel は選ばず動かさず保存しない`, async (t) => {
    const h = await setup(t);
    const node = h.item();
    assert.equal(pointer(node, 'pointerdown', { pointerType }).defaultPrevented, false);
    pointer(node, 'pointermove', { pointerType, clientY: 40 });
    pointer(node, 'pointerup', { pointerType, clientY: 40 });
    assert.equal(node.getAttribute('aria-pressed'), 'false');
    pointer(node, 'pointerdown', { pointerType });
    pointer(node, 'pointercancel', { pointerType });
    pointer(node, 'pointerup', { pointerType });
    assert.equal(node.getAttribute('aria-pressed'), 'false');
    await h.save(); assert.equal(h.saved.length, 0);
    pointer(node, 'pointerdown', { pointerType }); pointer(node, 'pointerup', { pointerType });
    assert.equal(node.getAttribute('aria-pressed'), 'true');
    pointer(node, 'pointerdown', { pointerType });
    pointer(node, 'pointermove', { pointerType, clientY: 28 });
    pointer(node, 'pointerup', { pointerType, clientY: 28 });
    await h.save();
    assert.equal(h.saved.at(-1).slides.one.items[0].y, 0.2);
  });
}

for (const narrow of [true, false]) {
  test(`編集 DOM: マウスは未選択でもすぐ動く（せまい画面=${narrow}）`, async (t) => {
    const h = await setup(t, { narrow }); const node = h.item();
    pointer(node, 'pointerdown', { pointerType: 'mouse' });
    pointer(node, 'pointermove', { pointerType: 'mouse', clientX: 42 });
    pointer(node, 'pointerup', { pointerType: 'mouse', clientX: 42 });
    await h.save(); assert.ok(Math.abs(h.saved.at(-1).slides.one.items[0].x - 0.2) < 1e-12);
  });
}

test('編集 DOM: 幅が広いときはキャンバスの中で文字入力し、blur で終了する', async (t) => {
  const h = await setup(t, { narrow: false });
  h.select(); h.select();
  const ta = h.stage().querySelector('textarea');
  assert.ok(ta); assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
  ta.value = '広い画面'; ta.dispatch('input'); ta.dispatch('blur');
  assert.equal(h.stage().querySelector('textarea'), null);
  assert.equal(h.item().querySelector('.slide-text-body').textContent, '広い画面');
});

test('編集 DOM: パネルは一つ。外わくとスクロール・押した設定へのフォーカスを保つ', async (t) => {
  const h = await setup(t); h.select();
  const bottom = h.root.querySelector('.ed-bottom');
  const right = h.root.querySelector('.ed-right');
  const head = right.querySelector('.ed-panel-head');
  const content = right.querySelector('.ed-panel-content');
  const opener = button(bottom, '設定'); opener.click();
  assert.equal(h.doc.activeElement, right.querySelector('.ed-panel-title'));
  content.scrollTop = 120;
  const bold = button(right, '太字'); bold.focus(); bold.click();
  assert.equal(right.querySelector('.ed-panel-head'), head);
  assert.equal(content.scrollTop, 120);
  assert.equal(h.doc.activeElement.dataset.focusKey, 'ed-bold');
  assert.equal(h.root.querySelector('.editor').style['--ed-bottom-space'], '240px');
  button(head, '閉じる').click(); assert.equal(h.doc.activeElement, opener);
  bottom.querySelector('button').click(); opener.click();
  assert.equal(h.root.querySelector('.ed-left').classList.contains('is-open'), false);
  assert.equal(right.classList.contains('is-open'), true);
  h.width(false); h.width(true);
  assert.equal(right.classList.contains('is-open'), false);
  assert.equal(opener.getAttribute('aria-expanded'), 'false');
});

test('編集 DOM: 要素一覧で背面を選べる。同じ行を二度押しても選択を保つ', async (t) => {
  const h = await setup(t); const right = h.root.querySelector('.ed-right');
  button(h.root, '要素を選ぶ').click();
  assert.equal(right.querySelector('.ed-item-picker').open, true);
  const rows = right.querySelectorAll('.ed-item-row');
  assert.match(rows[0].textContent, /図形/);
  rows[1].focus(); rows[1].click();
  const picker = right.querySelector('.ed-item-picker');
  assert.equal(picker.open, false);
  assert.equal(h.doc.activeElement, picker.querySelector('summary'));
  picker.open = true;
  const row = right.querySelector('[data-focus-key="ed-pick:text"]'); row.click(); row.click();
  assert.equal(right.querySelector('.ed-item-picker'), picker);
  assert.equal(row.getAttribute('aria-pressed'), 'true');
  assert.equal(h.item().getAttribute('aria-pressed'), 'true');
  button(h.root, '選択を外す').click();
  assert.equal(h.item().getAttribute('aria-pressed'), 'false');
});

test('編集 DOM: スライドの操作順・追加の開閉と、選択・追加・複製後だけパネルを閉じる', async (t) => {
  const h = await setup(t);
  const left = h.root.querySelector('.ed-left');
  const open = () => h.root.querySelector('.ed-bottom').querySelector('button').click();
  open();
  const content = left.querySelector('.ed-panel-content');
  assert.deepEqual(content.children.map((n) => n.className), ['ed-col-title', 'ed-slides', 'ed-slide-actions', 'btn ed-wide ed-slide-add-toggle', 'ed-add']);
  const add = button(left, '＋ スライドを追加'); add.click();
  assert.equal(add.getAttribute('aria-expanded'), 'true'); assert.equal(left.querySelector('.ed-add').hidden, false);
  add.click(); assert.equal(left.querySelector('.ed-add').hidden, true);
  button(left, '下へ').click(); assert.equal(left.classList.contains('is-open'), true);
  button(left, '上へ').click(); assert.equal(left.classList.contains('is-open'), true);
  h.chooseSlide('one'); assert.equal(left.classList.contains('is-open'), false);
  open(); button(left, '複製').click(); assert.equal(left.classList.contains('is-open'), false);
  open(); button(left, '＋ スライドを追加').click(); button(left, '＋ 資料スライド').click();
  assert.equal(left.classList.contains('is-open'), false);
  open(); button(left, '削除').click();
  button(h.doc.querySelector('dialog'), '削除').click(); await flush();
  assert.equal(left.classList.contains('is-open'), true);
});

test('編集 DOM: 資料以外の6種類は設定を本文内へ出し、0枚でも帯を表示できる', async (t) => {
  const h = await setup(t); const right = h.root.querySelector('.ed-right');
  for (const type of ['poll', 'quiz', 'rating', 'free', 'cloud', 'video']) {
    h.chooseSlide('one'); button(h.root.querySelector('.ed-bottom'), '設定').click();
    h.chooseSlide(type);
    assert.equal(right.classList.contains('is-open'), false);
    assert.equal(right.classList.contains('is-inline'), true);
    assert.equal(button(h.root.querySelector('.ed-bottom'), '設定').hidden, true);
  }
});

test('編集 DOM: スライドが0枚なら設定なし、中央の追加ボタンはそのまま', async (t) => {
  const h = await setup(t, { empty: true }); const bottom = h.root.querySelector('.ed-bottom');
  assert.equal(bottom.querySelector('button').textContent, 'スライド（0 枚）');
  assert.equal(button(bottom, '設定').hidden, true);
  assert.ok(button(h.root.querySelector('.ed-center'), '＋ 資料スライド'));
});

test('編集 DOM: 保存失敗と再試行は上の帯に従来の文言で出る', async (t) => {
  const h = await setup(t); h.failSave(true);
  const title = h.root.querySelector('.ed-title'); title.value = '変更'; title.dispatch('input'); await h.save();
  const saveBox = h.root.querySelector('.ed-top').querySelector('.ed-save');
  assert.match(saveBox.textContent, /保存できませんでした/);
  h.failSave(false); button(saveBox, 'もう一度保存').click(); await flush();
  assert.match(saveBox.textContent, /保存済み/);
});

test('編集 DOM: 文字を続けて追加した場合も新しい欄だけにフォーカスし、前の入力を残す', async (t) => {
  const h = await setup(t);
  button(h.root, '文字を追加').click();
  const first = h.root.querySelector('.ed-phone-textarea'); first.value = '一つ目'; first.dispatch('input');
  button(h.root, '文字を追加').click();
  const second = h.root.querySelector('.ed-phone-textarea'); second.value = '二つ目'; second.dispatch('input');
  assert.notEqual(first, second);
  assert.equal(h.doc.activeElement, second);
  assert.equal(second.focusCount, 1);
  first.value = '古い入力'; first.dispatch('input');
  await h.save();
  assert.deepEqual(h.saved.at(-1).slides.one.items.slice(-2).map((it) => it.text), ['一つ目', '二つ目']);
});

test('編集 DOM: 位置のボタンは連続操作を最新の要素へ適用し、キャンバスと保存に反映する', async (t) => {
  const h = await setup(t); h.select('shape');
  const original = parseFloat(h.item('shape').style.left);
  const move = h.root.querySelector('[data-focus-key="ed-nudge:right"]'); move.focus();
  for (let i = 0; i < 3; i++) move.click();
  assert.ok(Math.abs(parseFloat(h.item('shape').style.left) - original - 3) < 1e-9);
  assert.equal(h.doc.activeElement, move);
  await h.save();
  assert.ok(Math.abs(h.saved.at(-1).slides.one.items[1].x * 100 - original - 3) < 1e-9);
});

test('編集 DOM: 幅の切りかえで列の Tab 順を変え、広い画面では元へ戻す', async (t) => {
  const h = await setup(t); const body = h.root.querySelector('.ed-body');
  assert.deepEqual(body.children.map((n) => n.className), ['ed-center', 'ed-left', 'ed-right']);
  h.width(false);
  assert.deepEqual(body.children.map((n) => n.className), ['ed-left', 'ed-center', 'ed-right']);
});
