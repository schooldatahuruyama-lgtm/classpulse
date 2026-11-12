# PDF からスライドを作る Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教材の一覧の「PDF から作る」で、PDF の 1 ページを 1 枚の画像としてスライド 1 枚に貼った新しい教材を作る。

**Architecture:** PDF の読み取りと画像への変換は、先生の端末の中だけで行う（pdf.js を `js/lib/pdfjs/` に置き、押したときに初めて読みこむ）。できあがるのは、今ある `content` スライドと画像の要素だけ。データベースの構造と規則は変えない。判定と組み立ては純粋なモジュールに分けてテストする。

**Tech Stack:** ビルドなしの HTML/CSS/JS（ES modules）、pdf.js（`pdfjs-dist` 6.5.438 の legacy ビルド、Apache-2.0）、`node --test "tests/*.test.js"`。

**Spec:** `docs/superpowers/specs/2026-11-12-pdf-import-design.md`

## Global Constraints

- 作業の決まりは `CLAUDE.md` と `AGENTS.md` に従う。コミットは Claude Code（指揮役）が行う。実装する人は commit しない。
- PDF のファイルそのものを、端末の外へ送らない。pdf.js の部品（worker、cmaps、fonts、wasm）は、すべて自分のサイトの中（`js/lib/pdfjs/`）から読む。外の CDN を使わない。
- 上限: ページ数 30（`CONFIG.pdf.maxPages = 30`）、ファイルの大きさ 50MB（`CONFIG.pdf.maxFileBytes = 52428800`）。
- 1 枚の画像の上限は `Math.min(CONFIG.image.maxBytes, Math.floor(CONFIG.image.deckMaxBytes / ページ数))`。長辺は `CONFIG.image.maxEdge` まで。画像は JPEG、透明は白。
- スライドは 16:9。画像の要素の位置と大きさは、スライドに対する割合（0〜1）。縦横比を変えず、収まる最大の大きさで中央に置く。
- 1 ページ = `content` のスライド 1 枚 = 画像の要素 1 つ。ページ順のまま。
- 教材は、全ページが終わってから 1 回で保存する。途中でやめたとき・失敗したときは、教材を作らない。
- pdf.js は「PDF から作る」を押したときに初めて読みこむ（`import()`）。`index.html` や、ほかの画面のモジュールから静的に読みこまない。
- 既存のテストを壊さない。画面の文は試作1 の言い回しにそろえる。
- 配布物の取り出し元: `C:\Users\yan12\AppData\Local\Temp\claude\1bd37b230d7591da\e59b7d79-f132-47e8-b729-7adef34a3ccb\scratchpad\pdfjs-dl\package`（npm の `pdfjs-dist@6.5.438`、shasum `e7f8986ec4ea04057b5d9d2f0e5b63ea94d2303f` を確認済み）。新しくダウンロードしない。

## Review Focus

1. 31 ページ以上・パスワード付き・PDF でないファイル・こわれた PDF で、教材ができず、理由が文で出る。
2. 取込みの途中で「やめる」や画面の移動をしたとき、教材が残らず、裏で処理が走り続けない。
3. 30 ページの PDF で、画像の合計が教材の上限（5MB）をこえない。
4. 縦長のページがゆがまない（左右に余白、中央）。
5. 日本語の文字（フォントが埋めこまれていない PDF も）が、文字化けや空白にならない。

---

### Task 1: 判定と組み立て（純粋な部分）

**Files:**
- Create: `js/pdf-import-logic.js`, `tests/pdf-import-logic.test.js`
- Modify: `js/config.js`

**Interfaces:**
- Consumes: `createDeck`, `newId`（`js/model.js`。今ある署名のまま使う）, `CONFIG.image`
- Produces（すべて `js/pdf-import-logic.js`）:
  - `CONFIG.pdf = { maxPages: 30, maxFileBytes: 52428800 }`
  - `checkPdfFile({ name, type, size })` → `null`（よい）か `{ code: 'not-pdf' | 'too-large' }`。PDF の判定は、`type === 'application/pdf'` か、名前が `.pdf`（大文字小文字を問わない）で終わること
  - `checkPageCount(n)` → `null` か `{ code: 'too-many', pages: n }`（`n` が 1 未満・整数でないときは `{ code: 'broken' }`）
  - `pageBudget(pageCount)` → 1 枚の上限（上の式）
  - `fitToSlide(pageWidth, pageHeight)` → `{ x, y, w, h }`（0〜1。16:9 のスライドに収めて中央）
  - `titleFromFileName(name)` → `.pdf` を取った名前。空になるなら `'PDF の教材'`。前後の空白を取り、長さは今の教材名の上限に合わせる（上限が無ければ 100）
  - `buildDeckFromPages(title, pages, now, makeId)` → 教材。`pages` は `[{ dataUrl, width, height }]`。`makeId` は ID を作る関数（テストで決まった値を返せるように引数で受ける）
  - `importMessage(error)` → 画面に出す文（設計書 3.2 の表）。`error` は `{ code, pages? }`。`code` は `'not-pdf' | 'too-large' | 'too-many' | 'password' | 'broken' | 'cancelled'`（`cancelled` は `null` を返す＝何も出さない）

- [ ] **Step 1: 失敗するテストを書く。** 少なくとも: `checkPdfFile` の 4 つの場合（型が PDF／名前だけ `.PDF`／画像／50MB + 1）／`checkPageCount(30)` は `null`、`31` は `too-many` で `pages: 31`、`0` と `1.5` は `broken`／`pageBudget(30) === 174762`、`pageBudget(1) === 204800`、`pageBudget(30) * 30 <= 5242880`／`fitToSlide(1600, 900)` は `{x:0,y:0,w:1,h:1}`、`fitToSlide(1200, 900)`（4:3）は `w === 0.75, h === 1, x === 0.125, y === 0`、`fitToSlide(595, 842)`（A4 縦）は `h === 1` で `w` が `(595/842)/(16/9)` に小数 6 けたで一致し `x === (1 - w) / 2`、`fitToSlide(2000, 500)`（とても横長）は `w === 1` で `y === (1 - h) / 2`／`titleFromFileName('理科 3 章.pdf') === '理科 3 章'`、`'.pdf'` は `'PDF の教材'`／`buildDeckFromPages` で、スライドの数とページの数が同じ、`order` がページ順、各スライドが `content` で画像の要素が 1 つ、要素の `imageId` が `images` にあり中身がその `dataUrl`、位置が `fitToSlide` の値、できた教材を `normalizeDeck` に通しても変わらない、`validateDeck` が問題を返さない／`importMessage({code:'too-many',pages:42})` に `42` と `30` が含まれる、`cancelled` は `null`。
- [ ] **Step 2: テストを実行し、失敗を確かめる。**
- [ ] **Step 3: 実装する。** 画像の要素の形は、編集画面で画像を足したときに作られる形と同じにする（`js/views/editor/` の画像を足す所を読んで合わせる）。
- [ ] **Step 4: テストを実行し、すべて通ることを確かめる。**

### Task 2: pdf.js の組みこみ、変換、一覧の画面

**Files:**
- Create: `js/lib/pdfjs/`（下の一覧）, `js/pdf-import.js`
- Modify: `js/image.js`, `js/views/dashboard.js`, `css/app.css`
- Test: `tests/image.test.js`（今ある純粋な部分が変わらないこと）

**Interfaces:**
- Consumes: Task 1 のすべて、`ctx.repo.saveDeck(id, deck, now)`（今の「新しい教材」と同じ保存のしかた）
- Produces:
  - `js/image.js`: `compressCanvas(canvas, { maxBytes })` → JPEG のデータ URL（`compressImage` の中の、画質を下げていく部分を切り出したもの。`compressImage` の動きは変えない）。画質を下げても収まらないときは `null` を返し、呼ぶ側が小さく描き直す
  - `js/pdf-import.js`: `importPdf(file, { onProgress, signal })` → `{ title, pages: [{ dataUrl, width, height }] }`。失敗は `{ code }` を持つ Error を投げる。`onProgress(done, total)`。`signal` は `AbortSignal`（中止されたら `code: 'cancelled'`）

- [ ] **Step 1: 配布物を置く。** 取り出し元から `js/lib/pdfjs/` へ、次だけを写す: `legacy/build/pdf.min.mjs`、`legacy/build/pdf.worker.min.mjs`、`cmaps/`（全部）、`standard_fonts/`（全部）、`wasm/`（全部）、`LICENSE`。`js/lib/pdfjs/README.md` に、版（6.5.438）、入手先（npm `pdfjs-dist`）、shasum、写したファイルの一覧、ライセンス（Apache-2.0。`wasm/` の中の各ライセンスの文もそのまま置く）を書く。
- [ ] **Step 2: `compressCanvas` を切り出し、`compressImage` がそれを使うようにする。テストを実行する。**
- [ ] **Step 3: `importPdf` を実装する。** `checkPdfFile` → pdf.js を `import()` → `GlobalWorkerOptions.workerSrc`、`cMapUrl`、`standardFontDataUrl`、`wasmUrl` を `js/lib/pdfjs/` の中の場所（`import.meta.url` からの相対）にする → 文書を開く（パスワードを求められたら `code:'password'`、開けなければ `code:'broken'`）→ `checkPageCount` → 1 ページずつ: 長辺が `CONFIG.image.maxEdge` になる倍率で canvas に描く（背景は白）→ `compressCanvas` を `pageBudget` で → 収まらなければ長辺を 0.75 倍にして描き直す → ページを片づけてから次へ。最後に文書を閉じ、worker を終わらせる。中止・失敗のときも必ず閉じる。
- [ ] **Step 4: 一覧の画面に「PDF から作る」を足す。** 「新しい教材」の隣。押すとファイルを選ぶ（`accept="application/pdf,.pdf"`）。進みぐあい（「PDF を読みこんでいます… 3 / 24 ページ」）と「やめる」を出す。その間、ほかのボタンを二重に押せないようにする。終わったら `buildDeckFromPages` → 保存 → その教材の編集画面へ。失敗したら `importMessage` の文を出し、教材は作らない。保存の失敗は、今の「新しい教材」の失敗と同じ出し方にする。画面を離れたら（unmount）中止する。
- [ ] **Step 5: テストを実行し、すべて通ることを確かめる。**
- [ ] **Step 6: ブラウザで確かめる（練習モード `http://127.0.0.1:8790/?demo=1`。サーバーは動いている）。** 確認用の PDF は手元で作る（外から持ってこない）。作り方の例: ブラウザで HTML を開いて印刷のかわりに、Python があれば `reportlab` は使わず、PDF の中身を直接書く小さなスクリプトで作る（1 ページ・3 ページ・31 ページ、横長と A4 縦、日本語を含むもの。日本語は、フォントを埋めこまない PDF でも試す）。作ったスクリプトと PDF は scratchpad に置き、リポジトリに入れない。確かめること: 横長がほぼ全面／A4 縦が中央で左右に余白／日本語が読める／31 ページが断られる／PDF でないファイルが断られる／途中で「やめる」と教材ができない／取り込んだ教材を開いてアンケートを足せる／発表して生徒のタブでページが見える／一覧やほかの画面を開いただけでは pdf.js が読みこまれない（ネットワークの記録で確かめる）／コンソールにエラーが無い。練習モードの保存容量（`localStorage`）に入りきらないときに、保存できなかったことが分かること。確かめたことと、できなかったことを報告に書く。

### Task 3: 仕上げ（指揮役が行う）

- [ ] **Step 1: 練習モードで通す。** PDF から作る → アンケートと自由記述を足す → 発表 → 回答 → 終了 → 履歴。
- [ ] **Step 2: `tools/pages-branch.ps1` で作った `pages` ブランチに `js/lib/pdfjs/` が入ることを確かめる。**
- [ ] **Step 3: `README.md` に、PDF から作る方法、上限（30 ページ、50MB）、データの量の目安（設計書 4.4）を足す。`docs/reports/` に確認の結果を書く。**
- [ ] **Step 4: `tools/codex-review.ps1` で査読を受け、直す。**
- [ ] **Step 5: 公開する（`pages` を作り直して送る）。公開版で pdf.js のファイルが開けることを確かめる。**
