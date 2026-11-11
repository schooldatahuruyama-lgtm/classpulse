// 先生のログイン画面
import { el } from '../ui.js';

function messageFor(e) {
  const code = e && e.code;
  if (code === 'bad-credentials') return 'メールアドレスかパスワードが違います。';
  if (code === 'network') return '通信できませんでした。接続を確かめて、もう一度押してください。';
  return 'ログインできませんでした。';
}

export function mount(root, ctx) {
  let alive = true;
  const email = el('input', { id: 'login-email', type: 'email', autocomplete: 'username' });
  const password = el('input', { id: 'login-password', type: 'password', autocomplete: 'current-password' });
  const error = el('div', { class: 'error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'ログイン' });
  const form = el('form', { novalidate: true },
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'login-email', text: 'メールアドレス' }), email),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'login-password', text: 'パスワード' }), password),
    error,
    el('p', {}, submit));

  function showError(text) {
    error.textContent = text;
    error.hidden = false;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    error.hidden = true;
    if (!email.value.trim() || !password.value) { showError('メールアドレスとパスワードを入れてください。'); return; }
    submit.disabled = true;
    submit.textContent = 'ログインしています…';
    try {
      await ctx.auth.signInTeacher(email.value.trim(), password.value);
      if (alive) ctx.navigate('dashboard');
    } catch (e) {
      if (!alive) return;
      showError(messageFor(e));
      submit.disabled = false;
      submit.textContent = 'ログイン';
    }
  });

  root.replaceChildren(el('main', { class: 'center-page' },
    el('h1', { text: 'ClassPulse' }),
    ctx.notice ? el('p', { class: 'notice', role: 'alert', text: ctx.notice }) : null,
    el('div', { class: 'card' }, form)));
  email.focus();
  return () => { alive = false; };
}
