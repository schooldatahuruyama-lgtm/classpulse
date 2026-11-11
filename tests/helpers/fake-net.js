// js/net.js の createNet と同じ形のメモリ上の代役（テスト用）。
// 実物と同じにしてあること: update の複数パス、null での削除、空のオブジェクトと空の配列を保存しない、
// { '.sv': 'timestamp' } を now() に置きかえる、購読は自分・親・子の変更を受け取る。
// 購読の呼び出しは書き込みのあとに「同期的に」行う（テストが決まった順で確かめられるように）。
// 最初の値も subscribe の中で同期的に渡す。渡す値は常に写し。
import { NetError } from '../../js/errors.js';

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));
const isObj = (v) => v !== null && typeof v === 'object';

// 書く値を整える: サーバーの時刻を置きかえ、null と空の入れ物を落とす（全部落ちたら null）
function normalize(v, now) {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return v;
  if (!Array.isArray(v) && v['.sv'] === 'timestamp') return now();
  if (Array.isArray(v)) {
    const arr = v.map((x) => normalize(x, now));
    return arr.every((x) => x === null) ? null : arr;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const n = normalize(x, now);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length === 0 ? null : out;
}

const segs = (path) => String(path).split('/').filter((s) => s !== '');

export function createFakeNet({ now = Date.now, deny = () => false } = {}) {
  let root = null;
  let online = true;
  const subs = new Set(); // { path, onValue, onStatus }

  function read(path) {
    let node = root;
    for (const k of segs(path)) {
      if (!isObj(node)) return null;
      node = node[k];
      if (node === undefined) return null;
    }
    return node === undefined ? null : node;
  }

  // 1 か所に書く（値は整えたもの。null なら削除）。空になった親は取り除く
  function write(path, value) {
    const keys = segs(path);
    if (keys.length === 0) { root = value; return; }
    if (!isObj(root)) root = {};
    const chain = [root];
    for (let i = 0; i < keys.length - 1; i++) {
      let child = chain[i][keys[i]];
      if (!isObj(child)) { child = {}; chain[i][keys[i]] = child; }
      chain.push(child);
    }
    const last = keys[keys.length - 1];
    if (value === null) delete chain[chain.length - 1][last];
    else chain[chain.length - 1][last] = value;
    for (let i = chain.length - 1; i >= 1; i--) {
      if (Object.keys(chain[i]).length > 0) break;
      delete chain[i - 1][keys[i - 1]];
    }
    if (isObj(root) && Object.keys(root).length === 0) root = null;
  }

  // a が b の先祖か同じ、または b が a の先祖（= 重なる）か
  function related(a, b) {
    const x = segs(a);
    const y = segs(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function notify(changedPaths) {
    for (const s of [...subs]) {
      if (!subs.has(s)) continue;
      if (changedPaths.some((p) => related(p, s.path))) s.onValue(clone(read(s.path)));
    }
  }

  function guard(op, path, value) {
    if (!online) throw new NetError('network', 'ネットワークにつながりません');
    if (deny(op, path, value)) throw new NetError('denied', '権限がありません');
  }

  return {
    async get(path) {
      guard('get', path);
      return clone(read(path));
    },
    async set(path, value) {
      guard('set', path, value);
      write(path, normalize(value, now));
      notify([path]);
    },
    async update(path, patch) {
      guard('update', path, patch);
      const paths = [];
      for (const [k, v] of Object.entries(patch)) {
        const full = [...segs(path), ...segs(k)].join('/');
        write(full, normalize(v, now));
        paths.push(full);
      }
      notify(paths);
    },
    async remove(path) {
      guard('remove', path);
      write(path, null);
      notify([path]);
    },
    serverTimestamp() { return { '.sv': 'timestamp' }; },

    subscribe(path, onValue, onStatus) {
      const s = { path, onValue, onStatus };
      subs.add(s);
      if (online) {
        if (onStatus) onStatus('connected');
        onValue(clone(read(path)));
      } else if (onStatus) {
        onStatus('disconnected');
      }
      return () => { subs.delete(s); };
    },

    // 全体の写し
    dump() { return clone(root); },

    setOnline(value) {
      const next = Boolean(value);
      if (next === online) return;
      online = next;
      for (const s of [...subs]) {
        if (!subs.has(s)) continue;
        if (s.onStatus) s.onStatus(online ? 'connected' : 'disconnected');
        if (online) s.onValue(clone(read(s.path)));
      }
    },
  };
}
