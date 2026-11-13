import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, historyToCsv, exportFileName } from '../js/results-csv.js';

test('CSV: かくした回答のあとに確認待ちを分け、文章を式にしない', () => {
  const csv = historyToCsv({ questions: [
    { type: 'free', texts: ['雲'], hiddenTexts: ['かくす'], heldTexts: ['=死ね', 'バカ,"文"\n次'], total: 4 },
    { type: 'cloud', words: [], hiddenWords: [{ word: 'かくす', count: 1 }], heldWords: [{ word: '+バカ', count: 2 }], total: 3 },
  ] });
  assert.ok(csv.includes('授業中にかくした回答\r\nかくす\r\n自動チェックで止めた回答\r\n\'=死ね\r\n"バカ,""文""\n次"\r\n回答,4'));
  assert.ok(csv.includes('授業中にかくした言葉\r\nかくす,1\r\n自動チェックで止めた言葉\r\n\'+バカ,2\r\n回答,3'));
});

test('CSV: 確認待ちが空なら、追加前と同じ文字列', () => {
  const questions = [{ type: 'free', texts: ['雲'], total: 1 }, { type: 'cloud', words: [{ word: '雲', count: 1 }], total: 1 }];
  assert.equal(historyToCsv({ questions }), historyToCsv({ questions: questions.map((q) => ({ ...q, heldTexts: [], heldWords: [] })) }));
});

const endedAt = new Date(2026, 10, 13, 10, 7).getTime();

test('CSV: 5 種類の質問・かくした回答を含む履歴を、全体の文字列で確かめる', () => {
  const history = {
    title: '空の学習', startedAt: new Date(2026, 10, 13, 9, 5).getTime(), endedAt, participants: 3,
    questions: [
      { type: 'poll', question: '空の色は？', options: ['あお', 'しろ'], counts: [2, 1], total: 3 },
      { type: 'free', question: '気づいたこと', texts: ['雲,風', '「空」は"広い"\n青い'], hiddenTexts: ['=1+1'], total: 3 },
      { type: 'cloud', question: '言葉', words: [{ word: '雲', count: 2 }, { word: '+1', count: 1 }], hiddenWords: [{ word: '@SUM(A1)', count: 1 }], total: 3 },
      { type: 'quiz', question: '正しいもの', options: ['-1', '=x'], counts: [1, 2], total: 3, correct: 0 },
      { type: 'rating', question: 'わかった？', counts: [1, 0, 0, 0, 2], total: 3, average: 3.7, lowLabel: 'むずかしい', highLabel: 'かんたん' },
    ],
  };
  const expected = [
    'ClassPulse 授業の結果', '授業の名前,空の学習', '開始,2026-11-13 09:05', '終了,2026-11-13 10:07', '参加人数,3', '',
    '質問 1,アンケート,空の色は？', '選択肢,人数,割合(%)', 'あお,2,66.7', 'しろ,1,33.3', '回答,3', '',
    '質問 2,自由記述,気づいたこと', '回答', '"雲,風"', '"「空」は""広い""\n青い"', '授業中にかくした回答', "'=1+1", '回答,3', '',
    '質問 3,ワードクラウド,言葉', '言葉,人数', '雲,2', "'+1,1", '授業中にかくした言葉', "'@SUM(A1),1", '回答,3', '',
    '質問 4,クイズ,正しいもの', '選択肢,人数,割合(%),正解', "'-1,1,33.3,○", "'=x,2,66.7,", '正答率(%),33.3', '回答,3', '',
    '質問 5,5 段階評価,わかった？', '評価,人数,割合(%)', '1（むずかしい）,1,33.3', '2,0,0.0', '3,0,0.0', '4,0,0.0', '5（かんたん）,2,66.7', '平均,3.67', '回答,3', '',
  ].join('\r\n') + '\r\n';
  assert.equal(historyToCsv(history), expected);
  assert.equal(historyToCsv(history, { bom: true }), '\uFEFF' + expected);
});

for (const text of ['=1+1', '+1', '-1', '@SUM(A1)', '  =x', '\t文章', '  \t文章', '\r文章', '\u3000@x', '\n=x']) {
  test(`CSV: 式や制御文字で始まる文章を文字として書く (${JSON.stringify(text)})`, () => {
    const escaped = "'" + text;
    assert.equal(csvCell(text), /[\r\n]/.test(text) ? '"' + escaped + '"' : escaped);
  });
}

test('CSV: 引用符・カンマ・改行を囲み、日本語や途中の記号はそのまま', () => {
  assert.equal(csvCell('a,"b"\r\nc'), '"a,""b""\r\nc"');
  assert.equal(csvCell('空は + 青い'), '空は + 青い');
  assert.equal(csvCell('ふつうの文章'), 'ふつうの文章');
  assert.equal(csvCell(-1), "'-1");
  for (const value of [null, undefined, {}, [], NaN, Infinity]) assert.equal(csvCell(value), '');
});

test('CSV: 0 人、正解の記録なし、type のない古い質問を出せる', () => {
  const csv = historyToCsv({ endedAt, participants: 0, questions: [
    { options: ['あお'], counts: [0], total: 0 },
    { type: 'quiz', options: ['はい'], counts: [0], correct: null, total: 0 },
    { type: 'quiz', options: ['はい'], counts: [0], correct: 0, total: 0 },
    { type: 'rating', counts: [], total: 0 },
    { type: 'free', texts: [], hiddenTexts: [], total: 0 },
    { type: 'cloud', words: [], hiddenWords: [], total: 0 },
  ] });
  assert.ok(csv.includes('質問 1,アンケート,\r\n選択肢,人数,割合(%)\r\nあお,0,0.0'));
  assert.ok(csv.includes('正解,記録なし\r\n'));
  assert.ok(csv.includes('はい,0,0.0,○\r\n正答率(%),0.0'));
  assert.ok(csv.includes('平均,\r\n回答,0'));
  assert.ok(csv.includes('1,0,0.0\r\n2,0,0.0\r\n3,0,0.0\r\n4,0,0.0\r\n5,0,0.0'));
  assert.ok(!csv.includes('開始,'));
  assert.ok(!csv.includes('授業中にかくした'));
});

test('CSV: 壊れた値は空・0 にし、履歴を書き換えない', () => {
  const h = { title: {}, endedAt: 'bad', participants: NaN, questions: [null,
    { type: 'poll', options: ['=x', null], counts: [Infinity, '2'], total: -1 },
    { type: 'free', texts: {}, hiddenTexts: 'bad' },
    { type: 'cloud', words: [null, { word: {}, count: -3 }] },
    { type: 'rating', counts: 'bad', total: 'bad' },
    { type: { toString: null } },
  ] };
  const before = structuredClone(h);
  const csv = historyToCsv(h);
  assert.ok(csv.includes('終了,\r\n参加人数,0\r\n'));
  assert.ok(csv.includes("'=x,0,0.0\r\n,0,0.0"));
  assert.doesNotMatch(csv, /NaN|Infinity|undefined|null|\[object/);
  assert.deepEqual(h, before);
  for (const history of [null, undefined, {}, { questions: {} }, { endedAt: Infinity }]) assert.doesNotThrow(() => historyToCsv(history));
});

test('CSV: 授業名・質問文・選択肢・かくした文と言葉にも式防止を使う', () => {
  const csv = historyToCsv({ title: '  =x', questions: [
    { question: '+q', options: ['-1'], counts: [1], total: 1 },
    { type: 'free', hiddenTexts: ['\t文章'], total: 1 },
    { type: 'cloud', hiddenWords: [{ word: '=word', count: 1 }], total: 1 },
  ] });
  for (const fragment of ["授業の名前,'  =x", "アンケート,'+q", "'-1,1,100.0", "'\t文章", "'=word,1"]) assert.ok(csv.includes(fragment));
  assert.ok(!csv.includes(",'1"));
});

test('ファイル名: 終了のローカル日付・60 文字・使えない文字の置換・拡張子なし', () => {
  assert.equal(exportFileName({ title: '空/雲:雨?*"<>|\\\n\u0000\u007f', endedAt }), 'ClassPulse_空_雲_雨___________2026-11-13');
  assert.equal(exportFileName({ title: '😀'.repeat(61), endedAt }), `ClassPulse_${'😀'.repeat(60)}_2026-11-13`);
  assert.equal(exportFileName({ endedAt }), 'ClassPulse_無題の教材_2026-11-13');
  assert.equal(exportFileName({ title: '授業', endedAt: 'bad' }), 'ClassPulse_授業_');
});
