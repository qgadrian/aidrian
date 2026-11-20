// Bash rule: a subagent never starts a project run. `aidrian project init` records the session that runs it as the run's
// driver (lib/project-run.mjs), and a subagent's shell carries the main session's id, so the command alone cannot tell
// them apart. The main session, which has no `agent_id`, runs it. It denies the command run as `aidrian`, or as a node
// script that is the plugin's cli.mjs or bin/aidrian, wherever it runs (shell-lex walkCommands): in a substitution,
// `sh -c`, `eval`, or a heredoc fed to a shell. A shell fed text the rule cannot read as commands, such as a pipe into
// `bash`, is refused when that text names the command. Anything else it cannot read runs. A host that sends no `agent_id`
// for a subagent passes it, as lib/rules/decisions-set.mjs does.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';

export const REASON =
  'Blocked: `aidrian project init` makes the session that runs it the driver of a project run, and a subagent never drives one. ' +
  'Return the snapshot input in the handoff; the main session runs init.';

// The deny reason for `command`, or null. On only inside a project, and only for a call with an `agent_id`.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  if (typeof input?.agent_id !== 'string' || input.agent_id === '' || !findProject(cwd)) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /\bproject\s+init\b/u.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (words && words[0]?.text === 'project' && words[1]?.text === 'init') return REASON;
  }
  return null;
}
