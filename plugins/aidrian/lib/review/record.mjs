// The commands that write one entry into a pull request's review record: `aidrian pr attest` and the forms of
// `aidrian pr signoff`, and the pull request's comments they read the record from. lib/review/run.mjs re-exports each.

import { forgeFor } from '../forges/index.mjs';
import { overruleRefusal } from './approvals.mjs';
import { isObject } from '../fs.mjs';
import { notedPlan, parseFindings, recordFindings } from './findings.mjs';
import { parseVerdicts } from './flows.mjs';
import { closingRange } from './dispatch.mjs';
import { gitPaths } from './publish.mjs';
import * as quota from './quota.mjs';
import { heldMessage, otherRecordMessage, otherRecordRepo, readRecord, sameCommit, writeLocalState } from './state.mjs';

// The record to change, as readRecord gives it: the newer of this machine's and the one in the pull request's
// comments (`remote`, as remoteState read them), so a write never builds on a stale copy. A held comment newer than
// this machine's record is refused, never started over.
// A record of another repository with this number is refused (state.mjs otherRecordRepo): no entry lands on it.
function current(project, pr, repo, remote) {
  const record = readRecord(project, pr, remote ?? [], repo);
  if (record.held !== undefined) throw new Error(heldMessage(pr, record.held, record.why));
  const other = otherRecordRepo(record.state, repo);
  if (other) throw new Error(otherRecordMessage(pr, other, repo, 'this command records on'));
  return record.state;
}

// The pull request's comments, where its summary comment carries the record, or null when they cannot be read
// (offline: the local record). With config.json `review.record: "local"` there is no summary comment, and the pull
// request is not read.
export function remoteState(repo, pr, forge = forgeFor(undefined), config = null) {
  if (config?.review.record === 'local') return null;
  try {
    return forge.conversationComments(repo, pr);
  } catch {
    return null;
  }
}

// `aidrian pr attest <PR> --pass <id> ...`: one pass's result, for this head, into the review record.
// With `findingsText` (--findings-file), the counts come from the findings one by one, and the disposition table
// decides which stay open (lib/review/findings.mjs). The result replaces the pass's counts and list, and keeps the waivers
// the record held (`ruled`, `carried`), which no count reads: only a pass that re-runs, or a listing of the finding as
// fixed, ends one (lib/review/settled.mjs).
export function recordPass(project, { pr, repo, pass, head, reviewer, findings, fixed, accepted = 0, verdictsText = null, findingsText = null, remote = null }) {
  const itemized = findingsText === null ? null : parseFindings(findingsText);
  if (itemized) ({ findings, fixed, accepted } = itemized);
  if (fixed + accepted > findings) throw new Error('--fixed and --accepted together cannot exceed --findings');
  const verdicts = verdictsText === null ? [] : parseVerdicts(verdictsText);
  // An agent slice writes its report to the cross pass in the same file: { verdicts, contracts, cross_notes }.
  let report = {};
  try {
    const raw = verdictsText === null ? null : JSON.parse(verdictsText);
    const strings = (list) => (Array.isArray(list) ? list.filter((each) => typeof each === 'string').slice(0, 50) : []);
    if (raw && !Array.isArray(raw)) report = { contracts: strings(raw.contracts), cross_notes: strings(raw.cross_notes) };
  } catch {}
  const state = current(project, pr, repo, remote);
  const before = state.passes[pass];
  const note = isObject(state.dispatched?.[pass]) ? state.dispatched[pass] : null;
  const files = note?.files ?? null;
  const result = { head, reviewer, files, findings, open: findings - fixed - accepted, verdicts, ...report, list: itemized?.list ?? (before?.head === head ? before.list : null), ...(before?.ruled ? { ruled: before.ruled } : {}), ...(before?.carried ? { carried: before.carried } : {}) };
  // Ids come from the one function that writes them (findings.mjs recordFindings). Attest mints one only into a record a
  // step has floored, for a pass that step dispatched: elsewhere a finding keeps the id of its match in the pass's prior
  // list, and the rest wait for the next step. A returned id counts only among the ids the dispatch note says the pass's
  // input listed; the head's plan is the one the plan note names. A finding listed as fixed closes on this head, its
  // range from the head that last held it open, else the merge base the plan note names, else the delta base.
  const mint = state.floored === true && typeof note?.stage === 'string';
  const base = (state.planNote?.head === head ? state.planNote.base : null) ?? note?.base ?? null;
  const recorded = recordFindings(state, pass, result, {
    mint, securityPass: note?.security === true, paths: gitPaths(project.root).at(head), listed: Array.isArray(note?.listed) ? note.listed : null,
    plan: notedPlan(state), stage: note?.stage ?? null, range: closingRange(project.root, base),
  });
  writeLocalState(project, state);
  return recorded;
}

// `aidrian pr signoff <PR> --flow <id> --head <sha>`: the Human's sign-off of a flow on a head. An audit entry, not
// proof: the summary comment shows it, and who ran it.
// With `dryRun`, every refusal runs and nothing is written: `aidrian pr signoff --check`.
export function recordSignoff(project, { pr, repo, flow, head, by, remote = null, dryRun = false }) {
  const state = current(project, pr, repo, remote);
  const asked = state.signoffable;
  if (!asked || !sameCommit(asked.head, head)) throw new Error(`no review of ${repo}#${pr} ran on ${head.slice(0, 7)}: run \`aidrian pr review ${pr}\` on that head first, and sign off only a flow it names`);
  if (!asked.flows.includes(flow)) {
    const which = asked.flows.length ? `only ${asked.flows.join(', ')} can be` : 'no flow is';
    throw new Error(`flow ${flow} takes no Human sign-off on ${head.slice(0, 7)} of ${repo}#${pr}: ${which} signed off there. A sign-off never clears a violated invariant: fix the code, or, where reviewers disagree, settle it with the --overrule command the review prints`);
  }
  state.signoffs[flow] = { head, by, at: new Date().toISOString() };
  if (!dryRun) writeLocalState(project, state);
  return state.signoffs[flow];
}

// `aidrian pr signoff <PR> --flow <id> --overrule <invariant> --head <sha> --reason <text>`: the Human settles a
// dispute on one head, where one reviewer answered violated and another answered holds or not_affected with evidence.
// The invariant then passes on that evidence. An audit entry, not proof, listed with the overrides in the summary.
export function recordOverrule(project, { pr, repo, flow, invariant, head, by, reason, remote = null, dryRun = false }) {
  const state = current(project, pr, repo, remote);
  if (!String(reason ?? '').trim()) throw new Error('--overrule needs --reason: say why the violated verdict is wrong');
  const disputes = state.disputes && sameCommit(state.disputes.head, head) ? state.disputes.items : null;
  if (!disputes) throw new Error(`no review of ${repo}#${pr} ran on ${head.slice(0, 7)}: run \`aidrian pr review ${pr}\` on that head first`);
  if (!disputes.some((each) => each.flow === flow && each.invariant === invariant)) {
    throw new Error(overruleRefusal({ pr, repo, flow, invariant, head, invariants: state.invariants }));
  }
  const entry = { flow, invariant, head, by, reason: reason.trim().slice(0, 300), at: new Date().toISOString() };
  state.overrulings = [...(state.overrulings ?? []).filter((each) => !(each.flow === flow && each.invariant === invariant && sameCommit(each.head, head))), entry];
  state.overrides = [...state.overrides, `${by} overruled the violated verdict on ${flow}/${invariant} at ${head.slice(0, 7)}: ${entry.reason}`];
  if (!dryRun) writeLocalState(project, state);
  return entry;
}

// `aidrian pr signoff <PR> --flow <id> --accept <invariant> --evidence <url> --reason <text> --head <sha>`: the Human
// closes, on one head, an invariant no reviewer could verify, on evidence outside the tool, such as a designer's
// approval of real screenshots. `evidence` is the URL of a comment, review, or review comment of this pull request, and
// `checkEvidence(url)` throws unless the forge finds it there. The acceptance never clears a violated invariant, and
// holds for that head only. An audit entry, not proof, listed apart from the verdicts in the summary.
export function recordAccept(project, { pr, repo, flow, invariant, head, by, reason, evidence, checkEvidence = null, remote = null, dryRun = false }) {
  const state = current(project, pr, repo, remote);
  if (!String(reason ?? '').trim()) throw new Error('--accept needs --reason: say what the outside evidence shows');
  const known = state.invariants && sameCommit(state.invariants.head, head) ? state.invariants.items : null;
  if (!known) throw new Error(`no review of ${repo}#${pr} ran on ${head.slice(0, 7)}: run \`aidrian pr review ${pr}\` on that head first, and accept only an invariant it lists as unverified`);
  const item = known.find((each) => each.flow === flow && each.invariant === invariant);
  if (item?.state === 'violated') throw new Error(`invariant ${invariant} of flow ${flow} is violated on ${head.slice(0, 7)} of ${repo}#${pr}: an acceptance never clears a violated invariant. Fix the code, or, where reviewers disagree, settle it with the --overrule command the review prints`);
  if (!item) throw new Error(`invariant ${invariant} of flow ${flow} is not unverified on ${head.slice(0, 7)} of ${repo}#${pr}: --accept closes only an invariant the review lists as unverified on that head`);
  if (typeof evidence !== 'string' || !/^https:\/\/\S+$/u.test(evidence)) throw new Error('--accept needs --evidence: the https URL of a comment, review, or review comment of this pull request');
  if (typeof checkEvidence !== 'function') throw new Error(`--evidence ${evidence} could not be checked`);
  const kind = checkEvidence(evidence);
  const entry = { flow, invariant, head, by, reason: reason.trim().slice(0, 300), evidence, kind, at: new Date().toISOString() };
  state.acceptances = [...(state.acceptances ?? []).filter((each) => !(each.flow === flow && each.invariant === invariant && sameCommit(each.head, head))), entry];
  if (!dryRun) writeLocalState(project, state);
  return entry;
}

// `aidrian pr signoff <PR> --stage <name> --head <sha>`: the Human's sign-off of a stage they chose to review in place of
// a reviewer out of quota on that head (lib/review/quota.mjs). Like a flow's, an audit entry, not proof. It signs only a
// stage the Human chose to review, so it never skips a reviewer that has its quota.
export function recordStageSignoff(project, { pr, repo, stage, head, by, remote = null, dryRun = false }) {
  const state = current(project, pr, repo, remote);
  // One sign-off covers the stage: every reviewer of it the Human chose to replace on that head.
  const stops = (state.quotaStops ?? []).filter((each) => each.stage === stage && sameCommit(each.head, head) && each.choice === quota.HUMAN);
  if (!stops.length) throw new Error(`no Human review of the ${stage} stage is waiting on ${head.slice(0, 7)} of #${pr}: --stage signs off only a stage the Human chose to review after its reviewer ran out of quota`);
  const signoff = { by, at: new Date().toISOString() };
  for (const stop of stops) stop.signoff = signoff;
  if (!dryRun) writeLocalState(project, state);
  return signoff;
}
