import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

test('every test file imports the setup first, so a file run alone with `node --test` is kept apart too', () => {
  const dir = import.meta.dirname;
  const late = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).filter((name) => {
    const first = readFileSync(path.join(dir, name), 'utf8').split('\n').find((line) => line.startsWith('import '));
    return first !== "import '../scripts/test-state.mjs';";
  });
  assert.deepEqual(late, [], 'a test file run without --import would write to the developer`s state folder and temporary folder');
});
