// Bash rule: a subagent never settles a decision. `aidrian decisions set` and `aidrian decisions undo` carry out the
// Human's answer on a decision an agent made alone, so a subagent that ran one would answer for the Human. The main
// session, which has no `agent_id`, runs them on the Human's word. It denies each command run as `aidrian`, or as a node
// script that is the plugin's cli.mjs or bin/aidrian, wherever it runs (shell-lex walkCommands): in a substitution,
// `sh -c`, `eval`, or a heredoc fed to a shell. A shell fed text the rule cannot read as commands, such as a pipe into
// `bash`, is refused when that text names the command. Anything else it cannot read runs. A host that sends no `agent_id`
// for a subagent passes it.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';

export const REASON =
  'Blocked: `aidrian decisions set` and `aidrian decisions undo` carry out the Human\'s answer on a decision, and a subagent never gives that answer. ' +
  'Return the decision in the handoff; the main session asks the Human and runs the command.';

// The deny reason for `command`, or null. On only inside a project, and only for a call with an `agent_id`.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '' || !findProject(cwd)) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /\bdecisions\s+(?:set|undo)\b/u.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (words && words[0]?.text === 'decisions' && ['set', 'undo'].includes(words[1]?.text)) return REASON;
  }
  return null;
}
