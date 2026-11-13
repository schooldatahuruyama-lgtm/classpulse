// 新しい先生の登録。申しこみを書けなかったときは、承認待ちの画面でやり直せる
import { el } from '../ui.js';
import { isStillUser } from '../guard.js';

function messageFor(e) {
  const code = e && e.code;
  if (code === 'email-exists') return 'このメールアドレスは、もう登録されています。ログイン画面からログインしてください。';
  if (code === 'invalid-email') return 'メールアドレスを確かめてください。';
  if (code === 'weak-password') return 'パスワードは 8 文字以上にしてください。';
  if (code === 'signup-disabled') return 'いまは登録できません。管理者の先生に知らせてください。';
  if (code === 'network') return '通信できませんでした。接続を確かめて、もう一度押してください。';
  return '登録できませんでした。';
}

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const email = el('input', { id: 'signup-email', type: 'email', autocomplete: 'username' });
  const password = el('input', { id: 'signup-password', type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { id: 'signup-confirm', type: 'password', autocomplete: 'new-password' });
  const error = el('div', { class: 'error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: '登録する' });
  const retry = el('button', {
    type: 'button', class: 'btn', text: 'もう一度確かめる',
    onclick: () => { if (!busy && alive) ctx.navigate('pending'); },
  });
  const retryRow = el('p', { hidden: true }, retry);
  const field = (input, text) => el('div', { class: 'field' }, el('label', { class: 'label', for: input.id, text }), input);
  const form = el('form', { novalidate: true },
    field(email, 'メールアドレス'), field(password, 'パスワード（8 文字以上）'), field(confirm, 'パスワード（確認）'),
    error, retryRow, el('p', {}, submit));
  const showError = (text) => { error.textContent = text; error.hidden = false; };
  const setBusy = (v) => {
    busy = v;
    for (const n of [email, password, confirm, submit, retry]) n.disabled = v;
    submit.textContent = v ? '登録しています…' : '登録する';
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || !alive) return;
    error.hidden = true;
    if (!email.value.trim() || !password.value) { showError('メールアドレスとパスワードを入れてください。'); return; }
    if (password.value.length < 8) { showError('パスワードは 8 文字以上にしてください。'); return; }
    if (password.value !== confirm.value) { showError('パスワードが同じではありません。'); return; }
    setBusy(true);
    try {
      const registration = ctx.auth.signUpTeacher(email.value.trim(), password.value);
      password.value = '';
      confirm.value = '';
      const user = await registration;
      // 別の人に替わっていれば、その人をログアウトしない
      if (!isStillUser(ctx.auth, user.uid)) return;
      if (!alive) { ctx.auth.signOut(); return; }
      try { await ctx.requestAccess(user.email, user.uid); } catch { /* 承認待ちの画面で申しこみ直す */ }
      if (!isStillUser(ctx.auth, user.uid)) return;
      if (!alive) { ctx.auth.signOut(); return; }
      const result = await ctx.navigate('pending');
      if (alive && result === 'offline') {
        showError('通信できませんでした。');
        retryRow.hidden = false;
      }
    } catch (e) {
      if (alive) showError(messageFor(e));
    } finally {
      if (alive) setBusy(false);
    }
  });

  root.replaceChildren(el('main', { class: 'center-page signup' },
    el('h1', { text: 'はじめて使う先生の登録' }),
    el('p', { text: '登録したあと、管理者の先生が承認すると使えるようになります。' }),
    el('div', { class: 'card' }, form,
      el('p', {}, el('a', { href: '#/login', text: 'ログイン画面へ戻る' })))));
  email.focus();
  return () => { alive = false; password.value = ''; confirm.value = ''; };
}
