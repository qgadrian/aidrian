// `aidrian pr review [PR]`: run a pull request's review plan one step at a time. Every call plans the review for the
// pull request's head, reads what has happened so far, does the next thing it can do itself (run an exec reviewer, ask
// the review bot), and returns the next action. Calling it again is always safe. The review skill is a loop around it:
//
//   running         a split review ran some of its slices: call again for the rest
//   dispatch        run the listed agent passes, then record each with `aidrian pr attest <PR> --pass <id> ...`
//   fix_required    fix or disposition the listed findings and unsigned invariants, push, call again
//   human_required  a flow needs the Human's sign-off: `aidrian pr signoff <PR> --flow <id>`
//   received        every stage passed on this head; none_needed: the plan has nothing to review
//   unsatisfied     the plan requires a reviewer this machine cannot run; nothing ran
//   incomplete      a reviewer failed on this head and may be retried; stuck: it failed 3 times, the Human decides
//   too_large       the change is past what one review covers; the Human decides how to split it
//   checks_pending  a flow's required checks have not all finished on this head: call again later
//   timed_out, round_limit   as `aidrian pr await-review`
//   blocked_quota   a reviewer is out of quota: ask the Human `question`; the option picked runs its `run`, such as
//                   `--quota-fallback agent:critic` (lib/review/quota.mjs), or nothing
//   extension_check  at the round cap: run the listed judge, then record its verdict with `aidrian pr extend`
//   extension_ask    the judge says one more round; ask the Human, then `aidrian pr extend <PR> --human approve|deny`
//
// docs/review.md describes the plan, the stages, and the record.
//
// This file is the public entry and the step's outcome: what every result holds, records, and publishes. A step plans
// in lib/review/step.mjs and runs its stages in lib/review/stages.mjs, both on one step context `s`, which carries the
// outcome writers below. The record commands live in lib/review/record.mjs; this file re-exports them.

import { forgeFor } from '../forges/index.mjs';
import { sessionIdentity } from '../hosts/index.mjs';
import { isAncestor } from './diff.mjs';
import { blocks } from './findings.mjs';
import { dedupe } from './split.mjs';
import { runExec } from './reviewers.mjs';
import { atCap } from './extension.mjs';
import { answerPending, emptyState, mergePending, noteOutcome, prunePasses, readLocalState, summaryBody, writeSummary, writeLocalState } from './state.mjs';
import * as quota from './quota.mjs';
import { ghImage } from './visual.mjs';
import { prepareStep } from './step.mjs';
import { runStages } from './stages.mjs';

export { DEPENDENCY_DIRS, stderrTail } from './base-worktree.mjs';
export { reviewInForce } from './in-force.mjs';
export { recordAccept, recordOverrule, recordPass, recordSignoff, recordStageSignoff, remoteState } from './record.mjs';
export { MAX_LINES } from './step.mjs';
export { MAX_ATTEMPTS } from './stages.mjs';

export const EXIT = Object.freeze({
  dispatch: 0, running: 0, fix_required: 0, received: 0, none_needed: 0, human_required: 9,
  timed_out: 2, checks_pending: 2, blocked_quota: 3, round_limit: 4, unsatisfied: 6, incomplete: 7, stuck: 8, too_large: 8,
  extension_check: 10, extension_ask: 11,
});

// The whole step. `deps` replaces the forge, the image upload, the engine check, the reviewers, and the bot wait in tests.
// A step that throws after it marked its head `running`, such as a plan command that fails or a bot wait that errs,
// leaves `error` as the head's outcome, so the merge guard keeps refusing the head.
export async function reviewStep(opts, deps = {}) {
  const run = { pr: null, head: null, repo: null };
  try {
    return await stepOnce(opts, deps, run);
  } catch (error) {
    if (run.pr !== null) {
      const state = readLocalState(deps.project, run.pr) ?? emptyState(run.pr, run.repo);
      writeLocalState(deps.project, noteOutcome(state, { status: 'error', head: run.head, reason: error.message }));
    }
    throw error;
  }
}

// One step on the context `s`: the deps, then what lib/review/step.mjs reads and plans, and the outcome writers.
async function stepOnce(opts, { project, config, env = process.env, forge = forgeFor(undefined), image = (repo, files) => ghImage(repo, files, forge), exec = runExec, awaitBot = null, codex, captureSpawn } = {}, run) {
  const s = { opts, project, config, env, forge, image, exec, awaitBot, codex, captureSpawn, run };
  Object.assign(s, {
    settle: (result) => settle(s, result),
    finish: (status, extra) => finish(s, status, extra),
    capReached: (extra) => capReached(s, extra),
    quotaStop: (pass, stage, reason, extra) => quotaStop(s, pass, stage, reason, extra),
  });
  const ended = await prepareStep(s);
  if (ended) return ended;
  return runStages(s);
}

// The current round's open findings, kept on its entry in the record, so the check at the cap can read each round's
// findings after the passes have moved on to later heads.
function noteFindings({ state, head }, extra) {
  const round = state.rounds.at(-1);
  if (!round || round.head !== head || !(Array.isArray(extra.open) || Array.isArray(extra.flows))) return;
  const violated = (extra.flows ?? []).flatMap((flow) => (flow.violated ?? []).map((id) => ({ title: `flow ${flow.flow}: invariant ${id} violated`, file: null, line: null, severity: null })));
  const passes = extra.open ?? [];
  // Only what still blocks: an itemized list (attest --findings-file, an exec reviewer) keeps its fixed and accepted
  // findings too, and a fixed finding read as open would come back as a loop in the next round. A mistake that a
  // slice and the cross-cutting pass both report is one finding, as findings_merged lists it. A pass recorded with
  // counts only adds its count.
  const itemized = passes.filter((each) => Array.isArray(each.findings));
  const merged = dedupe(itemized.map((each) => [each.pass, each.findings.filter(blocks)]));
  const counted = passes.filter((each) => !Array.isArray(each.findings)).reduce((total, each) => total + (each.open ?? 0), 0);
  round.open = merged.length + counted + violated.length;
  round.findings = itemized.length === passes.length
    ? [...merged.map((each) => ({ title: each.title ?? null, file: each.file ?? null, line: Number.isInteger(each.line) ? each.line : null, severity: each.severity ?? null })), ...violated].slice(0, 50)
    : null;
}

// The round cap: round_limit, unless the base branch's github.extraRounds lets the check at the cap run
// (lib/review/extension.mjs), which may return extension_check or extension_ask instead.
function capReached(s, extra) {
  const { state, head, policy, n, info, planHistory, extensionLog } = s;
  noteFindings(s, extra);
  const decision = atCap({
    state, source: 'plan', round: state.rounds.length, head, policy, pr: n, goal: { title: info.title ?? null, body: info.body ?? null },
    command: `aidrian pr review ${n}`,
    history: planHistory,
    lastReviewed: () => state.rounds.at(-1)?.head ?? null,
    log: extensionLog,
  });
  const { status, ...carried } = decision;
  return finish(s, status, { ...extra, ...carried });
}

// A reviewer out of quota: the stop goes on the record for this head, and the Human is asked what replaces it, unless
// the plan requires an independent model, which no fallback gives.
function quotaStop(s, pass, stage, reason, extra = {}) {
  const { opts, state, head, plan, passes, map, n } = s;
  const stop = quota.recordStop(state, { head, stage, pass, reason });
  const refused = quota.refusal(plan, stop, passes, map);
  return finish(s, 'blocked_quota', { reason, pass: pass.id, ...extra, ...(refused ? { fallback_refused: refused } : quota.question({ pr: n, stop, withBot: opts.withBot })) });
}

// The one writer of every return after the record is read, but `held`, which must write nothing: the step's outcome
// goes into this machine's record, for the merge guard (lib/rules/github/merge-review.mjs). Only `finish` also
// publishes the record to the pull request.
function settle({ project, root, repo, n, state }, result) {
  // A gate review recorded while the step ran is on disk only: merge it in before a finished outcome answers it.
  state.pending = mergePending(readLocalState(project, n)?.pending, state.pending);
  noteOutcome(state, result, (a, b) => isAncestor(root, a, b), repo);
  writeLocalState(project, state);
  return result;
}

// Every bot answer that counts for this head, fresh or reused, answers the reviews the Human asked for
// (`aidrian pr request`), recorded while the step ran included. A reused answer counts with its own head.
function answerRequests({ project, root, repo, n, state, passes, map, resultFor }) {
  const answers = passes.filter((pass) => map[pass.reviewer]?.kind === 'remote').map(resultFor).filter((result) => result?.bot);
  if (!answers.length) return;
  state.pending = mergePending(readLocalState(project, n)?.pending, state.pending);
  for (const result of answers) answerPending(state, 'request', { head: result.head, by: result.reviewer, repo, isAncestor: (a, b) => isAncestor(root, a, b) });
}

function finish(s, status, extra) {
  const { forge, repo, n, head, base, onPr, summary, state, plan, fallbacks, keptSignoffs, maxRounds, flowStatus, outsideClosed, approvalPath, approvals } = s;
  answerRequests(s);
  noteFindings(s, extra);
  const result = { status, pr: n, repo, head, base, depth: plan.depth, round: state.rounds.length, max_rounds: maxRounds, engine: plan.engine, ...extra };
  // Every result on a head whose review a fallback replaced says so.
  if (fallbacks.length) result.quota_fallback = fallbacks.map((stop) => ({ stage: stop.stage, replaces: stop.reviewer, choice: stop.choice, signed_off_by: stop.signoff?.by ?? null, note: quota.describe(stop) }));
  // Slice results of packings this head no longer makes count for nothing again: they leave the record. A pass of
  // this plan always stays.
  prunePasses(state, plan.slices, new Set(plan.stages.flatMap((stage) => stage.passes.map((pass) => pass.id))));
  // The disputes the Human may settle on this head: `aidrian pr signoff --overrule` refuses any other invariant.
  state.disputes = { head, items: plan.flows.flatMap((flow) => flowStatus(flow).disputed.map((invariant) => ({ flow: flow.id, invariant }))) };
  // The approvals that closed an invariant, kept for the summary, and the path's state when an invariant names
  // approvers: which switch is off, or why the approvals could not be read.
  state.outside = { head, ...outsideClosed() };
  // The invariants the reviewers left open on this head, before any outside evidence: `aidrian pr signoff --accept`
  // closes only an unverified one of these, and refuses a violated one.
  state.invariants = { head, items: plan.flows.flatMap((flow) => {
    const status = flowStatus(flow, { outside: false });
    return [...status.open.map((invariant) => ({ flow: flow.id, invariant, state: 'violated' })), ...status.unverified.map((invariant) => ({ flow: flow.id, invariant, state: 'unverified' }))];
  }) };
  if (approvalPath) result.approvals = { on: approvalPath.on, ...(approvalPath.off ? { off: approvalPath.off } : {}), ...(approvals().error ? { error: approvals().error } : {}), closed: state.outside.approvals };
  settle(s, result);
  if (onPr) {
    const body = summaryBody(state, { ...plan, flows: plan.flows.map((flow) => ({ ...flow, signed: flowStatus(flow).signed, humanSigned: keptSignoffs.has(flow.id) })) }, status);
    try {
      writeSummary(summary, (id) => forge.editComment(repo, id, body), () => forge.postComment(repo, n, body));
    } catch (error) {
      result.summary_error = error.message;
    }
  }
  result.plan = { depth: plan.depth, reasons: plan.reasons, flows: plan.flows.map((flow) => flow.id), stages: plan.stages.map((stage) => ({ name: stage.name, passes: stage.passes.map((pass) => pass.id) })) };
  return result;
}

// The CLI body of `aidrian pr review [PR] [--with-bot] [--max-rounds N] [--timeout-sec S] [--quota-fallback agent:NAME|human]`:
// prints the step's JSON, returns its exit code.
export async function runReview(args, config, project, deps = {}) {
  try {
    const opts = { pr: null, maxRounds: undefined, timeoutSec: undefined, withBot: false, quotaFallback: null };
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      const value = () => {
        const next = args[++i];
        if (next === undefined) throw new Error(`${a} needs a value`);
        return next;
      };
      if (a === '--with-bot') opts.withBot = true;
      else if (a === '--max-rounds') opts.maxRounds = Number(value());
      else if (a === '--timeout-sec') opts.timeoutSec = Number(value());
      else if (a === '--quota-fallback') opts.quotaFallback = quota.parseChoice(value());
      else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
      else if (opts.pr === null) opts.pr = a.replace(/^#/u, '');
      else throw new Error(`unexpected argument: ${a}`);
    }
    if (opts.maxRounds !== undefined && !(Number.isInteger(opts.maxRounds) && opts.maxRounds >= 1)) throw new Error('--max-rounds must be an integer >= 1');
    if (opts.timeoutSec !== undefined && !(Number.isFinite(opts.timeoutSec) && opts.timeoutSec >= 0)) throw new Error('--timeout-sec must be >= 0');
    const result = await reviewStep(opts, { project, config, ...deps });
    if (result.status === 'round_limit') {
      const { recordSignal, roundLimitSignal } = await import('../lesson-signals.mjs');
      recordSignal(project, roundLimitSignal({ repo: result.repo, pr: result.pr, maxRounds: result.max_rounds, rounds: result.round, ...sessionIdentity(deps.env ?? process.env) }), { config });
    }
    console.log(JSON.stringify(result, null, 2));
    return EXIT[result.status] ?? 1;
  } catch (error) {
    console.error(`aidrian pr review: ${error.message}`);
    return 1;
  }
}
