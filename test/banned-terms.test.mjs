import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bannedHits, bodyFiles, judgeCommand } from '../scripts/banned-terms.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/banned-terms.mjs');
const patterns = [/\bzq-\d+/iu, /secretco/iu];

test('a private word matches in any case', () => {
  assert.deepEqual(bannedHits('fix: ZQ-12 and SecretCo', patterns), ['/\\bzq-\\d+/iu', '/secretco/iu']);
  assert.deepEqual(bannedHits('fix: azq-12', patterns), []);
});

test('body files are read from each way gh takes one', () => {
  assert.deepEqual(bodyFiles('gh pr create --body-file a.md && gh pr edit 1 --body-file=b.md -F c.md -F "$X" --body-file -'), ['a.md', 'b.md', 'c.md']);
});

test('a gh or git commit command is judged by its text and its body file; other commands are not read', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'bad.md'), '## Summary\nCloses ZQ-7.\n');
  writeFileSync(path.join(dir, 'good.md'), '## Summary\nfine\n');
  const judge = (command, cwd = dir) => judgeCommand(command, { cwd, patterns });
  assert.match(judge('gh pr create --title "fix ZQ-1" --body-file good.md'), /zq/);
  assert.match(judge('gh pr edit 5 --body-file bad.md'), /in bad\.md/);
  assert.match(judge(`cd ${dir} && gh pr create -t x -F bad.md`, '/'), /in bad\.md/, 'a leading cd moves the body file');
  assert.match(judge('git -C x commit -m "secretco fix"'), /secretco/);
  assert.equal(judge('gh pr create --title fix --body-file good.md'), null);
  assert.equal(judge('grep -r ZQ-1 .'), null, 'a search is not published');
});

test('the commit-msg hook refuses a private word and ignores comment lines', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const msg = path.join(dir, 'MSG');
  writeFileSync(msg, 'fix: thing\n# a comment can say anything\n');
  assert.equal(spawnSync('node', [SCRIPT, 'commit-msg', msg]).status, 0);
});

test('the git hooks call the script', () => {
  for (const hook of ['commit-msg', 'pre-push']) {
    assert.match(execFileSync('cat', [path.join(ROOT, '.githooks', hook)], { encoding: 'utf8' }), new RegExp(`banned-terms\\.mjs" ${hook}`));
  }
});
