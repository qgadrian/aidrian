// Bash rule: an agent never signs off a flow. `aidrian pr signoff` records the Human's sign-off under the git user's
// name, and the harness-config flow and every `signoff: "human"` flow wait for it, so an agent that ran it would sign
// in the Human's name. The review step prints the command for the Human, who runs it in their own shell (`!` in a
// Claude Code prompt, or another terminal); the short form `aidrian pr signoff <PR> --last`, which the message names,
// is the Human's too and denied alike. It denies `aidrian pr signoff` run as `aidrian`, or as a node script that
// is the plugin's cli.mjs or bin/aidrian, wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`,
// or a heredoc fed to a shell. A shell fed text the rule cannot read as commands, such as a pipe into `bash`, is refused
// when that text names a sign-off; anything else it cannot read runs. A sign-off with a plain `--check` among its words
// is the dry run, which records nothing, and runs; a `--check` the shell builds at run time, such as one glued to a
// substitution, is no dry run. An `aidrian` whose subcommand the shell builds at run time (`aidrian "$@"`) is denied
// too, since it may be a sign-off.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';

export const REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, recorded under their name, and only the Human runs it, `--last` included. ' +
  'Stop, and hand the Human a command for their own shell (`!` in the prompt, or another terminal). ' +
  'At human_required naming one flow, once `aidrian pr signoff <PR> --last --check` exits 0, hand over the short form `aidrian pr signoff <PR> --last`, ' +
  'short enough to type from a phone, naming the flow and short head that `--check` printed. ' +
  'At a disputed flow\'s overrule, or any other stop, hand over the command the review step printed. ' +
  'To try a command first, run it with `--check`, which records nothing.';

// The deny reason for `command`, or null. On only inside a project.
export function check(command, { cwd = process.cwd() } = {}) {
  if (!findProject(cwd)) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /\bpr\s+signoff\b/u.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (!words) continue;
    // A subcommand the shell builds at run time cannot be read, so it may be a sign-off.
    if (words[0]?.dynamic || (words[0]?.text === 'pr' && words[1]?.dynamic)) return REASON;
    // `--check` records nothing (lib/review-gate.mjs runSignoff), and the command takes no value that starts with `--`,
    // so a plain word `--check` is always the dry run: an agent may try a command before it hands it to the Human. A
    // dynamic word is not: `printf …`--check may expand to a value that swallows it, or to nothing.
    if (words[0]?.text === 'pr' && words[1]?.text === 'signoff' && !words.some((word) => !word.dynamic && word.text === '--check')) return REASON;
  }
  return null;
}
