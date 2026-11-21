import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SETUP = path.join(import.meta.dirname, '../scripts/test-state.mjs');

// The variables a Claude session or a git hook sets around `npm test`. Every one changes what some test sees:
// the agent name ends up in the hook_deny rows, and GIT_DIR sends a test's `git init --separate-git-dir` to the
// developer's own repository.
const LEAKED = {
  CLAUDE_CODE_AGENT: 'orchestrator',
  CLAUDE_CODE_SESSION_ID: 'session-1',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_PID: '4343',
  AIDRIAN_ALLOW_GIT_AMEND: '1',
  AIDRIAN_ALLOW_MAIN_COMMIT: '1',
  GIT_DIR: '/nonexistent/.git',
  GIT_WORK_TREE: '/nonexistent',
  GIT_INDEX_FILE: '/nonexistent/.git/index',
};

test('the test setup clears the session, override, and git variables from every test and what it spawns', () => {
  const probe = `process.stdout.write(JSON.stringify(Object.keys(${JSON.stringify(LEAKED)}).filter((key) => key in process.env)))`;
  const run = spawnSync(process.execPath, ['--import', SETUP, '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, ...LEAKED, AIDRIAN_TEST_STATE: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});

test('the test setup keeps the variables that are not the session`s, an override, or git`s', () => {
  const run = spawnSync(process.execPath, ['--import', SETUP, '-e', 'process.stdout.write(process.env.GIT_EDITOR ?? "")'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true' },
  });
  assert.equal(run.stdout, 'true');
});

test('the test setup keeps the temporary files of a run in its own folder, and deletes that folder when the run ends', (t) => {
  const outer = mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-probe-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const probe = "import('node:fs').then(({ mkdtempSync }) => process.stdout.write(mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'aidrian-denials-'))))";
  const run = spawnSync(process.execPath, ['--import', SETUP, '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TEST_STATE: '', TMPDIR: outer },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith(outer), run.stdout);
  assert.deepEqual(readdirSync(outer), []);
});

// A probe test file in a folder of its own, run as `node --import <setup> probe.test.mjs`, so the setup sees a test file as
// the main script. It prints node:child_process's functions' source after the setup ran, and starts git through exec, a
// promisified exec, and a promisified execFile: exec calls execFile inside node:child_process, so each must count once.
function probeRun(t, env) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-spawns-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'probe.test.mjs'), [
    "import childProcess from 'node:child_process';",
    "import { promisify } from 'node:util';",
    "const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];",
    "const source = names.map((name) => childProcess[name].toString()).join('\\n');",
    "await new Promise((done) => childProcess.exec('git --version', done));",
    "await promisify(childProcess.exec)('git --version');",
    "const { stdout } = await promisify(childProcess.execFile)('git', ['--version']);",
    "if (!stdout.startsWith('git version')) throw new Error(`promisify lost its stdout: ${stdout}`);",
    'process.stdout.write(source);',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--import', SETUP, 'probe.test.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(run.status, 0, run.stderr);
  return { dir, source: run.stdout };
}

const PLAIN = "const cp = require('node:child_process'); process.stdout.write(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map((name) => cp[name].toString()).join('\\n'));";

test('without AIDRIAN_TEST_LOG the test setup leaves node:child_process as it is', (t) => {
  const plain = spawnSync(process.execPath, ['-e', PLAIN], { encoding: 'utf8' }).stdout;
  assert.equal(probeRun(t, {}).source, plain);
});

test('with AIDRIAN_TEST_LOG the test setup appends the test file`s start, then its time and child processes, each counted once', (t) => {
  const log = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-log-'))), 'files.jsonl');
  t.after(() => rmSync(path.dirname(log), { recursive: true, force: true }));
  probeRun(t, { AIDRIAN_TEST_LOG: log });
  const [start, row, ...more] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(more, []);
  assert.deepEqual(start, { file: 'probe.test.mjs', started: true });
  assert.deepEqual({ file: row.file, git: row.git, other: row.other }, { file: 'probe.test.mjs', git: 3, other: 0 });
  assert.ok(Number.isInteger(row.ms) && row.ms > 0, JSON.stringify(row));
});

test('a timing log that cannot be written when the file exits leaves a passing test file`s exit status 0', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-log-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gone = path.join(dir, 'gone');
  mkdirSync(gone);
  // The file removes the log's folder after its start is logged: before the fix, the failed append in the exit listener
  // made the status 1. scripts/run-tests.mjs fails the run for the row it lost.
  writeFileSync(path.join(dir, 'drops.test.mjs'), "import { rmSync } from 'node:fs';\nrmSync(process.env.DROP, { recursive: true });\n");
  const run = spawnSync(process.execPath, ['--import', SETUP, 'drops.test.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AIDRIAN_TEST_LOG: path.join(gone, 'files.jsonl'), DROP: gone } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(gone), false, 'the folder went');
});

test('a timing log that cannot be written as the file loads fails the file, so no file runs unlogged', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-log-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'quiet.test.mjs'), '');
  const run = spawnSync(process.execPath, ['--import', SETUP, 'quiet.test.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AIDRIAN_TEST_LOG: path.join(dir, 'gone', 'files.jsonl') } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /ENOENT/u);
});

test('a test file that removes the folder it runs in still exits 0 and logs its row', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-gone-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'gone.test.mjs'), [
    "import { mkdirSync, rmSync } from 'node:fs';",
    "import path from 'node:path';",
    "const away = path.join(process.cwd(), 'away');",
    'mkdirSync(away);',
    'process.chdir(away);',
    'rmSync(away, { recursive: true });',
  ].join('\n'));
  const log = path.join(dir, 'files.jsonl');
  const run = spawnSync(process.execPath, ['--import', SETUP, 'gone.test.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AIDRIAN_TEST_LOG: log } });
  assert.equal(run.status, 0, run.stderr);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.file), ['gone.test.mjs', 'gone.test.mjs'], 'the start and the row, by the path from the folder the run started in');
  assert.ok(Number.isInteger(lines[1].ms), JSON.stringify(lines));
});

test('every test file imports the setup first, so a file run alone with `node --test` is kept apart too', () => {
  const dir = import.meta.dirname;
  const late = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).filter((name) => {
    const first = readFileSync(path.join(dir, name), 'utf8').split('\n').find((line) => line.startsWith('import '));
    return first !== "import '../scripts/test-state.mjs';";
  });
  assert.deepEqual(late, [], 'a test file run without --import would write to the developer`s state folder and temporary folder');
});
