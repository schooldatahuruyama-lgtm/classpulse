# ワードクラウド Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 短い言葉を 1 人 3 つまで集め、多くの人が書いた言葉ほど大きく教室の画面に映すスライドの種類 `cloud` を足す。

**Architecture:** 自由記述（`free`）と同じ作りに乗せる。進行は `pub/polls`、回答は `inbox/answers/<slideId>/<uid>: { words:[…], at }`、かくした言葉は `host/hidden/<slideId>/<言葉の鍵>`。言葉は `pub` に書かず、先生の端末が `inbox` から雲を作る。

**Tech Stack:** ビルドなしの HTML/CSS/JS（ES modules）、Firebase（REST と EventSource）、`node --test "tests/*.test.js"`。パッケージは足さない。

**Spec:** `docs/superpowers/specs/2026-11-12-word-cloud-design.md`（自由記述の設計: `2026-11-12-free-text-design.md`）

## Global Constraints

- 作業の決まりは `CLAUDE.md` と `AGENTS.md` に従う。コミットは指揮役が行う。実装する人は commit しない。
- 種類の名前は `'cloud'`。回答の項目名は `words`（文字列の配列、1〜3 個）。`CONFIG.cloud = { maxWords: 3, maxLength: 20, maxShown: 60 }`。
- 「結果を表示」の前に、先生の画面の DOM に言葉を 1 文字も入れない。状態（`onChange` に渡すもの）にも入れない。
- 生徒の uid を DOM（属性も含む）・`pub`・履歴に入れない。言葉を `pub` に書かない。`cloud` では `pub/results/<slideId>` を書かない。
- 言葉は `textContent` で入れる。
- 締切済みの質問を `open` に戻さない。
- アンケート（`poll`）と自由記述（`free`）の動きを変えない。今あるテスト（424 件）を壊さない。古い保管データ（`{choice}`・`{text}`）がそのまま読める。
- 自由記述のために作ったしくみ（outbox の値の型、`hide`、`classpulse:hidden:<sid>`、`renderSlide` の `sample`、生徒の画面の入力欄を作り直さない工夫）を、写して増やすのではなく、共通にして使う。
- 画面の文は、ひらがな多めの今の言い回しにそろえる。色・余白・フォントは `css/base.css` の変数を使う。

## Review Focus

1. 表示前の先生の画面・状態に、言葉が無い。
2. かくした言葉が、あとから同じ言葉（全角・半角や大文字・小文字がちがう形も）が届いても、読み直しても、映らない。
3. 1 人が同じ言葉を何度書いても、書き直しても、人数が 1 より増えない。書き直しで消した言葉は数から消える。
4. 4 個以上・21 文字以上・空白だけ・文字列でない言葉が、画面でも規則でも通らない。
5. アンケートと自由記述がまざった授業で、3 種類とも今までどおり動く。

---

### Task 1: データの決まり・規則・送信・進行（画面以外）

**Files:**
- Modify: `js/config.js`, `js/model.js`, `js/session-logic.js`, `js/repo.js`, `js/outbox.js`, `js/session-client.js`, `js/session-host.js`, `docs/firebase/rules.json`, `docs/firebase/setup.md`
- Test: 今ある `tests/model.test.js`, `tests/session-logic.test.js`, `tests/repo-data.test.js`, `tests/rules.test.js`, `tests/outbox.test.js`, `tests/session-client.test.js`, `tests/session-host.test.js`

**Interfaces（Produces）:**
- `createSlide('cloud')` → `{ type:'cloud', question:'' }`。`normalizeDeck`・`validateDeck` は `free` と同じ扱い
- `js/session-logic.js`:
  - `normalizeWords(raw)` → 送る言葉の配列（1〜3 個）か `null`。`raw` は配列か、`0`・`1`・`2` の鍵を持つもの。各要素は前後の空白を取り、文字列でない・空・20 をこえるものは捨てる。言葉の鍵が同じものは 1 つにする（先のものを残す）。4 個目以降は捨てる。1 つも残らなければ `null`
  - `wordKey(word)` → 言葉の鍵（NFKC、つづく空白を 1 つに、小文字）
  - `hiddenKey(word)` → `host/hidden` に使う鍵（`wordKey` を `encodeURIComponent` し、`.` を `%2E` に）
  - `cloudList(answers, hidden)` → `{ items:[{ key, word, count }], hiddenItems:[{ key, word, count }], total }`。`key` は `hiddenKey`。`word` は画面に出す形（設計書 4.3）。並びは `count` の多い順、同じなら `key` の順。`total` は回答した人数
  - `buildSession`: `cloud` にも `polls[id] = { status:'waiting', resultsVisible:false }`
  - `buildHistory`: `cloud` は `{ slideId, type:'cloud', question, words:[{word,count}], hiddenWords:[{word,count}], total }`。uid も鍵も入れない
- 履歴を読むとき、`cloud` の `words`・`hiddenWords` を配列に正し、各要素を `{ word:文字列, count:数 }` に正す
- 規則: 設計書 4.2 のとおり、3 つの場合に分ける。`words` は名前つきの子として書き、その下の `$i` で 1 つずつ検証する
- outbox / session-client: 値の 3 つ目の型「文字列の配列」。保管の形は `{ words, state }`。同じ値かどうかは、中身で比べる。状態に `kind:'cloud'` と、送信済み・送信中の `words`（無ければ `null`）。`client.submitWords(rawList)`（今のスライドが `cloud` で受付中のときだけ、`normalizeWords` を通ったものを送る。送信済みと同じなら送らない）。`retry()` と書きかけの保存（`draft` / `setDraft`。値は 3 つの入力欄の文字列の配列）も `cloud` で使える
- session-host: 今のスライドが `cloud` のとき `kind:'cloud'`、`answerCount`（`cloudList().total`）、`cloudItems`（`resultsVisible` が `true` のときだけ `items` の先頭 `CONFIG.cloud.maxShown` 個、それ以外は `null`）、`cloudMore`（出していない語の数。表示中だけ）。`host.hide(slideId, key)` は今のものをそのまま使う（`key` に `hiddenKey` を渡す）。`cloud` では `pub/results` を書かない。`end()` の履歴に反映する

- [ ] **Step 1: 失敗するテストを書く。** 少なくとも: `normalizeWords(['  ねこ ', 'ネコ', 'いぬ', 'とり'])` の結果（`'ネコ'` は NFKC で `'ねこ'` と同じにならないので残る。半角カナ `'ﾈｺ'` と `'ネコ'` は同じ鍵になる）、`normalizeWords(['ABC','abc','ａｂｃ'])` は 1 つ、空白だけ・21 文字・数値は捨てる、全部だめなら `null`、`{0:'a',2:'b'}` も読める／`wordKey('  Ａ  b ')` が `'a b'`／`hiddenKey('a.b/c')` に `. / $ # [ ]` が含まれない／`cloudList`: 3 人が `['ねこ','いぬ']`,`['ねこ']`,`['ネコ','ﾈｺ']` → `ねこ` 2、`いぬ` 1、`ネコ` 1（1 人の重複は 1）、`total` 3、かくした鍵は `hiddenItems` へ、表示の形は多い方／`buildHistory` に uid も `hiddenKey` も含まれない／`buildSession`・`goToPatch` が `cloud` で動く／規則の文字列に `cloud` の場合がある・JSON として正しい／outbox: `{words}` の保管と読みこみ、古い `{choice}`・`{text}` が読める、送信中に別の言葉へ書き直すと最後のものが残る／client: `submitWords` の送信・同じ値は送らない・4 個以上や 21 文字は送る前に落ちる・締切後は `rejected`・アンケートのスライドでは何もしない／host: 非表示の間は状態に言葉が無い（`JSON.stringify`）、表示で `cloudItems`、`hide` で消えて `answerCount` は変わらない、あとから同じ言葉（全角・半角ちがい）が届いても出ない、作り直した host でも出ない、61 語あるとき `cloudItems` は 60 個で `cloudMore` は 1、`pub/results` に書かない、`end()` の履歴。
- [ ] **Step 2: テストを実行し、失敗を確かめる。**
- [ ] **Step 3: 実装する。**
- [ ] **Step 4: `docs/firebase/setup.md` の自由記述の注意の近くに、ワードクラウドの 1 行を足す。**
- [ ] **Step 5: テストを実行し、すべて通ることを確かめる。**

### Task 2: 編集・生徒・発表・履歴の画面

**Files:**
- Modify: `js/slide-render.js`, `js/views/editor.js`, `js/views/editor/inspector.js`, `js/views/editor/slide-list.js`, `js/views/student.js`, `js/views/present.js`, `js/views/history.js`, `css/slide.css`, `css/editor.css`, `css/student.css`, `css/present.css`, `css/app.css`
- Test: 純粋な関数に切り出したもの（`tests/student-view.test.js` など）

**Interfaces（Consumes）:** Task 1 のすべて（実際にできた形は Task 1 の報告を読む）。

- [ ] **Step 1: 編集画面。** 「ワードクラウド」を足す。質問文だけ。縮小表示とキャンバスの見本（入力欄 3 つの見本）。自由記述と同じ道を通す。
- [ ] **Step 2: 生徒の画面。** 入力欄 3 つ（`maxlength` 20）と「送信」／「送り直す」。入力欄を作り直さない。書きかけを保存する。送信状態・一時停止・締切・「前の画面を見てください」は自由記述と同じ。ボタンを押せる条件（1 つ以上の言葉があり、送信済みの値とちがう）は純粋な関数にしてテストする。
- [ ] **Step 3: 発表画面。** 表示前は「回答 n 人 / 参加 m 人」だけ。表示中は雲。文字の大きさは人数から決める（純粋な関数にしてテストする: 全員同じ人数なら同じ大きさ、最大の人数が最大の大きさ、最小が最小の大きさ）。並びは言葉から決まる順。`cloudMore` があれば「ほか n 語」。言葉をタップすると確認（「『〇〇』 3 人」「かくす」「とじる」）。「かくす」で `host.hide(slideId, key)`（Promise の失敗を必ず受ける）。`hiddenUnsaved` の表示は自由記述と同じ文でよい（「かくした回答を保存できていません」）。
- [ ] **Step 4: 授業の結果。** 回答した人数、言葉と人数の一覧、「授業中にかくした言葉」。
- [ ] **Step 5: テストを実行する。**
- [ ] **Step 6: 練習モード（`http://127.0.0.1:8790/?demo=1`）で通して確かめる。** 設計書 5 章の流れ。必ず実際に調べて報告に書く: (a) 言葉が 2 人分ある・結果は非表示のとき、発表画面の `document.body.innerHTML` にその言葉が無い。(b) 表示中の発表画面と履歴の `innerHTML`・属性に、生徒の uid が無い。(c) 2 人が同じ言葉（片方は全角・半角ちがい）を書くと 1 つにまとまり、大きく出る。(d) かくす → 消える、人数は変わらない、別の生徒が同じ言葉を書き直して送っても出ない、発表画面を読み直しても出ない。(e) 終了 → 履歴に言葉と人数、かくした言葉は分かれる。(f) アンケート・自由記述・ワードクラウドがまざった教材で通る。(g) どのタブにもコンソールのエラーが無い。

### Task 3: 仕上げ（指揮役）

- [ ] 査読（`tools/codex-review.ps1`）を受けて直す。README と `docs/reports/stage2-check.md` に書き足す。
- [ ] 先生に `rules.json` の貼り直しをお願いしてから公開する（規則が先、アプリがあと）。
