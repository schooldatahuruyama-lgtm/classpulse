// バイナリを置かずに、名前と中身の表から小さな ZIP / PowerPoint を作る。
import { deflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let crc = -1;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

export function makeZip(entries, { deflate = false, descriptor = false, comment = '' } = {}) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, input] of Object.entries(entries)) {
    const data = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
    const filename = Buffer.from(name), packed = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data), flags = 0x800 | (descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(deflate ? 8 : 0, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    const desc = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      desc.writeUInt32LE(0x08074b50); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(packed.length, 8); desc.writeUInt32LE(data.length, 12);
    }
    locals.push(local, filename, packed, desc);
    directory.push(central, filename);
    offset += local.length + filename.length + packed.length + desc.length;
  }
  const cd = Buffer.concat(directory), end = Buffer.alloc(22), tail = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(tail.length, 20);
  return Buffer.concat([...locals, cd, end, tail]);
}

export const rels = (entries) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
export const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
export const sp = (text = '本文', { transform = '', ph = '', body, id } = {}) => `<p:sp><p:nvSpPr>${id === undefined ? '' : `<p:cNvPr id="${id}"/>`}<p:nvPr>${ph ? `<p:ph ${ph}/>` : ''}</p:nvPr></p:nvSpPr><p:spPr>${transform}</p:spPr><p:txBody>${body ?? `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`}</p:txBody></p:sp>`;
export const pic = (id = 'image', transform = '') => `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill><p:spPr>${transform}</p:spPr></p:pic>`;
export const slide = (items = '', attrs = '') => `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" ${attrs}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${items}</p:spTree></p:cSld></p:sld>`;
export const layout = (items = '', master = false) => `<p:${master ? 'sldMaster' : 'sldLayout'}><p:cSld><p:spTree>${items}</p:spTree></p:cSld></p:${master ? 'sldMaster' : 'sldLayout'}>`;
export function pptxEntries(slides = [slide(sp())], { width = 16000000, height = 9000000, order, extra = {} } = {}) {
  order ??= slides.map((_, i) => i + 1);
  return {
    'ppt/presentation.xml': `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${order.map((i) => `<p:sldId id="${255 + i}" r:id="s${i}"/>`).join('')}</p:sldIdLst>${width === null ? '' : `<p:sldSz cx="${width}" cy="${height}"/>`}</p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(slides.map((_, i) => [`s${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])),
    ...Object.fromEntries(slides.map((xml, i) => [`ppt/slides/slide${i + 1}.xml`, xml])),
    ...extra,
  };
}
export function fileFrom(entries, options = {}) {
  const bytes = makeZip(entries, options);
  return { name: '練習教材.pptx', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
