// What closes a flow on the head a review step runs on: the reviewers' verdicts and captures, the Human's sign-offs,
// overrulings, and acceptances, and the approvals outside the tool. lib/review/step.mjs builds these for its step.

import { changedFiles, diffLines, isAncestor } from './diff.mjs';
import { citationProblem, flowState } from './flows.mjs';
import { approvalsSwitch, hasApprovers, isJudgeRuling, readApprovals, settleSwitch } from './approvals.mjs';
import { contentFlows } from './content.mjs';
import { touchedCitations } from './cited.mjs';
import { classify, detectFlows, HARNESS_FLOW, pathPattern } from './plan.mjs';
import { sameCommit } from './state.mjs';
import { captureKeys, readManifest } from './visual.mjs';
import { runPlanCommand } from './base-worktree.mjs';

// The flows whose Human sign-off on an earlier head still holds on `head`.
// A Human sign-off on an earlier head still holds when that head is an ancestor of this one and the change since
// selects nothing of the flow, run through the same selection as the plan: its globs, added-line patterns, content
// tracing, plan command, tests, and invariants doc. Accepting a deleted test stays exact to the head.
// `harnessFiles` are the files that decide how the project is reviewed, as lib/review/step.mjs reads them.
export async function keptSignoffsOf({ root, head, baseTip, cleanEnv, review, harnessFiles, plan, state }) {
  const reselected = new Map();
  const selectedSince = async (from) => {
    if (reselected.has(from)) return reselected.get(from);
    const since = changedFiles(root, from, head);
    const lines = diffLines(root, from, head);
    const ids = new Set(detectFlows(review.flows, { sorted: classify(since, review), addedLines: lines.addedLines, removedFiles: lines.removedFiles }).map((flow) => flow.id));
    for (const flow of contentFlows({ root, head, changes: since, addedLines: lines.addedLines, flows: review.flows })) ids.add(flow.id);
    const sincePaths = new Set(since.map((change) => change.file));
    for (const [id, definition] of Object.entries(review.flows)) {
      const tests = (definition.tests ?? []).map(pathPattern);
      if (since.some((change) => tests.some((pattern) => pattern.test(change.file))) || touchedCitations(root, from, head, { [id]: definition }, sincePaths).length) ids.add(id);
    }
    if (since.some((change) => harnessFiles.has(change.file)) || touchedCitations(root, from, head, review.flows, sincePaths).length) ids.add(HARNESS_FLOW);
    if (review.planCommand && since.length) {
      const extra = await runPlanCommand(review.planCommand, { base: from, head, changes: since }, { root, env: cleanEnv, baseTip });
      for (const flow of extra.flows ?? []) ids.add(flow.id);
    }
    reselected.set(from, ids);
    return ids;
  };
  const keptSignoffs = new Set();
  for (const flow of plan.flows) {
    const signed = state.signoffs[flow.id]?.head;
    if (flow.signoff !== 'human' || !signed) continue;
    if (signed === head || (isAncestor(root, signed, head) && !(await selectedSince(signed)).has(flow.id))) keptSignoffs.add(flow.id);
  }
  return keptSignoffs;
}

// The step's readers of what holds each flow's invariants on this head, for the step context `s`. `s.manifest` is read
// at each call: the capture of this head may land during the step.
export function evidenceOf(s) {
  const { project, root, n, repo, head, forge, review, state, plan, passes, resultFor } = s;
  const verdictsFor = (flowId) => passes.filter((pass) => (pass.flows ?? []).includes(flowId)).flatMap((pass) => {
    const result = resultFor(pass);
    return (result?.verdicts ?? []).filter((verdict) => verdict.flow === flowId).map((verdict) => ({ ...verdict, at: result.head, reviewer: pass.reviewer }));
  });
  // A capture is evidence for the head it was taken of: a verdict carried forward from an earlier head cites that
  // head's captures. The keys live in the review record too, so another machine without the images can check them.
  const capturesOf = (at) => new Set([...(state.captured?.[at] ?? []), ...captureKeys(at === head ? s.manifest : readManifest(project, n, at))]);
  // A judge's ruling counts only while both switches are on, and never on the flow that guards the review's own config.
  const settle = settleSwitch(review, project);
  const stands = (each) => !isJudgeRuling(each) || (settle.on && each.flow !== HARNESS_FLOW);
  // The invariants the Human overruled on this head: a violated verdict another reviewer disputes with evidence.
  const overruledOn = (flowId) => new Set((state.overrulings ?? []).filter((each) => each.flow === flowId && sameCommit(each.head, head) && stands(each)).map((each) => each.invariant));
  // Evidence outside the tool (lib/review/approvals.mjs): a named approver's review of this head, read once per step,
  // and only when an invariant names approvers and both switches are on. A failed read closes nothing.
  const approvalPath = hasApprovers(plan.flows) ? approvalsSwitch(review, project) : null;
  let approvalRead = null;
  const approvals = () => (approvalRead ??= approvalPath?.on ? readApprovals(forge, repo, n, { head, flows: plan.flows }) : { approvals: [], error: null });
  // The Human's acceptances on this head (`aidrian pr signoff --accept`), each on outside evidence they named.
  const acceptedOn = (flowId) => (state.acceptances ?? []).filter((each) => each.flow === flowId && sameCommit(each.head, head) && stands(each));
  const approvedOn = (flowId) => new Set([...approvals().approvals.filter((each) => each.flow === flowId), ...acceptedOn(flowId)].map((each) => each.invariant));
  const flowStatus = (flow, { outside = true } = {}) => flowState(flow.invariants, verdictsFor(flow.id), (evidence, verdict) => citationProblem(evidence, { root, head, captures: capturesOf(verdict?.at ?? head) }), overruledOn(flow.id), outside ? approvedOn(flow.id) : new Set());
  // The outside evidence that closed an invariant on this head, of the ones the reviewers left unverified: the approvals,
  // and the Human's acceptances.
  const outsideClosed = () => {
    const left = new Map(plan.flows.map((flow) => [flow.id, new Set(flowStatus(flow, { outside: false }).unverified)]));
    const closes = (each) => left.get(each.flow)?.has(each.invariant) ?? false;
    return {
      approvals: approvals().approvals.filter(closes).map(({ flow, invariant, login, url, at }) => ({ flow, invariant, login, url, at })),
      acceptances: plan.flows.flatMap((flow) => acceptedOn(flow.id)).filter(closes).map(({ flow, invariant, by, evidence, reason, at }) => ({ flow, invariant, by, evidence, reason, at })),
    };
  };
  // The verdicts on an invariant that said holds or not_affected but whose evidence does not count, and why: a reviewer's
  // judgement that a new pass with a checkable citation closes, with no sign-off.
  const rejectedVerdicts = (flowId, invariant) => verdictsFor(flowId)
    .filter((verdict) => verdict.invariant === invariant && ['holds', 'not_affected'].includes(verdict.verdict))
    .map((verdict) => ({ reviewer: verdict.reviewer, verdict: verdict.verdict, problem: citationProblem(verdict.evidence, { root, head, captures: capturesOf(verdict.at ?? head) }) }))
    .filter((each) => each.problem !== null);
  return { verdictsFor, approvalPath, approvals, flowStatus, outsideClosed, rejectedVerdicts, settle };
}
