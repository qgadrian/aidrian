import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { decideDisposition, loadTable, vocabulary } from '../plugins/aidrian/lib/finding-disposition.mjs';
import { isCommentLine, quietDelta } from '../plugins/aidrian/lib/review/diff.mjs';

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
  for (const severity of t.lateRound.severities) assert.ok(t.severities.includes(severity), `lateRound severity ${severity} not in vocabulary`);
  assert.ok(t.definitions[t.lateRound.disposition], 'the lateRound disposition has a definition');
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

test('from review round N, a low finding is a residual whatever its cost or citation; a bot low with no axes too', () => {
  const N = loadTable().lateRoundFrom;
  const low = { severity: 'low', likelihood: 'routine', affects: 'users', cost: 'trivial', source: 'bot' };
  assert.equal(d({ ...low, round: N - 1 }), 'drop_unless_cited', 'before N a cited low is still a fix');
  assert.equal(d({ ...low, round: N }), 'accepted_residual');
  assert.deepEqual([d({ ...low, round: 7 }), decideDisposition({ ...low, round: 7 }).rule], ['accepted_residual', 'lateRound']);
  assert.equal(d({ severity: 'nit', source: 'bot', round: 7 }), 'accepted_residual', 'an exec finding has no axes: the table decides it unaided');
  assert.equal(d({ severity: 'low', likelihood: 'routine', affects: 'users', round: 7 }), 'invalid', 'a person\'s round is still refused');
  assert.equal(d({ severity: 'medium', likelihood: 'plausible', affects: 'revenue', source: 'bot', round: 9 }), 'fix_now', 'nothing above low changes');
  const out = spawnSync(CLI, ['pr', 'disposition', '--severity', 'low', '--cost', 'trivial', '--source', 'bot', '--round', '7'], { encoding: 'utf8' });
  assert.deepEqual([out.status, JSON.parse(out.stdout).disposition, JSON.parse(out.stdout).rule], [0, 'accepted_residual', 'lateRound']);
});

test('a delta is quiet only when every file is prose, a test that only gained lines, or a comment-only code change', () => {
  const prose = (file) => file.startsWith('docs/');
  const test_ = (file) => /\.test\./u.test(file);
  const quiet = (file, added = [], removed = [], status = 'M') => quietDelta({ changes: [{ file, status }], addedLines: added.length ? { [file]: added } : {}, removedLines: removed.length ? { [file]: removed } : {} }, { prose, test: test_ });
  assert.equal(quiet('docs/x.md', ['hello']).quiet, true);
  assert.equal(quiet('test/a.test.mjs', ['assert.ok(true);']).quiet, true);
  assert.deepEqual(quiet('test/a.test.mjs', ['x'], ['assert.ok(y);']), { quiet: false, loud: ['test/a.test.mjs'] }, 'a removed test line may weaken it');
  assert.equal(quiet('test/a.test.mjs', ['test.only(\'x\', () => {});']).quiet, false, 'a focus or skip marker weakens the rest of the suite');
  assert.equal(quiet('test/a.test.mjs', [], [], 'D').quiet, false, 'a deleted test is loud');
  assert.equal(quiet('src/a.mjs', ['// note', '/**', ' * doc', ' */', '']).quiet, true);
  assert.equal(quiet('src/a.mjs', ['// eslint-disable-next-line']).quiet, false, 'a tool directive is behaviour');
  assert.equal(quiet('src/a.mjs', ['/* start']).quiet, false, 'a comment left open hides the code after it');
  assert.equal(quiet('src/a.mjs', [], [' */']).quiet, false, 'a removed close opens the code after it to the comment');
  assert.equal(quiet('src/a.mjs', ['/* note */ run();']).quiet, false, 'code after a closed comment is code');
  assert.equal(quiet('src/a.mjs', ['*items() { yield 1; }']).quiet, false, 'a generator method is no comment interior');
  assert.equal(quiet('src/a.go', [' * p = 1']).quiet, false, 'block interiors are not comments in Go');
  assert.equal(quiet('src/a.go', ['//go:build linux']).quiet, false, 'a build constraint is behaviour');
  assert.equal(quiet('src/a.py', ['#!/usr/bin/env python2']).quiet, false, 'a shebang picks the interpreter');
  assert.equal(quiet('src/a.py', ['# why it waits']).quiet, true);
  assert.equal(quiet('src/a.lua', ['--[[']).quiet, false);
  assert.equal(quiet('src/a.wasm').quiet, false, 'an unknown extension with no lines is loud');
  assert.equal(quiet('src/a.mjs', ['const x = 1;']).quiet, false);
  assert.equal(quiet('src/a.mjs', ['// a'], [], 'D').quiet, false, 'a deleted file is loud');
  assert.equal(quiet('src/a.mjs').quiet, false, 'a file with no changed lines, such as a mode change, is loud');
  assert.equal(quietDelta({ changes: [], addedLines: {}, removedLines: {} }, { prose, test: test_ }).quiet, false, 'an empty change list is not quiet');
  const hunks = { 'src/a.mjs': [{ added: ['/* a'], removed: [] }, { added: [' */'], removed: [] }] };
  assert.equal(quietDelta({ changes: [{ file: 'src/a.mjs', status: 'M' }], addedLines: { 'src/a.mjs': ['/* a', ' */'] }, removedLines: {}, hunks }, { prose, test: test_ }).quiet, false, 'a comment opened in one hunk and closed in another hides the code between');
  assert.equal(quiet('docs/x.md', [], ['hello'], 'D').quiet, false, 'a deleted doc is loud, prose or not');
  assert.equal(quiet('src/a.php', ["#[IsGranted('ROLE_ADMIN')]"]).quiet, false, 'a PHP 8 attribute is code');
  assert.equal(quiet('src/a.php', [], ["#[Route('/admin')]"]).quiet, false, 'so is removing one');
  assert.equal(quiet('src/a.php', ['// why']).quiet, true);
  for (const file of ['src/a.css', 'src/a.scss', 'src/a.less']) {
    assert.equal(quiet(file, ['* { margin: 0 }']).quiet, false, `the universal selector is a rule in ${file}`);
    assert.equal(quiet(file, ['* + p { margin: 0 }']).quiet, false);
    assert.equal(quiet(file, ['/* spacing */']).quiet, true);
  }
  // By design, not a hole: a `#` line inside a Python string reads as a comment. The rules decide only whether a push
  // counts against the round cap; the passes the push touches still re-review it, so the miss costs a round of cap.
  assert.equal(quiet('src/a.py', ['# inside a triple-quoted string']).quiet, true);
  assert.equal(isCommentLine('src/a.ts', '/// <reference path="x" />'), false);
  assert.equal(isCommentLine('src/a.rs', '/// docs'), true);
});
