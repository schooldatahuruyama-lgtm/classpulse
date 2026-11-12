// 発表の画面（#/present/<sid>）。先生の iPad の画面がそのまま生徒に映る。
// このため、ナビゲーション・メールアドレス・生徒の ID・非公開の集計は画面に出さない。
// 結果を非公開にしている質問は「回答 N 人 ／ 参加 M 人」だけを出し、件数の内訳は DOM に入れない。
// 自由記述は、結果を表示する前は文章の要素を 1 つも作らない（かくすのではなく、作らない）。
// 生徒の uid は DOM（属性・id・dataset も）に入れず、カードとの対応は JavaScript の Map だけで持つ。
// 文章は textContent でだけ入れる。
// ワードクラウドも同じ: 結果を表示する前は言葉の要素を 1 つも作らない。言葉は textContent で入れ、
// かくすための鍵は JavaScript の Map とクロージャの中だけで持つ（属性には入れない）。
// クイズは「正解を表示」の前は、正解の印も選択肢ごとの人数も DOM に作らない（「回答 n 人 ／ 参加 m 人」だけ）。
// 正解を表示すると、その質問は締め切られる（受付の停止・再開のボタンは出さない）。
import {
  el, confirmDialog, closeAllDialogs, statusChip, resultBars, toast,
  ratingAverageText, correctRateText, ratingBarLabels,
} from '../ui.js';
import { renderSlide } from '../slide-render.js';
import { createSessionHost } from '../session-host.js';
import { isChoiceSlide, ratingOptions } from '../model.js';

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

// ---- 受付・結果のボタンの決めごと（純粋な関数。テストあり） ----
// kind はスライドの種類、status は受付の状態、resultsVisible は結果（クイズは正解）を表示しているか。
// pauseHidden: 受付の停止・再開のボタンを出さないか（クイズは締め切ったあと＝正解を表示したあと）。
// pauseBlocked・resultsBlocked: 受付の状態のために押せないか（通信待ちなどは画面の側で足す）
export function pollControls({ kind, status, resultsVisible }) {
  const quiz = kind === 'quiz';
  return {
    pauseLabel: status === 'paused' ? '受付を再開' : '受付を止める',
    pauseHidden: quiz && (status === 'closed' || !!resultsVisible),
    pauseBlocked: status !== 'open' && status !== 'paused',
    resultsLabel: quiz
      ? (resultsVisible ? '正解をかくす' : '正解を表示')
      : (resultsVisible ? '結果をかくす' : '結果を表示'),
    resultsBlocked: status === 'waiting',
  };
}

// クイズの結果の下に出す文。正解が分かれば正答率、分からなければ（正解を読みこめなかった）その旨
export function quizSummaryText(correct, rate) {
  if (!Number.isInteger(correct)) return '正解のデータを読みこめませんでした';
  return correctRateText(rate);
}

// ---- ワードクラウドの見た目の決めごと（純粋な関数。テストあり） ----
// 文字の大きさ（発表の画面の置き場所の幅に対する %、cqw）。いちばん小さくても CSS で 28px より小さくしない
export const CLOUD_FONT = { min: 3.6, max: 10, same: 5.5 };

// 人数から文字の大きさを決める。minCount・maxCount は、出している言葉の中の最小と最大の人数。
// 全員が同じ人数なら同じ大きさ（same）、最大の人数は max、最小の人数は min。間は人数の平方根で（差が大きすぎないように）
export function cloudFontSize(count, minCount, maxCount) {
  const { min, max, same } = CLOUD_FONT;
  const lo = Math.max(Number(minCount), 0);
  const hi = Number(maxCount);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return same;
  const c = Math.min(Math.max(Number(count) || 0, lo), hi);
  const t = (Math.sqrt(c) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo));
  return Math.round((min + t * (max - min)) * 10) / 10;
}

// 文字列から決まる 32 ビットの数（FNV-1a）。並びと色を言葉から決めるのに使う
function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 雲の並び: 言葉の鍵から決まる順（人数の順ではないので、大きい言葉が 1 か所に固まらない。
// 渡された順に左右されず、表示のたびに変わらない）。元の配列は変えない
export function cloudOrder(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({ it, h: hash32(it.key) }))
    .sort((a, b) => (a.h - b.h) || (a.it.key < b.it.key ? -1 : a.it.key > b.it.key ? 1 : 0))
    .map((x) => x.it);
}

// 言葉の色（0〜3。css/present.css の .is-t0〜.is-t3。どれも白い地との明るさの差が足りる色）
export const CLOUD_TONES = 4;
export function cloudTone(key) {
  return hash32(`tone:${key}`) % CLOUD_TONES;
}

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
  let shownKey = null; // 中央に出しているもの（'join'、'slide:<id>'、自由記述の一覧は 'board:<id>'）
  let board = null; // 自由記述の回答の一覧（結果の表示中だけ作る。スライドが変わったら作り直す）
  let cloud = null; // ワードクラウドの雲（結果の表示中だけ作る。スライドが変わったら作り直す）
  let qrDialog = null;
  const pending = { pause: false, results: false };
  let moving = 0; // 通信待ちのスライド移動の数（その間は受付・結果の操作を押せない）
  // 授業の終了: 'idle'（まだ）、'running'（後片づけの途中）、'failed'（終了したが後片づけが残った）、'done'（済んだ）
  let endState = 'idle';

  const host = createSessionHost({
    net: ctx.net,
    repo: ctx.repo,
    sid,
    storage: ctx.storage, // かくした回答の記録を端末にも残す（保存前に読み直しても映らないように）
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

  // 一覧・雲を捨てる。雲の言葉の確認を開いていたら、取り消しとして閉じる（古い言葉に対して操作しない）
  function dropBoards() {
    if (cloud && cloud.ask) cloud.ask.abort();
    cloud = null;
    board = null;
  }

  function page(...children) {
    live = null;
    shownKey = null;
    dropBoards();
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
    // アンケート・クイズ・5 段階評価・自由記述・ワードクラウド（受付の停止・再開と結果の表示は同じ操作）
    if (!slide || (!isChoiceSlide(slide) && slide.type !== 'free' && slide.type !== 'cloud')) return null;
    const poll = (state.pub.polls || {})[id];
    return poll ? { id, slide, poll } : null;
  }

  function togglePause() {
    const p = currentPoll();
    if (!p || isOff(live.pauseBtn) || live.pauseBtn.hidden) return;
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
    l.poll = el('aside', { class: 'pr-poll', 'aria-label': 'アンケートの状況', 'aria-live': 'polite', hidden: true });
    l.prevBtn = btn('pr-prev', '← 前へ', () => go(-1));
    l.prevBtn.setAttribute('aria-label', '前へ'); // 矢印の記号は読み上げない
    l.pos = el('span', { class: 'pr-pos' });
    l.nextBtn = btn('btn-primary pr-next', '次へ →', () => go(1));
    l.nextBtn.setAttribute('aria-label', '次へ');
    l.last = el('span', { class: 'pr-last', hidden: true, text: '最後のスライドです' });
    l.pauseBtn = btn('pr-pause', '受付を止める', togglePause);
    l.resultsBtn = btn('pr-results-btn', '結果を表示', toggleResults);
    l.pollGroup = el('div', { class: 'pr-group pr-group-poll', hidden: true }, l.pauseBtn, l.resultsBtn);
    l.count = el('span', { class: 'pr-count', 'aria-live': 'polite' });
    l.qrBtn = btn('pr-qr-btn', 'QR コード', openQr);
    l.endBtn = btn('btn-danger pr-end', '授業を終了', endClass);
    l.bar = el('div', { class: 'pr-bar', role: 'toolbar', 'aria-label': '発表の操作' },
      el('div', { class: 'pr-group pr-group-nav' }, l.prevBtn, l.pos, l.nextBtn, l.last),
      l.pollGroup,
      el('div', { class: 'pr-group pr-group-side' }, l.count, l.qrBtn),
      el('div', { class: 'pr-group pr-group-end' }, l.endBtn));
    l.ending = el('div', { class: 'pr-ending', role: 'status', hidden: true, text: ENDING });
    l.hiddenWarn = el('div', { class: 'pr-offline pr-hidden-unsaved', role: 'alert', hidden: true, text: 'かくした回答を保存できていません' });
    l.wrap = el('div', { class: 'present' }, l.banner, l.hiddenWarn, l.ending, el('div', { class: 'pr-body' }, l.stage, l.poll), l.bar);
    root.replaceChildren(l.wrap);
    shownKey = null;
    dropBoards();
    return l;
  }

  // ---- 自由記述の回答の一覧（結果の表示中だけ） ----
  // uid は、この中の Map のキーと、クロージャの中だけで持つ（DOM には入れない）
  function buildBoard(slideId, slide) {
    const b = { slideId, cards: new Map(), zoomUid: null };
    b.list = el('ul', { class: 'pr-free-list', 'aria-label': '回答の一覧' });
    b.empty = el('p', { class: 'pr-free-empty', hidden: true, text: 'まだ回答はありません。' });
    b.zoomText = el('span', { class: 'pr-free-zoom-text' });
    // 大きい表示: 文をもう一度タップするか「一覧にもどる」で戻る
    b.zoomBody = el('button', { type: 'button', class: 'pr-free-zoom-body', onclick: () => closeZoom(b) }, b.zoomText);
    b.zoomBack = el('button', { type: 'button', class: 'btn btn-primary pr-free-back', text: '一覧にもどる', onclick: () => closeZoom(b) });
    b.zoom = el('div', { class: 'pr-free-zoom', role: 'group', 'aria-label': '大きく表示した回答', hidden: true }, b.zoomBody, b.zoomBack);
    b.root = el('div', { class: 'pr-free-board' },
      el('h2', { class: 'pr-free-question', text: typeof slide.question === 'string' ? slide.question : '' }),
      b.empty, b.list, b.zoom);
    return b;
  }

  function freeCard(b, uid, text) {
    const c = { text };
    c.textEl = el('span', { class: 'pr-free-text', text });
    // カードの本体（大きく表示）と「かくす」は別のボタン（入れ子にしない）。押す場所がぶつからない
    c.open = el('button', { type: 'button', class: 'pr-free-open', onclick: () => openZoom(b, uid) }, c.textEl);
    c.hideBtn = el('button', { type: 'button', class: 'btn pr-free-hide', text: 'かくす', onclick: () => askHide(b, uid) });
    c.li = el('li', { class: 'pr-free-card' }, c.open, c.hideBtn);
    return c;
  }

  // 一覧を items（[{ uid, text }]、host が並べた順）に合わせる。カードは作り直さず、増減と文の書きかえだけ
  function updateBoard(b, items) {
    const before = document.activeElement;
    let lostAt = -1; // フォーカスのあったカードが消えたら、その位置
    const seen = new Set();
    items.forEach((it, i) => {
      seen.add(it.uid);
      let c = b.cards.get(it.uid);
      if (!c) {
        c = freeCard(b, it.uid, it.text);
        b.cards.set(it.uid, c);
      } else if (c.text !== it.text) {
        c.text = it.text;
        c.textEl.textContent = it.text;
      }
      const at = b.list.children[i];
      if (at !== c.li) b.list.insertBefore(c.li, at || null);
    });
    for (const [uid, c] of b.cards) {
      if (seen.has(uid)) continue;
      if (before instanceof Node && c.li.contains(before)) lostAt = Array.prototype.indexOf.call(b.list.children, c.li);
      c.li.remove();
      b.cards.delete(uid);
    }
    b.empty.hidden = items.length > 0;

    // 大きく表示している回答: 書き直されたら文を更新、かくされた（一覧に無い）なら一覧に戻る
    if (b.zoomUid !== null) {
      const c = b.cards.get(b.zoomUid);
      if (!c) closeZoom(b);
      else if (b.zoomText.textContent !== c.text) b.zoomText.textContent = c.text;
    }

    // 並べかえで外れたフォーカスを戻す。消えたカードにあったら、近くのカード（無ければ結果のボタン）へ
    if (lostAt >= 0) {
      const next = b.list.children[Math.min(lostAt, b.list.children.length - 1)];
      const btn = next ? next.querySelector('.pr-free-open') : null;
      if (btn) btn.focus();
      else if (live) live.resultsBtn.focus();
    } else if (before instanceof HTMLElement && before !== document.activeElement && before.isConnected && !b.zoom.contains(before)) {
      before.focus();
    }
  }

  function openZoom(b, uid) {
    const c = b.cards.get(uid);
    if (!alive || board !== b || !c) return;
    b.zoomUid = uid;
    b.zoomText.textContent = c.text;
    b.zoom.hidden = false;
    b.list.inert = true; // 下の一覧にキーボードで行かない
    b.zoomBack.focus();
  }

  function closeZoom(b) {
    if (b.zoomUid === null) return;
    const c = b.cards.get(b.zoomUid);
    const hadFocus = b.zoom.contains(document.activeElement);
    b.zoomUid = null;
    b.zoom.hidden = true;
    b.zoomText.textContent = '';
    b.list.inert = false;
    if (!hadFocus || !alive || board !== b) return;
    // 見ていたカードへフォーカスを戻す（かくされていたら、最初のカードか結果のボタンへ）
    const first = b.list.querySelector('.pr-free-open');
    if (c) c.open.focus();
    else if (first) first.focus();
    else if (live) live.resultsBtn.focus();
  }

  async function askHide(b, uid) {
    if (!alive || board !== b || endState !== 'idle' || !b.cards.has(uid)) return;
    const ok = await confirmDialog({
      title: 'この回答をかくしますか？',
      body: '授業中は元にもどせません。',
      okLabel: 'かくす',
      danger: true,
    });
    if (!ok || !alive || endState !== 'idle') return;
    // 一覧からはすぐに消える。保存は host が裏で行う（失敗したら再試行し、その間は帯で知らせる）。
    // 画面を閉じた・授業が終わったなどで拒否されることがあるので、必ず受け止める
    host.hide(b.slideId, uid).catch(() => { if (alive && endState === 'idle') toast('回答をかくせませんでした。'); });
  }

  // ---- ワードクラウドの雲（結果の表示中だけ） ----
  // 言葉の鍵（hiddenKey）は、この中の Map のキーと、クロージャの中だけで持つ（DOM には入れない）
  function buildCloud(slideId, slide) {
    const c = { slideId, words: new Map(), ask: null };
    c.list = el('ul', { class: 'pr-cloud-list', 'aria-label': '言葉の一覧' });
    c.empty = el('p', { class: 'pr-free-empty', hidden: true, text: 'まだ回答はありません。' });
    c.more = el('p', { class: 'pr-cloud-more muted', hidden: true });
    c.root = el('div', { class: 'pr-free-board pr-cloud-board' },
      el('h2', { class: 'pr-free-question', text: typeof slide.question === 'string' ? slide.question : '' }),
      c.empty,
      el('div', { class: 'pr-cloud-scroll' }, c.list),
      c.more);
    return c;
  }

  function cloudWord(c, key) {
    const w = { word: null, count: 0, size: null, label: null };
    w.btn = el('button', { type: 'button', class: `pr-cloud-word is-t${cloudTone(key)}`, onclick: () => askHideWord(c, key) });
    w.li = el('li', { class: 'pr-cloud-item' }, w.btn);
    return w;
  }

  // 雲を items（[{ key, word, count }]）に合わせる。言葉の要素は作り直さず、増減・文字・大きさの書きかえと並べかえだけ
  function updateCloud(c, items, more) {
    const before = document.activeElement;
    let lostAt = -1;
    const counts = items.map((it) => it.count);
    const lo = counts.length ? Math.min(...counts) : 0;
    const hi = counts.length ? Math.max(...counts) : 0;
    const seen = new Set();
    cloudOrder(items).forEach((it, i) => {
      seen.add(it.key);
      let w = c.words.get(it.key);
      if (!w) {
        w = cloudWord(c, it.key);
        c.words.set(it.key, w);
      }
      if (w.word !== it.word) { w.word = it.word; w.btn.textContent = it.word; }
      w.count = it.count;
      const size = String(cloudFontSize(it.count, lo, hi));
      if (w.size !== size) { w.size = size; w.btn.style.setProperty('--cw', size); }
      const label = `${it.word}、${it.count} 人`;
      if (w.label !== label) { w.label = label; w.btn.setAttribute('aria-label', label); }
      const at = c.list.children[i];
      if (at !== w.li) c.list.insertBefore(w.li, at || null);
    });
    for (const [key, w] of c.words) {
      if (seen.has(key)) continue;
      // フォーカスのあった言葉か、確認を開いている言葉（閉じるとフォーカスの戻り先が無い）が消えたら、その位置
      const askedHere = c.ask && c.ask.key === key;
      if (askedHere || (before instanceof Node && w.li.contains(before))) lostAt = Array.prototype.indexOf.call(c.list.children, w.li);
      w.li.remove();
      c.words.delete(key);
    }
    // 確認を開いている言葉が雲から消えたら（かくした・60 語から外れたなど）、確認を閉じる
    if (c.ask && !c.words.has(c.ask.key)) c.ask.abort();
    c.empty.hidden = items.length > 0;
    const n = Number.isInteger(more) && more > 0 ? more : 0;
    c.more.hidden = n === 0;
    const moreText = n ? `ほか ${n} 語` : '';
    if (c.more.textContent !== moreText) c.more.textContent = moreText;

    // 消えた言葉にフォーカスがあったら、近くの言葉（無ければ結果のボタン）へ。並べかえで外れたら戻す
    if (lostAt >= 0) {
      const next = c.list.children[Math.min(lostAt, c.list.children.length - 1)];
      const btn = next ? next.querySelector('.pr-cloud-word') : null;
      if (btn) btn.focus();
      else if (live) live.resultsBtn.focus();
    } else if (before instanceof HTMLElement && before !== document.activeElement && before.isConnected) {
      before.focus();
    }
  }

  // 言葉をタップ: 「『〇〇』 3 人」と「かくす」「とじる」。かくすのは言葉の鍵（確認の間に人数が変わっても同じ言葉）
  async function askHideWord(c, key) {
    const w = c.words.get(key);
    if (!alive || cloud !== c || endState !== 'idle' || !w || c.ask) return;
    const ctrl = new AbortController();
    const ask = { key, abort: () => ctrl.abort() };
    c.ask = ask;
    let ok = false;
    try {
      ok = await confirmDialog({
        title: `『${w.word}』 ${w.count} 人`,
        body: 'かくすと、授業中は元にもどせません。',
        okLabel: 'かくす',
        cancelLabel: 'とじる',
        danger: true,
        signal: ctrl.signal,
      });
    } finally {
      if (c.ask === ask) c.ask = null;
    }
    // 確認の間に、スライドが変わった・結果をかくした・画面を離れた・言葉が消えたなら何もしない
    if (!ok || !alive || cloud !== c || endState !== 'idle' || !c.words.has(key)) return;
    // 雲からはすぐに消える。保存は host が裏で行う。拒否されることがあるので、必ず受け止める
    host.hide(c.slideId, key).catch(() => { if (alive && endState === 'idle') toast('言葉をかくせませんでした。'); });
  }

  // アンケートの状況: 状態のチップ、回答数、結果（公開中のときだけ）
  function renderPoll(p) {
    const info = POLL_STATUS[p.poll.status] || null;
    if (p.slide.type === 'free' || p.slide.type === 'cloud') {
      // 自由記述・ワードクラウド: 状態と件数だけ（文章・言葉は中央に、表示中だけ出す）
      const n = Number.isInteger(state.answerCount) ? state.answerCount : 0;
      const unit = p.slide.type === 'free' ? '件' : '人';
      live.poll.replaceChildren(
        info ? statusChip(info.kind, info.label) : '',
        el('p', { class: 'pr-answers', text: `回答 ${n} ${unit} ／ 参加 ${state.participants} 人` }));
      return;
    }
    const t = state.tallies[p.id];
    const answered = t ? t.total : 0;
    const children = [
      info ? statusChip(info.kind, info.label) : null,
      el('p', { class: 'pr-answers', text: `回答 ${answered} 人 ／ 参加 ${state.participants} 人` }),
    ];
    // 非公開の質問の集計は、ここで止める（DOM に入れない）。
    // クイズは表示前の集計に counts が無い（host が人数だけ渡す）。counts が無ければ棒を作らない
    if (p.poll.resultsVisible === true && t && Array.isArray(t.counts)) {
      const box = el('div', { class: 'pr-results' });
      if (p.slide.type === 'rating') {
        // 5 段階評価: 1〜5 の棒（両はしの行に言葉）と平均
        const marks = ratingOptions();
        resultBars(box, { options: ratingBarLabels(p.slide.lowLabel, p.slide.highLabel, marks.length), marks, counts: t.counts, total: t.total });
        box.append(el('p', { class: 'pr-summary', text: ratingAverageText(state.average, t.total) }));
      } else if (p.slide.type === 'quiz') {
        // クイズ: 選択肢ごとの人数・正解の印・正答率（正解を読みこめなかったときは印を付けず、その旨を出す）
        const options = Array.isArray(p.slide.options) ? p.slide.options : [];
        const correct = Number.isInteger(state.correct) ? state.correct : null;
        resultBars(box, { options, counts: t.counts, total: t.total, correct });
        box.append(el('p', { class: 'pr-summary', text: quizSummaryText(correct, state.correctRate) }));
      } else {
        const options = Array.isArray(p.slide.options) ? p.slide.options : [];
        resultBars(box, { options, counts: t.counts, total: t.total });
      }
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
    l.hiddenWarn.hidden = state.hiddenUnsaved !== true;

    const cur = (state.pub && state.pub.current) || { slideId: '', index: -1 };
    const index = Number.isInteger(cur.index) ? cur.index : -1;
    const total = state.order.length;
    const slide = index >= 0 && cur.slideId ? state.slides[cur.slideId] || null : null;

    // 中央: 参加の画面か、今のスライド。自由記述の結果を表示中なら回答の一覧、ワードクラウドなら雲
    // （freeItems・cloudItems が null の間は作らない。スライドが変わる・結果をかくすと、一覧・雲・確認も捨てる）
    const showBoard = index >= 0 && !!slide && slide.type === 'free' && Array.isArray(state.freeItems);
    const showCloud = index >= 0 && !!slide && slide.type === 'cloud' && Array.isArray(state.cloudItems);
    // クイズの正解の印は、正解を表示している間だけ中央のスライドにも付ける（state.correct は表示中だけ届く）
    const pollNow = index >= 0 ? currentPoll() : null;
    const shownCorrect = !!slide && slide.type === 'quiz' && pollNow && pollNow.poll.resultsVisible === true
      && Number.isInteger(state.correct) ? state.correct : null;
    const key = index < 0 ? 'join' : `${showBoard ? 'board' : showCloud ? 'cloud' : 'slide'}:${cur.slideId}${shownCorrect !== null ? `:correct:${shownCorrect}` : ''}`;
    if (key !== shownKey) {
      shownKey = key;
      dropBoards();
      if (index < 0) l.stage.replaceChildren(joinContent('pr-join-title'));
      else if (showBoard) {
        board = buildBoard(cur.slideId, slide);
        l.stage.replaceChildren(board.root);
      } else if (showCloud) {
        cloud = buildCloud(cur.slideId, slide);
        l.stage.replaceChildren(cloud.root);
      } else renderSlide(l.stage, slide, state.images, { sample: false, correct: shownCorrect });
      l.stage.classList.toggle('is-join', index < 0);
      l.stage.classList.toggle('is-board', showBoard || showCloud);
    }
    if (board) updateBoard(board, state.freeItems);
    if (cloud) updateCloud(cloud, state.cloudItems, state.cloudMore);
    l.wrap.querySelectorAll('.pr-join-count').forEach((n) => { n.textContent = participantsText(); });

    // アンケートの状況
    const p = pollNow;
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
      const c = pollControls({ kind: p.slide.type, status: p.poll.status, resultsVisible: p.poll.resultsVisible });
      if (l.pauseBtn.textContent !== c.pauseLabel) l.pauseBtn.textContent = c.pauseLabel;
      l.pauseBtn.hidden = c.pauseHidden;
      setOff(l.pauseBtn, off || moving > 0 || pending.pause || c.pauseBlocked);
      if (l.resultsBtn.textContent !== c.resultsLabel) l.resultsBtn.textContent = c.resultsLabel;
      setOff(l.resultsBtn, off || moving > 0 || pending.results || c.resultsBlocked);
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
    // Esc: 大きく表示している回答を閉じて一覧に戻る
    if (ev.key === 'Escape' && board && board.zoomUid !== null) {
      ev.preventDefault();
      closeZoom(board);
      return;
    }
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
    dropBoards();
    closeAllDialogs(); // 開いたままの確認（授業の終了など）は、取り消しとして閉じる
    document.removeEventListener('keydown', onKey);
    if (qrDialog) { const d = qrDialog; qrDialog = null; d.close(); }
    // 画面を離れるだけ（授業は終わらない）。次に同じ授業を開く host は、この書きこみが済むのを待つ
    host.stop();
  };
}
