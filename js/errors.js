// 通信やログインの失敗を表す共通のエラー
// code: 'network'（つながらない）, 'denied'（規則が拒否）, 'auth'（ログインが無効）,
//       'bad-credentials'（メールアドレスかパスワードが違う）, 'email-exists'（登録済み）,
//       'invalid-email'（メールアドレスの形が違う）, 'weak-password'（パスワードが短い）,
//       'signup-disabled'（登録を受けつけていない）, 'account-exists'（別のログイン方法で登録済み）,
//       'google-failed'（Google ログインの失敗）, 'drive-auth'（Drive の確認切れ）,
//       'drive-denied'（Drive の保存拒否）, 'drive-failed'（Drive の保存失敗）, 'unknown'
export class NetError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'NetError';
    this.code = code;
  }
}
