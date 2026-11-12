// 練習モードは手動で試すための道具。2 つのタブが同じ瞬間に書きこむ場合の競合は守っていない。
// 別のタブへは「書きこみそのもの」を BroadcastChannel で順に知らせる（保存先は読み直し用）。
// 練習モード: Firebase の代わりに、このパソコンの中だけで動く net / auth を作る。
// データは localStorage に保存し、BroadcastChannel でほかのタブへ変更を知らせる。
// ブラウザのものは引数で受け取る（Node のテストでも動かせる）。
import { createMemoryNet } from './memory-net.js';
import { NetError } from '../errors.js';

export const DEMO_DB_KEY = 'classpulse:demo:db';
const TEACHER_KEY = 'classpulse:demo:teacher';
const STUDENT_KEY = 'classpulse:demo:student-uid';
const CHANNEL = 'classpulse-demo';
export const DEMO_TEACHER_UID = 'demo-teacher';

// 練習モードにしてよい場所か。localhost 系で、URL に ?demo=1 があるときだけ
export function isDemoAllowed(hostname, search) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  return new URLSearchParams(search || '').get('demo') === '1';
}

// 保存先の中身。キーが無ければ null（削除された）、読めない・壊れているときは undefined（今のデータを残す）
function readDb(storage) {
  try {
    const raw = storage.getItem(DEMO_DB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return undefined;
  }
}

// 規則の代わり（docs/firebase/rules.json の pub/results/$slideId の .validate と同じ）:
// 集計は、書きこんだあとのデータで、その質問の結果を公開している（resultsVisible が true）ときだけ書ける。
// 消すのはいつでもよい。root は今の中身、op・path・value は書きこみ。拒否するなら true
export function resultsWriteDenied(root, op, path, value) {
  if (op !== 'set' && op !== 'update') return false;
  const join = (a, b) => [a, b].filter((x) => x !== '').join('/');
  const writes = op === 'set'
    ? [[String(path), value]]
    : Object.entries(value || {}).map(([k, v]) => [join(String(path), String(k).replace(/^\/+|\/+$/g, '')), v]);
  const isObj = (v) => v !== null && typeof v === 'object';
  const exists = (v) => v !== null && v !== undefined;
  // 書きこんだあとの resultsVisible（同じ書きこみに入っていればその値、無ければ今の値）
  const visibleAfter = (sid, id) => {
    let vis = root?.sessions?.[sid]?.pub?.polls?.[id]?.resultsVisible;
    for (const [p, v] of writes) {
      if (p === `sessions/${sid}/pub/polls/${id}/resultsVisible`) vis = v;
      else if (p === `sessions/${sid}/pub/polls/${id}`) vis = isObj(v) ? v.resultsVisible : undefined;
      else if (p === `sessions/${sid}/pub/polls`) vis = isObj(v) && isObj(v[id]) ? v[id].resultsVisible : undefined;
    }
    return vis === true;
  };
  // まるごと置きかえる書きこみ: 置きかえたあとの pub の中だけで確かめる
  const pubDenied = (pub) => isObj(pub) && isObj(pub.results)
    && Object.keys(pub.results).some((id) => exists(pub.results[id]) && pub.polls?.[id]?.resultsVisible !== true);
  for (const [p, v] of writes) {
    if (!exists(v)) continue;
    let m;
    if ((m = /^sessions\/([^/]+)\/pub\/results\/([^/]+)(\/.*)?$/.exec(p))) {
      if (!visibleAfter(m[1], m[2])) return true;
    } else if ((m = /^sessions\/([^/]+)\/pub\/results$/.exec(p))) {
      if (isObj(v) && Object.keys(v).some((id) => exists(v[id]) && !visibleAfter(m[1], id))) return true;
    } else if (/^sessions\/[^/]+\/pub$/.test(p)) {
      if (pubDenied(v)) return true;
    } else if (/^sessions\/[^/]+$/.test(p)) {
      if (isObj(v) && pubDenied(v.pub)) return true;
    }
  }
  return false;
}

// 先生の登録だけが入った初期の中身
const seedDb = () => ({ teacherList: { [DEMO_TEACHER_UID]: true } });

export function createDemoBackend({ storage, sessionStorage, BroadcastChannel, now = Date.now }) {
  let initial = readDb(storage) || null;
  // 先生の登録を最初から入れておく（teacherList に demo-teacher）
  if (!initial || !initial.teacherList || initial.teacherList[DEMO_TEACHER_UID] !== true) {
    initial = { ...(initial || {}), teacherList: { ...((initial && initial.teacherList) || {}), [DEMO_TEACHER_UID]: true } };
    storage.setItem(DEMO_DB_KEY, JSON.stringify(initial));
  }

  let channel = null;
  try { channel = BroadcastChannel ? new BroadcastChannel(CHANNEL) : null; } catch { channel = null; }

  // 規則の代わり: 参加は授業が live のときだけ。回答は授業が live で、その質問が open のときだけ。
  // かくしている質問の集計は pub に書けない
  let mem;
  const deny = (op, path, value) => {
    if (resultsWriteDenied(mem.dump(), op, path, value)) return true;
    if (op !== 'set') return false;
    const part = /^sessions\/([^/]+)\/inbox\/participants\/[^/]+$/.exec(path);
    const ans = /^sessions\/([^/]+)\/inbox\/answers\/([^/]+)\/[^/]+$/.exec(path);
    const m = part || ans;
    if (!m) return false;
    const pub = mem.dump()?.sessions?.[m[1]]?.pub;
    if (!pub || pub.state !== 'live') return true;
    return ans ? pub.polls?.[m[2]]?.status !== 'open' : false;
  };

  mem = createMemoryNet({
    now,
    deny,
    initial,
    onChange: (root, writes) => {
      // 保存できない（容量不足など）ときは失敗にする。memory-net が書く前の中身に戻し、呼び出し元の保存失敗の表示に届く。
      // ほかのタブにも知らせない（保存先と、どのタブのメモリも前のまま）
      try {
        storage.setItem(DEMO_DB_KEY, JSON.stringify(root));
      } catch {
        throw new NetError('unknown', '練習モードの保存先がいっぱいで保存できませんでした');
      }
      // 書きこみそのものを知らせる（保存先の最新だけを読む方式だと、続けて起きた変更の途中を取りこぼす）
      if (channel) channel.postMessage({ type: 'ops', writes });
    },
  });

  // 保存先の最新を取りこむ（ほかのタブの変更に追いつく）
  function sync() {
    const latest = readDb(storage);
    if (latest === undefined) return; // 読めないときは今のデータのまま
    mem.replaceRoot(latest === null ? seedDb() : latest); // キーが無い = 削除された
  }
  // 届いた書きこみを順に適用する。消去は初期の状態へ。それ以外の知らせは保存先から読み直す
  if (channel) {
    channel.onmessage = (ev) => {
      const d = ev && ev.data;
      if (d && d.type === 'ops' && Array.isArray(d.writes)) mem.applyRemote(d.writes);
      else if (d && d.type === 'clear') mem.replaceRoot(seedDb());
      else sync();
    };
  }

  // BroadcastChannel が使えない環境では、操作の前に保存先の最新へ追いつく
  const net = { ...mem };
  if (!channel) {
    for (const op of ['get', 'set', 'update', 'remove']) {
      net[op] = (...args) => { sync(); return mem[op](...args); };
    }
  }
  net.clear = () => {
    storage.removeItem(DEMO_DB_KEY);
    mem.replaceRoot(seedDb());
    if (channel) channel.postMessage({ type: 'clear' });
  };

  // 先生: どんなメールアドレスとパスワードでも入れる。状態は localStorage に残す
  const teacherAuth = {
    async signInTeacher(email) {
      storage.setItem(TEACHER_KEY, JSON.stringify({ uid: DEMO_TEACHER_UID, email: String(email || '') }));
      return { ...this.user };
    },
    async signInAnonymous() { throw new NetError('unknown', '先生の auth では使えません'); },
    async restore() { return this.user; },
    async getToken() {
      if (!this.user) throw new NetError('auth', 'ログインしていません');
      return 'demo-token';
    },
    async forceRefresh() { return this.getToken(); },
    signOut() { storage.removeItem(TEACHER_KEY); },
    get user() {
      try {
        const s = JSON.parse(storage.getItem(TEACHER_KEY) || 'null');
        return s && s.uid ? { uid: s.uid, email: s.email } : null;
      } catch { return null; }
    },
  };

  // 生徒: uid は sessionStorage（タブごとに別。同じタブの読み直しでは同じ）
  const newUid = () => `demo-s-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
  const studentAuth = {
    async signInTeacher() { throw new NetError('unknown', '生徒の auth では使えません'); },
    async signInAnonymous() {
      let uid = sessionStorage.getItem(STUDENT_KEY);
      if (!uid) { uid = newUid(); sessionStorage.setItem(STUDENT_KEY, uid); }
      return { uid };
    },
    async restore() { return this.user; },
    async getToken() {
      if (!this.user) throw new NetError('auth', 'ログインしていません');
      return 'demo-token';
    },
    async forceRefresh() { return this.getToken(); },
    signOut() { sessionStorage.removeItem(STUDENT_KEY); },
    get user() {
      const uid = sessionStorage.getItem(STUDENT_KEY);
      return uid ? { uid } : null;
    },
  };

  return { net, teacherAuth, studentAuth };
}
