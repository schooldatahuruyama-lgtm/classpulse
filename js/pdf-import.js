// PDF の各ページを画像（JPEG）にする。読み取りと変換は、すべてこの端末の中で行う（ファイルは外へ送らない）。
// pdf.js は大きいので、importPdf を初めて呼んだときに読みこむ（ほかの画面のモジュールから静的に読みこまない）。
// 失敗は { code } を持つ Error を投げる（code は pdf-import-logic.js の importMessage に渡す）。
import { CONFIG } from './config.js';
import { compressCanvas } from './image.js';
import { checkPdfFile, checkPageCount, pageBudget, titleFromFileName } from './pdf-import-logic.js';

// pdf.js の部品の場所（このファイルからの相対。公開先の /classpulse/ の下でも動くように）。URL は / で終える
const lib = (path) => new URL(`./lib/pdfjs/${path}`, import.meta.url).href;

let pdfjsPromise = null;

// pdf.js を読みこむ（1 回だけ。失敗したら次に押したときにやり直す）
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./lib/pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = lib('pdf.worker.min.mjs');
      return pdfjs;
    }).catch(() => {
      pdfjsPromise = null;
      // 部品を読みこめなかった（通信が切れている、など）。PDF がこわれているのとは別に知らせる
      throw importError('load-failed');
    });
  }
  return pdfjsPromise;
}

function importError(code, extra = {}) {
  return Object.assign(new Error(code), { code }, extra);
}

const MIN_EDGE = 16; // これより小さくはしない（compressImage と同じ）

// file: 選んだファイル。onProgress(終わったページ数, 全ページ数)。signal: 中止の合図（AbortSignal）。
// 返す値: { title, pages: [{ dataUrl, width, height }] }。width・height はページの大きさ（向きを反映したもの。縦横比に使う）
export async function importPdf(file, { onProgress = () => {}, signal } = {}) {
  const aborted = () => !!(signal && signal.aborted);
  const stopIfAborted = () => { if (aborted()) throw importError('cancelled'); };

  const bad = checkPdfFile({ name: file && file.name, type: file && file.type, size: file && file.size });
  if (bad) throw importError(bad.code);
  stopIfAborted();

  let pdfjs;
  let data;
  try {
    [pdfjs, data] = await Promise.all([loadPdfjs(), file.arrayBuffer()]);
  } catch (e) {
    stopIfAborted();
    throw e && e.code === 'load-failed' ? e : importError('broken');
  }
  stopIfAborted();

  // 部品はすべて自分のサイトの中から読む。パスワードを求められたら、画面に入力を出さずに失敗にする（onPassword を渡さない）
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: lib('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: lib('standard_fonts/'),
    wasmUrl: lib('wasm/'),
    enableXfa: false,
  });
  data = null;
  let renderTask = null;
  let canvas = null;
  // 中止されたら、描いている最中のページも文書の読みこみも止める
  const onAbort = () => {
    if (renderTask) renderTask.cancel();
    task.destroy().catch(() => {});
  };
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      stopIfAborted();
      if (e && e.name === 'PasswordException') throw importError('password');
      throw importError('broken');
    }
    stopIfAborted();

    const total = doc.numPages;
    const count = checkPageCount(total);
    if (count) throw importError(count.code, count.pages ? { pages: count.pages } : {});
    onProgress(0, total);

    const maxBytes = pageBudget(total);
    canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    const pages = [];
    for (let n = 1; n <= total; n++) {
      let page;
      try {
        page = await doc.getPage(n);
      } catch {
        stopIfAborted();
        throw importError('broken');
      }
      try {
        const base = page.getViewport({ scale: 1 });
        if (!(base.width > 0 && base.height > 0)) throw importError('broken');
        let edge = CONFIG.image.maxEdge;
        let dataUrl = null;
        // 長辺が edge になる倍率で描く。画質を下げても上限に収まらなければ、長辺を 0.75 倍にして描き直す
        while (!dataUrl) {
          if (edge < MIN_EDGE) throw importError('broken');
          const viewport = page.getViewport({ scale: edge / Math.max(base.width, base.height) });
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          // 透明な部分は白にする（JPEG は透明を持てない）
          g.fillStyle = '#FFFFFF';
          g.fillRect(0, 0, canvas.width, canvas.height);
          renderTask = page.render({ canvasContext: g, viewport, background: '#FFFFFF' });
          try {
            await renderTask.promise;
          } catch {
            stopIfAborted();
            throw importError('broken');
          } finally {
            renderTask = null;
          }
          stopIfAborted();
          try {
            dataUrl = compressCanvas(canvas, { maxBytes });
          } catch {
            throw importError('broken');
          }
          edge = Math.floor(edge * 0.75);
        }
        pages.push({ dataUrl, width: base.width, height: base.height });
      } finally {
        // 次のページの前に、このページの描画用のデータを片づける（iPad のメモリを使いすぎないため）
        try { page.cleanup(); } catch { /* 文書がもう閉じている */ }
      }
      onProgress(n, total);
    }
    return { title: titleFromFileName(file.name), pages };
  } catch (e) {
    // 思わぬ例外も、中止なら cancelled、それ以外は broken にそろえる
    if (aborted()) throw importError('cancelled');
    if (e && typeof e.code === 'string') throw e;
    throw importError('broken');
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    // 文書を閉じ、worker を終わらせる（成功・失敗・中止のどれでも）
    try { await task.destroy(); } catch { /* もう閉じている */ }
  }
}
