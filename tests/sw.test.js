import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { shouldRegister, shouldWake, shouldHandle, shouldCache, warmupUrls } from '../js/sw-logic.js';
import { fakeScheduler, flush } from './helpers/resilience.js';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://example.test';
const SCOPE = `${ORIGIN}/classpulse/`;
const CACHE = 'classpulse-v1';
const response = (body, status = 200, type = 'basic') => ({ body, status, type, clone() { return response(body, status, type); } });
const request = (url = `${SCOPE}js/main.js`, extra = {}) => ({ url, method: 'GET', mode: 'cors', ...extra });

// 入口の実物の初期化部分も動かす（画面や認証の初期化はこのテストの対象外）
function mainResilience({ readyState = 'loading', demo = false, noWake = false, registrationFails = false,
  controlled = true, ready = Promise.resolve(), entries = [], network = async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) } = {}) {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const from = main.indexOf('  const onLoad = () => {');
  const to = main.indexOf('  const { teacherAuth, studentAuth } = backend;', from);
  assert.ok(from >= 0 && to > from);
  const windowEvents = new Map();
  const documentEvents = new Map();
  const workerEvents = new Map();
  const clock = fakeScheduler();
  const calls = { teacher: 0, student: 0, registrations: [], fetches: [], resources: 0 };
  const document = { readyState, visibilityState: 'hidden', addEventListener(type, fn) { documentEvents.set(type, fn); } };
  const serviceWorker = {
    controller: controlled ? {} : null, ready,
    addEventListener(type, fn) { workerEvents.set(type, fn); },
    removeEventListener(type, fn) { if (workerEvents.get(type) === fn) workerEvents.delete(type); },
    async register(path, options) {
      calls.registrations.push({ path, options });
      if (registrationFails) throw new Error('registration');
    },
  };
  runInNewContext(main.slice(from, to), {
    shouldWake, shouldRegister, warmupUrls, document, ...clock,
    window: { addEventListener(type, fn, options) { windowEvents.set(type, { fn, options }); } },
    location: { protocol: 'https:', hostname: 'example.test', origin: ORIGIN, href: `${SCOPE}index.html#/join` },
    navigator: { serviceWorker },
    performance: { getEntriesByType(type) { assert.equal(type, 'resource'); calls.resources++; return entries; } },
    fetch(url) { calls.fetches.push(url); return network(url); },
    backend: { demo, net: noWake ? {} : { wake() { calls.teacher++; } }, studentNet: noWake ? {} : { wake() { calls.student++; } } },
  });
  return { calls, document, windowEvents, documentEvents, workerEvents, serviceWorker, clock };
}

test('main: 読みこみ完了後、通常の sw.js を updateViaCache none で 1 回登録する', async () => {
  const m = mainResilience({ registrationFails: true });
  assert.equal(m.calls.registrations.length, 0);
  const load = m.windowEvents.get('load');
  assert.equal(load.options.once, true);
  load.fn();
  await Promise.resolve();
  assert.equal(m.calls.registrations.length, 1);
  assert.equal(m.calls.registrations[0].path, 'sw.js');
  assert.equal(m.calls.registrations[0].options.updateViaCache, 'none');
  assert.equal(m.calls.registrations[0].options.type, undefined);
  assert.ok(m.documentEvents.has('visibilitychange'));
});

test('main: 読みこみ済みなら直ちに設定し、復帰の条件を満たすと先生・生徒の両方を起こす', () => {
  const m = mainResilience({ readyState: 'complete' });
  assert.equal(m.calls.registrations.length, 1);
  assert.equal(m.windowEvents.has('load'), false);
  m.windowEvents.get('pageshow').fn({ type: 'pageshow', persisted: false });
  m.documentEvents.get('visibilitychange')({ type: 'visibilitychange' });
  assert.equal(m.calls.teacher, 0);
  m.windowEvents.get('online').fn({ type: 'online' });
  m.windowEvents.get('pageshow').fn({ type: 'pageshow', persisted: true });
  m.document.visibilityState = 'visible';
  m.documentEvents.get('visibilitychange')({ type: 'visibilitychange' });
  assert.equal(m.calls.teacher, 3);
  assert.equal(m.calls.student, 3);
});

test('main: 練習モードでは登録せず、wake が無くても復帰イベントで失敗しない', () => {
  const m = mainResilience({ readyState: 'complete', demo: true, noWake: true });
  m.windowEvents.get('online').fn({ type: 'online' });
  assert.equal(m.calls.registrations.length, 0);
});

test('main: 初回は ready と controller の両方を待ち、制御後に読みこみ済みの部品を 1 回ずつ取る', async () => {
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const m = mainResilience({ readyState: 'complete', controlled: false, ready, entries: [
    { name: `${SCOPE}js/main.js` }, { name: `${SCOPE}js/main.js#duplicate` },
    { name: `${SCOPE}sw.js` }, { name: 'https://other.test/font.woff2' },
  ] });
  await flush();
  assert.equal(m.calls.fetches.length, 0);
  assert.equal(m.workerEvents.size, 0);
  resolveReady();
  await flush();
  assert.deepEqual(m.clock.delays(), [10000]);
  const changed = m.workerEvents.get('controllerchange');
  changed(); // controller がまだ無い通知では始めない
  await flush();
  assert.equal(m.calls.fetches.length, 0);
  m.serviceWorker.controller = {};
  changed();
  await flush();
  assert.deepEqual(m.calls.fetches, [`${SCOPE}index.html`, `${SCOPE}js/main.js`]);
  assert.equal(m.workerEvents.size, 0);
  assert.equal(m.clock.count, 0);
  await m.clock.advance(10000);
  assert.equal(m.calls.resources, 1);
});

test('main: 登録後 ready を待つ間に制御が始まっていても、初回の部品を保存する', async () => {
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const m = mainResilience({ readyState: 'complete', controlled: false, ready });
  await flush();
  m.serviceWorker.controller = {};
  assert.equal(m.calls.fetches.length, 0);
  resolveReady();
  await flush();
  assert.deepEqual(m.calls.fetches, [`${SCOPE}index.html`]);
  assert.equal(m.workerEvents.size, 0);
  assert.equal(m.clock.count, 0);
});

test('main: 制御されないまま 10 秒経ったら、監視を外して取り直しをやめる', async () => {
  const m = mainResilience({ readyState: 'complete', controlled: false });
  await m.clock.advance(9999);
  assert.equal(m.workerEvents.has('controllerchange'), true);
  assert.equal(m.calls.fetches.length, 0);
  await m.clock.advance(1);
  assert.equal(m.workerEvents.size, 0);
  assert.equal(m.clock.count, 0);
  m.serviceWorker.controller = {};
  await flush();
  assert.equal(m.calls.fetches.length, 0);
  assert.equal(m.calls.resources, 0);
});

test('main: 登録時に制御済みなら部品を取り直さない', async () => {
  const m = mainResilience({ readyState: 'complete' });
  await flush();
  assert.equal(m.calls.registrations.length, 1);
  assert.equal(m.calls.fetches.length, 0);
  assert.equal(m.calls.resources, 0);
  assert.equal(m.workerEvents.size, 0);
  assert.equal(m.clock.count, 0);
});

test('main: 登録に失敗しても部品を取り直さず、待ちを残さない', async () => {
  const m = mainResilience({ readyState: 'complete', controlled: false, registrationFails: true });
  await flush();
  assert.equal(m.calls.fetches.length, 0);
  assert.equal(m.workerEvents.size, 0);
  assert.equal(m.clock.count, 0);
});

test('main: 部品は応答の最後まで受け取ってから次の 4 個へ進み、失敗しても続ける', async () => {
  const bodies = [];
  const consumed = [];
  const entries = Array.from({ length: 9 }, (_, i) => ({ name: `${SCOPE}asset-${i}.js` }));
  const m = mainResilience({ readyState: 'complete', controlled: false, entries, network(url) {
    if (url === entries[0].name) throw new TypeError('fetch failed');
    if (url === entries[4].name) return Promise.reject(new TypeError('network failed'));
    return Promise.resolve({ arrayBuffer() {
      consumed.push(url);
      if (url === entries[5].name) return Promise.reject(new TypeError('body failed'));
      return new Promise((resolve) => { bodies.push(resolve); });
    } });
  } });
  await flush();
  m.serviceWorker.controller = {};
  m.workerEvents.get('controllerchange')();
  await flush();
  assert.equal(m.calls.fetches.length, 4);
  assert.equal(consumed.length, 3);
  bodies.shift()(new ArrayBuffer(0));
  await flush();
  assert.equal(m.calls.fetches.length, 4);
  bodies.splice(0).forEach((resolve) => resolve(new ArrayBuffer(0)));
  await flush();
  assert.equal(m.calls.fetches.length, 8);
  bodies.splice(0).forEach((resolve) => resolve(new ArrayBuffer(0)));
  await flush();
  assert.equal(m.calls.fetches.length, 10);
  bodies.splice(0).forEach((resolve) => resolve(new ArrayBuffer(0)));
  await flush();
  assert.deepEqual(m.calls.fetches, [`${SCOPE}index.html`, ...entries.map((entry) => entry.name)]);
  assert.equal(consumed.length, 8);
});

test('warmupUrls: ページと同じ origin の部品だけを、ハッシュ・重なりを除いて返す', () => {
  const href = `${SCOPE}index.html#/join`;
  const entries = [
    { name: `${SCOPE}index.html#other` }, { name: `${SCOPE}js/main.js#one` },
    { name: `${SCOPE}js/main.js#two` }, { name: `${SCOPE}style.css?v=1#part` },
    { name: `${SCOPE}fonts/font.woff2` }, { name: 'https://other.test/main.js' },
    { name: 'http://example.test/main.js' }, { name: 'data:text/css,body{}' },
    { name: 'https://[' }, { name: '' }, {},
  ];
  const before = JSON.stringify(entries);
  assert.deepEqual(warmupUrls({ href, origin: ORIGIN, entries }), [
    `${SCOPE}index.html`, `${SCOPE}js/main.js`, `${SCOPE}style.css?v=1`, `${SCOPE}fonts/font.woff2`,
  ]);
  assert.equal(JSON.stringify(entries), before);
});

test('warmupUrls: sw.js 自身はクエリやハッシュ付きでも除く', () => {
  assert.deepEqual(warmupUrls({ href: `${SCOPE}index.html`, origin: ORIGIN, entries: [
    { name: `${SCOPE}sw.js` }, { name: `${SCOPE}sw.js?v=2#part` }, { name: `${SCOPE}js/sw-logic.js` },
  ] }), [`${SCOPE}index.html`, `${SCOPE}js/sw-logic.js`]);
});

test('warmupUrls: ページも含めた上限を守り、最大でも 200 個', () => {
  const href = `${SCOPE}index.html#route`;
  const entries = Array.from({ length: 220 }, (_, i) => ({ name: `${SCOPE}${i}.js` }));
  assert.deepEqual(warmupUrls({ href, origin: ORIGIN, entries, max: 3 }), [`${SCOPE}index.html`, `${SCOPE}0.js`, `${SCOPE}1.js`]);
  assert.deepEqual(warmupUrls({ href, origin: ORIGIN, entries, max: 0 }), []);
  for (const max of [undefined, 200, 300]) {
    const urls = warmupUrls({ href, origin: ORIGIN, entries, max });
    assert.equal(urls.length, 200);
    assert.equal(urls.at(-1), `${SCOPE}198.js`);
  }
});

// 実物の sw.js を、偽の worker の上で実行する。決めごとのコピーだけのテストにはしない
function worker({ network = async () => response('new'), failOpen = false, failPut = false } = {}) {
  const listeners = new Map();
  const entries = new Map();
  const writes = [];
  const matches = [];
  const fetches = [];
  const deleted = [];
  let skipped = 0;
  let claimed = 0;
  const key = (req) => typeof req === 'string' ? req : req.url;
  const cache = {
    async match(req) { matches.push(key(req)); return entries.get(key(req)); },
    async put(req, res) { if (failPut) throw new Error('quota'); writes.push(key(req)); entries.set(key(req), res); },
  };
  runInNewContext(source, {
    URL,
    self: {
      location: { origin: ORIGIN }, registration: { scope: SCOPE },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async skipWaiting() { skipped++; }, clients: { async claim() { claimed++; } },
    },
    caches: {
      async open(name) { assert.equal(name, CACHE); if (failOpen) throw new Error('storage'); return cache; },
      async keys() { return [CACHE, 'classpulse-old', 'other-app-v1']; },
      async delete(name) { deleted.push(name); return true; },
    },
    fetch(req, init) { fetches.push({ req, init, argc: arguments.length }); return network(req, init); },
  });
  return {
    entries, writes, matches, fetches, deleted,
    get skipped() { return skipped; }, get claimed() { return claimed; },
    async dispatch(type, req) {
      const waits = [];
      let result;
      let handled = false;
      listeners.get(type)({ request: req, waitUntil(p) { waits.push(p); }, respondWith(p) { handled = true; result = p; } });
      const res = await result;
      await Promise.all(waits);
      return { handled, response: res };
    },
  };
}

test('SW 登録の条件: HTTPS・本番・対応ブラウザだけ。開発用のホストを除く', () => {
  for (const protocol of ['https:', 'http:', 'file:']) {
    for (const hostname of ['example.test', 'localhost', '127.0.0.1']) {
      for (const demo of [false, true]) {
        for (const hasServiceWorker of [false, true]) {
          assert.equal(shouldRegister({ protocol, hostname, demo, hasServiceWorker }), protocol === 'https:' && hostname === 'example.test' && !demo && hasServiceWorker);
        }
      }
    }
  }
});

test('wake の条件: online・BFCache 復帰・表示状態への復帰だけ', () => {
  for (const type of ['online', 'offline', 'pageshow', 'visibilitychange']) {
    for (const persisted of [false, true, undefined]) {
      for (const visibilityState of ['visible', 'hidden', undefined]) {
        assert.equal(shouldWake({ type, persisted, visibilityState }), type === 'online' || (type === 'pageshow' && persisted === true) || (type === 'visibilitychange' && visibilityState === 'visible'));
      }
    }
  }
});

test('SW: install は即時更新だけ。activate は旧 ClassPulse キャッシュを消して制御を始める', async () => {
  const w = worker();
  await w.dispatch('install');
  assert.equal(w.skipped, 1);
  assert.equal(w.fetches.length, 0);
  assert.equal(w.writes.length, 0);
  await w.dispatch('activate');
  assert.deepEqual(w.deleted, ['classpulse-old']);
  assert.equal(w.claimed, 1);
});

for (const req of [
  request(), request(`${SCOPE}index.html`, { mode: 'navigate' }),
  request(`${SCOPE}save`, { method: 'POST' }), request(`${SCOPE}save`, { method: 'PUT' }),
  request(`${SCOPE}save`, { method: 'DELETE' }), request(`${SCOPE}main.js`, { method: 'HEAD' }),
  request('https://example-db.firebaseio.com/sessions/test.json'),
  request('https://identitytoolkit.googleapis.com/v1/accounts:signUp'),
  request('https://www.googleapis.com/drive/v3/files'),
  request('http://example.test/classpulse/main.js'), request('https://other.test/main.js'),
]) {
  test(`SW: 扱う要求の純粋関数と実物の一致 ${req.method} ${req.url}`, async () => {
    const w = worker();
    const result = await w.dispatch('fetch', req);
    const wanted = shouldHandle(req, ORIGIN);
    assert.equal(result.handled, wanted);
    assert.equal(w.fetches.length, wanted ? 1 : 0);
    assert.equal(w.writes.length, wanted ? 1 : 0);
  });
}

for (const [status, type] of [[200, 'basic'], [200, 'default'], [200, 'opaque'], [0, 'opaque'], [206, 'basic'], [201, 'basic'], [204, 'basic'], [304, 'basic'], [404, 'basic'], [500, 'basic']]) {
  test(`SW: HTTP ${status} / ${type} の応答は必ずそのまま返し、保存条件も実物と一致`, async () => {
    const fresh = response('new', status, type);
    const req = request();
    const w = worker({ network: async () => fresh });
    w.entries.set(req.url, response('old'));
    const result = await w.dispatch('fetch', req);
    assert.equal(result.response, fresh);
    assert.equal(w.matches.length, 0);
    assert.equal(w.writes.length, shouldCache(fresh) ? 1 : 0);
    assert.equal(w.fetches[0].init.cache, 'no-cache');
    if (shouldCache(fresh)) {
      assert.equal(w.entries.get(req.url).body, 'new');
      assert.notEqual(w.entries.get(req.url), fresh); // 保存するのは clone
    }
  });
}

test('SW: navigate に Request と init を渡せない環境でも、URL で取得してネットワークの応答を返す', async () => {
  const fresh = response('new');
  const req = request(`${SCOPE}index.html`, { mode: 'navigate' });
  const w = worker({ network(input, init) {
    if (typeof input === 'object' && input.mode === 'navigate' && init) throw new TypeError('navigate Request with init');
    return Promise.resolve(fresh);
  } });
  w.entries.set(req.url, response('old'));
  assert.equal((await w.dispatch('fetch', req)).response, fresh);
  assert.equal(w.fetches.length, 1);
  assert.equal(typeof w.fetches[0].req, 'string');
  assert.equal(w.fetches[0].req, req.url);
  assert.deepEqual({ ...w.fetches[0].init }, { cache: 'no-cache', credentials: 'same-origin', redirect: 'follow' });
  assert.equal(w.matches.length, 0);
  assert.deepEqual(w.writes, [req.url]);
});

for (const mode of ['navigate', 'cors']) {
  for (const failure of ['sync', 'async']) {
    test(`SW: ${mode} の init 付き取得が ${failure} で失敗しても、init なしの成功をキャッシュより優先する`, async () => {
      const fresh = response('new');
      const req = request(`${SCOPE}index.html`, { mode });
      const w = worker({ network(input, init) {
        if (init) {
          const error = new TypeError('init unsupported');
          if (failure === 'sync') throw error;
          return Promise.reject(error);
        }
        assert.equal(input, req);
        return Promise.resolve(fresh);
      } });
      w.entries.set(req.url, response('old'));
      assert.equal((await w.dispatch('fetch', req)).response, fresh);
      assert.equal(w.fetches.length, 2);
      assert.equal(w.fetches[0].req, mode === 'navigate' ? req.url : req);
      assert.equal(w.fetches[0].init.cache, 'no-cache');
      assert.equal(w.fetches[1].req, req);
      assert.equal(w.fetches[1].argc, 1);
      assert.equal(w.matches.length, 0);
      assert.equal(w.entries.get(req.url).body, 'new');
    });
  }
  test(`SW: ${mode} は init なしの取得も失敗したら、2 回だけでキャッシュへ進む`, async () => {
    const req = request(`${SCOPE}index.html`, { mode });
    const w = worker({ network() { throw new TypeError('offline'); } });
    w.entries.set(req.url, response('saved'));
    assert.equal((await w.dispatch('fetch', req)).response.body, 'saved');
    assert.equal(w.fetches.length, 2);
    assert.equal(w.fetches[1].req, req);
    assert.equal(w.fetches[1].argc, 1);
    assert.deepEqual(w.matches, [req.url]);
    assert.equal(w.writes.length, 0);
  });
}

for (const failure of ['failOpen', 'failPut']) {
  test(`SW: ${failure} でもネットワークの成功を古いキャッシュに置き換えない`, async () => {
    const fresh = response('new');
    const w = worker({ [failure]: true, network: async () => fresh });
    w.entries.set(request().url, response('old'));
    assert.equal((await w.dispatch('fetch', request())).response, fresh);
    assert.equal(w.matches.length, 0);
  });
}

const offline = async () => { throw new TypeError('offline'); };
test('SW: 通信の例外のときだけ、要求そのもののキャッシュを返す', async () => {
  const w = worker({ network: offline });
  w.entries.set(request().url, response('saved'));
  assert.equal((await w.dispatch('fetch', request())).response.body, 'saved');
  assert.equal(w.writes.length, 0);
});

test('SW: navigate の写しが無ければ scope 内の index.html を返す', async () => {
  const w = worker({ network: offline });
  w.entries.set(`${SCOPE}index.html`, response('shell'));
  const req = request(`${SCOPE}?from=join`, { mode: 'navigate' });
  assert.equal((await w.dispatch('fetch', req)).response.body, 'shell');
  assert.deepEqual(w.matches, [req.url, `${SCOPE}index.html`]);
});

test('SW: JS の欠損を HTML で埋めず、画面の写しも無いときは通信の失敗を返す', async () => {
  const w = worker({ network: offline });
  w.entries.set(`${SCOPE}index.html`, response('shell'));
  await assert.rejects(w.dispatch('fetch', request()), /offline/);
  assert.deepEqual(w.matches, [request().url]);
  w.entries.clear();
  await assert.rejects(w.dispatch('fetch', request(`${SCOPE}missing`, { mode: 'navigate' })), /offline/);
});
