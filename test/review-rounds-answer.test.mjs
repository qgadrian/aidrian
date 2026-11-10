import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { ASK_ROUTE, check, OVERRIDE_REASON } from '../plugins/aidrian/lib/rules/github/review-rounds.mjs';

// The deny of `command`, which must start with the rule's message: what follows it is the miss the rule names.
const missOf = (command, context) => {
  const denied = check(command, context) ?? '';
  assert.ok(denied.startsWith(OVERRIDE_REASON), `${command}: ${denied}`);
  return denied.slice(OVERRIDE_REASON.length);
};

function setup(t, answers) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-rounds-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { reviewer: 'bot[bot]' } }));
  const file = path.join(dir, 't.jsonl');
  writeFileSync(file, answers.map((one) => JSON.stringify({ type: 'user', toolUseResult: { answers: one } })).join('\n'));
  return { cwd: dir, input: { transcript_path: file } };
}

test('the round override runs only as the exact raise the Human approved in the session', (t) => {
  const context = setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Approve (Recommended)' }]);
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4', context), null);
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 12 --request --max-rounds 4', context), null);
  for (const command of [
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 5',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 1 --max-rounds 4',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds "$N"',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr attest 12 --max-rounds 4',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 npm test',
    'export AIDRIAN_ALLOW_EXTRA_ROUNDS=1',
  ]) missOf(command, context);
});

test('with no Approve answer the round override stays denied', (t) => {
  const command = 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4';
  missOf(command, setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Deny' }]));
  missOf(command, setup(t, []));
});

test('a raise approved for another repository does not run here', (t) => {
  const context = setup(t, [{ 'Raise the cap on fork/r#12 to --max-rounds 4?': 'Approve' }]);
  missOf('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4', context);
});

test('an approved raise aimed elsewhere, or in a checkout with several remotes, stays denied', (t) => {
  const context = setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Approve' }]);
  const raise = 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4';
  for (const aimed of [`cd /other && ${raise}`, `env -C /other ${raise}`, `GH_REPO=x/y ${raise}`]) missOf(aimed, context);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd: context.cwd });
  missOf(raise, context);
});


test('in a checkout with several remotes, the first deny says no answer counts and names the Human`s own shell', (t) => {
  // 2026-11-10: an approved answer naming <owner>/<name>#<PR> and --max-rounds <N> was refused three times, each with the
  // same message, which sent the session back to the question it had already asked. Two remotes were the cause.
  const context = setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Approve --max-rounds 4 (Recommended)' }]);
  execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/up/r.git'], { cwd: context.cwd });
  for (const command of ['AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4', 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 env -C "$W" aidrian pr review 12 --with-bot --max-rounds 10']) {
    const miss = missOf(command, context);
    assert.match(miss, /This checkout has several remotes/u, command);
    assert.match(miss, /in their own shell/u, command);
    assert.match(miss, /`AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds <N>`/u, 'the command to hand over, for this pull request');
    assert.doesNotMatch(miss, /AskUserQuestion/u, 'asking again cannot help here');
    assert.doesNotMatch(miss, new RegExp(ASK_ROUTE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'nor does the lead offer the ask');
  }
});

test('every deny of the round override names what the transcript or the command missed', (t) => {
  const raise = 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4';
  assert.match(missOf(raise, setup(t, [])), /^ Stop at round_limit.* The transcript holds no AskUserQuestion answer\.$/su, 'one remote, nothing waiting: the ask, then the miss');
  assert.match(missOf(raise, setup(t, [{ 'Grant round 5 on #12?': 'Approve' }])), /No answered question names `o\/r#12`/u);
  assert.match(missOf(raise, setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 5?': 'Approve' }])), /The questions naming `o\/r#12` do not name `--max-rounds 4`/u);
  assert.match(missOf(raise, setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Deny' }])), /The Human picked "Deny"/u);
  const context = setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Approve' }]);
  for (const aimed of [`cd /other && ${raise}`, `env -C /other ${raise}`, `${raise} && echo done`]) assert.match(missOf(aimed, context), /one plain command/u, aimed);
  for (const shape of ['AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds "$N"', 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --depth deep --max-rounds 4', 'export AIDRIAN_ALLOW_EXTRA_ROUNDS=1']) {
    assert.match(missOf(shape, context), /only `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review <PR> --max-rounds <N>`/u, shape);
  }
});

test('an approved raise runs on the review step that also runs the bot', (t) => {
  const context = setup(t, [{ 'Raise the cap on o/r#12 to --max-rounds 4?': 'Approve' }]);
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --with-bot --max-rounds 4', context), null);
  assert.ok(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 12 --with-bot --max-rounds 4', context), 'await-review takes --request, not --with-bot');
});

test('while a check at the cap waits for the judge or the Human, the override deny names that route first', (t) => {
  const context = setup(t, [{ 'Grant round 5 on #12?': 'Grant round 5 (Recommended)' }]);
  const project = projectAt(context.cwd);
  const state = emptyState(12, 'o/r');
  state.extensions = [{ source: 'plan', round: 4, head: 'd', status: 'judging' }];
  writeLocalState(project, state);
  const judging = missOf('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 5', context);
  assert.match(judging, /The check at round 4 on pull request #12 waits for the judge/u);
  assert.match(judging, /`aidrian pr extend 12 --verdict extend\|stop/u);
  assert.ok(judging.indexOf('waits for the judge') < judging.indexOf('No answered question'), 'the route comes before the miss');
  state.extensions = [{ source: 'bot', round: 4, head: 'd', status: 'asking', judge: { verdict: 'extend', reason: 'r', at: '2026-11-01T10:00:00.000Z' } }];
  writeLocalState(project, state);
  const asking = missOf('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 12 --request --max-rounds 5', context);
  assert.match(asking, /waits for the Human.*`aidrian pr extend 12 --human approve`/su);
});
