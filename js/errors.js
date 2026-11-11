// 通信やログインの失敗を表す共通のエラー
// code: 'network'（つながらない）, 'denied'（規則が拒否）, 'auth'（ログインが無効）,
//       'bad-credentials'（メールアドレスかパスワードが違う）, 'not-teacher'（登録されていない）, 'unknown'
export class NetError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'NetError';
    this.code = code;
  }
}
