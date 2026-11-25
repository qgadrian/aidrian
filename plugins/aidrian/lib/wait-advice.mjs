// What a subagent is told of a long command: at its start (scripts/hook-session-start.mjs), and when it stops while one
// of its own background tasks still runs (scripts/hook-subagent-stop.mjs). Every number and every task type comes from
// the host's adapter: capabilities.foregroundLimit, waitCall, and taskOutput (docs/hooks.md#waiting-for-a-long-command).

import { binCommand } from './bin-command.mjs';
import { waitsFor } from './hosts/index.mjs';

// How long one wait call lasts, in words, on a host that declares one: each with a limit or a readable output does.
const callWords = ({ waitCall }) => ` in calls of at most ${waitCall.seconds} seconds each, with a tool timeout of ${waitCall.toolTimeout} seconds,`;
// When a wait is over. A task can end with no end line for the command to read, so the host's own word counts too.
const ENDED = 'until its first line starts with `ended`, or the host says the task ended';
// What is left once the command found no output: it finds none the next time either. `aidrian wait` says it too.
export const OTHER_CHECK = 'repeating the command cannot help: wait with another completion check you have, or report the wait as blocked';

// The start line of a subagent on `host`, or null on a host that declares no limit. "May": a host can move the commands
// of one kind of subagent only, and its start payload need not tell the kinds apart.
export function longCommandLine(host) {
  const { foregroundLimit, taskOutput } = host.capabilities;
  if (!foregroundLimit) return null;
  const wait = taskOutput ? `wait with \`${binCommand('aidrian')} wait <task id>\`` : 'wait for it';
  const until = taskOutput ? `${ENDED}. Exit 3 means the task still runs: wait again. Exit 2 means no output was found, and ${OTHER_CHECK}` : 'until it ends';
  return `Long commands: ${host.name} may move a command still running after ${foregroundLimit} seconds to the background, whatever timeout the call asks for; ` +
    `expect it for a long push or CI wait. Then ${wait}${callWords(host.capabilities)} ${until}.`;
}

// How to wait for `children`, running background tasks (lib/dispatch-rows.mjs runningChildren), on `host`.
export function waitWords(host, children) {
  const shells = children.filter((child) => waitsFor(host, child));
  const others = children.length > shells.length;
  const commands = shells.map((child) => `\`${binCommand('aidrian')} wait ${child.id}\``).join(', ');
  const other = shells.length ? 'any other task' : 'it';
  const poll = `poll ${other} with a foreground command whose loop ends on its own before the command's timeout, and repeat the call until it finishes`;
  const ways = [
    ...(shells.length ? [`run ${commands},${callWords(host.capabilities)} and repeat each while it exits 3, ${ENDED}; on exit 2 no output was found, and ${OTHER_CHECK}`] : []),
    ...(others ? [poll] : []),
  ];
  return `${ways.join('; ')}. `;
}

// What becomes of a command that waits too long on `host`.
export function movedWords(host) {
  const { foregroundLimit } = host.capabilities;
  if (!foregroundLimit) return 'A command that outlives its timeout is moved to the background and counts as one more task';
  return `A command that outlives its timeout is moved to the background and counts as one more task, and ${host.name} may move one still running after ${foregroundLimit} seconds whatever its timeout`;
}
