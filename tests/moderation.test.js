import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_WORDS, normalizeForCheck, normalizeWordList, normalizeModeration, createChecker } from '../js/moderation.js';

test('照合: NFKC・小文字・空白と記号。かなと長音はそのまま', () => {
  assert.equal(normalizeForCheck(' ＦＵＣＫ・! 💡\n'), 'fuck');
  assert.equal(normalizeForCheck('し ね よ'), 'しねよ');
  assert.equal(normalizeForCheck('バ・カ／うぜー'), 'バカうぜー');
  assert.notEqual(normalizeForCheck('ばか'), normalizeForCheck('バカ'));
});

for (const word of ['やくそく', 'ばかり', 'イエロー', 'パチンコ', '暗殺した', 'カステラ']) {
  test(`照合: ふつうの言葉「${word}」は当たらない`, () => assert.equal(createChecker()(word), false));
}
for (const word of ['死ね', 'し ね よ', 'ＦＵＣＫ', 'バ・カ', 'うぜー', ...BUILTIN_WORDS]) {
  test(`照合: 「${word}」は当たる`, () => assert.equal(createChecker()(word), true));
}

test('照合: 先生の言葉を足し、無効のとき・文字列でないときは当たらない', () => {
  const check = createChecker({ enabled: true, words: ['止める'] });
  assert.equal(check('これは止・める'), true);
  assert.equal(check('死ね'), true);
  const off = createChecker({ enabled: false, words: ['止める'] });
  assert.equal(off('死ね 止める'), false);
  for (const value of [null, undefined, 1, {}, ['死ね']]) assert.equal(check(value), false);
});

test('追加語: 空白を取り、長すぎる・短すぎる・非文字列を捨て、同じ形をまとめる', () => {
  assert.deepEqual(normalizeWordList([' ＡＢ ', 'ab', 'a・b', 'a!', '！', 'あ'.repeat(20), 'あ'.repeat(21), 1, null, 'うぜー']), ['ＡＢ', 'あ'.repeat(20), 'うぜー']);
  for (const value of [undefined, null, {}, 'ab']) assert.deepEqual(normalizeWordList(value), []);
});

test('追加語: 正しい言葉だけを先から 100 語まで残す', () => {
  const words = Array.from({ length: 105 }, (_, i) => `言葉${i}`);
  assert.deepEqual(normalizeWordList(['a', ...words]), words.slice(0, 100));
});

test('設定: 無い・こわれている値は既定値。空配列が省かれた設定も読む', () => {
  for (const value of [null, undefined, [], true, {}, { enabled: 'false', words: [] }, { enabled: false, words: 'ab' }]) {
    assert.deepEqual(normalizeModeration(value), { enabled: true, words: [] });
    assert.equal(createChecker(value)('死ね'), true);
  }
  assert.deepEqual(normalizeModeration({ enabled: false }), { enabled: false, words: [] });
  assert.deepEqual(normalizeModeration({ enabled: true, words: [' ＡＢ ', 'ab', null] }), { enabled: true, words: ['ＡＢ'] });
});
