// The review config a step runs by: the base branch's `review` group, which a pull request cannot weaken, plus what the
// head adds; the files a review command line names, whose change is a change to how the project is reviewed; and what
// the base branch itself changed in how the project is reviewed; and the state.dir check every review-record command
// makes against the base branch.
// lib/review/run.mjs re-exports reviewInForce.

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { committedConfig, firstTip, loadConfig, originDefaultTip, stateDirProblem } from '../config.mjs';
import { isDirectory, isFile, isWithin, resolvedPath } from '../fs.mjs';
import { checkoutRoots, runGit } from '../git.mjs';
import { committedConfigFile, DEFAULT_CONFIG, recordsFolder, stateDir } from '../project.mjs';
import { checkReview, REVIEW_DEFAULTS } from './config.mjs';
import { changedFiles, fileAt } from './diff.mjs';
import { flowsInForce } from './plan.mjs';
import { touchedCitations } from './cited.mjs';
import { codexAvailable, reviewerMap } from './reviewers.mjs';

// The base branch's tip in this checkout, by full ref names, so the answer does not depend on other refs: its tracking
// ref, or with no such ref its own branch. Null and throws as firstTip does. `git` gives each read's options.
const baseTipOf = (root, base, git) => firstTip(root, [`refs/remotes/origin/${base}`, `refs/heads/${base}`], git);

// Each git read with its own default options, for a command with no deadline.
const defaultGit = () => undefined;

// What a record command and the review step say about a difference from the base branch: a local reviewer needs a checkout
// at the head, where the hold refuses, so the messages state that limit instead of sending a session between checkouts.
// The merge guard has its own recourse, and auto-merge and product feedback print the difference alone.
const BEHIND = 'A head behind that base merges it first.';
const BASE_PINS_LOCAL = "The base branch's config.json pins `review.engine` to a local reviewer, which reads the checkout at the head, where the hold refuses, so no review finishes on this pull request: the Human merges it in their own shell.";
const localLimit = (project) => `A local reviewer reads the checkout at the head, so it cannot finish from there: with one as this machine's engine, set \`review.engine\` to \`self\` in \`${project.paths.local}\` for this review, and put it back after.`;

// Whether the config `base` pins `review.engine` to a reviewer that reads the checkout, which this machine's setting
// cannot change. `auto` is one when Codex can run here. With no pin the machine's engine decides, and `self` is open to it.
function pinsLocalReviewer(base, codex) {
  const pin = base.review.engine;
  if (!pin) return false;
  return pin === 'auto' ? codex().ok : reviewerMap(base)[pin]?.kind === 'exec';
}

// Whether the base branch at `baseTip` pins a local reviewer, read from the file that commit names, never the working copy's.
function basePinsLocal(project, baseTip, codex) {
  const atBase = { ...project, paths: { ...project.paths, config: committedConfigFile(project, baseTip) } };
  return pinsLocalReviewer(committedConfig(atBase, baseTip), codex);
}

const INSIDE = "the state folder is inside this repository's checkout ";
const DEFAULT_INSIDE = "the default state folder is inside this repository's checkout ";
const RECORDS_CHECKOUT = 'the folder the review records go in is a checkout, ';
const LINE_BREAK = "the path of the state folder or of the folder the review records go in holds a line break, which git's list of checkouts cannot show, ";
const UNLISTED = "git cannot list this repository's checkouts, and the review record is read from it";
const ALONE = 'commit that change alone in its own pull request, which gets no local review record, so the Human merges it';
const COPY = "from a clean checkout on the base branch, move the old folder's contents to the folder `aidrian state` prints.";

// A path as a disk that ignores case or Unicode form reads it.
const spelled = (name) => name.normalize('NFC').toLowerCase();

// `file` as the disk spells it: the real path of its nearest existing part, then the parts that do not exist yet. Null
// when that part is a broken link.
function onDiskPath(file) {
  if (resolvedPath(file) === null) return null;
  const tail = [];
  for (let current = file; ; current = path.dirname(current)) {
    try {
      return path.join(realpathSync.native(current), ...tail);
    } catch {
      tail.unshift(path.basename(current));
    }
  }
}

// A path as named and on disk, each in the spelling the comparison reads.
const spellings = (file) => [file, onDiskPath(file)].filter(Boolean).map(spelled);

// Whether git keeps a work tree at `dir`. A repository whose git folder lies apart has that folder listed as its main
// entry, and a worktree whose folder is gone stays listed: neither is a checkout.
const holdsCheckout = (dir) => isFile(path.join(dir, '.git')) || isDirectory(path.join(dir, '.git'));

// Every checkout of this repository: the listed ones, and the one the project is in. Null when git cannot answer. git runs
// only at the project root, where it meets the checkout's own `.git` first, so no answer depends on the state folder.
function repositoryCheckouts(project, git) {
  const listed = runGit(['worktree', 'list', '--porcelain'], project.root, git());
  const roots = listed.status === 0 ? checkoutRoots(project.root, git()) : null;
  if (!roots) return null;
  const entries = listed.stdout.split('\n\n').filter((entry) => !entry.split('\n').includes('bare'));
  // Each path exactly as git prints it, which is raw: the rest of its line, whatever that line holds.
  const paths = entries.map((entry) => entry.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length)).filter((dir) => dir && holdsCheckout(dir));
  return [...new Set([roots.current, ...paths])];
}

// The refusal for a state folder inside the checkout `top`. A folder the config names moves by the config. The default
// folder has nothing in the config to clear, so it moves by the config or by this machine's state root.
function insideProblem(project, working, top) {
  const why = `${top}, and the review record is read from it: in ${project.paths.config}, set "state": { "dir":`;
  if (working.state.dir) return `${INSIDE}${why} null } for the default folder, or any folder outside every checkout of this repository, and ${ALONE}. Once it lands, on each machine, ${COPY}`;
  return `${DEFAULT_INSIDE}${why} "<path>" } to a folder outside every checkout of this repository, and ${ALONE}, or set this machine's state root, \`$XDG_STATE_HOME\`, to a folder outside them. Once it is outside, on each machine whose folder moved, ${COPY}`;
}

// The refusal for a state folder whose path holds a line break, moved the same ways.
function lineBreakProblem(project, working) {
  const why = `${LINE_BREAK}and the review record is read from it: in ${project.paths.config}, set "state": { "dir":`;
  const folder = 'a folder outside every checkout of this repository whose path holds none';
  if (working.state.dir) return `${why} null } for the default folder, or ${folder}, and ${ALONE}. Once it lands, on each machine, ${COPY}`;
  return `${why} "<path>" } to ${folder}, and ${ALONE}, or set this machine's state root, \`$XDG_STATE_HOME\`, to one. Once it is moved, on each machine whose folder moved, ${COPY}`;
}

// The record is this machine's, and a head puts its files in its checkout, so the state folder and the folder the records
// go in lie outside every checkout of this repository, as named and with their links followed, in any case, whichever way
// `state.dir` is set. Elsewhere is allowed: this repository's head puts no file in another repository, an outer one, or a
// git folder apart. The folder the records go in holds no checkout of any repository either; a checkout elsewhere under
// the state folder is allowed. git's list splits by line, so a path with a line break is refused wherever it lies, with
// or without an answer from git. { problem }, null when it holds, with `unread` when git could not answer. `aidrian check`
// warns with the same answer.
export function insideCheckout(project, working, git) {
  let state;
  try {
    state = stateDir(project, { config: working, read: git });
  } catch {
    return { problem: UNLISTED, unread: true };
  }
  const records = recordsFolder(state);
  if (holdsCheckout(records)) return { problem: `${RECORDS_CHECKOUT}${records}, and the review record is read from it: move or remove that checkout on this machine, so only this machine's records stay there.` };
  let folder;
  let tops;
  try {
    folder = [...spellings(state), ...spellings(records)];
    tops = repositoryCheckouts(project, git);
  } catch {
    tops = null;
  }
  // A checkout at or above the folder has its path in the folder's, so a path with no line break needs no such entry.
  if (folder?.some((each) => each.includes('\n'))) return { problem: lineBreakProblem(project, working) };
  if (!tops) return { problem: UNLISTED, unread: true };
  const top = tops.find((dir) => spellings(dir).some((from) => folder.some((each) => isWithin(from, each))));
  return { problem: top ? insideProblem(project, working, top) : null };
}

// What the merge guard says to do about `problem`, from the compare that found it: `base` the branch the head lookup named,
// null for origin's default branch. A state folder inside a checkout, or a checkout at the folder the records go in, is
// refused at the base branch too, so a checkout there is no way forward. The default folder can move on this machine
// alone, with nothing to land. A difference from the default branch sends no session to a base that is another branch:
// that base differs from the default branch itself, and from its own checkout this same compare refuses.
export function recourse(problem, base) {
  if (problem.startsWith(RECORDS_CHECKOUT)) return 'Move that checkout first; until it is gone, the Human merges in their own shell.';
  if (problem.startsWith(LINE_BREAK)) return 'Move the state folder first; until its path holds none, the Human merges in their own shell.';
  if (problem.startsWith(DEFAULT_INSIDE)) return 'Move the state folder first; until it is outside, the Human merges in their own shell.';
  if (problem.startsWith(INSIDE)) return 'Move the state folder first; until that lands, the Human merges in their own shell.';
  if (base) return 'Merge from a checkout on the base branch, or the Human merges in their own shell.';
  return "Merge from a clean checkout at that branch's tip when it is the pull request's base; with another base, or no such checkout, the Human merges in their own shell.";
}

// The working copy against the config `baseTip` commits: { committed, problem }, with `problem` null when it holds, `differs`
// when it is a difference a checkout on the base does not have, and `unread` when it is a read that failed, not a real
// difference. A base with no config at all has no project folder to differ from: that is the pull request that adopts
// aidrian. `git` gives each read's options.
function againstBase(project, working, baseTip, where, git) {
  const folderMoved = `the working copy's project folder differs from ${where}, and the review record is read from it`;
  const file = committedConfigFile(project, baseTip, git());
  if (file === null) return { committed: null, problem: folderMoved, unread: true };
  if (file !== project.paths.config && fileAt(project.root, baseTip, file, git()) !== null) return { committed: null, problem: folderMoved, differs: true };
  const committed = committedConfig(project, baseTip, [], git());
  const moved = stateDirProblem(working, committed, where);
  return moved ? { committed, problem: moved, differs: true } : { committed, ...insideCheckout(project, working, git) };
}

// The base branch as this checkout has it, and its committed config: { committed, baseTip }. The review record is read
// from `state.dir`, so a command calls this before it reads the record, and a working copy whose value differs from the
// base branch's is refused, as auto-merge refuses it. `config` is the working copy's, null to load it. `codex` says
// whether Codex can run here, read only for a difference under a base that pins `auto`. Throws on a base no ref here
// resolves, and on a read that fails.
export function holdToBase(project, config, { repo, base, codex = codexAvailable }) {
  const baseTip = baseTipOf(project.root, base, defaultGit);
  if (!baseTip) throw new Error(`the base branch ${base} is not in this checkout: git fetch first`);
  const { committed, problem, differs } = againstBase(project, config ?? loadConfig(project).config, baseTip, `${repo} ${base}`, defaultGit);
  if (!problem) return { committed, baseTip };
  if (!differs) throw new Error(problem);
  const next = basePinsLocal(project, baseTip, codex) ? `${BEHIND} ${BASE_PINS_LOCAL}` : `Run the review from a checkout on the base branch. ${localLimit(project)} ${BEHIND}`;
  throw new Error(`${problem}. ${next}`);
}

// Why a local reviewer cannot finish from a checkout at `head`, for a review step running in another checkout: the hold
// refuses there when the head's own config differs from the base branch's, so no such checkout is a way forward. Null when
// a checkout at the head would pass that compare. It reads the head as a checkout there would read itself, with the file the
// head names and its committed config. `codex` as for holdToBase.
export function refusedAtHead(project, baseTip, head, codex = codexAvailable) {
  const atHead = { ...project, paths: { ...project.paths, config: committedConfigFile(project, head) ?? DEFAULT_CONFIG } };
  if (!againstBase(atHead, committedConfig(atHead, head), baseTip, 'the base branch', defaultGit).differs) return null;
  const why = `the state.dir or project folder of ${head.slice(0, 7)} differs from the base branch's, so the hold refuses a checkout at it.`;
  return basePinsLocal(project, baseTip, codex) ? `${why} ${BEHIND} ${BASE_PINS_LOCAL}` : `${why} ${localLimit(project)} ${BEHIND}`;
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
// or with none named from origin's default branch (originDefaultTip), or null. A ref that is not here leaves the compare
// with the checkouts, which needs no base. A read that fails or has no time left is no answer: a hook lets the action run
// when it cannot read.
export function baseProblem(project, { repo, base = null, git }) {
  try {
    const baseTip = base ? baseTipOf(project.root, base, git) : originDefaultTip(project.root, git);
    const where = base ? `${repo} ${base}` : `${repo}'s default branch`;
    const working = loadConfig(project).config;
    const { problem, unread } = baseTip ? againstBase(project, working, baseTip, where, git) : insideCheckout(project, working, git);
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
