// 生徒の画面: 送信ボタンの文と押せるか、回答の状態の文、ファイルの約束ごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendButtonState, answerMessage } from '../js/views/student.js';

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

test('生徒の画面は innerHTML を使わず、先生の画面やログインへの道を持たない', () => {
  const js = read('js/views/student.js');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(js, /navigate\(|#\/login|#\/present|'dashboard'/);
});

test('index.html が student.css を読みこみ、student.css に外部 URL が無い', () => {
  assert.match(read('index.html'), /<link[^>]+href="css\/student\.css"/);
  assert.doesNotMatch(read('css/student.css'), /https?:\/\//i);
});
