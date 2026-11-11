# ClassPulse 試作1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 30 人ほどの 1 学級で、先生が iPad でスライドを映して進め、生徒が iPad で QR コードから参加して選択式アンケートに答え、結果をその場で見られる Web アプリ（試作1）を作る。その前に、学校の iPad から Firebase につながるかを確かめる（段階 0）。

**Architecture:** ビルドなしの HTML・CSS・JavaScript（ES モジュール）。保存と通信は Firebase Realtime Database と Firebase Authentication を REST と EventSource で使い、Firebase を知っているのは `js/auth.js` と `js/net.js` だけにする。進行・締切・集計は通信と画面から独立した純粋な関数（`js/session-logic.js`）に置き、`node --test` で確かめる。

**Tech Stack:** HTML / CSS / JavaScript（ES モジュール、外部パッケージなし）、Node.js 18 以上の `node --test`、Firebase Realtime Database（REST・EventSource）、Firebase Authentication（REST）、GitHub Pages、qrcode-generator 1.4.4（MIT、ファイルを 1 つ同梱）、BIZ UDPGothic（OFL、フォントファイルを同梱）。

**Spec:** `docs/superpowers/specs/2026-11-11-classpulse-design.md`（設計書）。もとの要件は `docs/requirements.md`（要件定義書）。実装する人は両方を読む。

## Global Constraints

- 作業フォルダは `C:\Users\yan12\Documents\keita\AI開発\スライドアプリ`。この外は編集しない（Task 0 で理科アプリからルールと道具をコピーするときだけ読む）。
- 進め方は `CLAUDE.md` のとおり。タスクごとに、指示書を `.ai-tasks/YYYYMMDD-HHMMSS_<内容>.md` に書く → 実装（通常はサブエージェント）→ `npm test` と差分の確認 → Codex レビュー（`tools/codex-review.ps1`。使えないときは別の Claude エージェント）→ コミット。下の各タスクの「コミット」は、このレビューが済んでから行う。
- 外部パッケージをインストールしない。`package.json` に `dependencies` を書かない。Firebase の SDK を入れない。外部の配信元（CDN、Google Fonts）から実行時に読み込まない。
- JavaScript は ES モジュール（`export` / `import`、`package.json` に `"type": "module"`）。`js/` のモジュールは、ブラウザだけにあるもの（`window`、`document`、`localStorage`、`fetch`、`EventSource`）を直接使わず、引数で受け取る（`js/views/`、`js/ui.js`、`js/slide-render.js`、`js/image.js` の `compressImage`、`js/main.js` は除く）。
- 先生や生徒が入力した文字は `textContent` で画面に出す。`innerHTML` に入れない。
- 基準の端末は iPad の Safari。操作は Pointer Events で書く。主要なボタンは 44×44px 以上、生徒の選択肢のカードは高さ 56px 以上。
- 配色は要件定義書 7.2 の値をそのまま CSS 変数にする: `#3F63F6`（メイン）、`#1F2A6B`（ネイビー）、`#45D0C2`（アクセント）、`#52C97A`（成功）、`#F4C94A`（注意）、`#E8576A`（危険）、`#A88CF6`（補助紫）、`#F6F8FF`（背景）、`#FFFFFF`（カード）、`#DCE4F5`（区切り線）。淡い色の上に白い文字を置かない。
- 書体は `BIZ UDPGothic`（400 と 700）。文字の大きさは H1 40px、H2 28px、H3 20px、本文 16px、補足 12px。角丸は 12／16／24px、余白は 8／16／24／32px。
- 状態は色だけで伝えず、文字を必ず添える。選択肢には A〜F の記号を付ける。
- 回答に名前や、名前と結びつく情報を付けない。画面に生徒の匿名 ID を出さない。
- 結果を非公開にしている質問の集計を、`sessions/<授業ID>/pub` に書かない。発表画面にも出さない。
- 締切済み（`closed`）の質問を `open` に戻す処理を書かない。
- 要件定義書 8 章と付録 A で採用しないとされたもの（参加コードの入力、共同編集、タイマー、通知、お気に入り）を足さない。
- パスワードなどの秘密をリポジトリに入れない。`js/firebase-config.js` に入れてよいのはデータベースの URL と Web API キーだけ。
- 画面の文とコードのコメントは日本語。コミットの文は理科アプリと同じ形（`feat: …`、`docs: …`、`chore: …` に日本語）。

## Review Focus

設計書が直接は書いていないが、授業で起きやすいこと。それぞれ、下に書いたタスクのテストで確かめる。

1. **Realtime Database は空の配列・空のオブジェクトを保存しない。** スライドが 0 枚の教材や、要素のない資料スライドを読み直すと、`order` や `items` が無くなって戻る。読みこんだデータは必ず `normalizeDeck` を通し、欠けていても動くこと（Task 2）。
2. **生徒が授業の途中でページを読み直す。** 同じ匿名 ID のままで参加人数が増えず、答えた質問は「送信済み」と選んだ選択肢が戻ること（Task 4、Task 7）。
3. **先生が発表の途中でページを読み直す・閉じて開き直す。** 同じスライドから続き、締切済みの質問が開き直らず、公開中の結果が消えないこと（Task 8）。
4. **ログインの期限（1 時間）が授業の途中で切れる。** 自動で更新され、変化の受信がつなぎ直されること（Task 4、Task 5）。
5. **ボタンを続けて押す。** 先生が「次へ」を 2 回すばやく押すと 2 枚進むが、処理が重なって質問の状態がこわれないこと。生徒が選択肢を変えて続けて送ると、最後の 1 つだけが残ること（Task 7、Task 8）。

## ファイルの構成

| ファイル | 役割 | 作るタスク |
|---|---|---|
| `CLAUDE.md`、`AGENTS.md`、`tools/codex-*.ps1`、`tools/codex-*-prompt.md` | 開発のルールと道具（理科アプリからコピーして書きかえ） | 0 |
| `package.json`、`.gitignore`、`README.md`、`docs/requirements.md` | リポジトリの土台 | 0 |
| `docs/firebase/setup.md`、`docs/firebase/rules.json` | Firebase の準備の手順と規則 | 1 |
| `js/firebase-config.js` | データベースの URL と Web API キー | 1 |
| `check.html` | 段階 0 の接続確認ページ | 1 |
| `tools/pages-branch.ps1` | 公開用の `pages` ブランチを作る | 1 |
| `js/config.js` | 暫定の数値 | 2 |
| `js/model.js` | 教材・スライドのデータの形、操作、検査 | 2 |
| `js/session-logic.js` | 進行・締切・集計・履歴（純粋な関数） | 3 |
| `js/errors.js` | `NetError` | 4 |
| `js/auth.js` | 先生のログイン、生徒の匿名ログイン、期限の更新 | 4 |
| `js/net.js` | データベースの読み書きと変化の受信 | 5 |
| `tests/helpers/fake-net.js`、`tests/helpers/fakes.js` | テスト用の代役 | 4、5 |
| `js/repo.js`、`js/autosave.js` | 先生の教材と履歴の読み書き、自動保存 | 6 |
| `js/outbox.js`、`js/session-client.js` | 生徒の回答の一時保存と再送、生徒側の授業の進行 | 7 |
| `js/session-host.js` | 先生側の授業の進行 | 8 |
| `index.html`、`css/base.css`、`css/app.css`、`assets/fonts/`、`js/main.js`、`js/router.js`、`js/ui.js`、`js/views/login.js` | 画面の土台とログイン | 9 |
| `js/slide-render.js`、`js/image.js`、`js/views/editor.js`、`css/editor.css` | スライドの表示と編集 | 10 |
| `js/views/dashboard.js` | 授業ダッシュボード | 11 |
| `js/lib/qrcode.js`、`js/views/present.js`、`css/present.css` | 発表 | 12 |
| `js/views/student.js`、`css/student.css` | 生徒の画面 | 13 |
| `js/views/history.js` | 授業履歴と結果 | 14 |

データベースの構造（設計書 6.1。生徒に見せるものを `pub`、生徒から届くものを `inbox` にまとめ、生徒 1 人の接続を 1 本にする）:

```
teacherList/<uid>: true
teachers/<uid>/
  deckIndex/<deckId>: { title, updatedAt, slideCount }
  decks/<deckId>: { title, updatedAt, order:[slideId], slides:{<slideId>: slide}, images:{<imageId>: dataURL} }
  active: { sid, deckId, startedAt }            … 発表中の授業（ないときは無い）
  history/<sid>: History
sessions/<sid>/
  owner: uid
  deckId, startedAt
  pub/  title, state:"live"|"ended",
        current:{ slideId, index },             … 参加の画面のときは { slideId:"", index:-1 }
        polls/<slideId>:{ status:"waiting"|"open"|"paused"|"closed", resultsVisible:bool },
        results/<slideId>:{ counts:[n], total }  … 公開中だけ
  deck/ order, slides, images                    … 発表を始めたときの写し
  inbox/ participants/<uid>: 時刻
         answers/<slideId>/<uid>: { choice:番号, at:時刻 }
```

---

### Task 0: リポジトリの準備

**Files:**
- Create: `CLAUDE.md`、`AGENTS.md`、`package.json`、`.gitignore`、`README.md`、`docs/requirements.md`、`.ai-tasks/.gitkeep`、`.ai-review/.gitkeep`
- Create（理科アプリ `..\理科アプリ\tools\` からコピー）: `tools/codex-implement.ps1`、`tools/codex-implement-prompt.md`、`tools/codex-review.ps1`、`tools/codex-review-prompt.md`
- Test: `tests/repo.test.js`

**Interfaces:**
- Produces: `npm test` が `node --test "tests/*.test.js"` を実行する。

- [ ] **Step 1:** `git init`（ブランチ名は `master`。理科アプリと同じ）。`git config user.name` と `user.email` を、`git -C ..\理科アプリ config user.name`／`user.email` と同じ値に、このリポジトリだけに設定する。
- [ ] **Step 2:** `tests/repo.test.js` を書く。テスト名「リポジトリの土台がそろっている」: `CLAUDE.md`、`AGENTS.md`、`docs/requirements.md`、`tools/codex-review.ps1`、`tools/codex-implement.ps1` が存在する。`package.json` を読み、`type === 'module'`、`scripts.test === 'node --test "tests/*.test.js"'`、`dependencies` と `devDependencies` が無いことを確かめる。
- [ ] **Step 3:** `npm test` を実行し、失敗することを確かめる（`package.json` がまだ無いので `node --test tests/repo.test.js` で実行する）。
- [ ] **Step 4:** ファイルを作る。
  - `package.json`: `name: "classpulse"`、`version: "0.1.0"`、`private: true`、`type: "module"`、`description: "ClassPulse リアルタイム参加型スライドアプリ（試作1）"`、`scripts.test`。
  - `CLAUDE.md`、`AGENTS.md`: 理科アプリのものをコピーし、次を書きかえる。フォルダ名は `スライドアプリ`、アプリ名は ClassPulse。許可の文は「**ユーザーへの許可確認は不要**（2026-11-11 にユーザーがすべての操作を承認済み）」。設計書の場所は `docs/superpowers/specs/2026-11-11-classpulse-design.md`。`-Note` の例は「アンケートの締切の処理を追加した」。AGENTS.md の秘密情報の行に「先生のパスワード」を足す。
  - `tools/` の 4 ファイル: コピーし、中の「理科クエスト」「理科アプリ」という語を ClassPulse／スライドアプリに書きかえる。動きは変えない。
  - `docs/requirements.md`: `ClassPulse_要件定義書_v1.1_UIUX統合版.md` と同じ内容（原本は残す）。
  - `.gitignore`: `node_modules/`、`*.local.json`、`.superpowers/`、`*.docx`。
  - `README.md`: アプリの 1 行の説明、資料へのリンク（要件定義書、設計書、この計画）、`npm test` の説明だけ。使い方は Task 15 で書く。
- [ ] **Step 5:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 6:** コミット: `chore: リポジトリの準備（開発ルール、道具、要件定義書、設計書、計画）`。`docs/superpowers/` の設計書と計画も入れる。

---

### Task 1: Firebase の準備と接続確認ページ（段階 0）

**Files:**
- Create: `docs/firebase/setup.md`、`docs/firebase/rules.json`、`js/firebase-config.js`、`check.html`、`tools/pages-branch.ps1`
- Test: `tests/rules.test.js`

**Interfaces:**
- Produces: `js/firebase-config.js` が `export const FIREBASE = { databaseURL: string, apiKey: string }` を出す（`databaseURL` は末尾に `/` を付けない）。

- [ ] **Step 1:** `tests/rules.test.js` を書く。
  - 「規則が JSON として読める」: `docs/firebase/rules.json` を `JSON.parse` できる。
  - 「最上位で読み書きを許していない」: `rules['.read']` と `rules['.write']` が無い。
  - 「回答はほかの生徒が読めない」: `rules.sessions.$sid.inbox` に `.read` が無く、`rules.sessions.$sid.inbox.answers.$slideId.$uid` に `.read` が無い。
  - 「回答の書きこみは受付中だけ」: 上の `$uid` の `.write` の文字列に `'open'`、`'live'`、`auth.uid === $uid` が入っている。
  - 「設定のファイルに秘密のキーがない」: `js/firebase-config.js` の文字に `password`、`secret`、`private_key` が無い。
- [ ] **Step 2:** `npm test` を実行し、`rules.test.js` が失敗することを確かめる。
- [ ] **Step 3:** `docs/firebase/rules.json` を次の内容で作る。

```json
{
  "rules": {
    "check": {
      "ping": { ".read": true },
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        ".validate": "newData.isNumber()"
      }
    },
    "teacherList": {
      "$uid": { ".read": "auth != null && auth.uid === $uid" }
    },
    "teachers": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid && root.child('teacherList').child($uid).val() === true",
        ".write": "auth != null && auth.uid === $uid && root.child('teacherList').child($uid).val() === true"
      }
    },
    "sessions": {
      "$sid": {
        ".read": "auth != null && data.child('owner').val() === auth.uid",
        ".write": "auth != null && root.child('teacherList').child(auth.uid).val() === true && (data.exists() ? data.child('owner').val() === auth.uid : newData.child('owner').val() === auth.uid)",
        "pub": { ".read": "auth != null" },
        "deck": { ".read": "auth != null" },
        "inbox": {
          "participants": {
            "$uid": {
              ".write": "auth != null && auth.uid === $uid && root.child('sessions').child($sid).child('pub').child('state').val() === 'live'",
              ".validate": "newData.isNumber()"
            }
          },
          "answers": {
            "$slideId": {
              "$uid": {
                ".write": "auth != null && auth.uid === $uid && newData.exists() && root.child('sessions').child($sid).child('pub').child('state').val() === 'live' && root.child('sessions').child($sid).child('pub').child('polls').child($slideId).child('status').val() === 'open' && root.child('sessions').child($sid).child('pub').child('current').child('slideId').val() === $slideId",
                ".validate": "newData.hasChildren(['choice', 'at']) && newData.child('choice').isNumber() && newData.child('choice').val() >= 0 && newData.child('choice').val() < 6 && newData.child('at').val() === now",
                "$other": { ".validate": "$other === 'choice' || $other === 'at'" }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4:** `js/firebase-config.js` を、値が空の `FIREBASE` で作る（ユーザーが値を知らせたら入れる）。
- [ ] **Step 5:** `check.html` を作る。このページだけで完結させ（`js/firebase-config.js` だけを読みこむ）、「確認を始める」を押すと次を順に行い、1 行ずつ「○ できました」か「× できませんでした（理由）」を文字で出す。各項目は 10 秒で打ち切る。
  1. データベースを読む: `GET <databaseURL>/check/ping.json`
  2. 匿名でログインする: `POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<apiKey>`、本文 `{"returnSecureToken":true}`
  3. データベースに書く: `PUT <databaseURL>/check/<localId>.json?auth=<idToken>`、本文は今の時刻の数
  4. 変化を受け取る: `new EventSource('<databaseURL>/check/<localId>.json?auth=<idToken>')` を開き、もう一度 3 と同じ書きこみをして、`put` のイベントが届く
  5. ログインを更新する: `POST https://securetoken.googleapis.com/v1/token?key=<apiKey>`、本文 `grant_type=refresh_token&refresh_token=<refreshToken>`
  
  最後に「5 つすべて ○ なら、このネットワークで ClassPulse を使えます」と、端末の種類（`navigator.userAgent`）を出す。配色と書体は Global Constraints のとおり（書体のファイルはまだ無いので、端末の書体でよい）。
- [ ] **Step 6:** `docs/firebase/setup.md` を書く。ユーザーが行う手順を、画面のボタン名つきで順に書く。
  1. Firebase のコンソールでプロジェクトを新しく作る（料金プランは Spark のまま。Google アナリティクスは使わない）。
  2. Realtime Database を作る（ロックモード）。URL を控える。
  3. 「ルール」に `docs/firebase/rules.json` の中身を貼って公開する。
  4. Authentication を始め、「メール／パスワード」と「匿名」を有効にする。
  5. Authentication の「ユーザー」で自分の先生アカウントを作り、UID を控える。動作確認用の先生アカウントをもう 1 つ作る。
  6. Realtime Database の「データ」で `teacherList/<UID>` に `true` を書く（2 つのアカウントとも）。
  7. プロジェクトの設定で「ウェブ API キー」を控える。
  8. データベースの URL と API キーを Claude Code に伝える（この 2 つは公開してよい値）。動作確認用のアカウントのメールアドレスとパスワードも伝える（Claude Code は `tools/test-account.local.json` に保存する。Git には入らない）。
  9. 規則の確かめ方（「ルール プレイグラウンド」で、ログインなしの `sessions/x/inbox/answers` の読み取りが拒否されることなど 4 件）。
  
  先生を増やすときの手順（5 と 6 をくり返す）も書く。
- [ ] **Step 7:** `tools/pages-branch.ps1` を理科アプリからコピーし、`pages` ブランチに入れるものを `index.html`、`check.html`、`css/`、`js/`、`assets/` にする。
- [ ] **Step 8:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 9:** コミット: `feat: Firebase の手順書と規則、接続確認ページ（段階 0）`。
- [ ] **Step 10（ユーザーの作業）:** ユーザーに次をお願いし、返事を待つ。(a) `docs/firebase/setup.md` の 1〜8。(b) GitHub に新しいリポジトリを作り、その URL を伝える。
- [ ] **Step 11:** `js/firebase-config.js` に値を入れる。`git remote add origin <URL>`、`git push -u origin master`、`tools/pages-branch.ps1` を実行して `git push origin pages`。ユーザーに GitHub の Settings → Pages で `pages` ブランチを選んでもらう。手元のブラウザで公開された `check.html` を開き、5 つとも ○ になることを確かめる。コミット: `chore: Firebase の設定値`。
- [ ] **Step 12（ゲート。ユーザーの作業）:** ユーザーに、学校の iPad で学校のネットワークから公開版の `check.html` を開いてもらう。
  - 5 つとも ○: Task 9 以降に進める。
  - 1 つでも ×: Task 4・5 と Task 9 以降を止め、どれが × だったかをユーザーに報告して、通信の仕組みを選び直す（設計書 11 章）。Task 2・3 は Firebase によらないので、結果を待たずに進めてよい。

---

### Task 2: 教材のデータ（`js/model.js`）

**Files:**
- Create: `js/config.js`、`js/model.js`
- Test: `tests/model.test.js`

**Interfaces:**
- Produces（`js/config.js`）: `export const CONFIG = { image: { maxEdge: 1280, maxBytes: 204800, deckMaxBytes: 5242880 }, autosaveDelayMs: 1000, autosaveRetryMs: 5000, resultsThrottleMs: 500, poll: { minOptions: 2, maxOptions: 6 }, idLength: 12, sessionIdLength: 22, tokenRefreshMarginMs: 300000 }`
- Produces（`js/model.js`）。どの関数も引数を書きかえず、新しい値を返す。
  - 型 `TextItem = { id, kind:'text', x, y, w, h, text, size:'s'|'m'|'l'|'xl', bold:boolean, color:string, align:'left'|'center'|'right' }`、`ImageItem = { id, kind:'image', x, y, w, h, imageId }`。`x, y, w, h` はキャンバスに対する割合（0〜1）。
  - 型 `ContentSlide = { type:'content', items: Item[] }`、`PollSlide = { type:'poll', question:string, options:string[], resultMode:'live'|'manual' }`
  - 型 `Deck = { title:string, updatedAt:number, order:string[], slides:{[id]:Slide}, images:{[id]:string} }`
  - `newId(random = Math.random, length = CONFIG.idLength): string`（英数字だけ）
  - `newSessionId(getRandomValues): string`（`crypto.getRandomValues` を受け取る。英数字 22 文字）
  - `createDeck(title: string, now: number): Deck`
  - `createSlide(type: 'content'|'poll'): Slide`（アンケートは `question:''`、`options:['','']`、`resultMode:'manual'`）
  - `createTextItem(id): TextItem`（`x:0.1, y:0.1, w:0.8, h:0.2, text:'', size:'m', bold:false, color:'#1F2A6B', align:'left'`）
  - `addSlide(deck, slide, id, afterId?): Deck`（`afterId` が無ければ最後）
  - `removeSlide(deck, id): Deck`（そのスライドだけが使っている画像も `images` から消す）
  - `moveSlide(deck, id, delta: -1|1): Deck`（端では変えない）
  - `duplicateSlide(deck, id, newSlideId, newItemId: () => string): Deck`（複製を元のすぐ後ろに置く。画像は同じ `imageId` を共有する）
  - `updateSlide(deck, id, slide): Deck`
  - `normalizeDeck(raw: any): Deck`（欠けた `order`・`slides`・`images`・`items`・`options` を補い、`order` にあって `slides` に無い ID を外し、配列がオブジェクト（`{0:…,1:…}`）で戻った場合は配列に直す）
  - `validateDeck(deck): string[]`（発表を始められない理由の文。問題がなければ空）
  - `deckImageBytes(deck): number`（`images` のデータ URL の文字数の合計）

- [ ] **Step 1:** `tests/model.test.js` を書く。
  - 「新しい教材は空」: `createDeck('光', 1000)` が `{ title:'光', updatedAt:1000, order:[], slides:{}, images:{} }`。
  - 「スライドを足す・途中に足す」: `addSlide` を 2 回、3 回目は `afterId` に 1 枚目を渡し、`order` が `['a','c','b']`。元の deck の `order` は変わらない。
  - 「順番変更は端で止まる」: 先頭に `moveSlide(…, -1)` しても `order` が同じ。
  - 「複製は元のすぐ後ろ」「複製した要素の id は新しい」。
  - 「スライドを消すと、ほかで使っていない画像も消える」「2 枚で共有している画像は残る」。
  - 「Realtime Database から戻った形を直す」（Review Focus 1）: `normalizeDeck({ title:'光', updatedAt:1 })` が `order:[]`、`slides:{}`、`images:{}`。`normalizeDeck({ title:'t', updatedAt:1, order:{0:'a'}, slides:{ a:{ type:'content' } } })` で `order` が `['a']`、`slides.a.items` が `[]`。`slides.a` が `{ type:'poll', question:'q' }` のとき `options` が `[]`、`resultMode` が `'manual'`。`order` に `'zz'` があって `slides` に無いとき外れる。`normalizeDeck(null)` が空の教材（`title:''`）。
  - 「検査」: スライド 0 枚 → `['スライドがありません。']`。質問文が空白だけのアンケート → `'3 枚目: 質問文を入れてください。'` を含む。空白だけでない選択肢が 1 つ → `'3 枚目: 選択肢を 2 つ以上入れてください。'`。選択肢 7 つ → `'3 枚目: 選択肢は 6 つまでです。'`。空白だけの選択肢が途中にある → `'3 枚目: 空の選択肢を消してください。'`。正しい教材 → `[]`。
  - 「id は英数字だけで 12 文字」「授業 ID は 22 文字で、2 回作ると違う」（`newSessionId(crypto.getRandomValues.bind(crypto))`）。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** `js/config.js` と `js/model.js` を実装する。
- [ ] **Step 4:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 5:** コミット: `feat: 教材とスライドのデータ（作成、順番変更、検査、読みこみ時の補正）`。

---

### Task 3: 進行・締切・集計（`js/session-logic.js`）

**Files:**
- Create: `js/session-logic.js`
- Test: `tests/session-logic.test.js`

**Interfaces:**
- Consumes: `Deck`、`validateDeck`（Task 2）。
- Produces。`Pub = { title, state, current:{slideId,index}, polls:{[slideId]:{status,resultsVisible}}, results?:{[slideId]:{counts,total}} }`。`Patch` は `pub` を基準にした「パス → 値」の表（例 `{ 'polls/s2/status': 'closed', 'current': { slideId:'s3', index:2 } }`）。値 `null` は削除。変更がないときは `null` を返す。
  - `buildSession(deck: Deck, deckId: string, ownerUid: string, startedAt: number): { owner, deckId, startedAt, pub: Pub, deck: { order, slides, images } }`（`current` は `{ slideId:'', index:-1 }`。アンケートのスライドごとに `{ status:'waiting', resultsVisible: resultMode === 'live' }`）
  - `goToPatch(pub: Pub, order: string[], targetIndex: number): Patch|null`（`targetIndex` が 0 未満・枚数以上・今と同じなら `null`。今のスライドがアンケートで `open` か `paused` なら `closed` にする。行き先がアンケートで `waiting` なら `open` にする）
  - `nextPatch(pub, order)`、`prevPatch(pub, order)`（`goToPatch` に今の位置 ±1 を渡す。参加の画面からの `next` は 0 枚目へ）
  - `pausePatch(pub, slideId, paused: boolean): Patch|null`（`open` ⇔ `paused` だけ。`waiting`・`closed` は `null`）
  - `resultsVisiblePatch(pub, slideId, visible: boolean): Patch|null`（`waiting` は `null`。かくすときは `'results/<slideId>': null` も入れる）
  - `tally(answers: {[uid]:{choice}}|null, optionCount: number): { counts: number[], total: number }`（`choice` が整数でない・範囲外のものは数えない）
  - `percent(count: number, total: number): number`（整数に四捨五入。`total` が 0 なら 0）
  - `applyPatch(pub: Pub, patch: Patch): Pub`（パッチを当てた新しい `pub`。テストと画面の両方で使う）
  - `closeAllPatch(pub: Pub): Patch|null`（`closed` でない質問をすべて `closed` にする。すべて `closed` なら `null`）
  - `endPatch(pub: Pub): Patch`（`state:'ended'`、`closed` でない質問をすべて `closed`、`results` を消す）
  - `buildHistory(session, inbox: { participants, answers }|null, endedAt: number): History`。`History = { title, deckId, startedAt, endedAt, participants: number, questions: [{ slideId, question, options: string[], counts: number[], total: number }] }`（`questions` は `order` の順で、アンケートのスライドだけ。一度も開かなかった質問も 0 件で入れる）

- [ ] **Step 1:** `tests/session-logic.test.js` を書く。3 枚の教材（`s1` 資料、`s2` アンケート・選択肢 2 つ・`manual`、`s3` アンケート・選択肢 3 つ・`live`）を使う。
  - 「始めたときは参加の画面で、質問は待機中」: `pub.current` が `{ slideId:'', index:-1 }`、`polls.s2` が `{ status:'waiting', resultsVisible:false }`、`polls.s3.resultsVisible` が `true`。
  - 「アンケートに着くと受付中になる」: 2 回 `next` を当てると `polls.s2.status === 'open'`。
  - 「次へ進むと前の質問は締切」: さらに `next` で `polls.s2.status === 'closed'`、`polls.s3.status === 'open'`、`current.slideId === 's3'`。この 3 つが 1 つのパッチに入っている。
  - 「前へ戻っても締切のまま」: `prev` のパッチに `'polls/s2/status'` が無く、当てたあとも `closed`。`s3` は `closed` になる。そこからもう一度 `next` しても `s3` は `closed` のまま。
  - 「端では動かない」: 最後で `nextPatch` が `null`、0 枚目で `prevPatch` が `null`。
  - 「受付の停止と再開は締切前だけ」: `open` → `pausePatch(…, true)` で `paused`。`closed` と `waiting` に対しては `null`。
  - 「停止中に次へ進むと締切」。
  - 「結果をかくすと集計も消す」: `resultsVisiblePatch(pub, 's2', false)` が `{ 'polls/s2/resultsVisible': false, 'results/s2': null }`。
  - 「集計は 1 人 1 件、変な値は数えない」: `tally({ a:{choice:0}, b:{choice:1}, c:{choice:1}, d:{choice:5}, e:{choice:'1'}, f:{} }, 2)` が `{ counts:[1,2], total:3 }`。`tally(null, 2)` が `{ counts:[0,0], total:0 }`。
  - 「割合」: `percent(1,3) === 33`、`percent(2,3) === 67`、`percent(0,0) === 0`。
  - 「すべて締め切る」: `closeAllPatch` を当てると、`waiting`・`open`・`paused` の質問がすべて `closed` で、`state` は `live` のまま。もう一度呼ぶと `null`。
  - 「授業の終了」: `endPatch` を当てると `state === 'ended'`、すべての質問が `closed`、`results` が無い。
  - 「履歴」: `participants` が人数、`questions` が 2 件で `s2` の `counts` が集計どおり、開かなかった `s3` は `counts:[0,0,0]`、`total:0`。`inbox` が `null` でも落ちない（`participants:0`）。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** `js/session-logic.js` を実装する。
- [ ] **Step 4:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 5:** コミット: `feat: 授業の進行・締切・集計のロジック`。

---

### Task 4: ログイン（`js/auth.js`）

**Files:**
- Create: `js/errors.js`、`js/auth.js`、`tests/helpers/fakes.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Produces（`js/errors.js`）: `export class NetError extends Error { constructor(code, message) }`。`code` は `'network'`（つながらない）、`'denied'`（規則が拒否）、`'auth'`（ログインが無効）、`'bad-credentials'`（メールアドレスかパスワードが違う）、`'not-teacher'`（登録されていない）、`'unknown'`。
- Produces（`tests/helpers/fakes.js`）: `fakeStorage(): { getItem, setItem, removeItem }`、`fakeFetch(handler: (url, init) => { status, body } | Error): fetch と同じ形の関数（呼び出しの記録 `.calls` つき）`、`fakeClock(start): { now(), advance(ms) }`。
- Produces（`js/auth.js`）: `createAuth({ apiKey, fetch, storage, now, role: 'teacher'|'student' })` が次を返す。
  - `signInTeacher(email, password): Promise<{ uid, email }>`
  - `signInAnonymous(): Promise<{ uid }>`（保存した更新用トークンがあれば、それを使って同じ uid に戻る。無ければ新しく作る）
  - `restore(): Promise<{ uid, email? } | null>`（保存したトークンで戻る。無い・無効なら `null`）
  - `getToken(): Promise<string>`（期限まで `CONFIG.tokenRefreshMarginMs` 未満なら更新してから返す。同時に呼ばれても更新は 1 回）
  - `forceRefresh(): Promise<string>`
  - `signOut(): void`
  - `user: { uid, email? } | null`（読み取り専用）
  - 保存先のキーは `classpulse:auth:<role>`。保存するのは `{ uid, email, refreshToken }` だけ（パスワードは保存しない）。

- [ ] **Step 1:** `tests/helpers/fakes.js` と `tests/auth.test.js` を書く。
  - 「先生のログイン」: `signInWithPassword` に `{ email, password, returnSecureToken:true }` を送り、応答 `{ localId:'T1', email, idToken:'tok1', refreshToken:'r1', expiresIn:'3600' }` から `{ uid:'T1', email }` を返す。`storage` にパスワードの文字が入っていない。
  - 「まちがったパスワード」: 応答 400 `{ error:{ message:'INVALID_LOGIN_CREDENTIALS' } }` で `NetError` の `code === 'bad-credentials'`。`EMAIL_NOT_FOUND`、`INVALID_PASSWORD` も同じ。
  - 「つながらない」: `fetch` が失敗すると `code === 'network'`。
  - 「生徒は読み直しても同じ ID」（Review Focus 2）: `signInAnonymous()` で `uid:'S1'`。同じ `storage` で新しい `createAuth` を作り `signInAnonymous()` を呼ぶと、`accounts:signUp` は呼ばれず、`securetoken` の応答 `{ user_id:'S1', id_token:'tok2', refresh_token:'r2', expires_in:'3600' }` から `uid:'S1'` が返る。
  - 「保存したトークンが無効なら作り直す」: `securetoken` が 400 `TOKEN_EXPIRED` のとき、`signInAnonymous()` は `signUp` で新しい uid を作る。`restore()` は `null` を返し、保存を消す。
  - 「期限が近づくと更新する」（Review Focus 4）: ログイン後、時計を 56 分進めて `getToken()` を呼ぶと `securetoken` が 1 回呼ばれ、新しいトークンが返る。54 分なら呼ばれない。`getToken()` を同時に 3 回呼んでも更新は 1 回。
  - 「先生と生徒の保存は別」: `role:'teacher'` と `role:'student'` が別のキーを使う。
  - 「ログアウトで保存が消える」。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** `js/errors.js` と `js/auth.js` を実装する。エンドポイント: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=`、`…/accounts:signUp?key=`、`https://securetoken.googleapis.com/v1/token?key=`（本文は `application/x-www-form-urlencoded`）。
- [ ] **Step 4:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 5:** コミット: `feat: 先生のログインと生徒の匿名ログイン（期限の自動更新つき）`。

---

### Task 5: データベースの読み書き（`js/net.js`）

**Files:**
- Create: `js/net.js`、`tests/helpers/fake-net.js`
- Modify: `tests/helpers/fakes.js`（`fakeEventSource` を足す）
- Test: `tests/net.test.js`、`tests/fake-net.test.js`

**Interfaces:**
- Consumes: `createAuth` の `getToken`、`forceRefresh`（Task 4）、`NetError`。
- Produces（`js/net.js`）: `createNet({ databaseURL, auth, fetch, EventSource })` が次を返す。パスは先頭と末尾に `/` のない文字列（例 `'sessions/abc/pub'`）。
  - `get(path): Promise<any>`（無ければ `null`）
  - `set(path, value): Promise<void>`
  - `update(path, patch): Promise<void>`（`patch` のキーは `path` からの相対パス。`/` を含んでよい。値 `null` は削除）
  - `remove(path): Promise<void>`
  - `subscribe(path, onValue: (value) => void, onStatus?: (status: 'connected'|'disconnected') => void): () => void`（最初の値と、変わるたびに全体の値を渡す。返り値は購読をやめる関数）
  - `serverTimestamp(): { '.sv': 'timestamp' }`
  - 失敗の対応: HTTP 401 はトークンを `forceRefresh` して 1 回だけやり直し、だめなら `'auth'`。403 は `'denied'`。`fetch` の失敗は `'network'`。そのほかは `'unknown'`。
- Produces（`tests/helpers/fake-net.js`）: `createFakeNet({ now?, deny?: (op: 'get'|'set'|'update'|'remove', path, value) => boolean })` が `createNet` と同じ関数に加えて、`dump(): any`（全体の写し）、`setOnline(boolean)`（`false` の間、読み書きは `NetError('network')`、購読には `'disconnected'` を知らせ、`true` に戻すと `'connected'` と今の値を渡す）を返す。メモリの中の木で、`update` の複数パス、`null` での削除、空のオブジェクトと空の配列を保存しないこと、`{'.sv':'timestamp'}` を `now()` に置きかえることを、実物と同じにする。

- [ ] **Step 1:** `tests/net.test.js` を書く（`fakeFetch` と `fakeEventSource` を使う）。
  - 「読む」: `get('a/b')` が `GET <databaseURL>/a/b.json?auth=<token>` を呼び、本文の JSON を返す。
  - 「書く・一部を書く・消す」: それぞれ `PUT`、`PATCH`、`DELETE`。`update('sessions/x/pub', { 'polls/s2/status':'closed', current:{…} })` の本文がそのままの JSON。
  - 「拒否は denied」: 403 で `code === 'denied'`。
  - 「401 は更新して 1 回やり直す」: 1 回目 401、2 回目 200 のとき成功し、`auth.forceRefresh` が 1 回呼ばれる。2 回とも 401 なら `code === 'auth'`。
  - 「変化の受信で全体の値を組み立てる」: `put` `{ path:'/', data:{ a:1, b:{ c:2 } } }` → `onValue({ a:1, b:{ c:2 } })`。続けて `put` `{ path:'/b/c', data:3 }` → `{ a:1, b:{ c:3 } }`。`patch` `{ path:'/b', data:{ d:4 } }` → `{ a:1, b:{ c:3, d:4 } }`。`put` `{ path:'/a', data:null }` → `a` が消える。`put` `{ path:'/', data:null }` → `null`。
  - 「接続の状態を知らせる」: 開いたら `'connected'`、`error` で `'disconnected'`、開き直ったら `'connected'`。
  - 「期限切れでつなぎ直す」（Review Focus 4）: `auth_revoked` のイベントで今の接続を閉じ、`forceRefresh` のあと新しいトークンの URL で開き直す。
  - 「購読をやめると閉じる」: 返り値の関数を呼ぶと `close()` が呼ばれ、以後 `onValue` が呼ばれない。
- [ ] **Step 2:** `tests/fake-net.test.js` を書く: 複数パスの `update`、`null` での削除、空のオブジェクトが保存されない（`set('a', { b:{} })` のあと `get('a')` が `null`）、購読が親の変更も子の変更も受け取る、`deny` が真のとき `NetError('denied')`、`setOnline(false)` の動き、サーバーの時刻の置きかえ。
- [ ] **Step 3:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 4:** `js/net.js`、`tests/helpers/fake-net.js`、`fakeEventSource` を実装する。変化の受信は `EventSource`（`<databaseURL>/<path>.json?auth=<token>`）の `put`・`patch`・`keep-alive`・`cancel`・`auth_revoked` を扱う。`cancel` は `'disconnected'` を知らせて閉じる。
- [ ] **Step 5:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 6:** コミット: `feat: データベースの読み書きと変化の受信`。

---

### Task 6: 教材と履歴の保存、自動保存（`js/repo.js`、`js/autosave.js`）

**Files:**
- Create: `js/repo.js`、`js/autosave.js`
- Test: `tests/repo-data.test.js`、`tests/autosave.test.js`

**Interfaces:**
- Consumes: `net`（Task 5 の形。テストでは `createFakeNet`）、`normalizeDeck`（Task 2）、`History`（Task 3）。
- Produces（`js/repo.js`）: `createRepo(net, uid)` が次を返す。
  - `isTeacher(): Promise<boolean>`（`teacherList/<uid>` が `true`）
  - `listDecks(): Promise<[{ id, title, updatedAt, slideCount }]>`（`deckIndex` から。新しい順）
  - `loadDeck(id): Promise<Deck|null>`（`normalizeDeck` を通す）
  - `saveDeck(id, deck, now): Promise<void>`（`updatedAt` を `now` にし、`decks/<id>` と `deckIndex/<id>` を 1 回の `update` で書く）
  - `deleteDeck(id): Promise<void>`（両方を 1 回で消す）
  - `getActive(): Promise<{ sid, deckId, startedAt }|null>`、`setActive(value|null): Promise<void>`
  - `listHistory(): Promise<[{ sid, title, endedAt, participants }]>`（新しい順）、`getHistory(sid): Promise<History|null>`、`saveHistory(sid, history)`、`deleteHistory(sid): Promise<void>`（`history/<sid>` と `sessions/<sid>` を消す）
- Produces（`js/autosave.js`）: `createAutosaver({ save: (deck) => Promise<void>, delayMs, retryMs, onState: (state: 'saving'|'saved'|'failed') => void, setTimeout, clearTimeout })` が `{ touch(deck): void, flush(): Promise<void>, retry(): void, hasPending(): boolean }` を返す。

- [ ] **Step 1:** `tests/repo-data.test.js` を書く。
  - 「保存すると一覧にも出る」: `saveDeck('d1', deck, 5000)` のあと `listDecks()` が `[{ id:'d1', title, updatedAt:5000, slideCount }]`。
  - 「スライドのない教材を保存して読み直せる」（Review Focus 1）: 空の教材を保存し、`loadDeck` が `order:[]`、`slides:{}`、`images:{}`。
  - 「消すと一覧からも消える」「無い教材は null」「一覧は新しい順」。
  - 「履歴の保存・一覧・削除」: 削除で `sessions/<sid>` も消える。
  - 「登録されていない uid は先生でない」。
- [ ] **Step 2:** `tests/autosave.test.js` を書く（手で進める代役のタイマーを使う）。
  - 「1 秒まとめて 1 回だけ保存する」: `touch` を 3 回、999ms では `save` が 0 回、1000ms で 1 回で、最後の deck が渡る。`onState` が `'saving'` → `'saved'`。
  - 「保存中の変更は、終わってからもう 1 回保存する」。
  - 「失敗したら変更を持ったまま再試行する」: `save` が失敗 → `'failed'`、`hasPending() === true`。5000ms 後に再試行し、成功で `'saved'`。`retry()` ですぐ再試行。
  - 「flush はすぐ保存して、終わるまで待つ」。
- [ ] **Step 3:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 4:** 実装する。
- [ ] **Step 5:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 6:** コミット: `feat: 教材と履歴の保存、自動保存`。

---

### Task 7: 生徒側の進行と、回答の一時保存（`js/outbox.js`、`js/session-client.js`）

**Files:**
- Create: `js/outbox.js`、`js/session-client.js`
- Test: `tests/outbox.test.js`、`tests/session-client.test.js`

**Interfaces:**
- Consumes: `net`、`auth.signInAnonymous`、`NetError`、`normalizeDeck`、`Pub`。
- Produces（`js/outbox.js`）: `createOutbox({ storage, send: (sid, slideId, choice) => Promise<void> })` が次を返す。
  - `put(sid, slideId, choice): Promise<Entry>`（保存してから送る。同じ質問の前の未送信は置きかえる）
  - `flush(sid): Promise<void>`（`queued` のものを送り直す）
  - `get(sid, slideId): Entry|null`、`Entry = { choice: number, state: 'sending'|'sent'|'queued'|'rejected'|'failed' }`
  - `clear(sid): void`
  - `send` が `NetError('network')` → `queued`（残す）。`NetError('denied')` → `rejected`。そのほかの失敗 → `failed`。成功 → `sent`。保存先のキーは `classpulse:outbox:<sid>`。読み直したとき `sending` のままのものは `queued` として扱う。
- Produces（`js/session-client.js`）: `createSessionClient({ net, auth, storage, sid, onChange: (state) => void })` が `{ start(): Promise<void>, select(choice): void, submit(): Promise<void>, stop(): void }` を返す。
  - `state = { phase: 'loading'|'live'|'ended'|'not-found'|'error', connection: 'connected'|'disconnected', title, slide: Slide|null, slideId, index, total, images, poll: { status, resultsVisible }|null, results: { counts, total }|null, selected: number|null, answer: Entry|null }`
  - `start`: 匿名でログイン → `sessions/<sid>/pub` を読む（`null` なら `not-found`、`state === 'ended'` なら `ended`）→ `sessions/<sid>/deck` を読む → `inbox/participants/<uid>` にサーバーの時刻を書く → `pub` を購読する。接続が戻るたびに `outbox.flush(sid)`。
  - `submit`: 質問が `open` のときだけ `outbox.put`。回答は `inbox/answers/<slideId>/<uid>` に `{ choice, at: serverTimestamp() }`。
  - `send` が `denied` で失敗したとき、最新の `pub` でその質問が `paused` なら `NetError('network')` として扱う（`queued` にして、再開後に送り直す）。`closed` なら `denied` のまま（`rejected`）。
  - `pub.state` が `ended` になったら `phase:'ended'` にして購読をやめる。

- [ ] **Step 1:** `tests/outbox.test.js` を書く。
  - 「送れたら sent」「つながらなければ queued で、flush で送る」「締切で拒否されたら rejected で、flush しても送らない」。
  - 「続けて送ると最後の 1 つだけが残る」（Review Focus 5）: 1 回目の `send` が終わる前に `put(…, 1)`、`put(…, 0)` を呼ぶ。最後に `get` が `{ choice:0, state:'sent' }` で、最後に送られた値が 0。
  - 「読み直しても送信済みが戻る」（Review Focus 2）: 同じ `storage` で新しい `createOutbox` を作り、`get` が `{ choice:1, state:'sent' }`。`sending` のまま保存されていたものは `queued`。
  - 「授業ごとに別」。
- [ ] **Step 2:** `tests/session-client.test.js` を書く（`createFakeNet` に Task 3 の `buildSession` で作った授業を入れる。`deny` で規則の代わりをする: 質問が `open` でなければ回答の `set` を拒否）。
  - 「無い授業は not-found」「終わった授業は ended」。
  - 「参加すると参加者に入る」: `dump()` の `inbox.participants` に自分の uid。
  - 「先生が進めると今のスライドが変わる」: `pub` に `nextPatch` を当てると `state.slideId` と `state.slide` が変わる。
  - 「選んだだけでは送らない」: `select(1)` のあと `inbox.answers` が空で、`state.selected === 1`、`state.answer === null`。
  - 「送ると送信済み」: `submit()` のあと `dump()` に `{ choice:1, at:<数> }`、`state.answer.state === 'sent'`。
  - 「変えて送ると上書き」: `select(0)`、`submit()` で、その質問の回答は 1 件のまま `choice:0`。
  - 「受付停止中は送らない」「締切後は送らない」: `submit()` を呼んでも `set` が呼ばれない。
  - 「切れている間は一時保存し、戻ったら送る」: `setOnline(false)` → `submit()` → `answer.state === 'queued'`、`connection === 'disconnected'` → `setOnline(true)` → `sent`。
  - 「切れている間に締め切られたら rejected」。
  - 「停止中に拒否されたら一時保存にする」。
  - 「結果は公開中だけ届く」: `pub.results.s2` が無い間 `state.results === null`。
  - 「スライドが変わると選択は消える」: 次の質問で `selected === null`。前の質問に戻ると `answer` は前に送ったもの。
  - 「授業が終わると ended」。
  - 「同じ端末で読み直すと参加人数が増えない」（Review Focus 2）: 同じ `storage` で `start` を 2 回行い、`participants` が 1 人。
- [ ] **Step 3:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 4:** 実装する。
- [ ] **Step 5:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 6:** コミット: `feat: 生徒側の進行と、回答の一時保存・再送`。

---

### Task 8: 先生側の進行（`js/session-host.js`）

**Files:**
- Create: `js/session-host.js`
- Test: `tests/session-host.test.js`

**Interfaces:**
- Consumes: `net`、`repo`（Task 6）、Task 3 の関数すべて、`validateDeck`、`newSessionId`、`CONFIG.resultsThrottleMs`。
- Produces:
  - `startSession({ net, repo, uid, deckId, deck, now, getRandomValues }): Promise<string>`（授業 ID を返す。`validateDeck` に問題があれば `Error` で、`.reasons` に文の配列。`sessions/<sid>` を書き、`repo.setActive`）
  - `createSessionHost({ net, repo, sid, onChange: (state) => void, now, setTimeout, clearTimeout })` が `{ start(): Promise<void>, next(), prev(), setPaused(boolean), setResultsVisible(boolean), end(): Promise<void>, stop(): void }` を返す。`next`〜`setResultsVisible` は `Promise<void>`。
  - `state = { phase: 'loading'|'live'|'ended'|'not-found', connection, title, order, slides, images, pub: Pub, participants: number, tallies: { [slideId]: { counts, total } } }`
  - 操作は 1 つずつ順に行う（前の書きこみが終わってから次のパッチを作る）。書きこみが成功してから `state.pub` を変える。つながっていないときは `NetError('network')` で失敗し、`state.pub` は変わらない。
  - `inbox` を購読し、変わるたびに `tallies` と `participants` を計算する。`resultsVisible` が `true` の質問は、集計が変わったら `pub/results/<slideId>` に書く（`CONFIG.resultsThrottleMs` に 1 回まで。最後の値は必ず書く）。
  - `end`: まず `pub` に `closeAllPatch` を当てて、すべての質問を締め切る（これ以後、規則が新しい回答を拒否する）→ その書きこみが成功してから `inbox` を読み直す → `buildHistory` → `repo.saveHistory` → `pub` に `endPatch` → `sessions/<sid>/inbox` と `deck` を消す → `repo.setActive(null)`。履歴の保存に失敗したら、そこで止めて失敗を返す（`state` は `live` のまま、`inbox` も残す。もう一度 `end` を呼べばやり直せる）。

- [ ] **Step 1:** `tests/session-host.test.js` を書く（`createFakeNet` と代役のタイマー）。
  - 「検査に通らない教材は始められない」: `.reasons` に Task 2 の文。`sessions` に何も書かれない。
  - 「始めると授業と、発表中の印ができる」: `sessions/<sid>/owner === uid`、`teachers/<uid>/active.sid === sid`。
  - 「次へ・前へで pub が変わる」「前へ戻っても締切のまま」。
  - 「続けて 2 回押しても状態がこわれない」（Review Focus 5）: `next()` を待たずに 2 回呼び、両方が終わると `current.index === 1`。3 回呼ぶと `index === 2` で、`s2` は `closed`、`s3` は `open`。
  - 「回答が届くと集計が変わる」: `inbox/answers/s2/u1` を書くと `state.tallies.s2` が `{ counts:[0,1], total:1 }`、`participants` が人数。
  - 「非公開の間は pub に集計を書かない」: 回答が届いても `pub.results` が無い。
  - 「公開すると書き、かくすと消す」: `setResultsVisible(true)` で `pub/results/s2` に今の集計。回答が増えると 500ms 後に更新。`setResultsVisible(false)` で消える。
  - 「すぐ表示の質問は、着いたときから書く」。
  - 「短い間に何件届いても、書きこみは 500ms に 1 回で、最後の値になる」。
  - 「つながっていないときは進めない」: `setOnline(false)` → `next()` が `code === 'network'` で失敗、`state.pub.current` は同じ、`state.connection === 'disconnected'`。
  - 「開き直すと続きから」（Review Focus 3）: 2 枚進め、`s2` を公開した状態で `stop()`。同じ `net` で新しい `createSessionHost` を `start()` すると、`current.index === 1`、`polls.s2` は `open` のまま、`pub.results.s2` が残り、`tallies` が計算し直されている。`s2` を締め切ったあとで開き直しても `closed` のまま。
  - 「終了すると履歴が残り、回答と教材の写しが消える」: `teachers/<uid>/history/<sid>` が `buildHistory` の形、`pub.state === 'ended'`、`inbox` と `deck` が無い、`active` が無い。
  - 「履歴を保存できなければ終わらせない」: `deny` で `history` への書きこみを拒否 → `end()` が失敗し、`pub.state === 'live'`、`inbox` が残る。そのあと `deny` を外して `end()` を呼ぶと成功する。
  - 「終了の処理の途中で届いた回答を失わない」: `end()` が質問を締め切ったあと（`inbox` を読む前）に、代役の `net` で `inbox/answers/s2/u9` を直接書く → 履歴の `s2` の集計にその 1 件が入っている。締め切りの書きこみより後に、規則の代わりの `deny`（`open` でなければ拒否）を通して書こうとした回答は拒否される。
  - 「無い授業は not-found」。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** 実装する。
- [ ] **Step 4:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 5:** コミット: `feat: 先生側の進行（次へ・前へ、受付の停止、結果の公開、授業の終了）`。

---

### Task 9: 画面の土台とログイン

Task 1 のゲート（Step 12）が ○ になってから始める。

**Files:**
- Create: `index.html`、`css/base.css`、`css/app.css`、`assets/fonts/`（フォント 2 つと `OFL.txt`）、`js/main.js`、`js/router.js`、`js/ui.js`、`js/views/login.js`
- Test: `tests/router.test.js`、`tests/static.test.js`

**Interfaces:**
- Consumes: `createAuth`、`createNet`、`createRepo`、`FIREBASE`。
- Produces（`js/router.js`）: `parseRoute(hash: string): { name, params }`。`''`・`'#/'` → `dashboard`、`'#/login'` → `login`、`'#/edit/<deckId>'` → `editor`、`'#/present/<sid>'` → `present`、`'#/join/<sid>'` → `join`、`'#/history'` → `history`、`'#/history/<sid>'` → `result`、そのほか → `not-found`。`routeHash(name, params): string`。`needsTeacher(name): boolean`（`login`・`join`・`not-found` 以外は `true`）。
- Produces（`js/ui.js`）: `el(tag, props?, ...children): HTMLElement`（`props.text` は `textContent` に入れる）、`confirmDialog({ title, body, okLabel, danger }): Promise<boolean>`、`statusChip(kind: 'ok'|'warn'|'danger'|'info', label): HTMLElement`（アイコンと文字）、`resultBars(container, { options, counts, total }): void`（A〜F の記号、選択肢の文、棒、件数、割合、下に「回答した N 人のうちの割合」）、`toast(message)`。
- Produces（各画面）: `js/views/<name>.js` が `export function mount(root: HTMLElement, ctx): () => void` を出す（返り値は片づけの関数）。`ctx = { net, auth, repo, navigate(name, params), params, storage }`（生徒の画面では `auth` が生徒用、`repo` は無い）。

- [ ] **Step 1:** `tests/router.test.js`（上の対応の全部と、`routeHash` との往復、授業 ID に `/` や `?` が入ったものは `not-found`）と `tests/static.test.js` を書く。`static.test.js`: `index.html` が `css/base.css` と `js/main.js`（`type="module"`）を読みこむ。`http://`・`https://` で始まる `src`／`href` が無い。`css/base.css` に Global Constraints の色コード 10 個と `BIZ UDPGothic`、`font-display: swap` がある。`assets/fonts/OFL.txt` がある。`css/base.css` の `@font-face` の `url(…)` のファイルが実在する。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** フォントを入れる。BIZ UDPGothic の Regular と Bold を woff2 で `assets/fonts/BIZUDPGothic-Regular.woff2`、`-Bold.woff2` に置く（入手先の第 1 候補: npm の `@fontsource/biz-udpgothic` の `files/biz-udpgothic-japanese-400-normal.woff2` と `…-700-normal.woff2` を 1 回だけダウンロードする。日本語の 1 ファイル版が無ければ、Google Fonts のリポジトリ `ofl/bizudpgothic/` の TTF を `.ttf` のまま置き、`@font-face` を `format('truetype')` にする）。`OFL.txt` も同じ所から置く。ファイル名・入手先・大きさを README に書く。
- [ ] **Step 4:** `css/base.css`（CSS 変数、`@font-face`、文字の大きさ、ボタン（主・ふつう・危険）、カード、入力欄、フォーカスの枠、状態のチップ）、`css/app.css`（先生の画面の骨組み: 左のナビゲーションと本体。幅 900px 未満では上のメニュー）、`index.html`、`js/ui.js`、`js/router.js` を実装する。
- [ ] **Step 5:** `js/main.js` を実装する。`hashchange` で画面を切りかえる。`join` は生徒用の `createAuth({ role:'student' })` で `student` の画面へ。そのほかは先生用の `auth.restore()` を待ち、ログインしていなければ `#/login` へ。ログインしていて `repo.isTeacher()` が `false` なら、ログアウトして「このアカウントは ClassPulse の先生として登録されていません。」を出す。まだ無い画面は「準備中」と出す。
- [ ] **Step 6:** `js/views/login.js` を実装する。見出し「ClassPulse」、入力欄「メールアドレス」「パスワード」（どちらも `label` つき）、ボタン「ログイン」。失敗の文: `bad-credentials` →「メールアドレスかパスワードが違います。」、`network` →「通信できませんでした。接続を確かめて、もう一度押してください。」、そのほか →「ログインできませんでした。」。新規登録やパスワードの再設定の案内は出さない。
- [ ] **Step 7:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 8:** ブラウザで確かめる。`python -m http.server 8765 --bind 127.0.0.1` で開き、`tools/test-account.local.json` の確認用アカウントでログインできること、まちがったパスワードで文が出ること、`#/join/xxxx` がログインなしで開くこと、幅 768px と 1024px で崩れないこと、UD フォントで表示されること（開発者ツールの「レンダリングされたフォント」）。
- [ ] **Step 9:** コミット: `feat: 画面の土台（配色、UD フォント、画面の切りかえ）とログイン`。

---

### Task 10: スライドの表示と編集

**Files:**
- Create: `js/slide-render.js`、`js/image.js`、`js/views/editor.js`、`css/editor.css`、`css/slide.css`
- Modify: `index.html`（CSS の読みこみ）
- Test: `tests/image.test.js`

**Interfaces:**
- Consumes: Task 2 の `model.js` の関数、`createAutosaver`、`repo.loadDeck`／`saveDeck`、`startSession`（Task 8）、`ui.js`。
- Produces（`js/image.js`）: `fitSize(width, height, maxEdge): { width, height }`（縦横比を保ち、長辺が `maxEdge` 以下。もともと小さければそのまま。整数）、`dataUrlBytes(dataUrl): number`、`compressImage(file: File, { maxEdge, maxBytes }): Promise<string>`（JPEG のデータ URL。画質 0.85 から 0.1 ずつ下げ、`maxBytes` 以下になった所で返す。0.45 でも超えるなら `maxEdge` を 0.75 倍にしてやり直す）。
- Produces（`js/slide-render.js`）: `renderSlide(container, slide, images, { mode: 'view'|'thumb' }): void`。16:9 の枠を作り、資料スライドは要素を割合の位置に置く（文字の大きさは枠の幅に対する割合で決める: `s` 2.5%、`m` 4%、`l` 6%、`xl` 9%）。アンケートのスライドは質問文と、A〜F の記号つきの選択肢を並べる（結果は出さない）。

- [ ] **Step 1:** `tests/image.test.js` を書く: `fitSize(4000, 3000, 1280)` が `{ width:1280, height:960 }`、`fitSize(3000, 4000, 1280)` が `{ width:960, height:1280 }`、`fitSize(800, 600, 1280)` が `{ width:800, height:600 }`、`fitSize(1281, 1, 1280)` の `height` が 1 以上。`dataUrlBytes` が文字数を返す。
- [ ] **Step 2:** `npm test` を実行し、失敗することを確かめる。
- [ ] **Step 3:** `js/image.js`、`js/slide-render.js`、`css/slide.css` を実装する。
- [ ] **Step 4:** `js/views/editor.js` と `css/editor.css` を実装する（設計書 5.3）。
  - 上の帯: 「← 一覧へ」、教材名の入力欄（空なら「無題の教材」と保存）、保存状態のチップ（「保存中…」「保存済み」「保存できませんでした」＋ボタン「もう一度保存」）、ボタン「発表を開始」。
  - 左の列: スライドの縮小表示（番号つき）。選んだスライドに枠。下にボタン「＋ 資料スライド」「＋ アンケート」。選んだスライドに「上へ」「下へ」「複製」「削除」（削除は確認「このスライドを削除しますか？」）。
  - 中央（資料スライド）: キャンバス。上にツール「文字を追加」「画像を追加」。要素をタップで選ぶ、ドラッグで動かす、右下のつまみ（44px）で大きさを変える。枠の外には出ない。文字の箱は、選んでいるときにもう一度タップすると入力できる。
  - 右の列（文字を選んだとき）: 大きさ（小・中・大・特大）、太字、色（ネイビー、メインブルー、アクセント、危険、補助紫、黒）、そろえ（左・中央・右）、「この要素を削除」。画像を選んだときは「この要素を削除」だけ。
  - 中央と右（アンケートのスライド）: 質問文の入力欄、選択肢の入力欄（A〜F の記号つき、それぞれに「削除」。2 つのときは削除を押せない）、「＋ 選択肢を追加」（6 つで押せなくなる）、結果の出し方（「先生が表示するまで出さない」「すぐ表示」）、説明の文「このアンケートは匿名です。次のスライドへ進むと締め切ります。締め切る前は、生徒は答えを変えられます。」
  - 画像を足すとき: `compressImage` で縮め、教材の画像の合計が `CONFIG.image.deckMaxBytes` を超えるなら足さずに「画像の合計が 5MB を超えるため、追加できません。ほかの画像を減らしてください。」を出す。
  - 変更のたびに `autosaver.touch`。画面を離れる・「発表を開始」を押すときは `flush` を待つ。保存に失敗している間に離れようとしたら確認「保存できていない変更があります。このまま移動しますか？」。
  - 「発表を開始」: `startSession`。`.reasons` があれば一覧で出す。成功したら `#/present/<sid>` へ。すでに発表中の授業（`repo.getActive()`）があるときは「発表中の授業があります。先にその授業を終了してください。」と、その授業へ行くボタンを出す。
  - 幅 900px 未満: 左と右の列を、ボタン「スライド一覧」「設定」で開閉するパネルにする。
- [ ] **Step 5:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 6:** ブラウザで確かめる（タッチの操作は開発者ツールのデバイス表示、幅 1024px と 768px）: 資料スライドに文字と画像を置いて動かす・大きさを変える。アンケートを作る。順番変更・複製・削除。読み直しても内容が残る。開発者ツールで通信を切ると「保存できませんでした」になり、戻すと再試行で「保存済み」になる。スライドが 0 枚で「発表を開始」を押すと理由が出る。
- [ ] **Step 7:** コミット: `feat: スライドの編集（文字・画像・選択式アンケート、自動保存）`。

---

### Task 11: 授業ダッシュボード

**Files:**
- Create: `js/views/dashboard.js`
- Modify: `css/app.css`

**Interfaces:**
- Consumes: `repo`（`listDecks`、`saveDeck`、`deleteDeck`、`loadDeck`、`getActive`、`listHistory`）、`createDeck`、`newId`、`startSession`、`ui.js`。

- [ ] **Step 1:** 実装する（設計書 5.2）。
  - ナビゲーション: 「ホーム」「授業履歴」。下に、ログイン中のメールアドレスと「ログアウト」。
  - 上: 見出し「教材」、ボタン「＋ 新規作成」（`createDeck('無題の教材', now)` を保存して編集画面へ）。
  - 発表中の授業があるとき: いちばん上に注意の色のカード「発表中の授業があります」とボタン「発表に戻る」。
  - 教材のカード: 題名、「スライド N 枚」、最終更新の日時、ボタン「編集」「発表を開始」「結果を見る」（`#/history` へ）「削除」。削除の確認: 題「この教材を削除しますか？」、本文「「<題名>」を削除します。元に戻せません。授業の記録は残ります。」、ボタン「削除する」（危険の色）。
  - 「発表を開始」: 教材を読みこみ、Task 10 と同じ流れ（検査、発表中の授業の確認）。
  - 教材が 0 件のとき:「まだ教材がありません。「＋ 新規作成」から作れます。」
  - 読みこみの失敗:「読みこめませんでした。」とボタン「もう一度」。
  - 右（幅 900px 未満では下）: 「最近の授業」（`listHistory` の上から 5 件。題名、日時、参加人数。押すと結果へ）。
- [ ] **Step 2:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 3:** ブラウザで確かめる: 新規作成 → 編集 → 一覧に戻ると出ている。削除。幅 768px でナビゲーションが上のメニューになる。キーボード（Tab と Enter）だけで新規作成と削除ができ、フォーカスの枠が見える。
- [ ] **Step 4:** コミット: `feat: 授業ダッシュボード`。

---

### Task 12: 発表の画面

**Files:**
- Create: `js/lib/qrcode.js`、`js/lib/qrcode.LICENSE.txt`、`js/views/present.js`、`css/present.css`
- Modify: `index.html`（`<script src="js/lib/qrcode.js"></script>` を足す。このファイルだけ ES モジュールでなく、`window.qrcode` を作る）
- Modify: `tests/static.test.js`（`js/lib/qrcode.js` と `qrcode.LICENSE.txt` があること）

**Interfaces:**
- Consumes: `createSessionHost`（Task 8）、`renderSlide`、`resultBars`、`statusChip`、`confirmDialog`、`percent`。`window.qrcode(0, 'M')` → `addData(url)`、`make()`、`createSvgTag({ cellSize, margin, scalable:true })`。

- [ ] **Step 1:** `js/lib/qrcode.js` を入れる: qrcode-generator 1.4.4（Kazuhiko Arase、MIT）の `qrcode.js` を 1 回だけダウンロードして置き、ライセンス文を `qrcode.LICENSE.txt` に置く。`tests/static.test.js` に確認を足す。
- [ ] **Step 2:** `js/views/present.js` と `css/present.css` を実装する（設計書 5.4）。この画面は生徒に映るので、ナビゲーション、メールアドレス、非公開の集計を出さない。
  - 参加の画面（`current.index === -1`、または「QR コード」を押したときの重ね表示）: 見出し「カメラで QR コードを読んで参加してください」、QR コード（参加の URL: 今の場所の `#` より前に `#/join/<sid>` を付けたもの。白い地に黒、画面の短い辺の 55% 以上）、URL の文字、「参加 N 人」。重ね表示には「閉じる」。
  - 本体: 今のスライドを `renderSlide` で大きく出す。
  - アンケートのスライドでは、スライドの下か横に: 状態のチップ（`open`「受付中」、`paused`「受付停止中」、`closed`「締切済み」）、「回答 N 人 ／ 参加 M 人」、結果が公開中なら `resultBars`（`state.tallies` から）。
  - 下の帯（左から）: 「← 前へ」、「3 / 12」、「次へ →」（主のボタン。いちばん大きく）、アンケートのときだけ「受付を止める」／「受付を再開」（`closed` では押せない）と「結果を表示」／「結果をかくす」、「QR コード」、右の端に離して「授業を終了」（危険の色）。
  - 「授業を終了」の確認: 題「授業を終了しますか？」、本文「参加用のリンクが使えなくなり、生徒の画面は終了の画面になります。結果は授業履歴に残ります。」、ボタン「終了する」。終了したら `#/history/<sid>` へ。
  - 最後のスライドで「次へ」は押せない。その場所に「最後のスライドです」と出す。
  - つながっていないとき: 上に注意の色の帯「接続が切れています。つなぎ直しています…」。「前へ」「次へ」などの操作を押せなくする。
  - 操作が失敗したとき: `toast`「通信できなかったため、進められませんでした。」
  - `phase` が `not-found`:「この授業は見つかりません。」とボタン「ホームへ」。`ended`: `#/history/<sid>` へ。
  - キーボード: `→`・`PageDown`・スペースで次へ、`←`・`PageUp` で前へ。
  - 画面を離れるときは `host.stop()`（授業は終わらない）。
- [ ] **Step 3:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 4:** ブラウザで確かめる（生徒の役は、Realtime Database のコンソールで `inbox/answers/<slideId>/<適当な ID>` に `{ choice:0, at:1 }` を手で書く。Task 13 のあとで通して確かめ直す）: QR コードをスマートフォンで読むと `#/join/<sid>` が開く。次へ・前へ。戻ると「締切済み」で、受付のボタンが押せない。「先生が表示するまで出さない」の質問で、「結果を表示」を押す前は画面のどこにも件数の内訳が無い（回答数だけ）。読み直しても同じスライドから続く。幅 1024×768 と 768×1024 で、帯のボタンがすべて見えて押せる。
- [ ] **Step 5:** コミット: `feat: 発表の画面（QR コード、進行、受付の停止、結果の表示、授業の終了）`。

---

### Task 13: 生徒の画面

**Files:**
- Create: `js/views/student.js`、`css/student.css`
- Modify: `index.html`

**Interfaces:**
- Consumes: `createSessionClient`（Task 7）、`renderSlide`、`resultBars`、`statusChip`。

- [ ] **Step 1:** 実装する（設計書 5.5）。縦 1 列。先生用のナビゲーションやログインへのリンクを出さない。スライドを前後に動かす操作を置かない。
  - 上の帯: 授業名、通信状態のチップ（「接続中」／「接続が切れています。つなぎ直しています」）。
  - `loading`:「授業に参加しています…」。`not-found`:「この授業は見つかりません。QR コードをもう一度読んでください。」。`ended`: 見出し「授業は終了しました」、本文「参加してくれてありがとう。このページは閉じてかまいません。」。`error`:「通信できませんでした。」とボタン「もう一度」。
  - 参加の画面のとき（`index === -1`）:「先生が始めるまで、このままお待ちください。」
  - 資料スライド: `renderSlide` を幅いっぱいに。
  - アンケートのスライド: 質問文（H2）、チップ「この質問は匿名です」、選択肢のカード（`button`。A〜F の記号と文。高さ 56px 以上、間は 16px）、ボタン「回答を送信」。
    - 選んだカード: 太い枠と「選択中」の文字。送信済みの選択肢:「送信済み」の文字とチェックの印。
    - ボタンの文と状態: 何も選んでいない → 押せない「選択肢を選んでください」。選んだ・まだ送っていない →「回答を送信」。送信済みと同じものを選んでいる → 押せない「送信済み」。送信済みと違うものを選んだ →「回答を更新」。
    - 回答の状態の文（ボタンの下。`aria-live="polite"`）: `sending`「送信中…」、`sent`「送信済み。締め切りまでは変えられます。」、`queued`「一時保存しました。つながったら自動で送ります。」、`rejected`「締め切られたため、送信できませんでした。」、`failed`「送信できませんでした。」＋ボタン「もう一度送る」。
    - `paused`: チップ「受付停止中」。カードと送信のボタンを押せなくする。`closed`: チップ「締切済み」。押せなくし、自分が送ったものがあれば「送信済み」の印を残す。
    - 結果（`state.results` があるときだけ）: `resultBars`。
- [ ] **Step 2:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 3:** ブラウザで通して確かめる。先生のタブ 1 つと、生徒として別のブラウザ（または プライベートウィンドウ）を 2 つ開く（同じブラウザのふつうのタブどうしは同じ匿名 ID になる）。要件定義書 7.8 の表を上から確かめ、結果を表にして報告に書く。
  1. 回答を送る → 受け取りの確認後に「送信済み」。先生の画面の回答数が増える。
  2. 締切前に変える → 回答数は増えず、公開した結果の内訳が変わる。
  3. 次へ → 生徒の画面も変わり、前の質問は締切。
  4. 前へ → 生徒の画面に「締切済み」。押せない。
  5. 生徒の通信を切って答える →「一時保存」。戻すと「送信済み」になり、先生の集計に入る。切っている間に先生が次へ進んだ場合は「締め切られたため、送信できませんでした」。
  6. 非公開の質問で、生徒の開発者ツールのネットワークに集計の数が届いていない。「結果を表示」で届く。「結果をかくす」で消える。
  7. 生徒が読み直す → 参加人数が増えない。答えた質問は「送信済み」が戻る。
  8. 授業を終了 → 生徒は終了の画面。終了後に参加のリンクを開くと「授業は終了しました」。
  
  幅 375px、768px（縦）、1024px（横）で文字切れがない。ブラウザの拡大 200% で、選択肢と送信のボタンが使える。Tab と Enter／スペースだけで答えられる。
- [ ] **Step 4:** コミット: `feat: 生徒の画面（参加、追従、回答と変更、状態の表示）`。

---

### Task 14: 授業履歴と結果

**Files:**
- Create: `js/views/history.js`

**Interfaces:**
- Consumes: `repo.listHistory`、`getHistory`、`deleteHistory`、`resultBars`、`percent`。`mount` は `ctx.params.sid` があれば結果、無ければ一覧を出す（`main.js` で `history` と `result` の両方をこの画面に割り当てる）。

- [ ] **Step 1:** 実装する（設計書 5.6）。
  - 一覧: 見出し「授業履歴」。行ごとに題名、実施日時（`2026年11月11日 10:45`）、「参加 N 人」。押すと結果へ。0 件のとき「まだ授業の記録がありません。」
  - 結果: 題名、実施日時（開始〜終了）、「参加 N 人」。質問ごとのカード: 「質問 1」、質問文、`resultBars`、「回答 N 人」。回答が 0 件の質問は「回答はありませんでした。」。個人ごとの一覧や匿名 ID を出さない。
  - 下に「この記録を削除」（危険の色）。確認: 題「この授業の記録を削除しますか？」、本文「元に戻せません。」。削除したら一覧へ。
  - 無い記録:「この記録は見つかりません。」
- [ ] **Step 2:** `npm test` を実行し、成功することを確かめる。
- [ ] **Step 3:** ブラウザで確かめる: Task 13 の通しで終了した授業が一覧に出て、件数と割合が発表のときと同じ。削除できる。
- [ ] **Step 4:** コミット: `feat: 授業履歴と結果`。

---

### Task 15: 見やすさの確認、README、公開

**Files:**
- Modify: `README.md`、必要に応じて `css/*.css`
- Create: `docs/reports/prototype1-check.md`

- [ ] **Step 1:** 見やすさを確かめ、足りない所を直す（要件定義書 7.9）。
  - 文字と背景のコントラスト比: `css/base.css` の文字色と背景色の組み合わせをすべて計算し、4.5:1 以上（24px 以上の太字は 3:1 以上）であること。操作部品の枠と状態のチップは隣の色と 3:1 以上。計算の表を報告に入れる。
  - 主要なボタンが 44×44px 以上、生徒の選択肢が高さ 56px 以上（開発者ツールで測る）。
  - 全部の画面で、Tab の順が見た目の順と合い、フォーカスの枠が見える。
  - 入力欄にすべて `label` がある。状態の文に `aria-live` がある。飾りのアイコンに `aria-hidden="true"` がある。
- [ ] **Step 2:** `docs/reports/prototype1-check.md` を書く: 要件定義書 7.10 のチェックリストの各行について、試作1 で確かめたこと・確かめた方法・結果・試作1 の範囲外のもの（記名、未承認投稿、復元など）を表にする。実機（iPad）で未確認のものは「未確認」と書く。
- [ ] **Step 3:** `README.md` を書く: アプリの説明、公開版の URL、先生の使い方（ログイン → 教材を作る → 発表を開始 → QR コード → 進める → 終了 → 結果）、生徒の使い方、試作1 でできないこと（設計書 3 章）、知っておくこと（同時接続は 100 まで、画像は 1 教材 5MB まで、締切後に届いた回答は入らない、授業を終了し忘れると参加のリンクが生きたまま）、先生の増やし方（`docs/firebase/setup.md`）、開発（`npm test`、手元での開き方、公開の手順）。パスワードは書かない。
- [ ] **Step 4:** `npm test` を実行し、成功することを確かめる。コミット: `docs: 試作1 の確認の記録と README`。
- [ ] **Step 5:** 公開する: `tools/pages-branch.ps1` → `git push origin master` → `git push origin pages`。公開版でログインから終了までを 1 回通す。
- [ ] **Step 6（ユーザーの作業）:** ユーザーに、学校の iPad 数台（先生 1 台はミラーリング、生徒 2〜3 台）で参加から終了までを通してもらい、気づいた点を聞く。結果を `docs/reports/prototype1-check.md` に足す。

---

## この計画に入れていないもの

設計書 2 章の段階 2〜5（残りの回答 4 種類、記名回答、投稿の承認、出力、ゴミ箱、管理者の画面、Google ログイン、Drive 連携、スライドの取込み、動画・音声、アニメーション、200 人の検証、Service Worker）。試作1 を授業で使った結果を見てから、段階ごとに設計書と計画を書く。
