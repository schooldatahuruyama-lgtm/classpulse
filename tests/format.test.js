import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime } from '../js/format.js';

// ローカル時刻の部品で作るので、端末のタイムゾーンに左右されない
test('日付と時刻を「2026年11月11日 10:45」の形にする', () => {
  assert.equal(formatDateTime(new Date(2026, 10, 11, 10, 45).getTime()), '2026年11月11日 10:45');
});

test('分は 2 桁にそろえ、月と日と時はゼロを付けない', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 5, 9, 5).getTime()), '2026年1月5日 9:05');
  assert.equal(formatDateTime(new Date(2026, 11, 31, 0, 0).getTime()), '2026年12月31日 0:00');
});
