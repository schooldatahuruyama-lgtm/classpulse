// 発表の画面: ワードクラウドの文字の大きさ・並び・色、受付・結果のボタン、正答率・平均の文の決めごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudFontSize, cloudOrder, cloudTone, CLOUD_FONT, CLOUD_TONES, pollControls, quizSummaryText } from '../js/views/present.js';
import { ratingAverageText, correctRateText, ratingBarLabels } from '../js/ui.js';
import { mount as mountPresent, heldControls, remainingHeld } from '../js/views/present.js';
import { mount as mountWords, wordsInput } from '../js/views/words.js';
import { createDeck, createSlide, addSlide } from '../js/model.js';
import { buildSession, hiddenKey } from '../js/session-logic.js';
import { createRepo } from '../js/repo.js';
import { createFakeNet } from './helpers/fake-net.js';

test('確認待ち: 結果表示・接続・終了・移動待ちのボタンの決めごと', () => {
  const base = { kind: 'free', heldCount: 1, resultsVisible: true, connection: 'connected' };
  assert.deepEqual(heldControls(base), { hidden: false, blocked: false });
  assert.equal(heldControls({ ...base, kind: 'cloud' }).blocked, false);
  for (const change of [{ resultsVisible: false }, { connection: 'disconnected' }, { ending: true }, { moving: 1 }]) {
    assert.deepEqual(heldControls({ ...base, ...change }), { hidden: false, blocked: true });
  }
  for (const change of [{ kind: 'poll' }, { heldCount: 0 }, { heldCount: null }]) {
    assert.deepEqual(heldControls({ ...base, ...change }), { hidden: true, blocked: true });
  }
});

test('確認待ちの写し: 新着・書き直しは加えず、消えた回答は戻らない。人数も書きかえない', () => {
  const shown = [{ key: 'a', text: '元の文' }, { key: 'b', text: '言葉', count: 2 }];
  const next = remainingHeld(shown, [{ key: 'a', text: '新しい文' }, { key: 'b', text: '言葉', count: 3 }, { key: 'c', text: '新着' }]);
  assert.deepEqual(next, [shown[1]]);
  assert.deepEqual(remainingHeld(next, shown), [shown[1]]);
  assert.deepEqual(remainingHeld(next, []), []);
});

test('止める言葉の入力: 空行・重複は通知に数えず、不適切な長さと 100 語超えを数える', () => {
  assert.deepEqual(wordsInput(' ＡＢ \nab\na\n' + '長'.repeat(21) + '\n\n'), { words: ['ＡＢ'], removed: 2 });
  const input = Array.from({ length: 102 }, (_, i) => `語句${i}`).join('\n');
  assert.equal(wordsInput(input).words.length, 100);
  assert.equal(wordsInput(input).removed, 2);
});

// 外部ライブラリを使わない小さな DOM。実際の mount とイベントを通して、本文の作成時点と破棄を確かめる。
function testDom(t) {
  const previous = Object.fromEntries(['document', 'window', 'Node', 'Element', 'HTMLElement'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const made = [];
  const cleanups = [];
  let doc;
  class TestNode {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.attributes = {}; this.events = new Map(); this.parentElement = null; this.style = { setProperty() {} }; made.push(this); }
    get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
    get className() { return this.attributes.class || ''; }
    set className(value) { this.attributes.class = value; }
    get classList() {
      const toggle = (name, on) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (on) names.add(name); else names.delete(name); this.className = [...names].join(' '); };
      return { toggle, add: (...names) => names.forEach((name) => toggle(name, true)) };
    }
    get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get open() { return Object.hasOwn(this.attributes, 'open'); }
    get isConnected() { return this === doc.body || !!this.parentElement?.isConnected; }
    get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(value) { if (this.tagName === '#text') this.text = String(value); else this.replaceChildren(doc.createTextNode(String(value))); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...nodes) { nodes.forEach((n) => this.insertBefore(n instanceof TestNode ? n : doc.createTextNode(String(n)), null)); }
    insertBefore(node, before) { node.remove(); const i = before ? this.childNodes.indexOf(before) : -1; this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node); node.parentElement = this; }
    replaceChildren(...nodes) { for (const node of this.childNodes) node.parentElement = null; this.childNodes = []; this.append(...nodes); }
    remove() { if (this.parentElement) { const p = this.parentElement; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentElement = null; } }
    contains(node) { return node === this || this.childNodes.some((n) => n.contains(node)); }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some((s) => this.matches(s.trim()));
      if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
      if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
      return this.tagName === selector;
    }
    querySelectorAll(selector) { return this.childNodes.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
    removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
    dispatch(name, fields = {}) { const ev = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields }; for (const fn of [...(this.events.get(name) || [])]) fn(ev); return ev; }
    click() { this.dispatch('click'); }
    focus() { doc.activeElement = this; }
    showModal() { this.setAttribute('open', ''); }
    close() { if (this.open) { this.removeAttribute('open'); this.dispatch('close'); } }
  }
  doc = new TestNode('#document');
  doc.body = new TestNode('body');
  doc.append(doc.body);
  doc.activeElement = doc.body;
  doc.createElement = (tag) => new TestNode(tag);
  doc.createTextNode = (text) => { const node = new TestNode('#text'); node.text = text; return node; };
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  const timers = new Map();
  let seq = 0;
  Object.assign(globalThis, { document: doc, Node: TestNode, Element: TestNode, HTMLElement: TestNode,
    window: { location: { href: 'http://localhost/?demo=1#/present/test' }, setTimeout: (fn) => { timers.set(++seq, fn); return seq; }, clearTimeout: (id) => timers.delete(id) } });
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const root = doc.createElement('main');
  doc.body.append(root);
  return { root, doc, made, onCleanup: (fn) => cleanups.push(fn) };
}

const flushView = () => new Promise((resolve) => setImmediate(resolve));
const buttonText = (root, text) => root.querySelectorAll('button').find((button) => button.textContent === text);

async function presentSetup(t, kind) {
  const dom = testDom(t);
  let deck = addSlide(createDeck('確認', 1), { ...createSlide(kind), question: '問い' }, 's1');
  deck = addSlide(deck, createSlide('content'), 's2');
  const session = buildSession(deck, 'deck', 'teacher-test', 1);
  session.pub.current = { slideId: 's1', index: 0 };
  session.pub.polls.s1.status = 'open';
  const net = createFakeNet();
  await net.set('sessions/test', session);
  const repo = createRepo(net, 'teacher-test');
  const cleanup = mountPresent(dom.root, { params: { sid: 'test' }, net, repo, navigate: async () => {} });
  dom.onCleanup(cleanup);
  await flushView();
  const answer = async (key, text) => { await net.set(`sessions/test/inbox/answers/s1/${key}`, kind === 'free' ? { text, at: 1 } : { words: [text], at: 1 }); await flushView(); };
  const open = async () => {
    buttonText(dom.root, '確かめる').click();
    assert.ok(dom.doc.querySelector('.confirm'));
    buttonText(dom.doc, '出す').click();
    await flushView();
    return dom.root.querySelector('.pr-held-dialog');
  };
  return { ...dom, net, repo, cleanup, answer, open };
}

for (const kind of ['free', 'cloud']) {
  test(`発表 DOM (${kind}): 確認前は本文なし。開いても新着・書き直しを映さず、映すと即反映`, async (t) => {
    const h = await presentSetup(t, kind);
    await h.answer('private-a', '死ね');
    await h.answer('private-b', 'バカ');
    assert.doesNotMatch(h.root.textContent, /死ね|バカ/);
    assert.equal(buttonText(h.root, '確かめる').getAttribute('aria-disabled'), 'true');
    buttonText(h.root, '確かめる').click();
    assert.equal(h.doc.querySelector('.confirm'), null);
    buttonText(h.root, '結果を表示').click();
    await flushView();
    assert.doesNotMatch(h.root.textContent, /死ね|バカ/);
    assert.ok(h.made.every((node) => !/死ね|バカ/.test(node.textContent)));
    const dlg = await h.open();
    assert.match(dlg.textContent, /死ね/);
    assert.match(dlg.textContent, /バカ/);
    assert.ok(h.made.every((node) => !/private-a|private-b/.test(JSON.stringify(node.attributes))));
    assert.ok(h.made.every((node) => !JSON.stringify(node.attributes).includes(hiddenKey('死ね'))));
    const current = h.net.dump().sessions.test.pub.current;
    h.doc.dispatch('keydown', { key: 'ArrowRight', target: h.doc.body });
    h.doc.dispatch('keydown', { key: ' ', target: h.doc.body });
    await flushView();
    assert.deepEqual(h.net.dump().sessions.test.pub.current, current);
    await h.answer('private-c', 'うぜー');
    await h.answer('private-a', '死ねよ');
    assert.doesNotMatch(dlg.textContent, /うぜー|死ね/);
    assert.match(dlg.textContent, /バカ/);
    buttonText(dlg, '映す').click();
    await flushView();
    assert.match(dlg.textContent, /確認待ちの回答はありません。/);
    assert.doesNotMatch(dlg.textContent, /バカ/);
    assert.match(h.root.querySelector('.pr-stage').textContent, /バカ/);
    buttonText(dlg, 'とじる').click();
    assert.equal(h.root.querySelector('.pr-held-dialog'), null);
    assert.equal(h.doc.activeElement, buttonText(h.root, '確かめる'));
    const next = await h.open();
    assert.match(next.textContent, /うぜー|死ねよ/);
    await h.net.update('sessions/test/pub', { 'polls/s1/resultsVisible': false });
    await flushView();
    assert.equal(h.root.querySelector('.pr-held-dialog'), null);
    assert.doesNotMatch(h.root.textContent, /うぜー|死ねよ|バカ/);
  });
}

test('発表 DOM: 確認中のスライド移動、一覧中のスライド移動・終了・画面離脱で閉じる', async (t) => {
  const h = await presentSetup(t, 'free');
  await h.answer('private-a', '死ね');
  buttonText(h.root, '結果を表示').click(); await flushView();
  buttonText(h.root, '確かめる').click();
  await h.net.update('sessions/test/pub', { current: { slideId: 's2', index: 1 } }); await flushView();
  assert.equal(h.doc.querySelector('dialog[open]'), null);
  await h.net.update('sessions/test/pub', { current: { slideId: 's1', index: 0 } }); await flushView();
  await h.open();
  await h.net.update('sessions/test/pub', { current: { slideId: 's2', index: 1 } }); await flushView();
  assert.equal(h.doc.querySelector('dialog[open]'), null);
  await h.net.update('sessions/test/pub', { current: { slideId: 's1', index: 0 } }); await flushView();
  await h.open();
  await h.net.update('sessions/test/pub', { state: 'ended' }); await flushView();
  assert.equal(h.doc.querySelector('.pr-held-dialog'), null);
  h.cleanup();
  assert.equal(h.doc.querySelector('dialog[open]'), null);
});

test('止める言葉 DOM: 読みこみ失敗と再試行、保存の正規化・成功・失敗', async (t) => {
  const { root } = testDom(t);
  let failLoad = true;
  let failSave = false;
  let saved;
  const repo = {
    getModeration: async () => { if (failLoad) throw new Error('offline'); return { enabled: true, words: [] }; },
    saveModeration: async (value) => { if (failSave) throw new Error('offline'); saved = value; },
  };
  const cleanup = mountWords(root, { repo }); t.after(cleanup);
  await flushView();
  assert.match(root.textContent, /読みこめませんでした。/);
  failLoad = false;
  buttonText(root, 'もう一度').click(); await flushView();
  assert.equal(root.querySelector('details').open, false);
  root.querySelector('textarea').value = 'ＡＢ\nab\na';
  root.querySelector('input').checked = false;
  root.querySelector('form').dispatch('submit'); await flushView();
  assert.deepEqual(saved, { enabled: false, words: ['ＡＢ'] });
  assert.equal(root.querySelector('textarea').value, 'ＡＢ');
  assert.match(root.textContent, /保存しました。次に発表の画面を開いたときから使われます。/);
  assert.match(root.textContent, /使えない言葉を 1 個はずしました。/);
  failSave = true;
  root.querySelector('form').dispatch('submit'); await flushView();
  assert.match(root.textContent, /保存できませんでした。接続を確かめて、もう一度押してください。/);
  assert.equal(buttonText(root, '保存').disabled, false);
});

for (const operation of ['load', 'save']) {
  for (const rejected of [false, true]) {
    test(`止める言葉 DOM: 離れたあと ${operation} が ${rejected ? '失敗' : '成功'} しても画面を変えない`, async (t) => {
      const { root } = testDom(t);
      let resolve, reject;
      const pending = new Promise((a, b) => { resolve = a; reject = b; });
      const repo = { getModeration: () => operation === 'load' ? pending : Promise.resolve({ enabled: true, words: [] }), saveModeration: () => pending };
      const cleanup = mountWords(root, { repo });
      if (operation === 'save') { await flushView(); root.querySelector('form').dispatch('submit'); }
      const before = root.textContent;
      cleanup();
      if (rejected) reject(new Error('offline')); else resolve({ enabled: false, words: [] });
      await flushView();
      assert.equal(root.textContent, before);
    });
  }
}

test('文字の大きさ: 全員が同じ人数なら、どの言葉も同じ大きさ', () => {
  assert.equal(cloudFontSize(3, 3, 3), CLOUD_FONT.same);
  assert.equal(cloudFontSize(1, 1, 1), CLOUD_FONT.same);
});

test('文字の大きさ: 最大の人数が最大の大きさ、最小の人数が最小の大きさ', () => {
  assert.equal(cloudFontSize(10, 1, 10), CLOUD_FONT.max);
  assert.equal(cloudFontSize(1, 1, 10), CLOUD_FONT.min);
  assert.equal(cloudFontSize(2, 2, 3), CLOUD_FONT.min);
  assert.equal(cloudFontSize(3, 2, 3), CLOUD_FONT.max);
});

test('文字の大きさ: 人数が多いほど大きい（間は最小と最大の間）', () => {
  let prev = -Infinity;
  for (let c = 1; c <= 30; c++) {
    const s = cloudFontSize(c, 1, 30);
    assert.ok(s >= prev, `${c}`);
    assert.ok(s >= CLOUD_FONT.min && s <= CLOUD_FONT.max);
    prev = s;
  }
  assert.ok(cloudFontSize(2, 1, 30) > cloudFontSize(1, 1, 30));
});

test('文字の大きさ: おかしな値でも、決まった範囲の数を返す', () => {
  for (const args of [[NaN, 1, 3], [5, 1, 3], [0, 1, 3], [1, undefined, 3], [1, 3, 1]]) {
    const s = cloudFontSize(...args);
    assert.ok(Number.isFinite(s) && s >= CLOUD_FONT.min && s <= CLOUD_FONT.max, String(args));
  }
});

const items = [
  { key: 'a', word: 'あ', count: 5 }, { key: 'b', word: 'い', count: 4 }, { key: 'c', word: 'う', count: 3 },
  { key: 'd', word: 'え', count: 2 }, { key: 'e', word: 'お', count: 1 }, { key: '%E3%81%AD%E3%81%93', word: 'ねこ', count: 1 },
];

test('並び: 言葉の鍵から決まり、渡された順・人数に左右されない。元の配列は変えない', () => {
  const copy = items.map((x) => ({ ...x }));
  const a = cloudOrder(items).map((x) => x.key);
  const b = cloudOrder([...items].reverse()).map((x) => x.key);
  const c = cloudOrder(items.map((x) => ({ ...x, count: 1 }))).map((x) => x.key);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(items, copy);
  assert.deepEqual([...a].sort(), items.map((x) => x.key).sort());
});

test('並び: 人数の多い順のままにはしない。言葉を足しても、ほかの言葉どうしの並びは変わらない', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, word: `w${i}`, count: 20 - i }));
  const order = cloudOrder(many).map((x) => x.key);
  assert.notDeepEqual(order, many.map((x) => x.key));
  const more = cloudOrder([...many, { key: 'new', word: 'new', count: 1 }]).map((x) => x.key).filter((k) => k !== 'new');
  assert.deepEqual(more, order);
});

test('並び: 空・配列でないものは空の配列', () => {
  assert.deepEqual(cloudOrder([]), []);
  assert.deepEqual(cloudOrder(null), []);
});

test('色: 言葉の鍵から決まり、0〜CLOUD_TONES-1。いくつかの色に分かれる', () => {
  const tones = new Set();
  for (let i = 0; i < 40; i++) {
    const t = cloudTone(`k${i}`);
    assert.equal(t, cloudTone(`k${i}`));
    assert.ok(Number.isInteger(t) && t >= 0 && t < CLOUD_TONES);
    tones.add(t);
  }
  assert.ok(tones.size > 1);
});

// ---- 受付・結果のボタン（クイズ・5 段階評価） ----

test('ボタン: クイズは「正解を表示」／「正解をかくす」、ほかの種類は「結果を表示」／「結果をかくす」', () => {
  assert.equal(pollControls({ kind: 'quiz', status: 'open', resultsVisible: false }).resultsLabel, '正解を表示');
  assert.equal(pollControls({ kind: 'quiz', status: 'closed', resultsVisible: true }).resultsLabel, '正解をかくす');
  for (const kind of ['poll', 'rating', 'free', 'cloud']) {
    assert.equal(pollControls({ kind, status: 'open', resultsVisible: false }).resultsLabel, '結果を表示');
    assert.equal(pollControls({ kind, status: 'open', resultsVisible: true }).resultsLabel, '結果をかくす');
  }
});

test('ボタン: クイズは締め切ったあと・正解の表示中は、受付の停止・再開を出さない', () => {
  assert.equal(pollControls({ kind: 'quiz', status: 'open', resultsVisible: false }).pauseHidden, false);
  assert.equal(pollControls({ kind: 'quiz', status: 'paused', resultsVisible: false }).pauseHidden, false);
  assert.equal(pollControls({ kind: 'quiz', status: 'closed', resultsVisible: false }).pauseHidden, true);
  assert.equal(pollControls({ kind: 'quiz', status: 'closed', resultsVisible: true }).pauseHidden, true);
});

test('ボタン: アンケートなどは今までどおり（締切後も停止のボタンは出したまま押せない）', () => {
  for (const kind of ['poll', 'rating', 'free', 'cloud']) {
    assert.deepEqual(pollControls({ kind, status: 'closed', resultsVisible: true }), {
      pauseLabel: '受付を止める', pauseHidden: false, pauseBlocked: true, resultsLabel: '結果をかくす', resultsBlocked: false,
    });
  }
  assert.equal(pollControls({ kind: 'poll', status: 'paused', resultsVisible: false }).pauseLabel, '受付を再開');
  assert.equal(pollControls({ kind: 'poll', status: 'open', resultsVisible: false }).pauseBlocked, false);
  assert.equal(pollControls({ kind: 'poll', status: 'waiting', resultsVisible: false }).resultsBlocked, true);
  assert.equal(pollControls({ kind: 'quiz', status: 'waiting', resultsVisible: false }).resultsBlocked, true);
});

test('正答率の文: 「正答率 62%（8 / 13 人）」、0 人・無いときは「正答率 —」', () => {
  assert.equal(correctRateText({ correctCount: 8, total: 13, percent: 62 }), '正答率 62%（8 / 13 人）');
  assert.equal(correctRateText({ correctCount: 0, total: 0, percent: null }), '正答率 —');
  assert.equal(correctRateText(null), '正答率 —');
  assert.equal(correctRateText({ correctCount: 0, total: 3, percent: 0 }), '正答率 0%（0 / 3 人）');
});

test('クイズの結果の文: 正解を読みこめなかったときは、その旨', () => {
  assert.equal(quizSummaryText(null, null), '正解のデータを読みこめませんでした');
  assert.equal(quizSummaryText(1, { correctCount: 2, total: 4, percent: 50 }), '正答率 50%（2 / 4 人）');
  assert.equal(quizSummaryText(0, { correctCount: 0, total: 0, percent: null }), '正答率 —');
});

test('平均の文: 小数 1 けた（整数も 1 けた）、0 人・平均が無いときは「平均 —」', () => {
  assert.equal(ratingAverageText(3.8, 13), '平均 3.8（13 人）');
  assert.equal(ratingAverageText(4, 2), '平均 4.0（2 人）');
  assert.equal(ratingAverageText(null, 0), '平均 —');
  assert.equal(ratingAverageText(null, 3), '平均 —');
  assert.equal(ratingAverageText(3, 0), '平均 —');
});

test('評価の棒の文: 1 と 5 の行だけ両はしの言葉', () => {
  assert.deepEqual(ratingBarLabels('低い', '高い', 5), ['低い', '', '', '', '高い']);
  assert.deepEqual(ratingBarLabels('', undefined, 5), ['', '', '', '', '']);
});
