// データベース（Firebase Realtime Database）の読み書きと変化の受信
// データベースの URL の形を知っているのはこのモジュールだけ。fetch と EventSource は引数で受け取る。
// パスは先頭と末尾に `/` のない文字列（例 'sessions/abc/pub'）。
import { NetError } from './errors.js';

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

export function createNet({ databaseURL, auth, fetch, EventSource }) {
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

  // 401 のときは 1 回だけトークンを取り直してやり直す
  async function request(method, path, body) {
    let res = await send(method, path, body, await auth.getToken());
    if (res.status === 401) {
      res = await send(method, path, body, await auth.forceRefresh());
    }
    if (res.status === 401) throw new NetError('auth', 'ログインが無効です');
    if (res.status === 403) throw new NetError('denied', '権限がありません');
    if (!res.ok) throw new NetError('unknown', `HTTP ${res.status}`);
    return res;
  }

  async function readJson(res) {
    try { return await res.json(); } catch { return null; }
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

      async function connect() {
        const gen = ++generation;
        let token;
        try {
          token = gen === 1 ? await auth.getToken() : await auth.forceRefresh();
        } catch {
          status('disconnected');
          return;
        }
        if (stopped || gen !== generation) return;
        const source = new EventSource(urlFor(path, token));
        es = source;
        source.addEventListener('open', () => { if (!stopped && gen === generation) status('connected'); });
        source.addEventListener('error', () => { if (!stopped && gen === generation) status('disconnected'); });
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
          connect();
        });
      }

      connect();
      return () => {
        stopped = true;
        close();
      };
    },
  };
}
