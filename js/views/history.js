// 授業履歴（#/history）と、1 回の授業の結果（#/history/<sid>）。
// 回答は匿名なので、ここには集計した人数だけを出す（個人ごとの一覧や ID は出さない）。
// 自由記述は件数と文章の一覧（だれが書いたかは出さない。履歴に uid は無い）。type の無い古い項目はアンケート。
// ワードクラウドは回答した人数と、言葉と人数の一覧（人数の多い順。履歴にある順のまま）。
// クイズは選択肢ごとの人数と割合・正解の印・正答率、5 段階評価は 1〜5 の人数と割合・平均・両はしの言葉。
import {
  el, confirmDialog, closeAllDialogs, resultBars, toast,
  ratingAverageText, correctRateText, ratingBarLabels,
} from '../ui.js';
import { formatDateTime } from '../format.js';
import { routeHash } from '../router.js';
import { correctRate } from '../session-logic.js';
import { ratingOptions } from '../model.js';

const UNTITLED = '無題の教材';
const MSG_LOAD_FAILED = '読みこめませんでした。';

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const sid = ctx.params && ctx.params.sid;

  const page = el('div', { class: 'hist' });
  root.replaceChildren(page);

  function loading() {
    page.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' }));
  }

  function failure(retry) {
    page.replaceChildren(el('div', { class: 'notice', role: 'alert' },
      el('p', { text: MSG_LOAD_FAILED }),
      el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度', onclick: () => { if (!alive) return; loading(); retry(); } })));
  }

  const backLink = () => el('a', { class: 'btn hist-back', href: routeHash('history'), text: '← 授業履歴へ' });

  // ---- 一覧 ----
  function renderList(items) {
    page.replaceChildren(
      el('h1', { class: 'hist-h1', text: '授業履歴' }),
      items.length
        ? el('ul', { class: 'hist-list' }, items.map((h) => el('li', {},
          el('a', { class: 'hist-item card', href: routeHash('result', { sid: h.sid }) },
            el('span', { class: 'hist-item-title', text: h.title || UNTITLED }),
            el('span', { class: 'small muted', text: `${formatDateTime(h.endedAt)} ・ 参加 ${h.participants} 人` })))))
        : el('p', { class: 'card muted', text: 'まだ授業の記録がありません。' }));
  }

  async function loadList() {
    try {
      const items = await ctx.repo.listHistory();
      if (alive) renderList(items);
    } catch {
      if (alive) failure(loadList);
    }
  }

  // ---- 結果 ----
  // 自由記述の文章の一覧（文は textContent で入れる）
  const textList = (texts) => el('ul', { class: 'hist-free-list' },
    texts.map((t) => el('li', { class: 'hist-free-item', text: t })));

  function freeCard(q, i) {
    const texts = Array.isArray(q.texts) ? q.texts : [];
    const hiddenTexts = Array.isArray(q.hiddenTexts) ? q.hiddenTexts : [];
    const body = el('div', { class: 'hist-q-body' },
      texts.length ? textList(texts) : el('p', { class: 'muted', text: hiddenTexts.length ? '表示した回答はありません。' : '回答はありませんでした。' }));
    // 授業中にかくした回答は、あるときだけ分けて出す
    if (hiddenTexts.length) {
      body.append(el('section', { class: 'hist-free-hidden' },
        el('h4', { class: 'hist-free-hidden-title', text: '授業中にかくした回答' }),
        textList(hiddenTexts)));
    }
    return el('li', { class: 'hist-q card' },
      el('h3', { class: 'hist-q-no', text: `質問 ${i + 1}（自由記述）` }),
      el('p', { class: 'hist-q-text', text: q.question || '' }),
      body,
      el('p', { class: 'small muted', text: `回答 ${q.total} 件` }));
  }

  // ワードクラウドの言葉と人数の一覧（言葉は textContent で入れる）
  const wordList = (words) => el('ul', { class: 'hist-cloud-list' },
    words.map((w) => el('li', { class: 'hist-cloud-item' },
      el('span', { class: 'hist-cloud-word', text: w.word }),
      el('span', { class: 'hist-cloud-count', text: `${w.count} 人` }))));

  function cloudCard(q, i) {
    const words = Array.isArray(q.words) ? q.words : [];
    const hiddenWords = Array.isArray(q.hiddenWords) ? q.hiddenWords : [];
    const body = el('div', { class: 'hist-q-body' },
      words.length ? wordList(words) : el('p', { class: 'muted', text: hiddenWords.length ? '表示した言葉はありません。' : '回答はありませんでした。' }));
    // 授業中にかくした言葉は、あるときだけ分けて出す
    if (hiddenWords.length) {
      body.append(el('section', { class: 'hist-free-hidden' },
        el('h4', { class: 'hist-free-hidden-title', text: '授業中にかくした言葉' }),
        wordList(hiddenWords)));
    }
    return el('li', { class: 'hist-q card' },
      el('h3', { class: 'hist-q-no', text: `質問 ${i + 1}（ワードクラウド）` }),
      el('p', { class: 'hist-q-text', text: q.question || '' }),
      body,
      el('p', { class: 'small muted', text: `回答 ${q.total} 人` }));
  }

  // クイズ: 選択肢ごとの人数と割合、正解の印、正答率（正解が記録されていなければ、その旨）
  function quizCard(q, i) {
    const options = Array.isArray(q.options) ? q.options : [];
    const correct = Number.isInteger(q.correct) ? q.correct : null;
    const body = el('div', { class: 'hist-q-body' });
    if (q.total > 0) resultBars(body, { options, counts: q.counts, total: q.total, correct });
    else {
      body.append(el('p', { class: 'muted', text: '回答はありませんでした。' }));
      // 回答が 0 人でも、正解は読めるようにする
      if (correct !== null && typeof options[correct] === 'string') {
        body.append(el('p', { text: `正解は「${options[correct]}」です` }));
      }
    }
    return el('li', { class: 'hist-q card' },
      el('h3', { class: 'hist-q-no', text: `質問 ${i + 1}（クイズ）` }),
      el('p', { class: 'hist-q-text', text: q.question || '' }),
      body,
      el('p', { class: 'hist-summary', text: correct !== null ? correctRateText(correctRate(q.counts, correct)) : '正解の記録がありません' }),
      el('p', { class: 'small muted', text: `回答 ${q.total} 人` }));
  }

  // 5 段階評価: 両はしの言葉、1〜5 の人数と割合、平均
  function ratingCard(q, i) {
    const marks = ratingOptions();
    const low = typeof q.lowLabel === 'string' ? q.lowLabel : '';
    const high = typeof q.highLabel === 'string' ? q.highLabel : '';
    const ends = [low ? `1：${low}` : '', high ? `5：${high}` : ''].filter(Boolean).join(' ／ ');
    const body = el('div', { class: 'hist-q-body' });
    if (q.total > 0) resultBars(body, { options: ratingBarLabels(low, high, marks.length), marks, counts: q.counts, total: q.total });
    else body.append(el('p', { class: 'muted', text: '回答はありませんでした。' }));
    return el('li', { class: 'hist-q card' },
      el('h3', { class: 'hist-q-no', text: `質問 ${i + 1}（5 段階評価）` }),
      el('p', { class: 'hist-q-text', text: q.question || '' }),
      ends ? el('p', { class: 'small muted hist-rating-ends', text: ends }) : null,
      body,
      el('p', { class: 'hist-summary', text: ratingAverageText(q.average, q.total) }),
      el('p', { class: 'small muted', text: `回答 ${q.total} 人` }));
  }

  function questionCard(q, i) {
    if (q && q.type === 'free') return freeCard(q, i);
    if (q && q.type === 'cloud') return cloudCard(q, i);
    if (q && q.type === 'quiz') return quizCard(q, i);
    if (q && q.type === 'rating') return ratingCard(q, i);
    const body = el('div', { class: 'hist-q-body' });
    if (q.total > 0) resultBars(body, { options: q.options, counts: q.counts, total: q.total });
    else body.append(el('p', { class: 'muted', text: '回答はありませんでした。' }));
    return el('li', { class: 'hist-q card' },
      el('h3', { class: 'hist-q-no', text: `質問 ${i + 1}` }),
      el('p', { class: 'hist-q-text', text: q.question || '' }),
      body,
      el('p', { class: 'small muted', text: `回答 ${q.total} 人` }));
  }

  async function remove(message) {
    if (!alive || busy) return;
    const ok = await confirmDialog({ title: 'この授業の記録を削除しますか？', body: '元に戻せません。', okLabel: '削除する', danger: true });
    if (!ok || !alive) return;
    busy = true;
    message.replaceChildren();
    try {
      await ctx.repo.deleteHistory(sid);
      if (!alive) return;
      toast('削除しました。');
      ctx.navigate('history');
    } catch {
      if (alive) message.replaceChildren(el('div', { class: 'notice', role: 'alert' }, el('p', { text: '削除できませんでした。接続を確かめて、もう一度押してください。' })));
    } finally {
      busy = false;
    }
  }

  function renderResult(h) {
    if (!h) {
      page.replaceChildren(backLink(), el('p', { class: 'notice', role: 'alert', text: 'この記録は見つかりません。' }));
      return;
    }
    const span = h.startedAt ? `${formatDateTime(h.startedAt)} 〜 ${formatDateTime(h.endedAt)}` : formatDateTime(h.endedAt);
    const message = el('div', { class: 'hist-message' });
    page.replaceChildren(
      backLink(),
      el('h1', { class: 'hist-h1', text: h.title || UNTITLED }),
      el('p', { class: 'muted', text: `${span} ・ 参加 ${h.participants} 人` }),
      el('ul', { class: 'hist-qs' }, h.questions.map(questionCard)),
      message,
      el('div', { class: 'hist-foot' },
        el('button', { type: 'button', class: 'btn hist-delete', text: 'この記録を削除', onclick: () => remove(message) })));
  }

  async function loadResult() {
    try {
      const h = await ctx.repo.getHistory(sid);
      if (alive) renderResult(h);
    } catch {
      if (alive) failure(loadResult);
    }
  }

  loading();
  if (sid) loadResult(); else loadList();
  return () => { alive = false; closeAllDialogs(); };
}
