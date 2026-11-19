// Bash rule: no `ln` that links a dependency folder, `node_modules` or `.venv`, into another copy of a project.
// A package manager run in the copy, such as `pnpm exec` with no lockfile there, installs through the link and changes
// the original's packages: a read-only reviewer that ran mutations in a scratch copy once moved the reviewed worktree to
// newer package versions that way. The deny names the way to get dependencies in the agent's own task worktree: install
// there, where `aidrian worktree new` already runs the project's bootstrap. For a worktree under review it names no install
// at all: a reviewer installs nothing, and reviews read-only or reports that a mutation or test run needs the pull
// request's own task worktree. A pull request controls its tree, its config's bootstrap, and its package manager's hooks,
// so any install or bootstrap the deny pointed a reviewer to would run that pull request's code; an earlier deny quoted the
// checkout's bootstrap command, and one after it advised an install in a scratch copy of the reviewed tree.
// Agents that needed dependencies in a task worktree hit the rule again and again while the deny named the scratch copy alone.
// Read through wrappers, subshells, and the substitutions that run (commandLines, readInvocation); a link made from a
// script or an interpreter is out of reach, so this guards against accidents, not intent.

import { commandLines, lexCommand, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_DEPENDENCY_LINK';

// The folders a package manager installs into, matched as an operand's last path segment.
const DEPENDENCY_FOLDERS = new Set(['node_modules', '.venv']);

// The first sentence stays as it is: lessons and reports group this rule's denies by it.
export const REASON =
  'Blocked: linking a dependency folder lets a package manager run in the copy install through the link and change the original\'s packages. ' +
  'For dependencies in your own task worktree, install them in that worktree: `aidrian worktree new` already runs the ' +
  'project\'s bootstrap there. ' +
  'In a worktree under review, install nothing, there or in any copy of it: review it read-only, or report that the ' +
  'mutation or test run needs the pull request\'s own task worktree, and leave that run to its owner. ' +
  `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
  "(agents must never set it on the user's behalf).";

// The last path segment of an operand, without trailing slashes: `../wt/node_modules/` is `node_modules`.
const lastSegment = (text) => text.replace(/\/+$/u, '').split('/').pop();

// The deny reason for `command`, or null.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const segment of commandLines(command).flatMap((line) => lexCommand(line))) {
    const { program, args } = readInvocation(segment);
    if (program !== 'ln') continue;
    // A variable before the folder, as in `"$WT/node_modules"`, still ends in the folder's literal name.
    const operands = args.filter((token) => !token.text.startsWith('-'));
    if (operands.some((token) => DEPENDENCY_FOLDERS.has(lastSegment(token.text)))) return REASON;
  }
  return null;
}
