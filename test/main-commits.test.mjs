import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { commitMode } from '../plugins/aidrian/lib/main-commits.mjs';

const config = (mainCheckout) => ({ ...DEFAULTS, git: { ...DEFAULTS.git, mainCheckout: { ...DEFAULTS.git.mainCheckout, ...mainCheckout } } });

test('commitMode: null follows the guard, block when it is on and allow when it is off', () => {
  assert.equal(DEFAULTS.git.mainCheckout.commits, null);
  assert.equal(commitMode(DEFAULTS), 'allow', 'a fresh project, guard off, is never blocked');
  assert.equal(commitMode(config({ guard: true, commits: null })), 'block');
  assert.equal(commitMode(config({ guard: false, commits: null })), 'allow');
});

test('commitMode: an explicit value wins over the guard', () => {
  for (const guard of [true, false]) {
    for (const commits of ['block', 'warn', 'allow']) {
      assert.equal(commitMode(config({ guard, commits })), commits, `guard ${guard}, commits ${commits}`);
    }
  }
});

// `aidrian pre-commit`, run against temporary repositories. Each one is made with `git init` under mkdtemp and driven
// with `git -C`; no test sets GIT_DIR or GIT_WORK_TREE.
const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const CLI_MJS = path.join(ROOT, 'plugins/aidrian/lib/cli.mjs');
const GUARD_ON = { version: 1, git: { mainCheckout: { guard: true } } };

function tempDir(t) {
  // realpath: on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pre-commit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitIn = (dir) => (...args) => {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', maxBuffer: Infinity });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

// A repository on `main` whose first commit holds `.gitignore` (ignoring `.worktrees/` and `logs/`), a README, and,
// unless `config` is null, `.aidrian/config.json`.
function repo(t, config = GUARD_ON) {
  const dir = tempDir(t);
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\nlogs/\n');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  if (config !== null) writeConfig(dir, config);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

function writeConfig(dir, config) {
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

// A linked worktree of `dir` on a new branch, under the ignored `.worktrees/`.
function worktree(dir, git, name = 'task') {
  const tree = path.join(dir, '.worktrees', name);
  git('worktree', 'add', '-q', '-b', name, tree);
  return { tree, git: gitIn(tree) };
}

const preCommit = (cwd, env = {}, args = []) => {
  const { status, stdout, stderr } = spawnSync(CLI, ['pre-commit', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: Infinity });
  return { status, stdout, stderr };
};

const MAIN = /aidrian worktree new <branch>/;
const OVERRIDE_LINE = /AIDRIAN_ALLOW_MAIN_COMMIT=1, which the Human sets in their own shell; agents never set it/;

test('pre-commit refuses a commit in the main checkout, naming aidrian worktree new and the override', (t) => {
  const { dir } = repo(t);
  const { status, stdout, stderr } = preCommit(dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.match(stderr, MAIN);
  assert.match(stderr, OVERRIDE_LINE);
  assert.doesNotMatch(stderr, /git rm --cached/, 'nothing ignored is staged');
});

test('pre-commit passes the same commit from a linked worktree, and in a main checkout whose HEAD is unborn', (t) => {
  const { dir, git } = repo(t);
  const { tree } = worktree(dir, git);
  assert.deepEqual(preCommit(tree), { status: 0, stdout: '', stderr: '' });

  const fresh = tempDir(t);
  gitIn(fresh)('init', '-q', '-b', 'main');
  writeConfig(fresh, GUARD_ON);
  gitIn(fresh)('add', '.');
  assert.deepEqual(preCommit(fresh), { status: 0, stdout: '', stderr: '' }, 'no worktree exists before the first commit');
});

test('pre-commit in warn mode prints the same lines, each prefixed warning:, and exits 0', (t) => {
  const { dir } = repo(t, { version: 1, git: { mainCheckout: { guard: true, commits: 'warn' } } });
  const warned = preCommit(dir, {}, ['--project', dir]);
  writeConfig(dir, { version: 1, git: { mainCheckout: { guard: true, commits: 'block' } } });
  const blocked = preCommit(dir);
  assert.deepEqual([warned.status, blocked.status], [0, 1]);
  assert.match(warned.stderr, MAIN);
  const lines = warned.stderr.trimEnd().split('\n');
  assert.ok(lines.every((line) => line.startsWith('warning: ')), warned.stderr);
  assert.deepEqual(lines.map((line) => line.slice('warning: '.length)), blocked.stderr.trimEnd().split('\n'));
});

test('pre-commit passes in allow mode, with the guard off, with no project folder, and with a config.json that does not parse', (t) => {
  for (const config of [
    { version: 1, git: { mainCheckout: { guard: true, commits: 'allow' } } },
    { version: 1, git: { mainCheckout: { guard: false } } },
    { version: 1 },
    null,
    '{ "version": 1, "git": { "mainCheckout": { "guard": true ',
  ]) {
    const { dir } = repo(t, config);
    assert.deepEqual(preCommit(dir), { status: 0, stdout: '', stderr: '' }, JSON.stringify(config));
  }
});

test('pre-commit: an invalid commits value keeps null, which follows the guard', (t) => {
  const { dir } = repo(t, { version: 1, git: { mainCheckout: { guard: true, commits: 'sometimes' } } });
  assert.equal(preCommit(dir).status, 1);
});

test('pre-commit passes with AIDRIAN_ALLOW_MAIN_COMMIT=1 only, and refuses with CI=true like any other commit', (t) => {
  const { dir } = repo(t);
  assert.deepEqual(preCommit(dir, { AIDRIAN_ALLOW_MAIN_COMMIT: '1' }), { status: 0, stdout: '', stderr: '' });
  for (const env of [{ AIDRIAN_ALLOW_MAIN_COMMIT: '0' }, { AIDRIAN_ALLOW_MAIN_COMMIT: 'true' }, { CI: 'true' }, { CI: '1' }]) {
    const { status, stderr } = preCommit(dir, env);
    assert.equal(status, 1, JSON.stringify(env));
    assert.match(stderr, MAIN, JSON.stringify(env));
  }
});

test('pre-commit refuses a newly force-added ignored file in a worktree too, naming git rm --cached', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  mkdirSync(path.join(tree, 'logs'));
  writeFileSync(path.join(tree, 'logs/run.log'), 'x\n');
  writeFileSync(path.join(tree, 'logs/my notes.log'), 'x\n');
  writeFileSync(path.join(tree, 'kept.md'), 'x\n');
  treeGit('add', '-f', 'logs', 'kept.md');
  const { status, stderr } = preCommit(tree);
  assert.equal(status, 1);
  assert.match(stderr, /git rm --cached logs\/run\.log\n/);
  assert.match(stderr, /git rm --cached 'logs\/my notes\.log'\n/, 'a path with a space is quoted for the shell');
  assert.doesNotMatch(stderr, /kept\.md/);
  assert.doesNotMatch(stderr, MAIN, 'a worktree is not the main checkout');
  assert.match(stderr, OVERRIDE_LINE);
});

test('pre-commit refuses a git mv of a tracked file into an ignored folder, even with diff.renames=copies', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  treeGit('config', 'diff.renames', 'copies');
  mkdirSync(path.join(tree, 'logs'));
  treeGit('mv', 'README.md', 'logs/README.md');
  const { status, stderr } = preCommit(tree);
  assert.equal(status, 1);
  assert.match(stderr, /git rm --cached logs\/README\.md\n/);
});

test('pre-commit passes a change to a file tracked before a later .gitignore matched it', (t) => {
  const { dir, git } = repo(t);
  mkdirSync(path.join(dir, 'build'));
  writeFileSync(path.join(dir, 'build/out.txt'), 'one\n');
  git('add', 'build/out.txt');
  git('commit', '-q', '-m', 'build output');
  const { tree, git: treeGit } = worktree(dir, git);
  writeFileSync(path.join(tree, '.gitignore'), '.worktrees/\nlogs/\nbuild/\n');
  writeFileSync(path.join(tree, 'build/out.txt'), 'two\n');
  treeGit('add', '-u');
  assert.deepEqual(preCommit(tree), { status: 0, stdout: '', stderr: '' });
});

test('pre-commit refuses a gitlink added under an ignored .worktrees/ through the ignored-file check alone', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  const head = treeGit('rev-parse', 'HEAD').trim();
  treeGit('update-index', '--add', '--cacheinfo', `160000,${head},.worktrees/other`);
  const { status, stderr } = preCommit(tree);
  assert.equal(status, 1);
  assert.match(stderr, /git rm --cached \.worktrees\/other\n/);
  assert.doesNotMatch(stderr, MAIN);
});

test('pre-commit lets the commit run, with one stderr line, when git cannot read the checkout', (t) => {
  const dir = tempDir(t);
  writeConfig(dir, GUARD_ON);
  // The ceiling keeps git from finding a repository above the temp folder.
  const { status, stdout, stderr } = preCommit(dir, { GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  assert.deepEqual([status, stdout], [0, '']);
  assert.equal(stderr, 'aidrian pre-commit: the checkout unreadable; not checked\n');
});

test('pre-commit: a staged-files read that fails adds no problem, and the main-checkout problem still refuses', (t) => {
  const { dir } = repo(t);
  // An index git cannot parse, inside the temporary repository: only the staged-files read uses it.
  const garbage = path.join(dir, '.git', 'garbage-index');
  writeFileSync(garbage, 'not an index\n');
  const { status, stderr } = preCommit(dir, { GIT_INDEX_FILE: garbage });
  assert.equal(status, 1);
  assert.match(stderr, /^aidrian pre-commit: the staged files unreadable; not checked\n/);
  assert.match(stderr, MAIN);

  const { tree } = worktree(dir, gitIn(dir));
  assert.deepEqual(preCommit(tree, { GIT_INDEX_FILE: garbage }), {
    status: 0,
    stdout: '',
    stderr: 'aidrian pre-commit: the staged files unreadable; not checked\n',
  }, 'in a worktree nothing else is wrong');
});

test('pre-commit reads more than 1 MiB of added paths: a large git add -f of an ignored folder is refused', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  const folder = path.join(tree, 'logs', 'd'.repeat(40));
  mkdirSync(folder, { recursive: true });
  const count = 5400;
  for (let i = 0; i < count; i += 1) writeFileSync(path.join(folder, `${String(i).padStart(5, '0')}${'f'.repeat(150)}`), '');
  treeGit('add', '-f', 'logs');
  const added = treeGit('diff', '--cached', '--name-only', '-z');
  assert.ok(added.length > 1024 * 1024, `${added.length} bytes of paths`);
  const { status, stderr } = preCommit(tree);
  assert.equal(status, 1, stderr.slice(0, 300));
  assert.equal(stderr.match(/git rm --cached /g)?.length, count);
});

test('git runs pre-commit for a commit and pre-merge-commit for a non-fast-forward merge: both refuse in the main checkout', (t) => {
  const { dir, git } = repo(t);
  const hooks = tempDir(t);
  for (const name of ['pre-commit', 'pre-merge-commit']) {
    writeFileSync(path.join(hooks, name), `#!/bin/sh\nexec node "${CLI_MJS}" pre-commit\n`);
    chmodSync(path.join(hooks, name), 0o755);
  }
  git('config', 'core.hooksPath', hooks);
  const commit = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const before = git('rev-parse', 'HEAD');

  const refused = commit(dir, 'commit', '--allow-empty', '-q', '-m', 'test: in main');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, MAIN);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no commit landed');

  // In a linked worktree, a force-added ignored file is staged. A partial commit, which git makes from a temporary
  // index it names in GIT_INDEX_FILE, leaves it out and lands; the full commit then holds it and is refused.
  const { tree } = worktree(dir, git, 'side');
  const treeGit = gitIn(tree);
  mkdirSync(path.join(tree, 'logs'));
  writeFileSync(path.join(tree, 'logs/run.log'), 'x\n');
  writeFileSync(path.join(tree, 'side.md'), 'x\n');
  treeGit('add', '-f', 'logs/run.log');
  treeGit('add', 'side.md');
  const partial = commit(tree, 'commit', '-q', '-m', 'test: in a worktree', '--', 'side.md');
  assert.deepEqual([partial.status, partial.stderr], [0, ''], 'a partial commit reads the index git made for it');
  assert.equal(treeGit('log', '-1', '--format=%s'), 'test: in a worktree\n');
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['side.md']);
  const full = commit(tree, 'commit', '-q', '-m', 'test: with the log');
  assert.equal(full.status, 1);
  assert.match(full.stderr, /git rm --cached logs\/run\.log\n/);
  assert.doesNotMatch(full.stderr, MAIN);
  treeGit('rm', '-q', '--cached', 'logs/run.log');

  const merge = commit(dir, 'merge', '--no-ff', '--no-edit', 'side');
  assert.notEqual(merge.status, 0);
  assert.match(merge.stderr, MAIN);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no merge commit landed');
});
