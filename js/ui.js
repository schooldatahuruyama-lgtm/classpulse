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

// 確認ダイアログ。OK なら true、取り消し・Esc・画面の切りかえなら false
export function confirmDialog({ title, body, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' });
    let result = false;
    let done = false;
    const ok = el('button', { type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: okLabel, onclick: () => { result = true; dlg.close(); } });
    const cancel = el('button', { type: 'button', class: 'btn', text: 'やめる', onclick: () => dlg.close() });
    dlg.append(
      el('h2', { id: 'confirm-title', text: title }),
      el('p', { text: body }),
      el('div', { class: 'dialog-actions' }, cancel, ok),
    );
    // 1 回だけ完了させる（閉じた・片づけたの どちらからでも）
    const finish = (value) => {
      if (done) return;
      done = true;
      openDialogs.delete(entry);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    const onClose = () => finish(result);
    const entry = { finish };
    openDialogs.add(entry);
    dlg.addEventListener('close', onClose);
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
