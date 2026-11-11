// 画像を端末で縮める。fitSize と dataUrlBytes は純粋な関数（Node でも動く）。
// compressImage だけはブラウザの Image・canvas を使う。

// 縦横比を保ち、長辺を maxEdge 以下にした大きさ（整数）。もともと小さければそのまま
export function fitSize(width, height, maxEdge) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / long;
  return {
    width: w >= h ? maxEdge : Math.max(1, Math.min(maxEdge, Math.round(w * scale))),
    height: h > w ? maxEdge : Math.max(1, Math.min(maxEdge, Math.round(h * scale))),
  };
}

// データ URL の大きさ（文字数。教材の画像の合計と同じ数え方）
export function dataUrlBytes(dataUrl) {
  return String(dataUrl ?? '').length;
}

// ファイルを画像として読みこむ（向きはブラウザが EXIF に合わせる）
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

// 画質（0.85 → 0.45 を 0.1 ずつ）。小数の誤差を避けるため整数で数える
const QUALITIES = [85, 75, 65, 55, 45].map((q) => q / 100);

// JPEG のデータ URL にする。maxBytes 以下になった所で返す。0.45 でも超えるなら長辺を 0.75 倍にしてやり直す
export async function compressImage(file, { maxEdge, maxBytes }) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('画像のファイルではありません');
  const img = await loadImage(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('画像の大きさがわかりません');
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  let edge = maxEdge;
  while (edge >= 16) {
    const { width, height } = fitSize(srcW, srcH, edge);
    canvas.width = width;
    canvas.height = height;
    // 透明な部分は白にする（JPEG は透明を持てない）
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    for (const q of QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (!url.startsWith('data:image/jpeg')) throw new Error('JPEG にできませんでした');
      if (dataUrlBytes(url) <= maxBytes) return url;
    }
    edge = Math.floor(edge * 0.75);
  }
  throw new Error('画像を小さくできませんでした');
}
