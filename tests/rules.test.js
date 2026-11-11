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

test('回答はほかの生徒が読めない', () => {
  const inbox = rules().sessions.$sid.inbox;
  assert.equal(inbox['.read'], undefined);
  assert.equal(inbox.answers.$slideId.$uid['.read'], undefined);
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
