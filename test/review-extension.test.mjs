import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { DEFAULT_REVIEWER, exitCodeFor, runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { extensionSummary, formatExtensions } from '../plugins/aidrian/lib/report-reviews.mjs';
import {
  askQuestion, atCap, BLOAT_MIN_LINES, botRounds, buildHistory, findingTitle, grantedRounds, normalizeTitle, parseExtend, recordHuman, recordVerdict, revalidate, runExtend, signals,
} from '../plugins/aidrian/lib/review/extension.mjs';
import { untextedBlocking } from '../plugins/aidrian/lib/review/publish.mjs';
import { emptyState, HELD_LINE, heldRevision, readLocalState, stateFromComment, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { approved, check, mismatch, transcriptAnswers } from '../plugins/aidrian/lib/rules/review-extend.mjs';

// A summary written on a private repository, from inside the team, whose checks pass every string: these tests read
// the whole record back (test/review-state.test.mjs holds what other readings post).
const OPEN = { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } };
// What a fake forge answers for a private repository and a pull request from inside the team (publish.mjs readReading).
const PRIVATE_PR = { visibility: () => 'PRIVATE' };
const INSIDE = { author_association: 'MEMBER', base: { ref: 'main', repo: { fork: false } } };

const finding = (file, line, title) => ({ file, line, title });
const round = (n, head, findings, fix = null) => ({ round: n, head, open: findings.length, findings, fix });

test('signals: converging is fewer open findings than the round before, and anything else is a red flag', () => {
  const fewer = signals({ rounds: [round(1, 'a', [finding('x.js', 1, 'one'), finding('y.js', 9, 'two')]), round(2, 'b', [finding('z.js', 40, 'three')])] });
  assert.equal(fewer.converging, true);
  assert.ok(!fewer.reasons.some((reason) => reason.startsWith('not converging')));
  const same = signals({ rounds: [round(1, 'a', [finding('x.js', 1, 'first problem')]), round(2, 'b', [finding('z.js', 40, 'another thing')])] });
  assert.equal(same.converging, false);
  assert.match(same.reasons[0], /^not converging: round 2 left 1 open finding, round 1 left 1$/u);
  assert.equal(signals({ rounds: [round(1, 'a', [])] }).converging, null, 'one round has no trend');
});

test('signals: looping is a finding back at the same place, or under the same title, after a fix', () => {
  const place = signals({ rounds: [round(1, 'a', [finding('src/a.js', 10, 'null check missing'), finding('src/b.js', 1, 'other')]), round(2, 'b', [{ ...finding('src/a.js', 12, 'race on save'), id: 'R2-3' }])] });
  assert.deepEqual([place.looping, place.evidence.looping[0].match, place.evidence.looping[0].earlier_round, place.evidence.looping[0].id], [true, 'place', 1, 'R2-3']);
  // A reason names the finding by its id, never by its title.
  assert.match(place.reasons.find((reason) => reason.startsWith('looping')), /such as R2-3 at src\/a\.js:12 in round 2, first in round 1/u);
  assert.doesNotMatch(place.reasons.find((reason) => reason.startsWith('looping')), /race on save/u);
  const title = signals({ rounds: [round(1, 'a', [finding('src/a.js', 10, '**Guard the `refund` total**'), finding('q.js', 1, 'q')]), round(2, 'b', [finding('src/c.js', 99, 'guard the refund total')])] });
  assert.deepEqual([title.looping, title.evidence.looping[0].match], [true, 'title']);
  const fresh = signals({ rounds: [round(1, 'a', [finding('src/a.js', 10, 'null check'), finding('q.js', 1, 'q')]), round(2, 'b', [finding('src/a.js', 30, 'race on save')])] });
  assert.equal(fresh.looping, false, 'a new finding in the same file, far away, is not the same place');
  const noFix = signals({ rounds: [round(1, 'a', [finding('src/a.js', 10, 'null check'), finding('q.js', 1, 'q')]), round(2, 'a', [finding('src/a.js', 10, 'null check')])] });
  assert.equal(noFix.looping, false, 'the same head again had no fix between');
  assert.equal(signals({ rounds: [{ round: 1, head: 'a', open: 2, findings: null }, { round: 2, head: 'b', open: 1, findings: null }] }).looping, null, 'counts alone cannot tell');
});

test('signals: drifting is a later finding outside the files the pull request first changed', () => {
  const rounds = [round(1, 'a', [finding('src/a.js', 1, 'one'), finding('lib/caller.js', 5, 'two')]), round(2, 'b', [finding('src/new-helper.js', 3, 'three')])];
  const drift = signals({ rounds, originalFiles: ['src/a.js'] });
  assert.deepEqual([drift.drifting, drift.evidence.drifting.map((each) => each.file)], [true, ['src/new-helper.js']]);
  assert.match(drift.reasons.find((reason) => reason.startsWith('drifting')), /after round 1 sit outside the files the pull request first changed, such as src\/new-helper\.js/u);
  const inside = signals({ rounds, originalFiles: ['src/a.js', 'src/new-helper.js'] });
  assert.equal(inside.drifting, false, 'round 1 may name a caller; only later rounds drift');
  assert.equal(signals({ rounds }).drifting, null, 'no original diff, no verdict');
});

test('signals: bloating is fixes adding more than half the first diff, and never under the line floor', () => {
  const rounds = (added) => [round(1, 'a', [finding('a.js', 1, 'x'), finding('a.js', 50, 'y')], { added, removed: 0, files: ['a.js'] }), round(2, 'b', [finding('a.js', 90, 'z')], { added: 0, removed: 0, files: [] })];
  const big = signals({ rounds: rounds(120), originalAdded: 200 });
  assert.deepEqual([big.bloating, big.evidence.bloating], [true, { fix_added: 120, fix_added_all: 120, original_added: 200, limit: 100 }]);
  assert.match(big.reasons.find((reason) => reason.startsWith('bloating')), /added 120 lines of code, past 100 \(50% of the 200 lines/u);
  assert.equal(signals({ rounds: rounds(90), originalAdded: 200 }).bloating, false);
  assert.equal(signals({ rounds: rounds(BLOAT_MIN_LINES), originalAdded: 10 }).bloating, false, 'a small change may need a fix its own size');
  assert.equal(signals({ rounds: rounds(BLOAT_MIN_LINES + 1), originalAdded: 10 }).bloating, true);
});

test('signals: doc lines a fix adds are no bloat; only code_added counts', () => {
  const docs = [round(1, 'a', [finding('a.md', 1, 'x')], { added: 601, code_added: 0, removed: 0, files: ['a.md'] }), round(2, 'b', [], { added: 0, code_added: 0, removed: 0, files: [] })];
  const read = signals({ rounds: docs, originalAdded: 454 });
  assert.deepEqual([read.bloating, read.evidence.bloating], [false, { fix_added: 0, fix_added_all: 601, original_added: 454, limit: 227 }]);
});

test('signals: a history with no readable signal stops', () => {
  const blind = signals({ rounds: [{ round: 1, head: null, open: null, findings: null, fix: null }] });
  assert.deepEqual(blind.unknown, ['converging', 'looping', 'drifting', 'bloating']);
  assert.match(blind.reasons.at(-1), /^no signal could be read/u);
});

test('titles: markup, badges, and word order do not make two titles different', () => {
  assert.equal(normalizeTitle('**<sub>![P1 Badge](https://x)</sub> Guard the `refund` total**'), normalizeTitle('total: guard the refund'));
  assert.equal(findingTitle('**<sub><sub>![P2 Badge](https://img)</sub></sub>  Keep the cap**\n\nbody'), 'Keep the cap');
  const rounds = botRounds(
    [{ id: 2, user: { login: 'bot' }, submitted_at: '2026-01-02', commit_id: 'bbb' }, { id: 1, user: { login: 'bot' }, submitted_at: '2026-01-01', commit_id: 'aaa' }, { id: 3, user: { login: 'person' }, submitted_at: '2026-01-03' }],
    [{ pull_request_review_id: 1, path: 'a.js', line: 4, body: 'One' }, { pull_request_review_id: 1, path: 'a.js', line: 4, body: 'reply', in_reply_to_id: 9 }, { pull_request_review_id: 2, path: 'b.js', original_line: 7, body: 'Two' }],
    'bot',
  );
  assert.deepEqual(rounds, [
    { round: 1, head: 'aaa', open: 1, findings: [{ title: 'One', file: 'a.js', line: 4 }] },
    { round: 2, head: 'bbb', open: 1, findings: [{ title: 'Two', file: 'b.js', line: 7 }] },
  ]);
});

const passing = () => ({ rounds: [round(1, 'a', [finding('a.js', 1, 'one'), finding('a.js', 50, 'two')]), round(2, 'b', [finding('a.js', 90, 'three')])], originalFiles: ['a.js'], originalAdded: 10, files: ['a.js'] });

test('atCap: off, and the ceiling, stop without reading the history; a grant counts only as its mode allows', () => {
  const unread = () => assert.fail('the history is not read');
  const state = emptyState(7, 'o/r');
  assert.deepEqual(atCap({ state, source: 'plan', round: 3, head: 'h', policy: { mode: 'off', max: 2 }, history: unread, pr: 7 }), { status: 'round_limit', extension: { status: 'off', mode: 'off' } });
  state.extensions = [{ source: 'plan', round: 3, status: 'granted', by: 'judge' }, { source: 'bot', round: 3, status: 'granted', by: 'judge' }];
  assert.equal(grantedRounds(state, 'plan', { mode: 'auto', max: 2 }), 1);
  assert.equal(grantedRounds(state, 'plan', { mode: 'ask', max: 2 }), 0, 'under "ask" a grant needs the Human');
  assert.equal(grantedRounds(state, 'plan', { mode: 'auto', max: 0 }), 0, 'the ceiling clamps');
  const ceiling = atCap({ state, source: 'plan', round: 4, head: 'h', policy: { mode: 'auto', max: 1 }, history: unread, pr: 7 });
  assert.deepEqual([ceiling.status, ceiling.extension.by], ['round_limit', 'ceiling']);
});

test('atCap: the judge`s verdict and the Human`s answer move one entry, and only a waiting one', () => {
  const state = emptyState(7, 'o/r');
  const rows = [];
  const first = atCap({ state, source: 'plan', round: 2, head: 'abcdef1234', policy: { mode: 'ask', max: 2 }, history: passing, pr: 7, log: (row) => rows.push(row) });
  assert.equal(first.status, 'extension_check');
  assert.throws(() => recordHuman(state, { answer: 'approve', by: 'x' }), /no extension waits for the Human/u, 'no Human answer before the judge');
  assert.throws(() => recordVerdict(state, { verdict: 'extend', reason: 'r', head: '1234567' }), /the check was for abcdef1, not 1234567/u);
  recordVerdict(state, { verdict: 'extend', reason: 'valid', head: 'abcdef1' });
  const ask = atCap({ state, source: 'plan', round: 2, head: 'abcdef1234', policy: { mode: 'ask', max: 2 }, history: passing, pr: 7 });
  assert.equal(ask.status, 'extension_ask');
  recordHuman(state, { answer: 'deny', by: 'Tester' });
  const denied = atCap({ state, source: 'plan', round: 2, head: 'abcdef1234', policy: { mode: 'ask', max: 2 }, history: passing, pr: 7 });
  assert.deepEqual([denied.status, denied.extension.status, denied.extension.by], ['round_limit', 'denied', 'human']);
  assert.deepEqual(rows, [{ event: 'review_extension', source: 'plan', round: 2, outcome: 'judging', by: null, signals: [] }]);
});

test('atCap on a head no round reviewed: the judge is told, the question names the fix, and a stop says so', () => {
  const fix = { added: 3, removed: 1, files: ['a.js'] };
  const history = () => ({ ...passing(), rounds: [round(1, 'a', [finding('a.js', 1, 'one'), finding('a.js', 50, 'two')]), round(2, 'b', [finding('a.js', 90, 'three')], fix)] });
  const reviewed = atCap({ state: emptyState(7, 'o/r'), source: 'plan', round: 2, head: 'b', policy: { mode: 'ask', max: 2 }, history, pr: 7 });
  assert.equal(reviewed.status, 'extension_check');
  assert.ok(!('unreviewed_head' in reviewed.extension), 'the last round reviewed this head');

  const state = emptyState(7, 'o/r');
  const check = atCap({ state, source: 'plan', round: 2, head: 'c0ffee1234', policy: { mode: 'ask', max: 2 }, history, pr: 7 });
  assert.equal(check.status, 'extension_check');
  assert.deepEqual(check.extension.unreviewed_head, { head: 'c0ffee1234', from: 'b', fix });
  assert.deepEqual(state.extensions[0].unreviewed, { head: 'c0ffee1234', from: 'b' });
  assert.match(check.dispatch[0].brief, /`extension\.unreviewed_head`/u);

  recordVerdict(state, { verdict: 'extend', reason: 'a.js:90 was a valid high finding; the fix is small' });
  const ask = atCap({ state, source: 'plan', round: 2, head: 'c0ffee1234', policy: { mode: 'ask', max: 2 }, history, pr: 7 });
  assert.equal(ask.status, 'extension_ask');
  assert.match(ask.question, /fix head c0ffee1 is reviewed by no pass/u);
  assert.equal((ask.question.match(/round \d/gu) ?? []).length, 1, 'the question names one round, the one it grants');
  const answer = JSON.stringify({ type: 'user', timestamp: 't', toolUseResult: { answers: { [ask.question]: ask.options[0] } } });
  assert.equal(approved(transcriptAnswers(answer), { pr: 7, round: 3 }), true, 'the review-extend rule still reads the approval');
  assert.equal(approved(transcriptAnswers(answer), { pr: 7, round: 2 }), false);

  recordHuman(state, { answer: 'deny', by: 'Tester' });
  const denied = atCap({ state, source: 'plan', round: 2, head: 'c0ffee1234', policy: { mode: 'ask', max: 2 }, history, pr: 7 });
  assert.deepEqual([denied.status, denied.unreviewed_head], ['round_limit', true]);
  assert.match(summaryBody(state, null, 'round_limit', OPEN), /- round 2 on `c0ffee1`: denied[^\n]*\n- fix head `c0ffee1`, pushed after round 2 on `b`, is reviewed by no pass/u);
});

test('revalidate: a push that bloats an open decision sends it back to the judge with the red flag, and names the fix as unreviewed', () => {
  const bloated = () => ({ ...passing(), rounds: [round(1, 'a', [finding('a.js', 1, 'one'), finding('a.js', 50, 'two')]), round(2, 'b', [finding('a.js', 90, 'three')], { added: 100, removed: 0, files: ['a.js'] })] });
  for (const status of ['asking', 'granted']) {
    const state = emptyState(7, 'o/r');
    state.extensions = [{ source: 'plan', round: 2, head: 'b', status, by: 'judge', reasons: ['valid'], mode: 'auto', max: 2 }];
    const back = atCap({ state, source: 'plan', round: 2, head: 'c0ffee1234', policy: { mode: 'ask', max: 2 }, history: bloated, pr: 7 });
    assert.deepEqual([back.status, back.extension.by, back.extension.signals.bloating, back.extension.unreviewed_head?.head], ['extension_check', null, true, 'c0ffee1234'], status);
    assert.match(back.extension.red_flags[0], /^bloating/u, status);
    assert.equal(state.extensions[0].human, undefined, 'an approval for the head before does not carry over');
  }
});

test('atCap at the ceiling: no history is read, and lastReviewed alone says the head is a fix no round reviewed', () => {
  const unread = () => assert.fail('the history is not read');
  const atCeiling = (lastReviewed, head = 'c0ffee1234') => {
    const state = emptyState(7, 'o/r');
    state.extensions = [{ source: 'plan', round: 2, status: 'granted', by: 'judge' }];
    return [state, atCap({ state, source: 'plan', round: 3, head, policy: { mode: 'auto', max: 1 }, history: unread, lastReviewed, pr: 7 })];
  };
  const [state, fix] = atCeiling(() => 'b');
  assert.deepEqual([fix.status, fix.extension.by, fix.unreviewed_head], ['round_limit', 'ceiling', true]);
  assert.match(summaryBody(state, null, 'round_limit', OPEN), /- round 3 on `c0ffee1`: stopped by the ceiling[^\n]*\n- fix head `c0ffee1`, pushed after round 3 on `b`, is reviewed by no pass/u);
  const [, same] = atCeiling(() => 'c0ffee1234');
  assert.deepEqual([same.status, 'unreviewed_head' in same], ['round_limit', false], 'the last round reviewed this head');
});

test('the summary: a fix head a plan round reviewed since is not listed as unreviewed', () => {
  const state = emptyState(7, 'o/r');
  state.extensions = [{ source: 'plan', round: 2, head: 'c0ffee1234', status: 'stopped', by: 'judge', reasons: ['nit'], unreviewed: { head: 'c0ffee1234', from: 'b' } }];
  assert.match(summaryBody(state, null, 'round_limit', OPEN), /is reviewed by no pass/u);
  state.rounds = [{ head: 'a' }, { head: 'b' }, { head: 'c0ffee1234' }];
  assert.doesNotMatch(summaryBody(state, null, 'round_limit', OPEN), /is reviewed by no pass/u);
});

test('aidrian pr extend: its arguments are checked before anything is recorded', () => {
  assert.deepEqual(parseExtend(['#12', '--verdict', 'extend', '--reason', ' a.js:3 is real ', '--head', 'abc1234']), { pr: 12, verdict: 'extend', reason: 'a.js:3 is real', head: 'abc1234', human: null });
  assert.deepEqual(parseExtend(['12', '--human', 'deny']), { pr: 12, verdict: null, reason: null, head: null, human: 'deny' });
  for (const [args, error] of [
    [[], /needs a pull request number/u],
    [['12'], /exactly one of --verdict or --human/u],
    [['12', '--verdict', 'extend', '--human', 'approve'], /exactly one of --verdict or --human/u],
    [['12', '--verdict', 'maybe', '--reason', 'x'], /--verdict must be extend or stop/u],
    [['12', '--verdict', 'stop'], /--verdict needs --reason/u],
    [['12', '--verdict', 'stop', '--reason', '  '], /--verdict needs --reason/u],
    [['12', '--human', 'yes'], /--human must be approve or deny/u],
    [['12', '--human', 'approve', '--head', 'abc1234'], /--head goes with --verdict/u],
    [['12', '--verdict', 'stop', '--reason', 'x', '--head', 'main'], /--head must be a commit SHA/u],
    [['12', '--force'], /unknown argument: --force/u],
    [['12', '--reason'], /--reason needs a value/u],
  ]) assert.throws(() => parseExtend(args), error, JSON.stringify(args));
});

// A project with a review record whose round-2 check waits for the Human, and a transcript file for the hook payload.
function guarded(t, { asking = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-extend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' } }));
  const project = projectAt(dir);
  const state = emptyState(12, 'o/r');
  state.extensions = [{ source: 'plan', round: 2, head: 'abc', status: asking ? 'asking' : 'judging', judge: asking ? { verdict: 'extend', reason: 'r', at: '2026-11-01T10:00:00.000Z' } : undefined }];
  writeLocalState(project, state);
  const transcript = path.join(dir, 'transcript.jsonl');
  const answer = (question, label, timestamp = '2026-11-01T10:05:00.000Z') => JSON.stringify({ type: 'user', timestamp, toolUseResult: { questions: [{ question }], answers: { [question]: label } } });
  const write = (...lines) => writeFileSync(transcript, `${lines.join('\n')}\n`);
  return { dir, project, transcript, answer, write, run: (command) => check(command, { cwd: dir, input: { transcript_path: transcript } }) };
}

const QUESTION = 'Pull request #12 reached its review-round cap. Grant one extra review round, round 3?';

test('the review-extend rule reads the call inside a shell string, eval, or a heredoc fed to a shell', (t) => {
  const g = guarded(t);
  g.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: QUESTION }] } }));
  for (const command of [
    'bash -c "aidrian pr extend 12 --human approve"',
    "sh -c 'aidrian pr extend 12 --human=approve'",
    'eval "aidrian pr extend 12 --human approve"',
    'eval -- "aidrian pr extend 12 --human approve"',
    "bash <<'EOF'\naidrian pr extend 12 --human approve\nEOF",
    'echo "aidrian pr extend 12 --human approve" | bash',
  ]) assert.match(g.run(command) ?? '', /holds no such answer/u, command);
  assert.equal(g.run("bash -c 'echo hi'"), null, 'an ordinary shell string');
  assert.equal(g.run('bash -c "aidrian pr extend 12 --human deny"'), null, 'deny always runs, wrapped too');
  g.write(g.answer(QUESTION, 'Approve round 3'));
  assert.equal(g.run('bash -c "aidrian pr extend 12 --human approve"'), null, 'the Human`s approval, wrapped');
});

test('the review-extend rule: an agent records the Human`s approval only after the Human picked it', (t) => {
  const g = guarded(t);
  g.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: QUESTION }] } }));
  assert.match(g.run('aidrian pr extend 12 --human approve') ?? '', /holds no such answer.*#12 and round 3/su, 'no answer, no approval');
  assert.equal(g.run('aidrian pr extend 12 --human deny'), null, 'deny always runs');
  assert.equal(g.run('aidrian pr extend 12 --verdict extend --reason x'), null, 'the judge`s verdict is not the Human`s');
  g.write(g.answer(QUESTION, 'Deny'));
  assert.ok(g.run('aidrian pr extend 12 --human approve'), 'the Human said deny');
  g.write(g.answer(QUESTION.replace('#12', '#123'), 'Approve round 3'));
  assert.ok(g.run('aidrian pr extend 12 --human approve'), 'an answer about another pull request');
  g.write(g.answer(QUESTION.replace('round 3', 'round 4'), 'Approve round 4'));
  assert.ok(g.run('aidrian pr extend 12 --human approve'), 'an answer about another round');
  g.write(g.answer(QUESTION, 'Approve round 3', '2026-11-01T09:00:00.000Z'));
  assert.ok(g.run('aidrian pr extend 12 --human approve'), 'an answer older than the judge`s verdict');
  g.write(g.answer(QUESTION, 'Approve round 3'));
  for (const command of ['aidrian pr extend 12 --human approve', 'aidrian pr extend #12 --human=approve', 'node plugins/aidrian/lib/cli.mjs pr extend 12 --human approve']) {
    assert.equal(g.run(command), null, command);
  }
  assert.ok(check('node --disable-warning X plugins/aidrian/lib/cli.mjs pr extend 12 --human approve', { cwd: g.dir, input: {} }), 'a runner\'s option with a value hides no call');
  assert.ok(check('aidrian pr extend 12 --human approve', { cwd: g.dir, input: {} }), 'no transcript, no approval: the Human runs it in their own shell');
  assert.ok(g.run('aidrian pr extend "$PR" --human approve'), 'a pull request the rule cannot read');
  assert.ok(g.run('echo ok && aidrian pr extend 12 --human "$ANSWER"') === null, 'the approval is in the transcript, whatever the variable holds');
});

test('the review-extend rule: with no ask waiting in this machine`s record, an approval is the Human`s to run', (t) => {
  const g = guarded(t, { asking: false });
  g.write(g.answer(QUESTION, 'Approve round 3'));
  assert.ok(g.run('aidrian pr extend 12 --human approve'), 'a record from another machine, or none, proves nothing here');
  assert.equal(g.run('aidrian pr extend 12 --human deny'), null);
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-extend-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('aidrian pr extend 12 --human approve', { cwd: bare, input: {} }), null, 'outside a project the rule is off');
});

test('the review-extend rule: after a judge`s stop, the deny names the Human`s override, not another ask', (t) => {
  const g = guarded(t);
  const state = emptyState(12, 'o/r');
  state.rounds = [{ head: 'a' }, { head: 'b' }, { head: 'c' }, { head: 'd' }];
  state.extensions = [
    { source: 'plan', round: 3, head: 'c', status: 'granted', by: 'judge' },
    { source: 'plan', round: 4, head: 'd', status: 'stopped', by: 'judge', judge: { verdict: 'stop', reason: 'r', at: '2026-11-01T10:00:00.000Z' } },
  ];
  writeLocalState(g.project, state);
  g.write(g.answer('Grant extra review round 5 for pull request #12?', 'Approve round 5 for pull request #12'));
  const denied = g.run('aidrian pr extend 12 --human approve') ?? '';
  assert.match(denied, /no extension waits for the Human on pull request #12 \(the latest check, at round 4, is stopped by the judge\)/u);
  assert.match(denied, /`AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4`/u, 'five rounds: four done, one granted, one more');
  assert.match(denied, /`--with-bot` before `--max-rounds` when the step runs the bot/u, 'the raise keeps the bot stage');
  assert.doesNotMatch(denied, /Ask the Human with AskUserQuestion/u, 'an ask cannot help when nothing waits for it');
  state.rounds = [];
  state.extensions = [{ source: 'bot', round: 4, head: 'd', status: 'stopped', by: 'judge' }];
  writeLocalState(g.project, state);
  assert.match(g.run('aidrian pr extend 12 --human approve') ?? '', /AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 12 --request --max-rounds 5/u, 'a bot cap counts the bot`s reviews, not the plan`s rounds');
  state.rounds = [{ head: 'a' }];
  state.extensions = [{ source: 'plan', round: 3, head: 'c', status: 'stopped', by: 'judge' }, { source: 'bot', round: 2, head: 'd', status: 'granted', by: 'judge' }, { source: 'bot', round: 3, head: 'e', status: 'stopped', by: 'judge' }];
  writeLocalState(g.project, state);
  assert.match(g.run('aidrian pr extend 12 --human approve') ?? '', /await-review 12 --request --max-rounds 3`/u, 'three bot reviews, one bot grant: a baseline of three allows a fourth');
  const other = check('aidrian pr extend 99 --human approve', { cwd: g.dir, input: {} }) ?? '';
  assert.match(other, /holds no extension check for pull request #99.*the Human runs the approval in their own shell/su, 'no record here: maybe another machine asked');
});

test('the review-extend rule: while the check at the cap waits for the judge, the deny names the judge, not the override', (t) => {
  // 2026-11-10: a session asked the Human before the judge ran, and this deny sent it to the override instead of the judge.
  const g = guarded(t, { asking: false });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: g.dir });
  g.write(g.answer('Grant round 3 on #12?', 'Grant round 3 (Recommended)'));
  const denied = g.run('aidrian pr extend 12 --human approve') ?? '';
  assert.match(denied, /The check at round 2 on pull request #12 waits for the judge/u);
  assert.match(denied, /run again the review command that reached the cap, `aidrian pr review 12`, with the options it ran with, such as its `--with-bot` and `--max-rounds`/u);
  assert.match(denied, /`aidrian pr extend 12 --verdict extend\|stop --reason "<evidence>" --head <sha>`/u);
  assert.doesNotMatch(denied, /AIDRIAN_ALLOW_EXTRA_ROUNDS|asking again changes nothing/u, 'the judge comes before any raise of the cap');
});

test('the review-extend rule: in a checkout with several remotes, the override after a stop is the Human`s to run', (t) => {
  const g = guarded(t);
  const state = emptyState(12, 'o/r');
  state.extensions = [{ source: 'plan', round: 3, head: 'c', status: 'stopped', by: 'judge' }];
  writeLocalState(g.project, state);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: g.dir });
  assert.match(g.run('aidrian pr extend 12 --human approve') ?? '', /put the choice to the Human with an AskUserQuestion that names <owner>\/<name>#12/u, 'one remote: an answer can approve it');
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd: g.dir });
  const denied = g.run('aidrian pr extend 12 --human approve') ?? '';
  assert.match(denied, /This checkout has several remotes/u);
  assert.match(denied, /the Human runs `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4` \(with `--with-bot` before `--max-rounds` when the step runs the bot\) in their own shell/u);
  assert.doesNotMatch(denied, /AskUserQuestion/u, 'no answer can approve it here');
});

test('the review-extend rule: each call in a chain is judged against its own pull request, and every refusal is named', (t) => {
  const g = guarded(t);
  const second = emptyState(13, 'o/r');
  second.extensions = [{ source: 'plan', round: 2, head: 'def', status: 'asking', judge: { verdict: 'extend', reason: 'r', at: '2026-11-01T10:00:00.000Z' } }];
  writeLocalState(g.project, second);
  const ask13 = QUESTION.replace('#12', '#13');
  g.write(g.answer(QUESTION, 'Approve round 3'));
  const one = g.run('aidrian pr extend 12 --human approve && aidrian pr extend 13 --human approve') ?? '';
  assert.match(one, /#13 and round 3/u, 'the unapproved pull request is named');
  assert.doesNotMatch(one, /#12/u, 'the approved one is not');
  g.write('');
  const both = g.run('aidrian pr extend 12 --human approve; aidrian pr extend 13 --human approve') ?? '';
  assert.match(both, /#12 and round 3/u);
  assert.match(both, /#13 and round 3/u, 'one retry can fix both');
  g.write(g.answer(QUESTION, 'Approve round 3'), g.answer(ask13, 'Approve round 3'));
  assert.equal(g.run('aidrian pr extend 12 --human approve && aidrian pr extend 13 --human approve'), null, 'one answer per pull request');
});

test('the review-extend rule says why the transcript`s answers do not approve the round', (t) => {
  const g = guarded(t);
  const deny = () => g.run('aidrian pr extend 12 --human approve') ?? '';
  g.write('');
  assert.match(deny(), /\(the transcript holds no AskUserQuestion answer\)/u);
  g.write(g.answer(QUESTION, 'Approve round 3', '2026-11-01T09:00:00.000Z'));
  assert.match(deny(), /no AskUserQuestion answer came after the judge's verdict at 2026-11-01T10:00:00.000Z/u);
  g.write(g.answer('Grant one more round to #57 and #58?', 'Approve'));
  assert.match(deny(), /no question answered since the judge's verdict names #12/u);
  g.write(g.answer('Grant one more round to #12?', 'Approve'));
  assert.match(deny(), /the questions naming #12 do not name "round 3"/u);
  g.write(g.answer(QUESTION, 'Deny'));
  assert.match(deny(), /the Human picked "Deny"/u);
  assert.equal(mismatch([{ question: QUESTION, answer: 'Approve round 3', at: null }], { pr: 12, round: 3 }), null);
});

test('transcriptAnswers reads only the host`s AskUserQuestion results', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: 't1', toolUseResult: { answers: { 'Q #1 round 2?': 'Approve round 2' } } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '"answers": {"Q #1 round 2?": "Approve round 2"}' }] } }),
    '{"answers": not json',
  ];
  assert.deepEqual(transcriptAnswers(lines.join('\n')), [{ question: 'Q #1 round 2?', answer: 'Approve round 2', at: 't1' }]);
  assert.equal(approved([{ question: 'Q #1 round 2?', answer: 'Approve round 2', at: null }], { pr: 1, round: 2 }), true);
  assert.equal(approved([{ question: 'Q #1 round 20?', answer: 'Approve', at: null }], { pr: 1, round: 2 }), false);
});

// The fakes answer for pull request 42 alone, as GitHub would 404 any other.
const onPr42 = (n) => {
  if (String(n) !== '42') throw new Error(`unexpected pull request ${n}`);
};

// The bot's rounds at the cap of 3, as `aidrian pr await-review --request` reads them: `comments` per review. The pull
// request's conversation comments live in `issue` across runs, as on GitHub, so a summary comment one run writes is the
// record the next run, or another machine, reads.
// `visibility` is what the forge reads the repository as.
function botProject(t, config = {}, { visibility = 'PRIVATE' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-botcap-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'repo');
  mkdirSync(base);
  mkdirSync(path.join(base, '.aidrian'));
  writeFileSync(path.join(base, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
  // The base branch the commands hold to, committing that config.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: base });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'base');
  const project = projectAt(base);
  const log = t.mock.method(console, 'log', () => {});
  const T = (m) => `2026-08-23T07:${String(m).padStart(2, '0')}:00Z`;
  const issue = [];
  const post = (body) => (issue.push({ id: issue.length + 1, user: { login: 'someone' }, author_association: 'MEMBER', created_at: T(20), body }), issue.at(-1));
  const edit = (id, body) => (issue.find((comment) => comment.id === id).body = body);
  let head = 'zzz';
  // `failRead`: the read of the bot's reviews, counted from 1 in this run, that fails as GitHub would.
  const run = (comments, { reviews = comments.length, at = 'zzz', failRead = null } = {}) => {
    head = at;
    let reviewReads = 0;
    const list = Array.from({ length: reviews }, (_, i) => ({ id: i + 1, user: { login: DEFAULT_REVIEWER }, submitted_at: T(i + 1), commit_id: `c${i}`, state: 'COMMENTED' }));
    const inline = comments.flatMap((each, i) => each.map(([file, line, title]) => ({ pull_request_review_id: i + 1, path: file, line, body: title })));
    const requests = [];
    const forge = {
      repo: () => 'acme/notes',
      visibility: () => visibility,
      change: () => ({ number: 42, isCrossRepository: false }),
      viewer: () => 'someone',
      postComment: (_repo, n, body) => {
        onPr42(n);
        return body.startsWith('@codex review') ? (requests.push({ body }), {}) : post(body);
      },
      editComment: (_repo, id, body) => edit(Number(id), body),
      pull: (_repo, n) => (onPr42(n), { ...INSIDE, title: 'Cap refunds', body: 'Refunds never exceed the charge.', head: { sha: head, ref: 'feat', repo: { full_name: 'acme/notes' } } }),
      commit: () => ({ commit: { committer: { date: T(1) } } }),
      reviews: (_repo, n) => {
        onPr42(n);
        reviewReads += 1;
        if (reviewReads === failRead) throw new Error('HTTP 502: GitHub is unavailable');
        return list;
      },
      reviewComments: (_repo, n) => (onPr42(n), inline),
      conversationComments: (_repo, n) => (onPr42(n), issue),
      reactions: () => [],
    };
    let t0 = Date.parse(T(30));
    return runAwaitReview(['42', '--request', '--timeout-sec', '0'], loadConfig(project).config, project, { forge, now: () => t0, sleep: async (s) => { t0 += s * 1000; } }).then((code) => ({ code, out: JSON.parse(log.mock.calls.at(-1).arguments[0]), requests, reviewReads }));
  };
  // `aidrian pr extend` as the CLI runs it, with the review step's forge over the same comments.
  const extend = (args) => runExtend(['42', ...args], project, loadConfig(project).config, {
    repo: 'acme/notes', env: {},
    forge: { visibility: () => visibility, pull: () => INSIDE, change: () => ({ headRefOid: head, baseRefName: 'main', isCrossRepository: false }), conversationComments: () => issue, postComment: (_repo, _n, body) => post(body), editComment: (_repo, id, body) => edit(id, body), viewer: () => 'someone' },
  });
  // Another machine: this one's state folder is gone, and only the pull request's comments remain.
  const forget = () => rmSync(path.join(base, '../state'), { recursive: true, force: true });
  // A push GitHub reports before any command runs on it.
  const move = (at) => { head = at; };
  return { project, run, extend, forget, move, issue };
}

const converging = [[['a.js', 1, 'One'], ['b.js', 5, 'Two'], ['c.js', 9, 'Three']], [['d.js', 1, 'Four'], ['e.js', 2, 'Five']], [['f.js', 3, 'Six']]];

test('await-review and extend, run by a non-member, edit that user\'s own summary comment', async (t) => {
  const { run, extend, issue } = botProject(t);
  await run(converging);
  assert.equal(issue.length, 1);
  issue[0].author_association = 'CONTRIBUTOR';
  await run(converging);
  assert.equal(issue.length, 1, 'await-review edits it');
  assert.equal(await extend(['--verdict', 'extend', '--reason', 'f.js:3 is a valid high finding']), 0);
  assert.equal(issue.length, 1, 'extend edits it');
});

test('await-review --request at the cap: converging bot rounds get the judge, and a Human-approved round asks the bot once more', async (t) => {
  const { project, run } = botProject(t);
  const check1 = await run(converging);
  assert.deepEqual([check1.code, check1.out.status, exitCodeFor('extension_check')], [10, 'extension_check', 10]);
  assert.deepEqual(check1.out.extension.history.map((each) => each.open), [3, 2, 1]);
  assert.deepEqual(check1.out.extension.goal, { title: 'Cap refunds', body: 'Refunds never exceed the charge.' });
  assert.equal(check1.requests.length, 0, 'no review is requested at the cap');

  const state = readLocalState(project, 42);
  recordVerdict(state, { verdict: 'extend', reason: 'f.js:3 is a valid high finding' });
  writeLocalState(project, state);
  const ask = await run(converging);
  assert.deepEqual([ask.code, ask.out.status, ask.out.question], [11, 'extension_ask', 'Pull request #42 reached its review-round cap, and its fix head zzz is reviewed by no pass. Grant one extra review round, round 4, to review that fix?']);

  const asked = readLocalState(project, 42);
  recordHuman(asked, { answer: 'approve', by: 'Tester', current: 'zzz' });
  writeLocalState(project, asked);
  const granted = await run(converging);
  assert.equal(granted.out.status, 'timed_out', 'the fourth round is asked for');
  assert.equal(granted.requests.length, 1);
  assert.match(granted.requests[0].body, /max-rounds=4/u);
});

test('await-review at the cap: the checks, verdicts, and approvals reach the summary comment, so another machine continues', async (t) => {
  const bot = botProject(t);
  assert.equal((await bot.run(converging)).out.status, 'extension_check');
  const [summary] = bot.issue;
  assert.equal(stateFromComment(summary.body, 42).extensions[0].status, 'judging', 'the check is on the pull request');
  assert.match(summary.body, /\*\*Extra rounds:\*\*\n- bot round 3 on `zzz`: judging/u);
  bot.forget();
  assert.equal(await bot.extend(['--verdict', 'extend', '--reason', 'f.js:3 is a valid high finding']), 0);
  assert.equal(bot.issue.length, 1, 'the one summary comment, edited in place');
  assert.equal(stateFromComment(bot.issue[0].body, 42).extensions[0].status, 'asking');
  bot.forget();
  assert.equal((await bot.run(converging)).out.status, 'extension_ask', 'the verdict came back from the pull request');
  bot.forget();
  assert.equal(await bot.extend(['--human', 'approve']), 0);
  bot.forget();
  const granted = await bot.run(converging);
  assert.deepEqual([granted.out.status, granted.requests.length], ['timed_out', 1], 'the grant came back from the pull request');
});

test('a held summary comment: aidrian pr extend and await-review fail on a machine without the record, and the writer goes on', async (t) => {
  const bot = botProject(t);
  assert.equal((await bot.run(converging)).out.status, 'extension_check');
  const written = readLocalState(bot.project, 42);
  bot.issue[0].body = bot.issue[0].body.replace(/<!-- aidrian-review-state-br:[^>]*-->/u, `${HELD_LINE}\n<!-- aidrian-review-state-held:${written.revision} -->`);
  const held = bot.issue[0].body;
  bot.forget();
  const message = new RegExp(`the review record of #42 is at revision ${written.revision} on the machine that wrote it`, 'u');
  await assert.rejects(bot.extend(['--verdict', 'extend', '--reason', 'f.js:3 is a valid high finding']), message);
  const errors = t.mock.method(console, 'error', () => {});
  const awaited = await bot.run(converging);
  errors.mock.restore();
  assert.equal(awaited.code, 1);
  assert.match(errors.mock.calls.at(-1).arguments[0], message);
  assert.equal(bot.issue[0].body, held, 'neither command edits the comment');
  assert.equal(readLocalState(bot.project, 42), null, 'nor starts a record over it');

  writeLocalState(bot.project, { ...written, revision: written.revision - 1 });
  assert.equal(await bot.extend(['--verdict', 'extend', '--reason', 'f.js:3 is a valid high finding']), 0, 'the writer goes on');
  assert.equal(heldRevision(bot.issue[0].body), null);
  assert.equal(stateFromComment(bot.issue[0].body, 42).extensions[0].status, 'asking');
});

test('await-review at the cap: a push after the judge`s verdict sends the check back to the judge, and a stale approval is refused', async (t) => {
  const bot = botProject(t);
  await bot.run(converging);
  await bot.extend(['--verdict', 'extend', '--reason', 'valid']);
  assert.equal((await bot.run(converging)).out.status, 'extension_ask');
  const moved = await bot.run(converging, { at: 'b1b1b1b1' });
  assert.deepEqual([moved.out.status, moved.out.extension.status], ['extension_check', 'judging'], 'the judge has not seen b1b1b1b1');
  assert.match(moved.out.dispatch[0].record, /--head b1b1b1b1$/u);
  await bot.extend(['--verdict', 'extend', '--reason', 'still valid', '--head', 'b1b1b1b1']);
  bot.move('c2c2c2c2');
  await assert.rejects(bot.extend(['--human', 'approve']), /the check was for b1b1b1b, and the pull request is at c2c2c2c now/u);
  assert.equal(await bot.extend(['--human', 'deny']), 0, 'a deny needs no head');
});

test('await-review --request at the cap: a head the bot has not reviewed reaches the judge as such, and a stop says so', async (t) => {
  const bot = botProject(t);
  const check = await bot.run(converging);
  assert.equal(check.out.status, 'extension_check');
  assert.deepEqual([check.out.extension.unreviewed_head.head, check.out.extension.unreviewed_head.from], ['zzz', 'c2'], 'from is the bot`s last reviewed head');
  const verdict = await bot.extend(['--verdict', 'stop', '--reason', 'f.js:3 is a nit']);
  assert.equal(verdict, 0);
  const stopped = await bot.run(converging);
  assert.deepEqual([stopped.code, stopped.out.status, stopped.out.unreviewed_head], [4, 'round_limit', true]);
  assert.match(bot.issue[0].body, /- bot round 3 on `zzz`: stopped by the judge: f\.js:3 is a nit\n- fix head `zzz`, pushed after bot round 3 on `c2`, is reviewed by no pass/u);
});

test('await-review --request at the bot`s ceiling: the bot`s last review names the head as unreviewed, and a failed read names nothing', async (t) => {
  const bot = botProject(t, { github: { maxExtraRounds: 0 } });
  const capped = await bot.run(converging);
  assert.deepEqual([capped.code, capped.out.status, capped.out.extension.by, capped.out.unreviewed_head], [4, 'round_limit', 'ceiling', true]);
  assert.match(bot.issue[0].body, /- bot round 3 on `zzz`: stopped by the ceiling[^\n]*\n- fix head `zzz`, pushed after bot round 3 on `c2`, is reviewed by no pass/u);

  // The last read of the reviews in that run was the ceiling's: the same run with that read failing still stops.
  const down = botProject(t, { github: { maxExtraRounds: 0 } });
  const failed = await down.run(converging, { failRead: capped.reviewReads });
  assert.deepEqual([failed.code, failed.out.status, failed.out.extension.by, 'unreviewed_head' in failed.out], [4, 'round_limit', 'ceiling', false]);
  assert.equal(readLocalState(down.project, 42).extensions[0].unreviewed, undefined);
  assert.doesNotMatch(down.issue[0].body, /is reviewed by no pass/u);
});

test('await-review --request at the cap: a push after the judge`s stop is named as unreviewed, from the bot`s last review', async (t) => {
  const bot = botProject(t);
  assert.equal((await bot.run(converging)).out.status, 'extension_check');
  await bot.extend(['--verdict', 'stop', '--reason', 'f.js:3 is a nit']);
  const pushed = await bot.run(converging, { at: 'yyy' });
  assert.deepEqual([pushed.code, pushed.out.status, pushed.out.extension.by, pushed.out.unreviewed_head], [4, 'round_limit', 'judge', true]);
  assert.deepEqual(readLocalState(bot.project, 42).extensions[0].unreviewed, { head: 'yyy', from: 'c2' });
  assert.match(bot.issue[0].body, /- fix head `yyy`, pushed after bot round 3 on `c2`, is reviewed by no pass/u);
});

test('await-review --request at the cap: bot rounds that do not shrink go to the judge with their red flags', async (t) => {
  const { run } = botProject(t);
  const result = await run([[['a.js', 1, 'One']], [['a.js', 2, 'One again']], [['b.js', 9, 'Two']]]);
  assert.deepEqual([result.out.status, result.out.extension.by], ['extension_check', null]);
  assert.deepEqual(result.out.extension.red_flags.map((reason) => reason.split(':')[0]), ['not converging', 'looping']);
  assert.deepEqual([result.out.extension.signals.converging, result.out.extension.signals.looping], [false, true]);
  const off = botProject(t, { github: { extraRounds: 'off' } });
  const plain = await off.run([[['a.js', 1, 'One']], [['b.js', 1, 'x']], []]);
  assert.deepEqual([plain.code, plain.out.extension], [4, { status: 'off', mode: 'off' }]);
});

test('aidrian report reviews counts each check at the cap once, by its last decision', () => {
  const at = (minute) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const row = (pr, round, outcome, by, minute, signalsHit = []) => ({ event: 'review_extension', ts: at(minute), repo: 'o/r', pr, source: 'plan', round, outcome, by, signals: signalsHit });
  const rows = [
    row(1, 3, 'judging', null, 1), row(1, 3, 'asking', 'judge', 2), row(1, 3, 'granted', 'human', 3, ['looping']),
    row(2, 3, 'stopped', 'mechanical', 4, ['looping', 'bloating']),
    row(3, 3, 'stopped', 'mechanical', 5),
    row(4, 3, 'judging', null, 6), row(4, 3, 'stopped', 'judge', 7, ['looping', 'drifting']),
    row(5, 5, 'stopped', 'ceiling', 8),
    row(6, 3, 'asking', 'judge', 9),
    { event: 'stop', ts: at(10) },
    row(7, 3, 'denied', 'human', 0),
  ];
  const summary = extensionSummary(rows, { sinceMs: Date.parse(at(1)) });
  assert.deepEqual(summary, {
    checks: 6, over_flags: 3, granted_over_flags: 1, signals: { looping: 3, bloating: 1, unreadable: 1, drifting: 1 },
    stopped_by_signals: 2, stopped_by_judge: 1, stopped_by_ceiling: 1,
    granted: 1, granted_by_human: 1, denied: 0, waiting: 1,
  });
  assert.equal(formatExtensions(summary, { since: '7d' }),
    'Extra rounds since 7d: 6 checks at the round cap; 3 with red flags (looping 3, bloating 1, unreadable 1, drifting 1), 1 granted over them; 2 stopped by the signals, 1 stopped by the judge, 1 at the ceiling; 1 granted (1 by the Human), 0 denied, 1 waiting');
  const fresh = extensionSummary([row(8, 3, 'granted', 'judge', 1, ['bloating'])]);
  assert.equal(formatExtensions(fresh),
    'Extra rounds: 1 check at the round cap; 1 with red flags (bloating 1), 1 granted over them; 0 stopped by the judge, 0 at the ceiling; 1 granted (0 by the Human), 0 denied, 0 waiting', 'no old mechanical stop, no signals stop count');
  assert.equal(formatExtensions(extensionSummary([])), null, 'no check, no line');
});

// A git repository whose `main` commits `config`, and a `feat` branch of three commits, one per bot review, and a
// fix after the third, as `aidrian pr await-review --request` sees it. Requests the run posts join the conversation, as on GitHub.
function gitBot(t, config, { working = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gitbot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  write('.aidrian/config.json', JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
  write('src/a.js', 'export const a = 0;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  const commit = (text) => (write('src/a.js', text), git('commit', '-q', '-am', 'change'), git('rev-parse', 'HEAD'));
  const heads = [commit('export const a = 1;\n'), commit('export const a = 2;\n'), commit('export const a = 3;\n')];
  const fix = commit('export const a = 4;\n');
  // An uncommitted edit of the working copy's config: the base branch's config is the one in force.
  if (working) write('.aidrian/config.json', JSON.stringify({ version: 1, state: { dir: '../state' }, ...working }));
  const project = projectAt(dir);
  const log = t.mock.method(console, 'log', () => {});
  let minute = 0;
  const at = () => `2026-08-23T08:${String((minute += 1)).padStart(2, '0')}:00Z`;
  const issue = [];
  const requests = [];
  // `beforePull(n)` runs before GitHub answers the n-th read of the pull request in a run: a push between two reads.
  const hooks = {};
  let pulls = 0;
  const findings = [[['src/a.js', 1, 'One'], ['src/a.js', 40, 'Two'], ['src/a.js', 120, 'Three']], [['src/a.js', 80, 'Four'], ['src/a.js', 160, 'Five']], [['src/a.js', 200, 'Six']]];
  const reviews = heads.map((sha, i) => ({ id: i + 1, user: { login: DEFAULT_REVIEWER }, submitted_at: at(), commit_id: sha, state: 'COMMENTED' }));
  const inline = findings.flatMap((each, i) => each.map(([file, line, title]) => ({ pull_request_review_id: i + 1, path: file, line, body: title })));
  const forge = {
    repo: () => 'acme/notes',
    ...PRIVATE_PR,
    change: () => ({ number: 42, isCrossRepository: false }),
    postComment: (_repo, n, body) => {
      onPr42(n);
      const comment = { id: issue.length + 1, user: { login: 'someone' }, author_association: 'MEMBER', created_at: at(), body };
      issue.push(comment);
      if (body.startsWith('@codex review')) requests.push(comment);
      return comment;
    },
    editComment: (_repo, id, body) => (issue.find((comment) => comment.id === Number(id)).body = body),
    pull: (_repo, n) => {
      onPr42(n);
      pulls += 1;
      hooks.beforePull?.(pulls);
      return { ...INSIDE, title: 'Cap refunds', body: 'goal', head: { sha: git('rev-parse', 'HEAD'), ref: 'feat', repo: { full_name: 'acme/notes' } } };
    },
    commit: () => ({ commit: { committer: { date: at() } } }),
    reviews: (_repo, n) => (onPr42(n), reviews),
    reviewComments: (_repo, n) => (onPr42(n), inline),
    conversationComments: (_repo, n) => (onPr42(n), issue),
    reactions: () => [],
  };
  const run = async (env = {}, args = []) => {
    pulls = 0;
    const start = Date.parse('2026-08-23T09:00:00Z');
    let now = start;
    const git_ = { pushedHead: () => null, behind: () => false };
    const code = await runAwaitReview(['42', '--request', '--timeout-sec', '0', ...args], loadConfig(project).config, project, { forge, git: git_, env, now: () => now, sleep: async (s) => { now += s * 1000; } });
    return { code, out: code === 1 ? null : JSON.parse(log.mock.calls.at(-1).arguments[0]), elapsed: (now - start) / 1000 };
  };
  return { project, run, requests, commit, fix, hooks, git };
}

test('await-review: a grant revoked by a bloated push stays revoked, whatever cap an earlier request recorded', async (t) => {
  const bot = gitBot(t, { github: { extraRounds: 'auto' } });
  const first = await bot.run();
  assert.equal(first.out.status, 'extension_check', JSON.stringify(first.out.extension));
  const state = readLocalState(bot.project, 42);
  recordVerdict(state, { verdict: 'extend', reason: 'src/a.js:200 is valid', current: bot.fix });
  writeLocalState(bot.project, state);
  const extended = await bot.run();
  assert.deepEqual([extended.out.status, bot.requests.length], ['timed_out', 1], 'the granted fourth round is asked for');
  assert.match(bot.requests[0].body, /max-rounds=4/u);

  bot.commit(`${Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n`);
  const revoked = await bot.run();
  assert.deepEqual([revoked.out.status, bot.requests.length], ['extension_check', 1], 'no new request: the recorded 4 does not bring the grant back');
  assert.deepEqual([revoked.out.extension.by, revoked.out.extension.signals.bloating], [null, true]);
  const again = readLocalState(bot.project, 42);
  recordVerdict(again, { verdict: 'extend', reason: 'the growth is the fix', current: bot.git('rev-parse', 'HEAD') });
  writeLocalState(bot.project, again);
  const asking = await bot.run();
  assert.equal(asking.out.status, 'extension_ask', 'under "auto", an extend over a red flag still asks the Human');
  assert.match(asking.out.question, /red flags \(bloating\)/u);

  const human = await bot.run({ AIDRIAN_ALLOW_EXTRA_ROUNDS: '1' });
  assert.deepEqual([human.out.status, bot.requests.length], ['timed_out', 2], 'the Human`s override still keeps a recorded cap');
});

test('await-review: the signals read the base branch`s review.ignore, so a working-copy edit cannot hide a bloated fix', async (t) => {
  const bot = gitBot(t, { github: { extraRounds: 'auto' } }, { working: { github: { extraRounds: 'auto' }, review: { ignore: ['src/**'] } } });
  assert.equal((await bot.run()).out.status, 'extension_check');
  const state = readLocalState(bot.project, 42);
  recordVerdict(state, { verdict: 'extend', reason: 'src/a.js:200 is valid', current: bot.fix });
  writeLocalState(bot.project, state);
  assert.equal((await bot.run()).out.status, 'timed_out', 'the extra round is asked for');
  bot.commit(`${Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n`);
  const revoked = await bot.run();
  assert.deepEqual([revoked.out.status, revoked.out.extension.signals.bloating, revoked.out.extension.signals.evidence.bloating.original_added], ['extension_check', true, 1]);
});

test('await-review: a grant is used only for the head it was read on; a bloated push between the reads revokes it, and nothing is posted', async (t) => {
  const grant = async (bot) => {
    assert.equal((await bot.run()).out.status, 'extension_check');
    const state = readLocalState(bot.project, 42);
    recordVerdict(state, { verdict: 'extend', reason: 'src/a.js:200 is valid', current: bot.fix });
    writeLocalState(bot.project, state);
  };
  const same = gitBot(t, { github: { extraRounds: 'auto' } });
  await grant(same);
  const asked = await same.run();
  assert.deepEqual([asked.out.status, same.requests.length], ['timed_out', 1], 'on the head the grant was read on, the request goes out');

  const raced = gitBot(t, { github: { extraRounds: 'auto' } });
  await grant(raced);
  // The first read (the base and the grant) sees the fix; the wait's own read sees a 60-line push made in between.
  raced.hooks.beforePull = (n) => {
    if (n === 2) raced.commit(`${Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n`);
  };
  const revoked = await raced.run();
  assert.deepEqual([revoked.out.status, raced.requests.length], ['extension_check', 0], 'no request on the bloated head');
  assert.deepEqual([revoked.out.extension.by, revoked.out.extension.signals.bloating], [null, true]);
  assert.equal(readLocalState(raced.project, 42).extensions[0].status, 'judging', 'the grant is revoked, back to the judge');
});

test('await-review: a grant adds to an explicit --max-rounds as to the base cap, and an explicit raise still needs the override', async (t) => {
  const bot = gitBot(t, { github: { extraRounds: 'auto' } });
  assert.equal((await bot.run({}, ['--max-rounds', '3'])).out.status, 'extension_check');
  const state = readLocalState(bot.project, 42);
  recordVerdict(state, { verdict: 'extend', reason: 'src/a.js:200 is valid', current: bot.fix });
  writeLocalState(bot.project, state);
  const error = t.mock.method(console, 'error', () => {});
  const raised = await bot.run({}, ['--max-rounds', '4']);
  assert.deepEqual([raised.code, bot.requests.length], [1, 0], 'a --max-rounds past the base cap is the Human`s, grant or not');
  assert.match(error.mock.calls.at(-1).arguments[0], /--max-rounds 4 goes past config\.json github\.maxReviewRounds \(3\)/u);
  const asked = await bot.run({}, ['--max-rounds', '3']);
  assert.deepEqual([asked.out.status, bot.requests.length], ['timed_out', 1], 'the granted fourth round is asked for');
  assert.match(bot.requests[0].body, /max-rounds=4/u);
});

test('await-review without --request reads GitHub alone: no base branch in the checkout is needed; a request still needs it', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-nobase-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'feat'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' } }));
  const project = projectAt(dir);
  const nothingPosted = () => {
    throw new Error('nothing is posted');
  };
  const forge = {
    repo: () => 'acme/notes',
    change: () => ({ number: 42 }),
    postComment: nothingPosted,
    editComment: nothingPosted,
    pull: () => ({ base: { ref: 'main' }, head: { sha: 'abc1234', ref: 'feat', repo: { full_name: 'acme/notes' } } }),
    commit: () => ({ commit: { committer: { date: '2026-08-23T07:01:00Z' } } }),
    reviews: () => [],
    reviewComments: () => [],
    conversationComments: () => [],
    reactions: () => [],
  };
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const deps = { forge, git: { pushedHead: () => null, behind: () => false }, now: () => 0, sleep: async () => {} };
  assert.equal(await runAwaitReview(['42', '--timeout-sec', '0'], loadConfig(project).config, project, deps), 2);
  assert.equal(JSON.parse(log.mock.calls.at(-1).arguments[0]).status, 'timed_out');
  assert.equal(await runAwaitReview(['42', '--request', '--timeout-sec', '0'], loadConfig(project).config, project, deps), 1);
  assert.match(error.mock.calls.at(-1).arguments[0], /the base branch main is not in this checkout: git fetch first/u);
});

test('await-review: a retry after the head moved waits only for what is left of --timeout-sec, and reports the whole wait', async (t) => {
  const bot = gitBot(t, { github: { extraRounds: 'auto' } });
  assert.equal((await bot.run()).out.status, 'extension_check');
  const state = readLocalState(bot.project, 42);
  recordVerdict(state, { verdict: 'extend', reason: 'src/a.js:200 is valid', current: bot.fix });
  writeLocalState(bot.project, state);
  // The request for the fix goes out; a small push lands during the first poll, before any review.
  bot.hooks.beforePull = (n) => {
    if (n === 3) bot.commit('export const a = 5;\n');
  };
  const waited = await bot.run({}, ['--timeout-sec', '10', '--interval-sec', '5']);
  assert.equal(bot.requests.length, 2, 'the grant held on the new head, which is asked about once');
  assert.equal(waited.out.status, 'timed_out');
  assert.ok(waited.elapsed <= 10, `the whole command waited ${waited.elapsed} s of its 10`);
  assert.equal(waited.out.waited_sec, waited.elapsed, 'waited_sec counts every wait of the command');
});

test('buildHistory: a fix that rewords docs adds no code, and bloat is measured against the code first added', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hist-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const lines = (n, tag) => `${Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n')}\n`;
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  write('README.md', 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'feat');
  write('docs/guide.md', lines(100, 'first'));
  write('src/a.js', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  write('docs/guide.md', lines(100, 'reworded'));
  git('commit', '-q', '-am', 'reword');
  const head = git('rev-parse', 'HEAD');
  const read = buildHistory({ root: dir, rounds: [{ round: 1, head: first, open: 1, findings: [] }], baseTip: base, head });
  assert.deepEqual([read.rounds[0].fix.added, read.rounds[0].fix.code_added, read.originalAdded, read.originalCodeAdded], [100, 0, 101, 1]);
  assert.equal(signals(read).bloating, false, 'a docs rewording is no bloat');
  const grown = signals({ ...read, rounds: [{ ...read.rounds[0], fix: { added: 45, code_added: 45, removed: 0, files: ['src/a.js'] } }] });
  assert.deepEqual([grown.bloating, grown.evidence.bloating.limit], [true, BLOAT_MIN_LINES], 'the docs do not widen the allowance for code');
});

test('atCap: a red-flag stop an older version recorded goes to the judge, not a dead end', () => {
  const state = emptyState(7, 'o/r');
  state.extensions = [{ source: 'plan', round: 2, head: 'b', status: 'stopped', by: 'mechanical', reasons: ['bloating: old'], mode: 'ask', max: 2 }];
  const flagged = () => ({ ...passing(), rounds: [round(1, 'a', [finding('a.js', 1, 'one')]), round(2, 'b', [finding('a.js', 90, 'two')])] });
  const result = atCap({ state, source: 'plan', round: 2, head: 'b', policy: { mode: 'ask', max: 2 }, history: flagged, pr: 7 });
  assert.deepEqual([result.status, result.extension.status, result.extension.red_flags.map((reason) => reason.split(':')[0])], ['extension_check', 'judging', ['not converging']]);
  const capped = emptyState(7, 'o/r');
  capped.extensions = [{ source: 'plan', round: 2, status: 'granted', by: 'judge' }, { source: 'plan', round: 3, head: 'b', status: 'stopped', by: 'mechanical', reasons: ['bloating: old'], judge: { verdict: 'extend' } }];
  const ceiling = atCap({ state: capped, source: 'plan', round: 3, head: 'b', policy: { mode: 'auto', max: 1 }, history: flagged, pr: 7 });
  assert.deepEqual([ceiling.status, ceiling.extension.by, capped.extensions[1].judge], ['round_limit', 'ceiling', undefined], 'the ceiling still holds');
});

test('revalidate: a push that raises no new red flag keeps the Human`s approval over the flags it was given for', () => {
  const flat = () => ({ ...passing(), rounds: [round(1, 'a', [finding('a.js', 1, 'one')]), round(2, 'b', [finding('a.js', 90, 'two')], { added: 1, removed: 1, files: ['a.js'] })] });
  const state = emptyState(7, 'o/r');
  state.extensions = [{ source: 'plan', round: 2, head: 'b', status: 'granted', by: 'human', reasons: ['valid'], red_flags: ['not converging: round 2 left 1 open finding, round 1 left 1'], human: { answer: 'approve' }, mode: 'ask', max: 2 }];
  const entry = revalidate({ state, source: 'plan', round: 2, head: 'c0ffee1234', history: flat });
  assert.deepEqual([entry.status, entry.human?.answer], ['granted', 'approve']);
  assert.match(summaryBody(state, null, 'fix_required'), /granted by the Human[^\n]*\(over red flags: not converging\)/u);
  const bloated = () => ({ ...flat(), rounds: [round(1, 'a', [finding('a.js', 1, 'one')]), round(2, 'b', [finding('a.js', 90, 'two')], { added: 100, code_added: 100, removed: 0, files: ['a.js'] })] });
  const back = revalidate({ state, source: 'plan', round: 2, head: 'deadbee123', history: bloated });
  assert.deepEqual([back.status, back.human, back.reasons[0].split(':')[0]], ['judging', undefined, 'bloating'], 'a new flag name revokes the approval');
});

test('signals: a repeat raises its red flag by id with no text, by place, and by title where both are held; each evidence entry carries its id', () => {
  const byId = signals({ rounds: [round(1, 'a', [{ id: 'R1-1', file: null, line: null }, { id: 'R1-2' }]), round(2, 'b', [{ id: 'R1-1' }])] });
  assert.deepEqual([byId.looping, byId.evidence.looping[0].match, byId.evidence.looping[0].id], [true, 'id', 'R1-1']);
  assert.match(byId.reasons.find((reason) => reason.startsWith('looping')), /such as R1-1 in round 2/u);
  const noText = signals({ rounds: [round(1, 'a', [{ id: 'R1-1', file: 'src/a.js', line: 4 }, { id: 'R1-2' }]), round(2, 'b', [{ id: 'R2-5', file: 'src/a.js', line: 6 }])] });
  assert.deepEqual([noText.looping, noText.evidence.looping[0].match, noText.evidence.looping[0].id], [true, 'place', 'R2-5'], 'by place where a title is missing');
  const titled = signals({ rounds: [round(1, 'a', [{ id: 'R1-1', title: 'Refund total unchecked' }, { id: 'R1-2' }]), round(2, 'b', [{ id: 'R2-5', title: 'refund TOTAL unchecked' }])] });
  assert.equal(titled.evidence.looping[0].match, 'title');
  const untitled = signals({ rounds: [round(1, 'a', [{ id: 'R1-1', file: 'a.js', line: 1 }, { id: 'R1-2' }]), round(2, 'b', [{ id: 'R2-5', file: 'b.js', line: 90 }])] });
  assert.equal(untitled.looping, false, 'no id, no place, and no title held: no match');
  const drift = signals({ rounds: [round(1, 'a', [{ id: 'R1-1', file: 'a.js', line: 1 }]), round(2, 'b', [{ id: 'R2-5', file: 'z.js', line: 3 }])], originalFiles: ['a.js'] });
  assert.deepEqual(drift.evidence.drifting.map((entry) => entry.id), ['R2-5']);
});

test('await-review and extend on a public repository post the check at the cap with no reason, and the local record keeps it', async (t) => {
  const bot = botProject(t, {}, { visibility: 'PUBLIC' });
  assert.equal((await bot.run(converging)).out.status, 'extension_check');
  assert.equal(await bot.extend(['--verdict', 'extend', '--reason', 'SENTINEL f.js:3 is a valid high finding']), 0);
  const [summary] = bot.issue;
  assert.equal(stateFromComment(summary.body, 42).extensions[0].status, 'asking', 'the decision is on the pull request');
  assert.doesNotMatch(summary.body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n'), /SENTINEL/u);
  assert.doesNotMatch(JSON.stringify(stateFromComment(summary.body, 42)), /SENTINEL|One|Two|Three/u, 'no reason and no finding title in the posted record');
  assert.match(readLocalState(bot.project, 42).extensions[0].reasons[0], /SENTINEL/u);
});

test('a machine with no record that runs await-review on a public copy marks an untexted finding adopted, so its next step stops', async (t) => {
  const bot = botProject(t, {}, { visibility: 'PUBLIC' });
  assert.equal((await bot.run(converging)).out.status, 'extension_check');
  const mine = readLocalState(bot.project, 42);
  const head = 'f'.repeat(40);
  const theirs = { ...mine, revision: mine.revision + 3, planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] }, passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R1-4', mint: 'abcdef02', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  bot.issue[0].body = summaryBody(theirs, null, 'x', OPEN);
  bot.forget();
  await bot.run(converging);
  const written = readLocalState(bot.project, 42);
  assert.equal(written.passes['engine:codex-local'].list[0].adopted, true);
  assert.equal(untextedBlocking(written, written), 'R1-4', 'the step on this machine stops on it');
});

test('revalidate reads a posted copy`s bare red flag names as the flags they name: an approved grant survives identical signals', () => {
  const looped = () => ({ ...passing(), rounds: [round(1, 'a', [finding('a.js', 1, 'one'), finding('b.js', 9, 'x')]), round(2, 'b', [finding('a.js', 2, 'two')], { added: 1, removed: 1, files: ['a.js'] })] });
  const state = emptyState(7, 'o/r');
  // The entry as an adopted posted copy holds it: each red flag by its name alone.
  state.extensions = [{ source: 'plan', round: 2, head: 'b', status: 'granted', by: 'human', reasons: [], red_flags: ['looping'], human: { answer: 'approve' }, mode: 'ask', max: 2 }];
  const entry = revalidate({ state, source: 'plan', round: 2, head: 'c0ffee1234', history: looped });
  assert.deepEqual([entry.status, entry.human?.answer], ['granted', 'approve']);
  assert.match(askQuestion(7, 3, null, ['looping', 'bloating: added 90 lines']), /red flags \(looping, bloating\)/u);
});
