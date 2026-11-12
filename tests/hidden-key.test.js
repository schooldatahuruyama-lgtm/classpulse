import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenKey } from '../js/session-logic.js';

// かくした言葉の鍵は、REST の URL にそのまま入る。% を含むと URL として元に戻され、
// データベースに使えない文字になったり、読み戻したときの鍵と合わなくなったりする
test('hiddenKey: 英数字だけでできていて、URL にしても変わらない', () => {
  for (const w of ['ねこ', 'a.b/c', '$#[]', 'A B', '100%', '😀', 'ﾈｺ']) {
    const k = hiddenKey(w);
    assert.match(k, /^w[0-9a-f]+$/, w);
    assert.equal(encodeURIComponent(k), k, w);
    assert.equal(decodeURIComponent(k), k, w);
  }
});

test('hiddenKey: 同じ言葉（全角・半角、大文字・小文字のちがい）は同じ鍵、ちがう言葉はちがう鍵', () => {
  assert.equal(hiddenKey('ﾈｺ'), hiddenKey('ネコ'));
  assert.equal(hiddenKey('ＡＢＣ'), hiddenKey('abc'));
  assert.notEqual(hiddenKey('ねこ'), hiddenKey('ネコ'));
  assert.notEqual(hiddenKey('a.b'), hiddenKey('a/b'));
});
