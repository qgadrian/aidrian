// Bash rule: no `ln` that links a dependency folder, `node_modules` or `.venv`, into another copy of a project.
// A package manager run in the copy, such as `pnpm exec` with no lockfile there, installs through the link and changes
// the original's packages: a read-only reviewer that ran mutations in a scratch copy once moved the reviewed worktree to
// newer package versions that way. The deny names the allowed way to get dependencies: the project's worktree bootstrap
// (config.json `git.worktrees.bootstrap`), by its command when the project sets one, or its install from the lockfile, run
// in the worktree itself; and, for a scratch copy of a worktree under review, a copy of its own with that install.
// Agents that needed dependencies in a task worktree hit the rule again and again while the deny named the scratch copy alone.
// Read through wrappers, subshells, and the substitutions that run (commandLines, readInvocation); a link made from a
// script or an interpreter is out of reach, so this guards against accidents, not intent.

import { loadConfig } from '../config.mjs';
import { findProject } from '../project.mjs';
import { commandLines, lexCommand, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_DEPENDENCY_LINK';

// The folders a package manager installs into, matched as an operand's last path segment.
const DEPENDENCY_FOLDERS = new Set(['node_modules', '.venv']);

// The first sentence stays as it is: lessons and reports group this rule's denies by it. `bootstrap` is the project's
// worktree bootstrap command, or null when it sets none.
export const reason = (bootstrap) =>
  'Blocked: linking a dependency folder lets a package manager run in the copy install through the link and change the original\'s packages. ' +
  'To get dependencies in a worktree, install them in that worktree: ' +
  (bootstrap
    ? `run the project's worktree bootstrap there, \`${bootstrap}\` (config.json \`git.worktrees.bootstrap\`, which \`aidrian worktree new\` runs in each new worktree). `
    : 'run the project\'s install there from its lockfile, such as `pnpm install --frozen-lockfile --offline`; ' +
      'config.json `git.worktrees.bootstrap` can name it, so `aidrian worktree new` runs it in each new worktree. ') +
  'For a scratch copy of a worktree under review: `git -C <worktree> archive HEAD | tar -x -C <scratch>`, which brings the lockfile, ' +
  'then that install in the copy, offline, and run the mutation or test there. ' +
  'Never run a package manager install against a worktree under review. ' +
  `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
  "(agents must never set it on the user's behalf).";

// The project's worktree bootstrap command from the config of the project at `cwd`, or null.
function bootstrapAt(cwd) {
  try {
    const project = typeof cwd === 'string' ? findProject(cwd) : null;
    const command = project ? loadConfig(project).config.git?.worktrees?.bootstrap : null;
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  } catch {
    return null;
  }
}

// The last path segment of an operand, without trailing slashes: `../wt/node_modules/` is `node_modules`.
const lastSegment = (text) => text.replace(/\/+$/u, '').split('/').pop();

// The deny reason for `command`, or null.
export function check(command, { env = process.env, cwd } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const segment of commandLines(command).flatMap((line) => lexCommand(line))) {
    const { program, args } = readInvocation(segment);
    if (program !== 'ln') continue;
    // A variable before the folder, as in `"$WT/node_modules"`, still ends in the folder's literal name.
    const operands = args.filter((token) => !token.text.startsWith('-'));
    if (operands.some((token) => DEPENDENCY_FOLDERS.has(lastSegment(token.text)))) return reason(bootstrapAt(cwd));
  }
  return null;
}
