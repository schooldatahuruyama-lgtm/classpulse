// 授業の進行・締切・集計の規則。DOM・通信・グローバルに触れない純粋なモジュール。
// 「パッチ」は pub を基準にした「パス → 値」の表。値 null は削除。引数は書きかえない。
//
// 守る規則:
// - 次のスライドへ移ると、今の質問は締切（open / paused → closed）
// - closed の質問は二度と open に戻さない
// - waiting の質問は、先生がそのスライドに着いたときに初めて open になる
// - 結果をかくすときは、公開済みの集計（results/<slideId>）も消す

import { CONFIG } from './config.js';

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  }
  return [];
}

export function buildSession(deck, deckId, ownerUid, startedAt) {
  const polls = {};
  for (const id of deck.order) {
    const s = deck.slides[id];
    if (s && s.type === 'poll') {
      polls[id] = { status: 'waiting', resultsVisible: s.resultMode === 'live' };
    } else if (s && (s.type === 'free' || s.type === 'cloud')) {
      // 自由記述・ワードクラウドは「結果を表示」を押すまで回答を映さない
      polls[id] = { status: 'waiting', resultsVisible: false };
    }
  }
  return {
    owner: ownerUid,
    deckId,
    startedAt,
    pub: {
      title: deck.title,
      state: 'live',
      current: { slideId: '', index: -1 },
      polls,
    },
    deck: {
      order: [...deck.order],
      slides: JSON.parse(JSON.stringify(deck.slides)),
      images: { ...(deck.images || {}) },
    },
  };
}

export function goToPatch(pub, order, targetIndex) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= order.length) return null;
  const cur = pub.current || { slideId: '', index: -1 };
  if (targetIndex === cur.index) return null;
  const patch = {};
  const polls = pub.polls || {};
  // 今のスライドの質問は、受付中・停止中なら締め切る
  const from = polls[cur.slideId];
  if (from && (from.status === 'open' || from.status === 'paused')) {
    patch[`polls/${cur.slideId}/status`] = 'closed';
  }
  const targetId = order[targetIndex];
  const to = polls[targetId];
  // 行き先の質問は、待機中のときだけ受付を始める（締切済みは開けない）
  if (to && to.status === 'waiting') patch[`polls/${targetId}/status`] = 'open';
  patch.current = { slideId: targetId, index: targetIndex };
  return patch;
}

export function nextPatch(pub, order) {
  return goToPatch(pub, order, pub.current.index + 1);
}

export function prevPatch(pub, order) {
  // 参加の画面（index -1）からは戻らない
  if (pub.current.index < 0) return null;
  return goToPatch(pub, order, pub.current.index - 1);
}

export function pausePatch(pub, slideId, paused) {
  const poll = (pub.polls || {})[slideId];
  if (!poll) return null;
  if (paused && poll.status === 'open') return { [`polls/${slideId}/status`]: 'paused' };
  if (!paused && poll.status === 'paused') return { [`polls/${slideId}/status`]: 'open' };
  return null;
}

export function resultsVisiblePatch(pub, slideId, visible) {
  const poll = (pub.polls || {})[slideId];
  if (!poll || poll.status === 'waiting') return null;
  const patch = { [`polls/${slideId}/resultsVisible`]: !!visible };
  if (!visible) patch[`results/${slideId}`] = null;
  return patch;
}

export function tally(answers, optionCount) {
  const counts = new Array(optionCount).fill(0);
  let total = 0;
  for (const a of Object.values(answers || {})) {
    const c = a && a.choice;
    if (Number.isInteger(c) && c >= 0 && c < optionCount) {
      counts[c] += 1;
      total += 1;
    }
  }
  return { counts, total };
}

export function percent(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function applyPatch(pub, patch) {
  const next = structuredClone(pub);
  for (const [path, value] of Object.entries(patch || {})) {
    const keys = path.split('/').filter((k) => k !== '');
    if (!keys.length || keys.some((k) => UNSAFE_KEYS.has(k))) continue;
    const v = value === null ? null : structuredClone(value);
    let node = next;
    let ok = true;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (node[k] === null || typeof node[k] !== 'object') {
        if (v === null) { ok = false; break; } // 無いものを消すだけなら何もしない
        node[k] = {};
      }
      node = node[k];
    }
    if (!ok) continue;
    const last = keys[keys.length - 1];
    if (v === null) delete node[last];
    else node[last] = v;
  }
  return next;
}

function openPollIds(pub) {
  return Object.keys(pub.polls || {}).filter((id) => pub.polls[id].status !== 'closed');
}

export function closeAllPatch(pub) {
  const ids = openPollIds(pub);
  if (!ids.length) return null;
  const patch = {};
  for (const id of ids) patch[`polls/${id}/status`] = 'closed';
  return patch;
}

export function endPatch(pub) {
  const patch = { state: 'ended', results: null };
  for (const id of openPollIds(pub)) patch[`polls/${id}/status`] = 'closed';
  return patch;
}

// 自由記述の回答の文。前後の空白を取り、文字列でない・空・上限をこえるなら null
export function normalizeText(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t === '' || t.length > CONFIG.free.maxLength) return null;
  return t;
}

// 自由記述の回答の一覧。answers は inbox.answers[slideId]、hidden は { <uid>: true }。
// 不正な text の回答は数えない。並びは at の古い順、同じなら uid の順
export function freeList(answers, hidden) {
  const hid = hidden && typeof hidden === 'object' ? hidden : {};
  const rows = [];
  for (const [uid, a] of Object.entries(answers || {})) {
    const text = normalizeText(a && a.text);
    if (text === null) continue;
    const at = a && typeof a.at === 'number' ? a.at : 0;
    rows.push({ uid, text, at });
  }
  rows.sort((x, y) => (x.at - y.at) || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
  const items = [];
  const hiddenItems = [];
  for (const { uid, text } of rows) {
    (hid[uid] === true ? hiddenItems : items).push({ uid, text });
  }
  return { items, hiddenItems, total: rows.length };
}

// ---- ワードクラウド ----

// 対になっていないサロゲート（データベースに書けず、encodeURIComponent が例外を投げる）
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

// 言葉の鍵（同じ言葉かどうかを決める値）。NFKC で全角・半角をそろえ、つづく空白を 1 つにし、小文字にする
export function wordKey(word) {
  return String(word).replace(LONE_SURROGATES, '�').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

// 言葉の鍵を、データベースの鍵に使える形にする（. $ # [ ] / と制御文字を含まない）
function encodeKey(k) {
  return encodeURIComponent(k).replace(/\./g, '%2E');
}

// host/hidden/<slideId>/ の下に使う鍵。言葉の鍵が同じなら同じ
export function hiddenKey(word) {
  return encodeKey(wordKey(word));
}

// 配列、またはデータベースの形（{ 0: …, 1: … }）から、添字の順に並べた要素。どちらでもなければ null
function indexedList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.keys(raw)
      .filter((k) => /^(0|[1-9]\d*)$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => raw[k]);
  }
  return null;
}

// 送る言葉の配列（1〜maxWords 個）。各要素は前後の空白を取り、文字列でない・空・maxLength をこえるものは捨てる。
// 言葉の鍵が同じものは先のものを残す。maxWords 個をこえる分は捨てる。1 つも残らなければ null
export function normalizeWords(raw) {
  const list = indexedList(raw);
  if (!list) return null;
  const out = [];
  const seen = new Set();
  for (const w of list) {
    if (out.length >= CONFIG.cloud.maxWords) break;
    if (typeof w !== 'string') continue;
    const t = w.trim();
    if (t === '' || t.length > CONFIG.cloud.maxLength || LONE_SURROGATE.test(t)) continue;
    const k = wordKey(t);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out : null;
}

// 言葉の配列どうしが、中身も並びも同じか
export function sameWords(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((w, i) => w === b[i]);
}

// ワードクラウドの一覧。answers は inbox.answers[slideId]、hidden は { <hiddenKey>: true }。
// 言葉ごとに { key（hiddenKey）, word（いちばん多く書かれた形。同じ数なら先に届いた形）, count（書いた人数） }。
// 並びは count の多い順、同じなら key の順。total は正しい言葉を 1 つ以上送った人数（かくした言葉も含む）
export function cloudList(answers, hidden) {
  const hid = hidden && typeof hidden === 'object' ? hidden : {};
  const rows = [];
  for (const [uid, a] of Object.entries(answers || {})) {
    const words = normalizeWords(a && a.words);
    if (words === null) continue;
    const at = typeof a.at === 'number' ? a.at : 0;
    rows.push({ uid, words, at });
  }
  // 届いた順（at の古い順、同じなら uid の順）
  rows.sort((x, y) => (x.at - y.at) || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
  const groups = new Map(); // 言葉の鍵 → { count, forms: Map(形 → 人数)（届いた順） }
  for (const { words } of rows) {
    for (const w of words) { // normalizeWords が 1 人の中の同じ鍵を 1 つにしてある
      const k = wordKey(w);
      let g = groups.get(k);
      if (!g) { g = { count: 0, forms: new Map() }; groups.set(k, g); }
      g.count += 1;
      g.forms.set(w, (g.forms.get(w) || 0) + 1);
    }
  }
  const all = [];
  for (const [k, g] of groups) {
    let word = '';
    let best = 0;
    for (const [w, n] of g.forms) if (n > best) { word = w; best = n; }
    all.push({ key: encodeKey(k), word, count: g.count });
  }
  all.sort((x, y) => (y.count - x.count) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const items = [];
  const hiddenItems = [];
  for (const it of all) (hid[it.key] === true ? hiddenItems : items).push(it);
  return { items, hiddenItems, total: rows.length };
}

// hidden は { <slideId>: { <uid か hiddenKey>: true } }（省略可）。履歴には uid も鍵も入れない
export function buildHistory(session, inbox, endedAt, hidden) {
  const deck = session.deck;
  const answers = (inbox && inbox.answers) || {};
  const questions = [];
  for (const slideId of toArray(deck.order)) {
    const slide = (deck.slides || {})[slideId];
    if (!slide) continue;
    if (slide.type === 'free') {
      const { items, hiddenItems, total } = freeList(answers[slideId], (hidden || {})[slideId]);
      questions.push({
        slideId,
        type: 'free',
        question: slide.question || '',
        texts: items.map((x) => x.text),
        hiddenTexts: hiddenItems.map((x) => x.text),
        total,
      });
      continue;
    }
    if (slide.type === 'cloud') {
      const { items, hiddenItems, total } = cloudList(answers[slideId], (hidden || {})[slideId]);
      const plain = (x) => ({ word: x.word, count: x.count });
      questions.push({
        slideId,
        type: 'cloud',
        question: slide.question || '',
        words: items.map(plain),
        hiddenWords: hiddenItems.map(plain),
        total,
      });
      continue;
    }
    if (slide.type !== 'poll') continue;
    const options = toArray(slide.options);
    const { counts, total } = tally(answers[slideId], options.length);
    questions.push({ slideId, type: 'poll', question: slide.question || '', options: [...options], counts, total });
  }
  return {
    title: session.pub.title,
    deckId: session.deckId,
    startedAt: session.startedAt,
    endedAt,
    participants: Object.keys((inbox && inbox.participants) || {}).length,
    questions,
  };
}
