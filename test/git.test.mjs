import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkoutRoots, currentRoot, GIT_TIMEOUT_MS, isIgnored, mainRoot, repositoryCheckouts } from '../plugins/aidrian/lib/git.mjs';

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

test('a git that hangs is stopped after the timeout and counts as git not answering, so a hook fails open', (t) => {
  const { dir } = repo(t);
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-git-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const lib = JSON.stringify(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/git.mjs'));
  const script = `import { checkoutRoots } from ${lib}; console.log(JSON.stringify(checkoutRoots(${JSON.stringify(dir)})));`;
  let started = Date.now();
  const roots = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.deepEqual([roots.status, roots.stdout], [0, 'null\n']);
  assert.ok(Date.now() - started < GIT_TIMEOUT_MS + 2000, `${Date.now() - started} ms`);

  // The main-checkout rule lets a Bash write run when git cannot answer. The hook asks git more than once, but waits
  // only for the first call, so it ends well inside the host's 5 s limit.
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  const hook = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > tracked.md' }, cwd: dir });
  started = Date.now();
  const ran = spawnSync(process.execPath, [hook], { input, cwd: dir, env, encoding: 'utf8' });
  assert.deepEqual([ran.status, ran.stderr], [0, '']);
  assert.ok(Date.now() - started < GIT_TIMEOUT_MS + 1500, `${Date.now() - started} ms`);
});

test('repositoryCheckouts lists every checkout but a gone one; [] only outside a repository or without git, else null on failure', (t) => {
  const { dir, worktree } = repo(t);
  assert.deepEqual(repositoryCheckouts(path.join(dir, 'src')), [dir, worktree]);
  assert.deepEqual(repositoryCheckouts(worktree), [worktree, dir], 'the checkout it is in comes first');
  const gone = path.join(dir, '.aidrian/worktrees/gone');
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'gone', gone], { stdio: 'pipe' });
  rmSync(gone, { recursive: true, force: true });
  assert.deepEqual(repositoryCheckouts(dir), [dir, worktree], 'a worktree whose folder is gone is no checkout');
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-no-git-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(repositoryCheckouts(outside), []);
  // A git that exits 128 for everything: inside a repository the list always names the main checkout, so a failed one is
  // unknown, never empty; outside one there is nothing to list. With no git at all, there is nothing to list either.
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-git-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: broken" >&2\nexit 128\n', { mode: 0o755 });
  const lib = JSON.stringify(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/git.mjs'));
  const answer = (cwd, PATH) => {
    const script = `import { repositoryCheckouts } from ${lib}; console.log(JSON.stringify(repositoryCheckouts(${JSON.stringify(cwd)})));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(answer(dir, bin), null);
  assert.equal(answer(path.join(dir, 'src'), bin), null);
  assert.deepEqual(answer(outside, bin), []);
  const empty = mkdtempSync(path.join(tmpdir(), 'aidrian-no-bin-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(answer(dir, empty), []);
});

test('repositoryCheckouts is null when the environment points git at another repository, or keeps it from this one', (t) => {
  const { dir } = repo(t);
  const other = repo(t).dir;
  const lib = JSON.stringify(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/git.mjs'));
  // Each child gets the environment named, and nothing else that points git anywhere.
  const answer = (cwd, extra) => {
    const script = `import { repositoryCheckouts } from ${lib}; console.log(JSON.stringify(repositoryCheckouts(${JSON.stringify(cwd)})));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(answer(dir, { GIT_DIR: path.join(other, '.git') }), null, 'GIT_DIR');
  assert.equal(answer(dir, { GIT_WORK_TREE: other }), null, 'GIT_WORK_TREE');
  assert.equal(answer(dir, { GIT_COMMON_DIR: path.join(other, '.git') }), null, 'GIT_COMMON_DIR');
  // The same through the options a caller passes for each git call.
  assert.equal(repositoryCheckouts(dir, () => ({ env: { ...process.env, GIT_DIR: path.join(other, '.git') } })), null);
  // A ceiling above the checkout keeps git from it, but the disk shows its `.git`: unknown, never empty.
  assert.equal(answer(path.join(dir, 'src'), { GIT_CEILING_DIRECTORIES: dir }), null, 'GIT_CEILING_DIRECTORIES');
});
