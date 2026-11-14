import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { editorDom } from './helpers/editor-dom.js';
import { flush } from './helpers/resilience.js';
import { createFakeNet } from './helpers/fake-net.js';
import { fakeStorage } from './helpers/fakes.js';
import { renderSlide } from '../js/slide-render.js';
import { createTextItem, createShapeItem } from '../js/model.js';
import { buildSession } from '../js/session-logic.js';
import { mount as mountPresent } from '../js/views/present.js';
import { mount as mountStudent } from '../js/views/student.js';
import { mount as mountEditor } from '../js/views/editor.js';

const slide = { type: 'content', items: [
  { ...createTextItem('first'), text: '最初から' },
  { ...createTextItem('one'), text: '一回目', step: 1 },
  { ...createShapeItem('two'), step: 3 },
  { id: 'image', kind: 'image', imageId: 'missing', x: 0, y: 0, w: 0.2, h: 0.2, step: 3 },
] };
const items = (root) => root.querySelectorAll('.slide-item');
const visible = (root) => items(root).filter((node) => !node.hidden).map((node) => node.dataset.itemId);
const fades = (root) => root.querySelectorAll('.slide-item-enter').map((node) => node.dataset.itemId);

test('描画: 増えた回の要素だけフェード。同じ回の再描画・戻る・別のスライドは再実行しない', (t) => {
  const h = editorDom(t);
  const render = (step, extra = {}) => renderSlide(h.root, slide, {}, { step, slideId: 'a', ...extra });
  render(0);
  assert.equal(items(h.root).length, 4);
  assert.deepEqual(visible(h.root), ['first']);
  assert.deepEqual(fades(h.root), []);
  render(1);
  assert.deepEqual(fades(h.root), ['one']);
  // 0.3 秒を待たずに次を押しても、前の要素は表示済み、新しい回だけフェード。
  render(2);
  assert.deepEqual(visible(h.root), ['first', 'one', 'two', 'image']);
  assert.deepEqual(fades(h.root), ['two', 'image']);
  render(2);
  assert.deepEqual(fades(h.root), []);
  render(1);
  assert.deepEqual(visible(h.root), ['first', 'one']);
  assert.deepEqual(fades(h.root), []);
  render(2, { slideId: 'different' });
  assert.deepEqual(fades(h.root), []);
});

test('描画: 初回・再接続はフェードなし、縮小表示・見本は全部見せ、番号の印は付けない', (t) => {
  const h = editorDom(t);
  renderSlide(h.root, slide, {}, { step: 1 });
  assert.deepEqual(fades(h.root), []);
  renderSlide(h.root, slide, {}, { step: 2, animate: false });
  assert.deepEqual(fades(h.root), []);
  for (const options of [{}, { mode: 'thumb', step: 0 }, { step: '3' }, { step: -2 }, { step: 100 }]) {
    renderSlide(h.root, slide, {}, options);
    assert.equal(visible(h.root).length, options.step === -2 ? 1 : 4);
    assert.equal(h.root.querySelector('[data-step-rank]'), null);
  }
});

async function sessionView(t, kind, step = 0, only = false) {
  const h = editorDom(t);
  window.location = { href: 'http://localhost/?demo=1#/present/animation-view' };
  window.scrollTo = () => {};
  const deck = { title: '表示の確認', order: only ? ['a'] : ['a', 'q'], slides: {
    a: slide, q: { type: 'poll', question: '確認', options: ['はい', 'いいえ'], resultMode: 'manual' },
  }, images: {} };
  const session = buildSession(deck, 'deck', 'teacher-test', 1);
  session.pub.current = { slideId: 'a', index: 0, step };
  const net = createFakeNet({ initial: { sessions: { 'animation-view': session } } });
  const subscribe = net.subscribe;
  net.subscribe = (path, onValue, onStatus) => {
    let online = true;
    return subscribe(path, (value) => { if (online) onValue(value); }, (status) => {
      online = status === 'connected'; onStatus(status);
    });
  };
  const ctx = { params: { sid: 'animation-view' }, net, storage: fakeStorage(),
    repo: { getModeration: async () => null }, auth: { signInAnonymous: async () => ({ uid: 'student-test' }) }, navigate() {} };
  let stop = (kind === 'teacher' ? mountPresent : mountStudent)(h.root, ctx);
  h.cleanup(() => stop());
  await flush();
  return { ...h, net, ctx, current: (value) => net.set('sessions/animation-view/pub/current', value),
    reload: async () => { stop(); stop = (kind === 'teacher' ? mountPresent : mountStudent)(h.root, ctx); await flush(); } };
}

test('先生 DOM: ボタンとキーで出す・隠す。初めのスライドでも回数があれば戻れる', async (t) => {
  const h = await sessionView(t, 'teacher');
  const next = h.root.querySelector('.pr-next');
  const prev = h.root.querySelector('.pr-prev');
  assert.equal(h.root.querySelector('.pr-step').textContent, '出す 0／2');
  assert.equal(prev.getAttribute('aria-disabled'), 'true');
  assert.deepEqual(visible(h.root), ['first']);
  assert.equal(h.root.querySelector('.slide-enter'), null);
  next.click(); await flush();
  assert.equal(h.root.querySelector('.pr-step').textContent, '出す 1／2');
  assert.notEqual(prev.getAttribute('aria-disabled'), 'true');
  assert.deepEqual(fades(h.root), ['one']);
  const frame = h.root.querySelector('.slide-frame');
  await h.net.set('sessions/animation-view/inbox/participants/another-test', 2);
  await h.net.set('sessions/animation-view/pub/title', '更新');
  assert.equal(h.root.querySelector('.slide-frame'), frame);
  h.doc.dispatch('keydown', { key: 'ArrowRight' }); await flush();
  assert.deepEqual(fades(h.root), ['two', 'image']);
  h.doc.dispatch('keydown', { key: 'PageUp' }); await flush();
  assert.deepEqual(visible(h.root), ['first', 'one']);
  assert.deepEqual(fades(h.root), []);
  prev.click(); await flush();
  assert.deepEqual(visible(h.root), ['first']);
});

test('先生 DOM: 最後のスライドの途中は次へ、出し終えたら今までの最後の表示', async (t) => {
  const h = await sessionView(t, 'teacher', 0, true);
  const next = h.root.querySelector('.pr-next');
  assert.equal(next.hidden, false);
  assert.equal(h.root.querySelector('.pr-last').hidden, true);
  next.click(); await flush();
  assert.equal(next.hidden, false);
  next.click(); await flush();
  assert.equal(next.hidden, true);
  assert.equal(h.root.querySelector('.pr-last').hidden, false);
  assert.equal(h.net.dump().sessions['animation-view'].pub.state, 'live');
});

test('先生 DOM: スライド変更だけ切り替え、質問から戻れば全部表示、再読みこみで回数を維持', async (t) => {
  const h = await sessionView(t, 'teacher', 2);
  h.root.querySelector('.pr-next').click(); await flush();
  assert.ok(h.root.querySelector('.slide-enter'));
  assert.equal(h.root.querySelector('.pr-step').hidden, true);
  const frame = h.root.querySelector('.slide-frame');
  await h.net.set('sessions/animation-view/pub/title', '更新');
  assert.equal(h.root.querySelector('.slide-frame'), frame);
  h.root.querySelector('.pr-prev').click(); await flush();
  assert.equal(visible(h.root).length, 4);
  assert.deepEqual(fades(h.root), []);
  h.root.querySelector('.pr-prev').click(); await flush();
  await h.reload();
  assert.equal(h.root.querySelector('.pr-step').textContent, '出す 1／2');
  assert.deepEqual(visible(h.root), ['first', 'one']);
  assert.deepEqual(fades(h.root), []);
  assert.equal(h.root.querySelector('.slide-enter'), null);
});

test('生徒 DOM: 途中参加・再接続はフェードなし。同じ回の更新では DOM を置きかえない', async (t) => {
  const h = await sessionView(t, 'student', 1);
  assert.deepEqual(visible(h.root), ['first', 'one']);
  assert.deepEqual(fades(h.root), []);
  await h.current({ slideId: 'a', index: 0, step: 2 });
  assert.deepEqual(fades(h.root), ['two', 'image']);
  const frame = h.root.querySelector('.slide-frame');
  await h.net.set('sessions/animation-view/pub/title', '更新');
  assert.equal(h.root.querySelector('.slide-frame'), frame);
  h.net.setOnline(false);
  const remote = h.net.dump();
  remote.sessions['animation-view'].pub.current.step = 0;
  h.net.replaceRoot(remote);
  h.net.setOnline(true);
  assert.deepEqual(visible(h.root), ['first']);
  assert.deepEqual(fades(h.root), []);
  await h.current({ slideId: 'a', index: 0, step: 1 });
  assert.deepEqual(fades(h.root), ['one']);
  await h.current({ slideId: 'q', index: 1, step: 0 });
  assert.ok(h.root.querySelector('.slide-enter'));
  assert.equal(items(h.root).length, 0);
});

for (const kind of ['teacher', 'student']) {
  test(`${kind} DOM: 切断中に進んだ回数へ復帰してもフェードしない`, async (t) => {
    const h = await sessionView(t, kind, 0);
    h.net.setOnline(false);
    const remote = h.net.dump();
    remote.sessions['animation-view'].pub.current.step = 1;
    h.net.replaceRoot(remote);
    assert.deepEqual(visible(h.root), ['first']);
    h.net.setOnline(true);
    assert.deepEqual(visible(h.root), ['first', 'one']);
    assert.deepEqual(fades(h.root), []);
    await h.current({ slideId: 'a', index: 0, step: 2 });
    assert.deepEqual(fades(h.root), ['two', 'image']);
    h.net.setOnline(false);
    const moved = h.net.dump();
    moved.sessions['animation-view'].pub.current = { slideId: 'q', index: 1, step: 0 };
    h.net.replaceRoot(moved);
    h.net.setOnline(true);
    assert.equal(h.root.querySelector('.slide-enter'), null);
  });

  test(`${kind} DOM: 古い current は全部見せ、不正な回数は黙って正す`, async (t) => {
    const h = await sessionView(t, kind, undefined);
    for (const step of [undefined, '3', '文字', null]) {
      await h.current({ slideId: 'a', index: 0, step });
      assert.equal(visible(h.root).length, 4);
    }
    await h.current({ slideId: 'a', index: 0, step: -10 });
    assert.deepEqual(visible(h.root), ['first']);
    await h.current({ slideId: 'a', index: 0, step: 90 });
    assert.equal(visible(h.root).length, 4);
    assert.equal(h.root.querySelector('.toast'), null);
  });
}

for (const narrow of [true, false]) {
  test(`編集 DOM: どの幅も順番を保存、上下限で disabled、全要素の番号を更新、まとめて元に戻す（狭い=${narrow}）`, async (t) => {
    const h = editorDom(t, narrow);
    t.mock.method(Date, 'now', () => 100);
    const deck = { title: '編集の確認', order: ['a'], slides: { a: structuredClone(slide) }, images: {} };
    const saved = [];
    const stop = mountEditor(h.root, { params: { deckId: `animation-editor-${narrow}` }, auth: { user: { uid: 'teacher-test' } },
      repo: { deckState: async () => 'live', loadDeck: async () => deck, saveDeck: async (_, next) => saved.push(structuredClone(next)) } });
    h.cleanup(async () => { stop(); await flush(); });
    await flush();
    const select = (id) => h.root.querySelector(`[data-focus-key="ed-pick:${id}"]`).click();
    const item = (id) => h.root.querySelector('.ed-center').querySelector(`[data-item-id="${id}"]`);
    const plus = () => h.root.querySelector('[data-focus-key="ed-step:plus"]');
    const minus = () => h.root.querySelector('[data-focus-key="ed-step:minus"]');
    for (const id of ['two', 'image']) {
      select(id);
      assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 3（「次へ」の 2 回目で出る）');
      assert.equal(item(id).dataset.stepRank, '2');
    }
    select('first');
    assert.equal(minus().disabled, true);
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '最初から出す');
    plus().click(); plus().click();
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 2（「次へ」の 2 回目で出る）');
    assert.equal(item('first').dataset.stepRank, '2');
    assert.equal(item('two').dataset.stepRank, '3');
    h.root.querySelector('[aria-label="元に戻す"]').click();
    assert.equal(item('first').dataset.stepRank, undefined);
    assert.equal(item('two').dataset.stepRank, '2');
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '最初から出す');
    h.root.querySelector('[aria-label="やり直す"]').click();
    assert.equal(item('first').dataset.stepRank, '2');
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 2（「次へ」の 2 回目で出る）');
    for (let i = 0; i < 19; i++) plus().click();
    assert.equal(plus().disabled, true);
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 20（「次へ」の 3 回目で出る）');
    for (let i = 0; i < 21; i++) minus().click();
    assert.equal(minus().disabled, true);
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '最初から出す');
    select('two'); plus().click();
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 4（「次へ」の 3 回目で出る）');
    select('image'); plus().click();
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 4（「次へ」の 2 回目で出る）');
    select('two');
    assert.equal(h.root.querySelector('.ed-step-label').textContent, '順番 4（「次へ」の 2 回目で出る）');
    assert.equal(item('two').dataset.stepRank, '2');
    assert.equal(item('image').dataset.stepRank, '2');
    assert.equal(visible(h.root.querySelector('.ed-center')).length, 4);
    assert.equal(h.root.querySelector('.ed-slides').querySelector('[data-step-rank]'), null);
    h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); await flush();
    const stored = saved.at(-1).slides.a.items;
    assert.equal(stored.find((it) => it.id === 'first').step, undefined);
    assert.equal(stored.find((it) => it.id === 'two').step, 4);
    assert.equal(stored.find((it) => it.id === 'image').step, 4);
  });
}

test('CSS: フェード 0.3 秒・切り替え 0.25 秒。視差効果を減らす設定では停止し、順番ボタンは 44px 以上', () => {
  const css = readFileSync(new URL('../css/slide.css', import.meta.url), 'utf8');
  assert.match(css, /\.slide-item-enter\s*\{\s*animation: slide-fade-in 0\.3s/);
  assert.match(css, /\.slide-enter\s*\{\s*animation: slide-fade-in 0\.25s/);
  assert.match(css, /@media\s*\(prefers-reduced-motion: reduce\)\s*\{\s*\.slide-item-enter, \.slide-enter\s*\{ animation: none; transition: none;/);
  assert.match(readFileSync(new URL('../css/editor.css', import.meta.url), 'utf8'), /\.ed-step-buttons > button\s*\{ min-width: 44px; min-height: 44px;/);
});
