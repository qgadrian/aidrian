import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { checkoutRepos, computeVerdict, namesRemote, parseCliArgs, runChecks } from '../plugins/aidrian/lib/pr-checks.mjs';

const row = (name, state) => ({ name, state });
const verdict = (rows, policy) => computeVerdict(rows, policy).verdict;

test('every check terminal and none failing is ready; a skip is named, never silent', () => {
  const result = computeVerdict([row('lint', 'SUCCESS'), row('unit', 'SUCCESS'), row('docs', 'SKIPPED')]);
  assert.deepEqual([result.verdict, result.reason], ['ready', '2 pass; skipped: docs']);
});

test('a hard failure wins over pending; pending wins over ready', () => {
  for (const state of ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
    assert.equal(verdict([row('unit', state), row('e2e', 'IN_PROGRESS')]), 'failing', state);
  }
  for (const state of ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']) {
    assert.equal(verdict([row('unit', 'SUCCESS'), row('e2e', state)]), 'pending', state);
  }
});

test('CANCELLED fails unless an ignoreCancelledChecks entry is part of the name', () => {
  const rows = [row('unit', 'SUCCESS'), row('Vercel Preview', 'CANCELLED')];
  assert.equal(verdict(rows), 'failing');
  const result = computeVerdict(rows, { ignoreCancelledChecks: ['Vercel'] });
  assert.deepEqual([result.verdict, result.skipped], ['ready', ['Vercel Preview (cancelled)']]);
});

test('required checks must exist and pass: absent is pending, skipped or cancelled is failing', () => {
  const policy = { requiredChecks: ['e2e'], ignoreCancelledChecks: ['e2e'] };
  assert.equal(computeVerdict([row('unit', 'SUCCESS')], policy).reason, '1 not terminal: e2e (required, not reported yet)');
  assert.equal(verdict([row('unit', 'SUCCESS'), row('e2e shard 1', 'SUCCESS'), row('e2e shard 2', 'IN_PROGRESS')], policy), 'pending');
  assert.equal(verdict([row('unit', 'SUCCESS'), row('e2e shard 1', 'SUCCESS'), row('e2e shard 2', 'SUCCESS')], policy), 'ready');
  assert.equal(computeVerdict([row('e2e', 'SKIPPED')], policy).reason, 'e2e=SKIPPED (required)');
  assert.equal(verdict([row('e2e', 'CANCELLED')], policy), 'failing', 'a required check is never a routine cancel');
  assert.equal(verdict([row('unit', 'SUCCESS')], {}), 'ready', 'no required checks: nothing to wait for');
});

test('conditionalChecks: once it has an entry, only a listed check may skip; any other skip is unexpected and failing', () => {
  const rows = [row('lint', 'SUCCESS'), row('db tests', 'SKIPPED'), row('docs', 'NEUTRAL')];
  assert.equal(verdict(rows, { conditionalChecks: [] }), 'ready', 'an empty list lets every skip pass, as before');
  const result = computeVerdict(rows, { conditionalChecks: ['db'] });
  assert.deepEqual(
    [result.verdict, result.reason, result.skipped, result.unexpected_skips],
    ['failing', 'unexpected skip: docs', ['db tests'], ['docs']],
  );
  assert.equal(verdict(rows, { conditionalChecks: ['db', 'docs'] }), 'ready');
  assert.equal(verdict([row('docs', 'SKIPPED'), row('unit', 'IN_PROGRESS')], { conditionalChecks: ['db'] }), 'failing', 'a skip is final');
  const required = computeVerdict([row('e2e', 'SKIPPED')], { requiredChecks: ['e2e'], conditionalChecks: ['e2e'] });
  assert.deepEqual([required.verdict, required.reason], ['failing', 'e2e=SKIPPED (required)'], 'required wins over conditional');
});

test('parseCliArgs reads a number, #number, -R, and --json, and reports anything else', () => {
  assert.deepEqual(parseCliArgs(['#12', '-R', 'acme/notes', '--json']), { repo: 'acme/notes', asJson: true, prNumber: '12', unknown: undefined, usage: null });
  assert.equal(parseCliArgs(['--watch']).unknown, '--watch');
  for (const args of [['12', '-R'], ['12', '-R', '--json'], ['12', '--repo', '-x'], ['12', '--repo=']]) {
    assert.match(parseCliArgs(args).usage ?? '', /needs owner\/repo/, args.join(' '));
  }
});

// A forge facade whose `checks` answers with `rows`, or runs `rows` when it is a function.
const forgeWith = (rows) => ({ checks: (...given) => (typeof rows === 'function' ? rows(...given) : rows) });
const identity = (value) => ({ host: 'github.com', path: value });

test('runChecks exits by verdict, reads the rows of a pending check, and exits 3 on errors', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  assert.equal(runChecks(['7'], config, forgeWith([row('e2e', 'SUCCESS')])), 0);
  assert.equal(runChecks([], config, forgeWith([row('e2e', 'FAILURE')])), 1);
  // The facade reads the rows gh prints while it exits 8 for a pending check (test/forge-github.test.mjs).
  assert.equal(runChecks([], config, forgeWith([row('e2e', 'PENDING')])), 2);
  assert.equal(runChecks([], config, forgeWith([])), 3);
  assert.equal(runChecks(['-R', 'acme/notes'], config, forgeWith([])), 3);
  assert.equal(runChecks([], config, forgeWith(() => { throw new Error('gh: not found'); })), 3);
  assert.deepEqual(lines.slice(0, 3), ['ready: 1 pass', 'failing: e2e=FAILURE', 'pending: 1 not terminal: e2e']);
  assert.equal(lines.at(-1), 'error: could not read the checks with gh (gh: not found)');
});

test('-R works only for a remote of this checkout, whose config.json holds the policy; another repository is an error', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  const calls = [];
  const gh = forgeWith((...given) => (calls.push(given), [row('e2e', 'SUCCESS')]));
  const remotes = () => [identity('acme/notes'), identity('upstream-org/notes')];
  assert.equal(runChecks(['7', '-R', 'Acme/Notes'], config, gh, remotes), 0);
  assert.equal(runChecks(['7', '-R', 'github.com/upstream-org/notes'], config, gh, remotes), 0, 'a fork upstream is the same project');
  assert.deepEqual(calls.at(-1), ['7', { repo: 'github.com/upstream-org/notes' }], 'the -R value goes to the forge as given');
  const before = calls.length;
  assert.equal(runChecks(['7', '-R', 'other/app'], config, gh, remotes), 3);
  assert.equal(calls.length, before, 'gh is never asked about another repository');
  assert.equal(lines.at(-1), "error: other/app is not a remote of this checkout, and the check policy comes from this checkout's config.json: " +
    'run aidrian pr checks from a checkout of other/app');
  assert.equal(runChecks(['7'], config, gh, () => []), 0, 'without -R, gh reads the current repository');
});

test('namesRemote reads -R values and remote URLs to one repository; checkoutRepos lists a checkout\'s remotes', (t) => {
  for (const value of ['acme/notes', 'github.com/Acme/notes', 'https://github.com/acme/notes.git', 'git@github.com:acme/notes.git',
    'ssh://git@github.com/acme/notes/']) {
    assert.equal(namesRemote(value, [identity('acme/notes')]), true, value);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-pr-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:me/notes.git');
  git('remote', 'add', 'upstream', 'https://github.com/acme/notes');
  assert.deepEqual(checkoutRepos(dir).sort((a, b) => a.path.localeCompare(b.path)), [identity('acme/notes'), identity('me/notes')]);
  assert.deepEqual(checkoutRepos(tmpdir()), [], 'outside a checkout: no remotes, so any -R is refused');
});

test('-R compares the host and the whole path: a namespaced repository on another host is another repository', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-pr-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://gitlab.com/a/sub/project.git');
  const remotes = checkoutRepos(dir);
  assert.deepEqual(remotes, [{ host: 'gitlab.com', path: 'a/sub/project' }]);
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  const forge = forgeWith([row('e2e', 'SUCCESS')]);
  const checks = (repo) => runChecks(['7', '-R', repo], config, forge, () => remotes);
  assert.equal(checks('gitlab.com/a/sub/project'), 0);
  assert.equal(checks('https://GitLab.com/a/sub/project.git'), 0);
  assert.equal(checks('other.host/b/sub/project'), 3, 'another host and another namespace: another repository');
  assert.equal(checks('other.host/a/sub/project'), 3, 'the same path on another host: another repository');
  assert.equal(checks('gitlab.com/b/sub/project'), 3, 'the same host, another namespace: another repository');
  assert.equal(namesRemote('gitlab.com/a/sub/project', [{ host: 'other.host', path: 'b/sub/project' }]), false);
  assert.equal(namesRemote('acme/notes', [{ host: 'ghe.acme.io', path: 'acme/notes' }]), true, 'a bare owner/repo names no host');
  assert.equal(namesRemote('github.com/acme/notes', [{ host: 'ghe.acme.io', path: 'acme/notes' }]), false, 'a named host must match');
  assert.match(lines.at(-1), /gitlab\.com\/b\/sub\/project is not a remote of this checkout/u);
});

test('-R still names a GitHub remote reached through an SSH alias, ssh.github.com, or a path on the disk, and never with spaces', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  const forge = forgeWith([row('e2e', 'SUCCESS')]);
  const checksAt = (remote) => (repo) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-pr-checks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', remote]]) assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
    const remotes = checkoutRepos(dir);
    return runChecks(['7', '-R', repo], config, forge, () => remotes);
  };
  // A host with no dot is a name from ~/.ssh/config: it hides the real host, so the path decides.
  const alias = checksAt('git@github-work:acme/notes.git');
  assert.equal(alias('github.com/acme/notes'), 0, 'an SSH alias, -R with the host');
  assert.equal(alias('acme/notes'), 0, 'an SSH alias, a bare -R');
  assert.equal(alias('github.com/acme/other'), 3, 'an SSH alias, another path');
  const port443 = checksAt('ssh://git@ssh.github.com:443/acme/notes.git');
  assert.equal(port443('github.com/acme/notes'), 0, 'ssh.github.com is github.com');
  assert.equal(port443('ghe.acme.io/acme/notes'), 3, 'a dotted host that differs is still another repository');
  for (const local of ['/srv/git/acme/notes.git', 'file:///srv/git/acme/notes.git']) {
    assert.equal(checksAt(local)('acme/notes'), 0, `${local}: its last two parts`);
    assert.equal(checksAt(local)('github.com/acme/notes'), 0, `${local}: no host to compare`);
  }
  const plain = checksAt('git@github.com:acme/notes.git');
  for (const spaced of [' acme/notes', 'acme/notes ']) assert.equal(plain(spaced), 3, JSON.stringify(spaced));
  assert.equal(checksAt('https://gitlab.com/a/sub/project.git')('other.host/b/sub/project'), 3);
  // A backslash path is split on `/` and `:` alone, as the owner/repo key always read it: it names no owner/repo.
  assert.equal(checksAt('C:\\repos\\acme\\notes.git')('acme/notes'), 3, 'a Windows backslash remote');
});
