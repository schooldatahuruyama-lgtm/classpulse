import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('リポジトリの土台がそろっている', () => {
  const 必須ファイル = [
    'CLAUDE.md',
    'AGENTS.md',
    'docs/requirements.md',
    'tools/codex-review.ps1',
    'tools/codex-implement.ps1',
  ];
  for (const f of 必須ファイル) {
    assert.ok(existsSync(f), `${f} が無い`);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.js"');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
