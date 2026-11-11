// アプリの入り口: 通信と認証を用意し、ハッシュに合わせて画面を切りかえる
import { FIREBASE } from './firebase-config.js';
import { createAuth } from './auth.js';
import { createNet } from './net.js';
import { createRepo } from './repo.js';
import { parseRoute, routeHash, needsTeacher } from './router.js';
import { isDemoAllowed, createDemoBackend } from './dev/demo.js';
import { el, confirmDialog } from './ui.js';

const appRoot = document.getElementById('app');
const bannerRoot = document.getElementById('banner');

// 画面の名前 → 画面のファイル（js/views/）
const VIEW_FILES = {
  login: 'login', dashboard: 'dashboard', editor: 'editor', present: 'present',
  history: 'history', result: 'result', join: 'student',
};

const NAV = [
  { name: 'dashboard', label: 'ホーム' },
  { name: 'history', label: '授業履歴' },
];

function showMessage(text, { retry = false } = {}) {
  appRoot.replaceChildren(el('main', { class: 'center-page' },
    el('h1', { text: 'ClassPulse' }),
    el('p', { class: 'notice', role: 'alert', text }),
    retry ? el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度ためす', onclick: () => location.reload() })) : null));
}

// 練習モードか、本物の Firebase か、設定が空か
async function createBackend() {
  if (isDemoAllowed(location.hostname, location.search)) {
    const demo = createDemoBackend({
      storage: window.localStorage, sessionStorage: window.sessionStorage,
      BroadcastChannel: window.BroadcastChannel, now: () => Date.now(),
    });
    return { demo, net: demo.net, studentNet: demo.net, teacherAuth: demo.teacherAuth, studentAuth: demo.studentAuth };
  }
  if (!FIREBASE.databaseURL || !FIREBASE.apiKey) return null;
  const common = { apiKey: FIREBASE.apiKey, fetch: window.fetch.bind(window), storage: window.localStorage, now: () => Date.now() };
  const teacherAuth = createAuth({ ...common, role: 'teacher' });
  const studentAuth = createAuth({ ...common, role: 'student' });
  const mk = (auth) => createNet({ databaseURL: FIREBASE.databaseURL, auth, fetch: window.fetch.bind(window), EventSource: window.EventSource });
  return { demo: null, net: mk(teacherAuth), studentNet: mk(studentAuth), teacherAuth, studentAuth };
}

function showDemoBanner(backend) {
  bannerRoot.replaceChildren(el('div', { class: 'demo-banner' },
    el('span', { text: '練習モード（データはこのパソコンの中だけ）' }),
    el('button', {
      type: 'button', class: 'btn', text: '練習モードのデータを消す',
      onclick: async () => {
        const ok = await confirmDialog({ title: '練習モードのデータを消しますか？', body: 'このパソコンの中の練習用のデータ（教材・授業・ログイン）がすべて消えます。', okLabel: '消す', danger: true });
        if (!ok) return;
        backend.demo.net.clear();
        backend.teacherAuth.signOut();
        backend.studentAuth.signOut();
        location.hash = '#/login';
        location.reload();
      },
    })));
}

async function start() {
  const backend = await createBackend();
  if (!backend) { showMessage('Firebase の設定がまだ入っていません。'); return; }
  if (backend.demo) showDemoBanner(backend);

  const { teacherAuth, studentAuth } = backend;
  let cleanup = null;
  let renderId = 0;
  let restored = false;
  let teacherChecked = null; // 先生だと確かめた uid
  let notice = '';

  function navigate(name, params = {}) {
    const next = routeHash(name, params);
    if (location.hash === next) render();
    else location.hash = next;
  }

  async function loadView(name) {
    try {
      return await import(`./views/${VIEW_FILES[name]}.js`);
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function placeholder(root) {
    root.replaceChildren(el('main', { class: 'page-pad' },
      el('h2', { text: '準備中' }),
      el('p', { text: 'この画面はまだ使えません。' })));
    return () => {};
  }

  // 先生用の骨組み（左のナビゲーションと本体。幅が狭いときは上のメニュー）
  function buildShell(current) {
    const links = NAV.map((n) => el('a', {
      class: 'shell-link', href: routeHash(n.name), text: n.label, 'aria-current': n.name === current ? 'page' : false,
    }));
    const main = el('main', { class: 'shell-main' });
    const nav = el('nav', { class: 'shell-nav', 'aria-label': 'メニュー' },
      el('div', { class: 'shell-brand', text: 'ClassPulse' }),
      el('div', { class: 'shell-links' }, links),
      el('div', { class: 'shell-spacer' }),
      el('button', {
        type: 'button', class: 'btn shell-logout', text: 'ログアウト',
        onclick: () => { teacherAuth.signOut(); teacherChecked = null; navigate('login'); },
      }));
    appRoot.replaceChildren(el('div', { class: 'shell' }, nav, main));
    return main;
  }

  async function render() {
    const id = ++renderId;
    const stale = () => id !== renderId;
    if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
    const route = parseRoute(location.hash);

    // 生徒の参加画面: ログイン不要。生徒用の認証で student の画面へ
    if (route.name === 'join') {
      const view = await loadView('join');
      if (stale()) return;
      const ctx = { net: backend.studentNet, auth: studentAuth, navigate, params: route.params, storage: window.localStorage };
      cleanup = view ? view.mount(appRoot, ctx) : placeholder(appRoot);
      return;
    }

    if (route.name === 'not-found') {
      appRoot.replaceChildren(el('main', { class: 'page-pad' },
        el('h2', { text: 'ページが見つかりません' }),
        el('p', {}, el('a', { class: 'btn btn-primary', href: '#/', text: 'ホームへ' }))));
      return;
    }

    // 先生の画面: 保存したログインを戻してから判断する
    if (!restored) {
      try {
        await teacherAuth.restore();
      } catch {
        if (stale()) return;
        showMessage('通信できませんでした。接続を確かめてください。', { retry: true });
        return;
      }
      if (stale()) return;
      restored = true;
    }

    let user = teacherAuth.user;
    if (user && teacherChecked !== user.uid) {
      let ok = false;
      try {
        ok = await createRepo(backend.net, user.uid).isTeacher();
      } catch {
        if (stale()) return;
        showMessage('通信できませんでした。接続を確かめてください。', { retry: true });
        return;
      }
      if (stale()) return;
      if (ok) teacherChecked = user.uid;
      else {
        teacherAuth.signOut();
        user = null;
        notice = 'このアカウントは ClassPulse の先生として登録されていません。';
      }
    }

    if (!user && needsTeacher(route.name)) { location.hash = routeHash('login'); return; } // hashchange で描き直す
    if (user && route.name === 'login') { navigate('dashboard'); return; }

    const view = await loadView(route.name);
    if (stale()) return;
    const repo = user ? createRepo(backend.net, user.uid) : undefined;
    const ctx = { net: backend.net, auth: teacherAuth, repo, navigate, params: route.params, storage: window.localStorage };
    if (route.name === 'login') {
      ctx.notice = notice;
      notice = '';
      cleanup = view ? view.mount(appRoot, ctx) : placeholder(appRoot);
    } else {
      const main = buildShell(route.name);
      cleanup = view ? view.mount(main, ctx) : placeholder(main);
    }
  }

  window.addEventListener('hashchange', render);
  render();
}

start();
