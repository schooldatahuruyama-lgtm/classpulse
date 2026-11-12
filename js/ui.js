// 画面の部品。入力された文字は必ず textContent で出す（innerHTML は使わない）
const SYMBOLS = ['A', 'B', 'C', 'D', 'E', 'F'];

// el('div', { class: 'card', text: '本文', onclick: fn }, 子...)
// props.text は textContent に入れる。on で始まる関数はイベントの待ち受け。
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === 'innerHTML' || key === 'html') throw new Error('innerHTML は使えません');
    if (key === 'text') node.textContent = String(val);
    else if (key === 'class') node.className = String(val);
    else if (key === 'dataset') Object.assign(node.dataset, val);
    else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
    else if (['value', 'checked', 'disabled', 'selected'].includes(key)) node[key] = val;
    else node.setAttribute(key, val === true ? '' : String(val));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return node;
}

// 開いている確認ダイアログ（画面が切りかわったら、取り消しとして片づける）
const openDialogs = new Set();

// 確認ダイアログ。OK なら true、取り消し・Esc・外側のタップ・画面の切りかえなら false。
// 結果はボタンを押した時点で返す（<dialog> の close イベントが届くのを待たない。
// 画面が隠れているときなどに close が遅れても、結果は遅れない）。完了は 1 回だけ。
// cancelLabel: 取り消しのボタンの文。signal（AbortSignal）: 中止されたら取り消し（false）として閉じる
export function confirmDialog({ title, body, okLabel = 'OK', cancelLabel = 'やめる', danger = false, signal = null }) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(false); return; }
    const opener = document.activeElement; // 閉じたらフォーカスを戻す先
    const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' });
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      openDialogs.delete(entry);
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('click', onBackdrop);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
      if (dlg.open) dlg.close();
      dlg.remove();
      // 開いた部品がまだ画面にあれば、そこへフォーカスを戻す
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus();
      }
    };
    // Esc（ブラウザの cancel イベント）
    const onCancel = (ev) => { ev.preventDefault(); finish(false); };
    // ほかの理由で閉じられたときも、取り消しとして終える
    const onClose = () => finish(false);
    // 呼んだ側が中止した（対象が消えた・画面が替わったなど）
    const onAbort = () => finish(false);
    // 外側（背景）のタップ: ダイアログの枠の外を押したとき
    const onBackdrop = (ev) => {
      if (ev.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) finish(false);
    };

    const ok = el('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: okLabel, onclick: () => finish(true) });
    const cancel = el('button', { type: 'button', class: 'btn', text: cancelLabel, onclick: () => finish(false) });
    dlg.append(
      el('h2', { id: 'confirm-title', text: title }),
      el('p', { text: body }),
      el('div', { class: 'dialog-actions' }, cancel, ok),
    );
    const entry = { finish };
    openDialogs.add(entry);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('click', onBackdrop);
    if (signal) signal.addEventListener('abort', onAbort);
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus(); // 間違って押しても実行されない側に置く
  });
}

// 開いている確認ダイアログを、すべて取り消し（false）として閉じる
export function closeAllDialogs() {
  for (const entry of [...openDialogs]) entry.finish(false);
}

// 画面が切りかわったら（ブラウザの「戻る」も）、前の画面のダイアログを残さない
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', closeAllDialogs);
}

const CHIP_ICONS = { ok: '✓', warn: '!', danger: '■', info: 'i' };

// 状態のチップ（アイコンと文字。色だけで伝えない）
export function statusChip(kind, label) {
  const k = CHIP_ICONS[kind] ? kind : 'info';
  return el('span', { class: `chip chip-${k}` },
    el('span', { class: 'chip-icon', 'aria-hidden': 'true', text: CHIP_ICONS[k] }),
    el('span', { text: label }));
}

// 結果の棒。options は選択肢の文（文字列か { text }）、counts は件数（配列）、total は回答した人数
export function resultBars(container, { options, counts, total }) {
  const list = el('ul', { class: 'result-bars' });
  options.forEach((opt, i) => {
    const n = Number((counts && counts[i]) || 0);
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    const text = typeof opt === 'string' ? opt : opt.text;
    const mark = SYMBOLS[i] ?? String(i + 1);
    const fill = el('div', { class: 'result-fill' });
    fill.style.width = `${pct}%`;
    list.append(el('li', { class: 'result-row' },
      el('span', { class: 'result-mark', text: mark }),
      el('span', { class: 'result-label', text }),
      el('span', { class: 'result-value', text: `${n}人（${pct}%）` }),
      el('div', { class: 'result-track', role: 'img', 'aria-label': `${mark}: ${n}人、${pct}%` }, fill)));
  });
  container.replaceChildren(list, el('p', { class: 'result-note', text: `回答した ${total} 人のうちの割合` }));
}

// 短い通知（数秒で消える）
export function toast(message) {
  const host = document.getElementById('toasts') || document.body;
  const t = el('div', { class: 'toast', role: 'status', text: message });
  host.append(t);
  setTimeout(() => t.remove(), 4000);
}
