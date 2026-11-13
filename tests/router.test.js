import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash, needsTeacher, viewFile } from '../js/router.js';

test('空とトップはダッシュボード', () => {
  assert.deepEqual(parseRoute(''), { name: 'dashboard', params: {} });
  assert.deepEqual(parseRoute('#'), { name: 'dashboard', params: {} });
  assert.deepEqual(parseRoute('#/'), { name: 'dashboard', params: {} });
});

test('各画面の対応', () => {
  assert.deepEqual(parseRoute('#/login'), { name: 'login', params: {} });
  assert.deepEqual(parseRoute('#/edit/deck1'), { name: 'editor', params: { deckId: 'deck1' } });
  assert.deepEqual(parseRoute('#/present/abc'), { name: 'present', params: { sid: 'abc' } });
  assert.deepEqual(parseRoute('#/join/abc'), { name: 'join', params: { sid: 'abc' } });
  assert.deepEqual(parseRoute('#/history'), { name: 'history', params: {} });
  assert.deepEqual(parseRoute('#/history/abc'), { name: 'result', params: { sid: 'abc' } });
});

test('知らない道筋・余計な部分・ID が無いものは not-found', () => {
  for (const h of ['#/nothing', '#/edit', '#/edit/', '#/edit/a/b', '#/login/x', '#/history/a/b', '#/join', 'x']) {
    assert.equal(parseRoute(h).name, 'not-found', h);
  }
});

test('ID に / や ? が入ったものは not-found', () => {
  assert.equal(parseRoute('#/join/a%2Fb').name, 'not-found');
  assert.equal(parseRoute('#/join/a%3Fb').name, 'not-found');
  assert.equal(parseRoute('#/join/a?b=1').name, 'not-found');
  assert.equal(parseRoute('#/join/%E0%A4%A').name, 'not-found');
});

test('routeHash との往復', () => {
  const cases = [
    ['dashboard', {}], ['login', {}], ['editor', { deckId: 'd1' }], ['present', { sid: 's1' }],
    ['join', { sid: 's1' }], ['history', {}], ['result', { sid: 's1' }],
  ];
  for (const [name, params] of cases) {
    assert.deepEqual(parseRoute(routeHash(name, params)), { name, params });
  }
  assert.equal(routeHash('dashboard'), '#/');
  assert.equal(routeHash('join', { sid: 'abc' }), '#/join/abc');
});

test('先生のログインが要る画面', () => {
  for (const n of ['login', 'signup', 'join', 'not-found']) assert.equal(needsTeacher(n), false, n);
  for (const n of ['dashboard', 'editor', 'present', 'history', 'result', 'pending', 'teachers']) assert.equal(needsTeacher(n), true, n);
});

test('履歴と結果は同じ画面ファイル（history）を使う', () => {
  assert.equal(viewFile('history'), 'history');
  assert.equal(viewFile('result'), 'history');
  assert.equal(viewFile(parseRoute('#/history/abc').name), 'history');
  assert.equal(viewFile('join'), 'student');
});

test('止める言葉の道順と先生だけの守り', () => {
  assert.deepEqual(parseRoute('#/words'), { name: 'words', params: {} });
  assert.equal(routeHash('words'), '#/words');
  assert.equal(viewFile('words'), 'words');
  assert.equal(needsTeacher('words'), true);
  assert.equal(parseRoute('#/words/extra').name, 'not-found');
});

test('ゴミ箱の道順', () => {
  assert.deepEqual(parseRoute('#/trash'), { name: 'trash', params: {} });
  assert.equal(routeHash('trash'), '#/trash');
  assert.equal(parseRoute('#/trash/x').name, 'not-found');
  assert.equal(needsTeacher('trash'), true);
  assert.equal(viewFile('trash'), 'trash');
});

test('登録・承認待ち・管理の道順と画面ファイル', () => {
  for (const name of ['signup', 'pending', 'teachers']) {
    assert.equal(routeHash(name), `#/${name}`);
    assert.deepEqual(parseRoute(routeHash(name)), { name, params: {} });
    assert.equal(viewFile(name), name);
    assert.equal(parseRoute(`#/${name}/extra`).name, 'not-found');
  }
});
