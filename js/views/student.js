// 生徒の画面（#/join/<sid>）。ログインなしで参加し、先生の今のスライドに自動で追従する。
// 先生の画面・ログインへの道、スライドを前後に動かす操作、名前の欄、生徒の匿名 ID は出さない。
// 集計の数は state.results があるとき（先生が結果を表示しているとき）だけ DOM に入れる。
// 回答の操作中にフォーカスやスクロールが飛ばないよう、同じスライドの間は部品を作り直さず中身だけ書きかえる。
import { el, statusChip, resultBars } from '../ui.js';
import { renderSlide, OPTION_MARKS } from '../slide-render.js';
import { createSessionClient } from '../session-client.js';

const POLL_CHIP = {
  open: { kind: 'ok', label: '受付中' },
  paused: { kind: 'warn', label: '受付停止中' },
  closed: { kind: 'danger', label: '締切済み' },
};

const ANSWER_TEXT = {
  sending: '送信中…',
  sent: '送信済み。締め切りまでは変えられます。',
  queued: '一時保存しました。つながったら自動で送ります。',
  rejected: '締め切られたため、送信できませんでした。',
  failed: '送信できませんでした。',
  unconfirmed: '授業が終わったため、送信できたか確認できませんでした。',
};

// 送信のボタンの文と、押せないか（off）。status は質問の受付の状態、answer は送った回答（無ければ null）
export function sendButtonState({ status, selected, answer }) {
  if (status === 'paused') return { label: '受付停止中', off: true };
  if (status === 'closed') return { label: '締切済み', off: true };
  const sentChoice = answer && answer.state === 'sent' ? answer.choice : null;
  const sending = !!answer && answer.state === 'sending';
  const notOpen = status !== 'open'; // 受付前など
  if (selected === null || selected === undefined) return { label: '選択肢を選んでください', off: true };
  if (sentChoice !== null && selected === sentChoice) return { label: '送信済み', off: true };
  if (sentChoice !== null) return { label: '回答を更新', off: sending || notOpen };
  return { label: '回答を送信', off: sending || notOpen };
}

// 回答の状態の文（ボタンの下に出す）
export function answerMessage(answer, status) {
  if (!answer || !ANSWER_TEXT[answer.state]) return '';
  // 締め切ったあとは「変えられます」と言わない
  if (answer.state === 'sent' && status === 'closed') return '送信済み。';
  return ANSWER_TEXT[answer.state];
}

export function mount(root, ctx) {
  const sid = ctx.params.sid;
  let alive = true;
  let client = null;
  let state = null;
  let shownKey = null; // 本体に出しているもの（'loading'・'wait'・'slide:<id>' など）
  let pollUi = null;   // アンケートの部品（同じ質問の間は作り直さない）

  // ---- 骨組み（1 回だけ作る） ----
  const titleEl = el('h1', { class: 'st-title', text: 'ClassPulse' });
  const connEl = el('div', { class: 'st-conn', role: 'status' });
  const body = el('div', { class: 'st-body' });
  const wrap = el('main', { class: 'st' },
    el('header', { class: 'st-head' }, titleEl, connEl),
    body);
  root.replaceChildren(wrap);

  function startClient() {
    if (client) client.stop();
    shownKey = null;
    pollUi = null;
    client = createSessionClient({
      net: ctx.net,
      auth: ctx.auth,
      storage: ctx.storage,
      sid,
      onChange: (s) => { if (alive) { state = s; render(); } },
    });
    client.start();
  }

  // 本体の中身を入れかえる（key が同じなら何もしない）
  function show(key, ...children) {
    if (key === shownKey) return false;
    shownKey = key;
    pollUi = null;
    body.replaceChildren(...children);
    return true;
  }

  // ---- 通信の状態 ----
  let shownConn = null;
  function renderConn(kind) {
    if (kind === shownConn) return;
    shownConn = kind;
    if (kind === 'connected') connEl.replaceChildren(statusChip('ok', '接続中'));
    else if (kind === 'disconnected') connEl.replaceChildren(statusChip('warn', '接続が切れています。つなぎ直しています'));
    else connEl.replaceChildren();
  }

  // ---- アンケート ----
  const isOff = (btn) => btn.getAttribute('aria-disabled') === 'true';
  // 押せなくする（disabled にするとフォーカスが外れるので aria-disabled を使い、押しても何もしない）
  function setOff(btn, off) {
    if (off) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  }

  function buildPoll(slide) {
    const options = Array.isArray(slide.options) ? slide.options.slice(0, OPTION_MARKS.length) : [];
    const ui = { options, cards: [], resultsKey: null };
    ui.statusChip = el('span', { class: 'st-chip-status' });
    ui.cards = options.map((opt, i) => {
      const selTag = el('span', { class: 'st-tag st-tag-selected', text: '選択中', hidden: true });
      const sentTag = el('span', { class: 'st-tag st-tag-sent', hidden: true },
        el('span', { class: 'st-check', 'aria-hidden': 'true', text: '✓' }),
        el('span', { text: '送信済み' }));
      const btn = el('button', {
        type: 'button', class: 'st-option', 'aria-pressed': 'false',
        onclick: () => { if (!isOff(btn)) client.select(i); },
      },
      el('span', { class: 'st-mark', text: OPTION_MARKS[i] }),
      // 文と印（狭い画面では、印を文の下へ回す）
      el('span', { class: 'st-option-body' },
        el('span', { class: 'st-option-text', text: typeof opt === 'string' ? opt : String(opt ?? '') }),
        el('span', { class: 'st-tags' }, selTag, sentTag)));
      return { btn, selTag, sentTag };
    });
    ui.sendBtn = el('button', {
      type: 'button', class: 'btn btn-primary st-send',
      onclick: () => { if (!isOff(ui.sendBtn)) client.submit(); },
    });
    ui.message = el('p', { class: 'st-answer-text' });
    ui.retryBtn = el('button', {
      type: 'button', class: 'btn st-retry', text: 'もう一度送る', hidden: true,
      onclick: () => client.retry(),
    });
    ui.results = el('section', { class: 'st-results', 'aria-labelledby': 'st-results-title', hidden: true });
    ui.root = el('section', { class: 'st-poll', 'aria-labelledby': 'st-question' },
      el('h2', { id: 'st-question', class: 'st-question', text: typeof slide.question === 'string' ? slide.question : '' }),
      el('div', { class: 'st-chips' }, statusChip('info', 'この質問は匿名です'), ui.statusChip),
      el('div', { class: 'st-options', role: 'group', 'aria-labelledby': 'st-question' }, ui.cards.map((c) => c.btn)),
      ui.sendBtn,
      el('div', { class: 'st-answer', 'aria-live': 'polite' }, ui.message),
      ui.retryBtn,
      ui.results);
    return ui;
  }

  function updatePoll(ui) {
    const before = document.activeElement;
    const status = state.poll ? state.poll.status : '';
    const answer = state.answer;
    const sentChoice = answer && answer.state === 'sent' ? answer.choice : null;
    const locked = status !== 'open'; // 受付中のときだけ選べる

    // 受付の状態のチップ（受付前は出さない）
    const chip = POLL_CHIP[status];
    const chipKey = chip ? status : '';
    if (ui.statusChip.dataset.status !== chipKey) {
      ui.statusChip.dataset.status = chipKey;
      ui.statusChip.replaceChildren(chip ? statusChip(chip.kind, chip.label) : '');
    }

    ui.cards.forEach((c, i) => {
      const isSel = state.selected === i;
      const isSent = sentChoice === i;
      c.btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      c.btn.classList.toggle('is-selected', isSel);
      c.btn.classList.toggle('is-sent', isSent);
      c.selTag.hidden = !isSel;
      c.sentTag.hidden = !isSent;
      setOff(c.btn, locked);
    });

    const b = sendButtonState({ status, selected: state.selected, answer });
    if (ui.sendBtn.textContent !== b.label) ui.sendBtn.textContent = b.label;
    setOff(ui.sendBtn, b.off);

    const msg = answerMessage(answer, status);
    if (ui.message.textContent !== msg) ui.message.textContent = msg;
    ui.message.dataset.state = answer ? answer.state : '';
    const showRetry = !!answer && answer.state === 'failed' && status === 'open';
    ui.retryBtn.hidden = !showRetry;
    if (!showRetry && before === ui.retryBtn) ui.sendBtn.focus(); // 押したボタンが消えたら、送信のボタンへ

    // 結果（先生が表示しているときだけ）
    const r = state.results;
    const key = r ? JSON.stringify(r) : null;
    if (key !== ui.resultsKey) {
      ui.resultsKey = key;
      if (r) {
        const box = el('div', { class: 'st-results-bars' });
        resultBars(box, { options: ui.options, counts: r.counts, total: r.total });
        ui.results.replaceChildren(el('h3', { id: 'st-results-title', text: '結果' }), box);
        ui.results.hidden = false;
      } else {
        ui.results.replaceChildren();
        ui.results.hidden = true;
      }
    }
  }

  // ---- 描画 ----
  function render() {
    if (!alive || !state) return;
    titleEl.textContent = state.title || 'ClassPulse';

    if (state.phase === 'loading') {
      renderConn(null);
      show('loading', el('p', { class: 'st-message', role: 'status', text: '授業に参加しています…' }));
      return;
    }
    if (state.phase === 'not-found') {
      renderConn(null);
      show('not-found', el('p', { class: 'st-message st-alert', role: 'alert', text: 'この授業は見つかりません。QR コードをもう一度読んでください。' }));
      return;
    }
    if (state.phase === 'ended') {
      renderConn(null);
      // 終わる直前に送った回答が届いたか確かめられなかったときは、そのことも伝える
      const unsure = !!state.answer && state.answer.state === 'unconfirmed';
      show(unsure ? 'ended:unconfirmed' : 'ended', el('section', { class: 'st-end' },
        el('h2', { text: '授業は終了しました' }),
        el('p', { text: '参加してくれてありがとう。このページは閉じてかまいません。' }),
        unsure ? el('p', { class: 'st-answer-text', 'data-state': 'unconfirmed', text: ANSWER_TEXT.unconfirmed }) : null));
      return;
    }
    if (state.phase === 'error') {
      renderConn(null);
      show('error',
        el('p', { class: 'st-message st-alert', role: 'alert', text: '通信できませんでした。' }),
        el('p', {}, el('button', { type: 'button', class: 'btn btn-primary st-again', text: 'もう一度', onclick: startClient })));
      return;
    }
    if (state.phase !== 'live') return;
    renderConn(state.connection === 'disconnected' ? 'disconnected' : 'connected');

    const slide = state.slide;
    if (state.index < 0 || !slide) {
      show('wait', el('p', { class: 'st-message st-wait', role: 'status', text: '先生が始めるまで、このままお待ちください。' }));
      return;
    }
    const key = `slide:${state.slideId}`;
    if (slide.type === 'poll') {
      if (show(key)) {
        pollUi = buildPoll(slide);
        body.append(pollUi.root);
        window.scrollTo(0, 0); // 新しいスライドは上から
      }
      if (pollUi) updatePoll(pollUi);
      return;
    }
    if (show(key)) {
      const box = el('section', { class: 'st-slide', 'aria-label': 'スライド' });
      renderSlide(box, slide, state.images);
      body.append(box);
      window.scrollTo(0, 0);
    }
  }

  startClient();

  return () => {
    alive = false;
    if (client) client.stop();
  };
}
