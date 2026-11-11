import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash, needsTeacher } from '../js/router.js';

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
  for (const n of ['login', 'join', 'not-found']) assert.equal(needsTeacher(n), false, n);
  for (const n of ['dashboard', 'editor', 'present', 'history', 'result']) assert.equal(needsTeacher(n), true, n);
});
