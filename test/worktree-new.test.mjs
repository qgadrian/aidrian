import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorktree } from '../plugins/aidrian/lib/worktree.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

// A clone of a bare `origin` with one commit on main, a project folder, and .worktrees/ ignored.
function fixture(t, config = { version: 1 }, { origin = true } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-wt-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(path.join(repo, '.aidrian'));
  writeFileSync(path.join(repo, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  if (origin) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'origin.git')]);
    git('remote', 'add', 'origin', path.join(base, 'origin.git'));
    git('push', '-q', '-u', 'origin', 'main');
  }
  const create = (options) => createWorktree(options, { cwd: repo });
  const blocked = (options) => {
    try {
      create(options);
    } catch (error) {
      return { phase: error.phase, reason: error.message, next: error.nextStep };
    }
    assert.fail('expected the call to be blocked');
  };
  return { base, repo, git, create, blocked };
}

test('in a repository whose git folder is separate, a plan finds the base branch and the folder from the main checkout', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-wt-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'meta.git'), repo]);
  writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, ...IDENTITY, 'commit', '-q', '-m', 'init']);
  const plan = createWorktree({ branch: 'feat/x', plan: true }, { cwd: repo });
  assert.deepEqual([plan.status, plan.worktree_path, plan.base], ['planned', path.join(repo, '.worktrees/x'), 'main']);
});

test('a plan names the folder after the last part of the branch, starts at origin/<default>, and touches nothing', (t) => {
  const { repo, git, create } = fixture(t);
  const plan = create({ branch: 'feat/share-links', plan: true });
  assert.deepEqual(plan, {
    status: 'planned',
    worktree_path: path.join(repo, '.worktrees/share-links'),
    branch: 'feat/share-links',
    branch_mode: 'new',
    base: 'origin/main',
    base_sha: git('rev-parse', 'origin/main'),
    bootstrap: null,
  });
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);
  assert.equal(create({ branch: 'fix/a', slug: 'other', plan: true }).worktree_path, path.join(repo, '.worktrees/other'));
});

test('create adds the branch with no upstream and runs the bootstrap inside the new worktree', (t) => {
  const { repo, git, create } = fixture(t, { version: 1, worktrees: { bootstrap: 'pwd > booted.txt' } });
  const result = create({ branch: 'feat/x' });
  const dir = path.join(repo, '.worktrees/x');
  assert.deepEqual([result.status, result.worktree_path, result.branch_mode, result.bootstrap], ['created', dir, 'new', 'pwd > booted.txt']);
  assert.equal(realpathSync(readFileSync(path.join(dir, 'booted.txt'), 'utf8').trim()), dir);
  assert.equal(git('-C', dir, 'branch', '--show-current'), 'feat/x');
  assert.equal(spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '@{u}']).status, 128, 'a bare git push cannot target main');
  assert.equal(git('status', '--porcelain'), '', 'the main checkout stays clean');
});

test('an existing local or remote branch is reused only after approval, and the remote one tracks origin', (t) => {
  const { repo, git, create, blocked } = fixture(t);
  git('branch', 'feat/local');
  assert.equal(create({ branch: 'feat/local', plan: true }).branch_mode, 'reuse-local');
  assert.equal(blocked({ branch: 'feat/local' }).phase, 'confirm-reuse');
  assert.equal(existsSync(path.join(repo, '.worktrees/local')), false);
  assert.equal(create({ branch: 'feat/local', reuseExisting: true }).status, 'created');

  git('push', '-q', 'origin', 'main:feat/remote');
  git('update-ref', '-d', 'refs/remotes/origin/feat/remote');
  assert.equal(create({ branch: 'feat/remote', plan: true }).branch_mode, 'reuse-remote');
  assert.equal(create({ branch: 'feat/remote', reuseExisting: true }).status, 'created');
  assert.equal(git('-C', path.join(repo, '.worktrees/remote'), 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/remote');
});

test('create is blocked before it changes anything: bad names, a taken folder or branch, a missing base', (t) => {
  const { repo, git, create, blocked } = fixture(t);
  assert.equal(blocked({ branch: 'bad..name' }).phase, 'validate');
  assert.equal(blocked({ branch: 'feat/x', slug: '-x' }).phase, 'validate');
  assert.equal(blocked({ branch: 'feat/x', base: 'origin/nope' }).phase, 'resolve-base');
  mkdirSync(path.join(repo, '.worktrees/taken'), { recursive: true });
  assert.equal(blocked({ branch: 'feat/taken' }).phase, 'validate-path');
  create({ branch: 'feat/held' });
  const held = blocked({ branch: 'feat/held', slug: 'again', reuseExisting: true });
  assert.deepEqual([held.phase, held.reason], ['validate-branch', `feat/held is checked out in ${path.join(repo, '.worktrees/held')}`]);
  assert.equal(git('branch', '--list', 'feat/x'), '');
});

test('a worktrees folder inside the repository that git does not ignore blocks create', (t) => {
  const { repo, blocked } = fixture(t);
  writeFileSync(path.join(repo, '.gitignore'), '');
  const result = blocked({ branch: 'feat/x' });
  assert.equal(result.phase, 'preconditions');
  assert.match(result.next, /Add "\.worktrees\/" to \.gitignore/);
});

test('a failing bootstrap keeps the worktree and reports the end of its output and the command to rerun', (t) => {
  const { repo, blocked } = fixture(t, { version: 1, worktrees: { bootstrap: 'for i in $(seq 1 30); do echo line $i; done; echo broke >&2; exit 3' } });
  const result = blocked({ branch: 'feat/x' });
  const dir = path.join(repo, '.worktrees/x');
  assert.equal(result.phase, 'bootstrap');
  assert.match(result.reason, new RegExp(`^the worktree ${dir} was created, but its bootstrap failed:\\n`));
  assert.match(result.reason, /line 30\nbroke$/);
  assert.doesNotMatch(result.reason, /line 1\n/, 'only the end of the output');
  assert.match(result.next, /^cd ".*\/\.worktrees\/x" && for i/);
  assert.equal(existsSync(dir), true);
});

test('without an origin the base is the local default branch, and worktrees.dir moves the folder', (t) => {
  const { base, repo, create } = fixture(t, { version: 1, defaultBranch: 'main', worktrees: { dir: '../trees' } }, { origin: false });
  const result = create({ branch: 'feat/x' });
  assert.deepEqual([result.base, result.worktree_path], ['main', path.join(base, 'trees/x')]);
  assert.equal(existsSync(path.join(repo, '.worktrees')), false);
});

test('the command prints one JSON line, and a blocked run exits 1 with phase, reason, and next step', (t) => {
  const { repo } = fixture(t);
  const run = (args) => spawnSync(CLI, ['worktree', ...args], { cwd: repo, encoding: 'utf8' });
  const plan = run(['new', 'feat/x', '--plan']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).status, 'planned');
  const bad = run(['new', 'feat/x', '--base', 'nope']);
  assert.equal(bad.status, 1);
  assert.deepEqual(Object.keys(JSON.parse(bad.stdout)), ['status', 'phase', 'reason', 'next_step']);
  assert.match(run(['new']).stderr, /^usage: aidrian worktree new BRANCH/);
});
