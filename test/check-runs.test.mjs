// The check-run record and the two rules built on it (docs/hooks.md#check-runs, docs/hooks.md#push-first): the PostToolUse
// hook records only a test run a shell call finished; the pull request body rule and the subagent stop hook refuse a pass
// no finished run supports; push-first refuses a full suite while the branch holds a commit its remote lacks; and
// `aidrian test changed` finds the test files a change touches.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  appendCheckRuns, checkRows, commandKey, fileTail, isFullSuite, mayRunTests, outputText, passClaims, readCheckRuns, runCounts, runStatus, testRuns, unsupportedClaims,
  workingTree,
} from '../plugins/aidrian/lib/check-runs.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { configDir } from '../plugins/aidrian/lib/hosts/claude-code-config.mjs';
import { detectHost, HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { check as prBody } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { check as pushFirst, unpushed } from '../plugins/aidrian/lib/rules/push-first.mjs';
import { lexPipeline, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';
import { needlesOf, testCommand, touchedTests } from '../plugins/aidrian/lib/test-changed.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT_DIR, 'plugins/aidrian/scripts');
const CLI = path.join(ROOT_DIR, 'plugins/aidrian/lib/cli.mjs');
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-runs-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const STATE = path.join(ROOT, 'state');
// This repository's own testing config: `npm run check` is its full suite, and push first is on.
const TESTING = { ...DEFAULTS.testing, fullSuite: ['npm run check'], pushFirstMinutes: 5 };
const CONFIG = { version: 1, testing: { fullSuite: ['npm run check'], pushFirstMinutes: 5 } };

// Git sees no config of the machine that runs the suite, in this process and in every one it starts.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_STATE_HOME: STATE });
const ENV = { PATH: process.env.PATH, HOME: ROOT, XDG_STATE_HOME: STATE, TMPDIR: process.env.TMPDIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDECODE: '1' };

let made = 0;
// A project in a git repository with one commit, on branch `feat/x`, and a bare remote named origin.
function repo({ config = CONFIG, files = {} } = {}) {
  made += 1;
  const dir = path.join(ROOT, `repo-${made}`);
  const remote = path.join(ROOT, `remote-${made}.git`);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  for (const [file, text] of Object.entries({ 'README.md': 'x\n', ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const git = gitIn(dir);
  git('init', '-q', '-b', 'feat/x');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { env: ENV }).status, 0);
  git('remote', 'add', 'origin', remote);
  return { dir, git };
}

const gitIn = (dir) => (...args) => {
  const ran = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, env: { ...ENV, ...gitDates }, encoding: 'utf8' });
  assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stderr}`);
  return ran.stdout.trim();
};
let gitDates = {};

const invocation = (text) => readInvocation(lexPipeline(text).segments[0]);

test('a test run is read through wrappers and redirects, and keyed the same way a claim names it', () => {
  assert.equal(commandKey(invocation('rtk npm run check 2>&1')), 'npm run check');
  assert.equal(commandKey(invocation('npx vitest run a.test.ts')), 'vitest run a.test.ts');
  assert.equal(commandKey(invocation('node plugins/aidrian/lib/cli.mjs test changed')), 'aidrian test changed');
  assert.deepEqual(testRuns('cd /x && npm run check 2>&1 | tail -5', '/w', TESTING), [{ key: 'npm run check', folder: '/x', carries: false }]);
  assert.deepEqual(testRuns('env -C /x npm run check', '/w', TESTING), [{ key: 'npm run check', folder: '/x', carries: true }], 'env -C, the form the worktree skills give, credits its folder');
  assert.deepEqual(testRuns('(cd /x && npm run check)', '/w', TESTING).map((run) => run.folder), [null], 'a subshell cd credits no folder');
  assert.deepEqual(testRuns('npm run check && git push', '/w', TESTING), [{ key: 'npm run check', folder: '/w', carries: true }]);
  assert.deepEqual(testRuns('git status; node --test test/a.test.mjs', '/w'), [{ key: 'node --test test/a.test.mjs', folder: '/w', carries: false }], 'after ; the line\'s status may be another\'s');
  assert.deepEqual(testRuns('true || npm test', '/w').map((run) => run.carries), [false], 'after || the run may not have run');
  assert.deepEqual(testRuns('npm test || true', '/w').map((run) => run.carries), [false], 'an || masks the run\'s status');
  assert.deepEqual(testRuns('git status && echo test', '/w'), [], 'a word is not a test run');
  assert.deepEqual(testRuns('npm run check', '/w'), [], 'the plugin names no project\'s check script');
  assert.ok(isFullSuite(invocation('npm run check'), TESTING));
  assert.ok(!isFullSuite(invocation('npm run check'), DEFAULTS.testing), 'not by default');
  assert.ok(!isFullSuite(invocation('npm test -- test/a.test.mjs'), TESTING), 'one file is no full suite');
});

// Summaries as each runner prints them at its end.
const VITEST_PASS = ' ✓ src/a.test.ts (3 tests) 5ms\n ✓ src/b.test.ts (2 tests) 3ms\n\n Test Files  2 passed (2)\n      Tests  5 passed (5)\n   Start at  10:00:00\n   Duration  300ms\n';
const VITEST_FAIL = ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 4 passed (5)\n';
const JEST_PASS = 'Test Suites: 2 passed, 2 total\nTests:       5 passed, 5 total\nSnapshots:   0 total\nTime:        0.5 s\nRan all test suites.\n';
const PYTEST_PASS = '============================= test session starts ==============================\ncollected 12 items\n\n' +
  'tests/test_a.py ............                                             [100%]\n\n============================== 12 passed in 0.05s ==============================\n';
const PYTEST_FAIL = '========================= 1 failed, 11 passed in 0.10s =========================\n';
const RSPEC = 'Finished in 0.01 seconds (files took 0.1 seconds to load)\n12 examples, 2 failures\n';
const MIX = 'Finished in 0.03 seconds (0.02s async, 0.01s sync)\n10 tests, 0 failures\n';
const PLAYWRIGHT = 'Running 5 tests using 2 workers\n\n  1) [chromium] › tests/a.spec.ts:3:5 › opens the page ─────────────\n\n' +
  '    Error: expect(received).toBe(expected)\n\n  1 failed\n    [chromium] › tests/a.spec.ts:3:5 › opens the page ─────────────\n' +
  '  4 passed (3.2s)\n';
const CARGO = 'running 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok\n\n' +
  'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n' +
  '     Running tests/it.rs (target/debug/deps/it-0a1b2c)\n\nrunning 2 tests\n' +
  'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\n' +
  '   Doc-tests mycrate\n\nrunning 0 tests\n\n' +
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
const JEST_TWO = 'Tests:       1 failed, 4 passed, 5 total\nTime:        1.2 s\n...\nTests:       3 passed, 3 total\nTime:        0.4 s\n';
const TURBO = 'web:test:  Test Files  2 passed (2)\nweb:test:       Tests  5 passed (5)\napi:test: Tests:       3 passed, 3 total\n' +
  ' Tasks:    2 successful, 2 total\n';

test('counts come from one summary: node\'s, else the Tests line, else the last summary line', () => {
  assert.deepEqual(runCounts('ℹ tests 5\nℹ pass 4\nℹ fail 1\n12 passed elsewhere'), { pass: 4, fail: 1 });
  assert.deepEqual(runCounts('# pass 3\n# fail 0\n'), { pass: 3, fail: 0 });
  assert.deepEqual(runCounts(VITEST_PASS), { pass: 5, fail: 0 }, 'the Tests line, not Test Files plus Tests');
  assert.deepEqual(runCounts(VITEST_FAIL), { pass: 4, fail: 1 });
  assert.deepEqual(runCounts(JEST_PASS), { pass: 5, fail: 0 }, 'the Tests line, not Test Suites plus Tests');
  assert.deepEqual(runCounts(PYTEST_PASS), { pass: 12, fail: 0 });
  assert.deepEqual(runCounts(PYTEST_FAIL), { pass: 11, fail: 1 });
  assert.deepEqual(runCounts(`lint: 3 passed\n${VITEST_PASS}`), { pass: 5, fail: 0 }, 'the Tests family alone, never another family added');
  assert.deepEqual(runCounts(PLAYWRIGHT), { pass: 4, fail: 1 }, 'Playwright\'s own lines');
  assert.deepEqual(runCounts(CARGO), { pass: 5, fail: 0 }, 'every cargo test result, the doc-tests\' 0 included');
  assert.deepEqual(runCounts(JEST_TWO), { pass: 7, fail: 1 }, 'two jest runs, the first failing');
  assert.deepEqual(runCounts(TURBO), { pass: 8, fail: 0 }, 'Tests lines behind a task prefix, not Test Files');
  assert.deepEqual(runCounts(`${VITEST_PASS}  2 failed\n`), { pass: 5, fail: 2 }, 'a bare failed line fails the run');
  assert.deepEqual(runCounts(`${VITEST_PASS}\u001b[31m  2 failed\u001b[39m\n`), { pass: 5, fail: 2 }, 'in colour too');
  const nodePass = '✔ lists 2 failed payments (1.2ms)\n✔ retries 3 failed jobs (0.4ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n';
  assert.deepEqual(runCounts(nodePass), { pass: 2, fail: 0 }, 'a node test named for failures passes');
  assert.equal(runStatus(runCounts(nodePass), false), 'passed');
  const vitestPass = ' ✓ src/pay.test.ts > lists 2 failed payments 3ms\n ✓ src/job.test.ts > retries 3 failed jobs 1ms\n\n' +
    ' Test Files  2 passed (2)\n      Tests  2 passed (2)\n';
  assert.deepEqual(runCounts(vitestPass), { pass: 2, fail: 0 }, 'a vitest test named for failures passes');
  assert.equal(runStatus(runCounts(vitestPass), false), 'passed');
  assert.deepEqual(runCounts('ℹ pass 4\nℹ fail 0\n  1 failed\n'), { pass: 4, fail: 0 }, 'node\'s fail count stands');
  assert.deepEqual(runCounts(RSPEC), { pass: 10, fail: 2 });
  assert.deepEqual(runCounts(MIX), { pass: 10, fail: 0 });
  assert.deepEqual(runCounts('lint ok'), { pass: null, fail: null });
  for (const output of [VITEST_PASS, JEST_PASS, PYTEST_PASS, MIX, CARGO, TURBO]) assert.equal(runStatus(runCounts(output), false), 'passed', output);
  for (const output of [VITEST_FAIL, PYTEST_FAIL, RSPEC, PLAYWRIGHT, JEST_TWO]) assert.equal(runStatus(runCounts(output), false), 'failed', output);
  assert.equal(runStatus({ pass: null, fail: null }, true), 'passed', 'an exit of 0 the line carries passes');
  assert.equal(runStatus({ pass: 4, fail: 1 }, true), 'failed');
  assert.equal(runStatus({ pass: null, fail: null }, false), 'unjudged', 'no exit status and no counts is no verdict');
});

// go test's output: `-v` names each test, and without it only each package's line says how it went.
const GO_VERBOSE = '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n=== RUN   TestB/one\n    --- PASS: TestB/one (0.00s)\n' +
  '--- PASS: TestB (0.00s)\nPASS\nok  \texample.test/pkg\t0.012s\n=== RUN   TestC\n--- PASS: TestC (0.00s)\nPASS\nok  \texample.test/other\t(cached)\n';
const GO_VERBOSE_FAIL = '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n    sum_test.go:9: got 3, want 4\n--- FAIL: TestB (0.00s)\n' +
  'FAIL\nFAIL\texample.test/pkg\t0.010s\nFAIL\n';
const GO_PACKAGES = 'ok  \texample.test/pkg\t0.012s\nok  \texample.test/other\t(cached)\n?   \texample.test/cmd\t[no test files]\n';
const GO_PACKAGES_FAIL = '--- FAIL: TestB (0.00s)\n    sum_test.go:9: got 3, want 4\nFAIL\nFAIL\texample.test/pkg\t0.010s\n' +
  'ok  \texample.test/other\t0.004s\nFAIL\texample.test/broken [build failed]\nFAIL\n';

test('go test counts its tests with -v, else its packages', () => {
  assert.deepEqual(runCounts(GO_VERBOSE), { pass: 3, fail: 0 }, 'top-level tests, not subtests or packages');
  assert.deepEqual(runCounts(GO_VERBOSE_FAIL), { pass: 1, fail: 1 });
  assert.deepEqual(runCounts(GO_PACKAGES), { pass: 2, fail: 0 }, 'a package with no test files is neither');
  assert.deepEqual(runCounts(GO_PACKAGES_FAIL), { pass: 0, fail: 2 }, 'a failing test, and a package that did not build');
  assert.deepEqual(runCounts('ok  \texample.test/other\t0.004s\nFAIL\texample.test/broken [build failed]\n'), { pass: 1, fail: 1 }, 'a package that did not build');
  for (const output of [GO_VERBOSE, GO_PACKAGES]) assert.equal(runStatus(runCounts(output), false), 'passed', output);
  for (const output of [GO_VERBOSE_FAIL, GO_PACKAGES_FAIL]) assert.equal(runStatus(runCounts(output), false), 'failed', output);
  assert.deepEqual(runCounts('ok 1 - adds\nok 2 - subtracts\n'), { pass: null, fail: null }, 'a TAP line is no go package');
});

// A `-v` run whose package failed with no `--- FAIL:` line of its own.
const GO_V_BUILD = '=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \texample.test/pkg\t0.010s\n' +
  '# example.test/broken\nbroken/x.go:3:1: syntax error: non-declaration statement outside function body\nFAIL\texample.test/broken [build failed]\nFAIL\n';
const GO_V_TIMEOUT = '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestSlow\npanic: test timed out after 1s\n\trunning tests:\n\t\tTestSlow (1s)\n\n' +
  'goroutine 7 [running]:\ntesting.(*M).startAlarm.func1()\nFAIL\texample.test/pkg\t1.012s\nFAIL\n';
const GO_V_MAIN_EXIT = '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- PASS: TestB (0.00s)\nPASS\nFAIL\texample.test/pkg\t0.008s\nFAIL\n';

test('a go -v run with a failed package fails, though no test of it printed FAIL', () => {
  for (const [output, why] of [[GO_V_BUILD, 'a package that did not build'], [GO_V_TIMEOUT, 'a timeout panic'], [GO_V_MAIN_EXIT, 'a TestMain that exited 1 after its tests passed']]) {
    assert.ok(runCounts(output).fail >= 1, why);
    assert.equal(runStatus(runCounts(output), false), 'failed', why);
    const [row] = checkRows({ command: 'go test -v ./... | tee go.log', cwd: '/w', output, exitZero: true, tree: () => ({ tree: 't', trackedTree: 't' }), at: 't' });
    assert.equal(row.status, 'failed', `${why}, behind a pipe`);
  }
  assert.deepEqual(runCounts(GO_V_MAIN_EXIT), { pass: 2, fail: 1 });
});

test('a go package with no tests to run counts no pass', () => {
  assert.deepEqual(runCounts('ok  \texample.test/pkg\t0.005s [no tests to run]\n'), { pass: 0, fail: 0 });
  assert.deepEqual(runCounts('?   \texample.test/cmd\t[no test files]\n'), { pass: 0, fail: 0 });
  const skipped = '=== RUN   TestA\n    a_test.go:5: needs a database\n--- SKIP: TestA (0.00s)\nPASS\nok  \texample.test/pkg\t0.004s\n';
  assert.deepEqual(runCounts(skipped), { pass: 0, fail: 0 }, 'a -v run whose tests were all skipped');
  const [row] = checkRows({ command: 'go test -run TestNone ./...', cwd: '/w', output: 'ok  \texample.test/pkg\t0.005s [no tests to run]\n', exitZero: true, tree: () => ({ tree: 't', trackedTree: 't' }), at: 't' });
  assert.equal(row.pass, 0);
  assert.equal(unsupportedClaims(passClaims('`go test -run TestNone ./...` passed', { section: null }), [row], { tree: 't' }).length, 1, 'supports no claim');
  // Go packages that count nothing leave the counts to the next family a script's output holds.
  assert.deepEqual(runCounts('?   \texample.test/cmd\t[no test files]\n============== 12 passed in 0.50s ==============\n'), { pass: 12, fail: 0 }, 'go, then pytest');
  assert.deepEqual(runCounts(`${skipped}============== 12 passed in 0.50s ==============\n`), { pass: 12, fail: 0 }, 'an all-skipped go -v run, then pytest');
});

test('the working trees count uncommitted files, with and without the untracked ones, and match the commit that holds them', () => {
  const { dir, git } = repo();
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  writeFileSync(path.join(dir, 'scratch.txt'), 'n\n');
  const before = workingTree(dir);
  assert.notEqual(before.tree, before.trackedTree, 'the scratch file is in one tree only');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'second');
  assert.equal(before.trackedTree, git('rev-parse', 'HEAD^{tree}'), 'a commit that leaves the scratch file out');
  git('add', '-A');
  git('commit', '-q', '-m', 'third');
  assert.equal(before.tree, git('rev-parse', 'HEAD^{tree}'), 'a commit that holds it');
  assert.deepEqual(before.untrackedCode, [], 'a text file is no code');
  assert.deepEqual(workingTree(path.join(dir, '.aidrian')), { tree: before.tree, trackedTree: before.tree, untrackedCode: [] }, 'from a subfolder too');
  assert.equal(git('status', '--porcelain'), '', 'the checkout\'s own index is untouched');
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib/new.mjs'), 'x\n');
  assert.deepEqual(workingTree(path.join(dir, '.aidrian')).untrackedCode, ['lib/new.mjs'], 'untracked code, from the top');
});

test('a row a finished run, with the status the line carries', () => {
  const tree = () => ({ tree: 'abc', trackedTree: 'abd' });
  const row = (command, output, exitZero = true) => checkRows({ command, cwd: '/w', output, exitZero, tree, at: 't', testing: TESTING });
  assert.deepEqual(row('npm run check', 'ℹ pass 4\nℹ fail 0'), [{ at: 't', agentId: null, command: 'npm run check', tree: 'abc', trackedTree: 'abd', untrackedCode: [], status: 'passed', pass: 4, fail: 0 }]);
  assert.equal(row('npm run check | tail -3', 'lint ok')[0].status, 'unjudged', 'a pipe hides the exit status, and no count says');
  assert.equal(row('npm run check | tail -3', 'ℹ pass 9\nℹ fail 0')[0].status, 'passed');
  assert.equal(row('npm run check', 'ℹ pass 9\nℹ fail 0', false)[0].status, 'passed', 'a host with no exit status judges by counts');
  assert.equal(row('npm run check', 'lint ok', false)[0].status, 'unjudged', 'and leaves a run with no count unjudged');
  assert.deepEqual(row('git status', ''), []);
  assert.deepEqual(checkRows({ command: 'npm test', cwd: '/w', output: '', exitZero: true, tree: () => ({ tree: null, trackedTree: null }), at: 't' }),
    [{ at: 't', agentId: null, command: 'npm test', tree: null, trackedTree: null, untrackedCode: [], status: 'passed', pass: null, fail: null }], 'no tree: the row says so');
  // A run behind a word the shell may not run, as a zero count, may never have run: it records no row.
  for (const command of ['repeat 0 npm test', 'noglob npm test', 'case $x in a ) npm test ;; esac']) assert.deepEqual(row(command, ''), [], command);
  assert.equal(row('command npm test', '').length, 1, 'command runs an external program in every shell: the run keeps its row');
  assert.equal(row('repeat 0 npm test && npm run check', 'ℹ pass 4\nℹ fail 0').map((each) => each.command).join(), 'npm run check', 'the run that certainly ran keeps its row');
});

const BODY = (lines) => `## Summary\n\n- x\n\n## Tests run\n\n${lines.join('\n')}\n`;

test('a pass claim names a test command and a pass, and never a failure, an unfinished run, or CI', () => {
  const claims = passClaims(BODY([
    '- `npm run check`: 4071/4071 pass',
    '- `node --test test/a.test.mjs`: 40 failures under load; rerun alone: pass',
    '- CI `npm run check`: green',
    '- `npm run check`: not finished',
    '- npm run check passed, 12 pass',
    '- `npm test`: all',
    '  12 passed, wrapped onto the next line',
    '```',
    'ℹ pass 3 `npm test` passed',
    '```',
  ]), { testing: TESTING });
  assert.deepEqual(claims, [
    { clause: '- `npm run check`: 4071/4071 pass', key: 'npm run check', counts: [4071], commits: [] },
    { clause: '- npm run check passed, 12 pass', key: 'npm run check', counts: [12], commits: [] },
    { clause: '- `npm test`: all 12 passed, wrapped onto the next line', key: 'npm test', counts: [12], commits: [] },
  ]);
  assert.deepEqual(passClaims('## Summary\n\n`npm test` passed\n'), [], 'only the Tests run section');
  assert.equal(passClaims('`npm test` passed', { section: null }).length, 1, 'a whole report with no section');
  assert.deepEqual(passClaims('`npm test` at 056c3c2 passed, 1234567 of them', { section: null })[0].commits, ['056c3c2'], 'a count is no commit id');
  // About one abbreviated id in 27 is all digits: after "at" or "commit" it is still one.
  assert.deepEqual(passClaims('`npm test` at 3854814: 4071/4071 pass', { section: null })[0].commits, ['3854814'], 'an id of only digits');
  assert.deepEqual(passClaims('`npm test` passed at commit 3854814, 1234567 of them', { section: null })[0].commits, ['3854814']);
  assert.deepEqual(passClaims('`npm test` at `3854814`: 12 pass', { section: null })[0].commits, ['3854814'], 'an id in backticks');
  assert.deepEqual(passClaims('Commit 3854814: `npm test` 12 pass', { section: null })[0].commits, ['3854814'], 'a capital');
  assert.deepEqual(passClaims('At 3854814, `npm test`: 12 pass', { section: null })[0].commits, ['3854814']);
  assert.equal(passClaims('`git status` is clean and `npm run lint` passed', { section: null }).length, 0, 'no test command');
  assert.deepEqual(passClaims('`npm test` on Node 22 pass', { section: null })[0].counts, [], 'a number after a word is a name');
});

test('a report\'s own claims leave out what it quotes from another source', () => {
  const report = [
    'Read the pull request.',
    '',
    '> `npm run check`: 4071/4071 pass',
    '',
    'The pull request body says `npm test` passed, which the record does not show.',
    'According to the reviewer, `npm test` passed.',
    'PR #383 claimed `node --test test/a.test.mjs` passed; the backend-developer handoff reported `vitest run` passed.',
    'The reviewer wrote "`npm test` passed" in a comment.',
    'The output says `pytest` passed, 12 passed.',
  ].join('\n');
  const own = passClaims(report, { section: null, ownOnly: true });
  assert.deepEqual(own.map(({ key, counts }) => ({ key, counts })), [{ key: 'pytest', counts: [12] }], 'the writer\'s own run alone');
  const all = passClaims(report, { section: null }).map(({ key }) => key);
  assert.deepEqual(all, ['npm test', 'npm test', 'node --test test/a.test.mjs', 'vitest run', 'npm test', 'pytest'], 'a pull request body reads every line');
  assert.equal(passClaims('> `npm test` passed\n`npm test` passed', { section: null, ownOnly: true }).length, 1, 'a line after a block quote is the writer\'s');
  assert.deepEqual(passClaims('The reviewer says `npm test` passed, and `vitest run` passed 3/3.', { section: null, ownOnly: true }).map(({ key }) => key),
    ['vitest run'], 'the part after a coordinating "and" is the writer\'s');
  assert.deepEqual(passClaims('The PR body says `npm test` and `vitest run` passed.', { section: null, ownOnly: true }), [],
    'a source\'s part that ends at its commands carries into the next part');
});

test('a source\'s part carries into the next only when it ends at its commands', () => {
  const own = (text) => passClaims(text, { section: null, ownOnly: true, testing: TESTING }).map(({ key, counts }) => ({ key, counts }));
  assert.deepEqual(own('The reviewer reported `npm test` failed on Node 22, and `npm test` now passes: 12/12.'), [{ key: 'npm test', counts: [12] }]);
  assert.deepEqual(own('The issue says `npm test` hangs, and `vitest run` passed 3/3.'), [{ key: 'vitest run', counts: [3] }]);
  assert.deepEqual(own('The reviewer said `npm run lint` needs a fix and `npm test` passed 40/40'), [{ key: 'npm test', counts: [40] }]);
  assert.deepEqual(own('The PR body says npm run check and `vitest run` passed.'), [], 'a full suite as plain words ends the list too');
});

test('words in double quotes are the writer\'s own; an outside source is what drops a claim', () => {
  const own = (text) => passClaims(text, { section: null, ownOnly: true, testing: TESTING }).map(({ key, counts }) => ({ key, counts }));
  assert.deepEqual(own('`npm run check` reported "4071/4071 pass".'), [{ key: 'npm run check', counts: [4071] }]);
  assert.deepEqual(own('Ran `npm test`, which reported "126/126 pass".'), [{ key: 'npm test', counts: [126] }]);
  assert.deepEqual(own('The output reads: "`npm test` 40/40 pass".'), [{ key: 'npm test', counts: [40] }]);
  assert.deepEqual(own('The reviewer wrote "`npm test` passed"'), [], 'a source and a verb of saying');
});

test('a report that is or opens with a JSON object is read a string value at a time', () => {
  const own = (text) => passClaims(text, { section: null, ownOnly: true, testing: TESTING }).map(({ key, counts }) => ({ key, counts }));
  const handoff = { status: 'done', role: 'backend-developer', evidence: ['`npm run check` at f9d8ace: 3817/3817 pass', 'lib/a.mjs: the fix'], risks: [] };
  assert.deepEqual(own(JSON.stringify(handoff)), [{ key: 'npm run check', counts: [3817] }], 'a bare JSON handoff');
  assert.deepEqual(own(JSON.stringify(handoff, null, 2)), [{ key: 'npm run check', counts: [3817] }], 'pretty-printed');
  const quoting = { status: 'done', evidence: ['The PR body says `npm test` passed'] };
  assert.deepEqual(own(`${JSON.stringify(quoting)}\n\nDone. \`npm run check\`: 12/12 pass.`), [{ key: 'npm run check', counts: [12] }],
    'a JSON object then prose: the source\'s value is dropped, the prose kept');
  assert.deepEqual(own('{"status": "done", unparsed `npm test` passed 3/3'), [{ key: 'npm test', counts: [3] }], 'an object that does not parse is plain text');
  const later = { evidence: ['The PR body says `npm test` passed', '`npm run check`: 12/12 pass'] };
  assert.deepEqual(own(`Done.\n\n${JSON.stringify(later)}`), [{ key: 'npm run check', counts: [12] }], 'prose, then the JSON object on a line of its own');
  assert.deepEqual(own(`Done.\n\n\`\`\`json\n${JSON.stringify(later, null, 2)}\n\`\`\`\n\nAll good.`), [{ key: 'npm run check', counts: [12] }],
    'a JSON object in a json fence');
});

test('a `{` line inside fenced code is no handoff, and a claim after the fence still counts', () => {
  const own = (text) => passClaims(text, { section: null, ownOnly: true, testing: TESTING }).map(({ key, counts }) => ({ key, counts }));
  const config = '{"testing": {"fullSuite": ["npm run check"]}}';
  for (const [fence, why] of [['```', 'a plain fence'], ['```jsonc', 'a jsonc fence']]) {
    assert.deepEqual(own(`The config now reads:\n\n${fence}\n${config}\n\`\`\`\n\n\`npm run check\`: 12/12 pass.`), [{ key: 'npm run check', counts: [12] }], why);
  }
  assert.deepEqual(own(`The config now reads:\n\n\`\`\`json\n${config}\n{"broken":\n\`\`\`\n\n\`npm run check\`: 12/12 pass.`), [{ key: 'npm run check', counts: [12] }],
    'a json fence that does not parse, with a whole object on a line of it');
  const many = '```json\n{"a": "x"}\n```\n'.repeat(10_000);
  assert.deepEqual(own(`${many}\n\`npm run check\`: 12/12 pass.`), [{ key: 'npm run check', counts: [12] }], '10,000 json fences, then an own claim');
  const deep = `${'['.repeat(5000)}"\`npm test\` passed 1/1"${']'.repeat(5000)}`;
  assert.deepEqual(own(`\`\`\`json\n${deep}\n\`\`\``), [{ key: 'npm test', counts: [1] }], 'deep nesting reads with no recursion');
  const wide = JSON.stringify(Array.from({ length: 300_000 }, () => 0));
  assert.deepEqual(own(`\`\`\`json\n${wide}\n\`\`\`\n\n\`npm run check\`: 12/12 pass.`), [{ key: 'npm run check', counts: [12] }], 'a 300,000-element array, then an own claim');
});

test('a report\'s own claim stays one when it names a source that does not say the command', () => {
  const own = (text) => passClaims(text, { section: null, ownOnly: true, testing: TESTING }).map(({ key, counts }) => ({ key, counts }));
  for (const [text, counts] of [
    ['According to the test output, `npm test` passed, 120/120.', [120]],
    ['`npm test` passed 120/120, according to my run.', [120]],
    ['Fixed the issue reported in the ticket and `npm test` passed 40/40.', [40]],
    ['Fixed the two findings the reviewer reported, and `npm test` now passes: 12 passed.', [12]],
    ['Updated the fixture according to the spec and `npm test` passed.', []],
    ['This report states `npm test` passed 40/40.', [40]],
    ['My final report lists `npm test` passed 40/40.', [40]],
    ['This final report states `npm test` passed 40/40.', [40]],
    ['My handoff lists `npm test` passed 40/40.', [40]],
    ['According to my review, `npm test` passed 40/40.', [40]],
    ['This agent reports `npm test` passed 40/40.', [40]],
    ['This subagent reports `npm test` passed 40/40.', [40]],
  ]) assert.deepEqual(own(text), [{ key: 'npm test', counts }], text);
  assert.deepEqual(own('The final report states `npm test` passed 40/40.'), [], 'a report not the writer\'s');
  assert.deepEqual(own('My subagent reports `npm test` passed 40/40.'), [], 'a subagent is another agent');
  assert.deepEqual(own('The PR body says npm run check passed.'), [], 'a full suite named as plain words, said by a source');
});

test('quotes inside a code span are the command\'s, and its claim is checked', () => {
  const [claim] = passClaims('`pytest -k "adds"` passed, 12 passed.', { section: null, ownOnly: true });
  assert.equal(claim?.key, 'pytest -k adds');
  const rows = checkRows({ command: 'pytest -k "adds"', cwd: '/w', output: PYTEST_PASS, exitZero: true, tree: () => ({ tree: 't', trackedTree: 't' }), at: 't' });
  assert.deepEqual(unsupportedClaims([claim], rows, { tree: 't' }), [], 'its own run supports it');
});

test('a claim needs a run of its command that passed, at the tree, with the count it states', () => {
  const claims = [{ clause: 'c', key: 'npm run check', counts: [4071] }];
  const run = { command: 'npm run check', status: 'passed', pass: 4071, fail: 0, tree: 't1', trackedTree: 't3' };
  assert.deepEqual(unsupportedClaims(claims, [run], { tree: 't1' }), []);
  assert.deepEqual(unsupportedClaims(claims, [run], { tree: 't3' }), [], 'the tracked files\' tree');
  assert.equal(unsupportedClaims(claims, [{ ...run, untrackedCode: ['lib/new.mjs'] }], { tree: 't3' }).length, 1, 'not beside untracked code');
  assert.deepEqual(unsupportedClaims(claims, [{ ...run, untrackedCode: ['lib/new.mjs'] }], { tree: 't1' }), [], 'whose full tree still counts');
  assert.equal(unsupportedClaims(claims, [run], { tree: 't2' }).length, 1, 'another tree');
  assert.equal(unsupportedClaims(claims, [{ ...run, pass: 4031, fail: 40, status: 'failed' }], { tree: 't1' }).length, 1, 'a failed run');
  assert.equal(unsupportedClaims(claims, [{ ...run, status: 'unjudged', pass: null, fail: null }], { tree: 't1' }).length, 1, 'an unjudged run');
  assert.equal(unsupportedClaims(claims, [{ ...run, pass: 12 }], { tree: 't1' }).length, 1, 'another count');
  assert.deepEqual(unsupportedClaims(claims, [{ ...run, pass: null }], { tree: 't1' }), [], 'a run that printed no count');
  assert.equal(unsupportedClaims([{ ...claims[0], counts: [] }], [{ ...run, pass: 0 }], { tree: 't1' }).length, 1, 'a run of no tests');
  assert.equal(unsupportedClaims(claims, []).length, 1, 'no run at all');
});

test('the record appends, reads back, and keeps its newest rows past its cap', () => {
  const state = path.join(ROOT, 'record-state');
  mkdirSync(path.join(state, 'sessions/s1'), { recursive: true, mode: 0o700 });
  const folder = realpathSync(path.join(state, 'sessions/s1'));
  const row = (index) => ({ at: 't', agentId: null, command: `node --test t${index}.test.mjs`, tree: 'x'.repeat(40), status: 'passed', pass: index, fail: 0 });
  for (let index = 0; index < 600; index += 1) assert.ok(appendCheckRuns(folder, [row(index)]), `row ${index}`);
  const rows = readCheckRuns(folder);
  assert.equal(rows.at(-1).pass, 599);
  assert.ok(rows.length < 600 && rows.length > 100, `kept ${rows.length}`);
});

// The PostToolUse payload Claude Code sends for a Bash call.
const postPayload = (command, { cwd, session, stdout = '', response, agent } = {}) => ({
  session_id: session, transcript_path: path.join(ROOT, 'none.jsonl'), cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash',
  ...(agent ? { agent_id: agent, agent_type: 'aidrian:backend-developer' } : {}),
  tool_input: { command, description: 'x' },
  tool_response: response ?? { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
});
const runScript = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env: ENV });

// The rows the session's record holds, under every project's state folder.
function recorded(session) {
  const projects = path.join(STATE, 'aidrian/projects');
  let rows = [];
  let ids = [];
  try {
    ids = readdirSync(projects);
  } catch {
    // No project has a state folder yet.
  }
  for (const id of ids) {
    try {
      rows = rows.concat(readFileSync(path.join(projects, id, 'sessions', session, 'checks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
    } catch {
      // No record in this project.
    }
  }
  return rows;
}

test('the PostToolUse hook records a finished run, and nothing for one stopped or in the background', () => {
  const { dir, git } = repo();
  const tree = git('rev-parse', 'HEAD^{tree}');
  const ran = runScript('hook-bash-post.mjs', postPayload('npm run check 2>&1', { cwd: dir, session: 'rec-1', stdout: 'ℹ pass 7\nℹ fail 0\n' }));
  assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, '', '']);
  assert.deepEqual(recorded('rec-1').map(({ command, status, pass, fail, tree: at, trackedTree }) => ({ command, status, pass, fail, at, trackedTree })),
    [{ command: 'npm run check', status: 'passed', pass: 7, fail: 0, at: tree, trackedTree: tree }]);
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'rec-2', response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }));
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'rec-2', response: { stdout: 'ℹ pass 1', stderr: '', interrupted: true } }));
  assert.deepEqual(recorded('rec-2'), [], 'a run in the background or stopped records nothing');
});

test('a call whose output Claude Code kept in a file is counted from that file\'s tail', () => {
  const { dir, git } = repo();
  const tree = git('rev-parse', 'HEAD^{tree}');
  // Claude Code keeps a long stdout whole in a file, and sends only its head in the payload.
  const lines = Array.from({ length: 2000 }, (_, index) => `✔ case ${index} (0.1ms)`).join('\n');
  const whole = `${lines}\nℹ tests 2000\nℹ pass 2000\nℹ fail 0\n`;
  assert.ok(Buffer.byteLength(whole) > 30_000);
  // Where Claude Code keeps it: <config>/projects/<project>/<session>/tool-results/. The hooks run with HOME at ROOT.
  const results = path.join(ROOT, '.claude/projects/-work-app', `s-${made}`, 'tool-results');
  mkdirSync(results, { recursive: true });
  const file = path.join(results, 'b1.txt');
  writeFileSync(file, whole);
  const response = { stdout: whole.slice(0, 30_000), stderr: '', interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: file, persistedOutputSize: whole.length };
  const claude = detectHost({ env: { CLAUDECODE: '1' } });
  assert.deepEqual(claude.shellRun(response, { CLAUDE_CONFIG_DIR: path.join(ROOT, '.claude') }).persisted, { file, after: '' });
  // With no CLAUDE_CONFIG_DIR, the config folder is `.claude` under HOME, as the hook's environment gives it.
  assert.deepEqual(claude.shellRun(response, { HOME: ROOT }).persisted, { file, after: '' }, 'the env\'s HOME');
  assert.equal(claude.shellRun({ stdout: 'o', stderr: '' }, { HOME: ROOT }).persisted, null);
  assert.equal(configDir({ HOME: '/h' }), path.join('/h', '.claude'));
  assert.equal(configDir({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }), '/c');
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'persist-1', response }));
  assert.deepEqual(recorded('persist-1').map(({ status, pass, fail, tree: at }) => ({ status, pass, fail, at })), [{ status: 'passed', pass: 2000, fail: 0, at: tree }]);

  // Bounded as the payload's text is: only the last 64 KB is read, so a summary at the end of a larger file still counts.
  const big = path.join(ROOT, `persisted-big-${made}.txt`);
  writeFileSync(big, `ℹ pass 1\n${'x'.repeat(200 * 1024)}\nℹ pass 9\nℹ fail 0\n`);
  assert.deepEqual(runCounts(outputText('head', { file: big, after: '' })), { pass: 9, fail: 0 }, 'the head\'s count is beyond the tail');
  assert.equal(Buffer.byteLength(fileTail(big)), 64 * 1024);
  assert.deepEqual(runCounts(outputText('ℹ pass 3', { file: path.join(ROOT, 'none.txt'), after: '' })), { pass: 3, fail: null }, 'no file: the payload\'s text');
  const link = path.join(ROOT, `persisted-link-${made}.txt`);
  symlinkSync(file, link);
  assert.equal(fileTail(link), null, 'a symlink is never read');
  assert.equal(fileTail('relative.txt'), null);
  assert.equal(outputText('out', { file, after: 'warning\nℹ fail 1' }).endsWith('ℹ fail 0\n\nwarning\nℹ fail 1'), true, 'the stderr after it');
});

test('a persisted output path is read only in a tool-results folder under Claude Code\'s projects folder', () => {
  const claude = detectHost({ env: { CLAUDECODE: '1' } });
  const config = path.join(ROOT, `config-${made}`);
  const results = path.join(config, 'projects/-work-app/s1/tool-results');
  mkdirSync(results, { recursive: true });
  const inside = path.join(results, 'b1.txt');
  writeFileSync(inside, 'ℹ pass 1\n');
  const persisted = (file, env = { CLAUDE_CONFIG_DIR: config }) => claude.shellRun({ stdout: 'head', stderr: '', persistedOutputPath: file }, env).persisted;
  assert.deepEqual(persisted(inside), { file: inside, after: '' });
  // A tool-results folder anywhere else, as one a command made in the project, is no output of a call.
  const elsewhere = path.join(ROOT, `elsewhere-${made}/tool-results`);
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, 'b1.txt'), 'ℹ pass 1\n');
  assert.equal(persisted(path.join(elsewhere, 'b1.txt')), null, 'a path outside the projects folder');
  assert.equal(persisted(path.join(config, 'projects/-work-app/s1/b1.txt')), null, 'outside a tool-results folder');
  // A tool-results folder under projects that links to one elsewhere resolves outside it.
  symlinkSync(elsewhere, path.join(config, 'projects/-work-app/s2'));
  assert.equal(persisted(path.join(config, 'projects/-work-app/s2/b1.txt')), null, 'a symlinked parent that resolves outside');
  mkdirSync(path.join(config, 'projects/-work-app/s3'));
  symlinkSync(elsewhere, path.join(config, 'projects/-work-app/s3/tool-results'));
  assert.equal(persisted(path.join(config, 'projects/-work-app/s3/tool-results/b1.txt')), null, 'a symlinked tool-results folder that resolves outside');
  // A config folder reached through a symlink still holds the real projects folder.
  const linked = path.join(ROOT, `config-link-${made}`);
  symlinkSync(config, linked);
  const through = path.join(linked, 'projects/-work-app/s1/tool-results/b1.txt');
  assert.deepEqual(persisted(through, { CLAUDE_CONFIG_DIR: linked }), { file: inside, after: '' }, 'a symlinked config folder');
  assert.deepEqual(persisted(inside, { CLAUDE_CONFIG_DIR: linked }), { file: inside, after: '' });
  symlinkSync(path.join(elsewhere, 'b1.txt'), path.join(results, 'link.txt'));
  assert.equal(persisted(path.join(results, 'link.txt')), null, 'a symlinked file');
  if (process.platform !== 'win32') {
    const fifo = path.join(results, 'fifo.txt');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.equal(persisted(fifo), null, 'a FIFO');
    assert.equal(fileTail(fifo), null, 'and fileTail never blocks on one');
  }
});

test('the shell adapters say whether a call finished and whether its exit status is known', () => {
  const claude = detectHost({ env: { CLAUDECODE: '1' } });
  assert.equal(claude.id, 'claude-code');
  assert.deepEqual(claude.shellRun({ stdout: 'o', stderr: 'e', interrupted: false }), { output: 'o\ne', persisted: null, finished: true, exitZero: true });
  assert.equal(claude.shellRun({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b' }).finished, false);
  const codex = HOSTS.find((host) => host.id === 'codex');
  assert.equal(codex.id, 'codex');
  assert.deepEqual(codex.shellRun('out'), { output: 'out', finished: true, exitZero: false });
});

test('the pull request body rule refuses a pass the session record does not support', () => {
  // The test's folders are all in the system temp folder, which the rule otherwise refuses a body file in.
  const { dir, git } = repo({ config: { ...CONFIG, github: { pullRequest: { sharedTempBodyFile: false } } } });
  const tree = git('rev-parse', 'HEAD^{tree}');
  const bodyFile = path.join(ROOT, `body-${made}.md`);
  const create = `gh pr create --draft --title "fix: x" --body-file ${bodyFile}`;
  const judge = (lines, runs, { command = create, open = [] } = {}) => {
    writeFileSync(bodyFile, BODY(lines));
    return prBody(command, { cwd: dir, env: {}, listOpenPrs: () => open, readRuns: () => runs });
  };
  const claim = '- `npm run check`: 4071/4071 pass';
  const run = { command: 'npm run check', status: 'passed', pass: 4071, fail: 0, tree, trackedTree: tree };
  assert.match(judge([claim], []), /^Blocked: the `## Tests run` section says `npm run check` passed, but no run of it/u);
  assert.equal(judge([claim], [run]), null);
  assert.match(judge([claim], [{ ...run, pass: 4031, fail: 40, status: 'failed' }]), /The record holds failed \(pass 4031, fail 40\)/u);
  assert.match(judge([claim], [{ ...run, pass: null, fail: null, status: 'unjudged' }]), /The record holds unjudged at tree/u);
  assert.match(judge([claim], [{ ...run, tree: null, trackedTree: null }]), /at a tree git could not read/u);
  assert.match(judge([claim], [{ ...run, tree: 'f'.repeat(40), trackedTree: 'e'.repeat(40) }]), /the files of HEAD \(tree [0-9a-f]{12}\), or of the commit the line names/u);
  assert.equal(judge(['- `npm run check`: not finished (stopped under load)', '- CI `Check (Node 22)`: pass'], []), null);
  assert.equal(judge([claim], null), null, 'a session with no readable record is not judged');
  assert.equal(judge([claim], [], { command: `${create} --head other-branch` }), null, 'a body for another branch is not judged');

  // A run made beside an untracked code file, then a commit that leaves the file out: the run may have loaded it.
  writeFileSync(path.join(dir, 'README.md'), 'fixed\n');
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib/new.mjs'), 'export const n = 1;\n');
  const withCode = workingTree(dir);
  git('add', 'README.md');
  git('commit', '-q', '-m', 'fix');
  assert.match(judge([claim], [{ ...run, ...withCode }]) ?? '', /Untracked code beside the run, which the commit lacks: `lib\/new\.mjs`; `git add` it, or remove it, and rerun\./u);
  // The same beside an untracked scratch note: the tracked files' tree matches the commit.
  rmSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), 'fixed again\n');
  writeFileSync(path.join(dir, 'scratch.md'), 's\n');
  const ran = workingTree(dir);
  git('add', 'README.md');
  git('commit', '-q', '-m', 'fix again');
  assert.equal(judge([claim], [{ ...run, ...ran }]), null, 'the tracked files\' tree matches the commit');

  // Reword the commit, keeping its tree, until its abbreviated id is all digits, as one in about 27 is.
  for (let tries = 0; !/^[0-9]{7}/u.test(git('rev-parse', 'HEAD')); tries += 1) {
    assert.ok(tries < 2000, 'no commit id of only digits');
    git('commit', '-q', '--amend', '-m', `fix again ${tries}`);
  }
  const first = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'later.txt'), 'l\n');
  git('add', 'later.txt');
  git('commit', '-q', '-m', 'later');
  assert.match(judge([claim], [{ ...run, ...ran }]) ?? '', /^Blocked/u, 'a run of an earlier commit is not one of HEAD');
  assert.equal(judge([`- \`npm run check\` at ${first.slice(0, 7)}: 4071/4071 pass`], [{ ...run, ...ran }]), null, 'a line that names the commit its run was of');
  // Digits alone that git cannot read are a number, never a commit that leaves the line unjudged.
  assert.match(judge(['- `npm run check` passed at 1234567 ms: 4071/4071 pass'], [{ ...run, ...ran }]) ?? '', /^Blocked/u, 'a time is no commit');
  const named = `- \`npm run check\` at ${first.slice(0, 7)} passed at 20261119: 4071/4071 pass`;
  assert.equal(judge([named], [{ ...run, ...ran }]), null, 'the commit git reads, not the date after it');
  assert.match(judge([named], [{ ...run, tree: 'f'.repeat(40), trackedTree: 'e'.repeat(40) }]) ?? '', /^Blocked/u, 'and a run of another tree');

  // An edit judges only the lines its pull request's body lacks, and only for this branch's pull request.
  const edit = `gh pr edit 7 --body-file ${bodyFile}`;
  const acme = { headRepositoryOwner: { login: 'acme' } };
  const open = [{ number: 7, headRefName: 'feat/x', body: BODY([claim]), ...acme }, { number: 8, headRefName: 'other', body: '', ...acme }];
  assert.equal(judge([claim, '- more text'], [], { command: edit, open }), null, 'a line the body already held');
  assert.match(judge([claim, '- `npm test`: 3 passed'], [], { command: edit, open }) ?? '', /says `npm test` passed/u, 'a new line');
  assert.equal(judge(['- `npm test`: 3 passed'], [], { command: `gh pr edit 8 --body-file ${bodyFile}`, open }), null, 'another branch\'s pull request');
  assert.equal(judge(['- `npm test`: 3 passed'], [], { command: `gh pr edit 9 --body-file ${bodyFile}`, open }), null, 'a pull request the list cannot show');
  assert.match(judge(['- `npm test`: 3 passed'], [], { command: `gh pr edit --body-file ${bodyFile}`, open: null }) ?? '', /^Blocked/u, 'this branch\'s pull request, no list');
  // An edit that names its pull request by branch name reads that pull request's body, matched by its head.
  const byBranch = `gh pr edit feat/x --body-file ${bodyFile}`;
  assert.equal(judge([claim, '- more text'], [], { command: byBranch, open }), null, 'a line the branch\'s body already held');
  assert.match(judge([claim, '- `npm test`: 3 passed'], [], { command: byBranch, open }) ?? '', /says `npm test` passed/u, 'a new line');
  const owned = judge([claim, '- `npm test`: 3 passed'], [], { command: `gh pr edit acme:feat/x --body-file ${bodyFile}`, open }) ?? '';
  assert.match(owned, /says `npm test` passed/u, 'a new line under an owner:branch target');
  assert.doesNotMatch(owned, /`npm run check`/u, 'and only the new line');
  assert.equal(judge(['- `npm test`: 3 passed'], [], { command: `gh pr edit other --body-file ${bodyFile}`, open }), null, 'another branch\'s pull request');
  const slashed = [{ number: 3, headRefName: 'feat/x', body: BODY([claim]) }];
  assert.equal(judge(['- `npm test`: 3 passed'], [], { command: `gh pr edit team/pull/3 --body-file ${bodyFile}`, open: slashed }), null, 'a branch named like a URL path is a branch');
  // Two open pull requests share the head's name, one from a fork: the owner settles which, and nothing else does.
  const twins = [open[0], { number: 9, headRefName: 'feat/x', body: '', headRepositoryOwner: { login: 'fork' } }];
  assert.equal(judge([claim], [], { command: `gh pr edit acme:feat/x --body-file ${bodyFile}`, open: twins }), null, 'the owner\'s pull request, whose body held the line');
  assert.match(judge([claim], [], { command: `gh pr edit fork:feat/x --body-file ${bodyFile}`, open: twins }) ?? '', /^Blocked/u, 'the fork\'s, whose body did not');
  assert.match(judge([claim], [], { command: byBranch, open: twins }) ?? '', /^Blocked/u, 'unsettled: every line is judged');
});

test('the subagent stop hook sends back once a report that claims a pass its own finished run does not show', () => {
  const { dir } = repo();
  const transcript = path.join(ROOT, `agent-${made}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: 'go' } })}\n`);
  const stop = (session, message, active = false) => runScript('hook-subagent-stop.mjs', {
    session_id: session, cwd: dir, agent_id: 'a1', agent_type: 'aidrian:backend-developer', agent_transcript_path: transcript, last_assistant_message: message, stop_hook_active: active,
  });
  const claim = 'Done. `npm run check`: 4071/4071 pass.';
  const sent = stop('ev-1', claim);
  assert.equal(sent.status, 2, sent.stderr);
  assert.match(sent.stderr, /Your report says `npm run check` passed, but no run of it/u);
  assert.equal(stop('ev-1', claim, true).status, 0, 'the second stop ends');
  assert.equal(stop('ev-1', 'Done. `npm run check`: not finished; I stopped it.').status, 0);
  assert.equal(stop('ev-1', 'Done. The pull request body says `npm run check`: 4071/4071 pass, which no run here shows.').status, 0, 'a claim it quotes from another source');
  assert.equal(stop('ev-1', 'Done. The reviewer wrote:\n\n> `npm run check`: 4071/4071 pass\n').status, 0, 'a block quote');
  const handoff = JSON.stringify({ status: 'done', evidence: ['`npm run check`: 4071/4071 pass'] });
  assert.equal(stop('ev-1', handoff).status, 2, 'a bare JSON handoff\'s claim is the subagent\'s own');
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'ev-2', stdout: 'ℹ pass 4071\nℹ fail 0\n' }));
  assert.equal(stop('ev-2', claim).status, 2, 'the parent\'s run is not the subagent\'s');
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'ev-2', stdout: 'ℹ pass 4071\nℹ fail 0\n', agent: 'a1' }));
  assert.equal(stop('ev-2', claim).status, 0, 'its own finished run supports it');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 60_000).toISOString(), message: { content: 'go' } })}\n`);
  assert.equal(stop('ev-2', claim).status, 2, 'a run from before this dispatch started is not this dispatch\'s');
});

test('push-first refuses a full suite while the branch holds an old commit its remote lacks', () => {
  const { dir, git } = repo();
  git('push', '-q', 'origin', 'feat/x');
  const run = (command, options = {}) => pushFirst(command, { cwd: dir, env: {}, ...options });
  assert.equal(run('npm run check'), null, 'nothing unpushed');
  writeFileSync(path.join(dir, 'fix.txt'), 'f\n');
  gitDates = { GIT_COMMITTER_DATE: '2026-11-18T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-18T10:00:00Z' };
  git('add', '-A');
  git('commit', '-q', '-m', 'fix');
  gitDates = {};
  const at = Date.parse('2026-11-18T10:30:00Z');
  assert.deepEqual(unpushed(dir), { branch: 'feat/x', remoteRef: 'origin/feat/x', count: 1, oldest: at / 1000 - 1800 });
  const reason = run('rtk npm run check 2>&1 | tail -5', { now: at });
  assert.match(reason, /^Blocked: `npm run check` runs the full suite while branch `feat\/x` holds 1 commit\(s\) that `origin\/feat\/x` lacks, the oldest 30 minutes old\. Push first/u);
  assert.match(reason, /`aidrian test changed`/u);
  assert.equal(run('npm run check', { now: at - 28 * 60_000 }), null, 'a commit younger than the limit');
  assert.equal(run('npm test -- test/a.test.mjs', { now: at }), null, 'test files, no full suite');
  assert.equal(run('npm run check', { now: at, env: { AIDRIAN_ALLOW_FULL_SUITE: '1' } }), null);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, testing: { fullSuite: ['npm run check'] } }));
  assert.equal(run('npm run check', { now: at }), null, 'off by default');
  assert.equal(run('npm test', { now: at }), null);
});

test('push-first and the record read no config for a line of only readers, and do for any other program', () => {
  assert.equal(mayRunTests('git status && grep -c x f | wc -l', '/w'), false);
  assert.equal(mayRunTests('aidrian state', '/w'), false);
  assert.equal(mayRunTests('aidrian test changed', '/w'), true);
  assert.equal(mayRunTests('make ci', '/w'), true, 'a project may name any full suite');
  const { dir, git } = repo({ config: { version: 1, testing: { fullSuite: ['make ci'], pushFirstMinutes: 5 } } });
  git('push', '-q', 'origin', 'feat/x');
  writeFileSync(path.join(dir, 'fix.txt'), 'f\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fix');
  assert.match(pushFirst('make ci', { cwd: dir, env: {}, now: Date.now() + 3_600_000 }), /^Blocked: `make ci` runs the full suite/u);
});

test('push-first leaves a branch with no remote copy alone', () => {
  const { dir } = repo();
  assert.equal(unpushed(dir), null);
  assert.equal(pushFirst('npm run check', { cwd: dir, env: {}, now: Date.now() + 3_600_000 }), null);
});

test('aidrian test changed finds the changed test files and the ones that name a changed file', () => {
  const { dir, git } = repo({
    files: {
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'lib/a.mjs': 'export const a = 1;\n',
      'lib/b.mjs': 'export const b = 1;\n',
      'lib/widget.ts': 'export const w = 1;\n',
      'test/a.test.mjs': "import '../lib/a.mjs';\n",
      'test/b.test.mjs': "import '../lib/b.mjs';\nconst fixture = 'test/fixtures/a.json';\njoin(FIXTURES, 'notes.md');\n",
      'test/widget.test.ts': "import { w } from '../lib/widget';\n",
      'pkg/sum.go': 'package pkg\n',
      'pkg/sum_test.go': 'package pkg\n',
      'other/x_test.go': 'package other\n',
      'mod/package.json': '{}',
      'mod/tests/a.test.tsx': "import '../../lib/a.mjs';\n",
      'test/fixtures/a.json': '{"file": "lib/b.mjs"}\n',
      'test/fixtures/notes.md': 'see lib/b.mjs\n',
      'test/math.mjs': 'export {};\n',
      'test/fixtures/frozen-clock.mjs': 'export {};\n',
      'test/clock.test.mjs': "import './fixtures/frozen-clock.mjs';\nread('fixtures/expected.test.json');\n",
      'test/fixtures/expected.test.json': '{}\n',
      'test/fixtures/sample.test.jsx': 'export default 1;\n',
      'mod/test/fixtures/conf.json': '{}\n',
      'test/reads.test.mjs': "read('test/fixtures/gone.json');\nread('mod/test/fixtures/conf.json');\n",
      'test/jsx.test.mjs': "read('fixtures/sample.test.jsx');\n",
    },
  });
  git('push', '-q', 'origin', 'feat/x');
  assert.deepEqual(needlesOf('lib/check-runs.mjs'), ['check-runs.mjs', 'check-runs']);
  assert.deepEqual(needlesOf('lib/a.mjs'), ['a.mjs'], 'a stem too short to search');
  assert.deepEqual(needlesOf('lib/hosts/index.mjs'), ['hosts/index.mjs', 'hosts/index']);
  assert.deepEqual(needlesOf('docs/hooks.md'), ['docs/hooks.md']);
  assert.deepEqual(needlesOf('test/fixtures/frozen-clock.mjs'), ['frozen-clock.mjs', 'frozen-clock'], 'a helper in a test folder by its name');
  assert.deepEqual(needlesOf('test/fixtures/sample.test.jsx'), ['sample.test.jsx', 'sample.test']);
  writeFileSync(path.join(dir, 'lib/a.mjs'), 'export const a = 2;\n');
  writeFileSync(path.join(dir, 'test/c.test.mjs'), 'new\n');
  assert.deepEqual(touchedTests(dir, ['lib/a.mjs', 'test/c.test.mjs']), ['test/a.test.mjs', 'test/c.test.mjs'], 'a nested package\'s tests are its own runner\'s');
  assert.deepEqual(touchedTests(dir, ['lib/widget.ts']), ['test/widget.test.ts'], 'an import with no extension');
  assert.deepEqual(touchedTests(dir, ['pkg/sum.go']), ['pkg/sum_test.go'], 'Go tests beside the changed file');
  const nodeOnly = (files) => touchedTests(dir, files, undefined, { nodeOnly: true });
  assert.deepEqual(touchedTests(dir, ['lib/b.mjs']), ['test/b.test.mjs', 'test/fixtures/a.json', 'test/fixtures/notes.md'], 'a configured command decides what it runs');
  assert.deepEqual(touchedTests(dir, ['test/fixtures/a.json']), ['test/fixtures/a.json'], 'a configured command gets a changed fixture alone, as before');
  assert.deepEqual(touchedTests(dir, ['test/fixtures/gone.json']), ['test/reads.test.mjs'], 'a removed fixture it cannot get selects the tests that name it');
  rmSync(path.join(dir, 'test/fixtures/a.json'));
  assert.deepEqual(touchedTests(dir, ['test/fixtures/a.json']), ['test/b.test.mjs'], 'a tracked fixture deleted in the working tree selects the tests that name it');
  writeFileSync(path.join(dir, 'test/fixtures/a.json'), '{"file": "lib/b.mjs"}\n');
  assert.deepEqual(touchedTests(dir, ['mod/test/fixtures/conf.json']), ['test/reads.test.mjs'], 'a nested package\'s fixture selects the root tests that name it');
  assert.deepEqual(nodeOnly(['test/fixtures/sample.test.jsx']), ['test/jsx.test.mjs'], 'a .jsx fixture named like a test selects the test that names it');
  assert.deepEqual(nodeOnly(['lib/b.mjs']), ['test/b.test.mjs'], 'a fixture or Markdown file is no test module');
  assert.deepEqual(nodeOnly(['test/fixtures/a.json']), ['test/b.test.mjs'], 'a changed fixture selects the tests that name it');
  assert.deepEqual(nodeOnly(['lib/widget.ts']), [], 'a .ts test needs a configured command');
  assert.deepEqual(nodeOnly(['test/math.mjs']), ['test/math.mjs'], 'any module in a test folder is a node test');
  assert.deepEqual(nodeOnly(['test/fixtures/notes.md']), ['test/b.test.mjs'], 'a fixture joined to its folder by name');
  assert.deepEqual(nodeOnly(['lib/a.mjs']), ['test/a.test.mjs'], 'a nested package\'s .tsx test stays out');
  assert.deepEqual(nodeOnly(['test/fixtures/frozen-clock.mjs']), ['test/clock.test.mjs', 'test/fixtures/frozen-clock.mjs'], 'a changed helper selects the tests that import it');
  assert.deepEqual(nodeOnly(['test/fixtures/expected.test.json']), ['test/clock.test.mjs'], 'a fixture named like a test selects the tests that read it');
  assert.deepEqual([nodeOnly(['pkg/sum.go']), nodeOnly(['pkg/sum_test.go'])], [[], []], 'Go tests are a configured command\'s');
  assert.equal(testCommand(dir, {}), 'npm test --');
  assert.equal(testCommand(dir, { changedCommand: 'node --test' }), 'node --test');
  const listed = spawnSync(process.execPath, [CLI, 'test', 'changed', '--list'], { cwd: dir, env: ENV, encoding: 'utf8' });
  assert.deepEqual([listed.status, listed.stdout], [0, 'test/a.test.mjs\ntest/c.test.mjs\n'], listed.stderr);
});

test('aidrian test changed with nothing to run says no test passed, and its row supports no claim', () => {
  const { dir, git } = repo({ files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) } });
  git('push', '-q', 'origin', 'feat/x');
  const ran = spawnSync(process.execPath, [CLI, 'test', 'changed'], { cwd: dir, env: ENV, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /no test file touches[^\n]*\nℹ tests 0\nℹ pass 0\nℹ fail 0\n$/u);
  const [row] = checkRows({ command: 'aidrian test changed', cwd: dir, output: ran.stdout, exitZero: true, tree: () => ({ tree: 't', trackedTree: 't' }) });
  assert.deepEqual([row.status, row.pass], ['passed', 0]);
  assert.equal(unsupportedClaims(passClaims('`aidrian test changed` passed', { section: null }), [row], { tree: 't' }).length, 1);
});
