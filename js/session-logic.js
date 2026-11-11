// 授業の進行・締切・集計の規則。DOM・通信・グローバルに触れない純粋なモジュール。
// 「パッチ」は pub を基準にした「パス → 値」の表。値 null は削除。引数は書きかえない。
//
// 守る規則:
// - 次のスライドへ移ると、今の質問は締切（open / paused → closed）
// - closed の質問は二度と open に戻さない
// - waiting の質問は、先生がそのスライドに着いたときに初めて open になる
// - 結果をかくすときは、公開済みの集計（results/<slideId>）も消す

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

export function buildHistory(session, inbox, endedAt) {
  const deck = session.deck;
  const answers = (inbox && inbox.answers) || {};
  const questions = [];
  for (const slideId of toArray(deck.order)) {
    const slide = (deck.slides || {})[slideId];
    if (!slide || slide.type !== 'poll') continue;
    const options = toArray(slide.options);
    const { counts, total } = tally(answers[slideId], options.length);
    questions.push({ slideId, question: slide.question || '', options: [...options], counts, total });
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
