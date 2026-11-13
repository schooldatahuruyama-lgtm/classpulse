// 授業の結果を CSV にする。文字のセルと集計の数値は、別々に書き出す。
import { correctRate } from './session-logic.js';

const textOf = (value) => typeof value === 'string' ? value : '';
const listOf = (value) => Array.isArray(value) ? value : [];
const countOf = (value) => Number.isFinite(value) && value > 0 ? value : 0;
const TYPES = { poll: 'アンケート', free: '自由記述', cloud: 'ワードクラウド', quiz: 'クイズ', rating: '5 段階評価' };

export function csvCell(value) {
  let text = typeof value === 'number' && Number.isFinite(value) ? String(value) : textOf(value);
  // タブ・CR 自体も危険な先頭文字なので、trimStart で消してから判定しない。
  if (/^\s*[=+@\-\t\r]/u.test(text)) text = "'" + text;
  return /[,"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function dateParts(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const dateTime = (ms) => {
  const parts = dateParts(ms);
  return parts ? `${parts.date} ${parts.time}` : '';
};

export function exportFileName(history) {
  const title = textOf(history?.title) || '無題の教材';
  const safe = Array.from(title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '_')).slice(0, 60).join('');
  return `ClassPulse_${safe}_${dateParts(history?.endedAt)?.date || ''}`;
}

export function historyToCsv(history, { bom = false } = {}) {
  const h = history || {};
  const rows = [];
  const row = (...cells) => rows.push(cells.join(','));
  const percentage = (count, total) => (total ? count / total * 100 : 0).toFixed(1);
  row('ClassPulse 授業の結果');
  row('授業の名前', csvCell(textOf(h.title) || '無題の教材'));
  if (h.startedAt && dateParts(h.startedAt)) row('開始', dateTime(h.startedAt));
  row('終了', dateTime(h.endedAt));
  row('参加人数', countOf(h.participants));
  row();
  listOf(h.questions).forEach((item, i) => {
    const q = item || {};
    const type = typeof q.type === 'string' && Object.hasOwn(TYPES, q.type) ? q.type : 'poll';
    const total = countOf(q.total);
    row(`質問 ${i + 1}`, TYPES[type], csvCell(q.question));
    if (type === 'free') {
      row('回答');
      listOf(q.texts).forEach((text) => row(csvCell(text)));
      if (listOf(q.hiddenTexts).length) {
        row('授業中にかくした回答');
        q.hiddenTexts.forEach((text) => row(csvCell(text)));
      }
      if (listOf(q.heldTexts).length) {
        row('自動チェックで止めた回答');
        q.heldTexts.forEach((text) => row(csvCell(text)));
      }
    } else if (type === 'cloud') {
      const words = (items) => listOf(items).forEach((w) => row(csvCell(w?.word), countOf(w?.count)));
      row('言葉', '人数');
      words(q.words);
      if (listOf(q.hiddenWords).length) { row('授業中にかくした言葉'); words(q.hiddenWords); }
      if (listOf(q.heldWords).length) { row('自動チェックで止めた言葉'); words(q.heldWords); }
    } else {
      const options = type === 'rating' ? [1, 2, 3, 4, 5] : listOf(q.options);
      const counts = options.map((_, index) => countOf(listOf(q.counts)[index]));
      const correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < options.length ? q.correct : null;
      row(type === 'rating' ? '評価' : '選択肢', '人数', '割合(%)', ...(type === 'quiz' ? ['正解'] : []));
      options.forEach((option, index) => {
        let label = type === 'rating' ? String(option) : textOf(option);
        const end = type === 'rating' ? textOf(index === 0 ? q.lowLabel : index === 4 ? q.highLabel : '') : '';
        if (end) label += `（${end}）`;
        row(csvCell(label), counts[index], percentage(counts[index], total), ...(type === 'quiz' ? [index === correct ? '○' : ''] : []));
      });
      if (type === 'quiz') {
        if (correct === null) row('正解', '記録なし');
        else {
          const rate = correctRate(counts, correct);
          row('正答率(%)', percentage(rate.correctCount, rate.total));
        }
      }
      if (type === 'rating') {
        // 既存の average は小数 1 けたに丸めるため、CSV の 2 けたは人数から計算する。
        const n = counts.reduce((sum, count) => sum + count, 0);
        const sum = counts.reduce((value, count, index) => value + count * (index + 1), 0);
        row('平均', total && n ? (sum / n).toFixed(2) : '');
      }
    }
    row('回答', total);
    row();
  });
  return (bom ? '\uFEFF' : '') + rows.join('\r\n') + '\r\n';
}
