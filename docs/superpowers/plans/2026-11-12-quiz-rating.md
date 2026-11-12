# クイズと 5 段階評価 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正解のある選択問題（`quiz`）と、1〜5 から選ぶ評価（`rating`）の 2 つのスライドの種類を足す。

**Architecture:** どちらも今のアンケートのしくみ（回答 `{ choice, at }`、集計 `{ counts, total }`、`pub/polls`、`pub/results`）に乗せる。クイズの正解は、授業の写しから外して `sessions/<sid>/host/quiz/<slideId>` に置き、「正解を表示」のときだけ `pub/results/<slideId>.correct` に書く。Firebase の規則は変えない。

**Tech Stack:** ビルドなしの HTML/CSS/JS（ES modules）、Firebase（REST と EventSource）、`node --test "tests/*.test.js"`。

**Spec:** `docs/superpowers/specs/2026-11-12-quiz-rating-design.md`

## Global Constraints

- 作業の決まりは `CLAUDE.md` と `AGENTS.md` に従う。コミットは指揮役が行う。実装する人は commit しない。
- `docs/firebase/rules.json` を変えない。
- 種類の名前は `'quiz'` と `'rating'`。クイズの正解の項目名は `correct`（0 からの番号）。評価の項目名は `lowLabel`・`highLabel`（それぞれ 20 文字まで、空でもよい）と `resultMode`。`CONFIG.rating = { steps: 5, labelMaxLength: 20 }`。
- 「正解を表示」の前に、正解を、授業の写し（`sessions/<sid>/deck`）・`pub`・先生の画面の DOM・生徒の端末の状態のどこにも入れない。先生の画面の DOM に、選択肢ごとの人数も入れない。
- クイズで結果を表示したら、同じ書きこみでその質問を `closed` にする。締切済みの質問を `open` に戻さない。
- 評価の回答の `choice` は 0〜4。授業の写しの評価のスライドには `options: ['1','2','3','4','5']` を入れる。
- 生徒の uid を DOM・`pub`・履歴に入れない。
- アンケート・自由記述・ワードクラウドの動きを変えない。今あるテスト（493 件）を壊さない。`type` の無い古い履歴、今ある教材が、そのまま読める。
- アンケートのために作ったもの（`tally`、`resultBars`、選ぶ・送る・変えるの流れ、結果の公開の間引き）を、写して増やすのではなく、共通にして使う。
- 正解・不正解は、色だけでなく文字や印でも分かるようにする。画面の文は今の言い回しにそろえる。

## Review Focus

1. 「正解を表示」の前に、生徒の端末が受け取るデータ（`pub`、`deck`）と、どの画面の DOM にも正解が無い。
2. 「正解を表示」のあと、回答を変えたり新しく送ったりできない（通信の遅れ、保管中の回答の再送を含む）。
3. 編集で選択肢を消したり並べかえたりしても、正解が別の選択肢にずれない。
4. 正答率と平均の計算（0 人のとき、不正な回答がまざったとき）。
5. アンケート・自由記述・ワードクラウドとまざった授業で、5 種類とも今までどおり動く。

---

### Task 1: データの決まり・送信・進行（画面以外）

**Files:**
- Modify: `js/config.js`, `js/model.js`, `js/session-logic.js`, `js/repo.js`, `js/session-client.js`, `js/session-host.js`（`js/outbox.js` は、値が整数のままなので変えないはず。必要なら変える）
- Test: 今ある `tests/model.test.js`, `tests/session-logic.test.js`, `tests/repo-data.test.js`, `tests/session-client.test.js`, `tests/session-host.test.js`, `tests/rules.test.js`（規則が変わっていないことの確認だけ）

**Interfaces（Produces）:**
- `createSlide('quiz')` → `{ type:'quiz', question:'', options:['',''], correct:0 }`。`createSlide('rating')` → `{ type:'rating', question:'', lowLabel:'', highLabel:'', resultMode:'manual' }`
- `normalizeDeck`: `quiz` は `poll` と同じ正し方に加え、`correct` が 0 以上・選択肢の数未満の整数でなければ 0。`rating` は `question`・`lowLabel`・`highLabel` を文字列に（言葉は 20 文字で切る）、`resultMode` を `'live'` か `'manual'` に
- `validateDeck`: `quiz` は `poll` と同じ問題（質問文が空、選択肢が空）を返す。`rating` は質問文が空のときだけ
- 選択肢を消す操作の関数（今 `poll` 用にあるものを読んで合わせる）: `quiz` で消したとき、正解を消したら `correct` は 0、正解より前を消したら 1 減らす。選択肢の並べかえがあるなら、正解がついていく
- `buildSession`:
  - `quiz`: `polls[id] = { status:'waiting', resultsVisible:false }`。写しのスライドから `correct` を外す。返す値に `host: { quiz: { <id>: correct } }` を足す（クイズが 1 つも無ければ `host` を足さない）
  - `rating`: `polls[id] = { status:'waiting', resultsVisible: resultMode === 'live' }`。写しのスライドに `options: ['1','2','3','4','5']` を足す
- `resultsVisiblePatch(pub, slideId, visible, { closeOnShow })`: 第 4 引数（省略可）。`closeOnShow` が真で `visible` が真のとき、`status` が `closed` でなければ `polls/<id>/status: 'closed'` も入れる。今ある呼び出しの動きは変えない
- `average(counts)` → 平均（小数 1 けたに丸めた数）。合計が 0 なら `null`。`counts[i]` は `i + 1` 点
- `correctRate(counts, correct)` → `{ correctCount, total, percent }`。`total` が 0 なら `percent` は `null`
- `buildHistory(session, inbox, endedAt, hidden, quiz)`: 第 5 引数 `quiz` は `{ <slideId>: 正解の番号 }`（省略可。無ければ `correct` は `null`、`correctCount` は 0）。項目の形は設計書 4.4
- 履歴を読むとき、`quiz`・`rating` の項目を正す（`counts` を数の配列に、`average` を数か `null` に、など）
- session-client: `kind` が `'quiz'`・`'rating'` のとき、今の `select` / `submit`（アンケートの選ぶ・送る）がそのまま使える。`quiz` で結果が表示されたら、状態に `correct`（`pub/results/<id>.correct`。表示前は `null`）と、自分の答えが合っていたか `isCorrect`（`true` / `false` / 答えていなければ `null`）
- session-host: 今のスライドが `quiz`・`rating` のとき、`kind` と、アンケートと同じ集計の項目。ただし `quiz` で `resultsVisible` が偽の間は、内訳（`counts`）と正解を状態に入れず、回答の人数だけを入れる。表示中は `correct` と `correctRate` も入れる。`quiz` の `setResultsVisible(true, slideId)` は `closeOnShow` で締め切り、`pub/results/<id>` に `{ counts, total, correct }` を書く。`rating` は表示中 `average` を入れる。`start()` は `host.quiz` を読む。`end()` は `host/quiz` を読み直して `buildHistory` に渡す

- [ ] **Step 1: 失敗するテストを書く。** 少なくとも: `createSlide` の 2 つの形／`normalizeDeck`（`correct` が範囲外・小数・文字列 → 0、評価の言葉が 21 文字 → 20 文字）／選択肢を消したときの正解（正解を消す、前を消す、後ろを消す）／`buildSession`: 写しを `JSON.stringify` して `"correct"` が含まれない、`host.quiz` に正解、評価の写しに `options`、クイズが無い教材では `host` が無い、アンケートは今までどおり／`resultsVisiblePatch` の `closeOnShow`（`open` → `closed` が入る、すでに `closed` なら入らない、`visible:false` では入らない、第 4 引数なしは今までどおり）／`average([0,0,0,0,0]) === null`、`average([1,0,0,0,1]) === 3`、`average([0,1,2,0,0]) === 2.7`／`correctRate([3,5,0], 1)` は `{ correctCount:5, total:8, percent:63 }`、0 人は `percent:null`／`buildHistory` のクイズと評価の項目、uid が含まれない／古い履歴がそのまま読める／client: クイズと評価のスライドで選んで送れる、クイズで結果が表示される前の状態に `correct` が無い（`null`）、表示後に `correct` と `isCorrect`、表示後（`closed`）は送れない／host: クイズで非表示の間、状態を `JSON.stringify` しても正解の番号を示す項目と `counts` が無い、`setResultsVisible(true)` の 1 回の書きこみに `status:'closed'` と `resultsVisible:true` が両方入る、`pub/results/<id>` に `correct` が入る、かくすと消える、締切のまま再表示できる、評価の `average`、`end()` の履歴に正解と正答率／`tests/rules.test.js`: 規則のファイルがこの作業で変わっていない（今ある検証がそのまま通る）。
- [ ] **Step 2: テストを実行し、失敗を確かめる。**
- [ ] **Step 3: 実装する。**
- [ ] **Step 4: テストを実行し、すべて通ることを確かめる。**

### Task 2: 編集・生徒・発表・履歴の画面

**Files:**
- Modify: `js/slide-render.js`, `js/views/editor.js`, `js/views/editor/inspector.js`, `js/views/editor/slide-list.js`, `js/views/student.js`, `js/views/present.js`, `js/views/history.js`, `js/ui.js`（足すだけ）, `css/*.css`
- Test: 純粋な関数に切り出したもの

**Interfaces（Consumes）:** Task 1 のすべて（実際にできた形は Task 1 の報告を読む）。

- [ ] **Step 1: 編集画面。** 「クイズ」と「5 段階評価」を足す。クイズは、選択肢ごとに「正解」を選ぶ所（1 つだけ選べる。色だけでなく文字でも分かる）。評価は、質問・両はしの言葉・結果の出し方。縮小表示とキャンバスの見本。編集画面には正解を出してよい（先生の準備の画面）。
- [ ] **Step 2: 生徒の画面。** クイズはアンケートと同じ流れ。正解の表示のあと、設計書 3.2 の文と印。評価は 1〜5 のボタンと両はしの言葉、結果は棒と平均。
- [ ] **Step 3: 発表画面。** クイズ: 表示前は人数だけ、ボタンは「正解を表示」／「正解をかくす」、表示中は内訳・正解の印・正答率。評価: 棒と平均。表示前のクイズで、内訳と正解の要素を作らない。
- [ ] **Step 4: 授業の結果。** クイズと評価の項目（設計書 3.4）。
- [ ] **Step 5: テストを実行する。**
- [ ] **Step 6: 練習モード（`http://127.0.0.1:8790/?demo=1`）で通して確かめる。** 必ず実際に調べて報告に書く: (a) クイズに 2 人が答えた・正解は未表示のとき、発表画面の `innerHTML` に「正解」の印も内訳の数字も無い。(b) 同じとき、`localStorage` の `classpulse:demo:db` の `sessions/<sid>/deck` と `sessions/<sid>/pub` を `JSON.stringify` して `correct` が無い（`host/quiz` にだけある）。(c) 「正解を表示」→ `status` が `closed`、発表画面に内訳・正解・正答率、正解した生徒のタブに「正解です」、まちがえた生徒のタブに正解の文、どちらのタブも選び直して送れない。(d) 「正解をかくす」→ 消える、`pub/results/<id>` が無い、受付は再開しない。(e) 評価: 2 人が答える → 結果と平均が発表画面と生徒のタブで合う。(f) 終了 → 履歴にクイズの正答率と評価の平均。(g) 5 種類がまざった教材で通る。(h) どの画面の `innerHTML` にも生徒の uid が無い。(i) コンソールにエラーが無い。

### Task 3: 仕上げ（指揮役）

- [ ] 査読（`tools/codex-review.ps1`）を受けて直す。README と `docs/reports/stage2-check.md` に書き足す。公開する（規則の貼り直しはいらない）。
