// 授業履歴（#/history）と、1 回の授業の結果（#/history/<sid>）。
// 回答は匿名なので、ここには集計した人数だけを出す（個人ごとの一覧や ID は出さない）。
import { el, confirmDialog, closeAllDialogs, resultBars, toast } from '../ui.js';
import { formatDateTime } from '../format.js';
import { routeHash } from '../router.js';

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
      el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度', onclick: () => { loading(); retry(); } })));
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
  function questionCard(q, i) {
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
    if (busy) return;
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
