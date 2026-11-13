// アプリの入り口: 通信と認証を用意し、ハッシュに合わせて画面を切りかえる
import { FIREBASE } from './firebase-config.js';
import { createAuth } from './auth.js';
import { createNet } from './net.js';
import { createRepo } from './repo.js';
import { parseRoute, routeHash, needsTeacher, viewFile } from './router.js';
import { isDemoAllowed, createDemoBackend } from './dev/demo.js';
import { el, confirmDialog, toast } from './ui.js';
import { checkTeacherAccess, isStillUser } from './guard.js';
import { handleGoogleCallback, createGoogleLogin, parseGoogleCallback } from './google-login.js';
import { createDriveExport } from './drive-export.js';

const appRoot = document.getElementById('app');
const bannerRoot = document.getElementById('banner');

const NAV = [
  { name: 'dashboard', label: 'ホーム' },
  { name: 'history', label: '授業履歴' },
  { name: 'trash', label: 'ゴミ箱' },
  { name: 'words', label: '止める言葉' },
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
  const googleDeps = {
    clientId: FIREBASE.googleClientId, demo: backend.demo, location,
    replaceState: (...args) => history.replaceState(...args),
    get sessionStorage() { return window.sessionStorage; },
    auth: teacherAuth, now: () => Date.now(),
    getRandomValues: (bytes) => window.crypto.getRandomValues(bytes),
    assign: (url) => location.assign(url),
    fetch: (...args) => window.fetch(...args),
    getLoginHint: () => teacherAuth.user?.email,
  };
  const googleEnabled = !!FIREBASE.googleClientId && !backend.demo;
  // error は両方の認可で使う。先に URL を消す Drive の判定後も、ログインへ渡せる形で読む。
  // access_token のハッシュは控えず、ログイン用の error・state だけを引き継ぐ。
  const loginCallback = googleEnabled ? parseGoogleCallback(location.hash) : null;
  const driveExport = googleEnabled ? createDriveExport(googleDeps) : null;
  const driveCallback = driveExport ? driveExport.handleCallback() : { handled: false };
  const loginDeps = Object.create(googleDeps);
  if (loginCallback && 'error' in loginCallback) {
    loginDeps.location = {
      origin: location.origin, pathname: location.pathname,
      hash: `#error=${encodeURIComponent(loginCallback.error)}${loginCallback.state === null ? '' : '&state=' + encodeURIComponent(loginCallback.state)}`,
    };
  }
  const callback = googleEnabled && !driveCallback.handled ? await handleGoogleCallback(loginDeps) : { handled: false };
  const googleLogin = googleEnabled ? createGoogleLogin(googleDeps) : null;
  let notice = callback.notice;
  let driveNotice = driveCallback.notice;
  let cleanup = null;
  let renderId = 0;
  let restored = callback.handled && !callback.notice; // Google で入った直後は更新用トークンで戻し直さない
  let shownHash = null; // 今の画面のハッシュ（まだ何も出していなければ null）
  const teardown = () => { if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; } };
  let adminUid = null;
  let adminCheck = null; // 同じ人の確認は、通信中も含めて 1 回にまとめる

  function adminFor(uid, repo) {
    if (adminUid !== uid) { adminUid = uid; adminCheck = null; }
    if (!adminCheck) adminCheck = repo.isAdmin();
    return adminCheck;
  }

  // 画面を移して、その描き直しが終わったら結果（'offline' など）を返す
  function navigate(name, params = {}) {
    const next = routeHash(name, params);
    if (location.hash !== next) history.pushState(null, '', next); // hashchange は起きないので、ここで描き直す
    return render();
  }

  async function loadView(name) {
    try {
      return await import(`./views/${viewFile(name)}.js`);
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // 前の画面を片づけたあと、次の画面の読みこみを待つ間、古いボタンが残らないよう中身を置きかえる。
  // 先生の骨組み（ナビゲーション）は残し、本体だけを置きかえる。
  function showLoading(keepShell) {
    const loading = el('p', { class: 'loading page-pad', role: 'status', text: '読みこんでいます…' });
    const main = keepShell ? appRoot.querySelector('.shell-main') : null;
    (main || appRoot).replaceChildren(loading);
  }

  // 画面のプログラムを読みこめなかったとき。アドレス（ハッシュ）はそのままなので、読み直せば同じ画面を開ける
  // （発表を始めた直後なら、作成済みの授業の発表画面がそのまま開く。授業は作り直さない）
  function placeholder(root) {
    root.replaceChildren(el('main', { class: 'page-pad' },
      el('h2', { text: '画面を読みこめませんでした' }),
      el('p', { role: 'alert', text: '接続を確かめて、もう一度ためしてください。' }),
      el('p', {}, el('button', { type: 'button', class: 'btn btn-primary', text: 'もう一度ためす', onclick: () => location.reload() }))));
    return () => {};
  }

  // 先生用の骨組み（左のナビゲーションと本体。幅が狭いときは上のメニュー）
  function buildShell(current, isAdmin) {
    const navItems = isAdmin ? [...NAV, { name: 'teachers', label: '先生の管理' }] : NAV;
    const links = navItems.map((n) => el('a', {
      class: 'shell-link', href: routeHash(n.name), text: n.label, 'aria-current': n.name === current ? 'page' : false,
    }));
    const main = el('main', { class: 'shell-main' });
    const nav = el('nav', { class: 'shell-nav', 'aria-label': 'メニュー' },
      el('div', { class: 'shell-brand', text: 'ClassPulse' }),
      el('div', { class: 'shell-links' }, links),
      el('div', { class: 'shell-spacer' }),
      el('button', {
        type: 'button', class: 'btn shell-logout', text: 'ログアウト',
        onclick: () => { teacherAuth.signOut(); adminUid = null; adminCheck = null; navigate('login'); },
      }));
    appRoot.replaceChildren(el('div', { class: 'shell' }, nav, main));
    return main;
  }

  async function render() {
    const id = ++renderId;
    const stale = () => id !== renderId;
    const route = parseRoute(location.hash);

    // 生徒の参加画面: ログイン不要。生徒用の認証で student の画面へ
    if (route.name === 'join') {
      teardown();
      shownHash = location.hash;
      showLoading(false);
      const view = await loadView('join');
      if (stale()) return;
      const ctx = { net: backend.studentNet, auth: studentAuth, navigate, params: route.params, storage: window.localStorage };
      cleanup = view ? view.mount(appRoot, ctx) : placeholder(appRoot);
      return;
    }

    if (route.name === 'not-found') {
      teardown();
      shownHash = location.hash;
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

    // 先生の画面へ移るたびに、先生として登録されているかを確かめ直す
    const checkUser = teacherAuth.user;
    if (adminUid !== (checkUser ? checkUser.uid : null)) { adminUid = null; adminCheck = null; }
    const repo = checkUser ? createRepo(backend.net, checkUser.uid) : undefined;
    const { verdict: access, uid: checkedUid } = await checkTeacherAccess({ auth: teacherAuth, repo });
    if (stale()) return;
    // 確認している間に別の人に替わっていたら、その古い結果は使わない（ログアウトもしない）
    if (!isStillUser(teacherAuth, checkedUid)) { render(); return; }
    if (access === 'offline') {
      if (shownHash !== null) { // 今の画面のまま残す
        history.replaceState(null, '', shownHash || '#/');
        toast('通信できませんでした。');
      } else {
        showMessage('通信できませんでした。接続を確かめてください。', { retry: true });
      }
      return 'offline';
    }
    // 使えないことが確定したら、先に古い画面を片づける。ログイン状態は保つ
    teardown();
    let destination = route.name;
    if (access === 'pending' || access === 'suspended') destination = 'pending';
    else if (access === 'signed-out' && needsTeacher(route.name)) destination = 'login';
    else if (access === 'ok' && ['login', 'signup', 'pending'].includes(route.name)) destination = 'dashboard';
    if (destination !== route.name) {
      route.name = destination;
      route.params = {};
      history.replaceState(null, '', routeHash(destination));
    }
    shownHash = location.hash;
    const standalone = ['login', 'signup', 'pending'].includes(route.name);
    showLoading(!standalone);
    const isAdmin = access === 'ok' ? await adminFor(checkedUid, repo) : false;
    if (stale()) return;
    if (!isStillUser(teacherAuth, checkedUid)) { render(); return; }
    const view = await loadView(route.name);
    if (stale()) return;
    if (!isStillUser(teacherAuth, checkedUid)) { render(); return; }
    const ctx = { net: backend.net, auth: teacherAuth, repo, navigate, params: route.params, storage: window.localStorage, googleLogin, driveExport };
    if (route.name === 'login') ctx.notice = notice;
    if (route.name === 'history' || route.name === 'result') ctx.driveNotice = driveNotice;
    if (route.name === 'signup') {
      ctx.requestAccess = async (email, uid) => {
        if (!isStillUser(teacherAuth, uid)) return;
        await createRepo(backend.net, uid).requestAccess(email);
      };
    }
    if (route.name === 'pending') ctx.status = access;
    if (standalone) {
      cleanup = view ? view.mount(appRoot, ctx) : placeholder(appRoot);
      if (view && route.name === 'login') notice = undefined;
    } else {
      const main = buildShell(route.name, isAdmin);
      cleanup = view ? view.mount(main, ctx) : placeholder(main);
      if (view && (route.name === 'history' || route.name === 'result')) driveNotice = undefined;
    }
  }

  window.addEventListener('hashchange', render);
  render();
}

start();
