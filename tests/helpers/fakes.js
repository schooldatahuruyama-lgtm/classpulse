// テスト用の偽物（保存先・fetch・時計）。環境に依存しないよう注入して使う。

// localStorage と同じ形の保存先
export function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// handler(url, init) が { status, body } を返す（Error を返すと通信失敗になる）。
// 呼び出しの記録は .calls（{ url, init }）に残る。
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  fn.calls = calls;
  return fn;
}

// 手で進められる時計
export function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
