import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { decideDisposition, loadTable, vocabulary } from '../plugins/aidrian/lib/finding-disposition.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const d = (i) => decideDisposition(i).disposition;

test('a contrived payments race is a residual, not a fix', () => {
  assert.equal(d({ severity: 'high', likelihood: 'contrived', affects: 'revenue' }), 'accepted_residual');
});

test('a routine user-facing break outranks it even at medium severity', () => {
  assert.equal(d({ severity: 'medium', likelihood: 'routine', affects: 'users' }), 'fix_now');
});

test('critical is always fix_now regardless of axis', () => {
  assert.equal(d({ severity: 'critical', likelihood: 'contrived', affects: 'internal' }), 'fix_now');
});

test('a contrived feature-gate bypass on an internal surface is a residual', () => {
  assert.equal(d({ severity: 'high', likelihood: 'contrived', affects: 'internal' }), 'accepted_residual');
});

test('plausible revenue impact is fixed at high and medium: money moving is never a residual by default', () => {
  assert.equal(d({ severity: 'high', likelihood: 'plausible', affects: 'revenue' }), 'fix_now');
  assert.equal(d({ severity: 'medium', likelihood: 'plausible', affects: 'revenue' }), 'fix_now');
});

test('the owner\'s example: same revenue surface, opposite dispositions by likelihood and cost', () => {
  // A technically skilled party must discover a weak entry door and exploit it to flip a DB flag.
  assert.equal(d({ severity: 'high', likelihood: 'contrived', affects: 'revenue', cost: 'structural' }), 'accepted_residual');
  // A toggle that should be disabled is not: obvious, and a quick fix.
  assert.equal(d({ severity: 'medium', likelihood: 'routine', affects: 'revenue', cost: 'trivial' }), 'fix_now');
});

test('a trivial fix is taken even for a contrived finding; cost defaults to bounded', () => {
  assert.equal(d({ severity: 'high', likelihood: 'contrived', affects: 'revenue', cost: 'trivial' }), 'fix_now');
  assert.equal(d({ severity: 'high', likelihood: 'contrived', affects: 'revenue' }), 'accepted_residual');
  assert.equal(d({ severity: 'medium', likelihood: 'plausible', affects: 'users', cost: 'structural' }), 'accepted_residual');
  assert.equal(d({ severity: 'high', likelihood: 'plausible', affects: 'users', cost: 'structural' }), 'fix_now');
});

test('low severity is dropped before any residual rule can turn it into PR-body prose', () => {
  assert.equal(d({ severity: 'low', likelihood: 'contrived', affects: 'internal' }), 'drop_unless_cited');
  assert.equal(d({ severity: 'nit', likelihood: 'routine', affects: 'users' }), 'drop_unless_cited');
});

test('the PR-feedback severity scale maps onto the reviewer scale', () => {
  assert.equal(d({ severity: 'blocker', likelihood: 'contrived', affects: 'internal' }), 'fix_now');
  assert.equal(d({ severity: 'major', likelihood: 'plausible', affects: 'users' }), 'fix_now');
  assert.equal(d({ severity: 'minor', likelihood: 'plausible', affects: 'internal' }), 'accepted_residual');
});

test('every vocabulary word and every disposition has a definition', () => {
  for (const [word, entry] of Object.entries(vocabulary())) {
    const def = typeof entry === 'string' ? entry : entry?.definition;
    assert.ok(typeof def === 'string' && def.length > 10, `${word} lacks a definition`);
  }
});

test('--vocab defines the severity scale and says what a customer-path residual is: visible, never refused', () => {
  const v = vocabulary();
  for (const severity of loadTable().severities) assert.ok(v[severity], `${severity} is missing from --vocab`);
  assert.match(v.critical, /skips the likelihood check/, 'critical is the one grade the likelihood axis cannot demote');
  assert.match(v.accepted_residual, /made visible/);
  assert.match(v.accepted_residual, /never answered with a refusal/);
});

test('every likelihood and cost word carries calibration examples so sessions classify alike', () => {
  const t = loadTable();
  for (const word of [...t.likelihoods, ...t.costs]) {
    assert.ok(Array.isArray(t.examples[word]) && t.examples[word].length >= 1, `${word} lacks an example`);
  }
});

test('every reachable combination resolves to a defined disposition', () => {
  const t = loadTable();
  const dispositions = new Set(Object.keys(t.definitions));
  for (const severity of t.severities) for (const likelihood of t.likelihoods) for (const affects of t.affects) for (const cost of t.costs) {
    const out = d({ severity, likelihood, affects, cost });
    assert.ok(dispositions.has(out), `${severity}/${likelihood}/${affects}/${cost} -> ${out} is undefined`);
  }
});

test('low severity drops unless a rule is cited', () => {
  assert.equal(d({ severity: 'low', likelihood: 'plausible', affects: 'users' }), 'drop_unless_cited');
});

test('a bot finding with no axis is acceptable as-is; a human one needs the axis', () => {
  assert.equal(d({ severity: 'high', source: 'bot' }), 'acceptable_as_is');
  assert.equal(d({ severity: 'high' }), 'needs_axis');
});

test('unknown vocabulary is rejected, never guessed', () => {
  assert.equal(d({ severity: 'P2', likelihood: 'routine', affects: 'users' }), 'invalid');
});

test('the table vocabulary is closed and every rule uses it', () => {
  const t = loadTable();
  for (const r of t.rules) {
    for (const [k, vs] of Object.entries(r.when)) {
      const allowed = { severity: t.severities, likelihood: t.likelihoods, affects: t.affects, cost: t.costs, phase: t.phases }[k];
      assert.ok(allowed, `unknown axis ${k}`);
      for (const v of vs) assert.ok(allowed.includes(v), `${k}=${v} not in vocabulary`);
    }
  }
});

test('from bot review round 5, a medium plausible bot finding for users or operators is a residual', () => {
  const finding = { severity: 'medium', likelihood: 'plausible', affects: 'operators', source: 'bot' };
  assert.equal(d({ ...finding, round: 4 }), 'fix_now');
  assert.equal(d({ ...finding, round: 5 }), 'accepted_residual');
  assert.equal(d({ ...finding, round: '9' }), 'accepted_residual', 'the CLI passes the round as a string');
  assert.equal(d(finding), 'fix_now', 'no round given: early');
  assert.equal(d({ ...finding, source: undefined }), 'fix_now', 'a human finding never turns late');
  assert.equal(d({ ...finding, source: undefined, round: 9 }), 'invalid', 'a round on a human finding is rejected');
  assert.equal(d({ ...finding, source: 'codex', round: 9 }), 'invalid', 'a source other than bot is never guessed');
});

test('late rounds never relax revenue, high, routine or trivial-cost findings', () => {
  const late = { source: 'bot', round: 12 };
  assert.equal(d({ ...late, severity: 'medium', likelihood: 'plausible', affects: 'revenue' }), 'fix_now');
  assert.equal(d({ ...late, severity: 'high', likelihood: 'plausible', affects: 'users' }), 'fix_now');
  assert.equal(d({ ...late, severity: 'medium', likelihood: 'routine', affects: 'users' }), 'fix_now');
  assert.equal(d({ ...late, severity: 'medium', likelihood: 'plausible', affects: 'operators', cost: 'trivial' }), 'fix_now');
});

test('an unreadable round is rejected, never guessed', () => {
  assert.equal(d({ severity: 'medium', likelihood: 'plausible', affects: 'users', source: 'bot', round: 0 }), 'invalid');
  assert.equal(d({ severity: 'medium', likelihood: 'plausible', affects: 'users', source: 'bot', round: 'five' }), 'invalid');
});

test('the command prints the decision, exits 2 on an unknown word, and --vocab prints every definition', () => {
  const run = (args) => spawnSync(CLI, ['pr', 'disposition', ...args], { encoding: 'utf8' });
  const fix = run(['--severity', 'high', '--likelihood', 'plausible', '--affects', 'users']);
  assert.deepEqual([fix.status, JSON.parse(fix.stdout).disposition], [0, 'fix_now']);
  assert.equal(run(['--severity', 'P2', '--likelihood', 'routine', '--affects', 'users']).status, 2);
  assert.equal(JSON.parse(run(['--vocab']).stdout).users, loadTable().definitions.users);
});
