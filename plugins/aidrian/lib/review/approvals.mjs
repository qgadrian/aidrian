// Evidence outside the tool that closes a flow invariant no reviewer could verify, such as a designer's approval of
// real screenshots while no app runs for the visual capture. An invariant of a flow's list may name `approvers`, forge
// logins, read from the base branch like all review config. A review on the forge closes that invariant on one head
// when every one of these holds:
//
//   - its state is APPROVED, and it was given on that exact commit (`commit_id`), so a push drops it
//   - its author is one of the invariant's approvers, and is not the account the session's forge token belongs to, so
//     an agent holding that token cannot approve for itself
//   - its body holds the line `aidrian-approve: <flow>/<invariant>`, so one approval names what it closes
//
// It closes an invariant no reviewer answered with evidence, never one a reviewer says is violated (flows.mjs
// flowState). The path is on only with both switches on: the team's `review.approvals.allow` on the base branch, and
// this machine's `reviewApprovals: "on"` in the git-ignored local file (project.mjs). A forge read that fails reads as
// no approval: the invariant stays unverified, and the review step still runs. docs/review.md#sign-off-by-the-human.

import { isLogin } from '../forges/index.mjs';

export const APPROVE_KEY = 'aidrian-approve';

// The line an approver puts in the body of their review to close `invariant` of `flow`.
export const approveLine = (flow, invariant) => `${APPROVE_KEY}: ${flow}/${invariant}`;

// Whether approvals count here: { on, off }, where `off` names the switch that is off, or is null.
export function approvalsSwitch(review, project) {
  if (review?.approvals?.allow !== true) return { on: false, off: 'the team does not allow it: review.approvals.allow is not true on the base branch' };
  if (project?.localReviewApprovals !== 'on') return { on: false, off: `this machine has not turned it on: reviewApprovals is not "on" in ${project?.paths?.local ?? 'the local settings file'}` };
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
  const out = [];
  const seen = new Set();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (review?.state !== 'APPROVED' || review.commit_id !== head) continue;
    const login = review.user?.login;
    if (!isLogin(login) || same(login, viewer)) continue;
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
