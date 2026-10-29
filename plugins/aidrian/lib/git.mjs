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

// The main checkout: the folder that holds the git common dir. Every worktree of the repository shares it.
export function mainRoot(cwd) {
  const commonDir = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir && path.dirname(commonDir);
}

// The top folder of the checkout that `cwd` is in: the main checkout or one of its worktrees.
export function currentRoot(cwd) {
  return firstLine(['rev-parse', '--show-toplevel'], cwd);
}

// Both at once, in one git call: { main, current }, or null. They differ inside a worktree.
export function checkoutRoots(cwd) {
  const lines = firstLine(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], cwd)?.split('\n');
  return lines?.length === 2 ? { main: path.dirname(lines[0]), current: lines[1] } : null;
}

// Whether git ignores `file` (absolute, or relative to `root`).
export function isIgnored(root, file) {
  const { status } = runGit(['check-ignore', '-q', '--', file], root);
  return status === 0 ? true : status === 1 ? false : null;
}
