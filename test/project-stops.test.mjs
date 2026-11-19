// `aidrian project stop-action` (lib/project-stops.mjs): each way an issue's auto-merge stops maps to exactly one action
// with its cap; the command takes the forge's part of an action through the forge facade, records it in the attempt's
// drop folder, and parks once a cap is reached; only the run's driver or the issue's own session runs it; and the GitHub
// adapter's commands behind each new forge method. The run fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { runIssueOf } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { markFolder, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { classifyStop, POLICY_REASONS, STOP_ACTIONS, STOP_CAPS, STOPS_FILE, stopLine } from '../plugins/aidrian/lib/project-stops.mjs';
import { DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

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

test('the forge\'s merge ends it, a closed pull request parks, and an auto-merge with no answer parks', () => {
  assert.equal(classify({ view: view({ state: 'MERGED' }) }).action, 'done');
  assert.equal(classify({ view: view({ state: 'CLOSED' }) }).action, 'park');
  const none = classify({ autoMerge: { error: 'could not read the pull request with gh (HTTP 502)' } });
  assert.deepEqual([none.action, /HTTP 502/u.test(none.why)], ['park', true]);
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
  // A policy park comes before a base update: no update can lift it.
  assert.equal(classify({ autoMerge: off('outsider'), view: view({ status: 'BEHIND' }) }).action, 'park');
  assert.equal(classify({ autoMerge: off('trust', { trust: 'signoff' }), view: view({ mergeable: 'CONFLICTING' }) }).action, 'park', 'a sign-off owed parks before an update that would void it');
  assert.equal(classify({ autoMerge: off('waived-for-good') }).action, 'park', 'an unknown reason parks');
  assert.equal(classify({ view: view({ draft: true }) }).action, 'park', 'a draft parks');
});

test('a conflict merges the base in and a branch behind its base is updated, at most twice per issue together, and the line says the new head voids every sign-off', () => {
  const conflict = classify({ view: view({ mergeable: 'CONFLICTING', status: 'DIRTY' }) });
  assert.deepEqual([conflict.action, conflict.used, conflict.cap], ['merge_base', 1, STOP_CAPS.base_update]);
  const line = stopLine(conflict, { view: view(), key: 'ENG-1', branch: 'feat/eng-1-export' });
  assert.match(line, /^merge_base ENG-1 #12 at aaaaaaa: it conflicts with main; the new head voids every sign-off and review of this one, so a pull request whose flows need the Human's sign-off parks after it \(1 of 2 for this issue\); merge origin\/main into feat\/eng-1-export, .*push with `git push origin HEAD:refs\/heads\/feat\/eng-1-export`, never with force/u);
  const behind = classify({ view: view({ status: 'BEHIND' }), autoMerge: off('trust', { trust: 'bot' }) });
  assert.equal(behind.action, 'update_branch', 'an update comes before a bot request, which the new head would need again');
  assert.equal(classify({ view: view({ status: 'BEHIND' }), history: [...rows('merge_base', 1, NEW)] }).used, 2, 'the two share one cap');
  const capped = classify({ view: view({ status: 'BEHIND' }), history: [...rows('merge_base', 1, NEW), ...rows('update_branch', 1, OTHER_HEAD)] });
  assert.deepEqual([capped.action, /base update has reached its cap of 2 for this issue/u.test(capped.why)], ['park', true]);
  assert.equal(classify({ view: view({ mergeable: 'UNKNOWN' }) }).action, 'wait', 'the forge still computing it waits');
});

test('a review refusal on a head a base update made gets one review round; any other review refusal parks', () => {
  const updated = [{ action: 'update_branch', head: NEW }];
  const round = classify({ autoMerge: off('review'), history: updated });
  assert.deepEqual([round.action, round.cap], ['review_round', 1]);
  assert.equal(classify({ autoMerge: off('review'), history: [...updated, { action: 'review_round', head: HEAD }] }).action, 'park', 'once per head');
  assert.equal(classify({ autoMerge: off('review') }).action, 'park', 'no update made this head');
  assert.equal(classify({ autoMerge: off('review'), history: [{ action: 'update_branch', head: HEAD }] }).action, 'park', 'the update has not moved the head yet');
});

test('a bot verdict missing asks the bot once per head, then parks', () => {
  const ask = classify({ autoMerge: off('trust', { trust: 'bot' }) });
  assert.equal(ask.action, 'request_bot');
  assert.match(stopLine(ask, { view: view(), key: 'ENG-1', branch: 'b' }), /run `aidrian pr await-review 12 --request`, then run the pr-auto-merge skill again/u);
  assert.equal(classify({ autoMerge: off('trust', { trust: 'bot' }), history: rows('request_bot', 1) }).action, 'park');
  assert.equal(classify({ autoMerge: off('trust', { trust: 'bot' }), history: rows('request_bot', 1, NEW) }).action, 'request_bot', 'a new head asks again');
});

test('with auto-merge on: failing checks of workflow runs run again once per head, pending checks wait three times, a blocked merge parks, and else it merges', () => {
  const failing = { verdict: 'failing', reason: 'e2e=FAILURE', runs: [41, 42] };
  const rerun = classify({ checks: failing });
  assert.deepEqual([rerun.action, rerun.runs, rerun.cap], ['rerun_checks', [41, 42], 1]);
  assert.equal(classify({ checks: failing, history: rows('rerun_checks', 1) }).action, 'park', 'once per head');
  assert.equal(classify({ checks: { ...failing, runs: null } }).action, 'park', 'a failing check no workflow run reports');
  const pending = { verdict: 'pending', reason: '1 not terminal: e2e', runs: null };
  assert.equal(classify({ checks: pending, history: rows('wait', 2) }).used, 3);
  assert.equal(classify({ checks: pending, history: rows('wait', 3) }).action, 'park');
  assert.equal(classify({ checks: null }).action, 'park', 'checks it could not read');
  assert.equal(classify({ view: view({ status: 'BLOCKED' }) }).action, 'park');
  assert.equal(classify({}).action, 'merge');
  assert.equal(classify({ autoMerge: on({ head: NEW }) }).action, 'wait', 'a head that moved between reads');
});

test('every action a line names is one the classifier gives, and each capped one has its cap', () => {
  assert.deepEqual([...STOP_ACTIONS].sort(), ['done', 'merge', 'merge_base', 'park', 'request_bot', 'rerun_checks', 'review_round', 'update_branch', 'wait']);
  assert.deepEqual(Object.keys(STOP_CAPS).sort(), ['base_update', 'request_bot', 'rerun_checks', 'review_round', 'wait']);
});

// A run whose ENG-1 started, with a forge that also answers the stop's reads and records its writes.
function stopped(t, { merge = {}, checks = [passingRow(40)], force = false } = {}) {
  const fx = runFixture(t);
  const start = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(start.exitCode, 0, start.err.join('\n'));
  const writes = [];
  const state = { view: { number: 12, url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD, headRefName: 'feat/eng-1-export', baseRefName: 'main', isCrossRepository: false, reviewDecision: '', latestReviews: [], ...merge }, checks };
  const forge = {
    ...fx.forge,
    mergeState: (repo, ref) => (writes.push(['mergeState', repo, ref]), state.view),
    checks: (ref, options) => (writes.push(['checks', ref, options]), state.checks),
    rerunFailedChecks: (repo, runs, options) => (writes.push(['rerunFailedChecks', repo, runs, options]), runs),
    branchAllowsForce: (repo, branch, options) => (writes.push(['branchAllowsForce', repo, branch, options]), force),
    updateBranch: (repo, n, options) => (writes.push(['updateBranch', repo, n, options]), {}),
  };
  const drop = fx.rows().find((row) => row.event === 'start' && row.outcome === 'started').drop;
  const act = (autoMerge, session = CHILD) => fx.cmd(['stop-action', 'launch', 'ENG-1'], { session, forge, autoMerge: () => autoMerge });
  return { ...fx, state, writes, drop, act };
}
// A check row as the forge's checks gives it (forges/github.mjs checkRow).
const checkRow = (name, state, run, repo = 'acme/widgets') => ({ name, state, workflow: 'ci', event: 'pull_request', run, host: 'github.com', repo, workflowId: null });
const failingRow = (run, repo) => checkRow('e2e', 'FAILURE', run, repo);
function passingRow(run) {
  return checkRow('e2e', 'SUCCESS', run);
}

test('stop-action reruns the failed jobs of the head\'s failing workflow runs through the forge, records it, and parks the second time', (t) => {
  const fx = stopped(t, { checks: [failingRow(41), checkRow('lint', 'SUCCESS', 41)] });
  const first = fx.act(on());
  assert.equal(first.exitCode, 0, first.err.join('\n'));
  assert.match(first.out[0], /^rerun_checks ENG-1 #12 at aaaaaaa: its checks fail: e2e=FAILURE \(1 of 1 for this head\); the forge started the failed jobs of 1 workflow run again; then run the pr-auto-merge skill again$/u);
  assert.deepEqual(fx.writes.find((call) => call[0] === 'rerunFailedChecks'), ['rerunFailedChecks', 'acme/widgets', [41], { host: 'github.com' }]);
  assert.deepEqual(fx.writes.find((call) => call[0] === 'mergeState'), ['mergeState', 'github.com/acme/widgets', 'feat/eng-1-export'], 'found by the issue\'s branch in the pinned repository');
  const history = readFileSync(path.join(fx.drop, STOPS_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(history.map(({ action, head, pr, attempt, session }) => ({ action, head, pr, attempt, session })), [{ action: 'rerun_checks', head: HEAD, pr: 12, attempt: 1, session: CHILD }]);
  const second = fx.act(on());
  assert.match(second.out[0], /^park ENG-1 #12 at aaaaaaa: its checks fail: e2e=FAILURE, and rerun checks has reached its cap of 1 for this head; record the result pr_open with this line as its stop$/u);
  assert.equal(fx.writes.filter((call) => call[0] === 'rerunFailedChecks').length, 1, 'no second rerun');
});

test('a failing check whose run is in another repository is not run again: it parks', (t) => {
  const fx = stopped(t, { checks: [failingRow(41, 'evil/fork')] });
  assert.match(fx.act(on()).out[0], /^park ENG-1 #12 .*not every failing check is a workflow run of this repository/u);
  assert.equal(fx.writes.filter((call) => call[0] === 'rerunFailedChecks').length, 0);
});

test('a branch behind its base is merged up to date on the forge, rebased only under the rebase strategy where its rules allow force, and never past the cap', (t) => {
  const fx = stopped(t, { merge: { mergeStateStatus: 'BEHIND' } });
  const merged = fx.act(on());
  assert.match(merged.out[0], /^update_branch ENG-1 #12 at aaaaaaa: it is behind main; the new head voids every sign-off .* \(1 of 2 for this issue\); the forge merged main into it; then run the pr-auto-merge skill again$/u);
  assert.deepEqual(fx.writes.find((call) => call[0] === 'updateBranch'), ['updateBranch', 'acme/widgets', 12, { host: 'github.com', expectedHead: HEAD, method: 'merge' }]);
  assert.equal(fx.writes.filter((call) => call[0] === 'branchAllowsForce').length, 0, 'squash never asks for force');
  fx.act(on({ strategy: 'rebase' }));
  assert.deepEqual(fx.writes.filter((call) => call[0] === 'updateBranch').at(-1)[3].method, 'merge', 'the branch rules forbid force: the base is merged in');
  assert.match(fx.act(on()).out[0], /^park .*base update has reached its cap of 2 for this issue/u);
  assert.equal(fx.writes.filter((call) => call[0] === 'updateBranch').length, 2);
});

test('under the rebase strategy, with force allowed on the branch, the forge rebases it', (t) => {
  const fx = stopped(t, { merge: { mergeStateStatus: 'BEHIND' }, force: true });
  assert.match(fx.act(on({ strategy: 'rebase' })).out[0], /the forge rebased it onto main/u);
  assert.equal(fx.writes.find((call) => call[0] === 'updateBranch')[3].method, 'rebase');
});

test('only the run\'s driver or the issue\'s own session runs it, for the issue\'s own pull request, in the pinned repository', (t) => {
  const fx = stopped(t);
  assert.match(fx.act(on(), OTHER).err[0], /only the run's driver, or the newest session of the chain the run started for the issue ENG-1/u);
  assert.equal(fx.act(on(), DRIVER).exitCode, 0, 'the driver');
  assert.match(fx.act(on(), DRIVER).out[0], /^merge ENG-1 #12/u);
  fx.state.view = { ...fx.state.view, headRefName: 'feat/other' };
  assert.match(fx.act(on()).err[0], /pull request #12 is not from the issue's own branch feat\/eng-1-export/u);
  fx.state.view = { ...fx.state.view, headRefName: 'feat/eng-1-export', url: 'https://github.com/evil/widgets/pull/12' };
  assert.match(fx.act(on()).err[0], /pull request #12 is not in github\.com\/acme\/widgets/u);
  fx.state.view = { ...fx.state.view, url: 'https://github.com/acme/widgets/pull/12', isCrossRepository: true };
  assert.match(fx.act(on()).err[0], /is not from the issue's own branch/u);
});

test('a stop history that is a link, or holds a row the command did not write, parks', (t) => {
  const fx = stopped(t);
  writeFileSync(path.join(fx.root, 'elsewhere.jsonl'), '');
  symlinkSync(path.join(fx.root, 'elsewhere.jsonl'), path.join(fx.drop, STOPS_FILE));
  assert.match(fx.act(on()).out[0], /^park ENG-1 #12 at aaaaaaa: the stop history of attempt 1 .* is a symlink/u);
  const other = stopped(t);
  writeFileSync(path.join(other.drop, STOPS_FILE), `${JSON.stringify({ action: 'park', head: HEAD })}\n`);
  assert.match(other.act(on()).out[0], /^park .*holds a row this command did not write/u);
});

test('the hooks let the driver and the issue\'s own session run stop-action, and refuse any other session', (t) => {
  const fx = stopped(t);
  const ask = (session) => projectCommandDenial({ tool_name: 'Bash', tool_input: { command: 'aidrian project stop-action launch ENG-1' }, session_id: session, cwd: fx.dir }, fx.config, { unattended: () => false, home: fx.home });
  assert.equal(ask(CHILD), null);
  assert.equal(ask(DRIVER), null);
  assert.match(ask(OTHER)?.reason ?? '', /`aidrian project stop-action` acts on the pull request of an issue, for the run's driver or the issue's own session/u);
  assert.ok(projectCommandDenial({ tool_name: 'Bash', tool_input: { command: 'aidrian project stop-action launch ENG-1' }, session_id: CHILD, agent_id: 'a1', cwd: fx.dir }, fx.config, { home: fx.home }), 'a subagent');
});

// The GitHub adapter over a recording gh.
function recorded(answer) {
  const calls = [];
  const forge = createGithubForge({ cwd: '/repo', run: (args, options) => (calls.push({ args, input: options.input }), answer(args)) });
  return { forge, calls };
}

test('the GitHub adapter: the merge state view, the failed-job reruns, the force rule, the two updates, and the commit list', () => {
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

test('the closing-word check holds a session whose mark names a run\'s issue to that issue, an unreadable mark to none, and no other session', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-stops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state') };
  assert.equal(runIssueOf(CHILD, { env }), undefined, 'no mark');
  markUnattended(OTHER, { root, env });
  assert.equal(runIssueOf(OTHER, { env }), undefined, 'a mark with no run');
  markUnattended(CHILD, { root, env, tags: { project: 'launch', issue: 'ENG-1' } });
  assert.equal(runIssueOf(CHILD, { env }), 'ENG-1');
  writeFileSync(path.join(markFolder(env), `${CHILD}.json`), 'not json');
  assert.equal(runIssueOf(CHILD, { env }), null, 'a mark it cannot read names no issue, so every closing reference counts');
});
