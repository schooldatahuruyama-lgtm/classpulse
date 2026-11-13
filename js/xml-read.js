// OOXML 用の小さな XML 読み取り器。DOM と実体の展開は使わない。
import { CONFIG } from './config.js';

const broken = () => Object.assign(new Error('broken'), { code: 'broken' });
const validChar = (n) => n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
function entities(text) {
  return text.replace(/&([^;\s<&]*);|&/g, (whole, name) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, name)) return named[name];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name || '')) throw broken();
    const n = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!validChar(n)) throw broken();
    return String.fromCodePoint(n);
  });
}

export function parseXml(input, { maxDepth = CONFIG.pptx.maxXmlDepth } = {}) {
  let xml;
  try { xml = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw broken(); }
  if (/<!DOCTYPE/i.test(xml)) throw broken();
  for (const ch of xml) if (!validChar(ch.codePointAt(0))) throw broken();
  xml = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const stack = [];
  let root = null, p = 0;
  const namePattern = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
  const whitespace = () => { while (p < xml.length && /[\t\n\r ]/.test(xml[p])) p++; };
  const name = () => {
    namePattern.lastIndex = p;
    const m = namePattern.exec(xml);
    if (!m) throw broken();
    p = namePattern.lastIndex;
    return m[0];
  };
  const until = (marker) => {
    const end = xml.indexOf(marker, p);
    if (end < 0) throw broken();
    const text = xml.slice(p, end);
    p = end + marker.length;
    return text;
  };
  while (p < xml.length) {
    if (xml[p] !== '<') {
      const end = xml.indexOf('<', p);
      const raw = xml.slice(p, end < 0 ? xml.length : end);
      if (raw.includes(']]>')) throw broken();
      const text = entities(raw);
      if (stack.length) stack[stack.length - 1].text += text;
      else if (text.trim()) throw broken();
      p = end < 0 ? xml.length : end;
    } else if (xml.startsWith('<!--', p)) {
      p += 4;
      const comment = until('-->');
      if (comment.includes('--') || comment.endsWith('-')) throw broken();
    } else if (xml.startsWith('<?', p)) {
      p += 2;
      name();
      until('?>');
    } else if (xml.startsWith('<![CDATA[', p)) {
      if (!stack.length) throw broken();
      p += 9;
      stack[stack.length - 1].text += until(']]>');
    } else if (xml.startsWith('</', p)) {
      p += 2;
      const close = name();
      whitespace();
      if (xml[p++] !== '>' || !stack.length || stack.pop().name !== close) throw broken();
    } else {
      p++;
      const node = { name: name(), attrs: Object.create(null), children: [], text: '' };
      if (stack.length + 1 > maxDepth) throw broken();
      while (true) {
        const before = p;
        whitespace();
        if (xml[p] === '>' || xml.startsWith('/>', p)) break;
        if (p === before) throw broken();
        const key = name();
        if (Object.hasOwn(node.attrs, key)) throw broken();
        whitespace();
        if (xml[p++] !== '=') throw broken();
        whitespace();
        const quote = xml[p++];
        if (quote !== '"' && quote !== "'") throw broken();
        const value = until(quote);
        if (value.includes('<')) throw broken();
        node.attrs[key] = entities(value.replace(/[\t\n\r]/g, ' '));
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else {
        if (root) throw broken();
        root = node;
      }
      if (xml.startsWith('/>', p)) p += 2;
      else { p++; stack.push(node); }
    }
  }
  if (!root || stack.length) throw broken();
  return root;
}
