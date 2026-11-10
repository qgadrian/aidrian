import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideDisposition, isManifestPath, loadTable, manifestDrift, splitFlagWords, vocabulary } from '../plugins/aidrian/lib/finding-disposition.mjs';
import { isCommentLine, quietDelta } from '../plugins/aidrian/lib/review/diff.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-write.mjs');
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

// A pr-review manifest finding, with the axes of a contrived internal high, which the table makes accepted_residual.
const finding = (fields = {}) => ({ id: 'F1', specialist: 'code-reviewer', severity: 'high', likelihood: 'contrived', affects: 'internal', cost: 'bounded', disposition: 'accepted_residual', status: 'open', raised_in: 1, ...fields });

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-disposition-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('manifestDrift names a hand-set disposition with the value the axes give, and passes the tool\'s own', () => {
  assert.deepEqual(manifestDrift({ findings: [finding()] }), []);
  assert.deepEqual(manifestDrift({ findings: [finding({ disposition: 'fix_now' })] }), [{ id: 'F1', disposition: 'fix_now', expected: ['accepted_residual'] }]);
  assert.deepEqual(manifestDrift({ findings: [finding({ likelihood: undefined, affects: undefined, disposition: 'fix_now' })] }), [{ id: 'F1', disposition: 'fix_now', expected: ['needs_axis', 'acceptable_as_is'] }], 'a finding missing an axis needs one');
  assert.deepEqual(manifestDrift({ findings: [finding({ severity: 'P2' })] }), [{ id: 'F1', disposition: 'accepted_residual', expected: [] }], 'axes outside the vocabulary never pass');
  assert.deepEqual(manifestDrift({ findings: [finding({ severity: 'P2', disposition: 'invalid' })] }), [{ id: 'F1', disposition: 'invalid', expected: [] }], 'not even with the disposition the command calls them');
  assert.deepEqual(manifestDrift({ findings: [finding({ disposition: undefined }), null, 'x'] }), [], 'a finding with no disposition yet is not judged');
  assert.deepEqual(manifestDrift({}), []);
});

test('manifestDrift accepts the late-round reading of a finding\'s round, and only for its own round', () => {
  const N = loadTable().lateRoundFrom;
  const late = finding({ severity: 'low', likelihood: 'routine', affects: 'users', cost: 'trivial', disposition: 'accepted_residual', raised_in: N });
  assert.deepEqual(manifestDrift({ findings: [late] }), [], 'run with --source bot --round, as pr-review-loop runs it');
  assert.deepEqual(manifestDrift({ findings: [{ ...late, disposition: 'drop_unless_cited' }] }), [], 'run with no source, as pr-review runs it');
  assert.equal(manifestDrift({ findings: [{ ...late, raised_in: 1 }] }).length, 1, 'round 1 has no late reading');
});

test('aidrian pr disposition --manifest exits 0 on the tool\'s values, 1 on drift, and 2 on a file that is no manifest', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'pr-7.json');
  const run = () => spawnSync(CLI, ['pr', 'disposition', '--manifest', file], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ pr: 7, findings: [finding(), finding({ id: 'F2', disposition: 'fix_now' })] }));
  const drifted = run();
  assert.equal(drifted.status, 1);
  assert.deepEqual(JSON.parse(drifted.stdout), { file, findings: 2, drift: [{ id: 'F2', disposition: 'fix_now', expected: ['accepted_residual'] }] });
  writeFileSync(file, JSON.stringify({ pr: 7, findings: [finding()] }));
  assert.equal(run().status, 0);
  writeFileSync(file, '{');
  assert.equal(run().status, 2);
  writeFileSync(file, '{"pr": 7}');
  assert.deepEqual([run().status, run().stderr], [2, `aidrian pr disposition: ${file} has no findings list\n`]);
});

test('a flag variable zsh passes as one argument is split into its words', () => {
  assert.deepEqual(splitFlagWords(['--severity high --likelihood contrived', '--affects', 'internal']), ['--severity', 'high', '--likelihood', 'contrived', '--affects', 'internal']);
  assert.deepEqual(splitFlagWords(['--manifest', '/a b/pr-1.json']), ['--manifest', '/a b/pr-1.json'], 'a value is never split');
  const out = spawnSync(CLI, ['pr', 'disposition', '--severity high --likelihood contrived --affects internal'], { encoding: 'utf8' });
  assert.deepEqual([out.status, JSON.parse(out.stdout).disposition], [0, 'accepted_residual']);
});

test('isManifestPath matches a review manifest and its temporary copies, in a reviews folder only', () => {
  for (const file of ['/s/reviews/pr-42.json', '/s/reviews/pr-42.json.tmp', '/s/reviews/.pr-42.json.123.tmp']) assert.ok(isManifestPath(file), file);
  for (const file of ['/s/plans/pr-42.json', '/s/reviews/pr-42-review.md', '/s/reviews/notes.json', '/s/reviews/pr-x.json']) assert.ok(!isManifestPath(file), file);
});

test('the file-write hook refuses a Write or Edit that sets a disposition the axes do not give, and lets the rest run', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, 'reviews'));
  const file = path.join(dir, 'reviews', 'pr-9.json');
  const hook = (toolName, toolInput) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: toolName, cwd: dir, tool_input: { file_path: file, ...toolInput } }), encoding: 'utf8' });
  const text = (findings) => `${JSON.stringify({ pr: 9, findings }, null, 2)}\n`;

  const refused = hook('Write', { content: text([finding({ disposition: 'fix_now' })]) });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Blocked: this write sets a review disposition that `aidrian pr disposition` does not give the finding's axes:\n  pr-9\.json F1: "fix_now", where its axes give accepted_residual\n/);
  assert.match(refused.stderr, /change the axes, never the disposition alone/);
  assert.deepEqual([hook('Write', { content: text([finding()]) }).status], [0], 'the tool\'s value passes');
  assert.equal(hook('Write', { content: '{ not json' }).status, 0, 'text that does not parse runs');
  const invalid = hook('Write', { content: text([finding({ severity: 'P2', disposition: 'invalid' })]) });
  assert.equal(invalid.status, 2, 'axes outside the vocabulary refuse, whatever the disposition');
  assert.match(invalid.stderr, /F1: "invalid", and its axes are not in the vocabulary/);

  writeFileSync(file, text([finding()]));
  const edit = hook('Edit', { old_string: '"disposition": "accepted_residual"', new_string: '"disposition": "fix_now"' });
  assert.equal(edit.status, 2, 'an Edit is judged on the file after it');
  assert.equal(hook('Edit', { old_string: '"likelihood": "contrived"', new_string: '"likelihood": "routine"' }).status, 2, 'changing an axis alone leaves the old disposition drifting');
  assert.equal(hook('Edit', { old_string: '"status": "open"', new_string: '"status": "in_progress"' }).status, 0, 'a status write runs');

  // A finding that drifted before the write, the same way, does not stop a run recording its status.
  writeFileSync(file, text([finding({ severity: 'P2', disposition: 'invalid' }), finding({ id: 'F2' })]));
  assert.equal(hook('Edit', { old_string: '"status": "open"', new_string: '"status": "blocked"' }).status, 0, 'a status write on an old drift runs');
  assert.equal(hook('Edit', { old_string: '"severity": "P2"', new_string: '"severity": "P3"' }).status, 2, 'a changed axis is a new drift');
  const copy = path.join(dir, 'reviews', 'pr-9.json.tmp');
  const tmp = (findings) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: copy, content: text(findings) } }), encoding: 'utf8' });
  assert.equal(tmp([finding({ severity: 'P2', disposition: 'invalid', status: 'blocked' }), finding({ id: 'F2' })]).status, 0, 'a temporary copy is compared with the manifest beside it');
  assert.equal(tmp([finding({ severity: 'P2', disposition: 'invalid' }), finding({ id: 'F2', disposition: 'fix_now' })]).status, 2, 'and refuses the drift it adds');

  const elsewhere = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, 'pr-9.json'), content: text([finding({ disposition: 'fix_now' })]) } }), encoding: 'utf8' });
  assert.equal(elsewhere.status, 0, 'a file outside a reviews folder is no manifest');
});
