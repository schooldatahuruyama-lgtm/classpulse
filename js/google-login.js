// Google への移動と戻りの確認。ブラウザの機能・乱数・時計は引数で受け取る。
import { CONFIG } from './config.js';
import { NetError } from './errors.js';

const NOTICES = {
  cancelled: 'Google でのログインをやめました。',
  mismatch: 'Google でのログインを確かめられませんでした。もう一度ためしてください。',
  'google-failed': 'Google でログインできませんでした。管理者の先生に知らせてください。',
  'account-exists': 'このメールアドレスは、パスワードでのログインに登録されています。メールアドレスとパスワードでログインしてください。',
  network: '通信できませんでした。接続を確かめて、もう一度ためしてください。',
};

export function randomToken(getRandomValues) {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function redirectUriFrom(location) {
  return location.origin + location.pathname;
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, nonce }) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'id_token',
    scope: 'openid email', nonce, state, prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function parseGoogleCallback(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.startsWith('#/')) return null;
  const fragment = hash.slice(1);
  if (!/(?:^|&)(?:id_token|error)=/.test(fragment)) return null;
  const params = new URLSearchParams(fragment);
  const state = params.get('state');
  // 同じ項目が重なった戻りは、どちらかを選ばず確認失敗にする。
  if (['id_token', 'error', 'state'].some((key) => params.getAll(key).length > 1)) {
    return { error: 'invalid_response', state };
  }
  if (params.has('error')) return { error: params.get('error'), state };
  return { idToken: params.get('id_token'), state };
}

export function jwtPayload(token) {
  // 署名を確かめるのは Firebase のサーバー。ここでは nonce を読むだけ。
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const payload = parts[1];
    if (payload.length % 4 === 1) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function checkGoogleCallback({ saved, parsed, now, maxAgeMs }) {
  if (parsed && parsed.error === 'access_denied') return { ok: false, reason: 'cancelled' };
  const mismatch = { ok: false, reason: 'mismatch' };
  if (!parsed || 'error' in parsed || !saved
    || typeof saved.state !== 'string' || !saved.state || saved.state !== parsed.state
    || typeof saved.nonce !== 'string' || !saved.nonce
    || !Number.isFinite(saved.at) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs)
    || now < saved.at || now - saved.at > maxAgeMs) return mismatch;
  const payload = jwtPayload(parsed.idToken);
  if (!payload || payload.nonce !== saved.nonce) return mismatch;
  return { ok: true, idToken: parsed.idToken };
}

export async function handleGoogleCallback(deps) {
  if (!deps.clientId || deps.demo) return { handled: false };
  const parsed = parseGoogleCallback(deps.location.hash);
  if (!parsed) return { handled: false };
  const failed = (reason) => ({ handled: true, notice: NOTICES[reason] });
  let checked;
  try {
    // 保存先の取得・読み取りや時計、通信より先に URL と履歴からトークンを消す。
    deps.replaceState(null, '', '#/login');
    const storage = deps.sessionStorage;
    let raw;
    try { raw = storage.getItem(CONFIG.googleLogin.storageKey); }
    finally { storage.removeItem(CONFIG.googleLogin.storageKey); }
    checked = checkGoogleCallback({
      saved: raw ? JSON.parse(raw) : null, parsed, now: deps.now(),
      maxAgeMs: CONFIG.googleLogin.maxAgeMs,
    });
  } catch {
    return failed('mismatch');
  }
  if (!checked.ok) return failed(checked.reason);
  try {
    await deps.auth.signInWithGoogleIdToken(checked.idToken, redirectUriFrom(deps.location));
    return { handled: true };
  } catch (e) {
    const code = e && e.code;
    return failed(code === 'account-exists' || code === 'network' ? code : 'google-failed');
  }
}

// 設定が無い・練習モードなら、画面に渡す操作自体を用意しない。
export function createGoogleLogin(deps) {
  if (!deps.clientId || deps.demo) return null;
  return () => {
    let storage;
    try {
      const state = randomToken(deps.getRandomValues);
      const nonce = randomToken(deps.getRandomValues);
      const url = buildGoogleAuthUrl({ clientId: deps.clientId, redirectUri: redirectUriFrom(deps.location), state, nonce });
      storage = deps.sessionStorage;
      storage.setItem(CONFIG.googleLogin.storageKey, JSON.stringify({ state, nonce, at: deps.now() }));
      deps.assign(url);
    } catch {
      try { if (storage) storage.removeItem(CONFIG.googleLogin.storageKey); } catch { /* 保存先が使えない */ }
      throw new NetError('google-failed', NOTICES['google-failed']);
    }
  };
}
