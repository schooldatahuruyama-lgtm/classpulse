# 利用を停止した先生の削除の設計書

- 作成日: 2026-11-15
- もとになる設計書: `2026-11-13-teacher-admin-design.md`
- **ユーザーの決定:** 利用を停止したアカウントが、ずっと残るのは困る。「30 日たったら自動で消す」か「削除ボタン」のどちらかがほしい。
- **Claude の判断:** 削除ボタンにする。理由: (a) 先生の教材と授業の記録を、だれも押していないのに自動で消すのは、まちがって停止したときに取り返しがつかない。(b) 自動で消すには「いつ停止したか」の記録と、消す処理を動かす人（管理者がアプリを開いたとき）が要り、しくみが増える。ボタンなら、管理者が自分で決めて消せる。

## 1. 今の状態

- 「利用を停止」は `teacherList/<uid>` を `false` にするだけ。その先生の教材・授業の記録・設定（`teachers/<uid>`）、名簿（`teacherDirectory/<uid>`）、終わった授業の残り（`sessions/<sid>`）は、ずっと残る。自動では消えない。
- 管理者は、今の規則では、ほかの先生の `teachers/<uid>` を読むことも消すこともできない。

## 2. 作るもの

- 「先生の管理」の、**利用停止中の先生**のカードに、ボタン「削除」を足す（利用中の先生・自分には出さない）。
- 押すと確認: 題「<メールアドレス>を削除しますか？」、文「この先生の教材・授業の記録・設定が、すべて消えます。元に戻せません。ログインのためのアカウント（Firebase の Authentication）は、この画面では消えません。」、ボタン「削除する」（危険の色）「やめる」。
- 「削除する」で、次を **1 回の書きこみ**（ルートへの `update`。全部成功か、全部失敗）で消す:
  - `teachers/<uid>`（教材・一覧・授業の記録・設定・発表中の印）
  - `teacherDirectory/<uid>`、`teacherRequests/<uid>`、`teacherList/<uid>`
  - その先生の授業の残り `sessions/<sid>`: `teachers/<uid>/history` の鍵（授業の ID）すべてと、`teachers/<uid>/active` の `sid`
- 成功: トースト「削除しました。」、一覧を読みこみ直す。失敗: 「削除できませんでした。接続を確かめて、もう一度押してください。」に続けて「何度も失敗するときは、Firebase のルールが新しいものになっているか確かめてください。」

## 3. 読みこみ（消す前に、授業の ID を集める）

- `teachers/<uid>/history` は、鍵だけを読む（REST の `?shallow=true`。授業の記録の中身＝生徒の文章は読まない）。`js/net.js` に `getKeys(path): Promise<string[]>` を足す（無ければ空の配列）。練習用の通信（`js/dev/memory-net.js`）にも同じものを足す。
- `teachers/<uid>/active` を読み、`sid` が文字列で、鍵に使える文字（英数字・`-`・`_`）だけなら、消す一覧に足す。
- 消す前に `teacherList/<uid>` を読み、`false` でなければ（再開されていた・もう無い）、消さずに失敗にする。

## 4. 規則（`docs/firebase/rules.json`。先生に貼り直してもらう）

変えるのは 2 か所。ほかは 1 文字も変えない。

`teachers/$uid`（本人の読み書きはそのまま。管理者は、停止中の先生のデータを、まるごと消すことだけできる。読めるのは `history` と `active` だけ）:

```json
"teachers": {
  "$uid": {
    ".read": "auth != null && auth.uid === $uid && root.child('teacherList').child($uid).val() === true",
    ".write": "auth != null && ((auth.uid === $uid && root.child('teacherList').child($uid).val() === true) || (auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false && !newData.exists()))",
    "history": { ".read": "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false" },
    "active": { ".read": "auth != null && auth.uid !== $uid && root.child('admins').child(auth.uid).val() === true && root.child('teacherList').child($uid).val() === false" }
  }
}
```

`sessions/$sid` の `.write`（持ち主の書きこみはそのまま。管理者は、持ち主が停止中の授業・もう無い授業を、消すことだけできる）:

```
"auth != null && ((root.child('teacherList').child(auth.uid).val() === true && (data.exists() ? data.child('owner').val() === auth.uid : newData.child('owner').val() === auth.uid)) || (root.child('admins').child(auth.uid).val() === true && !newData.exists() && (!data.exists() || root.child('teacherList').child(data.child('owner').val()).val() === false)))"
```

- 1 回の `update` の中では、規則は「書く前のデータ」で確かめられるので、`teacherList/<uid>` を同じ書きこみで消しても、ほかの場所の「停止中であること」の確かめは通る（Firebase の決まり。本物では Claude Code は確かめられない）。
- 古い規則のままだと、削除は失敗する（何も消えない）。新しい規則は、古いアプリでもそのまま動く。**先に規則を貼り直してから使う。**

## 5. 端の場合

| 場合 | 動き |
|---|---|
| 自分自身 | ボタンを出さない。`repo.deleteTeacher` も例外を投げる |
| 利用中の先生 | ボタンを出さない。`repo.deleteTeacher` は、読んだ `teacherList` が `false` でなければ失敗（消さない） |
| 確認の間に、別の管理者が再開した | 消す前の確かめで失敗。すり抜けても、規則が全体を拒否する（何も消えない） |
| 授業の記録が無い・`active` が無い・`sid` がおかしい | その分は消す一覧に入れず、残りを消す |
| 記録にある授業（`sessions/<sid>`）がもう無い | 規則が「無いものを消す」を通すので、全体は成功する |
| 規則が古い | 読みこみか書きこみが拒否され、失敗の文が出る。何も消えない |
| 通信の失敗 | 失敗の文。何も消えない（1 回の書きこみなので、途中まで消えた状態にならない） |
| 削除と同時に、画面を離れた・ログアウトした | 結果を画面に出さない（今の `current()` の考え方） |
| 削除された人が、同じアカウントでもう一度ログインした | 「承認待ち」の画面になり、もう一度申しこめる（はじめての人と同じ。管理者がことわれる） |
| 削除された人が管理者でもあった（`admins/<uid>`） | `admins` はアプリから書けないので残る。手順書に「Firebase の画面で消す」と書く |
| 授業の記録が何百件もある | 1 回の `update` に全部入れる（1 件は短い鍵。大きさの上限には届かない） |

## 6. 知っている限界

- ログインのためのアカウント（メールアドレスとパスワード・Google）は、アプリからは消せない（サーバーが無いため）。Firebase の画面（Authentication → Users）で、手で消す。
- 規則のうえでは、管理者は、停止中の先生の授業の記録（`history`）の中身も読める（アプリは鍵しか読まない。鍵だけに限ることは、規則ではできない）。
- 規則の変更は、本物の Firebase で先生が貼って試すまで、確かめられていない。

## 7. 確かめ方

- 自動テスト: `getKeys`（URL に `shallow=true`、`null` は空）、`deleteTeacher`（1 回の `update` の中身、停止中でない・自分は消さない、おかしい `sid`、記録なし）、規則の文字列（上の 2 か所が設計書のとおり。ほかは変わっていない）、画面（停止中だけにボタン、確認、成功と失敗の文）。
- ブラウザ（練習モード）: 先生を登録 → 承認 → 停止 → 削除 → 一覧から消える。利用中の先生と自分にボタンが無い。
- 本物: 先生が規則を貼り直してから試す。
