# ClassPulse

リアルタイム参加型スライドアプリ（試作1）。

## 資料

- [要件定義書](docs/requirements.md)
- [設計書](docs/superpowers/specs/2026-11-11-classpulse-design.md)
- [試作1の実装計画](docs/superpowers/plans/2026-11-11-classpulse-prototype1.md)

## テスト

```
npm test
```

Node.js 組み込みのテストランナー（`node --test`）で `tests/*.test.js` を実行する。依存パッケージは無い。

## 画面を手元で試す（練習モード）

```
python -m http.server 8765 --bind 127.0.0.1
```

`http://127.0.0.1:8765/?demo=1` を開く。`localhost`・`127.0.0.1`・`[::1]` で `?demo=1` を付けたときだけ、データをこのパソコンの中（localStorage）に置く練習モードになる。先生はどんなメールアドレスとパスワードでもログインできる。それ以外の場所では `?demo=1` は無視される。

## フォント

画面の書体は BIZ UDPGothic（SIL Open Font License 1.1。`assets/fonts/OFL.txt`）。

| ファイル | 入手先 | 大きさ |
| --- | --- | --- |
| `assets/fonts/BIZUDPGothic-Regular.woff2` | npm の `@fontsource/biz-udpgothic`（`files/biz-udpgothic-japanese-400-normal.woff2`、jsDelivr 経由で 1 回だけ取得） | 1,319,288 バイト |
| `assets/fonts/BIZUDPGothic-Bold.woff2` | 同上（`…-700-normal.woff2`） | 1,335,452 バイト |
| `assets/fonts/OFL.txt` | Google Fonts リポジトリ `ofl/bizudpgothic/OFL.txt` | 4,408 バイト |
