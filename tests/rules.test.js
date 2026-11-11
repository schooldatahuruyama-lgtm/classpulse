import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const rules = () => JSON.parse(read('docs/firebase/rules.json')).rules;

test('規則が JSON として読める', () => {
  assert.doesNotThrow(() => JSON.parse(read('docs/firebase/rules.json')));
});

test('最上位で読み書きを許していない', () => {
  const r = rules();
  assert.equal(r['.read'], undefined);
  assert.equal(r['.write'], undefined);
});

test('回答は本人だけが読める（inbox・answers・質問の単位では読めない）', () => {
  const inbox = rules().sessions.$sid.inbox;
  assert.equal(inbox['.read'], undefined);
  assert.equal(inbox.answers['.read'], undefined);
  assert.equal(inbox.answers.$slideId['.read'], undefined);
  assert.equal(inbox.answers.$slideId.$uid['.read'], 'auth != null && auth.uid === $uid');
});

test('回答の書きこみは受付中だけ', () => {
  const w = rules().sessions.$sid.inbox.answers.$slideId.$uid['.write'];
  assert.ok(w.includes("'open'"));
  assert.ok(w.includes("'live'"));
  assert.ok(w.includes('auth.uid === $uid'));
});

test('設定のファイルに秘密のキーがない', () => {
  const t = read('js/firebase-config.js').toLowerCase();
  for (const w of ['password', 'secret', 'private_key']) assert.ok(!t.includes(w), w);
});

test('授業の読み取りは登録済みの先生で持ち主だけ', () => {
  const r = rules().sessions.$sid['.read'];
  assert.ok(r.includes('teacherList'));
  assert.ok(r.includes("data.child('owner').val() === auth.uid"));
});

test('回答の検証は整数で、質問に実在する選択肢だけ', () => {
  const v = rules().sessions.$sid.inbox.answers.$slideId.$uid['.validate'];
  assert.ok(v.includes('% 1 === 0'));
  assert.ok(v.includes('options'));
});

test('先生のデータは本人だけが読み書きできる', () => {
  const t = rules().teachers.$uid;
  assert.ok(t['.read'].includes('auth.uid === $uid'));
  assert.ok(t['.write'].includes('auth.uid === $uid'));
});
