// 承認待ち・利用停止中の画面（先生用のメニューは付けない）
import { el } from '../ui.js';
import { isStillUser } from '../guard.js';

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const user = ctx.auth.user;
  const current = () => alive && isStillUser(ctx.auth, user.uid);
  const box = el('div', { class: 'card pending-card' });
  const message = el('div', { class: 'error', role: 'alert', hidden: true });
  const setBusy = (v) => {
    busy = v;
    box.querySelectorAll('button').forEach((b) => { b.disabled = v; });
  };
  const button = (text, action) => el('button', {
    type: 'button', class: 'btn', text, disabled: busy,
    onclick: () => { if (!busy && current()) action(); },
  });
  const retry = () => button('もう一度確かめる', () => ctx.navigate('dashboard'));
  const logout = () => button('ログアウト', () => { ctx.auth.signOut(); ctx.navigate('login'); });

  function render(request, failed = false) {
    let text;
    let actions;
    if (ctx.status === 'suspended') {
      text = 'このアカウントは、利用を停止されています。管理者の先生に確かめてください。';
      actions = [logout()];
    } else if (failed) {
      text = '通信できませんでした。';
      actions = [retry(), logout()];
    } else if (request) {
      text = `${request.email || user.email || ''}で登録を申しこみました。管理者の先生の承認を待っています。`;
      actions = [retry(), logout()];
    } else {
      text = 'このアカウントは、まだ ClassPulse の先生として登録されていません。';
      actions = [button('利用を申しこむ', apply), logout()];
    }
    box.replaceChildren(el('p', { text, role: failed ? 'alert' : undefined }), message,
      el('div', { class: 'teacher-actions' }, actions));
  }

  async function load() {
    try {
      const request = await ctx.repo.getMyRequest();
      if (current()) render(request);
    } catch {
      if (current()) render(null, true);
    }
  }

  async function apply() {
    setBusy(true);
    message.hidden = true;
    try {
      await ctx.repo.requestAccess(user.email);
      if (current()) await load();
    } catch {
      if (current()) {
        message.textContent = '申しこみできませんでした。接続を確かめて、もう一度押してください。';
        message.hidden = false;
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  root.replaceChildren(el('main', { class: 'center-page' }, el('h1', { text: 'ClassPulse' }), box));
  if (ctx.status === 'suspended') render(null);
  else { box.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' })); load(); }
  return () => { alive = false; };
}
