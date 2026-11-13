// 生徒の画面: 送信ボタンの文と押せるか、回答の状態の文、ファイルの約束ごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendButtonState, answerMessage, pollDecision, endedDecision, freeDecision, freeShownText, cloudDecision, cloudShownWords, quizVerdict } from '../js/views/student.js';
import { mount as mountStudent } from '../js/views/student.js';
import { buildSession } from '../js/session-logic.js';
import { createFakeNet } from './helpers/fake-net.js';
import { fakeStorage } from './helpers/fakes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// 動画の画面を実際に mount するための小さな DOM。作られた要素も記録する。
test('生徒 DOM: 動画は案内と題だけ。状態更新・移動後も iframe・画像・リンクを作らない', async (t) => {
  const previous = Object.fromEntries(['document', 'window', 'Node'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const made = [];
  class TestNode {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.attributes = {}; this.dataset = {}; made.push(this); }
    get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(value) { if (this.tagName === '#text') this.text = String(value); else this.replaceChildren(String(value)); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...nodes) { this.childNodes.push(...nodes.map((n) => n instanceof TestNode ? n : document.createTextNode(String(n)))); }
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
    addEventListener() {}
    querySelectorAll(selector) {
      const matches = (n) => selector.split(',').some((s) => s.trim().startsWith('.') ? (n.className || '').split(' ').includes(s.trim().slice(1)) : n.tagName === s.trim());
      return this.childNodes.flatMap((n) => [...(matches(n) ? [n] : []), ...n.querySelectorAll(selector)]);
    }
  }
  Object.assign(globalThis, {
    Node: TestNode,
    document: { createElement: (tag) => new TestNode(tag), createTextNode: (text) => { const n = new TestNode('#text'); n.text = text; return n; } },
    window: { scrollTo() {} },
  });
  let cleanup;
  t.after(() => {
    if (cleanup) cleanup();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const video = { type: 'video', videoId: 'AbCdEf01_-2', start: 90, caption: '<script>動画の題</script>' };
  const deck = { title: '確認', order: ['v', 'empty', 'bad'], slides: {
    v: video, empty: { ...video, caption: '' }, bad: { ...video, videoId: '../x', caption: '題' },
  }, images: {} };
  const session = buildSession(deck, 'deck', 'teacher-test', 1);
  session.pub.current = { slideId: 'v', index: 0 };
  const net = createFakeNet();
  await net.set('sessions/video-student', session);
  const main = document.createElement('main');
  cleanup = mountStudent(main, { params: { sid: 'video-student' }, net, storage: fakeStorage(), auth: { signInAnonymous: async () => ({ uid: 'student-test' }) } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.match(main.textContent, /動画は、前の画面で見てください。/);
  assert.ok(main.textContent.includes(video.caption));
  await net.set('sessions/video-student/pub/title', '更新');
  await flush();
  assert.ok(main.textContent.includes(video.caption));
  await net.set('sessions/video-student/pub/current', { slideId: 'empty', index: 1 });
  await flush();
  assert.match(main.textContent, /動画は、前の画面で見てください。/);
  assert.ok(!main.textContent.includes(video.caption));
  await net.set('sessions/video-student/pub/current', { slideId: 'bad', index: 2 });
  await flush();
  assert.match(main.textContent, /動画は、前の画面で見てください。題/);
  assert.equal(made.filter((n) => ['iframe', 'script', 'img', 'a', 'input', 'textarea', 'button'].includes(n.tagName)).length, 0);
  assert.doesNotMatch(main.textContent, /AbCdEf01_-2|youtu/);
});

test('送信ボタン: 何も選んでいない → 押せない「選択肢を選んでください」', () => {
  assert.deepEqual(sendButtonState({ status: 'open', selected: null, answer: null }), { label: '選択肢を選んでください', off: true });
});

test('送信ボタン: 選んだがまだ送っていない →「回答を送信」', () => {
  assert.deepEqual(sendButtonState({ status: 'open', selected: 1, answer: null }), { label: '回答を送信', off: false });
});

test('送信ボタン: 送信済みと同じものを選んでいる → 押せない「送信済み」', () => {
  assert.deepEqual(sendButtonState({ status: 'open', selected: 2, answer: { choice: 2, state: 'sent' } }), { label: '送信済み', off: true });
});

test('送信ボタン: 送信済みと違うものを選んだ →「回答を更新」', () => {
  assert.deepEqual(sendButtonState({ status: 'open', selected: 0, answer: { choice: 2, state: 'sent' } }), { label: '回答を更新', off: false });
});

test('送信ボタン: 送信中は押せない', () => {
  const s = sendButtonState({ status: 'open', selected: 1, answer: { choice: 1, state: 'sending' } });
  assert.equal(s.off, true);
});

test('送信ボタン: 受付停止中・締切済みは押せず、その状態を文字で出す', () => {
  assert.deepEqual(sendButtonState({ status: 'paused', selected: 1, answer: null }), { label: '受付停止中', off: true });
  assert.deepEqual(sendButtonState({ status: 'closed', selected: 1, answer: { choice: 1, state: 'sent' } }), { label: '締切済み', off: true });
  assert.equal(sendButtonState({ status: 'waiting', selected: null, answer: null }).off, true);
  assert.equal(sendButtonState({ status: undefined, selected: 1, answer: null }).off, true);
});

test('回答の状態の文（6 つの状態）', () => {
  const m = (state, status = 'open') => answerMessage({ choice: 0, state }, status);
  assert.equal(m('sending'), '送信中…');
  assert.equal(m('sent'), '送信済み。締め切りまでは変えられます。');
  assert.equal(m('queued'), '一時保存しました。つながったら自動で送ります。');
  assert.equal(m('rejected'), '締め切られたため、送信できませんでした。');
  assert.equal(m('failed'), '送信できませんでした。');
  assert.equal(m('unconfirmed'), '授業が終わったため、送信できたか確認できませんでした。');
  assert.equal(answerMessage(null, 'open'), '');
});

test('締切のあとの送信済みは「変えられます」と言わない', () => {
  assert.equal(answerMessage({ choice: 0, state: 'sent' }, 'closed'), '送信済み。');
});

// ---- 受付の状態 × 回答の状態 × 選び方 をすべて試す ----
const STATUSES = ['waiting', 'open', 'paused', 'closed'];
const ANSWER_STATES = [null, 'sending', 'sent', 'queued', 'rejected', 'failed', 'unconfirmed'];
const SELECTS = ['none', 'same', 'other']; // 何も選んでいない／回答と同じ／回答と違う
const ans = (state) => (state ? { choice: 1, state } : null);
const sel = (how) => (how === 'none' ? null : how === 'same' ? 1 : 0);

const SENT_OPEN = '送信済み。締め切りまでは変えられます。';
const QUEUED_OPEN = '一時保存しました。つながったら自動で送ります。';
const QUEUED_CLOSED = '締め切られました。つながったら、送信できていたかを確かめます。';
// 期待する文（受付の状態 → 回答の状態 → 文）
const EXPECTED_MESSAGE = {
  waiting: { null: '', sending: '送信中…', sent: SENT_OPEN, queued: QUEUED_OPEN, rejected: '締め切られたため、送信できませんでした。', failed: '送信できませんでした。', unconfirmed: '授業が終わったため、送信できたか確認できませんでした。' },
  open: { null: '', sending: '送信中…', sent: SENT_OPEN, queued: QUEUED_OPEN, rejected: '締め切られたため、送信できませんでした。', failed: '送信できませんでした。', unconfirmed: '授業が終わったため、送信できたか確認できませんでした。' },
  paused: { null: '', sending: '送信中…', sent: SENT_OPEN, queued: QUEUED_OPEN, rejected: '締め切られたため、送信できませんでした。', failed: '送信できませんでした。', unconfirmed: '授業が終わったため、送信できたか確認できませんでした。' },
  closed: { null: '', sending: '送信中…', sent: '送信済み。', queued: QUEUED_CLOSED, rejected: '締め切られたため、送信できませんでした。', failed: '送信できませんでした。', unconfirmed: '授業が終わったため、送信できたか確認できませんでした。' },
};

test('回答の状態の文: 受付の状態 × 回答の状態のすべての組（選び方には左右されない）', () => {
  for (const status of STATUSES) {
    for (const st of ANSWER_STATES) {
      for (const how of SELECTS) {
        const d = pollDecision({ status, selected: sel(how), answer: ans(st), results: null });
        assert.equal(d.message, EXPECTED_MESSAGE[status][String(st)], `${status} × ${st} × ${how}`);
      }
    }
  }
});

test('締切後の一時保存は「自動で送ります」と言わず、送れた・送れなかったとも言わない', () => {
  const m = answerMessage({ choice: 0, state: 'queued' }, 'closed');
  assert.doesNotMatch(m, /自動で送ります|送信済み|送信できませんでした/);
});

test('「もう一度送る」は、受付中・失敗・（未選択か失敗した回答と同じものを選んでいる）ときだけ', () => {
  for (const status of STATUSES) {
    for (const st of ANSWER_STATES) {
      for (const how of SELECTS) {
        const d = pollDecision({ status, selected: sel(how), answer: ans(st), results: null });
        const want = status === 'open' && st === 'failed' && how !== 'other';
        assert.equal(d.retry, want, `${status} × ${st} × ${how}`);
      }
    }
  }
});

test('失敗のあとに別の選択肢を選んだら、再送ではなく送信のボタンで今の選択を送る', () => {
  const d = pollDecision({ status: 'open', selected: 0, answer: { choice: 1, state: 'failed' }, results: null });
  assert.equal(d.retry, false);
  assert.deepEqual(d.send, { label: '回答を送信', off: false });
});

test('送信のボタンと選択肢: すべての組で、押せる条件を守る', () => {
  for (const status of STATUSES) {
    for (const st of ANSWER_STATES) {
      for (const how of SELECTS) {
        const label = `${status} × ${st} × ${how}`;
        const d = pollDecision({ status, selected: sel(how), answer: ans(st), results: null });
        assert.equal(d.cardsOff, status !== 'open', label);
        assert.equal(d.sentChoice, st === 'sent' ? 1 : null, label);
        // 受付中でない・未選択・送信中・送信済みと同じ → 押せない
        const off = status !== 'open' || how === 'none' || st === 'sending' || (st === 'sent' && how === 'same');
        assert.equal(d.send.off, off, label);
        if (status === 'paused') assert.equal(d.send.label, '受付停止中', label);
        else if (status === 'closed') assert.equal(d.send.label, '締切済み', label);
        else if (how === 'none') assert.equal(d.send.label, '選択肢を選んでください', label);
        else if (st === 'sent') assert.equal(d.send.label, how === 'same' ? '送信済み' : '回答を更新', label);
        else assert.equal(d.send.label, '回答を送信', label);
      }
    }
  }
});

test('結果の棒は results があるときだけ出す', () => {
  for (const status of STATUSES) {
    assert.equal(pollDecision({ status, selected: null, answer: null, results: null }).showResults, false);
    assert.equal(pollDecision({ status, selected: null, answer: null, results: { counts: [1, 0], total: 1 } }).showResults, true);
  }
});

test('片づけたあとはクライアントを作り直さない（startClient の先頭で確かめる）', () => {
  const js = read('js/views/student.js');
  assert.match(js, /function startClient\(\) \{\s*if \(!alive\) return;/);
});

test('生徒の画面は innerHTML を使わず、先生の画面やログインへの道を持たない', () => {
  const js = read('js/views/student.js');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(js, /navigate\(|#\/login|#\/present|'dashboard'/);
});

test('index.html が student.css を読みこみ、student.css に外部 URL が無い', () => {
  assert.match(read('index.html'), /<link[^>]+href="css\/student\.css"/);
  assert.doesNotMatch(read('css/student.css'), /https?:\/\//i);
});

test('終了の画面: 未確認の回答が無ければ何も足さない', () => {
  assert.deepEqual(endedDecision({ unconfirmedCount: 0 }), { key: 'ended', message: '' });
  assert.deepEqual(endedDecision({}), { key: 'ended', message: '' });
  // 今のスライドの回答（answer）には頼らない
  assert.deepEqual(endedDecision({ unconfirmedCount: 0, answer: { choice: 1, state: 'sent' } }), { key: 'ended', message: '' });
});

test('終了の画面: 未確認の回答があれば件数を伝える（今の質問の回答が無くても）', () => {
  assert.deepEqual(endedDecision({ unconfirmedCount: 1, answer: null }),
    { key: 'ended:unconfirmed:1', message: '授業が終わったため、送信できたか確認できなかった回答が 1 件あります。' });
  assert.deepEqual(endedDecision({ unconfirmedCount: 3, answer: null }),
    { key: 'ended:unconfirmed:3', message: '授業が終わったため、送信できたか確認できなかった回答が 3 件あります。' });
});

// ---- 自由記述 ----
const fd = (o) => freeDecision({ status: 'open', input: '', answer: null, resultsVisible: false, ...o });

test('自由記述: まだ送っていない →「送信」。空・空白だけは押せない', () => {
  assert.deepEqual(fd({ input: 'こんにちは' }).send, { label: '送信', off: false });
  assert.deepEqual(fd({ input: '' }).send, { label: '送信', off: true });
  assert.deepEqual(fd({ input: '   \n  ' }).send, { label: '送信', off: true });
});

test('自由記述: 201 文字は押せない、200 文字は押せる。残りの文字数は length で数える', () => {
  assert.equal(fd({ input: 'あ'.repeat(200) }).send.off, false);
  assert.equal(fd({ input: 'あ'.repeat(200) }).remaining, 0);
  assert.equal(fd({ input: 'あ'.repeat(201) }).send.off, true);
  assert.equal(fd({ input: '' }).remaining, 200);
  assert.equal(fd({ input: '😀' }).remaining, 198);
});

test('自由記述: 送った文章と同じ → 押せない「送信済み」。前後の空白だけの違いも同じ', () => {
  const answer = { text: 'りんご', state: 'sent' };
  assert.deepEqual(fd({ input: 'りんご', answer }).send, { label: '送信済み', off: true });
  assert.deepEqual(fd({ input: '  りんご\n', answer }).send, { label: '送信済み', off: true });
});

test('自由記述: 送った文章と違う →「送り直す」。空にしたら押せない', () => {
  const answer = { text: 'りんご', state: 'sent' };
  assert.deepEqual(fd({ input: 'みかん', answer }).send, { label: '送り直す', off: false });
  assert.deepEqual(fd({ input: '', answer }).send, { label: '送り直す', off: true });
});

test('自由記述: 送信中でも、違う文章なら送り直せる（最後の文章を送る）。同じ文章は押せない', () => {
  const answer = { text: 'りんご', state: 'sending' };
  assert.deepEqual(fd({ input: 'みかん', answer }).send, { label: '送り直す', off: false });
  assert.equal(fd({ input: 'りんご', answer }).send.off, true);
});

test('自由記述: 一時停止中・締切後は読み取り専用で押せない。受付前も押せない', () => {
  const p = fd({ status: 'paused', input: 'あ' });
  assert.equal(p.readOnly, true);
  assert.deepEqual(p.send, { label: '受付停止中', off: true });
  const c = fd({ status: 'closed', input: 'あ', answer: { text: 'あ', state: 'sent' } });
  assert.equal(c.readOnly, true);
  assert.deepEqual(c.send, { label: '締切済み', off: true });
  assert.equal(c.message, '送信済み。');
  const w = fd({ status: 'waiting', input: 'あ' });
  assert.equal(w.readOnly, false);
  assert.equal(w.send.off, true);
  assert.equal(fd({ status: 'open', input: 'あ' }).readOnly, false);
});

test('自由記述: 送信状態の文はアンケートと同じ。締切で送れなかったときも同じ知らせ', () => {
  for (const s of ['sending', 'sent', 'queued', 'rejected', 'failed', 'unconfirmed']) {
    for (const status of STATUSES) {
      assert.equal(fd({ status, answer: { text: 'あ', state: s } }).message, answerMessage({ choice: 0, state: s }, status));
    }
  }
  assert.equal(fd({ status: 'closed', answer: { text: 'あ', state: 'rejected' } }).message, '締め切られたため、送信できませんでした。');
  assert.equal(fd({ answer: null }).message, '');
});

test('自由記述: 「もう一度送る」は受付中・失敗・入力欄が失敗した文章と同じか空のときだけ', () => {
  const answer = { text: 'りんご', state: 'failed' };
  assert.equal(fd({ input: 'りんご', answer }).retry, true);
  assert.equal(fd({ input: '', answer }).retry, true);
  assert.equal(fd({ input: 'みかん', answer }).retry, false);
  assert.deepEqual(fd({ input: 'みかん', answer }).send, { label: '送信', off: false });
  assert.equal(fd({ input: 'りんご', answer }).send.off, true); // 同じ文章は「もう一度送る」で送る
  assert.equal(fd({ status: 'paused', input: 'りんご', answer }).retry, false);
  assert.equal(fd({ input: 'りんご', answer: { text: 'りんご', state: 'sent' } }).retry, false);
});

test('自由記述: 結果の表示中だけ「前の画面を見てください」を出す', () => {
  assert.equal(fd({ resultsVisible: true }).showNote, true);
  assert.equal(fd({ resultsVisible: false }).showNote, false);
});

test('自由記述: 入力欄に出す文（書けるときは書きかけ、読み取り専用は送った文章）', () => {
  assert.equal(freeShownText({ readOnly: false, draft: '書きかけ', text: '送った' }), '書きかけ');
  assert.equal(freeShownText({ readOnly: false, draft: '', text: '送った' }), '送った');
  assert.equal(freeShownText({ readOnly: true, draft: '書きかけ', text: '送った' }), '送った');
  assert.equal(freeShownText({ readOnly: true, draft: '書きかけ', text: null }), '書きかけ');
  assert.equal(freeShownText({ readOnly: false, draft: '', text: null }), '');
});

// ---- ワードクラウド ----
const cd = (o) => cloudDecision({ status: 'open', inputs: ['', '', ''], answer: null, resultsVisible: false, ...o });

test('ワードクラウド: 言葉が 1 つ以上あれば「送信」。3 つとも空・空白だけは押せない', () => {
  assert.deepEqual(cd({ inputs: ['ねこ', '', ''] }).send, { label: '送信', off: false });
  assert.deepEqual(cd({ inputs: ['', '', 'いぬ'] }).send, { label: '送信', off: false });
  assert.deepEqual(cd({ inputs: ['', '', ''] }).send, { label: '送信', off: true });
  assert.deepEqual(cd({ inputs: ['  ', '　', ' '] }).send, { label: '送信', off: true });
  assert.equal(cd({ inputs: [] }).send.off, true);
  assert.equal(cd({ inputs: null }).send.off, true);
});

test('ワードクラウド: 21 文字の欄は数えない（ほかに正しい言葉があれば送れる）', () => {
  assert.equal(cd({ inputs: ['あ'.repeat(21), '', ''] }).send.off, true);
  assert.equal(cd({ inputs: ['あ'.repeat(20), '', ''] }).send.off, false);
  assert.equal(cd({ inputs: ['あ'.repeat(21), 'ねこ', ''] }).send.off, false);
});

test('ワードクラウド: 送った言葉と同じ → 押せない「送信済み」。空の欄・前後の空白・同じ言葉の重複だけの違いも同じ', () => {
  const answer = { words: ['ねこ', 'いぬ'], state: 'sent' };
  assert.deepEqual(cd({ inputs: ['ねこ', 'いぬ', ''], answer }).send, { label: '送信済み', off: true });
  assert.deepEqual(cd({ inputs: [' ねこ ', '', 'いぬ'], answer }).send, { label: '送信済み', off: true });
  assert.deepEqual(cd({ inputs: ['ねこ', 'ねこ', 'いぬ'], answer }).send, { label: '送信済み', off: true });
});

test('ワードクラウド: 送った言葉と違う →「送り直す」。並びが違っても送り直せる。全部消したら押せない', () => {
  const answer = { words: ['ねこ', 'いぬ'], state: 'sent' };
  assert.deepEqual(cd({ inputs: ['ねこ', 'とり', ''], answer }).send, { label: '送り直す', off: false });
  assert.deepEqual(cd({ inputs: ['いぬ', 'ねこ', ''], answer }).send, { label: '送り直す', off: false });
  assert.deepEqual(cd({ inputs: ['ねこ', '', ''], answer }).send, { label: '送り直す', off: false });
  assert.deepEqual(cd({ inputs: ['', '', ''], answer }).send, { label: '送り直す', off: true });
});

test('ワードクラウド: 送信中でも違う言葉なら送り直せる。同じ言葉は押せない', () => {
  const answer = { words: ['ねこ'], state: 'sending' };
  assert.deepEqual(cd({ inputs: ['いぬ', '', ''], answer }).send, { label: '送り直す', off: false });
  assert.equal(cd({ inputs: ['ねこ', '', ''], answer }).send.off, true);
});

test('ワードクラウド: 一時停止中・締切後は読み取り専用で押せない。受付前も押せない', () => {
  const p = cd({ status: 'paused', inputs: ['あ', '', ''] });
  assert.equal(p.readOnly, true);
  assert.deepEqual(p.send, { label: '受付停止中', off: true });
  const c = cd({ status: 'closed', inputs: ['あ', '', ''], answer: { words: ['あ'], state: 'sent' } });
  assert.equal(c.readOnly, true);
  assert.deepEqual(c.send, { label: '締切済み', off: true });
  assert.equal(c.message, '送信済み。');
  const w = cd({ status: 'waiting', inputs: ['あ', '', ''] });
  assert.equal(w.readOnly, false);
  assert.equal(w.send.off, true);
});

test('ワードクラウド: 送信状態の文・ボタンは自由記述と同じ（同じ値・違う値のすべての組）', () => {
  for (const s of ['sending', 'sent', 'queued', 'rejected', 'failed', 'unconfirmed']) {
    for (const status of STATUSES) {
      for (const same of [true, false]) {
        const c = cd({ status, inputs: [same ? 'あ' : 'い', '', ''], answer: { words: ['あ'], state: s } });
        const f = fd({ status, input: same ? 'あ' : 'い', answer: { text: 'あ', state: s } });
        assert.deepEqual(c.send, f.send, `${s} ${status} ${same}`);
        assert.equal(c.message, f.message);
        assert.equal(c.retry, f.retry);
        assert.equal(c.readOnly, f.readOnly);
      }
    }
  }
  assert.equal(cd({ answer: null }).message, '');
});

test('ワードクラウド: 「もう一度送る」は受付中・失敗・入力が失敗した言葉と同じか空のときだけ', () => {
  const answer = { words: ['ねこ'], state: 'failed' };
  assert.equal(cd({ inputs: ['ねこ', '', ''], answer }).retry, true);
  assert.equal(cd({ inputs: ['', '', ''], answer }).retry, true);
  assert.equal(cd({ inputs: ['いぬ', '', ''], answer }).retry, false);
  assert.equal(cd({ status: 'paused', inputs: ['ねこ', '', ''], answer }).retry, false);
});

test('ワードクラウド: 結果の表示中だけ「前の画面を見てください」を出す', () => {
  assert.equal(cd({ resultsVisible: true }).showNote, true);
  assert.equal(cd({ resultsVisible: false }).showNote, false);
});

test('ワードクラウド: 入力欄に出す文（いつも 3 つ。書けるときは書きかけ、読み取り専用は送った言葉）', () => {
  assert.deepEqual(cloudShownWords({ readOnly: false, draft: ['書き', '', ''], words: ['送った'] }), ['書き', '', '']);
  assert.deepEqual(cloudShownWords({ readOnly: false, draft: ['', '', ''], words: ['送った', 'もの'] }), ['送った', 'もの', '']);
  assert.deepEqual(cloudShownWords({ readOnly: true, draft: ['書き', '', ''], words: ['送った'] }), ['送った', '', '']);
  assert.deepEqual(cloudShownWords({ readOnly: true, draft: ['書き', '', ''], words: null }), ['書き', '', '']);
  assert.deepEqual(cloudShownWords({ readOnly: false, draft: null, words: null }), ['', '', '']);
  assert.deepEqual(cloudShownWords({ readOnly: false, draft: ['a', 'b', 'c', 'd'], words: null }), ['a', 'b', 'c']);
});

// ---- クイズ: 正解が表示されたあとの文と印 ----
const QUIZ_OPTIONS = ['東京', '大阪', '名古屋'];

test('クイズ: 正解が届く前（correct が null）は何も出さない', () => {
  assert.equal(quizVerdict({ correct: null, isCorrect: null, options: QUIZ_OPTIONS }), null);
  assert.equal(quizVerdict({ correct: undefined, isCorrect: true, options: QUIZ_OPTIONS }), null);
});

test('クイズ: 送信済みの答えが正解 →「正解です」と ○', () => {
  assert.deepEqual(quizVerdict({ correct: 1, isCorrect: true, options: QUIZ_OPTIONS }), { kind: 'ok', mark: '○', text: '正解です' });
});

test('クイズ: 送信済みの答えがまちがい →「ざんねん。正解は『〇〇』です」と ×', () => {
  assert.deepEqual(quizVerdict({ correct: 1, isCorrect: false, options: QUIZ_OPTIONS }), { kind: 'ng', mark: '×', text: 'ざんねん。正解は『大阪』です' });
});

test('クイズ: 答えていない・送れたか確かめられていない →「正解は『〇〇』です」（○× を付けない）', () => {
  assert.deepEqual(quizVerdict({ correct: 0, isCorrect: null, options: QUIZ_OPTIONS }), { kind: 'info', mark: null, text: '正解は『東京』です' });
});

test('クイズ: 正解の選択肢の文が空なら記号（A〜F）で伝える', () => {
  assert.equal(quizVerdict({ correct: 2, isCorrect: false, options: ['a', 'b', '  '] }).text, 'ざんねん。正解は『C』です');
  assert.equal(quizVerdict({ correct: 1, isCorrect: null, options: [] }).text, '正解は『B』です');
});

test('クイズ: 正解の表示のあと（締切）は、選び直し・送信ができない', () => {
  const d = pollDecision({ status: 'closed', selected: 1, answer: { choice: 1, state: 'sent' }, results: { counts: [0, 1, 0], total: 1 } });
  assert.equal(d.cardsOff, true);
  assert.deepEqual(d.send, { label: '締切済み', off: true });
  assert.equal(d.showResults, true);
});
