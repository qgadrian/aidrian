// `aidrian project stop-action` (lib/project-stops.mjs): each way an issue's auto-merge stops maps to exactly one action
// with its cap; the command takes the forge's part of an action through the forge facade, records it in the attempt's
// drop folder, keeps the caps across attempts (lib/stop-history.mjs), waits on a failed read rather than park, and parks
// once a cap is spent; only the issue's own session runs it; and the GitHub adapter's commands behind each new forge
// method. The run fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runIssueOf } from '../plugins/aidrian/lib/closing-words.mjs';
import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { appendToRun, validateSnapshot } from '../plugins/aidrian/lib/project-run.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { classifyStop, POLICY_REASONS, STOP_ACTIONS, STOP_CAPS, STOPS_FILE, stopLine, WAIT_PAUSE } from '../plugins/aidrian/lib/project-stops.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { archiveFile } from '../plugins/aidrian/lib/stop-history.mjs';
import { markFolder, markPending, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { decidedFixture, DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const HEAD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const CHILD = STARTED[0].session;

const view = (more = {}) => ({ number: 12, url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', status: 'CLEAN', head: HEAD, base: 'main', reviewDecision: '', latestReviews: [], ...more });
const on = (more = {}) => ({ result: { effective: true, reason: null, why: null, head: HEAD, strategy: 'squash', ...more } });
const off = (reason, more = {}) => ({ result: { effective: false, reason, why: `why ${reason}`, head: HEAD, strategy: 'squash', ...more } });
const ready = { verdict: 'ready', reason: '3 pass', runs: null };
const classify = (given) => classifyStop({ view: view(), autoMerge: on(), checks: ready, history: [], ...given });
const rows = (action, n, head = HEAD) => Array.from({ length: n }, () => ({ action, head }));
const lineOf = (decision, more = {}) => stopLine(decision, { view: view(), key: 'ENG-1', branch: 'feat/eng-1-export', ...more });

test('the forge\'s merge ends it, a closed pull request parks, and an auto-merge that could not answer waits under the wait cap', () => {
  assert.equal(classify({ view: view({ state: 'MERGED' }) }).action, 'done');
  assert.equal(classify({ view: view({ state: 'CLOSED' }) }).action, 'park');
  const none = classify({ autoMerge: { error: 'could not read the pull request with gh (HTTP 502)' }, attempt: 1 });
  assert.deepEqual([none.action, none.record, none.pause, /HTTP 502/u.test(none.why)], ['wait', 'retry', WAIT_PAUSE, true]);
  assert.match(lineOf(none), /\(1 of 3 for this attempt\); wait 60 seconds, then run the pr-auto-merge skill again$/u);
  const retries = (n, attempt = 1) => Array.from({ length: n }, () => ({ action: 'retry', head: HEAD, attempt }));
  // Each retry waits longer: 60, 300, then 900 seconds.
  assert.deepEqual([0, 1, 2].map((n) => classify({ autoMerge: { error: 'x' }, attempt: 1, history: retries(n) }).pause), [60, 300, 900]);
  assert.match(classify({ autoMerge: { error: 'x' }, attempt: 1, history: retries(3) }).why, /failed 3 times in this attempt already/u);
  assert.equal(classify({ autoMerge: { error: 'x' }, attempt: 1, history: retries(3) }).action, 'park', 'once the retry cap is spent');
  assert.equal(classify({ autoMerge: { error: 'x' }, attempt: 2, history: retries(3) }).action, 'wait', 'a new attempt retries again');
  // Retries spend nothing of the pending-check budget, and pending waits nothing of theirs.
  const pending = { verdict: 'pending', reason: '1 not terminal: e2e', runs: null };
  assert.equal(classify({ checks: pending, attempt: 1, history: retries(3) }).used, 1);
  assert.equal(classify({ autoMerge: { error: 'x' }, attempt: 1, history: rows('wait', 3) }).action, 'wait');
});

test('every policy reason, changes requested, a sign-off the Human owes, and a reason it does not know park with the reason', () => {
  for (const reason of POLICY_REASONS) {
    const decision = classify({ autoMerge: off(reason) });
    assert.deepEqual([decision.action, decision.why.includes(`(${reason})`)], ['park', true], reason);
  }
  assert.ok(POLICY_REASONS.includes('closes'), 'the closing-word refusal is a policy reason');
  const changes = classify({ autoMerge: off('review'), view: view({ latestReviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'ana' } }] }) });
  assert.deepEqual([changes.action, /ana requested changes/u.test(changes.why)], ['park', true]);
  const signoff = classify({ autoMerge: off('trust', { trust: 'signoff' }) });
  assert.deepEqual([signoff.action, /only the Human signs off/u.test(signoff.why)], ['park', true]);
  // A sign-off park is a decision for the Human, not an open pull request.
  // The safe option comes first, and is the one recommended.
  assert.match(lineOf(signoff), /; record the result parked with one decision of class product: the Human's sign-off of the flows of #12 at head aaaaaaa, options "leave the pull request unmerged" and "sign off from an attended session", recommended the first$/u);
  // The class is the flow's, as auto-merge names it: a security flow's sign-off is a security decision.
  assert.match(lineOf(classify({ autoMerge: off('trust', { trust: 'signoff', flow: 'auth', signoffClass: 'security' }) })), /one decision of class security: /u);
  assert.match(lineOf(classify({ autoMerge: off('trust', { trust: 'signoff', flow: 'checkout', signoffClass: 'product' }) })), /one decision of class product: /u);
  assert.match(lineOf(classify({ autoMerge: off('trust', { trust: 'signoff', signoffClass: 'other' }) })), /one decision of class product: /u, 'any other word is product');
  assert.match(lineOf(classify({ autoMerge: off('paths') })), /; record the result pr_open with this line as its stop$/u);
  assert.equal(classify({ autoMerge: off('outsider'), view: view({ status: 'BEHIND' }) }).action, 'park', 'a policy park comes before a base update');
  assert.equal(classify({ autoMerge: off('trust', { trust: 'signoff' }), view: view({ mergeable: 'CONFLICTING' }) }).action, 'park', 'a sign-off owed parks before an update that would void it');
  assert.equal(classify({ autoMerge: off('waived-for-good') }).action, 'park', 'an unknown reason parks');
  assert.equal(classify({ view: view({ draft: true }) }).action, 'park', 'a draft parks');
});

test('a conflict merges the base in and a branch behind its base is updated, at most twice per issue together; the line fetches both, merges only into a HEAD that holds the forge\'s branch, and says the new head voids every sign-off', () => {
  const conflict = classify({ view: view({ mergeable: 'CONFLICTING', status: 'DIRTY' }) });
  assert.deepEqual([conflict.action, conflict.used, conflict.cap], ['merge_base', 1, STOP_CAPS.base_update]);
  assert.match(lineOf(conflict), /^merge_base ENG-1 #12 at aaaaaaa: it conflicts with main; the new head voids every sign-off and review of this one, so a pull request whose flows need the Human's sign-off parks after it \(1 of 2 for this issue\); run `git fetch origin main feat\/eng-1-export`, and when it fails, run it again in this turn, up to three times in all; when it still fails, merge nothing and record the result pr_open with a stop that names the failed fetch, never asking this command again for it; `git merge-base --is-ancestor origin\/feat\/eng-1-export HEAD`: when it fails, HEAD does not hold the branch as the forge has it, so merge nothing and record the result pr_open with a stop that says feat\/eng-1-export diverged from origin\/feat\/eng-1-export; then `git merge-tree --write-tree --name-only HEAD origin\/main` lists the files that would conflict: when one is a host config or instruction file, record the result pr_open with that file's path in its stop, and merge nothing; else run `git merge --no-ff --no-edit origin\/main`, a merge commit, never a rebase, resolve the conflicts without editing a host config or instruction file by hand \(a merge git refuses over one is recorded the same way\), run the tests, commit, and push with `git push origin HEAD:refs\/heads\/feat\/eng-1-export` in a call of its own, never with force; then run the pr-auto-merge skill again$/u);
  // The catch-up at an attempt's start gives the same route, then goes on with the work.
  assert.equal(lineOf(conflict, { catchUp: true }), lineOf(conflict).replace(/; then run the pr-auto-merge skill again$/u, '; then go on with the work, the checks and the review on the new head'));
  assert.equal(classify({ view: view({ status: 'BEHIND' }), autoMerge: off('trust', { trust: 'bot' }) }).action, 'update_branch', 'an update comes before a bot request');
  assert.equal(classify({ view: view({ status: 'BEHIND' }), history: rows('merge_base', 1, NEW) }).used, 2, 'the two share one cap');
  const spent = classify({ view: view({ status: 'BEHIND' }), history: [...rows('merge_base', 1, NEW), ...rows('update_branch', 1, OTHER_HEAD)] });
  assert.deepEqual([spent.action, /base update has reached its cap of 2 for this issue/u.test(spent.why)], ['park', true]);
  assert.equal(classify({ view: view({ mergeable: 'UNKNOWN' }) }).action, 'wait', 'the forge still computing it waits');
});

test('a review refusal on a head a base update made gets one review round, with the round cap\'s waiver; any other review refusal parks', () => {
  const updated = [{ action: 'update_branch', head: NEW }];
  const round = classify({ autoMerge: off('review'), history: updated });
  assert.deepEqual([round.action, round.cap], ['review_round', 1]);
  assert.match(lineOf(round), /run one review round on this head, with § 4's waiver at the round cap; when it signs off with nothing to push, run the pr-auto-merge skill again, else record the result pr_open$/u);
  assert.equal(classify({ autoMerge: off('review'), history: [...updated, { action: 'review_round', head: HEAD }] }).action, 'park', 'once per head');
  assert.equal(classify({ autoMerge: off('review') }).action, 'park', 'no update made this head');
  assert.equal(classify({ autoMerge: off('review'), history: [{ action: 'update_branch', head: HEAD }] }).action, 'park', 'the update has not moved the head yet');
});

test('a bot verdict missing asks the bot once per head, then waits for it under the wait cap', () => {
  const ask = classify({ autoMerge: off('trust', { trust: 'bot' }) });
  assert.equal(ask.action, 'request_bot');
  assert.match(lineOf(ask), /run `aidrian pr await-review 12 --request`, then run the pr-auto-merge skill again/u);
  const slow = classify({ autoMerge: off('trust', { trust: 'bot' }), history: rows('request_bot', 1) });
  assert.deepEqual([slow.action, /asked for this head and has not passed it yet/u.test(slow.why)], ['wait', true]);
  assert.match(lineOf(slow), /; run `aidrian pr await-review 12`, which waits for the bot it asked, then run the pr-auto-merge skill again$/u, 'no second request');
  assert.equal(classify({ autoMerge: off('trust', { trust: 'bot' }), history: [...rows('request_bot', 1), ...rows('wait', 3)] }).action, 'park');
  assert.equal(classify({ autoMerge: off('trust', { trust: 'bot' }), history: rows('request_bot', 1, NEW) }).action, 'request_bot', 'a new head asks again');
});

test('with auto-merge on: failing checks run again once per head, pending checks wait three times, a blocked merge parks, and a merge is tried once per head', () => {
  const failing = { verdict: 'failing', reason: 'e2e=FAILURE', runs: [41, 42] };
  const rerun = classify({ checks: failing });
  assert.deepEqual([rerun.action, rerun.runs, rerun.cap], ['rerun_checks', [41, 42], 1]);
  assert.equal(classify({ checks: failing, history: rows('rerun_checks', 1) }).action, 'park', 'once per head');
  assert.equal(classify({ checks: { ...failing, runs: null } }).action, 'park', 'a failing check no Actions run reports');
  const pending = { verdict: 'pending', reason: '1 not terminal: e2e', runs: null };
  assert.equal(classify({ checks: pending, history: rows('wait', 2) }).used, 3);
  assert.equal(classify({ checks: pending, history: rows('wait', 3) }).action, 'park');
  assert.equal(classify({ checks: null }).action, 'park', 'checks it could not read');
  assert.equal(classify({ view: view({ status: 'BLOCKED' }) }).action, 'park');
  const merge = classify({});
  assert.deepEqual([merge.action, merge.cap], ['merge', 1]);
  const again = classify({ history: rows('merge', 1) });
  assert.deepEqual([again.action, again.why], ['park', 'auto-merge is on and nothing this command reads stops the merge, yet the merge steps stopped on this head before: they stopped for a reason this command does not read, and their stop line is the stop']);
  assert.match(lineOf(again), /; record the result pr_open with the merge steps' own stop line as its stop$/u);
  assert.equal(classify({ history: rows('merge', 1, NEW) }).action, 'merge', 'a new head tries again');
  assert.equal(classify({ autoMerge: on({ head: NEW }) }).action, 'wait', 'a head that moved between reads');
});

test('a line cleans its reason as a result\'s stop is: no control or bidirectional characters, and capped', () => {
  const line = lineOf({ action: 'park', why: `bad‮evil\u0007 ${'x'.repeat(400)}` });
  assert.ok(!/[‮\u0007]/u.test(line));
  assert.match(line, /^park ENG-1 #12 at aaaaaaa: badevil x+; record/u);
  assert.ok(line.length < 300 + 120, 'the reason is capped');
});

test('every action a line names is one the classifier gives, and each capped one has its cap', () => {
  assert.deepEqual([...STOP_ACTIONS].sort(), ['done', 'merge', 'merge_base', 'none', 'park', 'request_bot', 'rerun_checks', 'review_round', 'update_branch', 'wait']);
  assert.deepEqual(Object.keys(STOP_CAPS).sort(), ['base_update', 'merge', 'request_bot', 'rerun_checks', 'retry', 'review_round', 'wait']);
});

// A check row as the forge's checks gives it (forges/github.mjs checkRow).
const checkRow = (name, state, run, { repo = 'acme/widgets', workflow = 'ci' } = {}) => ({ name, state, workflow, event: 'pull_request', run, host: 'github.com', repo, workflowId: null });
// A workflow run as the forge describes it: by default a first run of HEAD on the issue's branch.
const workflowRun = (more = {}) => ({ head_sha: HEAD, head_branch: 'feat/eng-1-export', head_repository: { full_name: 'acme/widgets' }, run_attempt: 1, ...more });

// A run whose ENG-1 started, with a forge that also answers the stop's reads and records its writes. `fail` names forge
// methods that throw, as gh does on a network error.
function stopped(t, { merge = {}, checks = [checkRow('e2e', 'SUCCESS', 40)], force = false, runs = {}, fail = [], fx: given } = {}) {
  const fx = given ?? runFixture(t);
  if (!given) {
    const start = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(start.exitCode, 0, start.err.join('\n'));
  }
  const writes = [];
  // The start the merge is checked against, and a merge a minute after it by default.
  const startedAt = Date.parse(fx.rows().filter((row) => row.event === 'start' && row.outcome === 'started').at(-1).at);
  const gh = { mergedAt: new Date(startedAt + 60_000).toISOString(), view: { number: 12, url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD, headRefName: 'feat/eng-1-export', baseRefName: 'main', isCrossRepository: false, reviewDecision: '', latestReviews: [], ...merge }, checks, fail: new Set(fail) };
  const call = (name, args, answer) => {
    writes.push([name, ...args]);
    if (gh.fail.has(name)) throw Object.assign(new Error('gh failed'), { stderr: `gh: ${name} failed (HTTP 502)\n` });
    return answer();
  };
  const forge = {
    ...fx.forge,
    repository: (...args) => call('repository', args, () => fx.forge.repository(...args)),
    mergeState: (...args) => call('mergeState', args, () => gh.view),
    change: (...args) => call('change', args, () => ({ ...gh.view, mergedAt: gh.view.state === 'MERGED' ? gh.mergedAt : null })),
    checks: (...args) => call('checks', args, () => gh.checks),
    workflowRun: (repo, id, options) => call('workflowRun', [repo, id, options], () => workflowRun(runs[id])),
    rerunFailedChecks: (repo, ids, options) => call('rerunFailedChecks', [repo, ids, options], () => ids),
    branchAllowsForce: (...args) => call('branchAllowsForce', args, () => force),
    updateBranch: (...args) => call('updateBranch', args, () => ({})),
  };
  const dropOf = () => fx.rows().filter((row) => row.event === 'start' && row.outcome === 'started').at(-1).drop;
  const act = (autoMerge, session = CHILD) => fx.cmd(['stop-action', 'launch', 'ENG-1'], { session, forge, autoMerge: () => autoMerge });
  // The catch-up at an attempt's start, which reads no auto-merge answer.
  const catchUp = () => fx.cmd(['stop-action', 'launch', 'ENG-1', '--catch-up'], { session: CHILD, forge, autoMerge: () => assert.fail('the catch-up reads no auto-merge answer') });
  return { ...fx, gh, writes, drop: dropOf(), dropOf, act, catchUp, forge, startedAt };
}
const called = (fx, name) => fx.writes.filter((each) => each[0] === name);

test('a sign-off the Human owes parks with its line on an issue with a recorded decision too: the grant signs off no flow', (t) => {
  const fx = decidedFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.ok(fx.claude.starts()[0].args.at(-1).includes('a decision the Human recorded on this issue'), 'the grant stood');
  const parked = stopped(t, { fx }).act(off('trust', { trust: 'signoff' }));
  assert.equal(parked.exitCode, 0, parked.err.join('\n'));
  assert.match(parked.out[0], /^park ENG-1 #12 at aaaaaaa: .*; record the result parked with one decision of class product: the Human's sign-off of the flows of #12 at head aaaaaaa, options "leave the pull request unmerged" and "sign off from an attended session", recommended the first$/u);
});

test('stop-action reruns the failed jobs of first runs of the head through the forge, records it, and parks the second time', (t) => {
  const fx = stopped(t, { checks: [checkRow('e2e', 'FAILURE', 41), checkRow('lint', 'SUCCESS', 41)] });
  const first = fx.act(on());
  assert.equal(first.exitCode, 0, first.err.join('\n'));
  assert.match(first.out[0], /^rerun_checks ENG-1 #12 at aaaaaaa: its checks fail: e2e=FAILURE \(1 of 1 for this head\); the forge started the failed jobs of 1 workflow run again; then run the pr-auto-merge skill again$/u);
  assert.deepEqual(called(fx, 'workflowRun')[0], ['workflowRun', 'acme/widgets', 41, { host: 'github.com' }]);
  assert.deepEqual(called(fx, 'rerunFailedChecks')[0], ['rerunFailedChecks', 'acme/widgets', [41], { host: 'github.com' }]);
  assert.deepEqual(called(fx, 'mergeState')[0], ['mergeState', 'github.com/acme/widgets', 'feat/eng-1-export'], 'found by the issue\'s branch in the pinned repository');
  const history = readFileSync(path.join(fx.drop, STOPS_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(history.map(({ action, head, pr, attempt, session }) => ({ action, head, pr, attempt, session })), [{ action: 'rerun_checks', head: HEAD, pr: 12, attempt: 1, session: CHILD }]);
  assert.match(fx.act(on()).out[0], /^park ENG-1 #12 at aaaaaaa: its checks fail: e2e=FAILURE, and rerun checks has reached its cap of 1 for this head; record the result pr_open with this line as its stop$/u);
  assert.equal(called(fx, 'rerunFailedChecks').length, 1, 'no second rerun');
});

test('a failing check that is an app status, a fork\'s run, a run of another head or branch, or a run that ran twice is not run again: it parks', (t) => {
  const status = stopped(t, { checks: [checkRow('deploy', 'FAILURE', 999, { workflow: null })] });
  assert.match(status.act(on()).out[0], /^park ENG-1 #12 .*not every failing check is an Actions run of this repository/u);
  const fork = stopped(t, { checks: [checkRow('e2e', 'FAILURE', 41, { repo: 'evil/fork' })] });
  assert.match(fork.act(on()).out[0], /^park .*not every failing check is an Actions run/u);
  for (const [run, why] of [
    [{ run_attempt: 2 }, /workflow run 41 ran 2 times on head aaaaaaa already/u],
    [{ head_sha: NEW }, /workflow run 41 is not a run of head aaaaaaa on feat\/eng-1-export in acme\/widgets/u],
    [{ head_branch: 'feat/other' }, /is not a run of head/u],
    [{ head_repository: { full_name: 'evil/widgets' } }, /is not a run of head/u],
  ]) {
    const fx = stopped(t, { checks: [checkRow('e2e', 'FAILURE', 41)], runs: { 41: run } });
    assert.match(fx.act(on()).out[0], why);
    assert.equal(called(fx, 'rerunFailedChecks').length, 0);
  }
});

test('a branch behind its base is merged up to date on the forge, rebased only under the rebase strategy where its rules allow force, and never past the cap', (t) => {
  const fx = stopped(t, { merge: { mergeStateStatus: 'BEHIND' } });
  assert.match(fx.act(on()).out[0], /^update_branch ENG-1 #12 at aaaaaaa: it is behind main; the new head voids every sign-off .* \(1 of 2 for this issue\); the forge merged main into it; then run the pr-auto-merge skill again$/u);
  assert.deepEqual(called(fx, 'updateBranch')[0], ['updateBranch', 'acme/widgets', 12, { host: 'github.com', expectedHead: HEAD, method: 'merge' }]);
  assert.equal(called(fx, 'branchAllowsForce').length, 0, 'squash never asks for force');
  fx.act(on({ strategy: 'rebase' }));
  assert.equal(called(fx, 'updateBranch').at(-1)[3].method, 'merge', 'the branch rules forbid force: the base is merged in');
  assert.match(fx.act(on()).out[0], /^park .*base update has reached its cap of 2 for this issue/u);
  assert.equal(called(fx, 'updateBranch').length, 2);
  const rebase = stopped(t, { merge: { mergeStateStatus: 'BEHIND' }, force: true });
  assert.match(rebase.act(on({ strategy: 'rebase' })).out[0], /the forge rebased it onto main/u);
  assert.equal(called(rebase, 'updateBranch')[0][3].method, 'rebase');
});

test('stop-action answers a conflict, a stale review after an update, a missing bot, pending checks, and a merge, each recorded against its cap', (t) => {
  const fx = stopped(t, { merge: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } });
  assert.match(fx.act(on()).out[0], /^merge_base ENG-1 #12 at aaaaaaa: .*\(1 of 2 for this issue\); run `git fetch origin main feat\/eng-1-export`, and when it fails, run it again in this turn, up to three times in all; when it still fails, merge nothing and record the result pr_open with a stop that names the failed fetch, never asking this command again for it; `git merge-base --is-ancestor origin\/feat\/eng-1-export HEAD`/u);
  fx.gh.view = { ...fx.gh.view, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: NEW };
  assert.match(fx.act(off('review', { head: NEW })).out[0], /^review_round ENG-1 #12 at bbbbbbb: a base update made this head/u);
  assert.match(fx.act(off('trust', { head: NEW, trust: 'bot' })).out[0], /^request_bot ENG-1 #12 at bbbbbbb/u);
  assert.match(fx.act(off('trust', { head: NEW, trust: 'bot' })).out[0], /^wait ENG-1 #12 at bbbbbbb: the review bot was asked for this head/u);
  fx.gh.checks = [checkRow('e2e', 'IN_PROGRESS', 41)];
  assert.match(fx.act(on({ head: NEW })).out[0], /^wait ENG-1 #12 at bbbbbbb: its checks are pending: .* \(2 of 3 for this head\)/u);
  fx.gh.checks = [checkRow('e2e', 'SUCCESS', 41)];
  assert.match(fx.act(on({ head: NEW })).out[0], /^merge ENG-1 #12 at bbbbbbb: nothing stops the merge now \(1 of 1 for this head\); run the pr-auto-merge skill again$/u);
  assert.match(fx.act(on({ head: NEW })).out[0], /^park ENG-1 #12 at bbbbbbb: .*they stopped for a reason this command does not read/u);
  const recorded = readFileSync(path.join(fx.drop, STOPS_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line).action);
  assert.deepEqual(recorded, ['merge_base', 'review_round', 'request_bot', 'wait', 'wait', 'merge']);
});

test('a forge read or action that fails waits under the wait cap, and parks only once it is spent', (t) => {
  for (const [fail, given, why] of [
    [['mergeState'], {}, /^wait ENG-1 at an unknown head: the forge could not describe the pull request of feat\/eng-1-export \("gh: mergeState failed \(HTTP 502\)"\) \(1 of 3 for this attempt\); wait 60 seconds/u],
    [['repository'], {}, /^wait ENG-1 #12 at aaaaaaa: could not read the default branch/u],
    [['workflowRun'], { checks: [checkRow('e2e', 'FAILURE', 41)] }, /^wait .*the forge could not describe workflow run 41/u],
    [['rerunFailedChecks'], { checks: [checkRow('e2e', 'FAILURE', 41)] }, /^wait .*the forge could not start the failed jobs again \("gh: rerunFailedChecks failed \(HTTP 502\)"\)/u],
    [['updateBranch'], { merge: { mergeStateStatus: 'BEHIND' } }, /^wait .*the forge could not bring #12 up to date with main/u],
    // A checks read that fails waits on the retry cap, never on the pending checks' cap of this head.
    [['checks'], {}, /^wait ENG-1 #12 at aaaaaaa: the forge could not list the checks of #12 now \("gh: checks failed \(HTTP 502\)"\) \(1 of 3 for this attempt\); wait 60 seconds/u],
  ]) {
    const fx = stopped(t, { fail, ...given });
    assert.match(fx.act(on()).out[0], why, fail[0]);
    assert.match(fx.act(on()).out[0], /\(2 of 3 for this attempt\); wait 300 seconds in all, in 2 foreground waits of at most 150 seconds each, never one longer call, which the host moves to the background, then run the pr-auto-merge skill again$/u, `${fail[0]}: backs off`);
    assert.match(fx.act(on()).out[0], /\(3 of 3 for this attempt\); wait 900 seconds in all, in 6 foreground waits of at most 150 seconds each/u, `${fail[0]}: backs off`);
    assert.match(fx.act(on()).out[0], /^park .*failed 3 times in this attempt already/u, `${fail[0]}: spent`);
  }
  const exit3 = stopped(t);
  assert.match(exit3.act({ error: 'aidrian pr auto-merge: could not read the gh user (HTTP 502)' }).out[0], /^wait ENG-1 #12 at aaaaaaa: aidrian pr auto-merge could not answer now/u);
});

test('a pull request retargeted to another base parks with no forge update', (t) => {
  const fx = stopped(t, { merge: { baseRefName: 'release', mergeStateStatus: 'BEHIND' } });
  assert.match(fx.act(on()).out[0], /^park ENG-1 #12 at aaaaaaa: it targets release, not the default branch main/u);
  assert.equal(called(fx, 'updateBranch').length, 0);
  // The catch-up at an attempt's start parks it the same way, before it reads any conflict.
  fx.gh.view = { ...fx.gh.view, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' };
  assert.match(fx.catchUp().out[0], /^park ENG-1 #12 at aaaaaaa: it targets release, not the default branch main/u);
});

test('the catch-up gives a merged or closed pull request the answer stop-action gives without it', (t) => {
  const fx = stopped(t, { merge: { state: 'MERGED' } });
  const plain = fx.act(on()).out;
  assert.match(plain[0], /^done ENG-1 #12 at aaaaaaa: the forge shows it merged; record the result merged/u);
  assert.deepEqual(fx.catchUp().out, plain);
  fx.gh.view = { ...fx.gh.view, state: 'CLOSED' };
  const closed = fx.act(on()).out;
  assert.match(closed[0], /^park ENG-1 #12 at aaaaaaa: the forge shows it closed; record the result pr_open with this line as its stop$/u);
  assert.deepEqual(fx.catchUp().out, closed);
});

// A result handed over through `aidrian project result`, then the driver's `wait` that takes it in, under `forge`.
function handOver(t, fx, value, forge) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-result-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'result.json');
  writeFileSync(file, JSON.stringify(value));
  const handed = fx.cmd(['result', 'launch', 'ENG-1', '--file', file], { session: CHILD });
  assert.equal(handed.exitCode, 0, handed.err.join('\n'));
  return fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge }).out.filter((line) => line !== 'idle' && !line.startsWith('lingering '));
}

test('a merge the result command refuses as merged parks on one decision that names why, and the result command takes that decision in', (t) => {
  // Into the default branch after the start: done, by the result command's own check, which then records it merged.
  const done = stopped(t, { merge: { state: 'MERGED' } });
  assert.match(done.act(on()).out[0], /^done ENG-1 #12 at aaaaaaa: the forge shows it merged; record the result merged/u);
  assert.deepEqual(called(done, 'change')[0], ['change', '12', 'state,mergedAt,headRefName,baseRefName,url,isCrossRepository', { repo: 'github.com/acme/widgets' }]);
  // A merge check the forge cannot answer waits under the retry cap, never done; a retry row that cannot be kept parks on
  // the one decision, never on pr_open, which the result command may refuse for a merged pull request. The attempt's
  // rows are marked archived, so its history reads from the run's archive alone, and the drop's history file is a
  // folder, which no user, root included, appends to.
  done.gh.fail.add('change');
  const archive = archiveFile(done.state, 'launch', 'ENG-1');
  const history = path.join(done.drop, STOPS_FILE);
  mkdirSync(path.dirname(archive), { recursive: true });
  writeFileSync(archive, `${JSON.stringify({ event: 'archived', attempt: 1 })}\n`, { mode: 0o600 });
  mkdirSync(history);
  let unkept;
  try {
    unkept = done.act(on()).out[0];
  } finally {
    rmSync(history, { recursive: true });
    rmSync(archive);
  }
  assert.ok(unkept.startsWith('park ENG-1 #12 at aaaaaaa: the stop history cannot be kept: '), unkept);
  assert.doesNotMatch(unkept, /the stop history of /u, 'the append failed, not the read, whose refusal names the history it read');
  assert.ok(unkept.endsWith('; record the result parked with one decision of class other: whether the merge of #12 counts as the issue\'s work, options "leave the issue parked" and "count the issue done by hand once its work is on the default branch", recommended the first'), unkept);
  assert.match(done.act(on()).out[0], /^wait ENG-1 #12 at aaaaaaa: the forge shows it merged, and the merge check could not be read: the forge could not describe pull request #12 \(gh failed\) \(1 of 3 for this attempt\); wait 60 seconds, then run the pr-auto-merge skill again$/u);
  done.gh.fail.delete('change');
  assert.deepEqual(handOver(t, done, { status: 'merged', pr: 12 }, done.forge), ['result ENG-1 merged -> done']);
  // Into another branch, at the start instant, or before the start: the park line names the result command's own reason.
  const fx = stopped(t, { merge: { state: 'MERGED', baseRefName: 'release' } });
  const refusals = [
    ['into another branch', 'release', 60_000, 'pull request #12 merged into "release", not the default branch main'],
    ['at the start instant', 'main', 0, 'pull request #12 merged before this attempt started'],
    ['before the start', 'main', -60_000, 'pull request #12 merged before this attempt started'],
  ];
  let line;
  for (const [name, base, offset, why] of refusals) {
    fx.gh.view = { ...fx.gh.view, baseRefName: base };
    fx.gh.mergedAt = new Date(fx.startedAt + offset).toISOString();
    line = fx.act(on()).out[0];
    assert.ok(line.startsWith(`park ENG-1 #12 at aaaaaaa: the forge shows it merged, and the result command cannot record it merged: ${why}; `), `${name}: ${line}`);
    assert.ok(line.endsWith('; record the result parked with one decision of class other: whether the merge of #12 counts as the issue\'s work, options "leave the issue parked" and "count the issue done by hand once its work is on the default branch", recommended the first'), `${name}: ${line}`);
    assert.deepEqual(fx.catchUp().out, [line], `${name}: the catch-up answers the same`);
  }
  assert.equal(existsSync(path.join(fx.drop, STOPS_FILE)), false, 'a park spends no cap');
  // A merge check the forge cannot answer waits three times in the attempt, plain or caught up; the fourth call parks
  // on the same one decision, never on pr_open, which the result command may refuse for a merged pull request.
  const decided = '; record the result parked with one decision of class other: whether the merge of #12 counts as the issue\'s work, options "leave the issue parked" and "count the issue done by hand once its work is on the default branch", recommended the first';
  fx.gh.fail.add('change');
  assert.match(fx.act(on()).out[0], /^wait .*the merge check could not be read: .*\(1 of 3 for this attempt\); wait 60 seconds, then run the pr-auto-merge skill again$/u);
  assert.match(fx.act(on()).out[0], /\(2 of 3 for this attempt\); wait 300 seconds/u);
  assert.match(fx.catchUp().out[0], /\(3 of 3 for this attempt\); wait 900 seconds in all, .*then run this command again$/u);
  for (const [name, call] of [['plain', () => fx.act(on())], ['caught up', () => fx.catchUp()]]) {
    const spent = call().out[0];
    assert.ok(spent.startsWith('park ENG-1 #12 at aaaaaaa: the forge shows it merged, and the merge check could not be read: the forge could not describe pull request #12 (gh failed), and it failed 3 times in this attempt already; '), `${name}: ${spent}`);
    assert.ok(spent.endsWith(decided), `${name}: ${spent}`);
  }
  fx.gh.fail.delete('change');
  // The outcome the line names is one the result command records, where merged is refused (project-result.test.mjs).
  const decision = { question: 'Pull request #12 merged before this attempt started, so the run cannot count it as ENG-1\'s work. Does it count?', options: ['leave the issue parked', 'count the issue done by hand once its work is on the default branch'], recommended: 0, class: 'other' };
  assert.deepEqual(handOver(t, fx, { status: 'parked', pr: 12, decisions: [decision], stop: line }, fx.forge), ['result ENG-1 parked -> parked decision-1']);
});

test('the catch-up at an attempt\'s start merges a base a draft conflicts with, under the base-update cap, and otherwise goes on', (t) => {
  const fx = stopped(t, { merge: { isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } });
  assert.match(fx.catchUp().out[0], /^merge_base ENG-1 #12 at aaaaaaa: it conflicts with main; .*\(1 of 2 for this issue\); run `git fetch origin main feat\/eng-1-export`, and when it fails, run it again in this turn, up to three times in all; when it still fails, merge nothing and record the result pr_open with a stop that names the failed fetch, never asking this command again for it; `git merge-base --is-ancestor origin\/feat\/eng-1-export HEAD`.*`git merge-tree --write-tree --name-only HEAD origin\/main`.*; then go on with the work, the checks and the review on the new head$/u);
  fx.gh.view = { ...fx.gh.view, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', headRefOid: NEW };
  assert.match(fx.catchUp().out[0], /^wait ENG-1 #12 at bbbbbbb: the forge has not worked out yet whether it merges \(1 of 3 for this head\); wait 60 seconds, then run this command again$/u);
  fx.gh.view = { ...fx.gh.view, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
  assert.equal(fx.catchUp().out[0], 'none ENG-1 #12 at bbbbbbb: it does not conflict with main; go on with the work');
  fx.gh.view = { ...fx.gh.view, headRefOid: OTHER_HEAD, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  assert.match(fx.catchUp().out[0], /^merge_base .*\(2 of 2 for this issue\)/u);
  fx.gh.view = { ...fx.gh.view, headRefOid: HEAD };
  assert.match(fx.catchUp().out[0], /^park .*base update has reached its cap of 2 for this issue/u);
  const recorded = readFileSync(path.join(fx.drop, STOPS_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line).action);
  assert.deepEqual(recorded, ['merge_base', 'wait', 'merge_base']);
  assert.equal(called(fx, 'updateBranch').length, 0);
});

test('a stop history that is a link, a FIFO, a hard link, or holds a row the command did not write parks, without blocking or writing elsewhere', (t) => {
  const link = stopped(t);
  writeFileSync(path.join(link.root, 'elsewhere.jsonl'), '');
  symlinkSync(path.join(link.root, 'elsewhere.jsonl'), path.join(link.drop, STOPS_FILE));
  assert.match(link.act(on()).out[0], /^park ENG-1 at an unknown head: the stop history of attempt 1: .*cannot be opened as a file \(ELOOP\)/u);
  const fifo = stopped(t);
  execFileSync('mkfifo', [path.join(fifo.drop, STOPS_FILE)]);
  assert.match(fifo.act(on()).out[0], /^park .*is not a regular file/u, 'no hang on the FIFO');
  const hard = stopped(t);
  const target = path.join(hard.root, 'target.jsonl');
  writeFileSync(target, '');
  linkSync(target, path.join(hard.drop, STOPS_FILE));
  assert.match(hard.act(on()).out[0], /^park .*has 2 links/u);
  assert.equal(readFileSync(target, 'utf8'), '', 'nothing written through the link');
  const planted = stopped(t);
  writeFileSync(path.join(planted.drop, STOPS_FILE), `${JSON.stringify({ action: 'park', head: HEAD })}\n`);
  assert.match(planted.act(on()).out[0], /^park .*holds a row the stop command did not write/u);
});

test('the caps hold across attempts: the driver\'s sweep archives an attempt\'s history before it removes its folder', (t) => {
  const fx = stopped(t, { merge: { mergeStateStatus: 'BEHIND' } });
  assert.match(fx.act(on()).out[0], /^update_branch .*\(1 of 2 for this issue\)/u);
  fx.claude.states[CHILD] = 'done';
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
  assert.ok(!existsSync(path.dirname(fx.drop)), 'the first attempt\'s folder is swept');
  const archived = readFileSync(archiveFile(fx.state, 'launch', 'ENG-1'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(archived.map((row) => row.action ?? row.event), ['update_branch', 'archived']);
  // Only the fields the caps read are archived: no session, time, or other text of the drop's row.
  assert.deepEqual(archived[0], { action: 'update_branch', head: HEAD, pr: 12, attempt: 1 });
  // A later wait does not archive a swept attempt again.
  fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.equal(readFileSync(archiveFile(fx.state, 'launch', 'ENG-1'), 'utf8').trim().split('\n').length, 2);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const second = stopped(t, { fx, merge: { mergeStateStatus: 'BEHIND' } });
  assert.match(second.act(on(), STARTED[1].session).out[0], /^update_branch .*\(2 of 2 for this issue\)/u);
  assert.match(second.act(on(), STARTED[1].session).out[0], /^park .*base update has reached its cap of 2 for this issue/u);
});

test('only the issue\'s own session runs it: not the driver, another issue\'s session, or a session whose mark names another issue or run', (t) => {
  const fx = stopped(t);
  // ENG-4 runs too, in the session OTHER, as a start the gate wrote names it.
  const ENG4 = OTHER;
  const at = new Date().toISOString();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-4', attempt: 1, session: DRIVER, name: 'launch · ENG-4 · 1', cwd: fx.dir, outcome: 'started', id: ENG4, child: ENG4, at },
    { event: 'issue', key: 'ENG-4', state: 'running', at },
  ] }));
  markUnattended(ENG4, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-4' } });
  assert.match(fx.act(on(), DRIVER).err[0], /only the newest session of the chain the run started for the issue ENG-1/u);
  assert.match(fx.act(on(), ENG4).err[0], /only the newest session of the chain the run started for the issue ENG-1/u);
  const ask = (session) => projectCommandDenial({ tool_name: 'Bash', tool_input: { command: 'aidrian project stop-action launch ENG-1' }, session_id: session, cwd: fx.dir }, fx.config, { unattended: () => false, home: fx.home });
  assert.equal(ask(CHILD), null);
  for (const session of [DRIVER, ENG4]) assert.match(ask(session)?.reason ?? '', /`aidrian project stop-action` acts on the pull request of an issue, for the issue's own session only/u, session);
  assert.ok(projectCommandDenial({ tool_name: 'Bash', tool_input: { command: 'aidrian project stop-action launch ENG-1' }, session_id: CHILD, agent_id: 'a1', cwd: fx.dir }, fx.config, { home: fx.home }), 'a subagent');
  // The issue's own session, whose mark names another issue or another run.
  for (const tags of [{ project: 'launch', issue: 'ENG-4' }, { project: 'other', issue: 'ENG-1' }]) {
    markUnattended(CHILD, { root: fx.dir, env: fx.env, tags });
    assert.match(fx.act(on()).err[0], /this session's unattended mark names the issue/u, JSON.stringify(tags));
    assert.match(ask(CHILD)?.reason ?? '', /this session's unattended mark names the issue/u);
  }
});

test('it finds the issue\'s own pull request only, in the pinned repository', (t) => {
  const fx = stopped(t);
  fx.gh.view = { ...fx.gh.view, headRefName: 'feat/other' };
  assert.match(fx.act(on()).err[0], /pull request #12 is not from the issue's own branch feat\/eng-1-export/u);
  fx.gh.view = { ...fx.gh.view, headRefName: 'feat/eng-1-export', url: 'https://github.com/evil/widgets/pull/12' };
  assert.match(fx.act(on()).err[0], /pull request #12 is not in github\.com\/acme\/widgets/u);
  fx.gh.view = { ...fx.gh.view, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: true };
  assert.match(fx.act(on()).err[0], /is not from the issue's own branch/u);
});

test('through the real auto-merge gate: a child whose body closes another run issue parks on closes, and a gate error waits', (t) => {
  const fx = runFixture(t, { local: { handoff: { background: 'on' }, github: { autoMerge: 'on' } }, config: { github: { requiredChecks: ['e2e'], autoMerge: { allow: true, strategy: 'squash' } } } });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const record = emptyState(12, 'acme/widgets');
  record.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' };
  writeLocalState(fx.project, record);
  const base = stopped(t, { fx });
  const gate = { body: 'Fixes ENG-1, ENG-2', viewer: () => 'adrian' };
  const forge = {
    ...base.forge,
    change: () => ({ number: 12, headRefOid: HEAD, baseRefName: 'main', author: { login: 'adrian' }, url: 'https://github.com/acme/widgets/pull/12', files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], changedFiles: 1, reviewDecision: '', latestReviews: [] }),
    viewer: () => gate.viewer(),
    conversationComments: () => [],
    reviews: () => [],
    reviewComments: () => [],
    pull: () => ({ head: { sha: HEAD }, title: 'feat(export): add CSV export', body: '', commits: 1 }),
    changeCommits: () => [{ sha: HEAD, commit: { message: 'feat: export' } }],
    // The review trail, the one snapshot the gate judges the title, body, and closing links from.
    reviewTrail: () => ({ head: HEAD, title: 'feat(export): add CSV export', body: gate.body, closingIssues: [], closingIssuesComplete: true }),
  };
  const act = () => fx.cmd(['stop-action', 'launch', 'ENG-1'], { session: CHILD, forge });
  assert.match(act().out[0], /^park ENG-1 #12 at aaaaaaa: auto-merge is off \(closes\): its body says "Fixes ENG-2"/u);
  gate.viewer = () => {
    throw Object.assign(new Error('gh'), { stderr: 'gh: HTTP 502\n' });
  };
  assert.match(act().out[0], /^wait ENG-1 #12 at aaaaaaa: aidrian pr auto-merge could not answer now: aidrian pr auto-merge: could not read the gh user/u);
});

test('the closing-word check holds a session whose mark names a run\'s issue to that issue; a pending, unreadable, or malformed mark to none; and no other session', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-stops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state') };
  assert.equal(runIssueOf(CHILD, { env }), undefined, 'no mark');
  markUnattended(OTHER, { root, env });
  assert.equal(runIssueOf(OTHER, { env }), undefined, 'a mark with no run');
  markUnattended(CHILD, { root, env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.equal(runIssueOf(CHILD, { env }), 'ENG-1');
  writeFileSync(path.join(markFolder(env), `${CHILD}.json`), JSON.stringify({ root, project: 'launch', issue: '../x' }));
  assert.equal(runIssueOf(CHILD, { env }), null, 'tags of a wrong shape');
  writeFileSync(path.join(markFolder(env), `${CHILD}.json`), 'not json');
  assert.equal(runIssueOf(CHILD, { env }), null, 'a mark it cannot read');
  const pending = STARTED[2].session;
  mkdirSync(path.join(root, 'work'), { recursive: true });
  markPending(DRIVER, { cwd: path.join(root, 'work'), root, known: [], env });
  assert.equal(runIssueOf(pending, { env }), null, 'a session a pending mark holds: every reference counts');
});

// The GitHub adapter over a recording gh.
function recorded(answer) {
  const calls = [];
  const forge = createGithubForge({ cwd: '/repo', run: (args, options) => (calls.push({ args, input: options.input }), answer(args)) });
  return { forge, calls };
}

test('the GitHub adapter: the merge state view, a workflow run, the failed-job reruns, the force rule, the two updates, and the commit list', () => {
  const { forge, calls } = recorded((args) => {
    if (args.includes('repos/acme/w/branches/feat%2Fx')) return JSON.stringify({ protected: false });
    if (args.includes('repos/acme/w/rules/branches/feat%2Fx')) return JSON.stringify([[{ type: 'deletion' }]]);
    if (args.includes('repos/acme/w/pulls/12')) return JSON.stringify({ node_id: 'PR_kw12' });
    if (args.some((arg) => arg.includes('/commits'))) return '[[]]';
    return '{}';
  });
  forge.mergeState('github.com/acme/w', 'feat/x');
  assert.deepEqual(calls.at(-1).args.slice(0, 5), ['pr', 'view', 'feat/x', '--repo', 'github.com/acme/w']);
  assert.match(calls.at(-1).args.at(-1), /mergeable,mergeStateStatus,headRefOid,headRefName/u);
  forge.workflowRun('acme/w', 41, { host: 'github.com' });
  assert.deepEqual(calls.at(-1).args, ['api', '--hostname', 'github.com', 'repos/acme/w/actions/runs/41']);
  assert.throws(() => forge.workflowRun('acme/w', '41/../x'), /a workflow run id must be a positive whole number/u);
  assert.deepEqual(forge.rerunFailedChecks('acme/w', [41, '42'], { host: 'github.com' }), [41, 42]);
  assert.deepEqual(calls.slice(-2).map((call) => call.args), [41, 42].map((id) => ['api', '--hostname', 'github.com', `repos/acme/w/actions/runs/${id}/rerun-failed-jobs`, '--method', 'POST']));
  assert.throws(() => forge.rerunFailedChecks('acme/w', ['41/../x']), /a workflow run id must be a positive whole number/u);
  assert.equal(forge.branchAllowsForce('acme/w', 'feat/x'), true);
  forge.updateBranch('acme/w', 12, { expectedHead: HEAD });
  assert.deepEqual(calls.at(-1).args, ['api', 'repos/acme/w/pulls/12/update-branch', '--method', 'PUT', '-f', `expected_head_sha=${HEAD}`]);
  forge.updateBranch('acme/w', 12, { expectedHead: HEAD, method: 'rebase' });
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ['api', 'graphql']);
  assert.ok(calls.at(-1).args.includes('id=PR_kw12') && calls.at(-1).args.includes(`head=${HEAD}`) && /updateMethod:REBASE/u.test(calls.at(-1).args.join(' ')));
  assert.throws(() => forge.updateBranch('acme/w', 12, { expectedHead: 'main' }), /a full commit SHA/u);
  forge.changeCommits('acme/w', 12);
  assert.deepEqual(calls.at(-1).args, ['api', 'repos/acme/w/pulls/12/commits?per_page=100', '--paginate', '--slurp']);
});

test('the force rule is false for a protected branch, a non-fast-forward ruleset, or rules it cannot read whole', () => {
  const ask = (branch, rules) => recorded((args) => (args.some((arg) => arg.includes('/rules/')) ? JSON.stringify(rules) : JSON.stringify(branch))).forge.branchAllowsForce('acme/w', 'x');
  assert.equal(ask({ protected: true }, [[]]), false);
  assert.equal(ask({}, [[]]), false, 'a branch answer with no protected field');
  assert.equal(ask({ protected: false }, [[{ type: 'non_fast_forward' }]]), false);
  assert.equal(ask({ protected: false }, [[{}]]), false);
  assert.equal(ask({ protected: false }, [[]]), true);
});

test('the run snapshot keeps an optional teams list, each a team key, for the closing-word check', () => {
  const issues = [{ key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted' }];
  assert.equal(validateSnapshot({ issues }).snapshot.teams, undefined, 'no teams: none kept');
  assert.deepEqual(validateSnapshot({ issues, teams: ['ENG', 'OPS', 'ENG'] }).snapshot.teams, ['ENG', 'OPS']);
  for (const teams of ['ENG', [1], ['eng'], ['ENG-1'], ['A'.repeat(17)], Array(501).fill('ENG')]) {
    const checked = validateSnapshot({ issues, teams });
    assert.equal(checked.snapshot, null, JSON.stringify(teams).slice(0, 40));
    assert.match(checked.problems.join('\n'), /team key|"teams" is not a list/u);
  }
});
