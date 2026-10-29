import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkoutRoots, currentRoot, isIgnored, mainRoot } from '../plugins/aidrian/lib/git.mjs';

// A repository with one commit, an ignored folder, and a worktree inside that folder.
function repo(t) {
  // realpath: git prints real paths, and on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian/worktrees/\n');
  writeFileSync(path.join(dir, 'tracked.md'), '# Tracked\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const worktree = path.join(dir, '.aidrian/worktrees/task');
  git('worktree', 'add', '-q', '-b', 'task', worktree);
  mkdirSync(path.join(dir, 'src'));
  return { dir, worktree };
}

test('the main root is the same from the main checkout, a subfolder, and a worktree; the current root is not', (t) => {
  const { dir, worktree } = repo(t);
  for (const cwd of [dir, path.join(dir, 'src'), worktree]) assert.equal(mainRoot(cwd), dir, cwd);
  assert.equal(currentRoot(path.join(dir, 'src')), dir);
  assert.equal(currentRoot(worktree), worktree);
});

test('with a separate git folder, the main checkout is the folder that has the files, not the git folder`s parent', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'meta.git'), work]);
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['-C', work, ...identity, 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(path.join(work, 'src'));
  for (const cwd of [work, path.join(work, 'src')]) {
    assert.deepEqual(checkoutRoots(cwd), { main: work, current: work }, cwd);
    assert.equal(mainRoot(cwd), work, cwd);
  }
  const worktree = path.join(base, 'task');
  execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'task', worktree]);
  assert.equal(checkoutRoots(worktree).current, worktree, 'a linked worktree is never the main checkout');
  assert.notEqual(checkoutRoots(worktree).main, worktree);
});

test('isIgnored answers true or false inside a repository, and null when git cannot tell', (t) => {
  const { dir } = repo(t);
  assert.equal(isIgnored(dir, 'tracked.md'), false);
  assert.equal(isIgnored(dir, 'new-file.md'), false);
  assert.equal(isIgnored(dir, '.aidrian/worktrees/task/tracked.md'), true);
  assert.equal(isIgnored(dir, path.join(dir, '.aidrian/worktrees/other')), true);
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-no-git-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(isIgnored(outside, 'file.md'), null);
  assert.equal(mainRoot(outside), null);
  assert.equal(currentRoot(outside), null);
});
