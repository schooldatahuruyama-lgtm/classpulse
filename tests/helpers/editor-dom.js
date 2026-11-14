// 編集画面のイベントを通すための小さな DOM。見た目・実機のキーボードは検証しない。
export function editorDom(t, narrow = true) {
  const keys = ['document', 'window', 'Node', 'Element', 'HTMLElement'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let doc;
  class TestNode {
    constructor(tag) {
      this.tagName = tag; this.childNodes = []; this.attributes = {}; this.dataset = {}; this.events = new Map();
      this.parentElement = null; this.scrollTop = 0; this.scrollLeft = 0; this.focusCount = 0;
      this.style = { setProperty(key, value) { this[key] = value; } };
    }
    get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
    get firstElementChild() { return this.children[0] || null; }
    get firstChild() { return this.childNodes[0] || null; }
    get className() { return this.attributes.class || ''; }
    set className(value) { this.attributes.class = value; }
    get classList() {
      const contains = (name) => this.className.split(' ').includes(name);
      const toggle = (name, on = !contains(name)) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return on;
      };
      return { contains, toggle, add: (...names) => names.forEach((n) => toggle(n, true)), remove: (...names) => names.forEach((n) => toggle(n, false)) };
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
    set hidden(on) { if (on) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get open() { return Object.hasOwn(this.attributes, 'open'); }
    set open(on) { if (on) this.setAttribute('open', ''); else this.removeAttribute('open'); }
    get isConnected() { return this === doc.body || !!this.parentElement?.isConnected; }
    get textContent() { return this.tagName === '#text' ? this.text : this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(value) { if (this.tagName === '#text') this.text = String(value); else this.replaceChildren(doc.createTextNode(String(value))); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) {
      if (key.startsWith('data-')) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
      return this.attributes[key] ?? null;
    }
    removeAttribute(key) { delete this.attributes[key]; }
    append(...nodes) { nodes.forEach((n) => this.insertBefore(n instanceof TestNode ? n : doc.createTextNode(String(n)), null)); }
    prepend(node) { this.insertBefore(node, this.firstChild); }
    insertBefore(node, before) {
      node.remove(); const i = before ? this.childNodes.indexOf(before) : -1;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node); node.parentElement = this;
    }
    replaceChildren(...nodes) { for (const n of this.childNodes) n.parentElement = null; this.childNodes = []; this.append(...nodes); }
    replaceWith(node) { const parent = this.parentElement; parent.insertBefore(node, this); this.remove(); }
    remove() { if (this.parentElement) { const p = this.parentElement; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentElement = null; } }
    contains(node) { return node === this || this.childNodes.some((n) => n.contains(node)); }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some((s) => this.matches(s.trim()));
      if (selector.startsWith('.')) return selector.slice(1).split('.').every((s) => this.classList.contains(s));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
      const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attr) return attr[2] === undefined ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2];
      return this.tagName === selector;
    }
    querySelectorAll(selector) { return this.childNodes.flatMap((n) => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
    removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
    dispatch(name, fields = {}) {
      const ev = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields };
      for (const fn of [...(this.events.get(name) || [])]) fn(ev);
      return ev;
    }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { this.focusCount++; doc.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, right: 320, top: 0, width: 320, height: this.classList.contains('ed-bottom') ? 60 : 180 }; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.dispatch('close'); } }
  }
  doc = new TestNode('#document');
  doc.body = new TestNode('body'); doc.append(doc.body); doc.activeElement = doc.body;
  doc.createElement = (tag) => new TestNode(tag);
  doc.createElementNS = (_, tag) => new TestNode(tag);
  doc.createTextNode = (text) => { const node = new TestNode('#text'); node.text = text; return node; };
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  const media = new TestNode('media'); media.matches = narrow;
  const timers = new Map(); let seq = 0;
  const win = new TestNode('window');
  Object.assign(win, { matchMedia: () => media, setTimeout: (fn) => { timers.set(++seq, fn); return seq; }, clearTimeout: (id) => timers.delete(id) });
  Object.assign(globalThis, { document: doc, window: win, Node: TestNode, Element: TestNode, HTMLElement: TestNode });
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const [key, desc] of Object.entries(previous)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  const root = doc.createElement('main'); doc.body.append(root);
  return { root, doc, media, timers, cleanup: (fn) => cleanups.push(fn), width: (on) => { media.matches = on; media.dispatch('change'); } };
}
