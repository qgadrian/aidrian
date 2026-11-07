// Bash rule: an agent never signs off a flow. `aidrian pr signoff` records the Human's sign-off under the git user's
// name, and the harness-config flow and every `signoff: "human"` flow wait for it, so an agent that ran it would sign
// in the Human's name. The review step prints the command for the Human, who runs it in their own shell (`!` in a
// Claude Code prompt, or another terminal). It denies `aidrian pr signoff` run as `aidrian`, or as a node script that
// is the plugin's cli.mjs or bin/aidrian, wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`,
// or a heredoc fed to a shell. A shell fed text the rule cannot read as commands, such as a pipe into `bash`, is refused
// when that text names a sign-off; anything else it cannot read runs. A sign-off with `--check` among its words is
// the dry run, which records nothing, and runs.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';

export const REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, recorded under their name, and only the Human runs it. ' +
  'Stop at human_required, or at a disputed flow\'s overrule, show the Human the command the review step printed, and ask them to run it in their own ' +
  'shell (`!` in the prompt, or another terminal). To try a command first, run it with `--check`, which records nothing.';

// The deny reason for `command`, or null. On only inside a project.
export function check(command, { cwd = process.cwd() } = {}) {
  if (!findProject(cwd)) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /\bpr\s+signoff\b/u.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    // `--check` records nothing (lib/review-gate.mjs runSignoff), and the command takes no value that starts with `--`,
    // so a word `--check` is always the dry run: an agent may try a command before it hands it to the Human.
    if (words && words[0]?.text === 'pr' && words[1]?.text === 'signoff' && !words.some((word) => word.text === '--check')) return REASON;
  }
  return null;
}
