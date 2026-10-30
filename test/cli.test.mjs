import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, defaultBranch: 'trunk' }));
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
  assert.deepEqual(lines.filter((line) => line.startsWith('  aidrian lesson ')).map((line) => line.split(' ')[4]), ['add', 'list', 'resolve', 'update', 'stats', 'nudge']);
  assert.deepEqual(lines.filter((line) => line.startsWith('  aidrian worktree ')).map((line) => line.split(' ')[4]), ['new', 'cleanup']);
  assert.ok(lines.includes('  aidrian commit-msg (--file PATH | --message TEXT) [--project DIR]'), 'a choice in parentheses is one form');
  const lesson = lines.findIndex((line) => line.startsWith('  aidrian lesson add '));
  assert.match(lines[lesson + 1], /^ {10}\[/, 'a wrapped usage line sits deeper than the description');
  const misuse = spawnSync(CLI, ['worktree', 'bogus'], { cwd: EXAMPLE, encoding: 'utf8' });
  assert.deepEqual(misuse.stderr.split('\n').slice(0, 2), [
    'usage: aidrian worktree new BRANCH [--base REF] [--slug NAME] [--fetch] [--plan] [--reuse-existing]',
    '       aidrian worktree cleanup [plan|execute] [--min-age 24h] [--force]',
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
