// 登録・復帰・キャッシュの条件。DOM に触れず、決めごとだけを返す
export function shouldRegister({ protocol, hostname, demo, hasServiceWorker }) {
  return protocol === 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1'
    && !demo && !!hasServiceWorker;
}

export function shouldWake({ type, persisted, visibilityState }) {
  return type === 'online' || (type === 'pageshow' && persisted === true)
    || (type === 'visibilitychange' && visibilityState === 'visible');
}

// 初回に読みこんだ部品だけを保存する。ハッシュ・重なり・worker 自身を除く
export function warmupUrls({ href, origin, entries = [], max = 200 }) {
  const limit = Math.min(200, Math.max(0, Math.floor(max)));
  if (!(limit > 0)) return [];
  const urls = new Set();
  for (const name of [href, ...entries.map((entry) => entry.name)]) {
    if (typeof name !== 'string' || !name) continue;
    let url;
    try { url = new URL(name, href); } catch { continue; }
    if (url.origin !== origin || url.pathname.endsWith('/sw.js')) continue;
    url.hash = '';
    urls.add(url.href);
    if (urls.size >= limit) break;
  }
  return [...urls];
}

// sw.js は通常のスクリプトなので、この 2 つの条件はそちらにも置く。実物との一致はテストする
export function shouldHandle({ method, url }, origin) {
  return method === 'GET' && new URL(url).origin === origin;
}

export function shouldCache({ status, type }) {
  return status === 200 && type !== 'opaque';
}
