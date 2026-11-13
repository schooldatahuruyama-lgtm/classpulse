// Drive の認可と CSV の送信。トークンと自動保存の印は、この操作の中だけに置く。
import { CONFIG } from './config.js';
import { NetError } from './errors.js';
import { randomToken, redirectUriFrom, parseGoogleCallback } from './google-login.js';
import { routeHash } from './router.js';

const MISMATCH = 'Google ドライブへの保存を確かめられませんでした。もう一度ためしてください。';
const CANCELLED = 'Google ドライブへの保存をやめました。';
const validSid = (sid) => typeof sid === 'string' && /^[A-Za-z0-9_-]+$/.test(sid);
const matches = (saved, state) => saved && typeof saved.state === 'string' && saved.state && saved.state === state;

export function buildDriveAuthUrl({ clientId, redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token',
    scope: CONFIG.driveExport.scope, state, include_granted_scopes: 'true',
  });
  if (typeof loginHint === 'string' && loginHint) params.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function parseDriveCallback(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.startsWith('#/')) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has('access_token')) {
    if (params.has('id_token')) return null;
    return parseGoogleCallback(hash); // error と state の読み取りはログインと共通
  }
  const state = params.get('state');
  if (params.has('id_token') || ['access_token', 'expires_in', 'token_type', 'state', 'error'].some((key) => params.getAll(key).length > 1)) {
    return { error: 'invalid_response', state };
  }
  if (params.has('error')) return { error: params.get('error'), state };
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in'));
  if (!accessToken || /[\s\u0000-\u001f\u007f]/u.test(accessToken)
    || params.get('token_type')?.toLowerCase() !== 'bearer' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { error: 'invalid_response', state };
  }
  return { accessToken, expiresIn, state };
}

export function createDriveExport(deps) {
  if (!deps.clientId || deps.demo) return null;
  let token = null;
  let expiresAt = 0;
  let pending = null;
  const clear = () => { token = null; expiresAt = 0; pending = null; };
  const failed = () => ({ handled: true, notice: MISMATCH });

  function handleCallback() {
    const hash = deps.location.hash;
    const parsed = parseDriveCallback(hash);
    if (!parsed) return { handled: false };
    const tokenResponse = /(?:^#|&)access_token=/.test(hash);
    let driveResponse = tokenResponse;
    clear();
    try {
      // 保存先の getter や読み取りが失敗しても、トークンを URL に残さない。
      // sid はまだ読めないため、まず安全な一覧へ消し、読めたあとで結果へ置きかえる。
      deps.replaceState(null, '', tokenResponse ? '#/history' : '#/login');
      const storage = deps.sessionStorage;
      let saved;
      if (tokenResponse) {
        let raw;
        try { raw = storage.getItem(CONFIG.driveExport.storageKey); }
        finally { storage.removeItem(CONFIG.driveExport.storageKey); }
        saved = raw ? JSON.parse(raw) : null;
      } else {
        const read = (key) => {
          try { return JSON.parse(storage.getItem(key)); } catch { return null; }
        };
        saved = read(CONFIG.driveExport.storageKey);
        const login = read(CONFIG.googleLogin.storageKey);
        // error だけの戻りは state で分ける。どちらでもなければ従来のログインへ。
        if (matches(login, parsed.state) || !matches(saved, parsed.state)) return { handled: false };
        driveResponse = true;
        storage.removeItem(CONFIG.driveExport.storageKey);
      }
      deps.replaceState(null, '', validSid(saved?.sid) ? routeHash('result', { sid: saved.sid }) : '#/history');
      const now = deps.now();
      if (!matches(saved, parsed.state) || !validSid(saved.sid)
        || !Number.isFinite(saved.at) || !Number.isFinite(now)
        || now < saved.at || now - saved.at > CONFIG.driveExport.maxAgeMs) return failed();
      if ('error' in parsed) return { handled: true, notice: parsed.error === 'access_denied' ? CANCELLED : MISMATCH };
      const expiry = now + parsed.expiresIn * 1000;
      if (!Number.isFinite(expiry) || expiry - now < CONFIG.driveExport.tokenMarginMs) return failed();
      token = parsed.accessToken;
      expiresAt = expiry;
      pending = saved.sid;
      return { handled: true };
    } catch {
      clear();
      return driveResponse ? failed() : { handled: false };
    }
  }

  function hasToken() {
    if (!token) return false;
    try {
      const now = deps.now();
      if (Number.isFinite(now) && expiresAt - now >= CONFIG.driveExport.tokenMarginMs) return true;
    } catch { /* 時計が使えなければ確認をやり直す */ }
    clear();
    return false;
  }

  function takePending(sid) {
    if (!pending || pending !== sid) return false;
    pending = null;
    return true;
  }

  function begin(sid) {
    let storage;
    clear();
    try {
      if (!validSid(sid)) throw new Error();
      const state = randomToken(deps.getRandomValues);
      const at = deps.now();
      if (!Number.isFinite(at)) throw new Error();
      const url = buildDriveAuthUrl({
        clientId: deps.clientId, redirectUri: redirectUriFrom(deps.location), state,
        loginHint: deps.getLoginHint?.(),
      });
      storage = deps.sessionStorage;
      storage.setItem(CONFIG.driveExport.storageKey, JSON.stringify({ state, sid, at }));
      deps.assign(url);
    } catch {
      try { if (storage) storage.removeItem(CONFIG.driveExport.storageKey); } catch { /* 保存先が使えない */ }
      throw new NetError('drive-failed');
    }
  }

  async function upload({ name, csv }) {
    if (!hasToken()) throw new NetError('drive-auth');
    let body;
    let boundary;
    try {
      if (typeof name !== 'string' || typeof csv !== 'string') throw new Error();
      const metadata = JSON.stringify({ name, mimeType: 'application/vnd.google-apps.spreadsheet' });
      boundary = 'classpulse_' + randomToken(deps.getRandomValues);
      while (metadata.includes(boundary) || csv.includes(boundary)) boundary += '_';
      body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
        + `--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    } catch { throw new NetError('drive-failed'); }
    let response;
    try {
      response = await deps.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body, redirect: 'error',
      });
    } catch { throw new NetError('network'); }
    if (response.status === 401) { clear(); throw new NetError('drive-auth'); }
    if (response.status === 403) throw new NetError('drive-denied');
    if (!response.ok) throw new NetError('drive-failed');
    try {
      const data = await response.json();
      const link = new URL(data.webViewLink);
      if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.id)
        || link.protocol !== 'https:' || !['docs.google.com', 'drive.google.com'].includes(link.hostname)
        || link.username || link.password) throw new Error();
      return { id: data.id, webViewLink: link.href };
    } catch { throw new NetError('drive-failed'); }
  }

  return { handleCallback, hasToken, takePending, begin, upload };
}
