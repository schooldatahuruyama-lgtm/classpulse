// ZIP の索引と、必要になった項目だけの展開。ファイル名は Map の鍵としてだけ使う。
import { CONFIG } from './config.js';

const fail = (code = 'broken') => Object.assign(new Error(code), { code });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crcStep(crc, bytes) {
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc;
}

export function openZip(bytes, limits = CONFIG.pptx) {
  const { maxEntries, maxTotalBytes, signal } = { ...CONFIG.pptx, ...limits };
  const stop = () => { if (signal?.aborted) throw fail('cancelled'); };
  stop();
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const within = (p, n, end = bytes.length) => {
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(n) || p < 0 || n < 0 || p + n > end) throw fail();
  };
  const u16 = (p) => { within(p, 2); return view.getUint16(p, true); };
  const u32 = (p) => { within(p, 4); return view.getUint32(p, true); };
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6)) throw fail();
  const count = u16(end + 10);
  const size = u32(end + 12);
  const offset = u32(end + 16);
  if (count === 65535 || count > maxEntries || count !== u16(end + 8) || size === 0xffffffff || offset === 0xffffffff) throw fail();
  within(offset, size, end);
  if (offset + size !== end) throw fail(); // ZIP64 など、索引と末尾の間の別の記録は扱わない
  const decode = (start, length) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length)); }
    catch { throw fail(); }
  };
  const extra = (start, length) => {
    const endExtra = start + length;
    for (let p = start; p < endExtra;) {
      within(p, 4, endExtra);
      const id = u16(p);
      const len = u16(p + 2);
      within(p + 4, len, endExtra);
      if (id === 1) throw fail(); // ZIP64
      p += 4 + len;
    }
  };
  const entries = new Map();
  const ranges = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    within(p, 46, end);
    if (u32(p) !== 0x02014b50) throw fail();
    const flags = u16(p + 8), method = u16(p + 10);
    const crc = u32(p + 16), packed = u32(p + 20), unpacked = u32(p + 24);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    const local = u32(p + 42);
    if ((flags & 0x2041) || ![0, 8].includes(method) || u16(p + 34) || [packed, unpacked, local].includes(0xffffffff)) throw fail();
    within(p + 46, nameLen + extraLen + commentLen, end);
    const name = decode(p + 46, nameLen);
    if (!name || name.includes('\0') || entries.has(name)) throw fail();
    extra(p + 46 + nameLen, extraLen);
    within(local, 30, offset);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) throw fail();
    const ln = u16(local + 26), le = u16(local + 28);
    const data = local + 30 + ln + le;
    within(local + 30, ln + le, offset);
    within(data, packed, offset);
    if (decode(local + 30, ln) !== name) throw fail();
    extra(local + 30 + ln, le);
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== packed || u32(local + 22) !== unpacked)) throw fail();
    if (method === 0 && packed !== unpacked) throw fail();
    ranges.push([local, data + packed]);
    entries.set(name, { data, packed, unpacked, method, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw fail();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw fail();
  let total = 0;

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    async read(name, maxBytes = maxTotalBytes) {
      stop();
      const entry = entries.get(name);
      if (!entry || !Number.isFinite(maxBytes) || maxBytes < 0) throw fail();
      const { data, packed, unpacked, method, crc } = entry;
      if (unpacked > maxBytes || total + unpacked > maxTotalBytes) throw fail();
      let length = 0, checksum = -1;
      const chunks = [];
      const accept = (chunk) => {
        stop();
        length += chunk.length;
        total += chunk.length;
        if (length > maxBytes || length > unpacked || total > maxTotalBytes) throw fail();
        checksum = crcStep(checksum, chunk);
        chunks.push(chunk);
      };
      if (method === 0) accept(bytes.subarray(data, data + packed));
      else {
        let inflater;
        try { inflater = new DecompressionStream('deflate-raw'); }
        catch { throw fail('unsupported'); }
        let pos = data;
        const source = new ReadableStream({
          pull(controller) {
            if (pos === data + packed) { controller.close(); return; }
            const next = Math.min(pos + 65536, data + packed);
            controller.enqueue(bytes.subarray(pos, next));
            pos = next;
          },
        });
        const reader = source.pipeThrough(inflater).getReader();
        const cancel = () => { reader.cancel().catch(() => {}); };
        signal?.addEventListener('abort', cancel);
        try {
          while (true) {
            stop();
            const { done, value } = await reader.read();
            stop();
            if (done) break;
            accept(value);
          }
        } catch (e) {
          cancel();
          throw e?.code === 'cancelled' ? e : fail();
        } finally {
          signal?.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
      }
      if (length !== unpacked || ((checksum ^ -1) >>> 0) !== crc) throw fail();
      const result = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
      return result;
    },
  };
}
