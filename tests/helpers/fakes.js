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

// EventSource の偽物。fakeEventSource() が「クラス」を返す（new で使える）。
// クラスの .instances に作られた接続が全部残り、.last が最後の接続。
// 接続側のテスト用操作: open()（接続成功）、fail()（error）、emit(type, data)（named イベント。
// data が文字列以外なら JSON にして e.data に入れる）。close() すると closed が true になる。
export function fakeEventSource() {
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.closed = false;
      this.readyState = 0; // 0 接続中、1 開いている、2 閉じている
      this.listeners = new Map();
      FakeEventSource.instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter((f) => f !== fn));
    }
    close() { this.closed = true; this.readyState = 2; }
    dispatch(type, event = {}) {
      if (this.closed && type !== 'error') return;
      for (const fn of this.listeners.get(type) || []) fn({ type, ...event });
    }
    open() { this.readyState = 1; this.dispatch('open'); }
    // 一時的な切断（ブラウザが自動でつなぎ直す）
    fail() { this.readyState = 0; this.dispatch('error'); }
    // 完全な切断（ブラウザは自動でつなぎ直さない）
    failClosed() { this.readyState = 2; this.dispatch('error'); }
    emit(type, data) {
      this.dispatch(type, { data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    static get last() { return FakeEventSource.instances[FakeEventSource.instances.length - 1]; }
  }
  FakeEventSource.instances = [];
  return FakeEventSource;
}
