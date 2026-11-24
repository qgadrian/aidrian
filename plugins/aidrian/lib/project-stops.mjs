// What a project run's issue does when its pull request did not merge: `aidrian project stop-action RUN ISSUE`
// (lib/project-run-cli.mjs), for the issue's own session only. classifyStop maps the stop to exactly one action with its
// cap; stopAction reads the stop, takes the action when the forge takes it, records it, and answers one line,
// `<action> <issue> #<n> at <head>: <why> (<used> of <cap> <scope>); <what to do next>`.
//
// The stop is read in this order, and the first that holds decides:
//   1. the pull request on the forge (mergeState), found by the issue's branch in the repository init pinned, from no
//      fork, into the default branch: merged is `done` when the result command records it merged (project-result.mjs
//      mergeProblem), and else parks on one decision for the Human, naming why; closed, or another base, parks.
//   2. `aidrian pr auto-merge --check --json` (runAutoMerge, in this process, as this session): a policy reason (POLICY_REASONS),
//      a `review` whose reason is changes requested, and a reason this file does not know park with the reason; `trust`
//      with `signoff` parks as a decision for the Human, who signs off from a session they attend, of class `security`
//      or `product` as auto-merge's `signoffClass` names it.
//   3. a draft parks: the ready step never marked it.
//   4. a conflict: `merge_base`, the session merges the base in, resolves it, and pushes with no force; behind its base:
//      `update_branch`, the forge brings it up to date (a rebase only under the rebase strategy, and only where the
//      branch's rules allow a push that is no fast-forward); BASE_UPDATES for both together, per issue. Either makes a
//      new head: every sign-off and review of the old one no longer counts, so a pull request whose flows need the
//      Human's sign-off parks after it. GitHub still computing it: `wait`.
//   5. `review` on a head a base update made: `review_round`, one review round of that head; any other `review` parks.
//   6. `trust` with `bot`: `request_bot` once per head; asked already, `wait`.
//   7. auto-merge on: failing checks, `rerun_checks` of their Actions runs' failed jobs, once per head, when every
//      failing check is a first run of the head on the issue's branch in the pinned repository, as the forge reads each
//      run; pending checks, `wait`; a merge the forge still blocks parks; else `merge`, once per head: a second `merge`
//      on the same head means the merge steps stopped for a reason this command does not read, and parks.
// A forge or auto-merge read that fails, or a forge action it refuses, is a `wait` under its own cap, RETRY_PAUSES, per
// attempt, each longer than the last, never a park until that cap is spent. Each capped action is recorded (lib/stop-history.mjs), and the caps
// count every attempt of the issue. A history it cannot read parks. Every forge call goes through the forge facade.
// With --catch-up, at the start of an attempt that takes up the issue's pull request, it reads step 1 and the conflict
// alone (catchUpStop): `merge_base` on a conflict, `none` when there is none, so the work goes on, under the same caps.

import path from 'node:path';

import { forgeFor } from './forges/index.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { changesRequested, defaultBranch, ghError, runAutoMerge } from './pr-auto-merge.mjs';
import { computeVerdict, currentRows } from './pr-checks.mjs';
import { CAPS, cleanText, mergeProblem } from './project-result.mjs';
import { issueBranch, readRun, runPlace, RUN_ID } from './project-run.mjs';
import { latestStart, runStore, startsOf, stopActorProblem } from './project-run-guard.mjs';
import { hostOf, repoName } from './remotes.mjs';
import { appendStops, issueStops, STOPS_FILE } from './stop-history.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

export { STOPS_FILE };
// The caps, in code: per head for each action but `base_update`, the `merge_base` and `update_branch` actions together,
// per issue, and `retry`, the waits on a failed read or action, per attempt.
export const STOP_CAPS = Object.freeze({ rerun_checks: 1, base_update: 2, wait: 3, retry: 3, review_round: 1, request_bot: 1, merge: 1 });
// The actions a line may name.
export const STOP_ACTIONS = Object.freeze(['done', 'merge', 'park', 'wait', 'rerun_checks', 'update_branch', 'merge_base', 'review_round', 'request_bot', 'none']);
const CAPPED = new Set(['wait', 'retry', 'rerun_checks', 'update_branch', 'merge_base', 'review_round', 'request_bot', 'merge']);
const BASE_UPDATES = new Set(['update_branch', 'merge_base']);
// The auto-merge reasons nothing a session does unattended can change: they wait for the Human.
export const POLICY_REASONS = Object.freeze(['team', 'local', 'checks', 'paths', 'author', 'outsider', 'closes']);
// Every auto-merge reason this file knows; any other parks.
const KNOWN_REASONS = new Set([...POLICY_REASONS, 'review', 'trust']);
// How long a wait on a read or an action that failed lasts, in seconds.
export const WAIT_PAUSE = 60;
// The longest one wait call may last, in seconds: a host moves a command still running at 180 s to the background, so a
// longer wait is taken in calls of at most this many seconds each.
export const WAIT_STEP = 150;
// How long each wait on a failed read or action lasts, in seconds, in turn: the `retry` cap, per attempt.
export const RETRY_PAUSES = Object.freeze([60, 300, 900]);
// The head a retry row records when the forge named none: retries count per attempt, never per head.
const UNKNOWN_HEAD = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/u;

const short = (sha) => (SHA.test(sha ?? '') && sha !== UNKNOWN_HEAD ? sha.slice(0, 7) : 'an unknown head');
const count = (history, test) => history.filter(test).length;

// A capped action of `action` on head `head`, or the park its spent cap gives: `spent` names that park's reason.
function capped(history, head, action, scope, why, { spent = null, ...extra } = {}) {
  const key = BASE_UPDATES.has(action) ? 'base_update' : action;
  const used = BASE_UPDATES.has(action) ? count(history, (row) => BASE_UPDATES.has(row.action)) : count(history, (row) => row.action === action && row.head === head);
  const cap = STOP_CAPS[key];
  if (used >= cap) return { action: 'park', why: spent ?? `${why}, and ${key.replace('_', ' ')} has reached its cap of ${cap} ${scope}` };
  return { action, why, cap, used: used + 1, scope, ...extra };
}

// A wait on a read or an action that failed, in attempt `attempt`: recorded as `retry`, and counted per attempt, apart
// from the waits on pending checks, so a forge outage neither spends their budget nor parks the issue for good.
export function transientWait(history, attempt, why) {
  const used = count(history, (row) => row.action === 'retry' && row.attempt === attempt);
  if (used >= STOP_CAPS.retry) return { action: 'park', why: `${why}, and it failed ${used} times in this attempt already` };
  return { action: 'wait', record: 'retry', why, cap: STOP_CAPS.retry, used: used + 1, scope: 'for this attempt', pause: RETRY_PAUSES[used] };
}

// The one action for a stop: { action, why, cap?, used?, scope?, runs?, pause?, parkAs? }. Pure. `view` is the pull
// request as readMergeState gives it, `autoMerge` { result, error }, the auto-merge JSON or why there is none, `checks` the
// verdict of its checks with `runs`, the workflow runs a rerun takes, or null when one failing check is no Actions run
// of the pinned repository (readChecks; read only when auto-merge is on), and `history` the recorded rows of the issue.
// `refused` is why the result command refuses a merged pull request as merged (project-result.mjs mergeProblem), or null.
export function classifyStop({ view, autoMerge, checks = null, history = [], attempt = null, refused = null }) {
  const park = (why, more = {}) => ({ action: 'park', why, ...more });
  const act = (action, scope, why, extra) => capped(history, view.head, action, scope, why, extra);
  if (view.state === 'MERGED' && refused) return park(`the forge shows it merged, and the result command cannot record it merged: ${refused}`, { parkAs: 'merge_refused' });
  if (view.state === 'MERGED') return { action: 'done', why: 'the forge shows it merged' };
  if (view.state !== 'OPEN') return park(`the forge shows it ${String(view.state).toLowerCase()}`);
  const result = autoMerge?.result;
  if (!result) return transientWait(history, attempt, `aidrian pr auto-merge could not answer now: ${autoMerge?.error ?? 'no reason'}`);
  if (result.head !== view.head) return act('wait', 'for this head', `the head moved from ${short(result.head)} to ${short(view.head)} while it was read`);
  if (!result.effective) {
    const { reason } = result;
    if (POLICY_REASONS.includes(reason)) return park(`auto-merge is off (${reason}): ${result.why}`);
    if (reason === 'review' && changesRequested(view)) return park(`auto-merge is off (review): ${changesRequested(view)}`);
    if (reason === 'trust' && result.trust === 'signoff') return park(`auto-merge is off (trust: signoff), and only the Human signs off, from a session they attend: ${result.why}`, { parkAs: 'signoff', decisionClass: result.signoffClass === 'security' ? 'security' : 'product' });
    if (!KNOWN_REASONS.has(reason)) return park(`auto-merge is off for a reason this command does not know (${String(reason)}): ${result.why}`);
  }
  if (view.draft) return park('it is still a draft, which the ready step never marked ready');
  if (conflicts(view)) return act('merge_base', 'for this issue', `it conflicts with ${view.base}; ${NEW_HEAD}`);
  if (view.status === 'BEHIND') return act('update_branch', 'for this issue', `it is behind ${view.base}; ${NEW_HEAD}`);
  if (view.mergeable === 'UNKNOWN' || view.status === 'UNKNOWN') return act('wait', 'for this head', 'the forge has not worked out yet whether it merges');
  if (!result.effective) {
    if (result.reason === 'review') {
      const update = history.filter((row) => BASE_UPDATES.has(row.action)).at(-1);
      if (update && update.head !== view.head) return act('review_round', 'for this head', `a base update made this head, which no review has seen: ${result.why}`);
      return park(`auto-merge is off (review): ${result.why}`);
    }
    if (history.some((row) => row.action === 'request_bot' && row.head === view.head)) return act('wait', 'for this head', `the review bot was asked for this head and has not passed it yet: ${result.why}`, { awaitBot: true });
    return act('request_bot', 'for this head', `auto-merge is off (trust: bot): ${result.why}`);
  }
  if (checks?.verdict === 'failing') {
    if (!checks.runs?.length) return park(`its checks fail, and not every failing check is an Actions run of this repository to run again: ${checks.reason}`);
    return act('rerun_checks', 'for this head', `its checks fail: ${checks.reason}`, { runs: checks.runs });
  }
  if (checks?.verdict === 'pending') return act('wait', 'for this head', `its checks are pending: ${checks.reason}`);
  if (checks?.verdict !== 'ready') return park('its checks could not be read');
  if (view.status === 'BLOCKED') return park('auto-merge is on and its checks pass, and the forge still blocks the merge: its branch rules ask for more, such as an approving review');
  const merge = act('merge', 'for this head', 'nothing stops the merge now', { spent: 'auto-merge is on and nothing this command reads stops the merge, yet the merge steps stopped on this head before: they stopped for a reason this command does not read, and their stop line is the stop' });
  return merge.action === 'park' ? { ...merge, parkAs: 'merge_steps' } : merge;
}

const NEW_HEAD = 'the new head voids every sign-off and review of this one, so a pull request whose flows need the Human\'s sign-off parks after it';
// Whether the pull request `view` conflicts with its base.
const conflicts = (view) => view.mergeable === 'CONFLICTING' || view.status === 'DIRTY';

// The one action at the start of an attempt that takes up the open pull request `view`, whose base is the default
// branch: `merge_base` on a conflict and `wait` while the forge works it out, each under its cap in `history`, else
// `none`. Pure.
export function catchUpStop({ view, history = [] }) {
  const act = (action, scope, why) => capped(history, view.head, action, scope, why);
  if (conflicts(view)) return act('merge_base', 'for this issue', `it conflicts with ${view.base}; ${NEW_HEAD}`);
  if (view.mergeable === 'UNKNOWN' || view.status === 'UNKNOWN') return act('wait', 'for this head', 'the forge has not worked out yet whether it merges');
  return { action: 'none', why: `it does not conflict with ${view.base}` };
}

// How the session waits `seconds`: in one call, or, past WAIT_STEP, in foreground calls of at most WAIT_STEP seconds each,
// since a host moves a longer call to the background.
function waitWords(seconds) {
  if (seconds <= WAIT_STEP) return `wait ${seconds} seconds`;
  return `wait ${seconds} seconds in all, in ${Math.ceil(seconds / WAIT_STEP)} foreground waits of at most ${WAIT_STEP} seconds each, never one longer call, which the host moves to the background`;
}

// What the session does after each action, once stopAction took the forge's part. Under --catch-up (`catchUp`), the
// work goes on after a merge of the base, and a wait asks the same command again.
function nextStep(decision, { view, branch, method, catchUp = false }) {
  const again = catchUp ? 'then run this command again' : 'then run the pr-auto-merge skill again';
  switch (decision.action) {
    case 'done': return 'record the result merged with `aidrian project result`';
    case 'merge': return 'run the pr-auto-merge skill again';
    case 'park':
      if (decision.parkAs === 'signoff') return `record the result parked with one decision of class ${decision.decisionClass ?? 'product'}: the Human's sign-off of the flows of #${view.number} at head ${short(view.head)}, options "leave the pull request unmerged" and "sign off from an attended session", recommended the first`;
      if (decision.parkAs === 'merge_refused') return `record the result parked with one decision of class other: whether the merge of #${view.number} counts as the issue's work, options "leave the issue parked" and "count the issue done by hand once its work is on the default branch", recommended the first`;
      if (decision.parkAs === 'merge_steps') return 'record the result pr_open with the merge steps\' own stop line as its stop';
      return 'record the result pr_open with this line as its stop';
    case 'wait': return decision.awaitBot
      ? `run \`aidrian pr await-review ${view.number}\`, which waits for the bot it asked, ${again}`
      : `${waitWords(decision.pause ?? WAIT_PAUSE)}, ${again}`;
    case 'rerun_checks': return `the forge started the failed jobs of ${decision.runs.length} workflow run${decision.runs.length === 1 ? '' : 's'} again; ${again}`;
    case 'update_branch': return `the forge ${method === 'rebase' ? `rebased it onto ${view.base}` : `merged ${view.base} into it`}; ${again}`;
    case 'merge_base': return `${mergeBaseRoute(view.base, branch)}; ${catchUp ? 'then go on with the work, the checks and the review on the new head' : again}`;
    case 'none': return 'go on with the work';
    case 'review_round': return 'run one review round on this head, with § 4\'s waiver at the round cap; when it signs off with nothing to push, run the pr-auto-merge skill again, else record the result pr_open';
    case 'request_bot': return `run \`aidrian pr await-review ${view.number} --request\`, ${again}`;
    default: return 'record the result pr_open with this line as its stop';
  }
}

// The one way an issue's session merges the base `base` into its branch `branch`, on which its clone already is, its
// own commits kept, once HEAD holds the branch as the forge has it: a conflict inside a host file stops before any merge, which would write the branch's lines over the
// base copy, and the push guard lets the host files through only as git merged them (issue-push-checkout.mjs).
const mergeBaseRoute = (base, branch) => `run \`git fetch origin ${base} ${branch}\`, and when it fails, run it again in this turn, up to three times in all; when it still fails, merge nothing and record the result pr_open with a stop that names the failed fetch, never asking this command again for it; \`git merge-base --is-ancestor origin/${branch} HEAD\`: when it fails, `
  + `HEAD does not hold the branch as the forge has it, so merge nothing and record the result pr_open with a stop that says ${branch} diverged from origin/${branch}; `
  + `then \`git merge-tree --write-tree --name-only HEAD origin/${base}\` lists the files that would conflict: when one is a host config or instruction file, `
  + 'record the result pr_open with that file\'s path in its stop, and merge nothing; '
  + `else run \`git merge --no-ff --no-edit origin/${base}\`, a merge commit, never a rebase, resolve the conflicts without editing a host config or instruction file by hand (a merge git refuses over one is recorded the same way), `
  + `run the tests, commit, and push with \`git push origin HEAD:refs/heads/${branch}\` in a call of its own, never with force`;

// The line of a decision. `why` is cleaned and capped as a result's `stop` is (project-result.mjs cleanText).
export function stopLine(decision, { view, key, branch, method = 'merge', catchUp = false }) {
  const tally = decision.cap ? ` (${decision.used} of ${decision.cap} ${decision.scope})` : '';
  const number = Number.isInteger(view?.number) ? ` #${view.number}` : '';
  return `${decision.action} ${key}${number} at ${short(view?.head)}: ${cleanText(decision.why, CAPS.stop)}${tally}; ${nextStep(decision, { view: view ?? {}, branch, method, catchUp })}`;
}

// A forge error as a line quotes it.
const quoted = (error) => JSON.stringify(ghError(error));

// The pull request of the issue's branch `branch` in the pinned repository `repository` ({ host, owner, name }), as the
// forge's mergeState gives it: { number, url, state, draft, mergeable, status, head, base, reviewDecision,
// latestReviews }, { problem } when it is not the issue's own, or { error } when the forge could not answer.
export function readMergeState(forge, repository, branch) {
  const named = `${repository.owner}/${repository.name}`;
  let view;
  try {
    view = forge.mergeState(`${repository.host}/${named}`, branch);
  } catch (error) {
    return { error: `the forge could not describe the pull request of ${branch} (${quoted(error)})` };
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
// `github`), plus `runs`: the Actions workflow runs of the failing checks, each once, or null when a failing check is no
// Actions run (no workflow, such as an app's status) of the pinned repository `repository`, or a skip fails it. A read
// that lists nothing is pending; one that fails is { error }, a wait on the retry cap, never the pending checks' cap.
export function readChecks(forge, repository, view, lists) {
  let rows;
  try {
    rows = forge.checks(String(view.number), { repo: `${repository.host}/${repository.owner}/${repository.name}` });
  } catch (error) {
    return { error: `the forge could not list the checks of #${view.number} now (${quoted(error)})` };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { verdict: 'pending', reason: 'the forge lists no check yet', runs: null };
  const verdict = computeVerdict(rows, lists, { draft: view.draft });
  if (verdict.verdict !== 'failing') return { ...verdict, runs: null };
  const named = `${repository.owner}/${repository.name}`.toLowerCase();
  const failing = currentRows(rows).filter((row) => verdict.failing.some((entry) => entry.startsWith(`${row.name}=`)));
  const ours = (row) => typeof row.workflow === 'string' && row.workflow !== '' && Number.isSafeInteger(row.run) && row.run > 0
    && row.repo?.toLowerCase() === named && row.host?.toLowerCase() === repository.host.toLowerCase();
  const runs = verdict.unexpected_skips.length || !failing.length || !failing.every(ours) ? null : [...new Set(failing.map((row) => row.run))];
  return { ...verdict, runs };
}

// Why the workflow runs `runs` may not be run again for the pull request `view` from `branch` in the pinned repository,
// as the forge reads each: { problem }, { error } when it could not, or null. Each must be a first run (`run_attempt`
// 1) of exactly the head, on that branch, in that repository, so the forge itself holds the rerun to once a head.
function rerunProblem(forge, repository, view, branch, runs) {
  const named = `${repository.owner}/${repository.name}`;
  for (const id of runs) {
    let run;
    try {
      run = forge.workflowRun(named, id, { host: repository.host });
    } catch (error) {
      return { error: `the forge could not describe workflow run ${id} (${quoted(error)})` };
    }
    if (run?.head_sha !== view.head || run?.head_branch !== branch || String(run?.head_repository?.full_name ?? '').toLowerCase() !== named.toLowerCase()) {
      return { problem: `workflow run ${id} is not a run of head ${short(view.head)} on ${branch} in ${named}, so it is not run again` };
    }
    if (run.run_attempt !== 1) return { problem: `workflow run ${id} ran ${Number.isInteger(run.run_attempt) ? run.run_attempt : 'an unknown number of'} times on head ${short(view.head)} already, and a head's checks run again once` };
  }
  return null;
}

// `aidrian pr auto-merge --check --json` on `url`, in this process, as the session `session`: { result } or { error }.
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

// Runs `aidrian project stop-action RUN KEY` for the session `env` names: { exitCode, out, err }. Only the issue's own
// session (project-run-guard.mjs stopActorProblem). `forge` and `autoMerge(url)` are test seams, the forge facade and
// the auto-merge answer; `config` is this checkout's, whose `github` check lists judge the checks. `catchUp` reads only
// the pull request's own stop and its conflict (catchUpStop), after the same base check.
export function stopAction({ project, config, run, key, env = process.env, home, now = Date.now(), forge = forgeFor(project.root), autoMerge, catchUp = false }) {
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
  const branch = issueBranch(found, key);
  const { repository } = found.init;
  const named = `${repository.owner}/${repository.name}`;
  const history = issueStops({ state: place.state, run, key, starts: startsOf(found, key) });
  // Every line goes out here. A park of a pull request the forge showed merged is always the merge_refused one, `parked`
  // on the one decision, whatever parked it: the result command may refuse pr_open, as merged, on a merged pull request.
  const answer = (given, view, method) => {
    const decision = given.action === 'park' && view?.state === 'MERGED' ? { ...given, parkAs: 'merge_refused' } : given;
    if (decision.action !== 'park' && CAPPED.has(decision.action)) {
      const kept = appendStops(path.join(start.drop, STOPS_FILE), [{ action: decision.record ?? decision.action, head: view?.head ?? UNKNOWN_HEAD, pr: view?.number ?? null, attempt: start.attempt, session, at: new Date(now).toISOString() }]);
      if (kept) return answer({ action: 'park', why: `the stop history cannot be kept: ${kept}` }, view);
    }
    return { exitCode: 0, out: [stopLine(decision, { view, key, branch, method, catchUp })], err: [] };
  };
  if (history.problem) return { exitCode: 0, out: [stopLine({ action: 'park', why: history.problem }, { view: null, key, branch })], err: [] };
  const rows = history.rows;
  const view = readMergeState(forge, repository, branch);
  if (view.problem) return refuse(view.problem);
  if (view.error) return answer(transientWait(rows, start.attempt, view.error), null);
  const retry = (why) => answer(transientWait(rows, start.attempt, why), view);
  let main;
  try {
    main = defaultBranch(forge, { repo: named, host: repository.host });
  } catch (error) {
    return retry(error.message);
  }
  if (view.state === 'OPEN' && view.base !== main) return answer({ action: 'park', why: `it targets ${view.base}, not the default branch ${main}, which a project run's issue merges into` }, view);
  // A merged or closed pull request gets the answer the command gives without --catch-up.
  if (catchUp && view.state === 'OPEN') return answer(catchUpStop({ view, history: rows }), view);
  // A merged pull request is `done` only when the result command records it merged: its own check, against this start.
  const landed = view.state === 'MERGED' ? mergeProblem({ forge, repository, pr: view.number, branch, since: Date.parse(start.at) }) : null;
  if (landed?.retry) return retry(`the forge shows it merged, and the merge check could not be read: ${landed.why}`);
  const merged = view.state === 'OPEN' ? (autoMerge ?? ((url) => autoMergeOf(project, url, { forge, session, home })))(view.url) : null;
  const checks = merged?.result?.effective === true && merged.result.head === view.head ? readChecks(forge, repository, view, config.github) : null;
  if (checks?.error) return answer(transientWait(rows, start.attempt, checks.error), view);
  const decision = classifyStop({ view, autoMerge: merged, checks, history: rows, attempt: start.attempt, refused: landed });
  if (decision.action === 'rerun_checks') {
    const refused = rerunProblem(forge, repository, view, branch, decision.runs);
    if (refused?.error) return answer(transientWait(rows, start.attempt, refused.error), view);
    if (refused) return answer({ action: 'park', why: refused.problem }, view);
    try {
      forge.rerunFailedChecks(named, decision.runs, { host: repository.host });
    } catch (error) {
      return answer(transientWait(rows, start.attempt, `the forge could not start the failed jobs again (${quoted(error)})`), view);
    }
  }
  let method = 'merge';
  if (decision.action === 'update_branch') {
    try {
      if (merged.result.strategy === 'rebase' && forge.branchAllowsForce(named, branch, { host: repository.host }) === true) method = 'rebase';
    } catch {
      method = 'merge';
    }
    try {
      forge.updateBranch(named, view.number, { host: repository.host, expectedHead: view.head, method });
    } catch (error) {
      return answer(transientWait(rows, start.attempt, `the forge could not bring #${view.number} up to date with ${view.base} (${quoted(error)})`), view);
    }
  }
  return answer(decision, view, method);
}
