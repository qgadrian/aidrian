// Bash rule: no skipping git hooks. Denies a hook-running git command (commit, push, merge) that carries `--no-verify`,
// `-n` on commit (alone or in a bundle such as `-an`), a `-c core.hooksPath=…` override, or a `HUSKY=0|false|` assignment.
// There is no override: a project that wants an exception changes its hooks, not this rule.

import { lexCommand, readGit } from '../shell-lex.mjs';

// The subcommands that run a hook. `-n` means --no-verify on commit only: it is --dry-run on push and --no-stat on merge.
const HOOK_RUNNING = new Set(['commit', 'push', 'merge']);
// `git commit` options whose value is the next token, so `-m "-n"` is a message, not a flag.
const COMMIT_VALUE_SHORTS = new Set(['-m', '-c', '-C', '-F', '-t']);
const HUSKY_OFF = new Set(['0', 'false', '']);

export const REASON =
  'Blocked: this skips a git hook. A failing hook is a verdict, not a flake: fix the cause, and if the failure is unrelated ' +
  'to your change, report it and wait for instructions. There is no agent-side override for this rule.';

// The deny reason for `command`, or null.
export function check(command) {
  for (const segment of lexCommand(command)) {
    const git = readGit(segment);
    if (!git || !HOOK_RUNNING.has(git.subcommand)) continue;
    if (skipsHooks(git.rest, git.subcommand) || overridesHooksPath(git.globals) || disablesHusky(segment)) return REASON;
  }
  return null;
}

function skipsHooks(rest, subcommand) {
  for (let i = 0; i < rest.length; i += 1) {
    const { text, dynamic } = rest[i];
    if (dynamic) continue;
    if (text === '--') return false;
    if (text === '--no-verify') return true;
    if (subcommand !== 'commit') continue;
    if (COMMIT_VALUE_SHORTS.has(text)) i += 1;
    else if (/^-[A-Za-z]+$/u.test(text) && text.includes('n')) return true;
  }
  return false;
}

function overridesHooksPath(globals) {
  return globals.some(({ text, dynamic }) => !dynamic && /^(-c)?core\.hooksPath=/u.test(text));
}

// Read from the raw segment: readInvocation drops leading assignments.
function disablesHusky(segment) {
  return segment.some(({ text, dynamic, operator }) => !dynamic && !operator && text.startsWith('HUSKY=') && HUSKY_OFF.has(text.slice(6)));
}
