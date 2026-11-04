import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

const run = (args, cwd = EXAMPLE, env = process.env) => spawnSync(CLI, args, { cwd, encoding: 'utf8', env });

test('check prints ok in the example consumer, from a subfolder, and with --project', () => {
  for (const [args, cwd] of [[['check']], [['check'], path.join(EXAMPLE, 'src')], [['check', '--project', EXAMPLE], ROOT]]) {
    const { status, stdout, stderr } = run(args, cwd);
    assert.deepEqual([status, stderr], [0, ''], args.join(' '));
    assert.match(stdout, /^ok: \.aidrian \(2 buckets, 8 docs\)\nstate: \/\S+\nbudget: \d+ of 16384 always-doc bytes \(engineering \d+, product 0\)\n$/, args.join(' '));
  }
});

test('check fails with every error, and names the folder it started from when there is no project', (t) => {
  // realpath: on macOS the temp folder is behind a symlink, and the command prints the real path.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const none = run(['check'], dir);
  assert.equal(none.status, 1);
  assert.equal(none.stderr, `no project folder at or above ${dir}; run aidrian init\n`);

  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, extra: 1, pr: { reviewer: 'x' }, github: { maxReviewRounds: 'ten' }, telemetry: { max_mb: 5 } }));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  const bad = run(['check'], dir);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(
    bad.stderr,
    '.aidrian/config.json: unknown key "extra"\n.aidrian/config.json: "pr" is now "github": rename the key\n' +
      '.aidrian/config.json: "github.maxReviewRounds" must be a whole number above 0\n' +
      '.aidrian/config.json: "telemetry.max_mb" is now "telemetry.maxMb": rename the key\n',
  );
});

test('in a worktree made before the project folder was committed, both commands say so instead of asking for init', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'trunk');
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const tree = path.join(dir, '.worktrees/old');
  git('worktree', 'add', '-q', '-b', 'old', tree);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { defaultBranch: 'trunk' } }));
  mkdirSync(path.join(tree, 'src'));

  const expected = (from) => `no project folder at or above ${from}: this worktree was created before .aidrian/ was committed and pushed; recreate it or merge trunk\n`;
  for (const from of [tree, path.join(tree, 'src')]) {
    assert.deepEqual([run(['check'], from).status, run(['check'], from).stderr], [1, expected(from)], from);
  }
  const knowledge = spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge'), ['tags'], { cwd: tree, encoding: 'utf8' });
  assert.deepEqual([knowledge.status, knowledge.stderr], [1, expected(tree)]);
  assert.doesNotMatch(run(['check'], dir).stderr, /no project folder/, 'the main checkout has the project');
});

test('--help, -h, and help print the usage on stdout and exit 0, for both commands', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const { status, stdout, stderr } = run([flag]);
    assert.deepEqual([status, stderr], [0, ''], flag);
    assert.match(stdout, /^usage: aidrian <command> \[args\]\n\n {2}aidrian check \[--project DIR\]\n/, flag);
    assert.doesNotMatch(stdout, /unknown command/);
    const knowledge = spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge'), [flag], { cwd: EXAMPLE, encoding: 'utf8' });
    assert.deepEqual([knowledge.status, knowledge.stderr], [0, ''], flag);
    assert.match(knowledge.stdout, /^usage: aidrian-knowledge <command> \[--project DIR\] \[args\]\n/, flag);
  }
});

test('the usage fits 100 columns, with one line for each form of a command and its wrapped parts indented under it', () => {
  const { stdout } = run(['--help']);
  const lines = stdout.trimEnd().split('\n');
  assert.deepEqual(lines.filter((line) => line.length > 100), []);
  assert.deepEqual(lines.filter((line) => line.startsWith('  aidrian lesson ')).map((line) => line.split(' ')[4]), ['add', 'list', 'resolve', 'update', 'stats', 'nudge', 'migrate']);
  assert.deepEqual(lines.filter((line) => line.startsWith('  aidrian worktree ')).map((line) => line.split(' ')[4]), ['new', 'cleanup']);
  assert.ok(lines.includes('  aidrian commit-msg (--file PATH | --message TEXT) [--project DIR]'), 'a choice in parentheses is one form');
  assert.ok(lines.includes('  aidrian pre-commit [--project DIR]'));
  const lesson = lines.findIndex((line) => line.startsWith('  aidrian lesson add '));
  assert.match(lines[lesson + 1], /^ {10}\[/, 'a wrapped usage line sits deeper than the description');
  const misuse = spawnSync(CLI, ['worktree', 'bogus'], { cwd: EXAMPLE, encoding: 'utf8' });
  assert.deepEqual(misuse.stderr.split('\n').slice(0, 2), [
    'usage: aidrian worktree new BRANCH [--base REF] [--slug NAME] [--fetch] [--plan] [--reuse-existing]',
    '       aidrian worktree cleanup [plan|execute] [--only PATH] [--min-age 24h] [--force]',
  ]);
});

test('a missing or unknown command, an unknown option, or a stray argument prints the usage and exits 1', () => {
  const cases = [
    [[], null],
    [['nope'], /\n\nunknown command: nope\n$/],
    [['config', 'check'], /\n\nunknown command: config\n$/],
    [['check', '--bogus'], /\n\nUnknown option '--bogus'/],
    [['check', '--project'], /\n\nOption '--project <value>' argument missing/],
    [['init', 'stray'], /\n\nUnexpected argument 'stray'/],
  ];
  for (const [args, expected] of cases) {
    const { status, stdout, stderr } = run(args);
    assert.equal(status, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^usage: aidrian <command> \[args\]\n\n {2}aidrian check \[--project DIR\]\n(?: {6}.*\n)+ {2}aidrian init \[--project DIR\]\n(?: {6}.*\n)+ {2}aidrian state \[--project DIR\]\n/);
    if (expected) assert.match(stderr, expected, args.join(' '));
  }
});

// A git repository on `main` with `decisions` committed in config.json, and `git` run in it.
function decisionsRepo(t, decisions) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const out = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const write = (value) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: value }));
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  write(decisions);
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  return { dir, git, write };
}

const pick = ({ authority, rule, base }) => [authority, rule, base];

// An environment whose `git` runs `script` first, then the real git, unless the script exits.
const fake = (t, script) => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${script}\nexec ${real} "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
};

const resolveCopy = (dir, ...more) => {
  const { status, stdout, stderr } = run(['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no', ...more], dir);
  assert.deepEqual([status, stderr], [0, '']);
  return JSON.parse(stdout);
};

test('decisions resolve says ask with the matched rule, for a floor class, an unknown class, and any yes or missing answer', (t) => {
  const { dir } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  const resolve = (...args) => {
    const { status, stdout, stderr } = run(['decisions', 'resolve', ...args], dir);
    assert.deepEqual([status, stderr], [0, ''], args.join(' '));
    return JSON.parse(stdout);
  };
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).rule], ['decide', 'mode']);
  assert.equal(resolve('--domain', 'ux', '--class', 'money', '--reversible', 'no,no,no,no').rule, 'floor-class');
  assert.equal(resolve('--domain', 'ux', '--class', 'pricing', '--reversible', 'no,no,no,no').rule, 'unknown-class');
  for (const answers of ['yes,no,no,no', 'no,no,no,yes', 'no,no,no', 'no']) {
    assert.deepEqual([resolve('--domain', 'ux', '--class', 'copy', '--reversible', answers).authority, resolve('--domain', 'ux', '--class', 'copy', '--reversible', answers).rule], ['ask', 'reversibility'], answers);
  }
  assert.equal(resolve('--domain', 'ux', '--class', 'copy').rule, 'reversibility', 'no answers at all');
});

test('decisions resolve prints the base branch\'s secondLook, so a working-copy edit cannot change it', (t) => {
  const look = { agent: 'critic', minSeverity: 'low' };
  const { dir, git, write } = decisionsRepo(t, { secondLook: look });
  assert.deepEqual(resolveCopy(dir).secondLook, look, 'the committed block');
  git('switch', '-q', '-c', 'feature');
  write({ secondLook: null });
  assert.deepEqual(resolveCopy(dir).secondLook, look, 'an uncommitted edit');
  git('commit', '-q', '-am', 'turn it off');
  assert.deepEqual(resolveCopy(dir).secondLook, look, 'a commit on the branch');
  git('switch', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  assert.equal(resolveCopy(dir).secondLook, null, 'once the base branch has it');
});

test('decisions resolve reads the base branch, so a branch cannot raise its own authority', (t) => {
  const { dir, git, write } = decisionsRepo(t, { mode: 'ask' });
  const main = git('rev-parse', 'main');
  git('switch', '-q', '-c', 'feature');
  write({ maxMode: 'decide-reversible', mode: 'decide-reversible' });
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).base], ['ask', main], 'an uncommitted edit');
  git('commit', '-q', '-am', 'raise');
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).base], ['ask', main], 'a commit on the branch');

  git('switch', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  git('switch', '-q', 'feature');
  assert.equal(resolveCopy(dir).authority, 'decide', 'once the base branch has it');
});

test('decisions resolve prefers origin/HEAD, which the working copy cannot move, over the default branch config.json names', (t) => {
  const { dir, git } = decisionsRepo(t, { mode: 'ask' });
  const main = git('rev-parse', 'main');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { defaultBranch: 'feature' }, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
  git('commit', '-q', '-am', 'point the default branch at this one');
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).base], ['ask', main]);
});

test('decisions resolve holds the local file to the base branch ceiling, and an out-of-git project reads its working copy', (t) => {
  const { dir, git, write } = decisionsRepo(t, { mode: 'ask', maxMode: 'ask' });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  git('switch', '-q', '-c', 'feature');
  assert.equal(resolveCopy(dir).authority, 'ask', 'the base maxMode holds the local mode down');
  write({ mode: 'ask', maxMode: 'decide-reversible' });
  assert.equal(resolveCopy(dir).authority, 'ask', 'a working-copy maxMode does not lift the ceiling');
  git('switch', '-q', '-f', 'main');
  write({ mode: 'ask', maxMode: 'decide-reversible' });
  git('commit', '-q', '-am', 'allow');
  assert.equal(resolveCopy(dir).authority, 'decide', 'the base allows it, and the local file sets it');

  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  mkdirSync(path.join(plain, '.aidrian'));
  writeFileSync(path.join(plain, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
  assert.deepEqual([resolveCopy(plain).authority, resolveCopy(plain).base], ['decide', null]);
});

test('decisions resolve never takes its base from a branch that names itself in git.defaultBranch', (t) => {
  const repoAt = (origin) => {
    const repo = decisionsRepo(t, { mode: 'ask' });
    const main = repo.git('rev-parse', 'main');
    if (origin) repo.git('update-ref', 'refs/remotes/origin/main', main);
    repo.git('switch', '-q', '-c', 'feature');
    writeFileSync(path.join(repo.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { defaultBranch: 'feature' }, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
    repo.git('commit', '-q', '-am', 'name this branch the default');
    repo.git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
    return { ...repo, main };
  };
  const withOrigin = repoAt(true);
  assert.deepEqual([resolveCopy(withOrigin.dir).authority, resolveCopy(withOrigin.dir).base], ['ask', withOrigin.main], 'origin/main, with no origin/HEAD');
  const without = repoAt(false);
  assert.deepEqual([resolveCopy(without.dir).authority, resolveCopy(without.dir).base], ['ask', without.main], 'the local main, with no origin/main');
  without.git('branch', '-q', '-D', 'main');
  assert.deepEqual(pick(resolveCopy(without.dir)), ['ask', 'no-base', null], 'no main at all: nothing the working copy names is a base');
});

test('decisions resolve falls back to origin/main, ahead of a local main, with no origin/HEAD', (t) => {
  const { dir, git, write } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  const pushed = git('rev-parse', 'main');
  git('update-ref', 'refs/remotes/origin/main', pushed);
  write({ mode: 'ask' });
  git('commit', '-q', '-am', 'a local main the remote does not have');
  git('switch', '-q', '-c', 'feature');
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).base], ['decide', pushed]);
  git('branch', '-q', '-D', 'main');
  assert.deepEqual([resolveCopy(dir).authority, resolveCopy(dir).base], ['decide', pushed], 'with no local main at all');
});

test('decisions resolve takes a local main only with no remote at all: a remote of another name gives no-base', (t) => {
  const { dir, git } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  const main = git('rev-parse', 'main');
  assert.deepEqual(pick(resolveCopy(dir)), ['decide', 'mode', main], 'no remote: the local main is the only record of the base');
  git('remote', 'add', 'upstream', 'https://example.com/upstream.git');
  git('update-ref', 'refs/remotes/upstream/main', main);
  assert.deepEqual(pick(resolveCopy(dir)), ['ask', 'no-base', null], 'only upstream: its main is not a name this command reads, and the local main does not stand in');
  git('remote', 'add', 'origin', 'https://example.com/origin.git');
  assert.deepEqual(pick(resolveCopy(dir)), ['ask', 'no-base', null], 'an origin with no fetched refs names no base yet');
  git('update-ref', 'refs/remotes/origin/main', main);
  assert.deepEqual(pick(resolveCopy(dir)), ['decide', 'mode', main], 'origin added and fetched, one remedy config.md names');

  const renamed = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  renamed.git('remote', 'add', 'upstream', 'https://example.com/upstream.git');
  renamed.git('update-ref', 'refs/remotes/upstream/main', 'main');
  assert.equal(resolveCopy(renamed.dir).rule, 'no-base');
  renamed.git('remote', 'rename', 'upstream', 'origin');
  assert.equal(resolveCopy(renamed.dir).authority, 'decide', 'upstream renamed to origin, the other remedy config.md names');
});

test('inside git with no base, or a git that fails or stalls, resolve asks and never reads the working copy', (t) => {
  const { dir, git, write } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  git('branch', '-q', '-m', 'main', 'trunk');
  write({ maxMode: 'decide-reversible', mode: 'decide-reversible' });
  assert.deepEqual(pick(resolveCopy(dir)), ['ask', 'no-base', null], 'no base branch');

  git('branch', '-q', '-m', 'trunk', 'main');
  assert.equal(resolveCopy(dir).authority, 'decide', 'the base is back');
  const resolved = (env) => {
    const { status, stdout, stderr } = run(['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no'], dir, env);
    assert.deepEqual([status, stderr], [0, '']);
    return JSON.parse(stdout);
  };
  assert.deepEqual(pick(resolved(fake(t, 'exit 3'))), ['ask', 'no-base', null], 'git fails on everything');
  assert.deepEqual(pick(resolved(fake(t, 'case " $* " in *" --verify "*) exit 3;; esac'))), ['ask', 'no-base', null], 'git fails on the base ref');
  assert.deepEqual(pick(resolved(fake(t, 'case " $* " in *" --verify "*) exec sleep 30;; esac'))), ['ask', 'no-base', null], 'git stalls on the base ref');
  assert.deepEqual(pick(resolved(fake(t, 'case " $* " in *" remote "*) exit 3;; esac'))), ['ask', 'no-base', null], 'git fails listing the remotes: the local main does not stand in');
  const failedShow = resolved(fake(t, 'case " $* " in *" show "*) exit 3;; esac'));
  assert.deepEqual([failedShow.authority, failedShow.rule], ['ask', 'no-base'], 'git fails reading the base config');
});

test('decisions resolve takes the config folder from the base commit, and a base with no team block holds every decision at ask', (t) => {
  const raise = (dir) => writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  const route = decisionsRepo(t, { mode: 'ask', maxMode: 'ask' });
  raise(route.dir);
  // The base holds a raising config in a folder no one reads, so reading it would decide.
  mkdirSync(path.join(route.dir, 'other'));
  writeFileSync(path.join(route.dir, 'other/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
  route.git('add', 'other');
  route.git('commit', '-q', '-m', 'a folder the project does not name');
  route.git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(route.dir, '.aidrian.json'), JSON.stringify({ dir: 'other' }));
  assert.equal(resolveCopy(route.dir).authority, 'ask', 'an uncommitted {"dir":"other"} does not move the lookup off the team maxMode');
  route.git('add', '.aidrian.json');
  route.git('commit', '-q', '-m', 'move the folder on the branch');
  assert.equal(resolveCopy(route.dir).authority, 'ask', 'nor does the same move committed on the branch');

  const moved = decisionsRepo(t, {});
  mkdirSync(path.join(moved.dir, 'team'));
  writeFileSync(path.join(moved.dir, 'team/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
  writeFileSync(path.join(moved.dir, '.aidrian.json'), JSON.stringify({ dir: 'team' }));
  moved.git('add', '.');
  moved.git('commit', '-q', '-m', 'the team moved its folder');
  moved.git('switch', '-q', '-c', 'feature');
  assert.equal(resolveCopy(moved.dir).authority, 'decide', 'the folder the base names is read');

  const atBase = (text, override) => {
    const repo = decisionsRepo(t, {});
    if (text === null) repo.git('rm', '-q', '--cached', '.aidrian/config.json');
    else writeFileSync(path.join(repo.dir, '.aidrian/config.json'), text);
    if (override !== undefined) writeFileSync(path.join(repo.dir, '.aidrian.json'), override);
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'the base');
    repo.git('switch', '-q', '-c', 'feature');
    rmSync(path.join(repo.dir, '.aidrian.json'), { force: true });
    repo.write({ maxMode: 'decide-reversible', mode: 'decide-reversible' });
    raise(repo.dir);
    return resolveCopy(repo.dir).authority;
  };
  assert.equal(atBase('{ not json'), 'ask', 'a base config that does not parse');
  assert.equal(atBase(JSON.stringify({ version: 99, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } })), 'ask', 'a base config of another version');
  const optedIn = JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible' } });
  assert.equal(atBase(optedIn, '{ not json'), 'ask', 'a base .aidrian.json that does not parse');
  assert.equal(atBase(optedIn, JSON.stringify({ dir: '../up' })), 'ask', 'a base .aidrian.json that names no usable folder');
  assert.equal(atBase(optedIn, JSON.stringify({ dir: 'nowhere' })), 'ask', 'a base .aidrian.json whose folder has no config');
  assert.equal(atBase(JSON.stringify({ version: 1 })), 'ask', 'a valid base with no decisions key has not opted in, so the local file raises nothing');
  assert.equal(atBase(optedIn), 'decide', 'a committed ceiling honours the local raise');

  const empty = decisionsRepo(t, {});
  empty.git('rm', '-q', '-r', '--cached', '.aidrian');
  empty.git('commit', '-q', '--allow-empty', '-m', 'no config at the base');
  empty.git('switch', '-q', '-c', 'feature');
  raise(empty.dir);
  assert.equal(resolveCopy(empty.dir).authority, 'ask', 'a base with no config.json');
});

test('decisions resolve reads the local file from the main checkout in a linked worktree, held to the base ceiling', (t) => {
  const open = decisionsRepo(t, { maxMode: 'decide-reversible' });
  writeFileSync(path.join(open.dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  const tree = path.join(open.dir, '.worktrees/wt');
  open.git('worktree', 'add', '-q', '-b', 'wt', tree);
  assert.equal(resolveCopy(open.dir).authority, 'decide', 'in the main checkout');
  assert.equal(resolveCopy(tree).authority, 'decide', 'the worktree has no copy of the file, and reads the main checkout\'s');

  const capped = decisionsRepo(t, { maxMode: 'ask' });
  writeFileSync(path.join(capped.dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  const held = path.join(capped.dir, '.worktrees/wt');
  capped.git('worktree', 'add', '-q', '-b', 'wt', held);
  assert.equal(resolveCopy(held).authority, 'ask');

  const only = decisionsRepo(t, { maxMode: 'decide-reversible' });
  const own = path.join(only.dir, '.worktrees/wt');
  only.git('worktree', 'add', '-q', '-b', 'wt', own);
  writeFileSync(path.join(own, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  assert.equal(resolveCopy(own).authority, 'ask', 'a file only in the worktree raises nothing');
  writeFileSync(path.join(only.dir, '.aidrian.local.json'), JSON.stringify({ decisions: { domains: { ux: 'ask' } } }));
  assert.equal(resolveCopy(own).authority, 'ask', 'with both, the main checkout\'s decisions apply, not the worktree\'s');
  writeFileSync(path.join(only.dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
  rmSync(path.join(own, '.aidrian.local.json'));
  assert.equal(resolveCopy(own).authority, 'decide', 'the main checkout\'s file still applies in the worktree');
});

test('decisions resolve treats every spelling of a --doc as the same path from the project root', (t) => {
  const { dir, git } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs: ['docs/pricing.md', 'docs/terms.md#refunds'] });
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs/pricing.md'), '# Pricing\n');
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  git('switch', '-q', '-c', 'feature');
  const rule = (cwd, ...docs) => {
    const out = resolveCopy(cwd, ...docs.flatMap((doc) => ['--doc', doc]));
    return [out.authority, out.rule];
  };
  const src = path.join(dir, 'src');
  const asked = ['ask', 'escalate-doc'];
  assert.deepEqual(rule(dir, 'docs/pricing.md'), asked);
  assert.deepEqual(rule(dir, './docs/pricing.md'), asked, './');
  assert.deepEqual(rule(dir, path.join(dir, 'docs/pricing.md')), asked, 'absolute');
  assert.deepEqual(rule(src, '../docs/pricing.md'), asked, '../ from a subfolder');
  assert.deepEqual(rule(dir, 'docs//pricing.md'), asked, '//');
  assert.deepEqual(rule(dir, 'docs/./pricing.md'), asked, '/./');
  assert.deepEqual(rule(dir, 'docs/x/../pricing.md'), asked, 'x/../');
  assert.deepEqual(rule(dir, `${dir}/docs/terms.md#refunds`), asked, 'absolute, keeping its section');
  assert.deepEqual(rule(dir, 'docs/terms.md'), asked, 'no section names the listed one too');
  assert.deepEqual(rule(dir, 'docs/terms.md#other'), ['decide', 'mode'], 'another section');
  assert.deepEqual(rule(dir, 'docs/guide.md'), ['decide', 'mode'], 'another doc');
  const away = ['ask', 'doc-outside-project'];
  assert.deepEqual(rule(dir, '../elsewhere.md'), away, '../ out of the project');
  assert.deepEqual(rule(dir, path.join(outside, 'a.md')), away, 'an absolute path elsewhere');
  assert.deepEqual(rule(src, '../../elsewhere.md#x'), away, '../../ from a subfolder, with a section');
  assert.deepEqual(rule(outside, 'docs/pricing.md').slice(0, 1), ['ask'], 'run from elsewhere with no project, no rule covers it');
});

test('a bad decisions value at the base holds every decision at ask, on a clean branch, though the local file raises the mode', (t) => {
  const cases = [
    ['maxMode', { mode: 'decide-reversible', maxMode: 'bogus' }],
    ['mode', { maxMode: 'decide-reversible', mode: 'bogus' }],
    ['escalate', { maxMode: 'decide-reversible', mode: 'decide-reversible', escalate: ['pricing'] }],
    ['escalateDocs', { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs: ['docs/*.md'] }],
    ['an unknown key', { maxMode: 'decide-reversible', mode: 'decide-reversible', other: 1 }],
    ['a block that is no object', 'decide-reversible'],
  ];
  for (const [name, decisions] of cases) {
    const { dir, git, write } = decisionsRepo(t, decisions);
    git('switch', '-q', '-c', 'feature');
    write({ maxMode: 'decide-reversible', mode: 'decide-reversible' });
    git('commit', '-q', '-am', 'a clean working copy');
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ decisions: { mode: 'decide-reversible' } }));
    assert.equal(resolveCopy(dir).authority, 'ask', name);
  }
  const { dir, git, write } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  git('switch', '-q', '-c', 'feature');
  write({ maxMode: 'decide-reversible', mode: 'decide-reversible' });
  assert.equal(resolveCopy(dir).authority, 'decide', 'a clean base still decides');
  const elsewhere = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible' });
  writeFileSync(path.join(elsewhere.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' }, github: { maxReviewRounds: 'ten' } }));
  elsewhere.git('commit', '-q', '-am', 'a bad value in another group');
  elsewhere.git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(elsewhere.dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  assert.equal(resolveCopy(elsewhere.dir).authority, 'decide', 'an error outside decisions leaves the block as written');
});

test('decisions resolve reads a relative --doc from the current folder and from the project root', (t) => {
  const { dir } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs: ['docs/pricing.md', 'src/notes.md'] });
  mkdirSync(path.join(dir, 'src'));
  const src = path.join(dir, 'src');
  const rule = (cwd, doc) => {
    const out = resolveCopy(cwd, '--doc', doc);
    return [out.authority, out.rule];
  };
  assert.deepEqual(rule(src, 'docs/pricing.md'), ['ask', 'escalate-doc'], 'the root reading matches, from below the root');
  assert.deepEqual(rule(src, 'notes.md'), ['ask', 'escalate-doc'], 'the current-folder reading matches');
  assert.deepEqual(rule(src, 'docs/guide.md'), ['decide', 'mode'], 'neither reading matches');
  assert.deepEqual(rule(src, '../docs/pricing.md'), ['ask', 'escalate-doc'], 'a path that climbs has its current-folder reading');
  assert.deepEqual(rule(src, '../docs/guide.md'), ['decide', 'mode'], 'and no root reading, which would leave the project');
  assert.deepEqual(rule(src, 'x/../docs/pricing.md'), ['ask', 'escalate-doc'], 'the root reading of a spelled path');
});

test('decisions resolve matches a symlinked escalateDocs file or folder, named by the link or by its target, in the entry or the --doc', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'away.md'), '# Away\n');
  const asked = ['ask', 'escalate-doc'];
  const decide = ['decide', 'mode'];
  const repoWith = (escalateDocs) => {
    const { dir, git } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs });
    mkdirSync(path.join(dir, 'docs/real-legal'), { recursive: true });
    for (const file of ['target.md', 'guide.md', 'real-legal/a.md']) writeFileSync(path.join(dir, 'docs', file), '# Doc\n');
    symlinkSync('target.md', path.join(dir, 'docs/link.md'));
    symlinkSync('real-legal', path.join(dir, 'docs/legal'));
    symlinkSync(path.join(outside, 'away.md'), path.join(dir, 'docs/away.md'));
    git('add', 'docs');
    git('commit', '-q', '-m', 'docs');
    return dir;
  };
  const rule = (dir, doc) => {
    const out = resolveCopy(dir, '--doc', doc);
    return [out.authority, out.rule];
  };

  const byLink = repoWith(['docs/link.md', 'docs/legal/']);
  assert.deepEqual(rule(byLink, 'docs/link.md'), asked, 'file: entry and doc name the link');
  assert.deepEqual(rule(byLink, 'docs/target.md'), asked, 'file: the entry names the link, the doc its target');
  assert.deepEqual(rule(byLink, 'docs/legal/a.md'), asked, 'folder: entry and doc name the link');
  assert.deepEqual(rule(byLink, 'docs/real-legal/a.md'), asked, 'folder: the entry names the link, the doc its target');
  assert.deepEqual(rule(byLink, 'docs/guide.md'), decide, 'a doc neither reaches');

  const byTarget = repoWith(['docs/target.md', 'docs/real-legal/']);
  assert.deepEqual(rule(byTarget, 'docs/link.md'), asked, 'file: the entry names the target, the doc the link');
  assert.deepEqual(rule(byTarget, 'docs/target.md'), asked, 'file: entry and doc name the target');
  assert.deepEqual(rule(byTarget, 'docs/legal/a.md'), asked, 'folder: the entry names the target, the doc the link');
  assert.deepEqual(rule(byTarget, 'docs/real-legal/a.md'), asked, 'folder: entry and doc name the target');

  const section = repoWith(['docs/link.md#refunds']);
  assert.deepEqual(rule(section, 'docs/target.md#refunds'), asked, 'a resolved entry keeps its section');
  assert.deepEqual(rule(section, 'docs/link.md#refunds'), asked);
  assert.deepEqual(rule(section, 'docs/target.md#other'), decide, 'another section of the target');
  assert.deepEqual(rule(section, 'docs/link.md#other'), decide, 'another section of the link');

  assert.deepEqual(rule(byLink, 'docs/away.md'), ['ask', 'doc-outside-project'], 'a link out of the project: its resolved reading decides, not the path as written');
  const alias = path.join(outside, 'alias');
  symlinkSync(byLink, alias);
  assert.deepEqual(rule(byLink, path.join(alias, 'docs/link.md')), asked, 'an absolute path through a link to the project keeps the link inside it');
  assert.deepEqual(rule(byLink, path.join(alias, 'docs/guide.md')), decide, 'and is not outside the project');

  const toRoot = repoWith(['docs/whole']);
  symlinkSync('..', path.join(toRoot, 'docs/whole'));
  assert.deepEqual(rule(toRoot, 'docs/guide.md'), asked, 'an entry that links to the project root covers every doc');

  // A doc the entry covers, swapped in the working copy for a link to one it does not: the target alone would decide.
  const swap = (dir, file) => {
    rmSync(path.join(dir, file));
    symlinkSync('../guide.md', path.join(dir, file));
  };
  const real = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs: ['docs/legal/'] });
  mkdirSync(path.join(real.dir, 'docs/legal'), { recursive: true });
  writeFileSync(path.join(real.dir, 'docs/guide.md'), '# Guide\n');
  writeFileSync(path.join(real.dir, 'docs/legal/a.md'), '# A\n');
  real.git('add', 'docs');
  real.git('commit', '-q', '-m', 'docs');
  swap(real.dir, 'docs/legal/a.md');
  assert.deepEqual(rule(real.dir, 'docs/legal/a.md'), asked, 'swapped doc, by relative path: the path as written');
  const realAlias = path.join(outside, 'real-alias');
  symlinkSync(real.dir, realAlias);
  assert.deepEqual(rule(real.dir, path.join(realAlias, 'docs/legal/a.md')), asked, 'swapped doc, by an absolute path through a link to the project: the root in any spelling');
  const linkedFolder = repoWith(['docs/legal/']);
  swap(linkedFolder, 'docs/real-legal/a.md');
  assert.deepEqual(rule(linkedFolder, 'docs/legal/a.md'), asked, 'swapped doc in a folder that is itself a link: the entry as written');
});

test('decisions resolve compares a doc\'s path in any case, so another case of a listed doc asks on every disk', (t) => {
  const { dir } = decisionsRepo(t, { maxMode: 'decide-reversible', mode: 'decide-reversible', escalateDocs: ['docs/pricing.md', 'docs/Later.md', 'docs/Legal/'] });
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs/pricing.md'), '# Pricing\n');
  for (const doc of ['DOCS/PRICING.md', 'docs/Pricing.md#Plans', 'DOCS/new/../pricing.md']) {
    assert.equal(resolveCopy(dir, '--doc', doc).authority, 'ask', doc);
  }
  assert.equal(resolveCopy(dir, '--doc', 'docs/pricing.md').authority, 'ask');
  // No file on disk here, so no disk supplies a spelling: the comparison alone has to catch these.
  for (const doc of ['docs/later.md', 'docs/LATER.md', 'docs/legal/a.md', 'DOCS/LEGAL/b.md']) {
    assert.deepEqual(pick(resolveCopy(dir, '--doc', doc)).slice(0, 2), ['ask', 'escalate-doc'], `${doc}: docs that differ only by case both ask`);
  }
  assert.equal(resolveCopy(dir, '--doc', 'docs/not-yet.md').authority, 'decide', 'a doc that does not exist yet still resolves');
});

test('in a clone, a local main never stands in for origin: no origin ref gives no-base', (t) => {
  const source = decisionsRepo(t, { mode: 'ask' });
  const dest = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['clone', '-q', source.dir, dest], { encoding: 'utf8' }).status, 0);
  const git = (...args) => {
    const out = spawnSync('git', ['-C', dest, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const pushed = git('rev-parse', 'origin/main');
  writeFileSync(path.join(dest, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { maxMode: 'decide-reversible', mode: 'decide-reversible' } }));
  git('commit', '-q', '-am', 'a local main no one reviewed');
  assert.deepEqual(pick(resolveCopy(dest)).slice(0, 1).concat(resolveCopy(dest).base), ['ask', pushed], 'origin/HEAD is the base');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  assert.deepEqual(pick(resolveCopy(dest)), ['ask', 'no-base', null], 'the local main does not stand in');
  assert.equal(resolveCopy(dest).secondLook, null, 'no base, no second look');
});

test('decisions resolve --vocab lists the classes with definitions, and bad arguments exit 1 with the usage', (t) => {
  const { dir } = decisionsRepo(t, {});
  const vocab = JSON.parse(run(['decisions', 'resolve', '--vocab'], dir).stdout);
  assert.deepEqual(Object.keys(vocab.classes).slice(0, 5), ['security', 'critical-flow', 'money', 'data-loss', 'unknown']);
  assert.equal(vocab.classes.money.floor, true);
  assert.equal(vocab.classes.copy.floor, false);
  assert.match(vocab.classes.copy.definition, /words/u);
  assert.deepEqual(Object.keys(vocab.reversibility), ['storedData', 'external', 'pricingOrContract', 'reachesUsersUnreviewed']);

  const bad = [
    [['decisions'], /decisions takes resolve, list, set, or undo/u],
    [['decisions', 'bogus'], /decisions takes resolve, list, set, or undo, not "bogus"/u],
    [['decisions', 'resolve', '--class', 'copy'], /resolve needs --domain and --class/u],
    [['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,maybe'], /--reversible takes up to 4 answers/u],
    [['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no,no'], /--reversible takes up to 4 answers/u],
  ];
  for (const [args, expected] of bad) {
    const { status, stdout, stderr } = run(args, dir);
    assert.deepEqual([status, stdout], [1, ''], args.join(' '));
    assert.match(stderr, /^usage: aidrian decisions resolve /u);
    assert.match(stderr, expected);
  }
});

// A project with one knowledge bucket, its docs from `docs` ({ name: text }), and no git.
function decisionDocs(t, docs) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const entries = Object.fromEntries(Object.keys(docs).map((name) => [name, { summary: `${name} rules`, tags: [] }]));
  writeFileSync(path.join(dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: entries }));
  for (const [name, text] of Object.entries(docs)) writeFileSync(path.join(dir, 'docs', name), text);
  return dir;
}

const DECISION = '<!-- aidrian:decision id=refund-copy status=unconfirmed class=copy domain=ux date=2026-01-01 pr=41 -->';
const OLD_WORDING = '<!-- aidrian:decision-old id=refund-copy text="Refunds take ten days." -->';
const NEW_WORDING = '<!-- aidrian:decision-new id=refund-copy text="Rule." -->';
// A marker under the rule "Rule.", with the wording it wrote, for a test about anything else.
const decided = (id = 'refund-copy', marker = DECISION) => `${marker}\n${NEW_WORDING}`.replaceAll('refund-copy', id);
const listDecisions = (dir) => {
  const { status, stdout, stderr } = run(['decisions', 'list', '--json'], dir);
  assert.deepEqual([status, stderr], [0, '']);
  return JSON.parse(stdout);
};

test('decisions list prints each marker of the indexed docs, with its old wording, for a person and as JSON', (t) => {
  const gap = DECISION.replaceAll('refund-copy', 'tab-order').replace('class=copy', 'class=ordering').replace('pr=41', 'pr=none').replace('unconfirmed', 'confirmed');
  const fiveDays = NEW_WORDING.replace('Rule.', 'Five days.');
  const tabs = NEW_WORDING.replace('refund-copy', 'tab-order').replace('Rule.', 'Tabs by use.');
  const dir = decisionDocs(t, { 'refunds.md': `# Refunds\n\nFive days.\n${DECISION}\n${OLD_WORDING}\n${fiveDays}\n`, 'ui.md': `Tabs by use.\n${gap}\n${tabs}\n`, 'plain.md': '# Nothing here\n' });
  writeFileSync(path.join(dir, 'docs/unindexed-sibling.txt'), `${DECISION}\n`);

  const out = listDecisions(dir);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.decisions.map(({ id, status, class: kind, domain, date, pr, doc, line, through, hasOldWording, oldWording, newWording }) => [id, status, kind, domain, date, pr, doc, line, through, hasOldWording, oldWording, newWording]), [
    ['refund-copy', 'unconfirmed', 'copy', 'ux', '2026-01-01', 41, 'docs/refunds.md', 4, 6, true, 'Refunds take ten days.', 'Five days.'],
    ['tab-order', 'confirmed', 'ordering', 'ux', '2026-01-01', null, 'docs/ui.md', 2, 3, false, null, 'Tabs by use.'],
  ]);
  assert.ok(out.decisions.every(({ ageDays }) => Number.isInteger(ageDays) && ageDays > 0));

  const { status, stdout, stderr } = run(['decisions', 'list'], dir);
  assert.deepEqual([status, stderr], [0, '']);
  const rows = stdout.trimEnd().split('\n').map((row) => row.split('\t'));
  assert.deepEqual(rows.map(([id, state, kind, domain, , doc, pr, wording, wrote]) => [id, state, kind, domain, doc, pr, wording, wrote]), [
    ['refund-copy', 'unconfirmed', 'copy', 'ux', 'docs/refunds.md:4', 'pr=41', 'old wording: yes', 'new wording: yes'],
    ['tab-order', 'confirmed', 'ordering', 'ux', 'docs/ui.md:2', 'pr=none', 'old wording: no', 'new wording: yes'],
  ]);
  assert.match(rows[0][4], /^\d+d$/u);
  assert.equal(run(['decisions', 'list', '--project', dir], ROOT).stdout, stdout, '--project names the project');
});

test('decisions list reports a malformed marker, a broken old wording, and a repeated id, and still lists the rest', (t) => {
  const dir = decisionDocs(t, {
    'a.md': `Rule.\n${DECISION.replace('class=copy', 'class=pricing')}\n\nRule.\n${DECISION.replaceAll('refund-copy', 'kept')}\n<!-- aidrian:decision-old id=kept text=oops -->\n${NEW_WORDING.replace('refund-copy', 'kept')}\n`,
    'b.md': `Rule.\n${decided('twice')}\n`,
    'c.md': `Rule.\n${decided('twice')}\n`,
  });
  const { decisions, problems } = listDecisions(dir);
  assert.deepEqual(decisions.map(({ id, doc, hasOldWording, oldWording }) => [id, doc, hasOldWording, oldWording]), [
    ['kept', 'docs/a.md', true, null],
    ['twice', 'docs/b.md', false, null],
    ['twice', 'docs/c.md', false, null],
  ]);
  assert.deepEqual(problems.map(({ doc, line }) => [doc, line]), [['docs/a.md', 2], ['docs/a.md', 6], ['docs/b.md', 2], ['docs/c.md', 2]]);
  assert.match(problems[0].problem, /class "pricing"/u);
  assert.match(problems[1].problem, /text="/u);
  assert.match(problems[2].problem, /id "twice" is also at docs\/c\.md:2/u);
  assert.match(problems[3].problem, /id "twice" is also at docs\/b\.md:2/u);

  const { status, stdout } = run(['decisions', 'list'], dir);
  assert.equal(status, 0);
  assert.match(stdout, /^kept\t.*\told wording: unreadable\tnew wording: yes$/mu);
  assert.match(stdout, /^problem\tdocs\/a\.md:2\t.*class "pricing"/mu);
});

test('decisions list survives a broken index and a doc it cannot read, and says so', (t) => {
  const dir = decisionDocs(t, { 'a.md': `Rule.\n${decided()}\n`, 'gone.md': 'x\n' });
  rmSync(path.join(dir, 'docs/gone.md'));
  const { decisions, problems } = listDecisions(dir);
  assert.deepEqual(decisions.map(({ id }) => id), ['refund-copy']);
  assert.deepEqual(problems.map(({ doc, line }) => [doc, line]), [[null, null]]);
  assert.match(problems[0].problem, /gone\.md does not exist/u);
  const empty = decisionDocs(t, { 'a.md': 'nothing\n' });
  assert.equal(run(['decisions', 'list'], empty).stdout, 'no decisions in 1 indexed doc\n');

  const badIndex = decisionDocs(t, { 'a.md': `Rule.\n${decided()}\n` });
  writeFileSync(path.join(badIndex, '.aidrian/knowledge/20-broken.json'), '{ not json');
  const broken = listDecisions(badIndex);
  assert.deepEqual(broken.decisions.map(({ id }) => id), ['refund-copy'], 'the good index still lists');
  assert.deepEqual(broken.problems.map(({ doc, line }) => [doc, line]), [[null, null]]);
  assert.match(broken.problems[0].problem, /20-broken\.json/u);
});

test('decisions list says so when a doc cannot be read', { skip: process.getuid?.() === 0 ? 'root reads every file' : false }, (t) => {
  const dir = decisionDocs(t, { 'a.md': `Rule.\n${decided()}\n`, 'locked.md': 'secret\n' });
  const locked = path.join(dir, 'docs/locked.md');
  chmodSync(locked, 0o000);
  const { decisions, problems } = listDecisions(dir);
  assert.deepEqual(decisions.map(({ id }) => id), ['refund-copy']);
  assert.deepEqual(problems.map(({ doc, line }) => [doc, line]), [['docs/locked.md', null]]);
  assert.match(problems[0].problem, /cannot read the doc: EACCES/u);
});

// `decisionDocs` as a git repository on `main`, with its docs committed, and `git` run in it.
function decisionRepo(t, docs) {
  const dir = decisionDocs(t, docs);
  const git = (...args) => {
    const out = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'docs');
  return { dir, git };
}

test('decisions list --added-since parses both ends: new markers, however written, and no quote, inherited marker, or uncommitted one', (t) => {
  const inherited = decided('inherited');
  const movedAway = decided('moved-away');
  const oldBroken = DECISION.replaceAll('refund-copy', 'old-broken').replace('date=2026-01-01', 'date=soon');
  const { dir, git } = decisionRepo(t, { 'a.md': `Rule.\n${inherited}\n\nRule.\n${oldBroken}\n`, 'b.md': `Rule.\n${movedAway}\n` });
  git('checkout', '-q', '-b', 'feature');
  const indented = '<!-- aidrian:decision id=indented status=unconfirmed class=copy domain=ux date=2026-01-01 pr=41 -->';
  const indentedWording = NEW_WORDING.replace('refund-copy', 'indented').replace('Rule.', '- Nested rule.');
  const settled = decided('settled').replace('unconfirmed', 'confirmed');
  const bad = DECISION.replaceAll('refund-copy', 'bad-class').replace('class=copy', 'class=pricing');
  writeFileSync(path.join(dir, 'docs/a.md'), [
    'Rule.', inherited.replace('unconfirmed', 'confirmed'), '', 'Rule.', oldBroken, '', '- Nested rule.', `  ${indented}`, `  ${indentedWording}`, '', 'Rule.', settled, '',
    'Rule.', bad, '', '```md', DECISION.replaceAll('refund-copy', 'fenced'), '```', `Write \`${DECISION.replaceAll('refund-copy', 'spanned')}\`.`, '',
  ].join('\n'));
  writeFileSync(path.join(dir, 'docs/b.md'), 'Nothing here now.\n');
  writeFileSync(path.join(dir, 'docs/c.md'), `Rule.\n${movedAway}\n`);
  const index = path.join(dir, '.aidrian/knowledge/10-docs.json');
  const entries = { 'a.md': { summary: 'a rules', tags: [] }, 'b.md': { summary: 'b rules', tags: [] }, 'c.md': { summary: 'c rules', tags: [] } };
  writeFileSync(index, JSON.stringify({ dir: 'docs', description: 'The rules.', docs: entries }));
  git('add', '.');
  git('commit', '-q', '-m', 'decide');
  writeFileSync(path.join(dir, 'docs/b.md'), `Rule.\n${decided('uncommitted')}\n`);

  const { status, stdout, stderr } = run(['decisions', 'list', '--added-since', 'main', '--json'], dir, { ...process.env, PATH: noGh(t) });
  assert.deepEqual([status, stderr], [0, '']);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.decisions.map(({ id, status: state, doc, line }) => [id, state, doc, line]), [['indented', 'unconfirmed', 'docs/a.md', 9], ['settled', 'confirmed', 'docs/a.md', 13]]);
  const own = out.problems.filter(({ inherited }) => !inherited);
  assert.deepEqual(own.map(({ doc, line }) => [doc, line]), [['docs/a.md', 17]], 'only the branch\'s own problem');
  assert.match(own[0].problem, /class "pricing"/u);
  assert.deepEqual(out.problems.filter(({ inherited }) => inherited).map(({ doc, line, inherited }) => [doc, line, inherited]), [['docs/a.md', 6, true]], 'the one the merge base has');
  assert.equal(out.pullRequest, null);

  const text = run(['decisions', 'list', '--added-since', 'main'], dir, { ...process.env, PATH: noGh(t) });
  assert.match(text.stdout, /^indented\tunconfirmed\t/mu);
  assert.match(text.stdout, /^problem\tdocs\/a\.md:17\t/mu);
  git('checkout', '-q', '--', 'docs/b.md');
  git('checkout', '-q', 'main');
  assert.match(run(['decisions', 'list', '--added-since', 'main'], dir, { ...process.env, PATH: noGh(t) }).stdout, /^problem\tdocs\/a\.md:6\tdate "soon".*\tinherited\n$/u, 'on main, only what it inherited');
  const clean = decisionRepo(t, { 'a.md': `Rule.\n${decided('kept')}\n` });
  assert.equal(run(['decisions', 'list', '--added-since', 'main'], clean.dir, { ...process.env, PATH: noGh(t) }).stdout, 'no decisions added since main\n');
  for (const ref of ['no-such-ref', '--output=x']) {
    const { status: code, stderr: said } = run(['decisions', 'list', `--added-since=${ref}`], dir);
    assert.equal(code, 1, ref);
    assert.match(said, /cannot compare this branch with/u, ref);
  }
});

test('decisions list --added-since flags a pr=none the branch added once its pull request exists, and only then', (t) => {
  const { dir, git } = decisionRepo(t, { 'a.md': 'Rule.\n' });
  git('checkout', '-q', '-b', 'feature');
  const noNumber = decided().replace('pr=41', 'pr=none');
  writeFileSync(path.join(dir, 'docs/a.md'), `Rule.\n${noNumber}\n\nRule.\n${decided('numbered')}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'decide');
  const before = JSON.parse(run(['decisions', 'list', '--added-since', 'main', '--json'], dir, { ...process.env, PATH: noGh(t) }).stdout);
  assert.deepEqual([before.problems, before.pullRequest, before.decisions.length], [[], null, 2], 'gh has no answer: nothing to flag');
  const after = JSON.parse(run(['decisions', 'list', '--added-since', 'main', '--json'], dir, fakeGh(t, '{"number":7}')).stdout);
  assert.equal(after.pullRequest, 7);
  assert.deepEqual(after.problems.map(({ doc, line }) => [doc, line]), [['docs/a.md', 2]]);
  assert.match(after.problems[0].problem, /"refund-copy" still says pr=none, but pull request #7 exists/u);
});

// A PATH with `gh` printing `json`, ahead of the real one.
function fakeGh(t, json) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gh-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${json}'\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

// A PATH whose `gh` always fails, so no test reads a real pull request.
const noGh = (t) => {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gh-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  return `${bin}:${process.env.PATH}`;
};

test('decisions list --added-since returns an inherited marker whose status the branch changed as settled, and flags a decision outside the indexed docs', (t) => {
  const kept = decided('kept');
  const unchanged = decided('unchanged');
  const { dir, git } = decisionRepo(t, { 'a.md': `Rule.\n${kept}\n\nRule.\n${unchanged}\n` });
  mkdirSync(path.join(dir, 'notes'));
  writeFileSync(path.join(dir, 'notes/inherited.md'), `Rule.\n${decided('in-notes')}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'notes');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'docs/a.md'), `Rule.\n${kept.replace('unconfirmed', 'confirmed')}\n\nRule.\n${unchanged}\n`);
  writeFileSync(path.join(dir, 'notes/new.md'), `Rule.\n${decided('stray')}\n\n\`\`\`md\n${DECISION.replaceAll('refund-copy', 'quoted')}\n\`\`\`\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'settle');

  const env = { ...process.env, PATH: noGh(t) };
  const { status, stdout, stderr } = run(['decisions', 'list', '--added-since', 'main', '--json'], dir, env);
  assert.deepEqual([status, stderr], [0, '']);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.decisions, [], 'neither the settled one nor the stray one is a new decision of the indexed docs');
  assert.deepEqual(out.settled.map(({ id, status: state, was, doc, line }) => [id, state, was, doc, line]), [['kept', 'confirmed', 'unconfirmed', 'docs/a.md', 2]]);
  assert.deepEqual(out.problems.map(({ doc, line }) => [doc, line]), [['notes/new.md', 2]], 'not the quoted one, nor the one the branch inherited');
  assert.match(out.problems[0].problem, /"stray" is in a doc no knowledge index lists: markers belong in an indexed doc/u);

  const text = run(['decisions', 'list', '--added-since', 'main'], dir, env).stdout;
  assert.match(text, /^kept\tconfirmed\t.*\tsettled, was unconfirmed$/mu);
  assert.match(text, /^problem\tnotes\/new\.md:2\t/mu);
  assert.deepEqual(out.removed, [], 'nothing left the indexed docs, and the inherited marker of an unindexed file stays there');
});

test('decisions list --added-since returns what no indexed doc at HEAD holds as removed, an undone marker too, with its status at the base', (t) => {
  const gone = decided('gone').replace('unconfirmed', 'confirmed');
  const { dir, git } = decisionRepo(t, { 'a.md': `Rule.\n${decided('undone')}\n\nRule.\n${gone}\n\nRule.\n${decided('stays')}\n`, 'b.md': 'Other.\n' });
  git('checkout', '-q', '-b', 'feature');
  const env = { ...process.env, PATH: noGh(t) };
  assert.equal(run(['decisions', 'undo', 'undone'], dir, env).status, 0);
  const moved = readFileSync(path.join(dir, 'docs/a.md'), 'utf8').replace(`Rule.\n${gone}\n\n`, '');
  writeFileSync(path.join(dir, 'docs/a.md'), moved);
  git('add', '.');
  git('commit', '-q', '-m', 'undo');
  const { status, stdout, stderr } = run(['decisions', 'list', '--added-since', 'main', '--json'], dir, env);
  assert.deepEqual([status, stderr], [0, '']);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.removed, [{ id: 'undone', status: 'unconfirmed', doc: 'docs/a.md' }, { id: 'gone', status: 'confirmed', doc: 'docs/a.md' }]);
  assert.deepEqual(out.decisions, [], 'nothing new');
  assert.match(run(['decisions', 'list', '--added-since', 'main'], dir, env).stdout, /^undone\tunconfirmed\tremoved from docs\/a\.md$/mu);
});

test('decisions list --added-since blanks only a valid status and pr: a line the branch made invalid is its own problem', (t) => {
  const inherited = decided('inherited');
  const broken = decided('old-broken').replace('status=unconfirmed', 'status=pending');
  const { dir, git } = decisionRepo(t, { 'a.md': `Rule.\n${inherited}\n\nRule.\n${broken}\n\nRule.\n${decided('good-pr')}\n` });
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'docs/a.md'), `Rule.\n${inherited.replace('status=unconfirmed', 'status=approved')}\n\nRule.\n${broken}\n\nRule.\n${decided('good-pr').replace('pr=41', 'pr=#41')}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'break');
  const out = JSON.parse(run(['decisions', 'list', '--added-since', 'main', '--json'], dir, { ...process.env, PATH: noGh(t) }).stdout);
  const problems = out.problems.filter(({ problem }) => /status "|pr "/u.test(problem)).map(({ line, problem, inherited }) => [line, problem.split(' ').slice(0, 2).join(' '), inherited ?? false]);
  assert.deepEqual(problems, [[2, 'status "approved"', false], [6, 'status "pending"', true], [10, 'pr "#41"', false]], 'the status the branch inherited broken is marked');
});

test('list and check report wording undo could no longer find, on the marker that wrote it', (t) => {
  const dir = decisionDocs(t, { 'a.md': `Someone changed this.\n${decided('drifted')}\n` });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  assert.match(listDecisions(dir).problems[0].problem, /"drifted" wrote wording found 0 times/u);
  const { status, stderr } = run(['check'], dir);
  assert.equal(status, 0);
  assert.match(stderr, /^warning: docs\/a\.md:2: "drifted" wrote wording found 0 times/mu);
});

const optedPause = (pending, oldestDays = 100000) => ({ maxMode: 'decide-reversible', mode: 'decide-reversible', unreviewed: { remind: 'session-start', pauseDomainAt: { pending, oldestDays } } });
const freshDecision = (id) => decided(id).replace('date=2026-01-01', `date=${new Date().toISOString().slice(0, 10)}`);
const docOf = (...records) => records.map((each) => `Rule.\n${each}\n`).join('\n');

// `decisionsRepo` with docs/a.md committed and indexed.
function pauseRepo(t, decisions, text) {
  const { dir, git } = decisionsRepo(t, decisions);
  mkdirSync(path.join(dir, 'docs'));
  mkdirSync(path.join(dir, '.aidrian/knowledge'));
  writeFileSync(path.join(dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'a.md': { summary: 'a rules', tags: [] } } }));
  writeFileSync(path.join(dir, 'docs/a.md'), text);
  git('add', '.');
  git('commit', '-q', '-m', 'docs');
  return { dir, git };
}

test('with no git at all, resolve counts the working copy\'s unconfirmed markers at either threshold', (t) => {
  const project = (decisions, text) => {
    const dir = decisionDocs(t, { 'a.md': text });
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions }));
    return dir;
  };
  const atCount = resolveCopy(project(optedPause(2), docOf(freshDecision('one'), freshDecision('two'))));
  assert.deepEqual(pick(atCount), ['ask', 'domain-paused', null]);
  assert.match(atCount.reason, /2 unreviewed decisions, the pause is at 2; the markers are in docs\/a\.md/u);
  const old = resolveCopy(project(optedPause(50, 7), docOf(decided('old-one'))));
  assert.deepEqual(pick(old), ['ask', 'domain-paused', null], 'the oldest reached the age');
  assert.match(old.reason, /the oldest unreviewed decision is \d+ days old, the pause is at 7/u);
  const below = resolveCopy(project(optedPause(2), docOf(freshDecision('one'), freshDecision('two').replace('unconfirmed', 'confirmed'))));
  assert.deepEqual(pick(below), ['decide', 'mode', null], 'a confirmed marker does not count, as the working copy is the only record');
});

test('a marker at the merge base that the base has since removed does not count, though HEAD still holds it', (t) => {
  const { dir, git } = pauseRepo(t, optedPause(1), docOf(freshDecision('undone-on-main')));
  git('checkout', '-q', '-b', 'feature');
  assert.equal(resolveCopy(dir).rule, 'domain-paused', 'on the base: it counts');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'docs/a.md'), 'Rule.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'undo on main');
  git('checkout', '-q', 'feature');
  assert.match(readFileSync(path.join(dir, 'docs/a.md'), 'utf8'), /undone-on-main/u, 'HEAD still holds it');
  assert.deepEqual(pick(resolveCopy(dir)).slice(0, 2), ['decide', 'mode']);
});

test('a tracked marker no index lists counts toward the pause: the reason names its doc, and list and check report it', (t) => {
  const { dir, git } = pauseRepo(t, optedPause(2), docOf(freshDecision('indexed')));
  mkdirSync(path.join(dir, 'notes'));
  writeFileSync(path.join(dir, 'notes/stray.md'), docOf(freshDecision('stray')));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'notes');
  writeFileSync(path.join(dir, 'notes/untracked.md'), docOf(freshDecision('untracked')));

  const { rule, reason } = resolveCopy(dir);
  assert.equal(rule, 'domain-paused');
  assert.match(reason, /the markers are in docs\/a\.md, notes\/stray\.md$/u);

  const { decisions, problems } = listDecisions(dir);
  assert.deepEqual(decisions.map(({ id }) => id), ['indexed'], 'set and undo read the indexed docs');
  assert.deepEqual(problems.map(({ doc, line }) => [doc, line]), [['notes/stray.md', 2]], 'tracked only');
  assert.match(problems[0].problem, /"stray" is in a doc no knowledge index lists: markers belong in an indexed doc/u);
  assert.match(run(['decisions', 'list'], dir).stdout, /^problem\tnotes\/stray\.md:2\t"stray" is in a doc/mu);
  const checked = run(['check'], dir);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /^warning: notes\/stray\.md:2: "stray" is in a doc no knowledge index lists/mu);

  assert.equal(new Set(problems.map(({ doc }) => doc)).size, 1);
  const undone = run(['decisions', 'undo', 'stray'], dir);
  assert.equal(undone.status, 1);
  assert.match(undone.stderr, /cannot undo "stray" at notes\/stray\.md:2: "stray" is in a doc no knowledge index lists/u);
  assert.match(undone.stderr, /^block above the marker:\n {2}Rule\.$/mu);
});

test('decisions list --added-since marks a problem inherited only when the merge base has the same problem on the same line', (t) => {
  const stackTop = decided('top').replace(NEW_WORDING.replace('refund-copy', 'top'), NEW_WORDING.replace('refund-copy', 'top').replace('Rule.', 'Second.'));
  const stackBottom = `${DECISION.replaceAll('refund-copy', 'bottom')}\n${OLD_WORDING.replace('refund-copy', 'bottom').replace('Refunds take ten days.', 'Second.')}\n${NEW_WORDING.replace('refund-copy', 'bottom')}`;
  const base = [`Rule.\n${decided('rewords')}`, `Already moved.\n${decided('inherited')}`, `Again moved.\n${decided('grew')}`, `Rule.\n${stackTop}\n${stackBottom}`, ''].join('\n\n');
  const { dir, git } = decisionRepo(t, { 'a.md': base });
  const list = () => JSON.parse(run(['decisions', 'list', '--added-since', 'main', '--json'], dir, { ...process.env, PATH: noGh(t) }).stdout).problems;
  git('checkout', '-q', '-b', 'feature');
  assert.deepEqual(list().map(({ problem, inherited }) => [problem.split(' ')[0], inherited]), [['"inherited"', true], ['"grew"', true]], 'the branch changed nothing: both inherited, and both still listed');
  const edited = base
    .replace(`Rule.\n${decided('rewords')}`, `Reworded by the branch.\n${decided('rewords')}`)
    .replace(`Again moved.\n${decided('grew')}`, `Rule.\nRule.\n${decided('grew')}`)
    .replace('text="Second." -->\n<!-- aidrian:decision-new id=bottom', 'text="Other." -->\n<!-- aidrian:decision-new id=bottom');
  writeFileSync(path.join(dir, 'docs/a.md'), edited);
  git('add', '.');
  git('commit', '-q', '-m', 'reword');
  const rows = list();
  const problems = rows.filter(({ inherited }) => !inherited).map(({ problem }) => problem);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0], /"rewords" wrote wording found 0 times/u, 'the line is inherited, the drift the branch\'s');
  assert.match(problems[1], /"grew" wrote wording found 2 times/u, 'another count is another problem');
  assert.match(problems[2], /"bottom" sits below "top", but its old wording/u);
  assert.deepEqual(rows.filter(({ inherited }) => inherited).map(({ problem }) => problem.split(' ')[0]), ['"inherited"'], 'the same problem on the same line at the merge base');

  const statusOnly = decisionRepo(t, { 'a.md': `Moved.\n${decided('settled-late')}\n` });
  statusOnly.git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(statusOnly.dir, 'docs/a.md'), `Moved.\n${decided('settled-late').replace('pr=41', 'pr=42')}\n`);
  statusOnly.git('add', '.');
  statusOnly.git('commit', '-q', '-m', 'number');
  const [same] = JSON.parse(run(['decisions', 'list', '--added-since', 'main', '--json'], statusOnly.dir, { ...process.env, PATH: noGh(t) }).stdout).problems;
  assert.equal(same.inherited, true, 'a valid pull request number aside');
  assert.match(run(['decisions', 'list', '--added-since', 'main'], statusOnly.dir, { ...process.env, PATH: noGh(t) }).stdout, /^problem\tdocs\/a\.md:2\t.*\tinherited$/mu);
});

test('a doc reached through a symlinked folder is no unindexed file, and a real unindexed one still reports', (t) => {
  const { dir, git } = decisionRepo(t, { 'a.md': 'Rule.\n' });
  mkdirSync(path.join(dir, 'shared'));
  writeFileSync(path.join(dir, 'shared/a.md'), `Rule.\n${decided('linked')}\n`);
  mkdirSync(path.join(dir, 'notes'));
  writeFileSync(path.join(dir, 'notes/other.md'), `Rule.\n${decided('other')}\n`);
  rmSync(path.join(dir, 'docs'), { recursive: true });
  symlinkSync('shared', path.join(dir, 'docs'));
  git('add', '.');
  git('commit', '-q', '-m', 'link');
  const { decisions, problems } = listDecisions(dir);
  assert.deepEqual(decisions.map(({ id, doc }) => [id, doc]), [['linked', 'docs/a.md']]);
  assert.deepEqual(problems.map(({ doc, line }) => [doc, line]), [['notes/other.md', 2]], 'shared/a.md is the indexed doc, by its real path');
});

test('when git grep fails, list notes that unindexed markers went unscanned and still exits 0; with no git there is no note', (t) => {
  const { dir } = decisionRepo(t, { 'a.md': `Rule.\n${decided()}\n` });
  const failing = fake(t, 'case " $* " in *" grep "*) exit 3;; esac');
  const json = run(['decisions', 'list', '--json'], dir, failing);
  assert.deepEqual([json.status, json.stderr], [0, '']);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(out.decisions.map(({ id }) => id), ['refund-copy']);
  assert.deepEqual(out.notes, ['markers in files no index lists could not be scanned: git grep failed']);
  const text = run(['decisions', 'list'], dir, failing);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^note\tmarkers in files no index lists could not be scanned: git grep failed$/mu);
  assert.deepEqual(listDecisions(dir).notes, [], 'git answers: no note');
  const plain = decisionDocs(t, { 'a.md': '# Nothing here\n' });
  assert.deepEqual(listDecisions(plain).notes, [], 'no git at all');
  assert.equal(run(['decisions', 'list'], plain).stdout, 'no decisions in 1 indexed doc\n');
  const empty = decisionRepo(t, { 'a.md': '# Nothing here\n' });
  assert.equal(run(['decisions', 'list'], empty.dir, failing).stdout, 'no decisions in 1 indexed doc\nnote\tmarkers in files no index lists could not be scanned: git grep failed\n');
});

test('decisions resolve pauses a domain at either threshold, counting the base and what the branch added, and no working-copy edit lifts it', (t) => {
  const opted = optedPause(2);

  const { dir, git } = pauseRepo(t, opted, docOf(freshDecision('one'), freshDecision('two')));
  git('checkout', '-q', '-b', 'feature');
  const atCount = resolveCopy(dir);
  assert.deepEqual([atCount.authority, atCount.rule], ['ask', 'domain-paused'], 'two on the base, at the count');
  assert.match(atCount.reason, /ux is paused: 2 unreviewed decisions, the pause is at 2/u);

  const file = path.join(dir, 'docs/a.md');
  writeFileSync(file, docOf(freshDecision('one').replace('unconfirmed', 'confirmed'), freshDecision('two').replace('unconfirmed', 'confirmed')));
  assert.equal(resolveCopy(dir).rule, 'domain-paused', 'an uncommitted status edit does not lift it');
  writeFileSync(file, 'Nothing here now.\n');
  assert.equal(resolveCopy(dir).rule, 'domain-paused', 'nor does deleting the markers');
  git('checkout', '-q', '--', 'docs/a.md');
  writeFileSync(file, docOf(freshDecision('one').replace('unconfirmed', 'confirmed'), freshDecision('two').replace('unconfirmed', 'confirmed')));
  git('add', '.');
  git('commit', '-q', '-m', 'settle on the branch');
  assert.equal(resolveCopy(dir).rule, 'domain-paused', 'nor does a commit on the branch: only the base branch counts');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  assert.deepEqual(pick(resolveCopy(dir)).slice(0, 2), ['decide', 'mode'], 'the answer on the base branch lifts it');

  const branch = pauseRepo(t, opted, docOf(freshDecision('one')));
  assert.equal(resolveCopy(branch.dir).authority, 'decide', 'one on the base is below the count');
  branch.git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(branch.dir, 'docs/a.md'), docOf(freshDecision('one'), freshDecision('added').replace('unconfirmed', 'confirmed')));
  assert.equal(resolveCopy(branch.dir).authority, 'decide', 'an uncommitted marker is not yet the branch\'s');
  branch.git('add', '.');
  branch.git('commit', '-q', '-m', 'decide');
  assert.equal(resolveCopy(branch.dir).rule, 'domain-paused', 'a marker the branch committed counts, whatever status it wrote');

  const elsewhere = run(['decisions', 'resolve', '--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no'], branch.dir);
  assert.equal(JSON.parse(elsewhere.stdout).authority, 'decide', 'another domain pauses only itself');

  const aged = pauseRepo(t, { ...opted, unreviewed: { remind: 'session-start', pauseDomainAt: { pending: 50, oldestDays: 7 } } }, docOf(decided('old-one')));
  const old = resolveCopy(aged.dir);
  assert.deepEqual([old.authority, old.rule], ['ask', 'domain-paused'], 'the oldest reached the age');
  assert.match(old.reason, /the oldest unreviewed decision is \d+ days old, the pause is at 7/u);

  const off = pauseRepo(t, { ...opted, unreviewed: { remind: 'session-start', pauseDomainAt: null } }, docOf(freshDecision('one'), freshDecision('two')));
  assert.equal(resolveCopy(off.dir).authority, 'decide', 'null turns the pause off');

  const stalled = run(['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no'], aged.dir, fake(t, 'case " $* " in *" grep "*) exit 3;; esac'));
  assert.deepEqual(pick(JSON.parse(stalled.stdout)).slice(0, 2), ['ask', 'no-base'], 'git failing on the markers asks');
});

test('check warns about a marker it cannot read and still passes, and reports nothing for a good one', (t) => {
  const dir = decisionDocs(t, { 'a.md': `Rule.\n${decided()}\n\nRule.\n${DECISION.replaceAll('refund-copy', 'bad-class').replace('class=copy', 'class=pricing')}\n` });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  const { status, stdout, stderr } = run(['check'], dir);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^ok: /u);
  assert.match(stderr, /^warning: docs\/a\.md:6: class "pricing" is no class of decisions\.json$/mu);
  assert.doesNotMatch(stderr, /docs\/a\.md:2/u);
});

test('decisions set refuses a tracked doc in a guarded main checkout, names the worktree command, and honours the override', (t) => {
  const { dir, git } = decisionRepo(t, { 'a.md': `Rule.\n${decided()}\n` });
  const config = path.join(dir, '.aidrian/config.json');
  writeFileSync(config, JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'guard');
  const file = path.join(dir, 'docs/a.md');
  const before = readFileSync(file, 'utf8');
  const { AIDRIAN_ALLOW_MAIN_WRITE: _, ...env } = process.env;

  const refused = run(['decisions', 'set', 'refund-copy', 'confirmed'], dir, env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /aidrian worktree new <branch>/u);
  assert.match(refused.stderr, /AIDRIAN_ALLOW_MAIN_WRITE=1/u);
  assert.equal(readFileSync(file, 'utf8'), before);

  const tree = path.join(dir, '.worktrees/task');
  git('worktree', 'add', '-q', '-b', 'task', tree);
  assert.equal(run(['decisions', 'set', 'refund-copy', 'confirmed'], tree, env).status, 0, 'a task worktree passes');
  assert.match(readFileSync(path.join(tree, 'docs/a.md'), 'utf8'), /status=confirmed/u);
  assert.equal(readFileSync(file, 'utf8'), before);

  assert.equal(run(['decisions', 'set', 'refund-copy', 'confirmed'], dir, { ...env, AIDRIAN_ALLOW_MAIN_WRITE: '1' }).status, 0, 'the override');
  assert.match(readFileSync(file, 'utf8'), /status=confirmed/u);

  writeFileSync(config, JSON.stringify({ version: 1, git: { mainCheckout: { guard: true, allowWrites: ['docs/*.md'] } } }));
  assert.equal(run(['decisions', 'set', 'refund-copy', 'rejected'], dir, env).status, 0, 'allowWrites');
});

test('decisions list reads this repository\'s docs with no problem: their examples are quotes', () => {
  assert.deepEqual(listDecisions(ROOT).problems, []);
});

test('decisions set rewrites only that marker\'s status, byte for byte, and reads back', (t) => {
  // A byte that is not UTF-8, and CRLF lines, must survive the write.
  const other = DECISION.replaceAll('refund-copy', 'other-one');
  const otherWording = NEW_WORDING.replaceAll('refund-copy', 'other-one').replace('Rule.', 'Above.');
  const before = Buffer.concat([Buffer.from(`# Caf`), Buffer.from([0xe9]), Buffer.from(`\r\nAbove.\r\n${other}\r\n${otherWording}\r\n\r\nRule.\r\n${DECISION}\r\n${OLD_WORDING}\r\n${NEW_WORDING}\r\nlast, no newline`)]);
  const dir = decisionDocs(t, { 'a.md': before });
  const file = path.join(dir, 'docs/a.md');

  const { status, stdout, stderr } = run(['decisions', 'set', 'refund-copy', 'confirmed'], dir);
  assert.deepEqual([status, stderr], [0, '']);
  assert.match(stdout, /docs\/a\.md:7: refund-copy confirmed \(was unconfirmed\)/u);
  assert.deepEqual(readFileSync(file), Buffer.from(before.toString('latin1').replace(`Rule.\r\n${DECISION}`, `Rule.\r\n${DECISION.replace('unconfirmed', 'confirmed')}`), 'latin1'));
  const listed = listDecisions(dir).decisions;
  assert.deepEqual(listed.map(({ id, status: state }) => [id, state]), [['other-one', 'unconfirmed'], ['refund-copy', 'confirmed']]);
  assert.equal(listed[1].oldWording, 'Refunds take ten days.', 'the old wording stays on record for undo');

  const again = run(['decisions', 'set', 'refund-copy', 'confirmed'], dir);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already confirmed/u);
  assert.equal(run(['decisions', 'set', 'refund-copy', 'rejected', '--project', dir], ROOT).status, 0);
  assert.equal(listDecisions(dir).decisions[1].status, 'rejected');
});

test('decisions set refuses a bad status, an unknown or malformed id, and a repeated id, and writes nothing', (t) => {
  const twice = decided('twice');
  const badId = DECISION.replaceAll('refund-copy', 'Bad_Id');
  const docs = { 'a.md': `Rule.\n${decided()}\n\nRule.\n${twice}\n\nRule.\n${DECISION.replaceAll('refund-copy', 'broken').replace('date=2026-01-01', 'date=soon')}\n\nRule.\n${badId}\n`, 'b.md': `Rule.\n${twice}\n` };
  const dir = decisionDocs(t, docs);
  const bad = [
    [['decisions', 'set'], /set needs an id and confirmed or rejected/u],
    [['decisions', 'set', 'refund-copy'], /set needs an id and confirmed or rejected/u],
    [['decisions', 'set', 'refund-copy', 'confirmed', 'extra'], /set needs an id and confirmed or rejected/u],
    [['decisions', 'set', 'refund-copy', 'unconfirmed'], /confirmed or rejected, not "unconfirmed"/u],
    [['decisions', 'set', 'no-such', 'confirmed'], /no decision marker with id "no-such".*4 marker problems/su],
    [['decisions', 'set', 'broken', 'confirmed'], /no decision marker with id "broken"/u],
    [['decisions', 'set', 'twice', 'confirmed'], /id "twice" is on 2 markers: docs\/a\.md:6, docs\/b\.md:2/u],
  ];
  for (const [args, expected] of bad) {
    const { status, stdout, stderr } = run(args, dir);
    assert.deepEqual([status, stdout], [1, ''], args.join(' '));
    assert.match(stderr, expected, args.join(' '));
  }
  for (const [name, text] of Object.entries(docs)) assert.equal(readFileSync(path.join(dir, 'docs', name), 'utf8'), text, name);
});

test('decisions usage lists resolve, list, set, and undo, and list, set, and undo need a project', (t) => {
  const { stderr } = run(['decisions', 'bogus'], EXAMPLE);
  for (const form of ['aidrian decisions resolve --domain', 'aidrian decisions list', 'aidrian decisions set ID confirmed|rejected', 'aidrian decisions undo ID']) assert.ok(stderr.includes(form), form);
  assert.match(run(['--help']).stdout, /aidrian decisions list/u);
  const away = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(away, { recursive: true, force: true }));
  for (const args of [['list'], ['set', 'a', 'confirmed'], ['undo', 'a']]) {
    const { status, stderr: said } = run(['decisions', ...args], away);
    assert.equal(status, 1);
    assert.match(said, /^no project folder at or above /u);
  }
});

test('decisions resolve stops on an invalid config, keeping its error, instead of answering on defaults', (t) => {
  const { dir, write } = decisionsRepo(t, {});
  write({ mode: 'decide' });
  const { status, stdout, stderr } = run(['decisions', 'resolve', '--domain', 'ux', '--class', 'copy', '--reversible', 'no,no,no,no'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(stderr, '.aidrian/config.json: "decisions.mode" must be "ask" or "decide-reversible"\n');
});

test('check warns when decisions.unreviewed has neither a reminder nor a pause, and still passes', (t) => {
  const { dir, write } = decisionsRepo(t, { unreviewed: { remind: 'off', pauseDomainAt: null } });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  const warned = run(['check'], dir);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /^warning: decisions\.unreviewed: "remind" is "off" and "pauseDomainAt" is null/mu);
  write({ unreviewed: { remind: 'off' } });
  assert.doesNotMatch(run(['check'], dir).stderr, /decisions\.unreviewed/u, 'the default pause still stops them');
});

test('a team mode or domain above maxMode: resolve names maxMode and check warns, with and without a local file that leaves the key alone', (t) => {
  const { dir } = decisionsRepo(t, { maxMode: 'ask', mode: 'decide-reversible', domains: { product: 'decide-reversible' } });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  const check = () => {
    const out = run(['check'], dir);
    assert.equal(out.status, 0, out.stderr);
    return out.stderr;
  };
  const local = (decisions) => writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ decisions }));
  const MODE = /^warning: decisions\.mode: "decide-reversible" is above decisions\.maxMode "ask".*commit decisions\.maxMode "decide-reversible"/mu;
  const DOMAIN = /^warning: decisions\.domains\.product: "decide-reversible" is above decisions\.maxMode "ask"/mu;

  assert.deepEqual(pick(resolveCopy(dir)).slice(0, 2), ['ask', 'maxMode'], 'no local file');
  assert.match(check(), MODE);
  assert.match(check(), DOMAIN);

  local({ unreviewed: { remind: 'session-start' } });
  assert.deepEqual(pick(resolveCopy(dir)).slice(0, 2), ['ask', 'maxMode'], 'a local file that leaves mode alone');
  assert.match(check(), MODE);
  assert.match(check(), DOMAIN);

  local({ mode: 'decide-reversible' });
  assert.deepEqual(pick(resolveCopy(dir)).slice(0, 2), ['ask', 'mode'], 'a local file that sets mode is held down');
  assert.doesNotMatch(check(), MODE);
  assert.match(check(), DOMAIN, 'the key the local file left alone still warns');
});

test('check warns for an escalateDocs entry with no exact tracked path, for a typo and a case difference, and still passes', (t) => {
  const escalateDocs = ['docs/pricing.md', 'docs/pricng.md', 'docs/Pricing.md', 'docs/legal/', 'docs/terms.md#refunds', 'docs/LEGAL/', 'docs/later.md', 'docs/café.md'];
  const { dir, git } = decisionsRepo(t, { escalateDocs });
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  mkdirSync(path.join(dir, 'docs/legal'), { recursive: true });
  for (const file of ['pricing.md', 'terms.md', 'legal/a.md', 'café.md']) writeFileSync(path.join(dir, 'docs', file), '# Doc\n');
  writeFileSync(path.join(dir, 'docs/later.md'), 'on disk, not tracked\n');
  git('add', 'docs/pricing.md', 'docs/terms.md', 'docs/legal/a.md', 'docs/café.md');
  const { status, stderr } = run(['check'], dir);
  assert.equal(status, 0, stderr);
  const named = [...stderr.matchAll(/^warning: decisions\.escalateDocs: "([^"]+)" matches no tracked path/gmu)].map((match) => match[1]);
  assert.deepEqual(named, ['docs/pricng.md', 'docs/Pricing.md', 'docs/LEGAL/', 'docs/later.md'], 'a non-ASCII path git would quote matches too');

  // Past the 1 MiB a spawn buffers by default, a listing that is cut off would hide the warning.
  const large = fake(t, `case " $* " in *" ls-files "*) head -c 1200000 /dev/zero | tr '\\000' x; printf '\\000docs/pricing.md\\000'; exit 0;; esac`);
  const listedLong = [...run(['check'], dir, large).stderr.matchAll(/escalateDocs: "([^"]+)"/gmu)].map((match) => match[1]);
  assert.ok(listedLong.includes('docs/pricng.md'), 'a listing over 1 MiB is still read');
  assert.ok(!listedLong.includes('docs/pricing.md'), 'to its end');

  const below = path.join(dir, 'apps/web');
  mkdirSync(path.join(below, '.aidrian'), { recursive: true });
  mkdirSync(path.join(below, 'docs'));
  writeFileSync(path.join(below, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { escalateDocs: ['docs/own.md', 'docs/pricing.md'] } }));
  writeFileSync(path.join(below, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  writeFileSync(path.join(below, 'docs/own.md'), '# Own\n');
  git('add', 'apps/web/docs/own.md');
  const nested = run(['check'], below);
  assert.deepEqual([...nested.stderr.matchAll(/escalateDocs: "([^"]+)"/gmu)].map((match) => match[1]), ['docs/pricing.md'], 'paths are from the project root');

  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  mkdirSync(path.join(plain, '.aidrian'));
  writeFileSync(path.join(plain, '.aidrian/config.json'), JSON.stringify({ version: 1, decisions: { escalateDocs: ['docs/none.md'] } }));
  assert.doesNotMatch(run(['check'], plain).stderr, /escalateDocs/u, 'outside git, nothing says what is tracked');
});

// A git repository whose config.json still uses the old `pr` group, and a `gh` on the PATH that reports one skipped e2e
// check: with the defaults in place of `requiredChecks`, `aidrian pr checks` would call that ready.
function renamedPolicy(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  const config = (value) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(value));
  config({ version: 1, pr: { requiredChecks: ['e2e'] } });
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin/gh'), `#!/bin/sh\necho '${JSON.stringify([{ name: 'e2e', state: 'SKIPPED' }])}'\n`);
  chmodSync(path.join(dir, 'bin/gh'), 0o755);
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\nbin/\nstate/\n');
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, 'state') };
  return { dir, config, env };
}

const RENAMED = '.aidrian/config.json: "pr" is now "github": rename the key\n';

test('pr checks refuses a config.json with errors: exit 3 with the errors, never a verdict on the defaults', (t) => {
  const { dir, config, env } = renamedPolicy(t);
  const checks = () => {
    const { status, stdout, stderr } = run(['pr', 'checks', '1'], dir, env);
    return [status, stdout, stderr];
  };
  assert.deepEqual(checks(), [3, '', RENAMED]);
  config({ version: 1 });
  assert.deepEqual(checks(), [0, 'ready: 0 pass; skipped: e2e\n', ''], 'the same gh on the defaults: ready');
  config({ version: 1, github: { requiredChecks: ['e2e'] } });
  assert.deepEqual(checks(), [1, 'failing: e2e=SKIPPED (required)\n', ''], 'renamed to github: the policy applies');
});

test('every command that reads config.json stops on its errors before it acts; one that reads none still runs', (t) => {
  const { dir, env } = renamedPolicy(t);
  writeFileSync(path.join(dir, 'brief.md'), '# Handoff\n');
  const cases = [
    [['check'], 1],
    [['init'], 1],
    [['state'], 1],
    [['commit-msg', '--message', 'feat: add a thing'], 1],
    [['lint'], 1],
    [['lesson', 'list'], 1],
    [['handoff', 'check', 'brief.md'], 2],
    [['report'], 1],
    [['pr', 'await-review', '1'], 1],
    [['pr', 'checks', '1'], 3],
    [['quorum', 'roles', 'plan'], 1],
  ];
  for (const [args, code] of cases) {
    const { status, stdout, stderr } = run(args, dir, env);
    assert.deepEqual([status, stdout, stderr], [code, '', RENAMED], args.join(' '));
  }
  const worktree = run(['worktree', 'new', 'feat/x', '--plan'], dir, env);
  assert.equal(worktree.status, 1);
  assert.deepEqual(JSON.parse(worktree.stdout), {
    status: 'blocked',
    phase: 'config',
    reason: RENAMED.trimEnd(),
    next_step: 'Fix config.json; aidrian check lists every problem.',
  });
  assert.equal(run(['pr', 'disposition', '--severity', 'critical'], dir, env).status, 0, 'disposition reads no config');
});

test('bin/aidrian and bin/aidrian-knowledge run through a symlink, and a chain of them, from another folder', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['aidrian', 'aidrian-knowledge']) {
    mkdirSync(path.join(dir, 'a'), { recursive: true });
    symlinkSync(path.join(ROOT, 'plugins/aidrian/bin', name), path.join(dir, 'a', name));
    symlinkSync(path.join('a', name), path.join(dir, name));
    for (const link of [path.join(dir, 'a', name), path.join(dir, name)]) {
      const { status, stderr } = spawnSync(link, ['--help'], { cwd: EXAMPLE, encoding: 'utf8' });
      assert.equal(status, 0, `${link}: ${stderr}`);
    }
  }
});
