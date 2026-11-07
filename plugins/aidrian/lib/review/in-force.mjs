// The review config a step runs by: the base branch's `review` group, which a pull request cannot weaken, plus what the
// head adds; the files a review command line names, whose change is a change to how the project is reviewed; and what
// the base branch itself changed in how the project is reviewed.
// lib/review/run.mjs re-exports reviewInForce.

import { checkReview, REVIEW_DEFAULTS } from './config.mjs';
import { changedFiles, fileAt } from './diff.mjs';
import { flowsInForce } from './plan.mjs';
import { touchedCitations } from './cited.mjs';

// The `review` config in force: the base branch's, which a pull request cannot weaken, plus what the head adds.
// `changed` lists the review settings the head changes, which trigger the harness-config flow.
export function reviewInForce(baseReview, headReview) {
  if (!baseReview) {
    const pending = Object.fromEntries(Object.entries(headReview.reviewers).map(([name, reviewer]) => [name, { ...reviewer, pending: true }]));
    const none = { reviewers: {}, approvals: REVIEW_DEFAULTS.approvals };
    return { review: { ...headReview, engine: null, planCommand: null, visual: null, approvals: REVIEW_DEFAULTS.approvals, reviewers: pending }, changed: ['engine', 'planCommand', 'reviewers', 'visual', 'approvals'].filter((key) => JSON.stringify(headReview[key] ?? none[key] ?? null) !== JSON.stringify(none[key] ?? null)) };
  }
  const changed = [];
  for (const key of ['engine', 'rules', 'ignore', 'nonBehaviour', 'flows', 'planCommand', 'reviewers', 'split', 'visual', 'approvals']) {
    if (JSON.stringify(baseReview[key] ?? null) !== JSON.stringify(headReview[key] ?? null)) changed.push(key);
  }
  return {
    review: {
      ...headReview,
      rules: [...baseReview.rules, ...headReview.rules.filter((rule) => !baseReview.rules.some((each) => JSON.stringify(each) === JSON.stringify(rule)))],
      ignore: baseReview.ignore,
      nonBehaviour: baseReview.nonBehaviour,
      split: baseReview.split,
      // The project's engine is policy, like the plan command: a pull request's own pick runs once it is merged.
      engine: baseReview.engine ?? null,
      flows: flowsInForce(baseReview.flows, headReview.flows),
      // The plan command and the reviewers a project defines are code: only the base branch's run. A head may add a
      // reviewer under a new name, never redefine one, and a plan command it adds runs once it is merged.
      planCommand: baseReview.planCommand,
      // The visual capture's policy (what it attaches, where it signs in) and its hooks are the base branch's too, so
      // a pull request cannot switch itself to attaching, or point the capture somewhere else.
      visual: baseReview.visual ?? null,
      // Whether an approver's review may close an invariant is the base branch's too: a pull request cannot let
      // approvals close its own invariants.
      approvals: baseReview.approvals ?? REVIEW_DEFAULTS.approvals,
      reviewers: {
        ...Object.fromEntries(Object.entries(headReview.reviewers).filter(([name]) => !Object.hasOwn(baseReview.reviewers, name)).map(([name, reviewer]) => [name, { ...reviewer, pending: true }])),
        ...baseReview.reviewers,
      },
    },
    changed,
  };
}

// The `review` group of the project config at `commit`, or null when that commit has no config.
export function baseReviewAt(project, commit) {
  const text = fileAt(project.root, commit, project.paths.config);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text);
    return raw?.review === undefined ? checkReview({}, project.paths.config, []) : checkReview(raw.review, project.paths.config, []);
  } catch {
    return null;
  }
}

// The files a plan command line names that exist in the repository: a change to them is a change to the review.
export function commandFiles(root, command, commit) {
  return (command ?? '').split(/\s+/u).filter((word) => /[./]/u.test(word) && !word.startsWith('-') && fileAt(root, commit, word) !== null);
}

// What the base branch changed in how the project is reviewed from `from` (the old merge base of the reviewed head) to
// `to` (the base tip, whose rules the step reviews under, so a rule main gains after the merged commit counts too): the
// config's `review` group (a flow, rule, reviewer, or plan command), a file a review command names (`harnessFiles`), and
// a flow's invariants doc or a doc an invariant cites. The reviewed head was judged without it, so its review cannot
// carry and the merge's own diff is not the whole question.
export function baseReviewMoved(project, { from, to, flows, harnessFiles }) {
  const root = project.root;
  const changes = changedFiles(root, from, to);
  const paths = new Set(changes.map((change) => change.file));
  const moved = [];
  if (paths.has(project.paths.config) && JSON.stringify(baseReviewAt(project, from)) !== JSON.stringify(baseReviewAt(project, to))) moved.push(`${project.paths.config} review`);
  for (const file of harnessFiles) if (file !== project.paths.config && paths.has(file)) moved.push(file);
  moved.push(...touchedCitations(root, from, to, flows, paths));
  return [...new Set(moved)];
}
