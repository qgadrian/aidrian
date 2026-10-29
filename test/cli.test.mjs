import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

const run = (args, cwd = EXAMPLE) => spawnSync(CLI, args, { cwd, encoding: 'utf8' });

test('config check prints ok in the example consumer, from a subfolder, and with --project', () => {
  for (const [args, cwd] of [[['config', 'check']], [['config', 'check'], path.join(EXAMPLE, 'src')], [['config', 'check', '--project', EXAMPLE], ROOT]]) {
    const { status, stdout, stderr } = run(args, cwd);
    assert.deepEqual([status, stdout, stderr], [0, 'ok\n', ''], args.join(' '));
  }
});

test('config check fails with every error, and names the path when there is no config', (t) => {
  // realpath: on macOS the temp folder is behind a symlink, and the command prints the real path.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const none = run(['config', 'check'], dir);
  assert.equal(none.status, 1);
  assert.equal(none.stderr, `no .aidrian/config.json at or above ${dir}\n`);

  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ buckets: ['kb'], extra: 1, pr: { maxReviewRounds: 'ten' } }));
  const bad = run(['config', 'check'], dir);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(
    bad.stderr,
    '.aidrian/config.json: unknown key "extra"\n.aidrian/config.json: "pr.maxReviewRounds" must be a whole number above 0\n',
  );
});

test('a missing or unknown group or command, an unknown option, or a stray argument prints the usage and exits 1', () => {
  const cases = [
    [[], null],
    [['nope'], /\n\nunknown group: nope\n$/],
    [['config'], /\n\nunknown command: config\n$/],
    [['config', 'nope'], /\n\nunknown command: config nope\n$/],
    [['config', 'check', '--bogus'], /\n\nUnknown option '--bogus'/],
    [['config', 'check', '--project'], /\n\nOption '--project <value>' argument missing/],
    [['config', 'check', 'stray'], /\n\nUnexpected argument 'stray'/],
  ];
  for (const [args, expected] of cases) {
    const { status, stdout, stderr } = run(args);
    assert.equal(status, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^usage: aidrian <group> <command> \[args\]\n\n {2}aidrian config check \[--project DIR\]\n/);
    if (expected) assert.match(stderr, expected, args.join(' '));
  }
});
