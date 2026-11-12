// 生徒の画面（#/join/<sid>）。ログインなしで参加し、先生の今のスライドに自動で追従する。
// 先生の画面・ログインへの道、スライドを前後に動かす操作、名前の欄、生徒の匿名 ID は出さない。
// 集計の数は state.results があるとき（先生が結果を表示しているとき）だけ DOM に入れる。
// 自由記述・ワードクラウドでは、ほかの生徒の文章・言葉は出さない（結果の表示中は「前の画面を見てください」とだけ出す）。
// 回答の操作中にフォーカスやスクロールが飛ばないよう、同じスライドの間は部品を作り直さず中身だけ書きかえる。
import { el, statusChip, resultBars } from '../ui.js';
import { renderSlide, OPTION_MARKS } from '../slide-render.js';
import { createSessionClient } from '../session-client.js';
import { normalizeText, normalizeWords, sameWords } from '../session-logic.js';
import { CONFIG } from '../config.js';

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
  if (status === 'closed') {
    // 締め切ったあとは「変えられます」と言わない
    if (answer.state === 'sent') return '送信済み。';
    // 締切後の一時保存は自動では送らない（届いていたかを照合するだけ）。送れた・送れなかったとは言わない
    if (answer.state === 'queued') return '締め切られました。つながったら、送信できていたかを確かめます。';
  }
  return ANSWER_TEXT[answer.state];
}

// 「もう一度送る」を出すか。retry() は失敗した回答（answer.choice）を送り直すので、
// 受付中で、画面で選んでいるものが その回答と同じ（または何も選んでいない）ときだけ出す。
// 別のものを選んだときは出さず、ふつうの送信のボタンで今の選択を送る
export function retryVisible({ status, selected, answer }) {
  if (!answer || answer.state !== 'failed' || status !== 'open') return false;
  return selected === null || selected === undefined || selected === answer.choice;
}

// アンケートの画面の決めごとをまとめる（画面はこの結果をそのまま当てはめるだけ）
// cardsOff: 選択肢を押せないか、sentChoice: 「送信済み」の印を付ける選択肢、showResults: 結果の棒を出すか
export function pollDecision({ status, selected, answer, results }) {
  return {
    cardsOff: status !== 'open',
    sentChoice: answer && answer.state === 'sent' ? answer.choice : null,
    send: sendButtonState({ status, selected, answer }),
    message: answerMessage(answer, status),
    retry: retryVisible({ status, selected, answer }),
    showResults: !!results,
  };
}

// ---- 自由記述 ----
const RESULTS_NOTE = 'みんなの回答は、前の画面を見てください';

// 自由記述の画面の決めごと（画面はこの結果をそのまま当てはめるだけ）。
// input は入力欄の今の文、answer は送った文章の記録（{ text, state } か null）。
// readOnly: 入力欄を読み取り専用にするか（一時停止中・締切後）、send: 送信のボタンの文と押せないか、
// retry: 「もう一度送る」を出すか、remaining: 残りの文字数、showNote: 「前の画面を見てください」を出すか
export function freeDecision({ status, input, answer, resultsVisible }) {
  const raw = typeof input === 'string' ? input : '';
  const text = normalizeText(raw);
  const prev = answer && typeof answer.text === 'string' ? answer.text : null;
  return {
    ...writtenDecision({ status, answer: prev !== null ? answer : null, empty: text === null, same: text !== null && text === prev, resultsVisible }),
    remaining: CONFIG.free.maxLength - raw.length,
  };
}

// 書いて答える質問（自由記述・ワードクラウド）で共通の決めごと。
// answer は送った値の記録（無ければ null）、empty は入力が送れる値にならないか、same は送った値と同じか
function writtenDecision({ status, answer, empty, same, resultsVisible }) {
  const st = answer ? answer.state : null;
  const readOnly = status === 'paused' || status === 'closed';
  // 届いた（または届く途中の）値があるときは「送り直す」。失敗・締切で送れなかったものは「送信」のまま
  const resend = st === 'sent' || st === 'sending' || st === 'queued';
  let send;
  if (status === 'paused') send = { label: '受付停止中', off: true };
  else if (status === 'closed') send = { label: '締切済み', off: true };
  else if (same && st === 'sent') send = { label: '送信済み', off: true };
  else send = { label: resend ? '送り直す' : '送信', off: status !== 'open' || empty || same };
  return {
    readOnly,
    send,
    message: answerMessage(answer, status),
    // retry() は失敗した値を送り直すので、入力がその値と同じ（または空）のときだけ出す
    retry: status === 'open' && st === 'failed' && (empty || same),
    showNote: !!resultsVisible,
  };
}

// 入力欄に出す文。読み取り専用のときは送った文章（無ければ書きかけ）、
// 書けるときは書きかけ（無ければ送った文章）
export function freeShownText({ readOnly, draft, text }) {
  const d = typeof draft === 'string' ? draft : '';
  const t = typeof text === 'string' ? text : '';
  if (readOnly) return t || d;
  return d || t;
}

// ---- ワードクラウド ----
const CLOUD_FIELDS = CONFIG.cloud.maxWords; // 入力欄の数

// ワードクラウドの画面の決めごと。inputs は 3 つの入力欄の今の文、answer は送った言葉の記録（{ words, state } か null）。
// 送れるのは、正しい言葉（normalizeWords を通るもの）が 1 つ以上あり、送った言葉と違うとき。
// 戻り値は自由記述と同じ形（readOnly・send・message・retry・showNote）
export function cloudDecision({ status, inputs, answer, resultsVisible }) {
  const words = normalizeWords(Array.isArray(inputs) ? inputs : []);
  const prev = answer && Array.isArray(answer.words) ? answer.words : null;
  return writtenDecision({
    status,
    answer: prev !== null ? answer : null,
    empty: words === null,
    same: words !== null && sameWords(words, prev),
    resultsVisible,
  });
}

// 3 つの入力欄に出す文（長さ 3 の配列）。考え方は freeShownText と同じ:
// 読み取り専用のときは送った言葉（無ければ書きかけ）、書けるときは書きかけ（無ければ送った言葉）
export function cloudShownWords({ readOnly, draft, words }) {
  const fill = (list) => Array.from({ length: CLOUD_FIELDS }, (_, i) => (Array.isArray(list) && typeof list[i] === 'string' ? list[i] : ''));
  const d = fill(draft);
  const w = fill(words);
  const hasDraft = d.some((s) => s !== '');
  const hasWords = w.some((s) => s !== '');
  if (readOnly) return hasWords ? w : d;
  return hasDraft ? d : w;
}

// 終了の画面に何を出すか。未確認の回答は、今の質問だけでなく授業全体で数える
// （終わった授業を開き直したときや、前の質問に残っているときも伝える）
export function endedDecision({ unconfirmedCount = 0 } = {}) {
  const n = Number.isInteger(unconfirmedCount) && unconfirmedCount > 0 ? unconfirmedCount : 0;
  if (n === 0) return { key: 'ended', message: '' };
  return { key: `ended:unconfirmed:${n}`, message: `授業が終わったため、送信できたか確認できなかった回答が ${n} 件あります。` };
}

export function mount(root, ctx) {
  const sid = ctx.params.sid;
  let alive = true;
  let client = null;
  let state = null;
  let shownKey = null; // 本体に出しているもの（'loading'・'wait'・'slide:<id>' など）
  let pollUi = null;   // アンケートの部品（同じ質問の間は作り直さない）
  let freeUi = null;   // 自由記述の部品（同じ質問の間は作り直さない。入力欄の文字とカーソルを守る）
  let cloudUi = null;  // ワードクラウドの部品（同じく作り直さない）

  // ---- 骨組み（1 回だけ作る） ----
  const titleEl = el('h1', { class: 'st-title', text: 'ClassPulse' });
  const connEl = el('div', { class: 'st-conn', role: 'status' });
  const body = el('div', { class: 'st-body' });
  const wrap = el('main', { class: 'st' },
    el('header', { class: 'st-head' }, titleEl, connEl),
    body);
  root.replaceChildren(wrap);

  function startClient() {
    if (!alive) return; // 片づけたあと（古い画面のボタンが遅れて押された）は、新しく作らない
    if (client) client.stop();
    shownKey = null;
    pollUi = null;
    freeUi = null;
    cloudUi = null;
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
    freeUi = null;
    cloudUi = null;
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

  // 受付の状態のチップ（受付前は出さない）。アンケートと自由記述で共通
  function updateStatusChip(node, status) {
    const chip = POLL_CHIP[status];
    const chipKey = chip ? status : '';
    if (node.dataset.status !== chipKey) {
      node.dataset.status = chipKey;
      node.replaceChildren(chip ? statusChip(chip.kind, chip.label) : '');
    }
  }

  function buildPoll(slide) {
    const options = Array.isArray(slide.options) ? slide.options.slice(0, OPTION_MARKS.length) : [];
    const ui = { options, cards: [], resultsKey: null };
    ui.statusChip = el('span', { class: 'st-chip-status', 'aria-live': 'polite' });
    ui.cards = options.map((opt, i) => {
      const selTag = el('span', { class: 'st-tag st-tag-selected', text: '選択中', hidden: true });
      const sentTag = el('span', { class: 'st-tag st-tag-sent', hidden: true },
        el('span', { class: 'st-check', 'aria-hidden': 'true', text: '✓' }),
        el('span', { text: '送信済み' }));
      const btn = el('button', {
        type: 'button', class: 'st-option', 'aria-pressed': 'false',
        'aria-label': `${OPTION_MARKS[i]} ${typeof opt === 'string' ? opt : String(opt ?? '')}`,
        onclick: () => { if (alive && !isOff(btn)) client.select(i); },
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
      onclick: () => { if (alive && !isOff(ui.sendBtn)) client.submit(); },
    });
    ui.message = el('p', { class: 'st-answer-text' });
    ui.retryBtn = el('button', {
      type: 'button', class: 'btn st-retry', text: 'もう一度送る', hidden: true,
      // 押した瞬間にも確かめる（選び直したあとに古い回答を送り直さない）
      onclick: () => { if (alive && ui.decision && ui.decision.retry) client.retry(); },
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
    // 何を出すか・押せるかは pollDecision が決める（テストはそちらで行う）。ここは当てはめるだけ
    const d = pollDecision({ status, selected: state.selected, answer, results: state.results });
    ui.decision = d;

    updateStatusChip(ui.statusChip, status);

    ui.cards.forEach((c, i) => {
      const isSel = state.selected === i;
      const isSent = d.sentChoice === i;
      c.btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      // 読み上げの名前: 「A はい」＋ 状態（選択中／送信済み）。中身の文字の組み立てに頼らず、いつも同じ形にする
      c.btn.setAttribute('aria-label', `${OPTION_MARKS[i]} ${typeof ui.options[i] === 'string' ? ui.options[i] : String(ui.options[i] ?? '')}${isSel ? '、選択中' : ''}${isSent ? '、送信済み' : ''}`);
      c.btn.classList.toggle('is-selected', isSel);
      c.btn.classList.toggle('is-sent', isSent);
      c.selTag.hidden = !isSel;
      c.sentTag.hidden = !isSent;
      setOff(c.btn, d.cardsOff);
    });

    if (ui.sendBtn.textContent !== d.send.label) ui.sendBtn.textContent = d.send.label;
    setOff(ui.sendBtn, d.send.off);

    if (ui.message.textContent !== d.message) ui.message.textContent = d.message;
    ui.message.dataset.state = answer ? answer.state : '';
    ui.retryBtn.hidden = !d.retry;
    if (!d.retry && before === ui.retryBtn) ui.sendBtn.focus(); // 押したボタンが消えたら、送信のボタンへ

    // 結果（先生が表示しているときだけ）
    const r = d.showResults ? state.results : null;
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

  // ---- 自由記述 ----
  // 入力欄は 1 回だけ作り、状態が変わっても作り直さない・value を書きかえない
  // （書きかえるのは、読み取り専用に切りかわるときと、読み取り専用の間だけ。変換の途中の文字を壊さない）
  function buildFree(slide, slideId) {
    const ui = { slideId, readOnly: null, decision: null };
    ui.statusChip = el('span', { class: 'st-chip-status', 'aria-live': 'polite' });
    ui.input = el('textarea', {
      id: 'st-free-input', class: 'st-free-input', rows: '5',
      maxlength: String(CONFIG.free.maxLength),
      'aria-labelledby': 'st-question', 'aria-describedby': 'st-free-count',
      autocomplete: 'off',
    });
    // 入力のたびに書きかけを保存し、ボタンと残りの文字数だけを書きかえる
    ui.input.addEventListener('input', () => {
      if (!alive || !client || freeUi !== ui) return;
      client.setDraft(ui.slideId, ui.input.value);
      updateFree(ui);
    });
    ui.count = el('p', { id: 'st-free-count', class: 'st-free-count' });
    ui.sendBtn = el('button', {
      type: 'button', class: 'btn btn-primary st-send',
      onclick: () => { if (alive && client && !isOff(ui.sendBtn)) client.submitText(ui.input.value); },
    });
    ui.message = el('p', { class: 'st-answer-text' });
    ui.retryBtn = el('button', {
      type: 'button', class: 'btn st-retry', text: 'もう一度送る', hidden: true,
      // 押した瞬間にも確かめる（書き直したあとに古い文章を送り直さない）
      onclick: () => { if (alive && client && ui.decision && ui.decision.retry) client.retry(); },
    });
    ui.note = el('p', { class: 'st-free-note', role: 'status', hidden: true, text: RESULTS_NOTE });
    ui.root = el('section', { class: 'st-poll st-free', 'aria-labelledby': 'st-question' },
      el('h2', { id: 'st-question', class: 'st-question', text: typeof slide.question === 'string' ? slide.question : '' }),
      el('div', { class: 'st-chips' }, statusChip('info', 'この質問は匿名です'), ui.statusChip),
      ui.input,
      ui.count,
      ui.sendBtn,
      el('div', { class: 'st-answer', 'aria-live': 'polite' }, ui.message),
      ui.retryBtn,
      ui.note);
    return ui;
  }

  function updateFree(ui) {
    const before = document.activeElement;
    const status = state.poll ? state.poll.status : '';
    const answer = state.answer;
    const readOnly = status === 'paused' || status === 'closed';
    // 読み取り専用に切りかわるとき（と、その間）は、送った文章を見せる。書けるように戻ったら書きかけを戻す
    if (readOnly !== ui.readOnly || readOnly) {
      const shown = freeShownText({ readOnly, draft: client ? client.draft(ui.slideId) : '', text: state.text });
      if (ui.input.value !== shown) ui.input.value = shown;
      ui.input.readOnly = readOnly;
      ui.readOnly = readOnly;
    }
    const d = freeDecision({ status, input: ui.input.value, answer, resultsVisible: state.poll && state.poll.resultsVisible });
    ui.decision = d;
    updateStatusChip(ui.statusChip, status);

    const count = `残り ${d.remaining} 文字`;
    if (ui.count.textContent !== count) ui.count.textContent = count;
    if (ui.sendBtn.textContent !== d.send.label) ui.sendBtn.textContent = d.send.label;
    setOff(ui.sendBtn, d.send.off);

    if (ui.message.textContent !== d.message) ui.message.textContent = d.message;
    ui.message.dataset.state = d.message && answer ? answer.state : '';
    ui.retryBtn.hidden = !d.retry;
    if (!d.retry && before === ui.retryBtn) ui.sendBtn.focus(); // 押したボタンが消えたら、送信のボタンへ
    ui.note.hidden = !d.showNote;
  }

  // ---- ワードクラウド ----
  // 入力欄 3 つは 1 回だけ作り、状態が変わっても作り直さない・value を書きかえない（自由記述と同じ考え方）。
  // 書きかえるのは、読み取り専用に切りかわるときと、読み取り専用の間だけ
  function buildCloud(slide, slideId) {
    const ui = { slideId, readOnly: null, decision: null, composing: false };
    ui.statusChip = el('span', { class: 'st-chip-status', 'aria-live': 'polite' });
    const values = () => ui.inputs.map((n) => n.value);
    ui.inputs = Array.from({ length: CONFIG.cloud.maxWords }, (_, i) => el('input', {
      type: 'text', class: 'st-cloud-input',
      maxlength: String(CONFIG.cloud.maxLength),
      'aria-label': `言葉 ${i + 1}`, 'aria-describedby': 'st-cloud-hint',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: i < CONFIG.cloud.maxWords - 1 ? 'next' : 'send',
    }));
    ui.inputs.forEach((input, i) => {
      // 入力のたびに 3 つの書きかけを保存し、ボタンと文だけを書きかえる（入力欄には触らない）
      input.addEventListener('input', () => {
        if (!alive || !client || cloudUi !== ui) return;
        client.setDraft(ui.slideId, values());
        updateCloud(ui);
      });
      // 日本語の変換の途中か（変換の確定の Enter で次へ進まない。読み取り専用に切りかえるときに確定させる）
      input.addEventListener('compositionstart', () => { ui.composing = true; });
      input.addEventListener('compositionend', () => { ui.composing = false; });
      // Enter: 次の欄へ。最後の欄なら、送れるときだけ送る
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || ui.composing) return;
        ev.preventDefault();
        if (i < ui.inputs.length - 1) ui.inputs[i + 1].focus();
        else if (!isOff(ui.sendBtn)) ui.sendBtn.click();
      });
    });
    ui.sendBtn = el('button', {
      type: 'button', class: 'btn btn-primary st-send',
      onclick: () => { if (alive && client && cloudUi === ui && !isOff(ui.sendBtn)) client.submitWords(values()); },
    });
    ui.message = el('p', { class: 'st-answer-text' });
    ui.retryBtn = el('button', {
      type: 'button', class: 'btn st-retry', text: 'もう一度送る', hidden: true,
      // 押した瞬間にも確かめる（書き直したあとに古い言葉を送り直さない）
      onclick: () => { if (alive && client && ui.decision && ui.decision.retry) client.retry(); },
    });
    ui.note = el('p', { class: 'st-free-note', role: 'status', hidden: true, text: RESULTS_NOTE });
    ui.root = el('section', { class: 'st-poll st-free st-cloud', 'aria-labelledby': 'st-question' },
      el('h2', { id: 'st-question', class: 'st-question', text: typeof slide.question === 'string' ? slide.question : '' }),
      el('div', { class: 'st-chips' }, statusChip('info', 'この質問は匿名です'), ui.statusChip),
      el('p', { id: 'st-cloud-hint', class: 'st-cloud-hint', text: `短い言葉を ${CONFIG.cloud.maxWords} つまで書けます（1 つ ${CONFIG.cloud.maxLength} 文字まで）。` }),
      el('div', { class: 'st-cloud-inputs', role: 'group', 'aria-labelledby': 'st-question' }, ui.inputs),
      ui.sendBtn,
      el('div', { class: 'st-answer', 'aria-live': 'polite' }, ui.message),
      ui.retryBtn,
      ui.note);
    return ui;
  }

  function updateCloud(ui) {
    const before = document.activeElement;
    const status = state.poll ? state.poll.status : '';
    const answer = state.answer;
    const readOnly = status === 'paused' || status === 'closed';
    if (readOnly !== ui.readOnly || readOnly) {
      // 変換の途中で読み取り専用になったら、先にフォーカスを外して変換を終わらせる（途中の文字と書きかえがぶつからない）
      if (readOnly && ui.composing && before instanceof HTMLElement && ui.inputs.includes(before)) before.blur();
      const shown = cloudShownWords({ readOnly, draft: client ? client.draft(ui.slideId) : null, words: state.words });
      ui.inputs.forEach((n, i) => {
        if (n.value !== shown[i]) n.value = shown[i];
        n.readOnly = readOnly;
      });
      ui.readOnly = readOnly;
    }
    const d = cloudDecision({ status, inputs: ui.inputs.map((n) => n.value), answer, resultsVisible: state.poll && state.poll.resultsVisible });
    ui.decision = d;
    updateStatusChip(ui.statusChip, status);

    if (ui.sendBtn.textContent !== d.send.label) ui.sendBtn.textContent = d.send.label;
    setOff(ui.sendBtn, d.send.off);

    if (ui.message.textContent !== d.message) ui.message.textContent = d.message;
    ui.message.dataset.state = d.message && answer ? answer.state : '';
    ui.retryBtn.hidden = !d.retry;
    if (!d.retry && before === ui.retryBtn) ui.sendBtn.focus(); // 押したボタンが消えたら、送信のボタンへ
    ui.note.hidden = !d.showNote;
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
      // 届いたか確かめられなかった回答があれば、その件数も伝える（今の質問の回答に限らない）
      const end = endedDecision(state);
      show(end.key, el('section', { class: 'st-end' },
        el('h2', { text: '授業は終了しました' }),
        el('p', { text: '参加してくれてありがとう。このページは閉じてかまいません。' }),
        end.message ? el('p', { class: 'st-answer-text', 'data-state': 'unconfirmed', text: end.message }) : null));
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
    if (slide.type === 'free') {
      if (show(key)) {
        freeUi = buildFree(slide, state.slideId);
        body.append(freeUi.root);
        window.scrollTo(0, 0);
      }
      if (freeUi) updateFree(freeUi);
      return;
    }
    if (slide.type === 'cloud') {
      if (show(key)) {
        cloudUi = buildCloud(slide, state.slideId);
        body.append(cloudUi.root);
        window.scrollTo(0, 0);
      }
      if (cloudUi) updateCloud(cloudUi);
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
    client = null;
    // 次の画面に替わるまで古い DOM が残ることがある。その間に押されても何もしないよう、ボタンを止める
    for (const b of wrap.querySelectorAll('button')) b.setAttribute('aria-disabled', 'true');
    for (const t of wrap.querySelectorAll('textarea, input')) t.readOnly = true;
  };
}
