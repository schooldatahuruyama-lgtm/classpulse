// 練習モードは手動で試すための道具。2 つのタブが同じ瞬間に書きこむ場合の競合は守っていない。
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

  // 規則の代わり: 参加は授業が live のときだけ。回答は授業が live で、その質問が open のときだけ
  let mem;
  const deny = (op, path) => {
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
    onChange: (root) => {
      try { storage.setItem(DEMO_DB_KEY, JSON.stringify(root)); } catch { /* 容量不足でも続ける */ }
      if (channel) channel.postMessage('changed');
    },
  });

  // 保存先の最新を取りこむ（ほかのタブの変更に追いつく）
  function sync() {
    const latest = readDb(storage);
    if (latest === undefined) return; // 読めないときは今のデータのまま
    mem.replaceRoot(latest === null ? seedDb() : latest); // キーが無い = 削除された
  }
  if (channel) channel.onmessage = sync;

  // 書く前・読む前に最新へ追いつく（2 つのタブが同時に書いても、古い内容で上書きしない）
  const net = { ...mem };
  for (const op of ['get', 'set', 'update', 'remove']) {
    net[op] = (...args) => { sync(); return mem[op](...args); };
  }
  net.clear = () => {
    storage.removeItem(DEMO_DB_KEY);
    mem.replaceRoot(seedDb());
    if (channel) channel.postMessage('changed');
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
