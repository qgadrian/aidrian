// The project's own review code, run as the base branch has it: a temporary worktree of the base tip, and the plan
// command and review.visual hooks that run inside one. lib/review/run.mjs re-exports DEPENDENCY_DIRS and stderrTail.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isDirectory } from '../fs.mjs';
import { currentRoot, runGit, showPrefix } from '../git.mjs';
import { validatePlan } from './plan.mjs';

// The folders of installed dependencies linked into a base worktree.
export const DEPENDENCY_DIRS = Object.freeze(['node_modules', 'vendor', '.venv', 'venv']);

// A temporary worktree of the base tip, for running the project's own review code (a plan command, an exec
// reviewer) as the base branch has it: a pull request that edits that code cannot run its own version. The worktree
// shares the repository's objects, so the code can still read the head with git. `use(dir)` runs inside it, with `dir`
// the project's folder in that checkout, as the project's config paths start there.
export async function inBaseWorktree(root, baseTip, use) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-base-'));
  const tree = path.join(dir, 'base');
  const added = runGit(['worktree', 'add', '--detach', '--quiet', tree, baseTip], root, { timeout: 60_000 });
  if (added.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not check out the base to run the project's review code: ${(added.stderr || '').trim()}`);
  }
  // The checkout's installed dependencies, linked in, so base code that imports them runs. They are the checkout's
  // install, not the base's: the code is pinned to the base, its packages to what this machine has. A project below the
  // repository root gets its own folder's and the checkout top's, for packages a monorepo hoists.
  const projectTree = path.join(tree, showPrefix(root));
  const top = currentRoot(root) ?? root;
  for (const [from, to] of [[root, projectTree], ...(top === root ? [] : [[top, tree]])]) {
    for (const name of DEPENDENCY_DIRS) {
      if (isDirectory(path.join(from, name)) && !existsSync(path.join(to, name))) symlinkSync(path.join(from, name), path.join(to, name));
    }
  }
  try {
    return await use(projectTree);
  } finally {
    runGit(['worktree', 'remove', '--force', tree], root, { timeout: 60_000 });
    rmSync(dir, { recursive: true, force: true });
  }
}

// The part of a failed command's stderr worth showing: its last few non-empty lines, cut to a length, with anything
// shaped like a token masked. A runtime's own last line (Node prints its version) would otherwise hide the cause.
export function stderrTail(stderr, { lines = 6, chars = 800 } = {}) {
  const kept = String(stderr ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '').slice(-lines).join(' | ');
  const masked = kept
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}/gu, '[redacted]');
  return masked.length > chars ? `...${masked.slice(-chars)}` : masked;
}

// A planCommand's plan: it reads { base, head, changes } on stdin and prints a plan. It runs in a worktree of the
// base, with an env isolated like a reviewer's.
export function runPlanCommand(command, input, { root, env, baseTip }) {
  return inBaseWorktree(root, baseTip, (tree) => {
    const result = spawnSync('sh', ['-c', command], { cwd: tree, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`review.planCommand failed: ${stderrTail(result.stderr) || (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)}`);
    let plan;
    try {
      plan = JSON.parse(result.stdout);
    } catch {
      throw new Error('review.planCommand did not print a JSON plan');
    }
    const problems = validatePlan(plan);
    if (problems.length) throw new Error(`review.planCommand printed a bad plan: ${problems.join('; ')}`);
    return plan;
  });
}

// A review.visual hook (login, preview) run in the base checkout `tree`: `input` on stdin, stdout returned. A failure
// throws with the tail of its stderr.
export function runHook(tree, command, input, env) {
  const result = spawnSync('sh', ['-c', command], { cwd: tree, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(stderrTail(result.stderr) || (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`));
  return result.stdout;
}
