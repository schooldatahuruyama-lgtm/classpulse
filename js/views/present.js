// 発表の画面（#/present/<sid>）。先生の iPad の画面がそのまま生徒に映る。
// このため、ナビゲーション・メールアドレス・生徒の ID・非公開の集計は画面に出さない。
// 結果を非公開にしている質問は「回答 N 人 ／ 参加 M 人」だけを出し、件数の内訳は DOM に入れない。
import { el, confirmDialog, closeAllDialogs, statusChip, resultBars, toast } from '../ui.js';
import { renderSlide } from '../slide-render.js';
import { createSessionHost } from '../session-host.js';

const FAIL = '通信できなかったため、進められませんでした。';
const ENDING = '授業を終了しています…';
const JOIN_TITLE = 'カメラで QR コードを読んで参加してください';
const SVG_NS = 'http://www.w3.org/2000/svg';
const QR_MARGIN = 4; // QR コードのまわりの白い余白（モジュールの数）

const POLL_STATUS = {
  open: { kind: 'ok', label: '受付中' },
  paused: { kind: 'warn', label: '受付停止中' },
  closed: { kind: 'danger', label: '締切済み' },
};

// 参加の URL: 今の場所の # より前（?demo=1 などはそのまま）に #/join/<sid> を付ける
export function joinUrl(href, sid) {
  return `${String(href).split('#')[0]}#/join/${encodeURIComponent(sid)}`;
}

// QR コードを SVG で作る（ライブラリの HTML の文字列は使わず、モジュールの表から DOM で組み立てる）
function qrSvg(text) {
  const factory = typeof window !== 'undefined' ? window.qrcode : undefined;
  if (typeof factory !== 'function') return null;
  let qr;
  try {
    qr = factory(0, 'M');
    qr.addData(text);
    qr.make();
  } catch (e) {
    console.error(e);
    return null;
  }
  const n = qr.getModuleCount();
  const size = n + QR_MARGIN * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '参加用の QR コード');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#FFFFFF');
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + QR_MARGIN} ${r + QR_MARGIN}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

export function mount(root, ctx) {
  const sid = ctx.params.sid;
  const url = joinUrl(window.location.href, sid);
  let alive = true;
  let leaving = false;
  let state = null;
  let live = null; // 発表中の画面の部品（最初に live になったときに作る）
  let shownKey = null; // 中央に出しているもの（'join' か スライド ID）
  let qrDialog = null;
  const pending = { pause: false, results: false };
  let moving = 0; // 通信待ちのスライド移動の数（その間は受付・結果の操作を押せない）
  // 授業の終了: 'idle'（まだ）、'running'（後片づけの途中）、'failed'（終了したが後片づけが残った）、'done'（済んだ）
  let endState = 'idle';

  const host = createSessionHost({
    net: ctx.net,
    repo: ctx.repo,
    sid,
    onChange: (s) => { if (alive) { state = s; render(); } },
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t),
  });

  // 授業履歴（結果）の画面へ。移れなかったら（通信できないなど）、やり直しのボタンを出す
  async function goHistory() {
    if (leaving || !alive) return;
    leaving = true;
    try {
      await ctx.navigate('result', { sid });
    } catch (e) {
      console.error(e);
    }
    if (!alive) return; // 移れた（この画面は片づけられた）
    leaving = false;
    page(el('h2', { text: '授業を終了しました' }),
      el('p', { role: 'alert', text: '授業履歴を開けませんでした。接続を確かめてください。' }),
      el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: '授業履歴を開く', onclick: goHistory })));
  }

  // 授業を終える（後片づけまで）。済んでから授業履歴へ移る。途中で画面を離れると後片づけが止まるため
  async function finishEnd() {
    if (endState === 'running' || !alive) return;
    endState = 'running';
    render();
    try {
      await host.end();
    } catch {
      if (!alive) return;
      if (state && state.phase === 'ended') {
        endState = 'failed'; // 授業は終わったが、後片づけが残った。やり直せる
      } else {
        endState = 'idle'; // まだ終わっていない（授業は続いている）
        toast(FAIL);
      }
      render();
      return;
    }
    if (!alive) return;
    endState = 'done';
    goHistory();
  }

  function page(...children) {
    live = null;
    shownKey = null;
    root.replaceChildren(el('div', { class: 'present present-message' }, el('div', { class: 'page-pad' }, ...children)));
  }

  function startHost() {
    page(el('p', { class: 'loading', role: 'status', text: '読み込み中…' }));
    host.start().catch(() => {
      if (!alive) return;
      page(el('h2', { text: '読み込めませんでした' }),
        el('p', { role: 'alert', text: '通信できませんでした。接続を確かめてください。' }),
        el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度読み込む', onclick: startHost })));
    });
  }

  // ---- 部品 ----
  const isOff = (btn) => btn.getAttribute('aria-disabled') === 'true';
  // 押せなくする（disabled にするとフォーカスが外れるので aria-disabled を使い、押しても何もしない）
  function setOff(btn, off) {
    if (off) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  }

  function participantsText() {
    return `参加 ${state ? state.participants : 0} 人`;
  }

  // 参加の案内（見出し・QR コード・URL・参加人数）。中央の画面と重ね表示で共通
  function joinContent(titleId) {
    const svg = qrSvg(url);
    return el('div', { class: 'pr-join' },
      el('div', { class: 'pr-qr' }, svg || el('p', { class: 'pr-qr-missing', text: 'QR コードを作れませんでした。下の URL を開いてください。' })),
      el('div', { class: 'pr-join-text' },
        el('h1', { id: titleId, class: 'pr-join-title', text: JOIN_TITLE }),
        el('p', { class: 'pr-join-url', text: url }),
        el('p', { class: 'pr-join-count', text: participantsText() })));
  }

  function openQr() {
    if (qrDialog || !live) return;
    const close = el('button', { type: 'button', class: 'btn btn-primary pr-qr-close', text: '閉じる', onclick: () => qrDialog && qrDialog.close() });
    const dlg = el('dialog', { class: 'pr-qr-dialog', 'aria-labelledby': 'pr-qr-dialog-title' }, joinContent('pr-qr-dialog-title'), close);
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (qrDialog === dlg) qrDialog = null;
      if (alive && live) live.qrBtn.focus();
    });
    qrDialog = dlg;
    live.wrap.append(dlg);
    dlg.showModal();
    close.focus();
  }

  // ---- 操作 ----
  function run(fn) {
    return fn().catch(() => { if (alive) toast(FAIL); });
  }

  // 「次へ」「前へ」は続けて押してよい（host が 1 つずつ順に行う）
  function go(dir) {
    if (!live) return;
    const btn = dir > 0 ? live.nextBtn : live.prevBtn;
    if (isOff(btn) || btn.hidden) return;
    moving += 1;
    render();
    run(() => (dir > 0 ? host.next() : host.prev())).finally(() => {
      moving -= 1;
      if (alive) render();
    });
  }

  // 受付の停止・再開と結果の表示は、終わるまで同じボタンを押せなくする
  async function once(key, fn) {
    if (pending[key]) return;
    pending[key] = true;
    render();
    try {
      await run(fn);
    } finally {
      pending[key] = false;
      if (alive) render();
    }
  }

  function currentPoll() {
    const cur = state && state.pub && state.pub.current;
    const id = cur && cur.slideId;
    const slide = id ? state.slides[id] : null;
    if (!slide || slide.type !== 'poll') return null;
    const poll = (state.pub.polls || {})[id];
    return poll ? { id, slide, poll } : null;
  }

  function togglePause() {
    const p = currentPoll();
    if (!p || isOff(live.pauseBtn)) return;
    // 表示しているスライドを渡す（順番が来たときに別のスライドになっていたら、host は何もしない）
    once('pause', () => host.setPaused(p.poll.status === 'open', p.id));
  }

  function toggleResults() {
    const p = currentPoll();
    if (!p || isOff(live.resultsBtn)) return;
    once('results', () => host.setResultsVisible(!p.poll.resultsVisible, p.id));
  }

  async function endClass() {
    if (endState !== 'idle' || !live || isOff(live.endBtn)) return;
    const ok = await confirmDialog({
      title: '授業を終了しますか？',
      body: '参加用のリンクが使えなくなり、生徒の画面は終了の画面になります。結果は授業履歴に残ります。',
      okLabel: '終了する',
      danger: true,
    });
    if (!ok || !alive || endState !== 'idle') return;
    finishEnd();
  }

  // ---- 発表中の画面の骨組み（1 回だけ作り、あとは中身を書きかえる） ----
  function buildLive() {
    const btn = (cls, text, onclick) => el('button', { type: 'button', class: `btn ${cls}`, text, onclick });
    const l = {};
    l.banner = el('div', { class: 'pr-offline', role: 'alert', hidden: true, text: '接続が切れています。つなぎ直しています…' });
    l.stage = el('section', { class: 'pr-stage', 'aria-label': 'スライド' });
    l.poll = el('aside', { class: 'pr-poll', 'aria-label': 'アンケートの状況', hidden: true });
    l.prevBtn = btn('pr-prev', '← 前へ', () => go(-1));
    l.pos = el('span', { class: 'pr-pos' });
    l.nextBtn = btn('btn-primary pr-next', '次へ →', () => go(1));
    l.last = el('span', { class: 'pr-last', hidden: true, text: '最後のスライドです' });
    l.pauseBtn = btn('pr-pause', '受付を止める', togglePause);
    l.resultsBtn = btn('pr-results-btn', '結果を表示', toggleResults);
    l.pollGroup = el('div', { class: 'pr-group pr-group-poll', hidden: true }, l.pauseBtn, l.resultsBtn);
    l.count = el('span', { class: 'pr-count' });
    l.qrBtn = btn('pr-qr-btn', 'QR コード', openQr);
    l.endBtn = btn('btn-danger pr-end', '授業を終了', endClass);
    l.bar = el('div', { class: 'pr-bar', role: 'toolbar', 'aria-label': '発表の操作' },
      el('div', { class: 'pr-group pr-group-nav' }, l.prevBtn, l.pos, l.nextBtn, l.last),
      l.pollGroup,
      el('div', { class: 'pr-group pr-group-side' }, l.count, l.qrBtn),
      el('div', { class: 'pr-group pr-group-end' }, l.endBtn));
    l.ending = el('div', { class: 'pr-ending', role: 'status', hidden: true, text: ENDING });
    l.wrap = el('div', { class: 'present' }, l.banner, l.ending, el('div', { class: 'pr-body' }, l.stage, l.poll), l.bar);
    root.replaceChildren(l.wrap);
    shownKey = null;
    return l;
  }

  // アンケートの状況: 状態のチップ、回答数、結果（公開中のときだけ）
  function renderPoll(p) {
    const info = POLL_STATUS[p.poll.status] || null;
    const t = state.tallies[p.id];
    const answered = t ? t.total : 0;
    const children = [
      info ? statusChip(info.kind, info.label) : null,
      el('p', { class: 'pr-answers', text: `回答 ${answered} 人 ／ 参加 ${state.participants} 人` }),
    ];
    // 非公開の質問の集計は、ここで止める（DOM に入れない）
    if (p.poll.resultsVisible === true && t) {
      const box = el('div', { class: 'pr-results' });
      const options = Array.isArray(p.slide.options) ? p.slide.options : [];
      resultBars(box, { options, counts: t.counts, total: t.total });
      children.push(box);
    }
    live.poll.replaceChildren(...children);
  }

  function updateLive() {
    const l = live;
    const before = document.activeElement;
    // 切断中と、授業を終了している途中は、操作を押せない
    const ending = endState === 'running';
    const offline = state.connection === 'disconnected';
    const off = offline || ending;
    l.banner.hidden = !offline;
    l.ending.hidden = !ending;

    const cur = (state.pub && state.pub.current) || { slideId: '', index: -1 };
    const index = Number.isInteger(cur.index) ? cur.index : -1;
    const total = state.order.length;
    const slide = index >= 0 && cur.slideId ? state.slides[cur.slideId] || null : null;

    // 中央: 参加の画面か、今のスライド
    const key = index < 0 ? 'join' : `slide:${cur.slideId}`;
    if (key !== shownKey) {
      shownKey = key;
      if (index < 0) l.stage.replaceChildren(joinContent('pr-join-title'));
      else renderSlide(l.stage, slide, state.images);
      l.stage.classList.toggle('is-join', index < 0);
    }
    l.wrap.querySelectorAll('.pr-join-count').forEach((n) => { n.textContent = participantsText(); });

    // アンケートの状況
    const p = index >= 0 ? currentPoll() : null;
    l.poll.hidden = !p;
    if (p) renderPoll(p);
    else l.poll.replaceChildren();

    // 下の帯
    l.pos.textContent = index >= 0 ? `${index + 1} / ${total}` : `開始前 / ${total}`;
    l.count.textContent = participantsText();
    setOff(l.prevBtn, off || index <= 0);
    const atLast = index >= total - 1;
    l.nextBtn.hidden = atLast;
    l.last.hidden = !atLast;
    setOff(l.nextBtn, off);

    l.pollGroup.hidden = !p;
    if (p) {
      // スライドの移動の通信待ちの間は、どのスライドへの操作か食い違うので押せない
      const status = p.poll.status;
      l.pauseBtn.textContent = status === 'paused' ? '受付を再開' : '受付を止める';
      setOff(l.pauseBtn, off || moving > 0 || pending.pause || (status !== 'open' && status !== 'paused'));
      l.resultsBtn.textContent = p.poll.resultsVisible ? '結果をかくす' : '結果を表示';
      setOff(l.resultsBtn, off || moving > 0 || pending.results || status === 'waiting');
    }
    setOff(l.endBtn, off);

    // 押していたボタンが消えたら、帯の中の押せるボタンへフォーカスを移す
    if (before instanceof HTMLElement && l.bar.contains(before) && !isShown(before)) {
      (isShown(l.nextBtn) ? l.nextBtn : l.prevBtn).focus();
    }
  }

  function isShown(node) {
    for (let n = node; n && n !== live.bar; n = n.parentElement) if (n.hidden) return false;
    return true;
  }

  function render() {
    if (!alive || !state || leaving) return;
    if (state.phase === 'loading') {
      if (!live) page(el('p', { class: 'loading', role: 'status', text: '読み込み中…' }));
      return;
    }
    if (state.phase === 'not-found') {
      page(el('h2', { text: '発表' }),
        el('p', { role: 'alert', text: 'この授業は見つかりません。' }),
        el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: 'ホームへ', onclick: () => ctx.navigate('dashboard') })));
      return;
    }
    if (state.phase === 'ended') {
      // 開いたときにもう終わっていた授業は、残りの後片づけを 1 回だけ行ってから授業履歴へ
      if (endState === 'idle') { finishEnd(); return; }
      if (endState === 'running') {
        page(el('p', { class: 'loading', role: 'status', text: ENDING }));
      } else if (endState === 'failed') {
        page(el('h2', { text: '授業を終了しました' }),
          el('p', { role: 'alert', text: '終了の処理が最後まで終わりませんでした。' }),
          el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度', onclick: finishEnd })));
      }
      return;
    }
    if (state.phase !== 'live') return;
    if (!live) live = buildLive();
    updateLive();
  }

  // キーボード: → / PageDown / スペースで次へ、← / PageUp で前へ
  function onKey(ev) {
    if (!alive || !live || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const t = ev.target instanceof Element ? ev.target : null;
    if (t && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const space = ev.key === ' ' || ev.key === 'Spacebar';
    // ボタンの上のスペースは、そのボタンを押す（次へと二重にしない）
    if (space && t && t.closest('button, a, summary, [role="button"]')) return;
    let dir = 0;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || space) dir = 1;
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') dir = -1;
    if (!dir) return;
    ev.preventDefault();
    go(dir);
  }

  document.addEventListener('keydown', onKey);
  startHost();

  return () => {
    alive = false;
    closeAllDialogs(); // 開いたままの確認（授業の終了など）は、取り消しとして閉じる
    document.removeEventListener('keydown', onKey);
    if (qrDialog) { const d = qrDialog; qrDialog = null; d.close(); }
    // 画面を離れるだけ（授業は終わらない）。次に同じ授業を開く host は、この書きこみが済むのを待つ
    host.stop();
  };
}
