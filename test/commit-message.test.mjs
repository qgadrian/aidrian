import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { commitSubject, subjectProblem } from '../plugins/aidrian/lib/commit-message.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const TYPES = DEFAULTS.git.commits.types;

test('the subject is the first line that is neither blank nor a git comment', () => {
  assert.equal(commitSubject('\n\n# Please enter the message.\nfeat(api): add export\n\n# On branch main\n'), 'feat(api): add export');
  assert.equal(commitSubject('\n# only comments\n'), undefined);
  assert.equal(commitSubject('feat: add export\n\nThe body.\n\nCloses #12\n'), 'feat: add export');
});

test('Conventional Commits subjects pass, and Merge and Revert subjects always do', () => {
  for (const subject of [
    'feat: add booking export',
    'fix(ci): scope stale artifact cleanup',
    'refactor(agents)!: simplify routing',
    'test(core/helpers): cover parsing',
    "Merge branch 'feature/foo'",
    'Revert "feat: add export"',
  ]) {
    assert.equal(subjectProblem(subject, TYPES), null, subject);
  }
});

test('other subjects fail with the accepted forms and the types', () => {
  for (const subject of ['Add export', 'feat add export', 'feat(scope) add export', 'feat:', 'misc: add export', 'fixup! feat: x']) {
    const problem = subjectProblem(subject, TYPES);
    assert.match(problem, new RegExp(`^Invalid commit subject: ${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), subject);
    assert.match(problem, /Types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test\./);
  }
  assert.match(subjectProblem(undefined, TYPES), /^The commit message is empty or only comments\./);
  assert.equal(subjectProblem('misc: x', ['misc']), null, 'the types are the project`s');
});

test('aidrian commit-msg reads the types from config.json and the message from a file or the command line', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { commits: { types: ['feat', 'wip'] } } }));
  writeFileSync(path.join(dir, 'MSG'), '# comment\nwip: half done\n');
  const run = (args) => spawnSync(CLI, ['commit-msg', ...args], { cwd: dir, encoding: 'utf8' });

  assert.deepEqual([run(['--file', 'MSG']).status, run(['--message', 'feat: x']).status], [0, 0]);
  const bad = run(['--message', 'fix: x']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^Invalid commit subject: fix: x\n[\s\S]*Types: feat, wip\./);
  assert.equal(spawnSync(CLI, ['commit-msg', '--message', 'fix: x'], { cwd: tmpdir(), encoding: 'utf8' }).status, 0, 'defaults outside a project');
  assert.deepEqual([run([]).status, run([]).stderr], [1, 'give one of --file PATH or --message TEXT\n']);
});
