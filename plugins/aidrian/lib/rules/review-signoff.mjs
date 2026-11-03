// Bash rule: an agent never signs off a flow. `aidrian pr signoff` records the Human's sign-off under the git user's
// name, and the harness-config flow and every `signoff: "human"` flow wait for it, so an agent that ran it would sign
// in the Human's name. The review step prints the command for the Human, who runs it in their own shell (`!` in a
// Claude Code prompt, or another terminal). It denies `aidrian pr signoff` run as `aidrian`, or as a node script that
// is the plugin's cli.mjs or bin/aidrian, also inside a command substitution that runs; anything it cannot read runs.

import { aidrianArgs, commandLines, lexCommand, readInvocation } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';

export const REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, recorded under their name, and only the Human runs it. ' +
  'Stop at human_required, or at a disputed flow\'s overrule, show the Human the command the review step printed, and ask them to run it in their own ' +
  'shell (`!` in the prompt, or another terminal).';

// The deny reason for `command`, or null. On only inside a project.
export function check(command, { cwd = process.cwd() } = {}) {
  if (!findProject(cwd)) return null;
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const words = aidrianArgs(readInvocation(segment));
      if (words && words[0]?.text === 'pr' && words[1]?.text === 'signoff') return REASON;
    }
  }
  return null;
}
