// 開発用。外部に接続せず、テストと同じ流れを人数を変えて測る
import { runLoadSimulation } from '../tests/helpers/load-scenario.mjs';

try {
  const count = process.argv[2] === undefined ? 30 : Number(process.argv[2]);
  const result = await runLoadSimulation(count);
  console.log(`人数: ${result.count}`);
  console.log(`参加から終了までの処理時間: ${result.processingMs.toFixed(1)} ms`);
  console.log(`host onChange: ${result.hostChanges} 回`);
  console.log(`pub への書きこみ: ${result.pubWrites} 回`);
  console.log(`生徒 1 人の pub 受信: ${result.studentPubEvents} 回 / ${result.studentPubCharacters} 文字`);
  console.log(`教材の写し: ${result.deckCharacters} 文字`);
  console.log(`各質問の回答数: ${result.questions.map((q) => `${q.type}=${q.total}`).join(', ')}`);
  console.log(`pub/results の書きこみ: ${result.questions.map((q) => `${q.type}=${q.resultsWrites}`).join(', ')}`);
  console.log(`復帰: 未送信 ${result.recovery.recovered}/${result.recovery.queued} 人、スライド追従 ${result.recovery.caughtUp}/${result.recovery.behind} 人`);
  console.log(`履歴: ${result.history.participants} 人 / ${result.history.questions.reduce((sum, q) => sum + q.total, 0)} 回答`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
