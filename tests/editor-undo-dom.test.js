import test from 'node:test';
import assert from 'node:assert/strict';
import { editorDom } from './helpers/editor-dom.js';
import { mount } from '../js/views/editor.js';
import { backgroundSaver } from '../js/views/editor/background.js';
import { createDeck, createSlide, createTextItem, createShapeItem, addSlide } from '../js/model.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const input = (node, value) => { node.value = value; node.dispatch('input'); };
const pointer = (node, name, x = 10) => node.dispatch(name, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: 10 });
let sequence = 0;

async function setup(t, { narrow = true, empty = false, image = false } = {}) {
  const h = editorDom(t, narrow);
  t.mock.method(Date, 'now', () => 100);
  let deck = createDeck('履歴の確認', 1);
  if (!empty) {
    const items = [{ ...createTextItem('text'), text: '最初の文字' }, createShapeItem('shape')];
    if (image) items.push({ id: 'image', kind: 'image', imageId: 'picture', x: 0, y: 0, w: 0.4, h: 0.3 });
    deck = addSlide(deck, { type: 'content', items }, 'one');
    for (const type of ['content', 'poll', 'quiz', 'rating', 'free', 'cloud', 'video']) deck = addSlide(deck, createSlide(type), type);
    if (image) deck = { ...deck, images: { picture: 'data:image/png;base64,AA==' } };
  }
  const saved = [];
  const deckId = `undo-test-${++sequence}`;
  let fail = false; let hold = null; let stopped = false;
  const stop = mount(h.root, {
    params: { deckId }, auth: { user: { uid: 'undo-test' } },
    repo: { deckState: async () => hold ? hold : 'live', loadDeck: async () => deck,
      saveDeck: async (_, next) => { if (fail) throw new Error('test-save'); saved.push(structuredClone(next)); },
      getActive: async () => null },
    navigate: () => { cleanup(); },
  });
  const cleanup = () => { if (!stopped) { stopped = true; stop(); } };
  h.cleanup(async () => { fail = false; cleanup(); await flush(); });
  await flush();
  const save = async () => { h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); await flush(); return saved.at(-1); };
  const item = (id = 'text') => h.root.querySelector('.ed-center')?.querySelector(`[data-item-id="${id}"]`);
  const select = (id = 'text') => h.root.querySelector(`[data-focus-key="ed-pick:${id}"]`).click();
  const choose = (id) => h.root.querySelector(`[data-slide-id="${id}"]`).click();
  const undo = h.root.querySelector('[aria-label="元に戻す"]');
  const redo = h.root.querySelector('[aria-label="やり直す"]');
  const title = h.root.querySelector('.ed-title');
  const key = (key = 'z', fields = {}) => h.doc.dispatch('keydown', { target: h.doc.body, key, ctrlKey: true, ...fields });
  const resize = (kind) => h.root.querySelector(`[data-focus-key="ed-resize:${kind}"]`).click();
  return { ...h, deck, deckId, saved, save, item, select, choose, undo, redo, title, key, resize, stop: cleanup,
    failSave: (on) => { fail = on; }, holdStart: (promise) => { hold = promise; } };
}

test('元に戻す DOM: 初期は disabled。同じ教材名では保存も記録もせず、結果は aria-live', async (t) => {
  const h = await setup(t);
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, true);
  input(h.title, h.title.value); assert.equal(h.key().defaultPrevented, false);
  await h.save(); assert.equal(h.saved.length, 0);
  input(h.title, '変更'); input(h.title, '続けて変更');
  h.undo.click(); assert.equal(h.title.value, '履歴の確認');
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, false);
  const notice = h.root.querySelector('.ed-history-notice');
  assert.equal(notice.getAttribute('aria-live'), 'polite'); assert.equal(notice.textContent, '元に戻しました。');
  h.redo.click(); assert.equal(h.title.value, '続けて変更'); assert.equal(notice.textContent, 'やり直しました。');
  assert.equal((await h.save()).title, '続けて変更');
  assert.equal(h.doc.querySelector('.toast'), null);
});

for (const narrow of [true, false]) {
  test(`元に戻す DOM: 入力を終えて一連の文字を戻し、遅い input で書き戻さない（狭い=${narrow}）`, async (t) => {
    const h = await setup(t, { narrow }); h.select();
    button(h.root, '文字を入力').click();
    const ta = h.root.querySelector(narrow ? '.ed-phone-textarea' : '.ed-textarea');
    for (const text of ['入', '入力', '入力した文字']) input(ta, text);
    h.undo.click();
    assert.equal(h.root.querySelector(narrow ? '.ed-phone-textarea' : '.ed-textarea'), null);
    assert.equal(h.item().querySelector('.slide-text-body').textContent, '最初の文字');
    assert.equal(h.undo.disabled, true);
    input(ta, '遅い入力');
    assert.equal((await h.save()).slides.one.items[0].text, '最初の文字');
    h.redo.click(); assert.equal(h.item().querySelector('.slide-text-body').textContent, '入力した文字');
    assert.equal(h.root.querySelector(narrow ? '.ed-phone-textarea' : '.ed-textarea'), null);
  });
}

for (const end of ['finish', 'selection', 'slide']) {
  test(`元に戻す DOM: ${end} の後は同じ入力でも別の1回`, async (t) => {
    const h = await setup(t); h.select(); button(h.root, '文字を入力').click();
    input(h.root.querySelector('.ed-phone-textarea'), '一度目');
    if (end === 'finish') button(h.root, 'できた').click();
    if (end === 'selection') { h.select('shape'); h.select(); }
    if (end === 'slide') { h.choose('content'); h.choose('one'); h.select(); }
    button(h.root, '文字を入力').click(); input(h.root.querySelector('.ed-phone-textarea'), '二度目');
    h.undo.click(); assert.equal(h.item().querySelector('.slide-text-body').textContent, '一度目');
    h.undo.click(); assert.equal(h.item().querySelector('.slide-text-body').textContent, '最初の文字');
  });
}

for (const kind of ['bigger', 'smaller', 'wider', 'narrower', 'taller', 'shorter']) {
  test(`元に戻す DOM: サイズ ${kind} の連打をまとめ、選択・左上・保存を戻す`, async (t) => {
    const h = await setup(t); h.select();
    h.resize(kind); h.resize(kind); const changed = (await h.save()).slides.one.items[0];
    assert.notDeepEqual(changed, h.deck.slides.one.items[0]);
    assert.equal(changed.x, 0.1); assert.equal(changed.y, 0.1);
    h.undo.click(); assert.deepEqual((await h.save()).slides.one.items[0], h.deck.slides.one.items[0]);
    assert.equal(h.undo.disabled, true); assert.equal(h.item().getAttribute('aria-pressed'), 'true');
    h.redo.click(); assert.deepEqual((await h.save()).slides.one.items[0], changed);
  });
}

test('元に戻す DOM: 移動の連打は1回、異なる方向・大きさの種類・要素では分ける', async (t) => {
  const h = await setup(t); h.select();
  const nudge = (dir) => h.root.querySelector(`[data-focus-key="ed-nudge:${dir}"]`).click();
  nudge('left'); nudge('left'); nudge('up'); h.resize('smaller'); h.resize('shorter');
  h.select('shape'); h.resize('smaller');
  for (let i = 0; i < 5; i++) { assert.equal(h.undo.disabled, false); h.undo.click(); }
  assert.equal(h.undo.disabled, true);
  assert.deepEqual((await h.save()).slides.one, h.deck.slides.one);
});

for (const destination of ['slide', 'item']) {
  test(`元に戻す DOM: 変更後に ${destination} の選択を変えても、往復で変更した要素を選ぶ`, async (t) => {
    const h = await setup(t); h.select(); h.resize('bigger');
    const changed = await h.save();
    const move = () => { if (destination === 'slide') h.choose('content'); else h.select('shape'); };
    const checkSelection = () => {
      assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, 'one');
      assert.equal(h.item().getAttribute('aria-pressed'), 'true');
    };
    for (let i = 0; i < 2; i++) {
      move(); h.undo.click(); checkSelection(); assert.deepEqual(await h.save(), h.deck);
      move(); h.redo.click(); checkSelection(); assert.deepEqual(await h.save(), changed);
    }
  });
}

test('元に戻す DOM: 空の文字への3文字の入力をまとめ、選択を変えても最後の入力へやり直す', async (t) => {
  const h = await setup(t); button(h.root, '文字を追加').click();
  const added = h.root.querySelector('.ed-item.is-selected').dataset.itemId;
  const ta = h.root.querySelector('.ed-phone-textarea');
  for (const value of ['あ', 'あい', 'あいう']) input(ta, value);
  h.choose('content'); h.undo.click();
  assert.equal(h.item(added).querySelector('.slide-text-body').textContent, '');
  assert.equal(h.item(added).getAttribute('aria-pressed'), 'true');
  h.select('shape'); h.redo.click();
  assert.equal(h.item(added).querySelector('.slide-text-body').textContent, 'あいう');
  assert.equal(h.item(added).getAttribute('aria-pressed'), 'true');
  h.undo.click(); h.undo.click(); assert.equal(h.item(added), null); assert.equal(h.undo.disabled, true);
});

test('元に戻す DOM: 端・最小・同じ色では記録を足さず、redo も消さない', async (t) => {
  const h = await setup(t); h.select();
  for (let i = 0; i < 100; i++) h.resize('smaller');
  const before = await h.save(); h.resize('smaller'); await h.save();
  assert.equal(h.saved.at(-1), before);
  h.undo.click();
  h.root.querySelector('[data-focus-key="ed-color:#1F2A6B"]').click();
  assert.equal(h.redo.disabled, false);
  assert.equal(h.undo.disabled, true);
  h.resize('wider'); assert.equal(h.redo.disabled, true);
});

test('元に戻す DOM: ドラッグは1回。矢印キーとつまみキーはそれぞれ連打をまとめる', async (t) => {
  const h = await setup(t);
  pointer(h.item(), 'pointerdown'); pointer(h.item(), 'pointermove', 30); pointer(h.item(), 'pointermove', 42); pointer(h.item(), 'pointerup', 42);
  h.undo.click(); assert.equal(h.undo.disabled, true);
  h.item().dispatch('keydown', { key: 'ArrowLeft' }); h.item().dispatch('keydown', { key: 'ArrowLeft' });
  h.root.querySelector('.ed-handle').dispatch('keydown', { key: 'ArrowDown' });
  h.root.querySelector('.ed-handle').dispatch('keydown', { key: 'ArrowDown' });
  h.undo.click(); h.undo.click(); assert.equal(h.undo.disabled, true);
  assert.deepEqual((await h.save()).slides.one.items[0], h.deck.slides.one.items[0]);
});

for (const id of ['text', 'shape', 'image']) {
  test(`元に戻す DOM: ${id} の削除を戻すと内容・選択・画像データも戻る`, async (t) => {
    const h = await setup(t, { image: true }); h.select(id);
    assert.ok(h.root.querySelector('[data-focus-key="ed-resize:bigger"]'));
    button(h.root, 'この要素を削除').click(); assert.equal(h.item(id), null);
    h.undo.click(); assert.equal(h.item(id).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await h.save(), h.deck);
    h.redo.click(); assert.equal(h.item(id), null);
    const next = await h.save();
    if (id === 'image') assert.equal(next.images.picture, undefined);
  });
}

for (const empty of [true, false]) {
  test(`元に戻す DOM: スライド追加前の選択へ戻り、空なら選択を外す（空=${empty}）`, async (t) => {
    const h = await setup(t, { empty });
    button(h.root, '＋ 資料スライド').click();
    const added = h.root.querySelector('[aria-current="true"]').dataset.slideId;
    if (!empty) h.choose('video');
    h.undo.click();
    assert.equal(h.root.querySelector('[aria-current="true"]')?.dataset.slideId ?? null, empty ? null : 'one');
    assert.equal(h.root.querySelector('.ed-item.is-selected'), null);
    if (!empty) h.choose('content');
    h.redo.click(); assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, added);
  });
}

test('元に戻す DOM: 複製・並べ替え・削除を戻し、変更したスライドへ戻る', async (t) => {
  const h = await setup(t); h.select();
  button(h.root.querySelector('.ed-slide-actions'), '複製').click();
  const duplicate = h.root.querySelector('[aria-current="true"]').dataset.slideId;
  h.undo.click(); assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, 'one');
  assert.equal(h.item().getAttribute('aria-pressed'), 'true');
  h.redo.click(); assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, duplicate);
  button(h.root.querySelector('.ed-slide-actions'), '下へ').click();
  h.undo.click(); assert.equal((await h.save()).order[1], duplicate);
  button(h.root.querySelector('.ed-slide-actions'), '削除').click();
  const dialog = h.doc.querySelector('dialog[open]');
  assert.ok(dialog.textContent.includes('この画面を開いている間は、「元に戻す」で戻せます。'));
  assert.equal(h.key().defaultPrevented, false);
  button(dialog, '削除').click(); await flush();
  const afterDelete = h.root.querySelector('[aria-current="true"]').dataset.slideId;
  h.choose('video'); h.undo.click();
  assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, duplicate);
  h.choose('cloud');
  h.redo.click(); assert.equal(h.root.querySelector(`[data-slide-id="${duplicate}"]`), null);
  assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, afterDelete);
});

test('元に戻す DOM: 新しい文字要素を戻すと以前の選択へ。再実行は入力を再開しない', async (t) => {
  const h = await setup(t); h.select('shape'); button(h.root, '文字を追加').click();
  const added = h.root.querySelector('.ed-item.is-selected').dataset.itemId;
  h.undo.click(); assert.equal(h.item(added), null); assert.equal(h.item('shape').getAttribute('aria-pressed'), 'true');
  h.redo.click(); assert.equal(h.item(added).getAttribute('aria-pressed'), 'true');
  assert.equal(h.root.querySelector('.ed-phone-textarea'), null);
});

for (const type of ['poll', 'quiz', 'rating', 'free', 'cloud', 'video']) {
  test(`元に戻す DOM: ${type} の入力を項目別にまとめ、中央と右の欄も復元`, async (t) => {
    const h = await setup(t); h.choose(type);
    const selector = type === 'video' ? '#ed-video-caption' : type === 'rating' ? '#ed-rating-question' : ['poll', 'quiz'].includes(type) ? '#ed-poll-question' : '#ed-free-question';
    input(h.root.querySelector(selector), '一'); input(h.root.querySelector(selector), '一つ目');
    if (type === 'poll' || type === 'quiz') {
      input(h.root.querySelectorAll('.ed-opt-input')[0], '選択肢を変更');
      input(h.root.querySelectorAll('.ed-opt-input')[1], '別の選択肢');
      h.undo.click(); h.undo.click();
    }
    if (type === 'rating') {
      input(h.root.querySelector('#ed-rating-low'), '低い'); input(h.root.querySelector('#ed-rating-high'), '高い');
      h.undo.click(); h.undo.click();
    }
    if (type === 'video') {
      input(h.root.querySelector('#ed-video-url'), 'https://www.youtube.com/watch?v=abcdefghijk&t=30');
      h.undo.click(); assert.equal(h.root.querySelector('#ed-video-url').value, '');
    }
    assert.equal(h.root.querySelector(selector).value, '一つ目');
    h.undo.click(); assert.equal(h.undo.disabled, true);
    assert.deepEqual((await h.save()).slides[type], h.deck.slides[type]);
  });
}

for (const fields of [{}, { metaKey: true, ctrlKey: false }, { repeat: true }]) {
  test(`元に戻す DOM: ショートカットとやり直し ${JSON.stringify(fields)}`, async (t) => {
    const h = await setup(t); input(h.title, '変更'); h.doc.body.focus();
    assert.equal(h.key('z', fields).defaultPrevented, true); assert.equal(h.title.value, '履歴の確認');
    assert.equal(h.key('Z', { ...fields, shiftKey: true }).defaultPrevented, true); assert.equal(h.title.value, '変更');
    h.key('z', fields); assert.equal(h.key('y', fields).defaultPrevented, true);
    assert.equal(h.key('y', fields).defaultPrevented, false);
  });
}

for (const tag of ['input', 'textarea']) {
  test(`元に戻す DOM: ${tag} の target または focus ではアプリは何もしない`, async (t) => {
    const h = await setup(t); input(h.title, '変更');
    const node = h.doc.createElement(tag); h.root.append(node);
    node.focus(); assert.equal(h.key().defaultPrevented, false);
    h.doc.body.focus(); assert.equal(h.key('z', { target: node }).defaultPrevented, false);
    assert.equal(h.title.value, '変更'); assert.equal(h.undo.disabled, false);
  });
}

test('元に戻す DOM: 準備中は押せず、準備が終われば戻せる', async (t) => {
  const h = await setup(t); input(h.title, '変更');
  let resolve; h.holdStart(new Promise((r) => { resolve = r; }));
  button(h.root, '発表を開始').click();
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, true); assert.equal(h.key().defaultPrevented, false);
  resolve('trashed'); await flush(); assert.equal(h.undo.disabled, false);
  h.undo.click(); assert.equal(h.title.value, '履歴の確認');
});

test('元に戻す DOM: 保存失敗中も戻せて、次の保存に復元した内容を渡す', async (t) => {
  const h = await setup(t); input(h.title, '変更'); h.failSave(true); await h.save();
  assert.equal(h.undo.disabled, false); h.undo.click(); assert.equal(h.title.value, '履歴の確認');
  h.failSave(false); button(h.root, 'もう一度保存').click(); await flush();
  assert.equal(h.saved.at(-1).title, '履歴の確認');
});

test('元に戻す DOM: 画面を離れるとキーを解除し、残ったボタンも押せない', async (t) => {
  const h = await setup(t); input(h.title, '変更'); h.stop(); await flush();
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, true);
  assert.equal(h.key().defaultPrevented, false); h.undo.click(); assert.equal(h.title.value, '変更');
});

test('元に戻す DOM: 削除済みの教材では履歴操作・保存を止める', async (t) => {
  const h = await setup(t); input(h.title, '変更');
  await backgroundSaver().deleting('undo-test', h.deckId, async () => {});
  await h.save();
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, true); assert.equal(h.key().defaultPrevented, false);
  assert.ok(h.root.textContent.includes('この教材は見つかりません。'));
});

// 画像の縮小と寸法測定の完了を別々に進める。実際のファイルや通信は使わない。
function prepareImage(t, h) {
  const pending = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  globalThis.Image = class {
    constructor() { this.naturalWidth = 40; this.naturalHeight = 30; pending.push(this); }
    set src(value) { this.url = value; }
  };
  h.cleanup(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else delete globalThis.Image; });
  t.mock.method(URL, 'createObjectURL', () => 'blob:synthetic');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const create = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'canvas') {
      node.getContext = () => ({ fillRect() {}, drawImage() {} });
      node.toDataURL = () => 'data:image/jpeg;base64,AA==';
    }
    return node;
  };
  return {
    start() { const file = h.root.querySelector('.ed-file'); file.files = [{ type: 'image/png' }]; file.dispatch('change'); },
    async finish() { pending.shift().onload(); await flush(); pending.shift().onload(); await flush(); },
  };
}

test('元に戻す DOM: 画像の読み込み中に戻しても、完了時の教材へ別の1回として追加する', async (t) => {
  const h = await setup(t); const image = prepareImage(t, h);
  input(h.title, '変更'); image.start(); h.undo.click();
  assert.equal(h.title.value, '履歴の確認');
  await image.finish();
  const next = await h.save(); assert.equal(next.title, '履歴の確認');
  assert.equal(next.slides.one.items.length, 3); assert.equal(h.redo.disabled, true);
  h.undo.click(); assert.deepEqual(await h.save(), h.deck);
  h.redo.click(); assert.deepEqual(await h.save(), next);
});

for (const move of [false, true]) {
  test(`元に戻す DOM: 画像の完了時は表示を保ち、往復で追加先と画像を選ぶ（移動=${move}）`, async (t) => {
    const h = await setup(t); const image = prepareImage(t, h);
    h.select('shape'); image.start();
    if (move) { h.choose('poll'); input(h.root.querySelector('#ed-poll-question'), '読み込み中の編集'); }
    await image.finish();
    assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, move ? 'poll' : 'one');
    const next = await h.save(); const added = next.slides.one.items.at(-1);
    assert.equal(added.kind, 'image');
    if (move) assert.equal(h.root.querySelector('#ed-poll-question').value, '読み込み中の編集');
    h.undo.click();
    assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, 'one');
    assert.equal(h.item(added.id), null); assert.equal(h.root.querySelector('.ed-item.is-selected'), null);
    const before = await h.save(); assert.deepEqual(before.slides.one, h.deck.slides.one);
    assert.deepEqual(before.images, h.deck.images);
    if (move) assert.equal(before.slides.poll.question, '読み込み中の編集');
    h.choose('content'); h.redo.click();
    assert.equal(h.root.querySelector('[aria-current="true"]').dataset.slideId, 'one');
    assert.equal(h.item(added.id).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await h.save(), next);
  });
}

test('元に戻す DOM: 画像の読み込み中に追加先を削除した場合は履歴を増やさない', async (t) => {
  const h = await setup(t); const image = prepareImage(t, h);
  image.start(); button(h.root.querySelector('.ed-slide-actions'), '削除').click();
  button(h.doc.querySelector('dialog[open]'), '削除').click(); await flush();
  const deleted = await h.save(); await image.finish();
  assert.ok(h.root.textContent.includes('スライドが削除されたため、画像を追加できませんでした。'));
  assert.equal(await h.save(), deleted);
  h.undo.click(); assert.equal(h.undo.disabled, true); assert.deepEqual(await h.save(), h.deck);
  h.redo.click(); assert.deepEqual(await h.save(), deleted);
});

test('元に戻す DOM: 読み込み元の追加スライドを戻して消した場合は従来の画像エラー', async (t) => {
  const h = await setup(t); const image = prepareImage(t, h);
  button(h.root, '＋ 資料スライド').click(); image.start(); h.undo.click(); await image.finish();
  assert.ok(h.root.textContent.includes('スライドが削除されたため、画像を追加できませんでした。'));
  assert.equal(h.undo.disabled, true); assert.equal(h.redo.disabled, false);
  assert.deepEqual(await h.save(), h.deck);
});

test('元に戻す DOM: 再表示では、前の編集画面の履歴を引き継がない', async (t) => {
  const h = await setup(t); input(h.title, '保存する教材名'); await h.save(); h.stop(); await flush();
  const nextStop = mount(h.root, { params: { deckId: h.deckId }, auth: { user: { uid: 'undo-test' } },
    repo: { deckState: async () => 'live', loadDeck: async () => h.saved.at(-1), saveDeck: async () => {} } });
  h.cleanup(nextStop); await flush();
  assert.equal(h.root.querySelector('.ed-title').value, '保存する教材名');
  assert.equal(h.root.querySelector('[aria-label="元に戻す"]').disabled, true);
  assert.equal(h.root.querySelector('[aria-label="やり直す"]').disabled, true);
});
