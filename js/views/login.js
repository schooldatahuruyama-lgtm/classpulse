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
  const retry = el('button', {
    type: 'button', class: 'btn', text: 'もう一度確かめる',
    onclick: () => {
      error.hidden = true;
      guarded(proceed, false);
    },
  });
  const retryRow = el('p', { hidden: true }, retry);
  const form = el('form', { novalidate: true },
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'login-email', text: 'メールアドレス' }), email),
    el('div', { class: 'field' }, el('label', { class: 'label', for: 'login-password', text: 'パスワード' }), password),
    error,
    retryRow,
    el('p', {}, submit));

  // ログイン中・登録の確認のやり直し中は、どちらの操作も受けつけない（共通の busy）
  let busy = false;
  const setBusy = (v) => {
    busy = v;
    for (const n of [submit, retry, email, password]) n.disabled = v;
    submit.textContent = v && submitting ? 'ログインしています…' : 'ログイン';
  };
  let submitting = false;
  async function guarded(fn, isSubmit) {
    if (busy) return;
    submitting = isSubmit;
    setBusy(true);
    try {
      await fn();
    } finally {
      if (alive) setBusy(false); // 画面が残っているときだけ元に戻す
    }
  }

  function showError(text) {
    error.textContent = text;
    error.hidden = false;
  }

  // ログイン済みで先生の画面へ進む。登録の確認だけ通信で失敗したときは、この画面に残して確かめ直せるようにする
  async function proceed() {
    const result = await ctx.navigate('dashboard');
    if (alive && result === 'offline') {
      showError('通信できませんでした。');
      retryRow.hidden = false;
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    error.hidden = true;
    retryRow.hidden = true;
    if (!email.value.trim() || !password.value) { showError('メールアドレスとパスワードを入れてください。'); return; }
    guarded(async () => {
      try {
        await ctx.auth.signInTeacher(email.value.trim(), password.value);
      } catch (e) {
        if (alive) showError(messageFor(e));
        return;
      }
      // 画面が替わったあとに成功したログインは、黙って残さない（その場でログアウトして捨てる）
      if (!alive) { ctx.auth.signOut(); return; }
      await proceed();
    }, true);
  });

  root.replaceChildren(el('main', { class: 'center-page' },
    el('h1', { text: 'ClassPulse' }),
    ctx.notice ? el('p', { class: 'notice', role: 'alert', text: ctx.notice }) : null,
    el('div', { class: 'card' }, form,
      el('p', {}, el('a', { href: '#/signup', text: 'はじめて使う先生はこちら' })))));
  email.focus();
  return () => { alive = false; };
}
