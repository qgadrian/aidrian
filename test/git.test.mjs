import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkoutRoots, currentRoot, gateGit, gitFolders, GIT_TIMEOUT_MS, isIgnored, isRefName, knownPrefix, mainRoot, memoGit, readOriginUrl, readPrefix, readRemoteUrls, REF_NAME_MAX_BYTES, repositoryCheckouts, resetGitStall, runGit, showPrefix, underGit, withGitFacts, withoutGitFacts } from '../plugins/aidrian/lib/git.mjs';

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

test('the gate\'s git, which makes a project run\'s attempt clones, runs no repository hook', (t) => {
  const { dir } = repo(t);
  writeFileSync(path.join(dir, '.git/hooks/post-checkout'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
  assert.equal(gateGit(['checkout', '-q', '-b', 'other'], dir).status, 0);
  assert.equal(existsSync(path.join(dir, 'hook-ran')), false);
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'main'], { stdio: 'pipe' });
  assert.equal(existsSync(path.join(dir, 'hook-ran')), true, 'the hook runs for a git without the hardened settings');
});

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

test('memoGit runs each command once a folder and gives the same result again; other arguments or folders run again', (t) => {
  const { dir, worktree } = repo(t);
  const read = memoGit();
  const head = read(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  assert.equal(head.stdout.trim(), 'main');
  assert.equal(read(['rev-parse', '--abbrev-ref', 'HEAD'], dir), head, 'the first result, not a second run');
  assert.equal(read(['rev-parse', '--abbrev-ref', 'HEAD'], worktree).stdout.trim(), 'task');
  assert.equal(read(['rev-parse', '--show-toplevel'], dir).stdout.trim(), dir);
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

test('repositoryCheckouts lists every checkout but a gone one; [] only outside a repository, else null on failure', (t) => {
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
  // unknown, never empty; outside one there is nothing to list. A git missing from PATH is the same: inside a repository
  // the checkouts are unknown, so a linked worktree the caller does not know of is never taken for no checkout.
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
  assert.equal(answer(dir, empty), null, 'no git inside a repository');
  assert.equal(answer(worktree, empty), null, 'no git inside a linked worktree');
  assert.deepEqual(answer(outside, empty), [], 'no git outside every repository');
  // `link/..`, with the link into the repository, is the repository to the system, though it folds to the folder outside.
  symlinkSync(path.join(dir, 'src'), path.join(outside, 'link'));
  assert.equal(underGit(`${outside}/link/..`), true, 'the folder the system lands in');
  assert.equal(answer(`${outside}/link/..`, bin), null, 'a failed git through a link and `..` into a repository');
  // A spelling the system cannot resolve, kept as text so `..` reaches underGit: it is folded, and its folded folders
  // walked. Through a link out of the repository, the folded folders lie in it, but the link's target does not.
  assert.equal(underGit(`${outside}/gone/..`), false, 'a folder that does not resolve, folded, outside');
  symlinkSync(outside, path.join(dir, 'src', 'out'));
  assert.equal(underGit(`${dir}/src/out/gone/..`), true, 'a folder that does not resolve, folded, not its link\'s target');
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

test('isRefName takes a branch name git takes, in pure JS, and refuses each shape git refuses', () => {
  for (const name of ['main', 'feat/session-prs', 'fix/123-login', 'release-1.2', 'a.b', 'ü-branch', 'x'.repeat(REF_NAME_MAX_BYTES)]) assert.equal(isRefName(name), true, name);
  const refused = [
    '', '@', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb',
    'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b',
    'a..b', 'a@{b', 'a//b',
    '-a', '/a', 'a/', 'a.', 'a.lock', 'a/b.lock/c', 'a/.b', '.a',
    'x'.repeat(REF_NAME_MAX_BYTES + 1), 'é'.repeat(128),
  ];
  for (const name of refused) assert.equal(isRefName(name), false, JSON.stringify(name));
  for (const value of [null, undefined, 12, {}]) assert.equal(isRefName(value), false, String(value));
});

test('isRefName starts no process: its code names no runner', () => {
  assert.doesNotMatch(isRefName.toString(), /runGit|spawn|exec|firstLine/u);
});

// A `git` first on PATH for the rest of the test that logs each call's arguments and runs the real one. `count(arg)` is
// how many calls named `arg` so far.
function loggingGit(t) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-log-')));
  const log = path.join(bin, 'calls.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  t.after(() => {
    process.env.PATH = before;
    rmSync(bin, { recursive: true, force: true });
  });
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { count: (arg) => lines().filter((line) => line.includes(arg)).length };
}

test('outside withGitFacts every read asks git, so a test may change the repository between two reads', (t) => {
  const { dir } = repo(t);
  const git = loggingGit(t);
  assert.equal(readOriginUrl(dir).status, 1);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git']);
  const after = readOriginUrl(dir);
  assert.deepEqual([after.status, after.stdout], [0, 'https://example.com/o/r.git\n']);
  assert.equal(git.count('remote.origin.url'), 2);
});

test('inside withGitFacts a fact is read once per folder, and a read after the scope asks git again', async (t) => {
  const { dir, worktree } = repo(t);
  const git = loggingGit(t);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git']);
  const urls = () => readRemoteUrls(dir).stdout;
  let late = null;
  await withGitFacts(async () => {
    assert.equal(readOriginUrl(dir).stdout, 'https://example.com/o/r.git\n');
    assert.equal(urls(), 'remote.origin.url https://example.com/o/r.git\n');
    assert.deepEqual(checkoutRoots(path.join(dir, 'src')), { main: dir, current: dir });
    assert.equal(knownPrefix(path.join(dir, 'src')), 'src/');
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://example.com/o/moved.git']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readOriginUrl(dir).stdout, 'https://example.com/o/r.git\n', 'the remembered answer');
    assert.equal(urls(), 'remote.origin.url https://example.com/o/r.git\n');
    assert.deepEqual(gitFolders(path.join(dir, 'src')), { common: path.join(dir, '.git'), gitDir: path.join(dir, '.git'), top: dir }, 'the same read as checkoutRoots');
    assert.equal(showPrefix(path.join(dir, 'src')), 'src/');
    assert.equal(readPrefix(path.join(dir, 'src')).stdout, 'src/\n');
    // Another folder is another key.
    assert.equal(checkoutRoots(worktree).current, worktree);
    late = new Promise((resolve) => setTimeout(() => resolve(readOriginUrl(dir).stdout), 20));
  });
  assert.equal(git.count('remote.origin.url'), 1);
  assert.equal(git.count('--get-regexp'), 1);
  assert.equal(git.count('--show-prefix'), 1);
  assert.equal(git.count('--git-common-dir'), 2, 'one for the main checkout\'s folder, one for the worktree');
  assert.equal(readOriginUrl(dir).stdout, 'https://example.com/o/moved.git\n', 'a read after the scope sees the change');
  assert.equal(await late, 'https://example.com/o/moved.git\n', 'so does a timer the scope started, once it has ended');
  assert.equal(git.count('remote.origin.url'), 3);
});

test('inside withGitFacts a folder git cannot answer for is asked again, and a read given an environment always asks', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-later-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = loggingGit(t);
  withGitFacts(() => {
    assert.equal(checkoutRoots(dir), null);
    assert.equal(knownPrefix(dir), null);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    assert.deepEqual(checkoutRoots(dir), { main: dir, current: dir });
    assert.equal(knownPrefix(dir), '');
    for (let i = 0; i < 2; i += 1) assert.equal(readOriginUrl(dir, { env: process.env }).status, 1);
  });
  assert.equal(git.count('--git-common-dir'), 2);
  assert.equal(git.count('--show-prefix'), 2);
  assert.equal(git.count('remote.origin.url'), 2);
});

test('inside withGitFacts a read given an option but a timeout asks git, so its answer never stands in for another read`s', (t) => {
  const { dir } = repo(t);
  const src = path.join(dir, 'src');
  const git = loggingGit(t);
  withGitFacts(() => {
    assert.equal(showPrefix(src), 'src/');
    assert.ok(Buffer.isBuffer(readPrefix(src, { encoding: 'buffer' }).stdout), 'a buffer read after a default read');
  });
  withGitFacts(() => {
    assert.ok(Buffer.isBuffer(readPrefix(src, { encoding: 'buffer' }).stdout));
    assert.equal(showPrefix(src), 'src/', 'a default read after a buffer read');
    assert.equal(knownPrefix(src, { timeout: GIT_TIMEOUT_MS }), 'src/', 'a timeout alone keeps the remembered answer');
    assert.equal(knownPrefix(src, Object.create({ env: process.env })), 'src/', 'an inherited env asks git too');
  });
  assert.equal(git.count('--show-prefix'), 5);
});

test('inside withGitFacts a folder is keyed by where the system lands, so a `..` after a link never takes another folder`s answer', (t) => {
  const { dir } = repo(t);
  const other = repo(t).dir;
  // `<dir>/link/..` reads as `<dir>` by its text, but the system follows the link first and lands in `<other>`.
  symlinkSync(path.join(other, 'src'), path.join(dir, 'link'));
  const through = `${dir}${path.sep}link${path.sep}..`;
  withGitFacts(() => {
    assert.deepEqual(checkoutRoots(dir), { main: dir, current: dir });
    assert.deepEqual(checkoutRoots(through), { main: other, current: other }, 'the folder git ran in, never the text\'s');
  });
});

test('a nested withGitFacts shares the open scope, and two scopes in a row share nothing', async (t) => {
  const { dir } = repo(t);
  const git = loggingGit(t);
  const answer = withGitFacts(() => {
    readPrefix(dir);
    return withGitFacts(() => readPrefix(dir).status);
  });
  assert.equal(answer, 0, 'the body\'s value comes back');
  assert.equal(git.count('--show-prefix'), 1);
  await withGitFacts(async () => readPrefix(dir));
  await withGitFacts(async () => readPrefix(dir));
  assert.equal(git.count('--show-prefix'), 3);
  assert.throws(() => withGitFacts(() => {
    readPrefix(dir);
    throw new Error('boom');
  }), /boom/u);
  readPrefix(dir);
  assert.equal(git.count('--show-prefix'), 5, 'a scope that throws is closed too');
});

test('a remembered checkout read in an attempt clone answers null once the clone\'s own config sets a program key', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-clone-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const attempt = path.join(base, 'runs/r1/attempts/1.1');
  const work = path.join(attempt, 'work');
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', '../git'], { cwd: work });
  withGitFacts(() => {
    assert.deepEqual(gitFolders(work), { common: path.join(attempt, 'git'), gitDir: path.join(attempt, 'git'), top: work });
    execFileSync('git', ['--git-dir', path.join(attempt, 'git'), 'config', 'core.sshCommand', 'touch ran']);
    assert.equal(gitFolders(work), null);
    assert.equal(checkoutRoots(work), null);
    assert.equal(knownPrefix(work), null);
  });
});

test('inside withGitFacts a stopped git answers before a remembered fact', (t) => {
  const { dir } = repo(t);
  t.after(resetGitStall);
  withGitFacts(() => {
    assert.equal(knownPrefix(path.join(dir, 'src')), 'src/');
    const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-hang-')));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      assert.equal(runGit(['status'], dir).error?.code, 'ETIMEDOUT');
    } finally {
      process.env.PATH = before;
    }
    assert.equal(readPrefix(path.join(dir, 'src')).status, null, 'the stopped call, not the remembered prefix');
    assert.equal(knownPrefix(path.join(dir, 'src')), null);
  });
});

test('an async withGitFacts body that rejects closes the scope', async (t) => {
  const { dir } = repo(t);
  const git = loggingGit(t);
  await assert.rejects(withGitFacts(async () => {
    readPrefix(dir);
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error('boom');
  }), /boom/u);
  readPrefix(dir);
  assert.equal(git.count('--show-prefix'), 2);
});

test('inside withGitFacts a repository with no origin is asked for it once, with its roots read once to know it is one', (t) => {
  const { dir } = repo(t);
  const git = loggingGit(t);
  withGitFacts(() => {
    for (let i = 0; i < 2; i += 1) assert.equal(readOriginUrl(dir).status, 1);
    for (let i = 0; i < 2; i += 1) assert.equal(readRemoteUrls(dir).status, 1);
    assert.deepEqual(checkoutRoots(dir), { main: dir, current: dir });
  });
  assert.equal(git.count('remote.origin.url'), 1);
  assert.equal(git.count('--get-regexp'), 1);
  assert.equal(git.count('--git-common-dir'), 1);
});

test('inside withGitFacts an origin read before `git init` is asked again after it and `git remote add`', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-later-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withGitFacts(() => {
    assert.equal(checkoutRoots(dir), null);
    assert.equal(readOriginUrl(dir).status, 1, 'outside a repository the config read exits 1 too');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git']);
    const after = readOriginUrl(dir);
    assert.deepEqual([after.status, after.stdout], [0, 'https://example.com/o/r.git\n']);
  });
});

test('withoutGitFacts asks git inside it, and the open scope asks again after it', async (t) => {
  const { dir } = repo(t);
  const git = loggingGit(t);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git']);
  const origin = () => readOriginUrl(dir).stdout;
  await withGitFacts(async () => {
    assert.equal(origin(), 'https://example.com/o/r.git\n');
    const during = await withoutGitFacts(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://example.com/o/moved.git']);
      return [origin(), origin()];
    });
    assert.deepEqual(during, ['https://example.com/o/moved.git\n', 'https://example.com/o/moved.git\n'], 'each read in the wait asks git');
    assert.equal(origin(), 'https://example.com/o/moved.git\n', 'a read after the wait is fresh');
    assert.equal(origin(), 'https://example.com/o/moved.git\n');
  });
  assert.equal(git.count('remote.origin.url'), 4, 'one before the wait, two in it, one after');
  assert.equal(withoutGitFacts(() => readPrefix(dir).status), 0, 'with no scope open it runs the body as it is');
});
