import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isFullSuite, testRuns } from '../plugins/aidrian/lib/check-runs.mjs';
import { lexPipeline, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(import.meta.dirname, '../scripts/run-tests.mjs');

// Small test files: one starts 3 git and 2 other child processes, one starts none, one fails, and one kills its runner.
const FILES = {
  'busy.test.mjs': [
    "import { execFileSync, execSync, spawnSync } from 'node:child_process';",
    "import test from 'node:test';",
    "test('starts processes', () => {",
    "  execFileSync('git', ['--version']);",
    "  spawnSync('git', ['--version']);",
    "  execSync('git --version');",
    "  execFileSync(process.execPath, ['-e', '']);",
    "  spawnSync(process.execPath, ['-e', '']);",
    '});',
  ],
  'quiet.test.mjs': ["import test from 'node:test';", "test('does nothing', () => {});"],
  'fails.test.mjs': ["import test from 'node:test';", "test('fails', () => { throw new Error('a failure'); });"],
  'kills.test.mjs': ["import test from 'node:test';", "test('kills its runner', () => { process.kill(process.ppid, 'SIGKILL'); });"],
};

// A folder holding the test files, and an empty temporary folder for the script's own files.
function folder(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-run-tests-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(FILES)) writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);
  const temp = path.join(dir, 'tmp');
  mkdirSync(temp);
  return { dir, temp };
}

// The script run in `dir`. A runner started inside a test reports as that test's child unless NODE_TEST_CONTEXT is gone.
function runTests({ dir, temp }, args) {
  const env = { ...process.env, TMPDIR: temp };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env });
}

// The table's rows, by file: { seconds, git, other }.
function rows(stderr) {
  const found = {};
  for (const [, seconds, git, other, file] of stderr.matchAll(/^\s*(\d+\.\d)\s+(\d+)\s+(\d+)\s+(\S+\.test\.mjs)$/gmu)) {
    found[file] = { seconds: Number(seconds), git: Number(git), other: Number(other) };
  }
  return found;
}

test('the run prints each test file with its git calls and other child processes, and the totals', (t) => {
  const where = folder(t);
  const run = runTests(where, ['busy.test.mjs', 'quiet.test.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const table = rows(run.stderr);
  assert.deepEqual(Object.keys(table).sort(), ['busy.test.mjs', 'quiet.test.mjs'], run.stderr);
  assert.deepEqual([table['busy.test.mjs'].git, table['busy.test.mjs'].other], [3, 2]);
  assert.deepEqual([table['quiet.test.mjs'].git, table['quiet.test.mjs'].other], [0, 0]);
  assert.match(run.stderr, /^Summed over 2 test files: \d+\.\d s, 3 git calls, 2 other child processes$/mu);
  assert.match(run.stdout, /pass 2/u, 'the runner`s own output passes through');
  assert.deepEqual(readdirSync(where.temp), [], 'the script removes its temporary folder');
});

test('the arguments after the script reach the runner', (t) => {
  const run = runTests(folder(t), ['--test-reporter=tap', 'quiet.test.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^TAP version/mu);
  assert.deepEqual(Object.keys(rows(run.stderr)), ['quiet.test.mjs']);
});

test('the run exits with the runner`s status, and 1 when a signal ended the runner', (t) => {
  const where = folder(t);
  assert.equal(runTests(where, ['fails.test.mjs']).status, 1);
  const killed = runTests(where, ['kills.test.mjs']);
  assert.equal(killed.status, 1, killed.stderr);
  assert.deepEqual(readdirSync(where.temp), []);
});

test('this repository`s config records the script as a test run, and the script alone as the full suite', () => {
  const { testing } = JSON.parse(readFileSync(path.join(ROOT, '.aidrian/config.json'), 'utf8'));
  for (const command of ['node scripts/run-tests.mjs', 'node scripts/run-tests.mjs test/git.test.mjs']) {
    assert.equal(testRuns(command, ROOT, testing).length, 1, command);
  }
  const invocation = (command) => readInvocation(lexPipeline(command).segments[0]);
  assert.equal(isFullSuite(invocation('node scripts/run-tests.mjs'), testing), true);
  assert.equal(isFullSuite(invocation('node scripts/run-tests.mjs test/git.test.mjs'), testing), false);
});
