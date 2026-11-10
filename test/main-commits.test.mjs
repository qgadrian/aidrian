import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { unpushedMainLine } from '../plugins/aidrian/lib/main-commits.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';

// `aidrian pre-commit`, run against temporary repositories. Each one is made with `git init` under mkdtemp and driven
// with `git -C`. Only the GIT_DIR tests set GIT_DIR, to a temporary repository's own git folder; no test sets
// GIT_WORK_TREE.
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

// The environment of these runs: the tests' own, without an override the shell running them may hold.
const testEnv = (env = {}) => {
  const merged = { ...process.env, ...env };
  if (!Object.hasOwn(env, 'AIDRIAN_ALLOW_MAIN_COMMIT')) delete merged.AIDRIAN_ALLOW_MAIN_COMMIT;
  return merged;
};

const preCommit = (cwd, env = {}, args = []) => {
  const { status, stdout, stderr } = spawnSync(CLI, ['pre-commit', ...args], { cwd, encoding: 'utf8', env: testEnv(env), maxBuffer: Infinity });
  return { status, stdout, stderr };
};

// git as a commit runs it, with the hooks it finds, and its exit status left to the test.
const gitRun = (cwd, args, env = {}) =>
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: testEnv(env) });

// `aidrian pre-commit` as the pre-commit and pre-merge-commit hooks of `hooksDir`, or of a temporary folder that
// `git` points core.hooksPath at.
function installHooks(t, git, hooksDir = null) {
  const hooks = hooksDir ?? tempDir(t);
  mkdirSync(hooks, { recursive: true });
  for (const name of ['pre-commit', 'pre-merge-commit']) {
    writeFileSync(path.join(hooks, name), `#!/bin/sh\nexec node "${CLI_MJS}" pre-commit\n`);
    chmodSync(path.join(hooks, name), 0o755);
  }
  if (hooksDir === null) git('config', 'core.hooksPath', hooks);
}

const MAIN = /aidrian worktree new <branch>/;
const OVERRIDE_LINE =
  /the override is per command, in the Human's own terminal: AIDRIAN_ALLOW_MAIN_COMMIT=1 git commit …; never exported before a session, and agents never set it/;

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

test('pre-commit refuses in a main checkout on an orphan branch: an unborn HEAD is a first commit only with no refs', (t) => {
  const { dir, git } = repo(t);
  git('checkout', '-q', '--orphan', 'fresh');
  const { status, stderr } = preCommit(dir);
  assert.equal(status, 1);
  assert.match(stderr, MAIN);
});

test('pre-commit refuses after git switch --orphan, which empties the working tree: the config committed on a branch counts', (t) => {
  const { dir, git } = repo(t);
  git('switch', '-q', '--orphan', 'fresh');
  assert.equal(existsSync(path.join(dir, '.aidrian/config.json')), false, 'the orphan switch removed config.json');
  const { status, stderr } = preCommit(dir);
  assert.equal(status, 1);
  assert.match(stderr, MAIN);

  const off = repo(t, { version: 1, git: { mainCheckout: { guard: false } } });
  off.git('switch', '-q', '--orphan', 'fresh');
  assert.deepEqual(preCommit(off.dir), { status: 0, stdout: '', stderr: '' }, 'the committed guard is off');
  const none = repo(t, null);
  none.git('switch', '-q', '--orphan', 'fresh');
  assert.deepEqual(preCommit(none.dir), { status: 0, stdout: '', stderr: '' }, 'no branch has a config.json');
});

test('pre-commit after an orphan switch reads the default branch, origin/HEAD first, not the branch that sorts first', (t) => {
  const bare = (git) => {
    git('switch', '-q', '--orphan', 'a-bare');
    git('commit', '-q', '--allow-empty', '-m', 'no config here');
  };
  const { dir, git } = repo(t);
  bare(git);
  git('switch', '-q', 'main');
  git('switch', '-q', '--orphan', 'fresh');
  const local = preCommit(dir);
  assert.equal(local.status, 1, 'main holds the config, though a-bare sorts first');
  assert.match(local.stderr, MAIN);

  const other = repo(t);
  other.git('branch', '-q', '-m', 'main', 'trunk');
  const origin = tempDir(t);
  gitIn(origin)('init', '-q', '--bare', '-b', 'trunk');
  other.git('remote', 'add', 'origin', origin);
  other.git('push', '-q', 'origin', 'trunk');
  other.git('remote', 'set-head', 'origin', 'trunk');
  bare(other.git);
  other.git('switch', '-q', '--orphan', 'fresh');
  const remote = preCommit(other.dir);
  assert.equal(remote.status, 1, 'origin/HEAD holds the config, with no local main');
  assert.match(remote.stderr, MAIN);
});

test('pre-commit passes on a main with no config.json, though a branch that sorts first turns the guard on', (t) => {
  const { dir, git } = repo(t, null);
  git('switch', '-q', '-c', 'chore/adopt-aidrian');
  writeConfig(dir, GUARD_ON);
  git('add', '.aidrian/config.json');
  git('commit', '-q', '-m', 'adopt aidrian');
  git('switch', '-q', 'main');
  assert.equal(existsSync(path.join(dir, '.aidrian/config.json')), false);
  assert.deepEqual(preCommit(dir), { status: 0, stdout: '', stderr: '' });
});

test('pre-commit passes with the guard off and with no project folder', (t) => {
  for (const config of [{ version: 1, git: { mainCheckout: { guard: false } } }, { version: 1 }, null]) {
    const { dir } = repo(t, config);
    assert.deepEqual(preCommit(dir), { status: 0, stdout: '', stderr: '' }, JSON.stringify(config));
  }
});

test('pre-commit passes, with one stderr line, when config.json is there but does not load', (t) => {
  for (const config of ['{ "version": 1, "git": { "mainCheckout": { "guard": true ', { version: 99, git: { mainCheckout: { guard: true } } }]) {
    const { dir } = repo(t, config);
    assert.deepEqual(preCommit(dir), { status: 0, stdout: '', stderr: 'aidrian pre-commit: config.json unreadable; not checked\n' }, JSON.stringify(config));
  }
});

test('pre-commit: a leftover commits key is an unknown key, and the guard alone still refuses', (t) => {
  for (const commits of ['allow', 'warn']) {
    const { dir } = repo(t, { version: 1, git: { mainCheckout: { guard: true, commits } } });
    const { status, stderr } = preCommit(dir);
    assert.equal(status, 1, commits);
    assert.match(stderr, MAIN, commits);
    assert.doesNotMatch(stderr, /^warning:/m, commits);
  }
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
  assert.match(stderr, /git rm --cached logs\/run\.log, unless another branch already tracks it; then ask the Human\n/);
  assert.match(stderr, /git rm --cached 'logs\/my notes\.log', unless another branch already tracks it; then ask the Human\n/, 'a path with a space is quoted for the shell');
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
  assert.match(stderr, /git rm --cached logs\/README\.md, unless another branch already tracks it; then ask the Human\n/);
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
  assert.match(stderr, /git rm --cached \.worktrees\/other, unless another branch already tracks it; then ask the Human\n/);
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
  installHooks(t, git);
  const commit = (cwd, ...args) => gitRun(cwd, args);
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
  assert.match(full.stderr, /git rm --cached logs\/run\.log, unless another branch already tracks it; then ask the Human\n/);
  assert.doesNotMatch(full.stderr, MAIN);
  treeGit('rm', '-q', '--cached', 'logs/run.log');

  const merge = commit(dir, 'merge', '--no-ff', '--no-edit', 'side');
  assert.notEqual(merge.status, 0);
  assert.match(merge.stderr, MAIN);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no merge commit landed');
});

// The merge test's main holds a force-added ignored file, as a tracked .env.example is.
test('a merge that brings in a git-ignored file its other parent tracks passes through the real hooks; a fresh git add -f still refuses', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  treeGit('commit', '-q', '--allow-empty', '-m', 'task work');
  mkdirSync(path.join(dir, 'logs'));
  writeFileSync(path.join(dir, 'logs/keep.log'), 'tracked on main\n');
  git('add', '-f', 'logs/keep.log');
  git('commit', '-q', '-m', 'keep a log on main');
  installHooks(t, git);

  const merge = gitRun(tree, ['merge', '--no-ff', '--no-edit', 'main']);
  assert.deepEqual([merge.status, merge.stderr], [0, ''], 'pre-merge-commit reads the parent git merge names');
  assert.equal(treeGit('rev-list', '--count', '--merges', 'HEAD^..HEAD').trim(), '1', 'the merge commit landed');
  assert.equal(treeGit('ls-files', 'logs/keep.log'), 'logs/keep.log\n');

  writeFileSync(path.join(tree, 'logs/new.log'), 'x\n');
  treeGit('add', '-f', 'logs/new.log');
  const fresh = gitRun(tree, ['commit', '-q', '-m', 'test: a new log']);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /git rm --cached logs\/new\.log, unless another branch already tracks it; then ask the Human\n/);
  assert.doesNotMatch(fresh.stderr, /keep\.log/, 'a path a parent tracks is never advised away');
});

test('pre-commit, while a merge waits for its commit: a path MERGE_HEAD tracks passes, and one no parent tracks refuses', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  treeGit('commit', '-q', '--allow-empty', '-m', 'task work');
  mkdirSync(path.join(dir, 'logs'));
  writeFileSync(path.join(dir, 'logs/keep.log'), 'tracked on main\n');
  git('add', '-f', 'logs/keep.log');
  git('commit', '-q', '-m', 'keep a log on main');

  treeGit('merge', '-q', '--no-ff', '--no-commit', 'main');
  assert.deepEqual(preCommit(tree), { status: 0, stdout: '', stderr: '' });
  writeFileSync(path.join(tree, 'logs/new.log'), 'x\n');
  treeGit('add', '-f', 'logs/new.log');
  const { status, stderr } = preCommit(tree);
  assert.equal(status, 1);
  assert.match(stderr, /git rm --cached logs\/new\.log, unless another branch already tracks it; then ask the Human\n/);
  assert.doesNotMatch(stderr, /keep\.log/);
});

test('pre-commit: a GITHEAD_ name for an ancestor of HEAD that tracked the path exempts nothing', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  mkdirSync(path.join(tree, 'logs'));
  writeFileSync(path.join(tree, 'logs/old.log'), 'x\n');
  treeGit('add', '-f', 'logs/old.log');
  treeGit('commit', '-q', '-m', 'track a log');
  const tracked = treeGit('rev-parse', 'HEAD').trim();
  treeGit('rm', '-q', '--cached', 'logs/old.log');
  treeGit('commit', '-q', '-m', 'drop it');
  treeGit('add', '-f', 'logs/old.log');
  const { status, stderr } = preCommit(tree, { [`GITHEAD_${tracked}`]: 'old' });
  assert.equal(status, 1);
  assert.match(stderr, /git rm --cached logs\/old\.log, unless another branch already tracks it; then ask the Human\n/);
});

test('pre-commit refuses an ignored file a squash merge or a path restore brings in, leaving that case to the Human', (t) => {
  const { dir, git } = repo(t);
  const { tree, git: treeGit } = worktree(dir, git);
  treeGit('commit', '-q', '--allow-empty', '-m', 'task work');
  mkdirSync(path.join(dir, 'logs'));
  writeFileSync(path.join(dir, 'logs/keep.log'), 'tracked on main\n');
  git('add', '-f', 'logs/keep.log');
  git('commit', '-q', '-m', 'keep a log on main');
  const ADVICE = /logs\/keep\.log is git-ignored but newly staged; unstage it with git rm --cached logs\/keep\.log, unless another branch already tracks it; then ask the Human\n/;

  treeGit('merge', '-q', '--squash', 'main');
  const squash = preCommit(tree);
  assert.equal(squash.status, 1);
  assert.match(squash.stderr, ADVICE);
  treeGit('reset', '-q', '--hard');

  treeGit('checkout', 'main', '--', 'logs/keep.log');
  const restore = preCommit(tree);
  assert.equal(restore.status, 1);
  assert.match(restore.stderr, ADVICE);
});

test('a commit routed through GIT_DIR or --git-dir from a folder outside the repository is judged by that repository', (t) => {
  const { dir, git } = repo(t);
  installHooks(t, git, path.join(dir, '.git', 'hooks'));
  const before = git('rev-parse', 'HEAD');
  const outside = tempDir(t);

  const viaEnv = gitRun(outside, ['commit', '--allow-empty', '-q', '-m', 'test: via GIT_DIR'], { GIT_DIR: path.join(dir, '.git') });
  assert.equal(viaEnv.status, 1, viaEnv.stderr);
  assert.match(viaEnv.stderr, MAIN);
  const viaOption = gitRun(outside, ['--git-dir', path.join(dir, '.git'), 'commit', '--allow-empty', '-q', '-m', 'test: via --git-dir']);
  assert.equal(viaOption.status, 1, viaOption.stderr);
  assert.match(viaOption.stderr, MAIN);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no commit landed on main');

  // A linked worktree's own git folder commits to its branch, which the guard lets through.
  worktree(dir, git);
  const viaWorktree = gitRun(outside, ['commit', '--allow-empty', '-q', '-m', 'test: in the worktree'], { GIT_DIR: path.join(dir, '.git', 'worktrees', 'task') });
  assert.deepEqual([viaWorktree.status, viaWorktree.stderr], [0, '']);
  assert.equal(git('log', '-1', '--format=%s', 'task'), 'test: in the worktree\n');
});

// This repository's own .githooks, installed by absolute path as `make hooks` does: git then finds them whatever the
// commit's work tree, and each hook finds its script beside itself, not in that work tree.
test("this repository's hooks, by absolute core.hooksPath, refuse a GIT_DIR commit from a sibling folder; a worktree's commit and a push run", (t) => {
  const { dir, git } = repo(t);
  git('config', 'core.hooksPath', path.join(ROOT, '.githooks'));
  const before = git('rev-parse', 'HEAD');
  const sibling = tempDir(t);

  const viaEnv = gitRun(sibling, ['commit', '--allow-empty', '-q', '-m', 'test: via GIT_DIR'], { GIT_DIR: path.join(dir, '.git') });
  assert.equal(viaEnv.status, 1, viaEnv.stderr);
  assert.match(viaEnv.stderr, MAIN, 'the commit guard ran, not a missing script');
  const viaOption = gitRun(sibling, ['--git-dir', path.join(dir, '.git'), 'commit', '--allow-empty', '-q', '-m', 'test: via --git-dir']);
  assert.equal(viaOption.status, 1, viaOption.stderr);
  assert.match(viaOption.stderr, MAIN);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no commit landed on main');

  // A worktree's git folder: pre-commit passes, and commit-msg finds its script too.
  worktree(dir, git);
  const viaWorktree = gitRun(sibling, ['commit', '--allow-empty', '-q', '-m', 'test: in the worktree'], { GIT_DIR: path.join(dir, '.git', 'worktrees', 'task') });
  assert.deepEqual([viaWorktree.status, viaWorktree.stderr], [0, '']);
  assert.equal(git('log', '-1', '--format=%s', 'task'), 'test: in the worktree\n');
  // pre-push finds its script the same way.
  const origin = tempDir(t);
  gitIn(origin)('init', '-q', '--bare', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  const push = gitRun(sibling, ['push', '-q', 'origin', 'task'], { GIT_DIR: path.join(dir, '.git') });
  assert.deepEqual([push.status, push.stderr], [0, '']);
});

test("make hooks sets core.hooksPath to the main checkout's absolute .githooks, run there or in a worktree", (t) => {
  if (spawnSync('make', ['--version']).status !== 0) return t.skip('make is not installed');
  const { dir, git } = repo(t);
  const { tree } = worktree(dir, git);
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  // core.hooksPath is shared by every worktree: one inside a worktree would stop every hook once that worktree goes.
  for (const at of [dir, tree]) {
    git('config', 'core.hooksPath', 'unset-by-the-test');
    const make = spawnSync('make', ['-s', '-C', at, '-f', path.join(ROOT, 'Makefile'), 'hooks'], { encoding: 'utf8', env });
    assert.equal(make.status, 0, make.stderr);
    assert.equal(git('config', '--get', 'core.hooksPath'), `${path.join(dir, '.githooks')}\n`, `run in ${at}`);
  }
});

// unpushedMainLine, against the same temporary repositories with a bare origin, made with `git init --bare` under
// mkdtemp and filled with `git -C … push`.
const AHEAD = (count) =>
  `Local main has ${count} commit${count === 1 ? '' : 's'} not on origin/main; only worktrees commit here. Inspect: git log origin/main..main`;
const OFF = (branch) => `The main checkout is on ${branch}, not main; only worktrees change branch. Switch back: git switch main`;
const DETACHED = "The main checkout's HEAD is detached, not on main. Switch back: git switch main";
const CHANGED = 'The main checkout has changed tracked files; task work belongs in a worktree. Inspect: git status';

function withOrigin(t, config = GUARD_ON) {
  const { dir, git } = repo(t, config);
  const origin = tempDir(t);
  gitIn(origin)('init', '-q', '--bare', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { dir, git };
}

const startLines = (cwd) => {
  const project = projectAt(cwd);
  return unpushedMainLine(project, loadConfig(project).config);
};

test('unpushedMainLine: local main one commit ahead of origin/main gives the line with its count; even gives none', (t) => {
  const { dir, git } = withOrigin(t);
  assert.deepEqual(startLines(dir), [], 'even with origin');
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  assert.deepEqual(startLines(dir), [AHEAD(1)]);
  git('commit', '-q', '--allow-empty', '-m', 'another');
  assert.deepEqual(startLines(dir), [AHEAD(2)]);
  const { tree } = worktree(dir, git);
  assert.deepEqual(startLines(tree), [AHEAD(2)], 'a session in a worktree reads the main checkout');
  git('push', '-q', 'origin', 'main');
  assert.deepEqual(startLines(dir), []);
});

test('unpushedMainLine: no origin/main ref gives no unpushed line, and only that line is dropped', (t) => {
  const { dir, git } = repo(t);
  assert.deepEqual(startLines(dir), []);
  git('switch', '-q', '-c', 'side');
  assert.deepEqual(startLines(dir), [OFF('side')], 'the failed rev-list drops its own line only');
});

test('unpushedMainLine: the guard off gives no line, whatever the main checkout holds', (t) => {
  for (const config of [{ version: 1, git: { mainCheckout: { guard: false } } }, { version: 1 }]) {
    const { dir, git } = withOrigin(t, config);
    git('commit', '-q', '--allow-empty', '-m', 'stray');
    writeFileSync(path.join(dir, 'README.md'), '# changed\n');
    git('switch', '-q', '-c', 'side');
    assert.deepEqual(startLines(dir), [], JSON.stringify(config));
  }
});

test('unpushedMainLine: off main names the branch, a detached HEAD gets its own line, and a changed tracked file names git status', (t) => {
  const { dir, git } = withOrigin(t);
  git('switch', '-q', '-c', 'feature/x');
  assert.deepEqual(startLines(dir), [OFF('feature/x')]);
  git('switch', '-q', '--detach', 'main');
  assert.deepEqual(startLines(dir), [DETACHED]);
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  assert.deepEqual(startLines(dir), [CHANGED]);
  git('add', 'README.md');
  assert.deepEqual(startLines(dir), [CHANGED], 'a staged change counts too');
  git('commit', '-q', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  writeFileSync(path.join(dir, 'README.md'), '# again\n');
  assert.deepEqual(startLines(dir), [AHEAD(1), OFF('side'), CHANGED], 'all three, in order');
});

test('unpushedMainLine: a clean checkout on main gives no line, and an untracked file alone gives none', (t) => {
  const { dir } = withOrigin(t);
  assert.deepEqual(startLines(dir), []);
  writeFileSync(path.join(dir, 'notes.md'), 'scratch\n');
  assert.deepEqual(startLines(dir), []);
});

test('unpushedMainLine: the default branch comes from git.defaultBranch, and no checkout gives no line', (t) => {
  const { dir, git } = withOrigin(t, { version: 1, git: { defaultBranch: 'trunk', mainCheckout: { guard: true } } });
  git('branch', '-q', '-m', 'main', 'trunk');
  git('push', '-q', 'origin', 'trunk');
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  assert.deepEqual(startLines(dir), [
    'Local trunk has 1 commit not on origin/trunk; only worktrees commit here. Inspect: git log origin/trunk..trunk',
  ]);

  const outside = tempDir(t);
  writeConfig(outside, GUARD_ON);
  const project = projectAt(outside);
  const env = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
  t.after(() => (env === undefined ? delete process.env.GIT_CEILING_DIRECTORIES : (process.env.GIT_CEILING_DIRECTORIES = env)));
  assert.deepEqual(unpushedMainLine(project, loadConfig(project).config), []);
});

test('unpushedMainLine: a tag named main does not make main read as another branch', (t) => {
  const { dir, git } = withOrigin(t);
  git('tag', 'main');
  assert.deepEqual(startLines(dir), []);
  git('switch', '-q', '-c', 'side');
  assert.deepEqual(startLines(dir), [OFF('side')]);
});

test('unpushedMainLine: a status git cannot read drops only the changed-files line', (t) => {
  const { dir, git } = withOrigin(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  // An index git cannot parse, inside the temporary repository: only the status read uses it.
  writeFileSync(path.join(dir, '.git', 'index'), 'not an index\n');
  assert.deepEqual(startLines(dir), [AHEAD(1), OFF('side')]);
});
