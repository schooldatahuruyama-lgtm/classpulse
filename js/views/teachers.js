// 管理者用の先生の一覧。承認・ことわる・停止は、確認してから行う
import { el, confirmDialog, closeAllDialogs, toast } from '../ui.js';
import { isStillUser } from '../guard.js';

const RETRY = '接続を確かめて、もう一度押してください。';
const NO_EMAIL = 'メールアドレスの記録なし';

function formatDate(ms) {
  const d = new Date(ms);
  if (!ms || !Number.isFinite(d.getTime())) return '日時の記録なし';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mount(root, ctx) {
  let alive = true;
  let busy = false;
  const user = ctx.auth.user;
  const current = () => alive && isStillUser(ctx.auth, user.uid);
  const message = el('div', { class: 'teacher-message' });
  const lists = el('div');
  const setBusy = (v) => {
    busy = v;
    root.querySelectorAll('button[data-teacher-action]').forEach((b) => { b.disabled = v; });
  };
  const showError = (text) => message.replaceChildren(el('p', { class: 'notice', role: 'alert', text }));
  const button = (text, onclick, danger = false) => el('button', {
    type: 'button', class: danger ? 'btn teacher-danger' : 'btn btn-primary',
    text, disabled: busy, 'data-teacher-action': '', onclick,
  });

  async function run(action, doneText, failText, confirmation = null) {
    if (busy || !current()) return;
    setBusy(true);
    message.replaceChildren();
    try {
      if (confirmation && !(await confirmDialog(confirmation))) return;
      if (!current()) return;
      await action();
      if (!current()) return;
      if (doneText) toast(doneText);
      await load();
    } catch {
      if (current()) showError(`${failText}${RETRY}`);
    } finally {
      if (current()) setBusy(false);
    }
  }

  function requestCard(request) {
    const email = request.email || NO_EMAIL;
    const approve = () => run(() => ctx.repo.approveTeacher(request.uid, request.email, Date.now()),
      '承認しました。', '承認できませんでした。', {
        title: `${email}を承認しますか？`,
        body: 'この人は ClassPulse で教材を作り、授業をできるようになります。知っている先生かどうかを、本人に確かめてから承認してください。',
        okLabel: '承認する',
      });
    const reject = () => run(() => ctx.repo.rejectRequest(request.uid),
      'ことわりました。', 'ことわることができませんでした。', {
        title: `${email}の申しこみをことわりますか？`, body: '', okLabel: 'ことわる', danger: true,
      });
    return el('li', { class: 'card teacher-item' },
      el('h3', { class: 'teacher-email', text: email }),
      el('p', { class: 'muted', text: formatDate(request.at) }),
      el('div', { class: 'teacher-actions' }, button('承認する', approve), button('ことわる', reject, true)));
  }

  function teacherCard(teacher) {
    const self = teacher.uid === user.uid;
    const email = (self ? user.email : teacher.email) || NO_EMAIL;
    const toggle = () => run(() => ctx.repo.setTeacherActive(teacher.uid, !teacher.active),
      teacher.active ? '利用を停止しました。' : '再開しました。',
      teacher.active ? '利用を停止できませんでした。' : '再開できませんでした。',
      teacher.active ? {
        title: `${email}の利用を停止しますか？`,
        body: 'この先生は ClassPulse を開けなくなります。教材と授業の記録は消えません。あとで「再開」できます。',
        okLabel: '利用を停止', danger: true,
      } : null);
    return el('li', { class: 'card teacher-item' },
      el('h3', { class: 'teacher-email', text: email }),
      self ? el('p', { text: '（自分・管理者）' }) : null,
      el('p', { text: teacher.active ? '利用中' : '利用停止中' }),
      self ? null : el('div', { class: 'teacher-actions' }, button(teacher.active ? '利用を停止' : '再開', toggle, teacher.active)));
  }

  async function load() {
    try {
      const [requests, teachers] = await Promise.all([ctx.repo.listRequests(), ctx.repo.listTeachers()]);
      if (!current()) return;
      lists.replaceChildren(
        el('section', { class: 'teacher-section' }, el('h2', { text: '承認待ち' }),
          requests.length ? el('ul', { class: 'teacher-list' }, requests.map(requestCard)) : el('p', { text: '承認待ちの人はいません。' })),
        el('section', { class: 'teacher-section' }, el('h2', { text: '先生の一覧' }),
          el('ul', { class: 'teacher-list' }, teachers.map(teacherCard))));
    } catch {
      if (!current()) return;
      lists.replaceChildren(el('div', { class: 'notice', role: 'alert' },
        el('p', { text: `読みこめませんでした。${RETRY}` }),
        button('もう一度', () => run(load, '', '読みこめませんでした。'))));
    }
  }

  async function start() {
    const admin = await ctx.repo.isAdmin();
    if (!current()) return;
    if (!admin) {
      lists.replaceChildren(el('p', { class: 'notice', role: 'alert', text: 'この画面は、管理者の先生だけが使えます。' }));
      return;
    }
    await load();
  }

  root.replaceChildren(el('div', { class: 'teacher-admin' },
    el('h1', { text: '先生の管理' }), message, lists));
  lists.replaceChildren(el('p', { class: 'loading', text: '読みこんでいます…' }));
  start();
  return () => { alive = false; closeAllDialogs(); };
}
