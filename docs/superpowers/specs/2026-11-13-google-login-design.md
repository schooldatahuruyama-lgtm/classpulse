# Google アカウントでのログインの設計書

- 作成日: 2026-11-13
- もとになる設計書: `2026-11-11-classpulse-design.md`（段階 3 の 3 つ目）、`2026-11-13-teacher-admin-design.md`（承認待ちのしくみ）
- 要件定義書の項目: 5 章の一部（Google アカウントでのログイン）

「ユーザーの決定」は先生が決めたこと、「Claude の判断」は Claude Code が決めたことである。

## 1. 目的

先生が、このアプリ用のパスワードを覚えなくても、Google アカウントでログインできるようにする。

## 2. 入れるもの・入れないもの

### 入れるもの（ユーザーの決定。チャットで案を示して承認）

- ログイン画面と登録の画面に「Google でログイン」のボタン。押すと Google の画面に移り、アカウントを選ぶと、アプリに戻ってログインできる。
- はじめての人が Google で入ったら、承認待ちになる（承認のしかたは今と同じ）。
- メールアドレスとパスワードでのログインは残す。
- 学校・自治体のアカウントと、個人のアカウントの両方を想定する（ユーザーの決定:「両方の可能性があります」）。
- アプリが Google から受け取るのは、メールアドレスだけ。

### 入れないもの

- 生徒の Google ログイン（生徒は今までどおりログイン不要）。
- Google Drive など、ほかの Google のサービスへのアクセス（段階 3 の 4 つ目で別に設計する）。
- ログインできるドメインをしぼる設定（承認待ちのしくみで足りる）。
- 1 つのアカウントに、Google とパスワードの両方を結び付ける画面。

### してはいけないこと

- 外部のスクリプトを読みこむ（Google の SDK・Firebase の SDK を使わない。今までどおり REST だけ）。
- Google から受け取った ID トークンを、保存する・URL や履歴に残す・ログに出す。
- `state` と `nonce` を確かめずに、URL に付いてきたトークンでログインする。
- 設定（クライアント ID）が空のときに、ボタンを出す・今までのログインをこわす。

## 3. しくみ（Claude の判断）

SDK を使わないので、OpenID Connect の「ID トークンを URL のうしろ（フラグメント）で受け取る」流れを自分で行う。

1. ボタンを押す → `state` と `nonce`（それぞれ乱数 16 バイト以上。`crypto.getRandomValues`）を作り、`sessionStorage` の `classpulse:google-login` に `{ state, nonce, at }` を入れる。
2. 次の URL へ移る（ページごと移動）:
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=<クライアント ID>&redirect_uri=<戻る場所>&response_type=id_token&scope=openid%20email&nonce=<nonce>&state=<state>&prompt=select_account`
   - 戻る場所は `location.origin + location.pathname`（例: `https://schooldatahuruyama-lgtm.github.io/classpulse/`）。問い合わせ（`?…`）とハッシュは付けない。
3. Google が、戻る場所に `#state=…&id_token=…`（失敗なら `#error=…&state=…`）を付けて戻す。
4. アプリの起動時（道順を見る前）に、ハッシュが `id_token=` か `error=` をふくむ Google の戻りかを見る。そうなら:
   - まず、ハッシュを `#/login` に置きかえる（`history.replaceState`。トークンを URL と履歴に残さない）。
   - `sessionStorage` の `{ state, nonce, at }` を取り出して、すぐ消す。
   - 確かめる: 保存があり、10 分以内で、`state` が同じ。ID トークン（JWT）の中身の `nonce` が同じ。1 つでもちがえば、ログインしない。
   - `accounts:signInWithIdp` に `{ postBody: "id_token=<ID トークン>&providerId=google.com", requestUri: <戻る場所>, returnSecureToken: true, returnIdpCredential: true }` を送る。
   - 成功したら、今のログインと同じように `{ uid, email, refreshToken }` だけを保存し、ホームへ進む（先生として使えるかどうかは、今の入口の確認が決める: 使える → ホーム、まだ → 承認待ち、停止 → 停止の文）。
5. 失敗の文（ログイン画面の上に出す）:
   - 利用者が Google の画面でやめた（`error=access_denied`）→「Google でのログインをやめました。」
   - `state`・`nonce` が合わない、保存が無い、時間切れ →「Google でのログインを確かめられませんでした。もう一度ためしてください。」
   - Firebase が受けつけない（`OPERATION_NOT_ALLOWED`、`INVALID_IDP_RESPONSE` など）→「Google でログインできませんでした。管理者の先生に知らせてください。」
   - 同じメールアドレスの別のログイン方法と結び付けられない（応答に `needConfirmation: true`、または `EMAIL_EXISTS`・`FEDERATED_USER_ID_ALREADY_LINKED`）→「このメールアドレスは、パスワードでのログインに登録されています。メールアドレスとパスワードでログインしてください。」
   - 通信 →「通信できませんでした。接続を確かめて、もう一度ためしてください。」

### 設定

- `js/firebase-config.js` に `googleClientId: ''` を足す（公開してよい値。秘密ではない）。空のときは、ボタンを出さず、Google の戻りも処理しない。
- 練習モードでは、ボタンを出さない。

### 規則

- `teacherRequests/$uid` の `.write` の `auth.provider === 'password'` を `auth.provider !== 'anonymous'` に変える（Google で入った人も申しこめるように。メールアドレスの一致は `.validate` が今までどおり確かめる）。ほかは変えない。

## 4. 画面

- ログイン画面: フォームの下、「はじめて使う先生はこちら」の上に、区切り「または」と、ボタン「Google でログイン」。
- 登録の画面: フォームの下に、区切り「または」と、ボタン「Google で登録・ログイン」、説明「Google アカウントを使うと、パスワードを決めなくても登録できます。」
- 承認待ちの画面: 変えない（Google で入ったはじめての人には「まだ登録されていません」と「利用を申しこむ」が出る）。
- ボタンを押したら、移動するまで押せなくする。

## 5. 知っている限界・未確認の前提

- 未確認（先生の設定のあとに、先生が試す）: Google の「ID トークンを直接返す流れ」が、このアプリのクライアント ID で通ること。Firebase が、その ID トークンを受けつけること（クライアント ID が、Firebase の Google ログインの設定にあるものと同じである必要がある）。規則の `auth.provider` が Google のログインで `'anonymous'` 以外になること。
- 未確認: 同じメールアドレスのパスワードのアカウントがあるときの動き。Firebase の決まりでは、Google のログインが優先され、同じ uid のまま、パスワードでのログインが使えなくなる可能性がある（先生に説明済み）。
- 学校・自治体のアカウントは、管理している人が外のアプリへのログインを止めていると、Google の画面で止まる（先生に説明済み）。アプリの側では変えられない。
- Google の同意画面が「テスト中」のままだと、登録した人しかログインできない。手順書に「公開する」を書く（メールアドレスだけを受け取るアプリは、Google の審査がいらない）。

## 6. 確かめ方

- 自動テスト: URL の組み立て（項目と値、戻る場所に `?` と `#` が付かない）、戻りの読み取り（成功・失敗・関係のないハッシュ）、`state`・`nonce`・時間切れ・保存なしの判定、JWT の中身の読み取り（こわれたトークンで例外を投げない）、`signInWithIdp` の送る中身と、保存にトークンが残らないこと、失敗の種類、設定が空ならボタンを出さない・戻りを処理しない、規則の文。
- ブラウザ（練習モード・設定が空）: 今までのログイン・登録・承認待ちが変わらない。ボタンが出ない。
- 本物の Firebase: 先生が設定のあとに試す（個人のアカウント、学校のアカウント、今のメールアドレスと同じ Google アカウント）。
