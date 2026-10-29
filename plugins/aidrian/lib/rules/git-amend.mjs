// Bash rule: no `git commit --amend`. An agent sharing a branch or worktree with another may rewrite a commit the other
// already built on; a new commit is always safe. A literal `--amend` before `--` denies; `--amend` in message text, after
// `--`, or behind a dynamic token does not.

import { lexCommand, readGit } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_GIT_AMEND';

const REASON =
  'Blocked: `git commit --amend` rewrites the branch tip, and another agent working on this branch may already have built on it. ' +
  'Make a new commit instead. ' +
  `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
  "(agents must never set it on the user's behalf).";

// The deny reason for `command`, or null.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const segment of lexCommand(command)) {
    const git = readGit(segment);
    if (git?.subcommand !== 'commit') continue;
    for (const token of git.rest) {
      if (token.dynamic) continue;
      if (token.text === '--') break;
      if (token.text === '--amend') return REASON;
    }
  }
  return null;
}
