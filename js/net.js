// データベース（Firebase Realtime Database）の読み書きと変化の受信
// データベースの URL の形を知っているのはこのモジュールだけ。fetch と EventSource は引数で受け取る。
// パスは先頭と末尾に `/` のない文字列（例 'sessions/abc/pub'）。
import { NetError } from './errors.js';
import { CONFIG } from './config.js';

// 木（値）の path（'/a/b' や '/'）に value を置く。null は削除。空になった親は取り除く。
// 木を直接書きかえて、新しい根を返す。
function applyAt(root, path, value) {
  const keys = path.split('/').filter((k) => k !== '');
  if (keys.length === 0) return isEmpty(value) ? null : value;
  if (root === null || typeof root !== 'object') root = {};
  // 根から途中の入れ物をたどる（無ければ作る）
  const parents = [root];
  for (let i = 0; i < keys.length - 1; i++) {
    let child = parents[i][keys[i]];
    if (child === null || typeof child !== 'object') {
      child = {};
      parents[i][keys[i]] = child;
    }
    parents.push(child);
  }
  const last = keys[keys.length - 1];
  if (isEmpty(value)) delete parents[parents.length - 1][last];
  else parents[parents.length - 1][last] = value;
  // 空になった入れ物を下から取り除く
  for (let i = parents.length - 1; i >= 1; i--) {
    if (Object.keys(parents[i]).length > 0) break;
    delete parents[i - 1][keys[i - 1]];
  }
  return Object.keys(root).length === 0 ? null : root;
}

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0);
}

export function createNet({ databaseURL, auth, fetch, EventSource, setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout }) {
  const base = String(databaseURL).replace(/\/+$/, '');
  const urlFor = (path, token) => `${base}/${path}.json?auth=${encodeURIComponent(token)}`;

  async function send(method, path, body, token) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    try {
      return await fetch(urlFor(path, token), init);
    } catch {
      throw new NetError('network', 'ネットワークにつながりません');
    }
  }

  // 実物の Firebase は、規則による拒否も HTTP 401 で返す（本文は {"error":"Permission denied"}）。
  // 期限切れ・無効なトークンも 401 だが、本文の文が違う。本文で見分ける
  async function isPermissionDenied(res) {
    try {
      const body = await res.json();
      return !!body && typeof body.error === 'string' && /permission denied/i.test(body.error);
    } catch {
      return false; // 本文が読めないときは、認証の失敗として扱う
    }
  }
  const denied = () => new NetError('denied', '権限がありません');

  // 401 のとき: 規則による拒否ならすぐ denied。それ以外は 1 回だけトークンを取り直してやり直す
  async function request(method, path, body) {
    let res = await send(method, path, body, await auth.getToken());
    if (res.status === 401) {
      if (await isPermissionDenied(res)) throw denied();
      res = await send(method, path, body, await auth.forceRefresh());
      if (res.status === 401) {
        if (await isPermissionDenied(res)) throw denied();
        throw new NetError('auth', 'ログインが無効です');
      }
    }
    if (res.status === 403) throw denied();
    if (!res.ok) throw new NetError('unknown', `HTTP ${res.status}`);
    return res;
  }

  // 本文の JSON を読む。受信に失敗したら network、JSON として不正なら unknown（null にしない）
  async function readJson(res) {
    try {
      return await res.json();
    } catch (e) {
      if (e && e.name === 'SyntaxError') throw new NetError('unknown', '応答が JSON ではありません');
      throw new NetError('network', '応答を読み込めませんでした');
    }
  }

  return {
    async get(path) {
      const body = await readJson(await request('GET', path));
      return body === undefined ? null : body;
    },
    async set(path, value) { await request('PUT', path, value); },
    async update(path, patch) { await request('PATCH', path, patch); },
    async remove(path) { await request('DELETE', path); },
    serverTimestamp() { return { '.sv': 'timestamp' }; },

    subscribe(path, onValue, onStatus) {
      let stopped = false;
      let es = null;
      let value = null;
      let timer = null; // つなぎ直しの待ち
      let generation = 0; // 開き直すたびに増やし、古い接続のイベントを無視する
      const status = (s) => { if (!stopped && onStatus) onStatus(s); };

      function handle(gen, type, e) {
        if (stopped || gen !== generation) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!msg || typeof msg.path !== 'string') return;
        if (type === 'put') {
          value = applyAt(value, msg.path, msg.data);
        } else {
          const prefix = msg.path === '/' ? '' : msg.path;
          for (const [k, v] of Object.entries(msg.data || {})) {
            value = applyAt(value, `${prefix}/${k}`, v);
          }
        }
        onValue(value === null ? null : structuredClone(value));
      }

      function close() {
        if (es) { es.close(); es = null; }
      }

      // 待ってからつなぎ直す（トークンも取り直す）。解除されるまで、開くまで繰り返す
      function scheduleRetry() {
        if (stopped || timer !== null) return;
        timer = setTimer(() => {
          timer = null;
          connect(true);
        }, CONFIG.reconnectDelayMs);
      }

      async function connect(refresh) {
        const gen = ++generation;
        let token;
        try {
          token = refresh ? await auth.forceRefresh() : await auth.getToken();
        } catch {
          if (stopped || gen !== generation) return;
          status('disconnected');
          scheduleRetry();
          return;
        }
        if (stopped || gen !== generation) return;
        const source = new EventSource(urlFor(path, token));
        es = source;
        source.addEventListener('open', () => { if (!stopped && gen === generation) status('connected'); });
        source.addEventListener('error', () => {
          if (stopped || gen !== generation) return;
          status('disconnected');
          // 完全に閉じた（CLOSED = 2）なら自動では戻らないので、こちらでつなぎ直す
          if (source.readyState === 2) {
            close();
            scheduleRetry();
          }
        });
        source.addEventListener('put', (e) => handle(gen, 'put', e));
        source.addEventListener('patch', (e) => handle(gen, 'patch', e));
        source.addEventListener('keep-alive', () => {});
        source.addEventListener('cancel', () => {
          if (stopped || gen !== generation) return;
          close();
          status('disconnected');
        });
        source.addEventListener('auth_revoked', () => {
          if (stopped || gen !== generation) return;
          close();
          status('disconnected');
          connect(true);
        });
      }

      connect(false);
      return () => {
        stopped = true;
        if (timer !== null) { clearTimer(timer); timer = null; }
        close();
      };
    },
  };
}
