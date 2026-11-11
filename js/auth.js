// Firebase Authentication（REST）でのログインとトークンの管理
// fetch・storage・now は引数で受け取る（環境に依存しない）。
// 保存するのは { uid, email, refreshToken } だけ。ID トークンと期限はメモリにだけ持つ。
import { CONFIG } from './config.js';
import { NetError } from './errors.js';

const IDT = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN = 'https://securetoken.googleapis.com/v1/token';

// Firebase のエラー文を NetError の code に直す
function codeFor(status, message) {
  const m = String(message || '');
  if (['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD'].includes(m)) return 'bad-credentials';
  if (['TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'USER_NOT_FOUND', 'USER_DISABLED', 'INVALID_GRANT_TYPE', 'MISSING_REFRESH_TOKEN'].includes(m)) return 'auth';
  if (m.startsWith('INVALID_REFRESH_TOKEN') || m.startsWith('INVALID_ID_TOKEN')) return 'auth';
  if (status === 401) return 'auth';
  if (status === 403) return 'denied';
  return 'unknown';
}

export function createAuth({ apiKey, fetch, storage, now, role }) {
  const storageKey = `classpulse:auth:${role}`;
  let user = null; // { uid, email? }
  let refreshToken = null;
  let idToken = null;
  let expiresAt = 0;
  let refreshing = null; // 更新中の Promise（同時に呼ばれても 1 回にまとめる）

  async function post(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new NetError('network', 'ネットワークにつながりません');
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const message = body && body.error && body.error.message;
      throw new NetError(codeFor(res.status, message), message || `HTTP ${res.status}`);
    }
    return body;
  }

  function postJson(path, payload) {
    return post(`${IDT}/${path}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  function persist() {
    const saved = { uid: user.uid, refreshToken };
    if (user.email) saved.email = user.email;
    storage.setItem(storageKey, JSON.stringify(saved));
  }

  function clearState() {
    user = null;
    refreshToken = null;
    idToken = null;
    expiresAt = 0;
    storage.removeItem(storageKey);
  }

  // ログイン・更新の応答を取り込む（camelCase と snake_case の両方に対応）
  function adopt(body, email) {
    const uid = body.localId ?? body.user_id;
    idToken = body.idToken ?? body.id_token;
    refreshToken = body.refreshToken ?? body.refresh_token;
    const seconds = Number(body.expiresIn ?? body.expires_in);
    expiresAt = now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000;
    const mail = email ?? (user && user.uid === uid ? user.email : undefined);
    user = mail ? { uid, email: mail } : { uid };
    persist();
  }

  function readSaved() {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && s.uid && s.refreshToken ? s : null;
    } catch {
      return null;
    }
  }

  // 更新用トークンで ID トークンを取り直す。無効なら保存を消して auth を投げる。
  async function doRefresh() {
    if (!refreshToken) throw new NetError('auth', 'ログインしていません');
    try {
      const body = await post(`${SECURETOKEN}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      });
      adopt(body);
      return idToken;
    } catch (e) {
      // 通信できないだけなら保存は残す。無効と分かったときだけ消す。
      if (e instanceof NetError && e.code !== 'network') clearState();
      throw e;
    }
  }

  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // 保存したトークンで戻る。無い・無効なら null（通信失敗は例外のまま）
  async function restore() {
    const saved = readSaved();
    if (!saved) return null;
    user = saved.email ? { uid: saved.uid, email: saved.email } : { uid: saved.uid };
    refreshToken = saved.refreshToken;
    try {
      await refresh();
    } catch (e) {
      if (e instanceof NetError && e.code === 'network') throw e;
      return null;
    }
    return { ...user };
  }

  return {
    async signInTeacher(email, password) {
      const body = await postJson('accounts:signInWithPassword', { email, password, returnSecureToken: true });
      adopt(body, body.email ?? email);
      return { ...user };
    },

    async signInAnonymous() {
      const restored = await restore();
      if (restored) return { uid: restored.uid };
      const body = await postJson('accounts:signUp', { returnSecureToken: true });
      adopt(body);
      return { uid: user.uid };
    },

    restore,

    async getToken() {
      if (!user) throw new NetError('auth', 'ログインしていません');
      if (!idToken || expiresAt - now() < CONFIG.tokenRefreshMarginMs) return refresh();
      return idToken;
    },

    forceRefresh() {
      return refresh();
    },

    signOut() {
      clearState();
    },

    get user() {
      return user ? { ...user } : null;
    },
  };
}
