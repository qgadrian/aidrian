// `aidrian wait TASK_ID [--max-wait SECONDS]`: waits, in one call, for a background shell of the session the command
// runs in to end, and prints `ended` or `running`, its exit code, and the end of its output (docs/hooks.md#waiting-for-a-long-command).
// Exit 0 when it ended, whatever its own exit code; 3 when it still runs; 2 on a task the host has no output of in this
// session, or a host with no way to read one; 1 on wrong arguments.
// The host's adapter alone knows where the output is and how its end shows (capabilities.taskOutput). It only reads.

import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { HIDDEN } from './hidden-text.mjs';
import { detectHost, TASK_ID } from './hosts/index.mjs';
import { usageLines } from './usage.mjs';
import { OTHER_CHECK } from './wait-advice.mjs';

const USAGE = 'TASK_ID [--max-wait SECONDS]';
const POLL_MS = 1000;
const LINES = 40;
// How each line of the task's output starts, so none reads as a line of the command's own.
const OUTPUT = '| ';

export const commands = {
  wait: {
    usage: USAGE,
    about: 'wait for a command the host moved to the background in this session, for as long as one call may last; exit 0 when it ended, 3 when it still runs',
    async run(args) {
      const { status, out, err } = await waitForTask(args);
      for (const line of out) console.log(line);
      for (const line of err) console.error(line);
      return status;
    },
  },
};

const failed = (status, problem) => ({ status, out: [], err: [`aidrian wait: ${problem}`] });

// The command's { status, out, err }, its lines. `host`, `now`, and `pause` are a test's. The wait is timed on a clock a
// change of the wall clock does not move, so it stays under the host's limit.
export async function waitForTask(args, { env = process.env, host = detectHost({ env }), now = () => performance.now(), pause = sleep } = {}) {
  const started = now();
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'max-wait': { type: 'string' } } });
  if (positionals.length !== 1) return { status: 1, out: [], err: usageLines('wait', USAGE, 'usage: ') };
  const [id] = positionals;
  const { taskOutput, waitCall } = host.capabilities;
  if (!taskOutput) return failed(2, `${host.name} gives a command no way to read a background task; ${OTHER_CHECK}`);
  const given = values['max-wait'] ?? String(waitCall.seconds);
  if (!/^\d{1,4}$/u.test(given) || Number(given) > waitCall.seconds) return failed(1, `--max-wait takes whole seconds from 0 to ${waitCall.seconds}`);
  if (!TASK_ID.test(id)) return failed(2, 'a task id holds only letters, digits, _, and -');
  const file = taskOutput.find({ id, env });
  if (file === null) return failed(2, `no output of a background task ${id} in this session; ${OTHER_CHECK}`);
  const until = started + Number(given) * 1000;
  for (;;) {
    const task = taskOutput.read(file);
    if (task === null) return failed(2, `the output of background task ${id} can no longer be read; ${OTHER_CHECK}`);
    const left = until - now();
    if (task.ended || left <= 0) return { status: task.ended ? 0 : 3, out: report(id, task), err: [] };
    await pause(Math.min(POLL_MS, left));
  }
}

// The lines a wait prints: the task's state, its exit code once it ended, and the last LINES lines of its output, which
// is untrusted: each starts with OUTPUT and holds no hidden character but a tab.
function report(id, task) {
  const text = task.output.replace(HIDDEN, (char) => (char === '\t' || char === '\n' ? char : '')).trimEnd();
  const lines = text === '' ? [] : text.split('\n').slice(-LINES).map((line) => `${OUTPUT}${line}`);
  const state = task.ended ? [`ended ${id}`, exitLine(task)] : [`running ${id}: run the command again to keep waiting, unless the host says the task ended`];
  return [...state, lines.length ? `last lines of its output (at most ${LINES}):` : 'no output yet', ...lines];
}

function exitLine({ killed, exitCode }) {
  if (killed) return 'exit code: none, it was killed';
  return `exit code: ${exitCode ?? 'unknown'}`;
}
