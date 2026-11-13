// 選んだ PowerPoint の画像を、この端末だけで JPEG に変える。ホームから遅延読みこみする。
import { CONFIG } from './config.js';
import { openZip } from './zip-read.js';
import { compressImage } from './image.js';
import { abortable } from './pdf-import-logic.js';
import { checkPptxFile, readPptx, imageType, imageBudget } from './pptx-import-logic.js';
export { buildDeckFromPptx, importMessage, summaryMessage } from './pptx-import-logic.js';

const error = (code) => Object.assign(new Error(code), { code });

export async function importPptx(file, { onProgress = () => {}, signal } = {}) {
  const stop = () => { if (signal?.aborted) throw error('cancelled'); };
  const wait = (p) => abortable(p, signal, () => error('cancelled'));
  const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    stop();
    const invalid = checkPptxFile(file);
    if (invalid) throw error(invalid.code);
    try { new DecompressionStream('deflate-raw'); } catch { throw error('unsupported'); }
    const buffer = await wait(file.arrayBuffer());
    stop();
    if (buffer.byteLength > CONFIG.pptx.maxFileBytes) throw error('too-large');
    const zip = openZip(new Uint8Array(buffer), { ...CONFIG.pptx, signal });
    const result = await readPptx(zip, { name: file.name, signal, yieldTask });
    stop();
    const media = new Set(result.slides.flatMap((s) => s.items.filter((it) => it.kind === 'image').map((it) => it.media)));
    const maxBytes = imageBudget(media.size);
    const images = Object.create(null), failed = new Set();
    onProgress(0, result.slides.length);
    for (let i = 0; i < result.slides.length; i++) {
      await wait(yieldTask());
      stop();
      const items = [];
      for (const item of result.slides[i].items) {
        stop();
        if (item.kind === 'text') { items.push(item); continue; }
        if (!Object.hasOwn(images, item.media) && !failed.has(item.media)) {
          // ZIP の破損や展開上限の超過は、画像の変換失敗とは分けて全体を中止する。
          const bytes = await wait(zip.read(item.media, CONFIG.pptx.maxImageBytes));
          stop();
          try {
            images[item.media] = await wait(compressImage(new Blob([bytes], { type: imageType(item.media) }), {
              maxEdge: CONFIG.image.maxEdge, maxBytes,
            }));
            stop();
          } catch (e) {
            stop();
            failed.add(item.media);
          }
        }
        if (failed.has(item.media)) result.skipped.image++;
        else items.push(item);
      }
      result.slides[i] = { items };
      stop();
      onProgress(i + 1, result.slides.length);
    }
    stop();
    return { ...result, images };
  } catch (e) {
    stop();
    if (['cancelled', 'not-pptx', 'too-large', 'too-many', 'unsupported', 'broken'].includes(e?.code)) throw e;
    throw error('broken');
  }
}
