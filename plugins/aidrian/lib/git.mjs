// Small git helpers for hooks and commands. Each returns null when git cannot answer, so the caller decides whether to
// fail open or closed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { isDirectory, isEntry, isFile } from './fs.mjs';

// How long one git call may take. Hooks run git on every tool call, inside the host's hook timeout; a git that hangs, on
// a stalled file system or an fsmonitor, is stopped and counts as git not answering. Once one call is stopped, the later
// ones in the same process do not wait again, so a hook pays the timeout once. `options.timeout` overrides it, and 0
// waits as long as git takes.
export const GIT_TIMEOUT_MS = 2000;
let stalled = null;
// The signal a git past its limit gets when the call names none: git's own SIGTERM, which lets it remove a lock it holds,
// or SIGKILL inside killingGit.
let killSignal;

// `read()`, with every git call it makes that names no signal killed outright at its limit: spawnSync waits for a child
// that ignores SIGTERM. Only for reads that hold no lock, such as `aidrian session snapshot`'s.
export function killingGit(read) {
  const before = killSignal;
  killSignal = 'SIGKILL';
  try {
    return read();
  } finally {
    killSignal = before;
  }
}

// The raw spawn result: { status, stdout, stderr, error }. Some git commands use exit 1 as an answer, not a failure.
// A git stopped by the timeout, and every later call that does not set its own timeout, has `status` null.
export function runGit(args, cwd, options = {}) {
  if (stalled && options.timeout === undefined) return stalled;
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...(killSignal ? { killSignal } : {}), ...options });
  if (result.error?.code === 'ETIMEDOUT' && options.timeout === undefined) stalled = { status: null, stdout: '', stderr: '', error: result.error };
  return result;
}

function firstLine(args, cwd, options) {
  const result = runGit(args, cwd, options);
  return result.status === 0 ? result.stdout.trim() : null;
}

// The main checkout, which every worktree of the repository shares. `options` are runGit's.
export function mainRoot(cwd, options) {
  return checkoutRoots(cwd, options)?.main ?? null;
}

// The top folder of the checkout that `cwd` is in: the main checkout or one of its worktrees.
export function currentRoot(cwd) {
  return firstLine(['rev-parse', '--show-toplevel'], cwd);
}

// The tree of the commit HEAD names in the checkout that `cwd` is in, or of the branch `branch` when given, or null:
// git cannot say, or `branch` is no branch name by git's own rules, such as one that reads as a revision.
export function treeOf(cwd, branch = null) {
  // Git's own answer with only its line end cut: a name may end in a character trim() would drop, such as a no-break space.
  const checked = branch === null ? null : runGit(['check-ref-format', '--branch', branch], cwd);
  if (checked && (checked.status !== 0 || checked.stdout.replace(/\n$/u, '') !== branch)) return null;
  const ref = branch === null ? 'HEAD' : `refs/heads/${branch}`;
  return firstLine(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], cwd);
}

// `cwd` from the top of its checkout, with a trailing slash: '' at the top, or when git cannot answer.
export function showPrefix(cwd) {
  return firstLine(['rev-parse', '--show-prefix'], cwd) ?? '';
}

// Both at once, in one git call: { main, current }, or null. They differ inside a linked worktree.
// In the main checkout, its own git folder is the common one, so the main checkout is the current one, wherever
// `git init --separate-git-dir` put that folder. A linked worktree has only the common folder's place to go by: the
// main checkout holds it as `.git`. A separate git folder records no main checkout (`git worktree list` names the
// folder itself), so from a linked worktree of such a repository `main` is that folder's parent.
export function checkoutRoots(cwd, options) {
  const lines = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'], cwd, options)?.split('\n');
  if (lines?.length !== 3) return null;
  const [commonDir, gitDir, current] = lines;
  return { main: gitDir === commonDir ? current : path.dirname(commonDir), current };
}

// The top folder of every checkout of the repository `cwd` is in: the checkout `cwd` is in, then each one `git worktree
// list` names that holds a work tree, so a bare entry, as a git folder kept apart lists itself, and a worktree whose
// folder is gone are dropped. Each listed path is exactly as git prints it. [] only when no git is installed, or `cwd`
// is outside any repository: no folder at or above it holds a `.git`. Inside a repository every failure is null, a
// stopped git and a non-zero exit included: the list always names the main checkout, so a failed one leaves the
// checkouts unknown, and a caller that keeps files out of every checkout refuses. So is a git kept from the repository by
// GIT_CEILING_DIRECTORIES: the disk still shows a `.git` at or above `cwd`, so the list fails closed. An environment that
// sets GIT_DIR, GIT_WORK_TREE, or GIT_COMMON_DIR points git at a repository other than the one at `cwd`, or at another
// work tree of it, so its list would be wrong, not unknown: null too. `read` gives each git call's options, and its
// `env`, when given, is the environment that counts.
export function repositoryCheckouts(cwd, read = () => undefined) {
  const env = read()?.env ?? process.env;
  if (REDIRECTS.some((name) => env[name] !== undefined)) return null;
  const listed = runGit(['worktree', 'list', '--porcelain'], cwd, read());
  if (listed.error?.code === 'ENOENT') return [];
  if (listed.status !== 0) return underGit(cwd) ? null : [];
  const roots = checkoutRoots(cwd, read());
  if (!roots) return null;
  const entries = listed.stdout.split('\n\n').filter((entry) => !entry.split('\n').includes('bare'));
  // Each path is the rest of its line, whatever that line holds.
  const paths = entries.map((entry) => entry.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length));
  return [...new Set([roots.current, ...paths.filter((dir) => dir && holdsCheckout(dir))])];
}

// The variables that point git away from the repository its folder holds.
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];

// Whether git keeps a work tree at `dir`: a `.git` file or folder is there.
export const holdsCheckout = (dir) => isFile(path.join(dir, '.git')) || isDirectory(path.join(dir, '.git'));

// Whether `dir` or a folder above it holds a `.git` entry, where git looks for a repository. It reads the disk alone, so
// it answers when git does not.
function underGit(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (isEntry(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

// Whether git ignores `file` (absolute, or relative to `root`).
export function isIgnored(root, file) {
  const { status } = runGit(['check-ignore', '-q', '--', file], root);
  return status === 0 ? true : status === 1 ? false : null;
}
