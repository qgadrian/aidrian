// Evidence outside the tool that closes a flow invariant no reviewer could verify, such as a designer's approval of
// real screenshots while no app runs for the visual capture. An invariant of a flow's list may name `approvers`, forge
// logins, read from the base branch like all review config. A review on the forge closes that invariant on one head
// when every one of these holds:
//
//   - its state is APPROVED, and it was given on that exact commit (`commit_id`), so a push drops it
//   - it is its author's latest verdict on that commit: a later review that requests changes on the head takes the
//     approval back, as GitHub's own review decision does; a comment-only review changes nothing
//   - its author is one of the invariant's approvers, and is not the account the session's forge token belongs to, so
//     an agent holding that token cannot approve for itself
//   - its body holds the line `aidrian-approve: <flow>/<invariant>`, so one approval names what it closes
//
// It closes an invariant no reviewer answered with evidence, never one a reviewer says is violated (flows.mjs
// flowState). The path is on only with both switches on: the team's `review.approvals.allow` on the base branch, and
// this machine's `reviewApprovals: "on"` in the git-ignored local file (project.mjs). A forge read that fails reads as
// no approval: the invariant stays unverified, and the review step still runs. docs/review.md#sign-off-by-the-human.

import { isLogin } from '../forges/index.mjs';
import { sameCommit } from './state.mjs';

export const APPROVE_KEY = 'aidrian-approve';

// The line an approver puts in the body of their review to close `invariant` of `flow`.
export const approveLine = (flow, invariant) => `${APPROVE_KEY}: ${flow}/${invariant}`;

// Whether approvals count here: { on, off }, where `off` names the switch that is off, or is null.
export function approvalsSwitch(review, project) {
  if (review?.approvals?.allow !== true) return { on: false, off: 'the team does not allow it: review.approvals.allow is not true on the base branch' };
  if (project?.localReviewApprovals !== 'on') return { on: false, off: `this machine has not turned it on: reviewApprovals is not "on" in ${project?.paths?.local ?? 'the local settings file'}` };
  return { on: true, off: null };
}

// A judge's ruling (`aidrian pr settle`) is recorded as an acceptance or an overruling whose `by` starts with this.
export const JUDGE_PREFIX = 'judge:';
export const isJudgeRuling = (entry) => String(entry?.by ?? '').startsWith(JUDGE_PREFIX);

// Whether a judge's ruling counts here: { on, off }, as approvalsSwitch. The review step reads the base branch's config,
// so a branch cannot raise it for itself.
export function settleSwitch(review, project) {
  if (review?.unattendedSignoff?.allow !== true) return { on: false, off: 'the team does not allow it: review.unattendedSignoff.allow is not true on the base branch' };
  if (project?.localUnattendedSignoff !== 'on') return { on: false, off: `this machine has not turned it on: unattendedSignoff is not "on" in ${project?.paths?.local ?? 'the local settings file'}` };
  return { on: true, off: null };
}

// Whether any invariant of `flows` names approvers.
export const hasApprovers = (flows) => (flows ?? []).some((flow) => (flow.invariants ?? []).some((invariant) => Array.isArray(invariant.approvers) && invariant.approvers.length > 0));

// The `flow/invariant` pairs a review body names, one `aidrian-approve:` line each.
function namedIn(body) {
  const named = new Set();
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const match = new RegExp(`^\\s*${APPROVE_KEY}:\\s*([^\\s/]+)/(\\S+)\\s*$`, 'u').exec(line);
    if (match) named.add(`${match[1]}/${match[2]}`);
  }
  return named;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The approvals among `reviews`, the forge's review payloads of a pull request, that close an invariant of `flows` on
// `head`: [{ flow, invariant, login, head, url, id, at }], one per invariant and approver. `viewer` is the login of the
// session's forge token; with none, nothing counts, since no review can be told apart from the session's own.
export function matchApprovals(reviews, { head, viewer, flows }) {
  if (!isLogin(viewer) || typeof head !== 'string' || head === '') return [];
  // Each author's latest verdict on the head, in the forge's list order, which is the order they were given: an
  // approval, or a request for changes that takes an earlier approval back.
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (!['APPROVED', 'CHANGES_REQUESTED'].includes(review?.state) || review.commit_id !== head) continue;
    const login = review.user?.login;
    if (!isLogin(login) || same(login, viewer)) continue;
    latest.set(login.toLowerCase(), review);
  }
  const out = [];
  const seen = new Set();
  for (const review of latest.values()) {
    if (review.state !== 'APPROVED') continue;
    const login = review.user.login;
    const named = namedIn(review.body);
    for (const flow of flows ?? []) {
      for (const invariant of flow.invariants ?? []) {
        if (!named.has(`${flow.id}/${invariant.id}`) || !(invariant.approvers ?? []).some((each) => same(each, login))) continue;
        const key = `${flow.id}/${invariant.id}/${login.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ flow: flow.id, invariant: invariant.id, login, head, url: review.html_url ?? null, id: review.id ?? null, at: review.submitted_at ?? null });
      }
    }
  }
  return out;
}

// The approvals of pull request `n` on `head`, read once through `forge`: { approvals, error }. Any failure, of the
// review list or of the token's login, gives no approval and names the error.
export function readApprovals(forge, repo, n, { head, flows }) {
  try {
    const viewer = forge.viewer();
    const reviews = forge.reviews(repo, n);
    return { approvals: matchApprovals(reviews, { head, viewer, flows }), error: null };
  } catch (error) {
    return { approvals: [], error: `the approvals on the pull request could not be read, so none counts: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
}

// The refusal of `aidrian pr signoff --overrule` for an invariant not disputed on `head`. `invariants` is the review
// record's `{ head, items }` (run.mjs reviewStep). An invariant the last review of that head lists as unverified gets
// both routes that close it on evidence outside the tool: where the base branch sets review.visual, ingest the images
// and have a reviewer cite one; or the Human's --accept. A violated or unknown invariant gets none: no route closes a violated verdict.
export function overruleRefusal({ pr, repo, flow, invariant, head, invariants }) {
  const lead = `invariant ${invariant} of flow ${flow} is not disputed on ${head.slice(0, 7)} of ${repo}#${pr}`;
  const rule = '--overrule settles only a violated verdict another reviewer answers holds or not_affected with evidence';
  const unverified = Boolean(invariants) && sameCommit(invariants.head, head) && Array.isArray(invariants.items)
    && invariants.items.some((each) => each?.flow === flow && each?.invariant === invariant && each?.state === 'unverified');
  if (!unverified) return `${lead}: ${rule}. Fix the code, or have a reviewer record its verdict with evidence first`;
  return `${lead}: it is unverified, and ${rule}. An unverified invariant closes on evidence outside the tool: when the base branch sets review.visual, ingest the images that show it with \`aidrian pr ingest ${pr} --head ${head} --source "<where they came from>" <image>...\` and have a reviewer cite \`capture:<key>\` in its verdict; or the Human, asked with AskUserQuestion, accepts it with \`aidrian pr signoff ${pr} --flow ${flow} --accept ${invariant} --evidence "<URL of a comment or review of this pull request>" --reason "<what it shows>" --head ${head}\``;
}
