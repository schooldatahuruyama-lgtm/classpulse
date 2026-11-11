// 生徒の画面: 送信ボタンの文と押せるか、回答の状態の文、ファイルの約束ごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendButtonState, answerMessage, pollDecision, endedDecision } from '../js/views/student.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

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
