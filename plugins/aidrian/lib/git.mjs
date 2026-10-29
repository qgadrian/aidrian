// Small git helpers for hooks and commands. Each returns null when git cannot answer, so the caller decides whether to
// fail open or closed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The raw spawn result: { status, stdout, stderr, error }. Some git commands use exit 1 as an answer, not a failure.
export function runGit(args, cwd, options = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
}

function firstLine(args, cwd) {
  const result = runGit(args, cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

// The main checkout, which every worktree of the repository shares.
export function mainRoot(cwd) {
  return checkoutRoots(cwd)?.main ?? null;
}

// The top folder of the checkout that `cwd` is in: the main checkout or one of its worktrees.
export function currentRoot(cwd) {
  return firstLine(['rev-parse', '--show-toplevel'], cwd);
}

// Both at once, in one git call: { main, current }, or null. They differ inside a linked worktree.
// In the main checkout, its own git folder is the common one, so the main checkout is the current one, wherever
// `git init --separate-git-dir` put that folder. A linked worktree has only the common folder's place to go by: the
// main checkout holds it as `.git`. A separate git folder records no main checkout (`git worktree list` names the
// folder itself), so from a linked worktree of such a repository `main` is that folder's parent.
export function checkoutRoots(cwd) {
  const lines = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'], cwd)?.split('\n');
  if (lines?.length !== 3) return null;
  const [commonDir, gitDir, current] = lines;
  return { main: gitDir === commonDir ? current : path.dirname(commonDir), current };
}

// Whether git ignores `file` (absolute, or relative to `root`).
export function isIgnored(root, file) {
  const { status } = runGit(['check-ignore', '-q', '--', file], root);
  return status === 0 ? true : status === 1 ? false : null;
}
