// Whether an attempt of a project run leaves work no commit on its issue's branch holds, read twice: by the issue's own
// session when it records its result (lib/project-run-gate.mjs recordResult), and from the ledger by the driver's sweep
// of ended attempts (lib/project-start.mjs sweepAttempts).
//   - treeOf runs git in the attempt's clone, in the session's own sandbox, where `aidrian project result` runs: the
//     status of the clone and of each other worktree git lists, and one count of the commits a local branch, another
//     worktree's HEAD, or the stash holds and neither HEAD nor a remote-tracking ref does. Ignored files, the base
//     copies the start marks skip-worktree or ignores, and the placeholders it excludes never show there. Its word,
//     `clean`, `uncommitted`, or `unknown`, goes in the drop as `tree`, and the driver copies it into the result row.
//   - ledgerKeep decides from the ledger alone whether an ended attempt's folder stays: no gate or hook runs git, or
//     anything the clone configures, in a clone a session had. `tree` decides only that, and never over a commit the
//     forge lacks (unpushedHead goes first).

import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

import { cleanText, maskSecrets } from './clean-text.mjs';
import { gateGit, WHOLE_TREE_BUFFER } from './git.mjs';

// The words a result's `tree` holds, and the statuses whose result the check runs for: merged work landed, and an
// environment result keeps its folder already, with a commit perhaps what broke.
export const TREE_WORDS = Object.freeze(['clean', 'uncommitted', 'unknown']);
export const TREE_STATUSES = Object.freeze(['failed', 'blocked', 'parked', 'pr_open']);
// Each git call's limit, the most other worktrees read, and the most file names a refusal prints.
const TREE_TIMEOUT_MS = 20_000;
const MAX_WORKTREES = 20;
const MAX_NAMES = 10;
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

// The tree of the attempt the start row `start` made, read in its clone with `env`: { tree, files, others, commits,
// names }, or { skip: true } for an attempt offered kept commits whose HEAD does not hold them (lib/project-kept.mjs):
// its first message has it change nothing more, so its tree is not read. Any git call that fails, a clone that is
// not the attempt's own work folder, and a submodule in the clone or a worktree it reads give `unknown`: status does
// not read into a submodule (lib/git.mjs GATE_ARGS), so a dirty one would read clean.
export function treeOf({ start, env = process.env }) {
  const unknown = { tree: 'unknown', files: 0, others: 0, commits: 0, names: [] };
  const work = start?.cwd;
  if (typeof start?.drop !== 'string' || typeof work !== 'string' || work !== path.join(path.dirname(start.drop), 'work')) return unknown;
  if (submodules(work) || present(path.join(path.dirname(start.drop), 'git', 'modules'))) return unknown;
  const quiet = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  const git = (args, cwd) => gateGit(args, cwd, { env: quiet, timeout: TREE_TIMEOUT_MS, maxBuffer: WHOLE_TREE_BUFFER });
  if (typeof start.took?.head === 'string' && FULL_ID.test(start.took.head)) {
    const held = git(['merge-base', '--is-ancestor', start.took.head, 'HEAD'], work);
    if (held.status === 1) return { skip: true };
    if (held.status !== 0) return unknown;
  }
  const own = changedFiles(git, work);
  if (own === null) return unknown;
  // git keeps its list of other worktrees in the git folder's `worktrees` folder: with none there, it lists none.
  const listed = existsSync(path.join(path.dirname(start.drop), 'git', 'worktrees')) ? git(['worktree', 'list', '--porcelain', '-z'], work) : { status: 0, stdout: '' };
  if (listed.status !== 0) return unknown;
  const others = worktreesOf(listed.stdout).slice(1);
  if (others.length > MAX_WORKTREES) return unknown;
  const theirs = { count: 0, sample: [] };
  for (const other of others.filter((each) => !each.prunable)) {
    if (submodules(other.path)) return unknown;
    const files = changedFiles(git, other.path);
    if (files === null) return unknown;
    theirs.count += files.count;
    theirs.sample = theirs.sample.concat(files.sample).slice(0, MAX_NAMES);
  }
  const heads = [...new Set(others.map((each) => each.head).filter((head) => FULL_ID.test(head ?? '')))];
  const counted = git(['rev-list', '--count', '--branches', '--glob=refs/stash*', ...heads, '--not', 'HEAD', '--remotes'], work);
  const commits = counted.status === 0 ? Number(counted.stdout.trim()) : Number.NaN;
  if (!Number.isInteger(commits)) return unknown;
  const names = own.sample.concat(theirs.sample).slice(0, MAX_NAMES).map((name) => maskSecrets(cleanText(name, 120, { domains: false }) ?? ''));
  const tree = own.count + theirs.count + commits > 0 ? 'uncommitted' : 'clean';
  return { tree, files: own.count, others: theirs.count, commits, names };
}

// Whether anything, a link included, is at `file`.
function present(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// Whether the worktree at `dir` declares submodules, by its `.gitmodules`.
const submodules = (dir) => present(path.join(dir, '.gitmodules'));

// What `git status` lists as changed or untracked in the worktree at `cwd` (statusPaths), or null when git cannot answer.
function changedFiles(git, cwd) {
  const read = git(['status', '--porcelain', '-z', '--untracked-files=normal'], cwd);
  return read.status === 0 ? statusPaths(read.stdout) : null;
}

// The paths of `git status --porcelain -z` output `out`: { count, sample }, how many, and the first MAX_NAMES of them.
// A rename or copy names its new path, and its old one is skipped.
export function statusPaths(out) {
  const fields = out.split('\0');
  const read = { count: 0, sample: [] };
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    if (field.length < 4) continue;
    read.count += 1;
    if (read.sample.length < MAX_NAMES) read.sample.push(field.slice(3));
    if (/[RC]/u.test(field.slice(0, 2))) at += 1;
  }
  return read;
}

// The worktrees `git worktree list --porcelain -z` printed, `out`, in its order, the main one first: { path, head,
// prunable } each.
function worktreesOf(out) {
  const trees = [];
  let current = null;
  for (const line of out.split('\0')) {
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, prunable: false };
      trees.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (current && (line === 'prunable' || line.startsWith('prunable '))) current.prunable = true;
  }
  return trees;
}

// The lines a result held back on `read` (treeOf, `uncommitted`) prints: the counts, at most MAX_NAMES cleaned names,
// and the three ways on. None says to discard work, or to stage everything.
export function treeLines(read) {
  const commits = read.commits === 1 ? 'commit' : 'commits';
  const parts = [
    `${read.files} changed or untracked ${read.files === 1 ? 'file' : 'files'} in the clone`,
    ...(read.others ? [`${read.others} in its other worktrees`] : []),
    ...(read.commits ? [`${read.commits} ${commits} only a local branch, another worktree, or the stash holds`] : []),
  ];
  return [
    `the clone holds work no commit on the issue's branch has: ${parts.join(', ')}`,
    ...read.names.map((name) => `  ${name}`),
    'Commit the issue\'s own work on its branch by path (`git add -- <path>`, then `git commit`), bring a slice branch or worktree onto it, ' +
      'or remove scratch files this session made; or run the same command again with --uncommitted to hand the result over with that work left where it is.',
  ];
}

// Why the folder of the ended attempt the start row `row` of `found` made stays, once unpushedHead found no commit the
// forge lacks: { why }, a fixed text with nothing a session wrote, or null when it goes. It goes only when its result is
// `merged`, or its result row says `clean`, or the attempt has neither a result nor an `ended` row, as a start given
// back or settled as an orphan. Every other end keeps it, an attempt offered kept commits too: a session that never
// took them may still have left files.
export function ledgerKeep({ found, row }) {
  const mine = (each) => each.key === row.key && each.attempt === row.attempt;
  const result = found.rows.findLast((each) => each.event === 'result' && mine(each));
  const ended = found.rows.some((each) => each.event === 'ended' && mine(each));
  if (result?.status === 'merged' || result?.tree === 'clean' || (!result && !ended)) return null;
  if (result?.tree === 'uncommitted') return { why: 'its session handed its result over with work left uncommitted' };
  if (result?.tree === 'unknown') return { why: 'its session\'s result could not tell whether work was left uncommitted' };
  if (!result) return { why: 'its session ended with no result that says its clone was left clean' };
  return { why: 'its result does not say its clone was left clean' };
}
