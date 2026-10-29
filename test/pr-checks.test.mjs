import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { checkoutRepos, computeVerdict, parseCliArgs, repoKey, runChecks } from '../plugins/aidrian/lib/pr-checks.mjs';

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
  assert.deepEqual(parseCliArgs(['#12', '-R', 'acme/notes', '--json']), { repo: 'acme/notes', asJson: true, prNumber: '12', unknown: undefined });
  assert.equal(parseCliArgs(['--watch']).unknown, '--watch');
});

test('runChecks exits by verdict, reads JSON from a gh that exits non-zero, and exits 3 on errors', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  const gh = (rows) => () => JSON.stringify(rows);
  assert.equal(runChecks(['7'], config, gh([row('e2e', 'SUCCESS')])), 0);
  assert.equal(runChecks([], config, gh([row('e2e', 'FAILURE')])), 1);
  const pendingExit = () => {
    throw Object.assign(new Error('exit 8'), { stdout: JSON.stringify([row('e2e', 'PENDING')]) });
  };
  assert.equal(runChecks([], config, pendingExit), 2);
  assert.equal(runChecks([], config, gh([])), 3);
  assert.equal(runChecks(['-R', 'acme/notes'], config, gh([])), 3);
  assert.equal(runChecks([], config, () => { throw new Error('gh: not found'); }), 3);
  assert.deepEqual(lines.slice(0, 3), ['ready: 1 pass', 'failing: e2e=FAILURE', 'pending: 1 not terminal: e2e']);
});

test('-R works only for a remote of this checkout, whose config.json holds the policy; another repository is an error', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { github: { ...DEFAULTS.github, requiredChecks: ['e2e'] } };
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return JSON.stringify([row('e2e', 'SUCCESS')]);
  };
  const remotes = () => ['acme/notes', 'upstream-org/notes'];
  assert.equal(runChecks(['7', '-R', 'Acme/Notes'], config, gh, remotes), 0);
  assert.equal(runChecks(['7', '-R', 'github.com/upstream-org/notes'], config, gh, remotes), 0, 'a fork upstream is the same project');
  assert.deepEqual(calls.at(-1), ['pr', 'checks', '7', '--repo', 'github.com/upstream-org/notes', '--json', 'name,state']);
  const before = calls.length;
  assert.equal(runChecks(['7', '-R', 'other/app'], config, gh, remotes), 3);
  assert.equal(calls.length, before, 'gh is never asked about another repository');
  assert.equal(lines.at(-1), "error: other/app is not a remote of this checkout, and the check policy comes from this checkout's config.json: " +
    'run aidrian pr checks from a checkout of other/app');
  assert.equal(runChecks(['7'], config, gh, () => []), 0, 'without -R, gh reads the current repository');
});

test('repoKey reads owner/repo from -R values and remote URLs; checkoutRepos lists a checkout\'s remotes', (t) => {
  for (const value of ['acme/notes', 'github.com/Acme/notes', 'https://github.com/acme/notes.git', 'git@github.com:acme/notes.git',
    'ssh://git@github.com/acme/notes/']) {
    assert.equal(repoKey(value), 'acme/notes', value);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-pr-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:me/notes.git');
  git('remote', 'add', 'upstream', 'https://github.com/acme/notes');
  assert.deepEqual(checkoutRepos(dir).sort(), ['acme/notes', 'me/notes']);
  assert.deepEqual(checkoutRepos(tmpdir()), [], 'outside a checkout: no remotes, so any -R is refused');
});
