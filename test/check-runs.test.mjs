// The check-run record and the two rules built on it (docs/hooks.md#check-runs, docs/hooks.md#push-first): the PostToolUse
// hook records only a test run a shell call finished; the pull request body rule and the subagent stop hook refuse a pass
// no finished run supports; push-first refuses a full suite while the branch holds a commit its remote lacks; and
// `aidrian test changed` finds the test files a change touches.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  appendCheckRuns, checkRows, commandKey, isFullSuite, passClaims, readCheckRuns, runCounts, runStatus, testRuns, unsupportedClaims, workingTree,
} from '../plugins/aidrian/lib/check-runs.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { detectHost } from '../plugins/aidrian/lib/hosts/index.mjs';
import { check as prBody } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';
import { check as pushFirst, unpushed } from '../plugins/aidrian/lib/rules/push-first.mjs';
import { lexPipeline, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';
import { needleOf, testCommand, touchedTests } from '../plugins/aidrian/lib/test-changed.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT_DIR, 'plugins/aidrian/scripts');
const CLI = path.join(ROOT_DIR, 'plugins/aidrian/lib/cli.mjs');
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-runs-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const STATE = path.join(ROOT, 'state');
const TESTING = DEFAULTS.testing;

// Git sees no config of the machine that runs the suite, in this process and in every one it starts.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_STATE_HOME: STATE });
const ENV = { PATH: process.env.PATH, HOME: ROOT, XDG_STATE_HOME: STATE, TMPDIR: process.env.TMPDIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDECODE: '1' };

let made = 0;
// A project in a git repository with one commit, on branch `feat/x`, and a bare remote named origin.
function repo({ config = { version: 1 }, files = {} } = {}) {
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
  assert.deepEqual(testRuns('cd /x && npm run check 2>&1 | tail -5', '/w'), [{ key: 'npm run check', folder: '/x', carries: false }]);
  assert.deepEqual(testRuns('npm run check && git push', '/w'), [{ key: 'npm run check', folder: '/w', carries: true }]);
  assert.deepEqual(testRuns('git status; node --test test/a.test.mjs', '/w'), [{ key: 'node --test test/a.test.mjs', folder: '/w', carries: true }]);
  assert.deepEqual(testRuns('npm test || true', '/w').map((run) => run.carries), [false], 'an || masks the run\'s status');
  assert.deepEqual(testRuns('git status && echo test', '/w'), [], 'a word is not a test run');
  assert.ok(isFullSuite(invocation('npm run check'), TESTING));
  assert.ok(!isFullSuite(invocation('npm test -- test/a.test.mjs'), TESTING), 'one file is no full suite');
});

test('counts come from the node runner summary first, else the words vitest, jest, and pytest print', () => {
  assert.deepEqual(runCounts('ℹ tests 5\nℹ pass 4\nℹ fail 1\n12 passed elsewhere'), { pass: 4, fail: 1 });
  assert.deepEqual(runCounts('# pass 3\n# fail 0\n'), { pass: 3, fail: 0 });
  assert.deepEqual(runCounts('Tests  1 failed | 11 passed (12)'), { pass: 11, fail: 1 });
  assert.deepEqual(runCounts('lint ok'), { pass: null, fail: null });
  assert.equal(runStatus({ pass: null, fail: null }, true), 'passed', 'an exit of 0 the line carries passes');
  assert.equal(runStatus({ pass: 4, fail: 1 }, true), 'failed');
  assert.equal(runStatus({ pass: null, fail: null }, false), 'failed', 'no exit status and no counts is no pass');
  assert.equal(runStatus({ pass: 4, fail: 0 }, false), 'passed');
});

test('the working tree counts uncommitted and untracked files, and matches the commit that holds them', () => {
  const { dir, git } = repo();
  writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  const before = workingTree(dir);
  assert.notEqual(before, git('rev-parse', 'HEAD^{tree}'));
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  assert.equal(before, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(workingTree(path.join(dir, '.aidrian')), before, 'from a subfolder too');
  assert.equal(git('status', '--porcelain'), '', 'the checkout\'s own index is untouched');
});

test('a row a finished run, with the status the line carries', () => {
  const tree = () => 'abc';
  const row = (command, output, exitZero = true) => checkRows({ command, cwd: '/w', output, exitZero, tree, at: 't' });
  assert.deepEqual(row('npm run check', 'ℹ pass 4\nℹ fail 0'), [{ at: 't', agentId: null, command: 'npm run check', tree: 'abc', status: 'passed', pass: 4, fail: 0 }]);
  assert.equal(row('npm run check | tail -3', 'lint ok')[0].status, 'failed', 'a pipe hides the exit status, and no count shows a pass');
  assert.equal(row('npm run check | tail -3', 'ℹ pass 9\nℹ fail 0')[0].status, 'passed');
  assert.equal(row('npm run check', 'ℹ pass 9\nℹ fail 0', false)[0].status, 'passed', 'a host with no exit status judges by counts');
  assert.deepEqual(row('git status', ''), []);
  assert.deepEqual(checkRows({ command: 'npm test', cwd: '/w', output: '', exitZero: true, tree: () => null }), [], 'no tree, no row');
});

const BODY = (lines) => `## Summary\n\n- x\n\n## Tests run\n\n${lines.join('\n')}\n`;

test('a pass claim names a test command and a pass, and never a failure, an unfinished run, or CI', () => {
  const claims = passClaims(BODY([
    '- `npm run check`: 4071/4071 pass',
    '- `node --test test/a.test.mjs`: 40 failures under load; rerun alone: pass',
    '- CI `npm run check`: green',
    '- `npm run check`: not finished',
    '- npm run check passed, 12 pass',
    '```',
    'ℹ pass 3 `npm test` passed',
    '```',
  ]), { testing: TESTING });
  assert.deepEqual(claims, [
    { clause: '- `npm run check`: 4071/4071 pass', key: 'npm run check', counts: [4071] },
    { clause: '- npm run check passed, 12 pass', key: 'npm run check', counts: [12] },
  ]);
  assert.deepEqual(passClaims('## Summary\n\n`npm test` passed\n'), [], 'only the Tests run section');
  assert.equal(passClaims('`npm test` passed', { section: null }).length, 1, 'a whole report with no section');
});

test('a claim needs a run of its command that passed, at the tree, with the count it states', () => {
  const claims = [{ clause: 'c', key: 'npm run check', counts: [4071] }];
  const run = { command: 'npm run check', status: 'passed', pass: 4071, fail: 0, tree: 't1' };
  assert.deepEqual(unsupportedClaims(claims, [run], { tree: 't1' }), []);
  assert.equal(unsupportedClaims(claims, [run], { tree: 't2' }).length, 1, 'another tree');
  assert.equal(unsupportedClaims(claims, [{ ...run, pass: 4031, fail: 40, status: 'failed' }], { tree: 't1' }).length, 1, 'a failed run');
  assert.equal(unsupportedClaims(claims, [{ ...run, pass: 12 }], { tree: 't1' }).length, 1, 'another count');
  assert.deepEqual(unsupportedClaims(claims, [{ ...run, pass: null }], { tree: 't1' }), [], 'a run that printed no count');
  assert.equal(unsupportedClaims(claims, []).length, 1, 'no run at all');
});

test('the record appends, reads back, and keeps its newest rows past its cap', () => {
  const { dir } = repo();
  const state = path.join(ROOT, 'record-state');
  mkdirSync(path.join(state, 'sessions/s1'), { recursive: true, mode: 0o700 });
  const folder = realpathSync(path.join(state, 'sessions/s1'));
  const row = (index) => ({ at: 't', agentId: null, command: `node --test t${index}.test.mjs`, tree: 'x'.repeat(40), status: 'passed', pass: index, fail: 0 });
  for (let index = 0; index < 600; index += 1) assert.ok(appendCheckRuns(folder, [row(index)]), `row ${index}`);
  const rows = readCheckRuns(folder);
  assert.equal(rows.at(-1).pass, 599);
  assert.ok(rows.length < 600 && rows.length > 100, `kept ${rows.length}`);
  assert.ok(dir);
});

// The PostToolUse payload Claude Code sends for a Bash call.
const postPayload = (command, { cwd, session, stdout = '', response } = {}) => ({
  session_id: session, transcript_path: path.join(ROOT, 'none.jsonl'), cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_input: { command, description: 'x' },
  tool_response: response ?? { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
});
const runScript = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env: ENV });

// The rows the session's record holds, under every project's state folder.
function recorded(session) {
  const projects = path.join(STATE, 'aidrian/projects');
  let rows = [];
  for (const id of (() => {
    try {
      return readdirSync(projects);
    } catch {
      return [];
    }
  })()) {
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
  assert.deepEqual(recorded('rec-1').map(({ command, status, pass, fail, tree: at }) => ({ command, status, pass, fail, at })), [{ command: 'npm run check', status: 'passed', pass: 7, fail: 0, at: tree }]);
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'rec-2', response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }));
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'rec-2', response: { stdout: 'ℹ pass 1', stderr: '', interrupted: true } }));
  assert.deepEqual(recorded('rec-2'), [], 'a run in the background or stopped records nothing');
});

test('the shell adapters say whether a call finished and whether its exit status is known', () => {
  const claude = detectHost({ env: { CLAUDECODE: '1' } });
  assert.deepEqual(claude.shellRun({ stdout: 'o', stderr: 'e', interrupted: false }), { output: 'o\ne', finished: true, exitZero: true });
  assert.equal(claude.shellRun({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b' }).finished, false);
  const codex = detectHost({ env: { CODEX_THREAD_ID: 't' } });
  if (codex.id === 'codex') assert.deepEqual(codex.shellRun('out'), { output: 'out', finished: true, exitZero: false });
});

test('the pull request body rule refuses a pass the session record does not support', () => {
  // The test's folders are all in the system temp folder, which the rule otherwise refuses a body file in.
  const { dir, git } = repo({ config: { version: 1, github: { pullRequest: { sharedTempBodyFile: false } } } });
  const tree = git('rev-parse', 'HEAD^{tree}');
  const bodyFile = path.join(ROOT, `body-${made}.md`);
  const command = `gh pr create --draft --title "fix: x" --body-file ${bodyFile}`;
  const judge = (lines, runs) => {
    writeFileSync(bodyFile, BODY(lines));
    return prBody(command, { cwd: dir, env: {}, listOpenPrs: () => [], readRuns: () => runs });
  };
  const run = { command: 'npm run check', status: 'passed', pass: 4071, fail: 0, tree };
  assert.match(judge(['- `npm run check`: 4071/4071 pass'], []), /^Blocked: the `## Tests run` section says `npm run check` passed, but no run of it/u);
  assert.equal(judge(['- `npm run check`: 4071/4071 pass'], [run]), null);
  assert.match(judge(['- `npm run check`: 4071/4071 pass'], [{ ...run, pass: 4031, fail: 40, status: 'failed' }]), /The record holds failed \(pass 4031, fail 40\)/u);
  assert.match(judge(['- `npm run check`: 4071/4071 pass'], [{ ...run, tree: 'f'.repeat(40) }]), /this commit's files/u);
  assert.equal(judge(['- `npm run check`: not finished (stopped under load)', '- CI `Check (Node 22)`: pass'], []), null);
  assert.equal(judge(['- `npm run check`: 4071/4071 pass'], null), null, 'a session with no readable record is not judged');
});

test('the subagent stop hook sends back once a report that claims a pass no finished run shows', () => {
  const { dir } = repo();
  const stop = (session, message, active = false) => runScript('hook-subagent-stop.mjs', {
    session_id: session, cwd: dir, agent_id: 'a1', agent_type: 'aidrian:backend-developer', last_assistant_message: message, stop_hook_active: active,
  });
  const claim = 'Done. `npm run check`: 4071/4071 pass.';
  const sent = stop('ev-1', claim);
  assert.equal(sent.status, 2, sent.stderr);
  assert.match(sent.stderr, /Your report says `npm run check` passed, but no run of it/u);
  assert.equal(stop('ev-1', claim, true).status, 0, 'the second stop ends');
  assert.equal(stop('ev-1', 'Done. `npm run check`: not finished; I stopped it.').status, 0);
  runScript('hook-bash-post.mjs', postPayload('npm run check', { cwd: dir, session: 'ev-2', stdout: 'ℹ pass 4071\nℹ fail 0\n' }));
  assert.equal(stop('ev-2', claim).status, 0, 'a finished run supports it');
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
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, testing: { pushFirstMinutes: 0 } }));
  assert.equal(run('npm run check', { now: at }), null, '0 turns it off');
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
      'test/a.test.mjs': "import '../lib/a.mjs';\n",
      'test/b.test.mjs': "import '../lib/b.mjs';\n",
      'mod/package.json': '{}',
      'mod/tests/a.test.tsx': "import '../../lib/a.mjs';\n",
    },
  });
  git('push', '-q', 'origin', 'feat/x');
  assert.equal(needleOf('lib/a.mjs'), 'a.mjs');
  assert.equal(needleOf('lib/hosts/index.mjs'), 'hosts/index.mjs');
  assert.equal(needleOf('docs/hooks.md'), 'docs/hooks.md');
  assert.equal(needleOf('test/a.test.mjs'), null);
  writeFileSync(path.join(dir, 'lib/a.mjs'), 'export const a = 2;\n');
  writeFileSync(path.join(dir, 'test/c.test.mjs'), 'new\n');
  assert.deepEqual(touchedTests(dir, ['lib/a.mjs', 'test/c.test.mjs']), ['test/a.test.mjs', 'test/c.test.mjs'], 'a nested package\'s tests are its own runner\'s');
  assert.equal(testCommand(dir, {}), 'npm test --');
  assert.equal(testCommand(dir, { changedCommand: 'node --test' }), 'node --test');
  const listed = spawnSync(process.execPath, [CLI, 'test', 'changed', '--list'], { cwd: dir, env: ENV, encoding: 'utf8' });
  assert.deepEqual([listed.status, listed.stdout], [0, 'test/a.test.mjs\ntest/c.test.mjs\n'], listed.stderr);
});
