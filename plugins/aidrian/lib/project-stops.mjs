// What a project run's issue does when its pull request did not merge: `aidrian project stop-action RUN ISSUE`
// (lib/project-run-cli.mjs). classifyStop maps the stop to exactly one action with its cap; stopAction reads the stop,
// takes the action when the forge takes it, records it, and answers one line, `<action> <issue> #<n> at <head>: ...`.
//
// The stop is read in this order, and the first that holds decides:
//   1. the pull request on the forge (mergeState), found by the issue's branch in the repository init pinned: merged is
//      `done`; closed parks.
//   2. `aidrian pr auto-merge --json` (runAutoMerge, in this process, as this session): an error, a policy reason
//      (POLICY_REASONS), a `review` whose reason is changes requested, and a reason this file does not know park with
//      the reason; `trust` with `signoff` parks for the Human, who signs off from a session they attend.
//   3. a draft parks: the ready step never marked it.
//   4. a conflict: `merge_base`, the session merges the base in, resolves it, and pushes with no force; behind its base:
//      `update_branch`, the forge brings it up to date (a rebase only under the rebase strategy, and only where the
//      branch's rules allow a push that is no fast-forward); BASE_UPDATES for both together, per issue. Either makes a
//      new head: every sign-off and review of the old one no longer counts, so a pull request whose flows need the
//      Human's sign-off parks after it. GitHub still computing it: `wait`.
//   5. `review` on a head a base update made: `review_round`, one review round of that head; any other `review` parks.
//   6. `trust` with `bot`: `request_bot` once per head, then it parks.
//   7. auto-merge on: failing checks, `rerun_checks` of their workflow runs' failed jobs, once per head, when every
//      failing check is a workflow run of the pinned repository; pending checks, `wait`; a merge the forge still blocks
//      parks; else `merge`, run the pr-auto-merge skill again.
// Each capped action is recorded in `stops.jsonl` in the drop folder of the issue's latest start, and the caps count
// the rows of every attempt's drop folder of the issue, so a later attempt does not reset them. A history it cannot
// read parks. Every forge call goes through the forge facade (lib/forges).

import { closeSync, constants, openSync, writeSync } from 'node:fs';
import path from 'node:path';

import { forgeFor } from './forges/index.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { changesRequested, ghError, runAutoMerge } from './pr-auto-merge.mjs';
import { computeVerdict, currentRows } from './pr-checks.mjs';
import { plainFolderProblem } from './project-result.mjs';
import { readCapped, readRun, runPlace, RUN_ID } from './project-run.mjs';
import { latestStart, runStore, startsOf, stopActorProblem } from './project-run-guard.mjs';
import { hostOf, repoName } from './remotes.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

// The caps, in code: `rerun_checks`, `wait`, `review_round`, and `request_bot` per head, and `base_update`, the
// `merge_base` and `update_branch` actions together, per issue.
export const STOP_CAPS = Object.freeze({ rerun_checks: 1, base_update: 2, wait: 3, review_round: 1, request_bot: 1 });
// The actions a line may name, and those whose taking is recorded against a cap.
export const STOP_ACTIONS = Object.freeze(['done', 'merge', 'park', 'wait', 'rerun_checks', 'update_branch', 'merge_base', 'review_round', 'request_bot']);
const CAPPED = new Set(['wait', 'rerun_checks', 'update_branch', 'merge_base', 'review_round', 'request_bot']);
const BASE_UPDATES = new Set(['update_branch', 'merge_base']);
// The auto-merge reasons nothing a session does unattended can change: they wait for the Human.
export const POLICY_REASONS = Object.freeze(['team', 'local', 'checks', 'paths', 'author', 'outsider', 'closes']);
// Every auto-merge reason this file knows; any other parks.
const KNOWN_REASONS = new Set([...POLICY_REASONS, 'review', 'trust']);
// The file the history is kept in, in a drop folder, and the most bytes read of it.
export const STOPS_FILE = 'stops.jsonl';
const STOPS_CAP = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/u;

const short = (sha) => String(sha ?? 'none').slice(0, 7);
const count = (history, test) => history.filter(test).length;

// The one action for a stop: { action, why, cap?, used?, scope?, runs? }. Pure. `view` is the pull request as
// readMergeState gives it, `autoMerge` { result, error }, the auto-merge JSON or why there is none, `checks` the
// verdict of its checks with `runs`, the workflow runs a rerun takes, or null when one failing check is no such run
// (readChecks; read only when auto-merge is on), and `history` the recorded rows of the issue ([{ action, head }]).
export function classifyStop({ view, autoMerge, checks = null, history = [] }) {
  const park = (why) => ({ action: 'park', why });
  const capped = (action, scope, why, extra = {}) => {
    const key = BASE_UPDATES.has(action) ? 'base_update' : action;
    const used = BASE_UPDATES.has(action) ? count(history, (row) => BASE_UPDATES.has(row.action)) : count(history, (row) => row.action === action && row.head === view.head);
    const cap = STOP_CAPS[key];
    if (used >= cap) return park(`${why}, and ${key.replace('_', ' ')} has reached its cap of ${cap} ${scope}`);
    return { action, why, cap, used: used + 1, scope, ...extra };
  };
  if (view.state === 'MERGED') return { action: 'done', why: 'the forge shows it merged' };
  if (view.state !== 'OPEN') return park(`the forge shows it ${String(view.state).toLowerCase()}`);
  const result = autoMerge?.result;
  if (!result) return park(`aidrian pr auto-merge gave no answer: ${autoMerge?.error ?? 'no reason'}`);
  if (result.head !== view.head) return capped('wait', 'for this head', `the head moved from ${short(result.head)} to ${short(view.head)} while it was read`);
  if (!result.effective) {
    const { reason } = result;
    if (POLICY_REASONS.includes(reason)) return park(`auto-merge is off (${reason}): ${result.why}`);
    if (reason === 'review' && changesRequested(view)) return park(`auto-merge is off (review): ${changesRequested(view)}`);
    if (reason === 'trust' && result.trust === 'signoff') return park(`auto-merge is off (trust: signoff), and only the Human signs off, from a session they attend: ${result.why}`);
    if (!KNOWN_REASONS.has(reason)) return park(`auto-merge is off for a reason this command does not know (${String(reason)}): ${result.why}`);
  }
  if (view.draft) return park('it is still a draft, which the ready step never marked ready');
  const newHead = 'the new head voids every sign-off and review of this one, so a pull request whose flows need the Human\'s sign-off parks after it';
  if (view.mergeable === 'CONFLICTING' || view.status === 'DIRTY') return capped('merge_base', 'for this issue', `it conflicts with ${view.base}; ${newHead}`);
  if (view.status === 'BEHIND') return capped('update_branch', 'for this issue', `it is behind ${view.base}; ${newHead}`);
  if (view.mergeable === 'UNKNOWN' || view.status === 'UNKNOWN') return capped('wait', 'for this head', 'the forge has not worked out yet whether it merges');
  if (!result.effective) {
    if (result.reason === 'review') {
      const update = history.filter((row) => BASE_UPDATES.has(row.action)).at(-1);
      if (update && update.head !== view.head) return capped('review_round', 'for this head', `a base update made this head, which no review has seen: ${result.why}`);
      return park(`auto-merge is off (review): ${result.why}`);
    }
    return capped('request_bot', 'for this head', `auto-merge is off (trust: bot): ${result.why}`);
  }
  if (checks?.verdict === 'failing') {
    if (!checks.runs?.length) return park(`its checks fail, and not every failing check is a workflow run of this repository to run again: ${checks.reason}`);
    return capped('rerun_checks', 'for this head', `its checks fail: ${checks.reason}`, { runs: checks.runs });
  }
  if (checks?.verdict === 'pending') return capped('wait', 'for this head', `its checks are pending: ${checks.reason}`);
  if (checks?.verdict !== 'ready') return park('its checks could not be read');
  if (view.status === 'BLOCKED') return park('auto-merge is on and its checks pass, and the forge still blocks the merge: its branch rules ask for more, such as an approving review');
  return { action: 'merge', why: 'nothing stops the merge now' };
}

// What the session does after each action, once stopAction took the forge's part.
function nextStep(decision, { view, key, branch, method }) {
  const again = 'then run the pr-auto-merge skill again';
  switch (decision.action) {
    case 'done': return `record the result merged with \`aidrian project result\``;
    case 'merge': return `run the pr-auto-merge skill again`;
    case 'park': return `record the result pr_open with this line as its stop`;
    case 'wait': return `wait for it, ${again}`;
    case 'rerun_checks': return `the forge started the failed jobs of ${decision.runs.length} workflow run${decision.runs.length === 1 ? '' : 's'} again; ${again}`;
    case 'update_branch': return `the forge ${method === 'rebase' ? `rebased it onto ${view.base}` : `merged ${view.base} into it`}; ${again}`;
    case 'merge_base': return `merge origin/${view.base} into ${branch}, resolve the conflicts, run the tests, commit, and push with \`git push origin HEAD:refs/heads/${branch}\`, never with force; ${again}`;
    case 'review_round': return `run one review round on this head; when it signs off with nothing to push, run the pr-auto-merge skill again, else record the result pr_open`;
    case 'request_bot': return `run \`aidrian pr await-review ${view.number} --request\`, ${again}`;
    default: return `record the result pr_open (${key})`;
  }
}

// The line of a decision.
export function stopLine(decision, { view, key, branch, method = 'merge' }) {
  const tally = decision.cap ? ` (${decision.used} of ${decision.cap} ${decision.scope})` : '';
  return `${decision.action} ${key} #${view.number} at ${short(view.head)}: ${decision.why}${tally}; ${nextStep(decision, { view, key, branch, method })}`;
}

// The pull request of the issue's branch `branch` in the pinned repository `repository` ({ host, owner, name }), as the
// forge's mergeState gives it: { number, url, state, draft, mergeable, status, head, base, reviewDecision,
// latestReviews }, or { problem }. It must be in that repository, from that branch, and from no fork.
export function readMergeState(forge, repository, branch) {
  const named = `${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.mergeState(`${repository.host}/${named}`, branch);
  } catch (error) {
    return { problem: `the forge names no pull request of the branch ${branch} it can describe (${ghError(error)})` };
  }
  if (!Number.isInteger(view?.number) || typeof view.url !== 'string' || typeof view.state !== 'string' || !SHA.test(view.headRefOid ?? '') || typeof view.baseRefName !== 'string') {
    return { problem: `the forge described the pull request of ${branch} with no number, link, state, head, or base` };
  }
  if (repoName(view.url) !== named.toLowerCase() || hostOf(view.url)?.toLowerCase() !== repository.host.toLowerCase()) return { problem: `pull request #${view.number} is not in ${repository.host}/${named}` };
  if (view.headRefName !== branch || view.isCrossRepository !== false) return { problem: `pull request #${view.number} is not from the issue's own branch ${branch}` };
  return {
    number: view.number, url: view.url, state: view.state, draft: view.isDraft !== false, mergeable: view.mergeable, status: view.mergeStateStatus,
    head: view.headRefOid, base: view.baseRefName,
    reviewDecision: typeof view.reviewDecision === 'string' ? view.reviewDecision : '', latestReviews: Array.isArray(view.latestReviews) ? view.latestReviews : [],
  };
}

// The checks of the pull request `view` as `aidrian pr checks` judges them, by this checkout's lists (`lists`, config.json
// `github`), plus `runs`: the workflow runs of the failing checks, each once, or null when a failing check is no
// workflow run of the pinned repository `repository`, or a skip fails it. A read that fails, or lists nothing, is pending.
export function readChecks(forge, repository, view, lists) {
  let rows;
  try {
    rows = forge.checks(String(view.number), { repo: `${repository.host}/${repository.owner}/${repository.name}` });
  } catch (error) {
    return { verdict: 'pending', reason: `the forge could not list its checks now (${ghError(error)})`, runs: null };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { verdict: 'pending', reason: 'the forge lists no check yet', runs: null };
  const verdict = computeVerdict(rows, lists, { draft: view.draft });
  if (verdict.verdict !== 'failing') return { ...verdict, runs: null };
  const named = `${repository.owner}/${repository.name}`.toLowerCase();
  const failing = currentRows(rows).filter((row) => verdict.failing.some((entry) => entry.startsWith(`${row.name}=`)));
  const ours = (row) => Number.isSafeInteger(row.run) && row.run > 0 && row.repo?.toLowerCase() === named && row.host?.toLowerCase() === repository.host.toLowerCase();
  const runs = verdict.unexpected_skips.length || !failing.length || !failing.every(ours) ? null : [...new Set(failing.map((row) => row.run))];
  return { ...verdict, runs };
}

// The recorded actions of issue `key` of the run `found`, from the drop folder of each of its attempts, in order:
// { rows } or { problem }.
export function readHistory(found, key) {
  const rows = [];
  for (const start of startsOf(found, key)) {
    if (typeof start.drop !== 'string') continue;
    const read = readCapped(path.join(start.drop, STOPS_FILE), STOPS_CAP);
    if (read.code === 'ENOENT') continue;
    if (read.problem) return { problem: `the stop history of attempt ${start.attempt} ${read.problem}` };
    for (const line of read.bytes.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return { problem: `the stop history of attempt ${start.attempt} holds a line that is not JSON` };
      }
      if (!CAPPED.has(row?.action) || !SHA.test(row.head ?? '')) return { problem: `the stop history of attempt ${start.attempt} holds a row this command did not write` };
      rows.push(row);
    }
  }
  return { rows };
}

// Appends `row` to the history in the drop folder `drop`: null, or why it could not. The folder must be a plain one of
// this user, and the file is opened without following a link.
function recordStop(drop, row) {
  const folder = plainFolderProblem(drop);
  if (folder) return folder;
  let fd;
  try {
    fd = openSync(path.join(drop, STOPS_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeSync(fd, `${JSON.stringify(row)}\n`);
    return null;
  } catch (error) {
    return `the stop history in ${drop} cannot be written (${error.code ?? 'no code'})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// `aidrian pr auto-merge --json` on `url`, in this process, as the session `session`: { result } or { error }.
function autoMergeOf(project, url, { forge, session, home }) {
  const out = [];
  const err = [];
  const sink = { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) };
  const code = runAutoMerge([url, '--json'], project, { forge, session, ...(home ? { home } : {}), out: sink });
  if (code === 3 || out.length !== 1) return { error: err.join(' ').slice(0, 300) || `it exited ${code}` };
  try {
    return { result: JSON.parse(out[0]) };
  } catch {
    return { error: 'its answer is not JSON' };
  }
}

// Runs `aidrian project stop-action RUN KEY` for the session `env` names: { exitCode, out, err }. Only the run's driver
// or the issue's own session (project-run-guard.mjs stopActorProblem). `forge` and `autoMerge(url)` are test seams,
// the forge facade and the auto-merge answer; `config` is this checkout's, whose `github` check lists judge the checks.
export function stopAction({ project, config, run, key, env = process.env, home, now = Date.now(), forge = forgeFor(project.root), autoMerge }) {
  const refuse = (why) => ({ exitCode: 1, out: [], err: [`aidrian project stop-action: ${why}`] });
  if (typeof run !== 'string' || !RUN_ID.test(run)) return refuse(`the run id ${JSON.stringify(run)} is not a run id`);
  const { session } = sessionIdentity(env);
  const place = runPlace(project, config, { env, home });
  if (place.problem) return refuse(place.problem);
  const found = readRun(place.state, run);
  if (found.problem) return refuse(found.problem);
  let mark;
  try {
    mark = readUnattendedMark(session, { env, ...(home ? { home } : {}) });
  } catch {
    mark = { root: null };
  }
  const actor = stopActorProblem({ found, store: runStore(project, config, place.state), key, session, mark, now });
  if (actor) return refuse(actor);
  const start = latestStart(found, key);
  if (typeof start?.drop !== 'string') return refuse(`no start of ${key} names a drop folder to keep its stop history in`);
  const { branch } = found.snapshot.issues.find((issue) => issue.key === key);
  const { repository } = found.init;
  const view = readMergeState(forge, repository, branch);
  if (view.problem) return refuse(view.problem);
  const history = readHistory(found, key);
  const context = { view, key, branch };
  if (history.problem) return { exitCode: 0, out: [stopLine({ action: 'park', why: history.problem }, context)], err: [] };
  const answer = view.state === 'OPEN' ? (autoMerge ?? ((url) => autoMergeOf(project, url, { forge, session, home })))(view.url) : null;
  const checks = answer?.result?.effective === true && answer.result.head === view.head ? readChecks(forge, repository, view, config.github) : null;
  const decision = classifyStop({ view, autoMerge: answer, checks, history: history.rows });
  const named = `${repository.owner}/${repository.name}`;
  let method = 'merge';
  const failed = (what, error) => ({ exitCode: 0, out: [stopLine({ action: 'park', why: `the forge could not ${what} (${ghError(error)})` }, context)], err: [] });
  if (decision.action === 'rerun_checks') {
    try {
      forge.rerunFailedChecks(named, decision.runs, { host: repository.host });
    } catch (error) {
      return failed('start the failed jobs again', error);
    }
  }
  if (decision.action === 'update_branch') {
    try {
      if (answer.result.strategy === 'rebase' && forge.branchAllowsForce(named, branch, { host: repository.host }) === true) method = 'rebase';
    } catch {
      method = 'merge';
    }
    try {
      forge.updateBranch(named, view.number, { host: repository.host, expectedHead: view.head, method });
    } catch (error) {
      return failed(`bring #${view.number} up to date with ${view.base}`, error);
    }
  }
  if (CAPPED.has(decision.action)) {
    const kept = recordStop(start.drop, { action: decision.action, head: view.head, pr: view.number, attempt: start.attempt, session, at: new Date(now).toISOString() });
    if (kept) return { exitCode: 0, out: [stopLine({ action: 'park', why: kept }, context)], err: [] };
  }
  return { exitCode: 0, out: [stopLine(decision, { ...context, method })], err: [] };
}
