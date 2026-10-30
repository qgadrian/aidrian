import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const { repo, git, dirs, plan, rowOf } = fixture(t);
  const result = plan();
  assert.deepEqual([result.status, result.base, result.gh_available, result.min_age_sec], ['planned', 'origin/main', true, 86400]);
  assert.deepEqual(result.auto.map((row) => row.path), [dirs.pr]);
  assert.deepEqual(rowOf(result, 'pr'), {
    bucket: 'auto', path: dirs.pr, branch: 'feat/pr', head: git(dirs.pr, 'rev-parse', 'HEAD'), reasons: ['merged pull request'], dirty: false, ignored: [],
    disposable: [], unreachable: 0, branch_delete: 'unless-moved',
  });
  assert.deepEqual(rowOf(result, 'ff').reasons, ['already in origin/main; no merged pull request confirms it']);
  assert.deepEqual(rowOf(result, 'squash').reasons, ['its changes are in origin/main; no merged pull request confirms it']);
  assert.deepEqual(rowOf(result, 'open').reasons, ['not merged into origin/main']);
  assert.deepEqual(rowOf(result, 'dirty').reasons, ['merged pull request', '1 uncommitted change']);
  assert.deepEqual([rowOf(result, 'ff').branch_delete, rowOf(result, 'dirty').bucket], ['if-merged', 'confirm']);
  assert.deepEqual([rowOf(result, 'locked').reason, rowOf(result, repo).reason], ['locked', 'main checkout']);
});

test('a git-ignored file, such as a .env, moves a merged worktree to confirm and is listed; execute keeps it', (t) => {
  const { repo, dirs, plan, rowOf, heads } = fixture(t);
  writeFileSync(path.join(repo, '.git/info/exclude'), '.env\nnode_modules/\n');
  writeFileSync(path.join(dirs.pr, '.env'), 'SECRET=1\n');
  mkdirSync(path.join(dirs.pr, 'node_modules'));
  writeFileSync(path.join(dirs.pr, 'node_modules/x.js'), '');
  const row = rowOf(plan(), 'pr');
  assert.deepEqual([row.bucket, row.dirty, row.ignored, row.disposable], ['confirm', false, ['.env'], ['node_modules/']]);
  assert.deepEqual(row.reasons, ['merged pull request', '1 git-ignored file, removed with it: .env']);
  const result = executeCleanup({}, { cwd: repo, heads, now: LATER });
  assert.deepEqual([result.removed, result.kept.includes(dirs.pr)], [[], true]);
  assert.equal(existsSync(path.join(dirs.pr, '.env')), true);
});

test('ignored files only in worktrees.disposable folders, at any depth, leave a merged worktree automatic', (t) => {
  const { repo, git, dirs, plan, rowOf, heads } = fixture(t);
  writeFileSync(path.join(repo, '.git/info/exclude'), 'node_modules/\n.next/\nbuild\n');
  for (const folder of ['node_modules/a', 'packages/web/node_modules', 'packages/web/.next/cache']) {
    mkdirSync(path.join(dirs.pr, folder), { recursive: true });
    writeFileSync(path.join(dirs.pr, folder, 'x.js'), '');
  }
  const result = plan();
  assert.equal(result.disposable.includes('node_modules'), true);
  const row = rowOf(result, 'pr');
  assert.deepEqual([row.bucket, row.ignored, row.disposable], ['auto', [], ['node_modules/', 'packages/web/.next/', 'packages/web/node_modules/']]);
  // A file named like a disposable folder is not one, and the list a project sets replaces the default.
  writeFileSync(path.join(dirs.pr, 'build'), '');
  assert.deepEqual(rowOf(plan(), 'pr').ignored, ['build']);
  rmSync(path.join(dirs.pr, 'build'));
  writeFileSync(path.join(repo, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { disposable: ['.next'] } } }));
  assert.deepEqual(rowOf(plan(), 'pr').ignored, ['node_modules/', 'packages/web/node_modules/']);
  writeFileSync(path.join(repo, '.aidrian/config.json'), '{"version": 1}');

  const done = executeCleanup({}, { cwd: repo, heads, now: LATER });
  assert.deepEqual(done.removed, [{ path: dirs.pr, branch: 'feat/pr', branch_deleted: true }]);
  assert.equal(existsSync(dirs.pr), false);
  assert.equal(git(repo, 'branch', '--list', 'feat/pr'), '');
});

test('a detached HEAD with commits on no branch is never removed without the delete decision and --force', (t) => {
  const { repo, git, dirs, plan, rowOf, heads } = fixture(t);
  const detached = path.join(repo, '.worktrees', 'detached');
  git(repo, 'worktree', 'add', '-q', '--detach', detached, 'feat/pr');
  git(detached, 'commit', '-q', '--allow-empty', '-m', 'only here');
  dirs.detached = detached;
  // gh reports the detached commit as a merged pull request's head: it still is not automatic, having no branch.
  const merged = new Map([...heads(), ['feat/pr', [...heads().get('feat/pr'), git(detached, 'rev-parse', 'HEAD')]]]);
  const row = rowOf(plan({}, { heads: () => merged }), 'detached');
  assert.deepEqual([row.bucket, row.branch, row.unreachable, row.branch_delete], ['confirm', null, 1, null]);
  assert.deepEqual(row.reasons, ['not merged into origin/main', 'detached HEAD: 1 commit on no branch, lost when it is removed']);
  const onBase = path.join(repo, '.worktrees', 'on-base');
  git(repo, 'worktree', 'add', '-q', '--detach', onBase, 'main');
  dirs.onBase = onBase;
  assert.equal(rowOf(plan(), 'onBase').unreachable, 0, 'a detached HEAD that a branch holds loses nothing');

  const decisions = { [detached]: 'delete' };
  const refused = executeCleanup({ decisions }, { cwd: repo, heads, now: LATER });
  assert.deepEqual(refused.refused, [{ path: detached, reason: 'commits on no branch: needs --force as well as the delete decision' }]);
  assert.equal(existsSync(detached), true);
  const forced = executeCleanup({ decisions, force: true }, { cwd: repo, heads, now: LATER });
  assert.deepEqual(forced.removed.filter((entry) => entry.path === detached), [{ path: detached, branch: null, branch_deleted: false }]);
});

test('cleanup plan writes no object to the repository, and still finds a squash merge', (t) => {
  const { repo, git, plan, rowOf } = fixture(t);
  const objects = () => git(repo, 'count-objects', '-v').split('\n').filter((line) => /^(count|in-pack):/.test(line));
  const before = objects();
  const result = plan();
  assert.deepEqual(objects(), before);
  assert.deepEqual(rowOf(result, 'squash').reasons, ['its changes are in origin/main; no merged pull request confirms it']);
  assert.deepEqual(rowOf(result, 'open').reasons, ['not merged into origin/main']);
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

test('in a repository whose git folder is separate, the main checkout is skipped, though git lists the git folder', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-clean-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const meta = path.join(base, 'meta.git');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', meta, repo]);
  execFileSync('git', ['-C', repo, ...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feat/x', path.join(base, 'x')]);
  const result = planCleanup({}, { cwd: repo, heads: () => new Map(), now: LATER });
  assert.deepEqual(result.skip, [{ bucket: 'skip', path: meta, branch: 'main', reason: 'main checkout' }]);
  assert.deepEqual(result.confirm.map((row) => row.path), [path.join(base, 'x')]);
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
  git(repo, 'config', 'branch.feat/pr.remote', 'origin');
  const result = executeCleanup({ decisions }, { cwd: repo, heads, now: LATER });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.removed.map((row) => [path.basename(row.path), row.branch_deleted]), [['pr', true], ['ff', true], ['squash', false]]);
  assert.match(result.removed[2].branch_error, /not fully merged/, 'git -d keeps a squash-merged branch');
  assert.deepEqual(result.kept, [dirs.open]);
  assert.deepEqual(result.refused, [{ path: dirs.dirty, reason: 'uncommitted changes: needs --force as well as the delete decision' }]);
  assert.equal(existsSync(dirs.pr), false);
  assert.equal(git(repo, 'branch', '--list', 'feat/pr'), '');
  assert.throws(() => git(repo, 'config', '--get', 'branch.feat/pr.remote'), 'its config goes with it, as with git branch -D');

  const forced = executeCleanup({ decisions, force: true }, { cwd: repo, heads, now: LATER });
  assert.deepEqual(forced.removed.map((row) => [path.basename(row.path), row.branch_deleted]), [['dirty', true]]);
  assert.equal(existsSync(dirs.dirty), false);
});

test('a commit or a change that lands after the rows were sorted keeps the worktree and its branch', (t) => {
  const { repo, git, dirs, heads } = fixture(t);
  const inspected = git(dirs.pr, 'rev-parse', 'HEAD');
  // gh answers while each row is sorted, after its HEAD and status were read: another session commits in pr then.
  const racing = () => ({
    get(branch) {
      if (branch === 'feat/pr') git(dirs.pr, 'commit', '-q', '--allow-empty', '-m', 'late');
      if (branch === 'feat/ff') writeFileSync(path.join(dirs.ff, 'new.txt'), 'new\n');
      if (branch === 'feat/squash') writeFileSync(path.join(dirs.squash, '.env'), 'SECRET=1\n');
      return heads().get(branch);
    },
  });
  writeFileSync(path.join(repo, '.git/info/exclude'), '.env\n');
  const result = executeCleanup({ decisions: { [dirs.ff]: 'delete', [dirs.squash]: 'delete' } }, { cwd: repo, heads: racing, now: LATER });
  const late = git(dirs.pr, 'rev-parse', 'HEAD');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.refused, [
    { path: dirs.pr, reason: `changed after it was inspected: HEAD moved from ${inspected} to ${late}; kept with its branch, run cleanup again` },
    { path: dirs.ff, reason: 'changed after it was inspected: uncommitted changes appeared; kept with its branch, run cleanup again' },
    { path: dirs.squash, reason: 'changed after it was inspected: git-ignored files appeared: .env; kept with its branch, run cleanup again' },
  ]);
  assert.deepEqual([existsSync(dirs.pr), existsSync(dirs.ff), git(repo, 'rev-parse', 'feat/pr')], [true, true, late]);
});

test('a commit that lands as git removes the worktree keeps the branch: its delete expects the inspected commit', (t) => {
  const { base, repo, git, dirs } = fixture(t);
  const inspected = git(dirs.pr, 'rev-parse', 'HEAD');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  // gh reports pr merged at the inspected commit; git commits in pr just before it removes that worktree.
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify([{ headRefName: 'feat/pr', headRefOid: inspected }])}'\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `case "$*" in *"worktree remove ${dirs.pr}") "${realGit}" -C "${dirs.pr}" ${IDENTITY.join(' ')} commit -q --allow-empty -m late ;; esac`,
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const executed = spawnSync(CLI, ['worktree', 'cleanup', 'execute', '--min-age', '0'], { cwd: repo, input: '{}', encoding: 'utf8', env });
  assert.equal(executed.status, 0, executed.stderr);
  const row = JSON.parse(executed.stdout).removed.find((entry) => entry.path === dirs.pr);
  assert.deepEqual([row.branch_deleted, existsSync(dirs.pr)], [false, false]);
  assert.match(row.branch_error, new RegExp(inspected));
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'feat/pr'), 'late', 'the late commit is still on its branch');
});

test('a decision matches its row with symlinks resolved, and one that names no worktree is reported', (t) => {
  const { base, repo, dirs, heads } = fixture(t);
  const link = path.join(base, 'link');
  symlinkSync(repo, link);
  const decisions = { [path.join(link, '.worktrees/open')]: 'delete', [path.join(base, 'gone')]: 'delete', [dirs.pr]: 'keep' };
  const result = executeCleanup({ decisions }, { cwd: repo, heads, now: LATER });
  assert.ok(result.removed.some((row) => row.path === dirs.open), JSON.stringify(result));
  assert.equal(existsSync(dirs.open), false);
  assert.deepEqual(result.unmatched, [path.join(base, 'gone')]);
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
