// The review config a step runs by: the base branch's `review` group, which a pull request cannot weaken, plus what the
// head adds; the files a review command line names, whose change is a change to how the project is reviewed; and what
// the base branch itself changed in how the project is reviewed; and the state.dir check every review-record command
// makes against the base branch.
// lib/review/run.mjs re-exports reviewInForce.

import path from 'node:path';

import { committedConfig, loadConfig, stateDirProblem } from '../config.mjs';
import { isWithin, resolvedPath } from '../fs.mjs';
import { currentRoot, runGit } from '../git.mjs';
import { committedConfigFile, repoRoot, stateDir } from '../project.mjs';
import { checkReview, REVIEW_DEFAULTS } from './config.mjs';
import { changedFiles, fileAt, resolve } from './diff.mjs';
import { flowsInForce } from './plan.mjs';
import { touchedCitations } from './cited.mjs';

// The base branch's tip in this checkout, by full ref names, so the answer does not depend on other refs: its tracking
// ref, or else its own branch.
const baseTipOf = (root, base, read) => resolve(root, `refs/remotes/origin/${base}`, read) ?? resolve(root, `refs/heads/${base}`, read);

const TRACKED = 'the state folder holds files git tracks at this checkout, and the review record is read from it';
const UNLISTED = 'git cannot list the state folder at this checkout, and the review record is read from it';

// The state folder's path from the top of this checkout, '' at the top itself, or null when it lies outside.
function stateFolderInCheckout(project, working, read) {
  const folder = stateDir(project, { config: working });
  const top = currentRoot(project.root, read) ?? repoRoot(project);
  const inside = [folder, resolvedPath(folder)].find((each) => isWithin(top, each));
  return inside === undefined ? null : path.relative(top, inside).split(path.sep).join('/');
}

// The record is this machine's, so a state folder in the checkout holds nothing git tracks: no entry at the folder, under
// it, or at a folder above it. { problem }, null when it holds, with `unread` when git could not say.
function trackedState(project, working, git) {
  if (!working.state.dir) return { problem: null };
  const folder = stateFolderInCheckout(project, working, git());
  if (folder === null) return { problem: null };
  const first = folder.split('/')[0];
  const scope = folder === '' ? [] : [`:(top,literal)${first}`];
  const listed = runGit(['ls-files', '-z', '--full-name', '--', ...scope], project.root, { maxBuffer: 256 * 1024 * 1024, ...git() });
  if (listed.status !== 0) return { problem: UNLISTED, unread: true };
  const names = listed.stdout.split('\0').filter(Boolean);
  const holds = (name) => folder === '' || name === folder || name.startsWith(`${folder}/`) || folder.startsWith(`${name}/`);
  return { problem: names.some(holds) ? TRACKED : null };
}

// The working copy against the config `baseTip` commits: { committed, problem }, with `problem` null when it holds, and
// `unread` when the problem is a read that failed, not a real difference. A base with no config at all has no project
// folder to differ from: that is the pull request that adopts aidrian. `git` gives each read's options.
function againstBase(project, working, baseTip, where, git) {
  const folderMoved = `the working copy's project folder differs from ${where}, and the review record is read from it`;
  const file = committedConfigFile(project, baseTip, git());
  if (file === null) return { committed: null, problem: folderMoved, unread: true };
  if (file !== project.paths.config && fileAt(project.root, baseTip, file, git()) !== null) return { committed: null, problem: folderMoved };
  const committed = committedConfig(project, baseTip, [], git());
  const moved = stateDirProblem(working, committed, where);
  return moved ? { committed, problem: moved } : { committed, ...trackedState(project, working, git) };
}

// The base branch as this checkout has it, and its committed config: { committed, baseTip }. The review record is read
// from `state.dir`, so a command calls this before it reads the record, and a working copy whose value differs from the
// base branch's is refused, as auto-merge refuses it. `config` is the working copy's, null to load it. Throws on a base
// no ref here resolves, and on a read that fails.
export function holdToBase(project, config, { repo, base }) {
  const baseTip = baseTipOf(project.root, base);
  if (!baseTip) throw new Error(`the base branch ${base} is not in this checkout: git fetch first`);
  const { committed, problem } = againstBase(project, config ?? loadConfig(project).config, baseTip, `${repo} ${base}`, () => undefined);
  if (problem) throw new Error(problem);
  return { committed, baseTip };
}

// A hook's read options, for one read at a time: each stopped after HOLD_READ_MS, or at `deadline` if sooner. A read asked
// for once the time is gone throws, so the hold is skipped.
const HOLD_READ_MS = 1000;
export const boundedReads = (deadline, now = Date.now) => () => {
  const left = Math.floor(deadline - now());
  if (left <= 0) throw new Error('the hold has no time left');
  return { timeout: Math.min(HOLD_READ_MS, left), killSignal: 'SIGKILL' };
};

// holdToBase's answer for a hook, from local git alone, each read through `git`: why the working copy differs from `base`,
// or with none named from origin's default branch, or null. A ref that is not here, or a read that fails or has no time
// left, is no answer: a hook lets the action run when it cannot read.
export function baseProblem(project, { repo, base = null, git }) {
  try {
    const baseTip = base ? baseTipOf(project.root, base, git()) : resolve(project.root, 'refs/remotes/origin/HEAD', git());
    if (!baseTip) return null;
    const where = base ? `${repo} ${base}` : `${repo}'s default branch`;
    const { problem, unread } = againstBase(project, loadConfig(project).config, baseTip, where, git);
    return unread ? null : problem;
  } catch {
    return null;
  }
}

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
