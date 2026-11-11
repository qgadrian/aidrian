// Bash rule: no `ln` that links a dependency folder, `node_modules` or `.venv`, into another copy of a project.
// A package manager run in the copy, such as `pnpm exec` with no lockfile there, installs through the link and changes
// the original's packages: a read-only reviewer that ran mutations in a scratch copy once moved the reviewed worktree to
// newer package versions that way. The deny names the copy that keeps the original intact: a worktree of its own, with
// the project's install from the lockfile, offline.
// Read through wrappers, subshells, and the substitutions that run (commandLines, readInvocation); a link made from a
// script or an interpreter is out of reach, so this guards against accidents, not intent.

import { commandLines, lexCommand, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_DEPENDENCY_LINK';

// The folders a package manager installs into, matched as an operand's last path segment.
const DEPENDENCY_FOLDERS = new Set(['node_modules', '.venv']);

// The first sentence stays as it is: lessons and reports group this rule's denies by it.
export const REASON =
  'Blocked: linking a dependency folder lets a package manager run in the copy install through the link and change the original\'s packages. ' +
  'Give the copy its own install: `git -C <worktree> archive HEAD | tar -x -C <scratch>`, which brings the lockfile, then the ' +
  'project\'s install in the copy from that lockfile, offline, such as `pnpm install --frozen-lockfile --offline`, and run the mutation or test there. ' +
  'Never run a package manager install against a worktree under review. ' +
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
