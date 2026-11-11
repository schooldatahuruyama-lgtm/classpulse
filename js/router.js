// ハッシュ（#/...）と画面名の対応。ブラウザの物は使わない
const SIMPLE = { login: '#/login', history: '#/history', dashboard: '#/' };
const WITH_ID = { editor: ['edit', 'deckId'], present: ['present', 'sid'], join: ['join', 'sid'], result: ['history', 'sid'] };
const PUBLIC = ['login', 'join', 'not-found'];

const NOT_FOUND = () => ({ name: 'not-found', params: {} });

// ID として使える文字: 英数字と - _ だけ（/ や ? や空白を含むものは受けつけない）
function decodeId(seg) {
  let id;
  try { id = decodeURIComponent(seg); } catch { return null; }
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function parseRoute(hash) {
  const h = String(hash || '');
  if (h === '' || h === '#' || h === '#/') return { name: 'dashboard', params: {} };
  if (!h.startsWith('#/')) return NOT_FOUND();
  const parts = h.slice(2).split('/');
  const [head, id, ...rest] = parts;
  if (rest.length > 0) return NOT_FOUND();
  if (id === undefined) {
    if (head === 'login') return { name: 'login', params: {} };
    if (head === 'history') return { name: 'history', params: {} };
    return NOT_FOUND();
  }
  const found = Object.entries(WITH_ID).find(([, [seg]]) => seg === head);
  if (!found) return NOT_FOUND();
  const value = decodeId(id);
  if (value === null) return NOT_FOUND();
  return { name: found[0], params: { [found[1][1]]: value } };
}

export function routeHash(name, params = {}) {
  if (WITH_ID[name]) {
    const [seg, key] = WITH_ID[name];
    return `#/${seg}/${encodeURIComponent(params[key])}`;
  }
  return SIMPLE[name] ?? '#/';
}

export function needsTeacher(name) {
  return !PUBLIC.includes(name);
}
