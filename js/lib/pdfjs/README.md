# pdf.js（PDF を読む部品）

- 版: 6.5.438（legacy ビルド）
- 入手先: npm の `pdfjs-dist`（https://www.npmjs.com/package/pdfjs-dist）
- 配布物の shasum: `e7f8986ec4ea04057b5d9d2f0e5b63ea94d2303f`
- 作っている所: Mozilla
- ライセンス: Apache-2.0（`LICENSE`）。`wasm/` と `standard_fonts/` の中の部品は、それぞれのフォルダにあるライセンスの文に従う。

## 配布物から写したもの（中身は変えていない）

- `legacy/build/pdf.min.mjs` → `pdf.min.mjs`
- `legacy/build/pdf.worker.min.mjs` → `pdf.worker.min.mjs`
- `cmaps/`（日本語などの文字の対応表）
- `standard_fonts/`（PDF に埋めこまれていない標準フォントの代わり）
- `wasm/`（PDF の中の画像を読む部品）
- `LICENSE`

このフォルダは「PDF から作る」を押したときにだけ読みこまれる。
