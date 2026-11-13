import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoadSimulation } from './helpers/load-scenario.mjs';

test('30 人: 5 種類に同時回答・書き直し・5 人の通信断から復帰・終了と履歴', async () => {
  const result = await runLoadSimulation();
  assert.equal(result.participants, 30);
  assert.deepEqual(result.questions.map((q) => q.type), ['poll', 'quiz', 'rating', 'free', 'cloud']);
  for (const question of result.questions) {
    assert.equal(question.total, 30, question.type);
    assert.equal(question.stored, 30, question.type);
    assert.ok(question.resultsWrites <= 3, question.type); // 30 回以上の回答を少数の公開にまとめる
    if (['poll', 'quiz', 'rating'].includes(question.type)) {
      assert.ok(question.resultsWrites > 0, question.type);
      assert.equal(question.publishedTotal, 30, question.type);
    } else {
      assert.equal(question.resultsWrites, 0); // 文章と言葉は生徒の pub に公開しない
    }
  }
  assert.deepEqual(result.recovery, { interrupted: 5, queued: 5, recovered: 5, behind: 5, caughtUp: 5 });
  assert.equal(result.history.participants, 30);
  assert.equal(result.history.questions.length, 5);
  assert.equal(result.history.questions.reduce((sum, q) => sum + q.total, 0), 150);
  for (const question of result.history.questions) assert.equal(question.total, 30);
  const [poll, quiz, rating, free, cloud] = result.history.questions;
  assert.deepEqual(poll.counts, [14, 16]); // 最初の 5 人の書き直しが反映される
  assert.deepEqual(quiz.counts, [14, 16]);
  assert.equal(quiz.correctCount, 16);
  assert.deepEqual(rating.counts, [6, 6, 6, 6, 6]);
  assert.equal(free.texts.length, 30);
  assert.equal(free.texts.filter((text) => text.endsWith('改訂')).length, 5);
  assert.deepEqual(Object.fromEntries(cloud.words.map((w) => [w.word, w.count])), { 空: 30, 雲: 25, 雨: 5 });
  assert.deepEqual(result.hostFinal, { phase: 'ended', slideId: 'cloud' });
  for (const state of result.finalStates) assert.deepEqual(state, { phase: 'ended', slideId: 'cloud', pollStatus: 'closed' });
  assert.ok(result.studentPubEvents < 30);
  assert.ok(result.studentPubCharacters > 0);
  assert.ok(result.deckCharacters > 0);
});
