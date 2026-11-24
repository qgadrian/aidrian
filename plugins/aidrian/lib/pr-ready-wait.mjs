// `aidrian pr ready-wait PR [-R OWNER/REPO] [--timeout-sec N] [--interval-sec N]`: wait until the ready checks hold
// (rules/github/ready-checks.mjs holdReason) would let `gh pr ready PR` run, then say so. It marks nothing ready: the
// ready stays a `gh pr ready` call, which the ready hold and the ready checks hold judge.
// Right after an edit, `gh pr checks --watch` reads the run from before and returns at once, so it is no wait for the
// re-queued run to show; this command polls the same view the hold reads until it holds nothing. docs/hooks.md#ready-checks.
// Exit 0 clear (or not a draft), 2 still held when the timeout ends (run it again), 3 a usage error or a view gh cannot read.
// The default timeout is 840 s: a foreground Claude Code Bash call stops at 900 s.

import { forgeFor } from './forges/index.mjs';
import { holdReason, repoOf, VIEW } from './rules/github/ready-checks.mjs';

export const DEFAULTS = Object.freeze({ timeoutSec: 840, intervalSec: 5 });
const USAGE = 'usage: aidrian pr ready-wait PR [-R OWNER/REPO] [--timeout-sec N] [--interval-sec N]';

// The arguments as { target, repo, timeoutSec, intervalSec }, or { usage } for a problem.
export function parseReadyWaitArgs(argv) {
  const options = { target: null, repo: null, ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? argv[++i] ?? '';
    if (flag === '-R' || flag === '--repo') {
      options.repo = value();
      if (!/^[^/\s-][^/\s]*\/[^/\s]+$/u.test(options.repo)) return { usage: `${flag} needs owner/repo` };
    } else if (flag === '--timeout-sec' || flag === '--interval-sec') {
      const seconds = Number(value());
      if (!(Number.isFinite(seconds) && seconds > 0)) return { usage: `${flag} needs a number of seconds above 0` };
      options[flag === '--timeout-sec' ? 'timeoutSec' : 'intervalSec'] = seconds;
    } else if (options.target === null && /^(?:#?\d+|https?:\/\/\S+\/pull\/\d+\S*)$/u.test(arg)) {
      options.target = arg.replace(/^#/u, '');
    } else {
      return { usage: `unknown argument: ${arg}` };
    }
  }
  return options.target === null ? { usage: 'needs the pull request: a number or its URL' } : options;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The least time a read gets, so the poll after the last sleep still reads: the run ends at most this much past its timeout,
// twice over when the edit times are read too.
const READ_FLOOR_MS = 5_000;

// Runs the command; returns its exit code. `forgeAt` gives the forge for one poll with its gh calls stopped at the time
// left; it, `now`, and `sleep` are seams for tests.
export async function runReadyWait(argv, {
  forgeAt = (options) => forgeFor(undefined, options), now = Date.now, sleep = pause, log = console.log, error = console.error,
} = {}) {
  const options = parseReadyWaitArgs(argv);
  if (options.usage) {
    error(`aidrian pr ready-wait: ${options.usage}\n${USAGE}`);
    return 3;
  }
  const { target, intervalSec, timeoutSec } = options;
  const repo = repoOf(target, options.repo);
  const deadline = now() + timeoutSec * 1000;
  for (;;) {
    const forge = forgeAt({ timeoutMs: Math.max(READ_FLOOR_MS, Math.floor(deadline - now())), killSignal: 'SIGKILL' });
    let view;
    try {
      view = forge.change(target, VIEW, { repo: options.repo });
    } catch (failure) {
      error(`aidrian pr ready-wait: could not read pull request ${target} with gh (${String(failure?.message ?? failure).split('\n')[0]})`);
      return 3;
    }
    const n = Number.isInteger(view?.number) ? view.number : target;
    const ref = repo ? `${n} -R ${repo}` : n;
    if (view?.isDraft !== true) {
      log(`clear: pull request #${n} is not a draft, so marking it ready changes nothing`);
      return 0;
    }
    const reason = holdReason(view, forge, now, { repo });
    if (reason === null) {
      log(`clear: no check on pull request #${n} is pending, and the run its last change re-queues has shown: mark it ready with \`gh pr ready ${ref}\``);
      return 0;
    }
    const left = deadline - now();
    if (left <= 0) {
      log(`held after ${timeoutSec} s: ${reason.replace(/^Blocked: /u, '')} Run \`aidrian pr ready-wait ${ref}\` again to keep waiting.`);
      return 2;
    }
    await sleep(Math.min(intervalSec * 1000, left));
  }
}
