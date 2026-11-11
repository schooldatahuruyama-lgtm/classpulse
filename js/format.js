// 表示用の整形（純粋な関数）

// ミリ秒 → 「2026年11月11日 10:45」（端末のローカル時刻、分はゼロ埋め）
export function formatDateTime(ms) {
  const d = new Date(ms);
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${mm}`;
}
