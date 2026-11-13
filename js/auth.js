// Firebase Authentication（REST）でのログインとトークンの管理
// fetch・storage・now は引数で受け取る（環境に依存しない）。
// 保存するのは { uid, email, refreshToken } だけ。ID トークンと期限はメモリにだけ持つ。
import { CONFIG } from './config.js';
import { NetError } from './errors.js';

const IDT = 'https://identitytoolkit.googleapis.com/v1';
const INVALID_TOKEN = ['TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_GRANT_TYPE', 'MISSING_REFRESH_TOKEN'];
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
  let gen = 0; // 認証状態の世代。ログアウトや別のログインで進み、古い応答を捨てるのに使う

  async function post(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new NetError('network', 'ネットワークにつながりません');
    }
    let body = null;
    let readFailed = false;
    try { body = await res.json(); } catch { readFailed = true; }
    if (!res.ok) {
      const message = !readFailed && body && body.error && body.error.message;
      const err = new NetError(codeFor(res.status, message), message || `HTTP ${res.status}`);
      err.status = res.status;
      err.firebaseMessage = message || '';
      throw err;
    }
    // 成功なのに本文を読めない（途中で切れた）ときは通信失敗として扱う
    if (readFailed) throw new NetError('network', '応答を読み取れませんでした');
    return body;
  }

  function postJson(path, payload) {
    return post(`${IDT}/${path}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // 応答の必須項目を検べる。足りなければ unknown（状態は変えない）
  function parseBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const uid = b.localId ?? b.user_id;
    const tok = b.idToken ?? b.id_token;
    const rt = b.refreshToken ?? b.refresh_token;
    const seconds = Number(b.expiresIn ?? b.expires_in);
    if (typeof uid !== 'string' || !uid || typeof tok !== 'string' || !tok
      || typeof rt !== 'string' || !rt || !Number.isFinite(seconds) || seconds <= 0) {
      throw new NetError('unknown', '応答の形が正しくありません');
    }
    return { uid, idToken: tok, refreshToken: rt, seconds };
  }

  // 開始時の世代と今が違えば、その処理の結果は捨てる
  function assertCurrent(g) {
    if (g !== gen) throw new NetError('auth', 'ログイン状態が変わったため、古い応答を捨てました');
  }

  function persist() {
    const saved = { uid: user.uid, refreshToken };
    if (user.email) saved.email = user.email;
    storage.setItem(storageKey, JSON.stringify(saved));
  }

  // 世代を進める。進行中の更新は古いものとして切り離し、次の更新は新しく始める
  function bumpGen() {
    gen += 1;
    refreshing = null;
  }

  function clearState() {
    bumpGen();
    user = null;
    refreshToken = null;
    idToken = null;
    expiresAt = 0;
    storage.removeItem(storageKey);
  }

  // ログイン・更新の応答を取り込む（camelCase と snake_case の両方に対応）
  function adopt(body, email) {
    const f = parseBody(body);
    const uid = f.uid;
    idToken = f.idToken;
    refreshToken = f.refreshToken;
    expiresAt = now() + f.seconds * 1000;
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

  // 更新用トークンで ID トークンを取り直す。
  // 保存を消すのは「トークンの無効が確定したとき」（securetoken が 400 で無効の理由を返したとき）だけ。
  async function doRefresh() {
    if (!refreshToken) throw new NetError('auth', 'ログインしていません');
    const g = gen;
    const rt = refreshToken;
    let body;
    try {
      body = await post(`${SECURETOKEN}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
      });
    } catch (e) {
      if (e instanceof NetError && e.status === 400 && INVALID_TOKEN.includes(e.firebaseMessage) && g === gen) {
        clearState();
        e.invalid = true;
      }
      throw e;
    }
    assertCurrent(g);
    parseBody(body);
    adopt(body);
    return idToken;
  }

  function refresh() {
    if (!refreshing) {
      const p = doRefresh().finally(() => { if (refreshing === p) refreshing = null; });
      refreshing = p;
    }
    return refreshing;
  }

  // 保存したトークンで戻る。{ user, g }（g は戻した時点の世代）。
  // 無い・無効が確定したなら user は null（通信失敗・古い応答は例外のまま）
  async function restoreImpl() {
    const saved = readSaved();
    if (!saved) return { user: null, g: gen };
    user = saved.email ? { uid: saved.uid, email: saved.email } : { uid: saved.uid };
    refreshToken = saved.refreshToken;
    try {
      await refresh();
    } catch (e) {
      if (e && e.invalid) return { user: null, g: gen }; // 無効が確定したときだけ null（世代は自分の消去で進んだ）
      throw e; // 一時的な失敗・古い応答は保存を残して伝える
    }
    return { user: { ...user }, g: gen };
  }

  async function restore() {
    return (await restoreImpl()).user;
  }

  return {
    async signUpTeacher(email, password) {
      if (role !== 'teacher') throw new NetError('unknown', '生徒の auth では使えません');
      const g = gen;
      let body;
      try {
        body = await postJson('accounts:signUp', { email, password, returnSecureToken: true });
      } catch (e) {
        const m = String(e && e.firebaseMessage || '');
        let code = 'unknown';
        if (m === 'EMAIL_EXISTS') code = 'email-exists';
        else if (m === 'INVALID_EMAIL' || m === 'MISSING_EMAIL') code = 'invalid-email';
        else if (m.startsWith('WEAK_PASSWORD')) code = 'weak-password';
        else if (m === 'OPERATION_NOT_ALLOWED' || m === 'ADMIN_ONLY_OPERATION') code = 'signup-disabled';
        else if (e && e.code === 'network') code = 'network';
        // サーバーの生のエラー文は残さない（入力の内容が含まれる場合がある）
        throw new NetError(code, '登録できませんでした');
      }
      assertCurrent(g);
      parseBody(body);
      bumpGen();
      adopt(body, body.email ?? email);
      return { ...user };
    },

    async signInTeacher(email, password) {
      const g = gen;
      const body = await postJson('accounts:signInWithPassword', { email, password, returnSecureToken: true });
      assertCurrent(g);
      parseBody(body);
      bumpGen();
      adopt(body, body.email ?? email);
      return { ...user };
    },

    async signInWithGoogleIdToken(googleIdToken, requestUri) {
      if (role !== 'teacher') throw new NetError('google-failed', '生徒の auth では使えません');
      const g = gen;
      let body;
      try {
        body = await postJson('accounts:signInWithIdp', {
          postBody: new URLSearchParams({ id_token: googleIdToken, providerId: 'google.com' }).toString(),
          requestUri, returnSecureToken: true, returnIdpCredential: true,
        });
        if (body && (body.needConfirmation === true
          || body.errorMessage === 'EMAIL_EXISTS' || body.errorMessage === 'FEDERATED_USER_ID_ALREADY_LINKED')) {
          throw new NetError('account-exists');
        }
        if (body && body.errorMessage) throw new NetError('google-failed');
        parseBody(body);
      } catch (e) {
        const m = String(e && e.firebaseMessage || '');
        let code = 'google-failed';
        if ((e && e.code === 'account-exists') || m === 'EMAIL_EXISTS' || m === 'FEDERATED_USER_ID_ALREADY_LINKED') code = 'account-exists';
        else if (e && e.code === 'network') code = 'network';
        // ID トークンなどが含まれうる、サーバーの生のエラー文は残さない。
        throw new NetError(code, 'Google でログインできませんでした');
      }
      assertCurrent(g);
      bumpGen();
      adopt(body, body.email);
      return { ...user };
    },

    async signInAnonymous() {
      const r = await restoreImpl();
      if (r.user) return { uid: r.user.uid };
      const g = r.g;
      const body = await postJson('accounts:signUp', { returnSecureToken: true });
      assertCurrent(g);
      parseBody(body);
      bumpGen();
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
