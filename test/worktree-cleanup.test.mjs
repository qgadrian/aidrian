import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeCleanup, parseDuration, planCleanup } from '../plugins/aidrian/lib/worktree.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const LATER = Date.now() + 2 * 24 * 3600 * 1000;

// A clone of a bare origin with worktrees in every state the cleanup knows:
//   pr       HEAD is a merged pull request's head          ff       merged into origin/main by fast-forward
//   squash   squash-merged into origin/main                open     one commit that is not merged
//   dirty    the pull request's head plus an uncommitted change      locked   locked
function fixture(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-clean-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...IDENTITY, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'origin.git')]);
  mkdirSync(path.join(repo, '.aidrian'));
  writeFileSync(path.join(repo, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const dirs = {};
  const add = (name, ...commits) => {
    dirs[name] = path.join(repo, '.worktrees', name);
    git(repo, 'worktree', 'add', '-q', '-b', `feat/${name}`, dirs[name], 'main');
    for (const file of commits) {
      writeFileSync(path.join(dirs[name], file), `${name} ${file}\n`);
      git(dirs[name], 'add', file);
      git(dirs[name], 'commit', '-q', '-m', `${name} ${file}`);
    }
  };
  add('pr', 'pr.txt');
  add('ff', 'ff.txt');
  add('squash', 's1.txt', 's2.txt');
  add('open', 'open.txt');
  add('dirty', 'dirty.txt');
  add('locked');
  writeFileSync(path.join(dirs.dirty, 'wip.txt'), 'work in progress\n');
  git(repo, 'worktree', 'lock', dirs.locked);
  git(repo, 'merge', '-q', '--ff-only', 'feat/ff');
  git(repo, 'merge', '-q', '--squash', 'feat/squash');
  git(repo, 'commit', '-q', '-m', 'squash');
  git(repo, 'push', '-q', 'origin', 'main');

  const merged = new Map([['feat/pr', [git(dirs.pr, 'rev-parse', 'HEAD')]], ['feat/dirty', [git(dirs.dirty, 'rev-parse', 'HEAD')]]]);
  const heads = () => merged;
  const plan = (options = {}, deps = {}) => planCleanup(options, { cwd: repo, heads, now: LATER, ...deps });
  const rowOf = (result, name) => [...result.auto, ...result.confirm, ...result.skip].find((row) => row.path === (dirs[name] ?? name));
  return { base, repo, git, dirs, heads, plan, rowOf };
}

test('only a merged pull request`s exact head, clean and old enough, is removed without asking', (t) => {
  const { repo, dirs, plan, rowOf } = fixture(t);
  const result = plan();
  assert.deepEqual([result.status, result.base, result.gh_available, result.min_age_sec], ['planned', 'origin/main', true, 86400]);
  assert.deepEqual(result.auto.map((row) => row.path), [dirs.pr]);
  assert.deepEqual(rowOf(result, 'pr'), { bucket: 'auto', path: dirs.pr, branch: 'feat/pr', reasons: ['merged pull request'], dirty: false, branch_delete: '-D' });
  assert.deepEqual(rowOf(result, 'ff').reasons, ['already in origin/main; no merged pull request confirms it']);
  assert.deepEqual(rowOf(result, 'squash').reasons, ['its changes are in origin/main; no merged pull request confirms it']);
  assert.deepEqual(rowOf(result, 'open').reasons, ['not merged into origin/main']);
  assert.deepEqual(rowOf(result, 'dirty').reasons, ['merged pull request', '1 uncommitted change']);
  assert.deepEqual([rowOf(result, 'ff').branch_delete, rowOf(result, 'dirty').bucket], ['-d', 'confirm']);
  assert.deepEqual([rowOf(result, 'locked').reason, rowOf(result, repo).reason], ['locked', 'main checkout']);
});

test('without gh nothing is automatic, and a worktree younger than --min-age is skipped', (t) => {
  const { dirs, plan, rowOf } = fixture(t);
  const offline = plan({}, { heads: () => null });
  assert.deepEqual([offline.gh_available, offline.auto], [false, []]);
  assert.deepEqual([rowOf(offline, 'pr').bucket, rowOf(offline, 'pr').reasons], ['confirm', ['not merged into origin/main']]);

  const fresh = plan({}, { now: Date.now() });
  assert.deepEqual(fresh.auto, []);
  assert.match(rowOf(fresh, 'pr').reason, /^too new: 0h old/);
  assert.equal(plan({ minAgeSec: 0 }, { now: Date.now() }).auto[0].path, dirs.pr);
});

test('a session inside a worktree never removes that worktree', (t) => {
  const { dirs, heads } = fixture(t);
  const result = planCleanup({}, { cwd: dirs.pr, heads, now: LATER });
  assert.deepEqual(result.auto, []);
  assert.equal(result.skip.find((row) => row.path === dirs.pr).reason, 'current worktree');
});

test('execute removes auto rows and confirmed deletes, keeps the rest, and needs --force for uncommitted work', (t) => {
  const { repo, git, dirs, heads } = fixture(t);
  const decisions = { [dirs.ff]: 'delete', [dirs.open]: 'keep', [dirs.dirty]: 'delete', [dirs.squash]: 'delete' };
  const result = executeCleanup({ decisions }, { cwd: repo, heads, now: LATER });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.removed.map((row) => [path.basename(row.path), row.branch_deleted]), [['pr', true], ['ff', true], ['squash', false]]);
  assert.match(result.removed[2].branch_error, /not fully merged/, 'git -d keeps a squash-merged branch');
  assert.deepEqual(result.kept, [dirs.open]);
  assert.deepEqual(result.refused, [{ path: dirs.dirty, reason: 'uncommitted changes: needs --force as well as the delete decision' }]);
  assert.equal(existsSync(dirs.pr), false);
  assert.equal(git(repo, 'branch', '--list', 'feat/pr'), '');

  const forced = executeCleanup({ decisions, force: true }, { cwd: repo, heads, now: LATER });
  assert.deepEqual(forced.removed.map((row) => [path.basename(row.path), row.branch_deleted]), [['dirty', true]]);
  assert.equal(existsSync(dirs.dirty), false);
});

test('parseDuration reads seconds and one unit; the command reads decisions on stdin and prints JSON', (t) => {
  assert.deepEqual(['90', '30m', '2h', '1d', '0'].map(parseDuration), [90, 1800, 7200, 86400, 0]);
  assert.throws(() => parseDuration('2 days'), /invalid --min-age/);
  const { repo, dirs } = fixture(t);
  const run = (args, input = '') => spawnSync(CLI, ['worktree', 'cleanup', ...args], { cwd: repo, input, encoding: 'utf8' });
  const plan = run(['--min-age', '0']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(JSON.parse(plan.stdout).confirm.some((row) => row.path === dirs.open));
  const executed = run(['execute', '--min-age', '0'], JSON.stringify({ [dirs.open]: 'delete' }));
  assert.equal(executed.status, 0, executed.stderr);
  assert.ok(JSON.parse(executed.stdout).removed.some((row) => row.path === dirs.open));
  const bad = run(['--min-age', 'soon']);
  assert.deepEqual([bad.status, JSON.parse(bad.stdout).phase], [1, 'arguments']);
});
