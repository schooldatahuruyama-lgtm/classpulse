// js/net.js の createNet と同じ形のメモリ上の代役（テストと、画面の練習モードで使う）。
// 実物と同じにしてあること: update の複数パス、null での削除、空のオブジェクトと空の配列を保存しない、
// { '.sv': 'timestamp' } を now() に置きかえる、購読は自分・親・子の変更を受け取る。
// 購読の呼び出しは書き込みのあとに「同期的に」行う（テストが決まった順で確かめられるように）。
// 最初の値も subscribe の中で同期的に渡す。渡す値は常に写し。
import { NetError } from '../errors.js';

const isObj = (v) => v !== null && typeof v === 'object';

// 書く値を整える: サーバーの時刻を置きかえ、null と空の入れ物を落とす（全部落ちたら null）
function normalize(v, now) {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return v;
  if (!Array.isArray(v) && v['.sv'] === 'timestamp') return now();
  // 配列は「添字を文字にしたキーのオブジェクト」で保存する（null の要素は落とす）。実物と同じ
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const n = normalize(x, now);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length === 0 ? null : out;
}

// 読み出し用: 実物の規則で配列に戻す。キーが全部 0 以上の整数で、0〜最大キーのうち
// 最大キーが個数の 2 倍より小さければ（Firebase SDK の規則）、最大キー+1 の長さの配列（欠けは null）。そうでなければオブジェクト。写しを返す
function view(v) {
  if (!isObj(v)) return v === undefined ? null : v;
  const keys = Object.keys(v);
  const out = {};
  for (const k of keys) out[k] = view(v[k]);
  if (keys.length > 0 && keys.every((k) => /^(0|[1-9]\d*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (max < 2 * keys.length) {
      return Array.from({ length: max + 1 }, (_, i) => (i in out ? out[i] : null));
    }
  }
  return out;
}

const segs = (path) => String(path).split('/').filter((s) => s !== '');

// initial: 最初の中身（整えて取り込む）、onChange(root): 書きこみのたびに呼ぶ（練習モードの保存用）
export function createMemoryNet({ now = Date.now, deny = () => false, initial = null, onChange = null } = {}) {
  let root = normalize(initial, now);
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
      if (changedPaths.some((p) => related(p, s.path))) s.onValue(view(read(s.path)));
    }
  }

  function guard(op, path, value) {
    if (!online) throw new NetError('network', 'ネットワークにつながりません');
    if (deny(op, path, value)) throw new NetError('denied', '権限がありません');
  }

  return {
    async get(path) {
      guard('get', path);
      return view(read(path));
    },
    async set(path, value) {
      guard('set', path, value);
      write(path, normalize(value, now));
      notify([path]);
      if (onChange) onChange(root);
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
      if (onChange) onChange(root);
    },
    async remove(path) {
      guard('remove', path);
      write(path, null);
      notify([path]);
      if (onChange) onChange(root);
    },
    serverTimestamp() { return { '.sv': 'timestamp' }; },

    subscribe(path, onValue, onStatus) {
      const s = { path, onValue, onStatus };
      subs.add(s);
      if (online) {
        if (onStatus) onStatus('connected');
        onValue(view(read(path)));
      } else if (onStatus) {
        onStatus('disconnected');
      }
      return () => { subs.delete(s); };
    },

    // 全体の写し
    dump() { return view(root); },

    // 外から中身をまるごと入れかえる（別のタブの変更の取りこみ用）。onChange は呼ばない。
    // 値が変わった場所の購読にだけ知らせる
    replaceRoot(value) {
      const next = normalize(value, now);
      if (JSON.stringify(next) === JSON.stringify(root)) return;
      const before = root;
      const read0 = (r, path) => {
        let node = r;
        for (const k of segs(path)) {
          if (!isObj(node)) return null;
          node = node[k];
          if (node === undefined) return null;
        }
        return node === undefined ? null : node;
      };
      root = next;
      for (const s of [...subs]) {
        if (!subs.has(s)) continue;
        if (JSON.stringify(read0(before, s.path)) !== JSON.stringify(read(s.path))) s.onValue(view(read(s.path)));
      }
    },

    setOnline(value) {
      const next = Boolean(value);
      if (next === online) return;
      online = next;
      for (const s of [...subs]) {
        if (!subs.has(s)) continue;
        if (s.onStatus) s.onStatus(online ? 'connected' : 'disconnected');
        if (online) s.onValue(view(read(s.path)));
      }
    },
  };
}

// 既存のテストが使っている名前
export const createFakeNet = createMemoryNet;
