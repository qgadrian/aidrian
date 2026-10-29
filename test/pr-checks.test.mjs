import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { computeVerdict, parseCliArgs, runChecks } from '../plugins/aidrian/lib/pr-checks.mjs';

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

test('parseCliArgs reads a number, #number, -R, and --json, and reports anything else', () => {
  assert.deepEqual(parseCliArgs(['#12', '-R', 'acme/notes', '--json']), { repo: 'acme/notes', asJson: true, prNumber: '12', unknown: undefined });
  assert.equal(parseCliArgs(['--watch']).unknown, '--watch');
});

test('runChecks exits by verdict, reads JSON from a gh that exits non-zero, and exits 3 on errors', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { pr: { ...DEFAULTS.pr, requiredChecks: ['e2e'] } };
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
