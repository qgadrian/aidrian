import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isFullSuite, testRuns } from '../plugins/aidrian/lib/check-runs.mjs';
import { lexPipeline, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(import.meta.dirname, '../scripts/run-tests.mjs');

// Small test files: one starts 3 git and 2 other child processes, one 1 git and 2 others, one starts none, one fails,
// and one kills its runner.
const FILES = {
  'trio.test.mjs': [
    "import { execFileSync } from 'node:child_process';",
    "import test from 'node:test';",
    "test('starts three processes', () => {",
    "  execFileSync('git', ['--version']);",
    "  execFileSync(process.execPath, ['-e', '']);",
    "  execFileSync(process.execPath, ['-e', '']);",
    '});',
  ],
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
  // Passes, and leaves a read-only folder holding a file in the script's log folder, so the script cannot remove it.
  'locks.test.mjs': [
    "import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('locks the log folder', () => {",
    "  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith('aidrian-test-log-'));",
    "  const locked = path.join(tmpdir(), name, 'locked');",
    '  mkdirSync(locked);',
    "  writeFileSync(path.join(locked, 'file'), '');",
    '  chmodSync(locked, 0o500);',
    '});',
  ],
  // Passes, and appends a row the table cannot render to the script's log.
  'breaks.test.mjs': [
    "import { appendFileSync, readdirSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('breaks the table', () => {",
    "  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith('aidrian-test-log-'));",
    "  appendFileSync(path.join(tmpdir(), name, 'files.jsonl'), 'null\\n');",
    '});',
  ],
  // Passes, and makes every append of its process throw, so its row is lost when it exits.
  'loses.test.mjs': [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import test from 'node:test';",
    "test('loses its row', () => {",
    "  fs.appendFileSync = () => { throw new Error('the log is gone'); };",
    '  syncBuiltinESMExports();',
    '});',
  ],
  // Passes, and puts a folder where the script's log was, so the script cannot read it.
  'hides.test.mjs': [
    "import { mkdirSync, readdirSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('hides the log', () => {",
    "  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith('aidrian-test-log-'));",
    "  const log = path.join(tmpdir(), name, 'files.jsonl');",
    '  rmSync(log);',
    '  mkdirSync(log);',
    '});',
  ],
  // Passes, and removes the script's log folder after its start was logged, so its row is lost when it exits.
  'drops.test.mjs': [
    "import { readdirSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('drops the log folder', () => {",
    "  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith('aidrian-test-log-'));",
    '  rmSync(path.join(tmpdir(), name), { recursive: true, force: true });',
    '});',
  ],
  // Passes, and removes the script's log alone after its start was logged, so its row lands in a new log with no start.
  'swaps.test.mjs': [
    "import { readdirSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('swaps the log', () => {",
    "  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith('aidrian-test-log-'));",
    "  rmSync(path.join(tmpdir(), name, 'files.jsonl'));",
    '});',
  ],
};

// A folder holding the test files, and an empty temporary folder for the script's own files. `budget`, when given, is
// written as the folder's test/child-process-budget.json: an object as JSON, a string as it is.
function folder(t, budget) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-run-tests-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(FILES)) writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);
  const temp = path.join(dir, 'tmp');
  mkdirSync(temp);
  if (budget !== undefined) {
    mkdirSync(path.join(dir, 'test'));
    writeFileSync(path.join(dir, 'test/child-process-budget.json'), typeof budget === 'string' ? budget : JSON.stringify(budget));
  }
  return { dir, temp };
}

// The script run in `dir`. A runner started inside a test reports as that test's child unless NODE_TEST_CONTEXT is gone.
// `node` holds node's own arguments for the script's process, such as an --import.
function runTests({ dir, temp }, args, node = []) {
  const env = { ...process.env, TMPDIR: temp };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [...node, SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env });
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

test('a log folder the script cannot remove leaves the runner`s status, and the table still prints', (t) => {
  const where = folder(t);
  // Writable again before the folder is removed, whether or not the run locked it.
  const unlock = () => {
    for (const name of readdirSync(where.temp)) {
      const locked = path.join(where.temp, name, 'locked');
      if (existsSync(locked)) chmodSync(locked, 0o700);
    }
  };
  let run;
  try {
    run = runTests(where, ['locks.test.mjs']);
  } finally {
    unlock();
  }
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(Object.keys(rows(run.stderr)), ['locks.test.mjs'], run.stderr);
});

test('a table that cannot be rendered is named on stderr, and the script still removes its folder', (t) => {
  const where = folder(t);
  const run = runTests(where, ['breaks.test.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /^Could not print the table of test files: /mu);
  assert.doesNotMatch(run.stderr, /Could not remove/u);
  assert.deepEqual(readdirSync(where.temp), []);
});

test('a stderr that throws on every write leaves the runner`s status, and the script still removes its folder', (t) => {
  const where = folder(t);
  // Loaded into the script's process alone: the runner it starts writes to stderr as usual.
  const broken = path.join(where.dir, 'broken-stderr.mjs');
  writeFileSync(broken, "process.stderr.write = () => { throw new Error('stderr is closed'); };\n");
  const run = runTests(where, ['quiet.test.mjs'], ['--import', pathToFileURL(broken).href]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(readdirSync(where.temp), []);
});

const WAYS_OUT = [
  /^Run its commands and hooks in the test's process \(docs\/test-processes\.md, Commands in the test's process, and docs\/contributing\.md, Hooks in the test's process\),$/mu,
  /^or add or raise its entry in test\/child-process-budget\.json, by the rule in docs\/test-processes\.md, Child-process budget, in the same pull request, and say why in the pull request's description\.$/mu,
];

test('a file one child process over its budget fails the run, naming the file, its count, its budget, and the ways out', (t) => {
  const run = runTests(folder(t, { default: 300, files: { 'trio.test.mjs': 2 } }), ['trio.test.mjs', 'quiet.test.mjs']);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /pass 2/u, 'the runner itself passed');
  assert.match(run.stderr, /^trio\.test\.mjs started 3 child processes \(1 git, 2 other\), over its budget of 2 in test\/child-process-budget\.json\.$/mu);
  assert.doesNotMatch(run.stderr, /quiet\.test\.mjs started/u);
  for (const line of WAYS_OUT) assert.match(run.stderr, line);
});

test('a file at its budget passes', (t) => {
  const run = runTests(folder(t, { default: 0, files: { 'trio.test.mjs': 3, 'quiet.test.mjs': 0 } }), ['trio.test.mjs', 'quiet.test.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /over its budget/u);
});

test('a file with no entry is held to the default', (t) => {
  const run = runTests(folder(t, { default: 2, files: { 'busy.test.mjs': 5 } }), ['trio.test.mjs', 'busy.test.mjs']);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^trio\.test\.mjs started 3 child processes \(1 git, 2 other\), over its budget of 2 in /mu);
  assert.doesNotMatch(run.stderr, /busy\.test\.mjs started/u);
});

test('with no budget file a run passes, and a file that did not run is not judged', (t) => {
  assert.equal(runTests(folder(t), ['busy.test.mjs']).status, 0);
  const run = runTests(folder(t, { default: 300, files: { 'busy.test.mjs': 0 } }), ['quiet.test.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a runner that failed keeps its status, and the budget is not judged', (t) => {
  const run = runTests(folder(t, { default: 0, files: {} }), ['fails.test.mjs', 'trio.test.mjs']);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /over its budget/u);
});

test('a file that started and left no row fails a run whose runner passed, naming the file, within budget or not', (t) => {
  for (const budget of [undefined, { default: 300, files: { 'loses.test.mjs': 0 } }]) {
    const where = folder(t, budget);
    const run = runTests(where, ['loses.test.mjs', 'quiet.test.mjs']);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /pass 2/u, 'the runner itself passed');
    assert.match(run.stderr, /^loses\.test\.mjs left no row of its child processes in the test log, so its budget cannot be judged: run it again\.$/mu);
    assert.doesNotMatch(run.stderr, /quiet\.test\.mjs left no row/u);
    assert.deepEqual(Object.keys(rows(run.stderr)), ['quiet.test.mjs'], run.stderr);
    assert.deepEqual(readdirSync(where.temp), []);
  }
  const failed = runTests(folder(t), ['loses.test.mjs', 'fails.test.mjs']);
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stderr, /left no row/u, 'a runner that failed is not judged');
});

test('a test log that cannot be read fails a run whose runner passed, and the script still removes its folder', (t) => {
  const where = folder(t);
  const run = runTests(where, ['hides.test.mjs']);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^Could not read the test log \S+files\.jsonl: /mu);
  assert.deepEqual(readdirSync(where.temp), []);
});

test('a test log removed or replaced after a file started fails a run whose runner passed, naming the log', (t) => {
  for (const file of ['drops.test.mjs', 'swaps.test.mjs']) {
    const where = folder(t);
    const run = runTests(where, [file]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /pass 1/u, 'the runner itself passed');
    assert.match(run.stderr, /^Could not read the test log \S+files\.jsonl: it was removed or replaced after 1 test file started, so their rows cannot be judged: run them again$/mu, file);
    assert.deepEqual(readdirSync(where.temp), [], file);
  }
});

test('a run that selected no test file passes', (t) => {
  const where = folder(t, { default: 0, files: {} });
  for (const args of [['none/*.test.mjs'], ['--test-shard=2/2', 'quiet.test.mjs']]) {
    const run = runTests(where, args);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /tests 0/u, args.join(' '));
    assert.doesNotMatch(run.stderr, /Could not read the test log/u, args.join(' '));
  }
});

test('a budget file that cannot be read fails a run whose runner passed, and the script still removes its folder', (t) => {
  for (const budget of ['{ not json', JSON.stringify({ default: 300, files: { 'quiet.test.mjs': 'many' } }), JSON.stringify({ files: {} }), JSON.stringify({ default: 300, files: null }), JSON.stringify({ default: 300, files: [] }), 'null']) {
    const where = folder(t, budget);
    const run = runTests(where, ['quiet.test.mjs']);
    assert.equal(run.status, 1, budget);
    assert.match(run.stderr, /^Could not read the child-process budget test\/child-process-budget\.json: /mu, budget);
    assert.deepEqual(readdirSync(where.temp), []);
  }
});

test('this repository`s budget is the default 300 and names only test files that exist, each above the default', () => {
  const budget = JSON.parse(readFileSync(path.join(ROOT, 'test/child-process-budget.json'), 'utf8'));
  assert.deepEqual(Object.keys(budget).sort(), ['default', 'files']);
  assert.equal(budget.default, 300);
  for (const [name, count] of Object.entries(budget.files)) {
    assert.ok(existsSync(path.join(ROOT, 'test', name)), `${name} names no test file`);
    assert.ok(name.endsWith('.test.mjs'), name);
    assert.ok(Number.isInteger(count) && count > budget.default && count % 50 === 0, `${name}: ${count} is not a multiple of 50 above the default`);
  }
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
