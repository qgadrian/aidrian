// `aidrian pr ready-wait PR [-R [HOST/]OWNER/REPO] [--timeout-sec N] [--interval-sec N]`: wait until the ready checks hold
// (rules/github/ready-checks.mjs holdReason) would let `gh pr ready PR` run, then say so. It marks nothing ready: the
// ready stays a `gh pr ready` call, which the ready hold and the ready checks hold judge.
// Right after an edit, `gh pr checks --watch` reads the run from before and returns at once, so it is no wait for the
// re-queued run to show; this command polls the same view the hold reads until it holds nothing. docs/hooks.md#ready-checks.
// Exit 0 clear (or not a draft), 2 still held when the timeout ends (run it again), 3 a usage error or a view gh cannot read.
// The default timeout is 840 s: a foreground Claude Code Bash call stops at 900 s.

import { forgeFor } from './forges/index.mjs';
import { holdReason, pullRef, VIEW } from './rules/github/ready-checks.mjs';

export const DEFAULTS = Object.freeze({ timeoutSec: 840, intervalSec: 5 });
const USAGE = 'usage: aidrian pr ready-wait PR [-R [HOST/]OWNER/REPO] [--timeout-sec N] [--interval-sec N]';

// The arguments as { target, repo, timeoutSec, intervalSec }, or { usage } for a problem.
export function parseReadyWaitArgs(argv) {
  const options = { target: null, repo: null, ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? argv[++i] ?? '';
    if (flag === '-R' || flag === '--repo') {
      options.repo = value();
      if (!/^[^/\s-][^/\s]*(?:\/[^/\s]+){1,2}$/u.test(options.repo)) return { usage: `${flag} needs [host/]owner/repo` };
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

// Runs the command; returns its exit code. `forgeAt` gives a forge whose gh calls stop after the `timeoutMs` it is given:
// each call gets the time left then, so the view and the edit-time read share the one deadline. It, `now`, and `sleep`
// are seams for tests.
export async function runReadyWait(argv, {
  forgeAt = (options) => forgeFor(undefined, options), now = Date.now, sleep = pause, log = console.log, error = console.error,
} = {}) {
  const options = parseReadyWaitArgs(argv);
  if (options.usage) {
    error(`aidrian pr ready-wait: ${options.usage}\n${USAGE}`);
    return 3;
  }
  const { target, repo, intervalSec, timeoutSec } = options;
  const elsewhere = Boolean(repo) || !/^\d+$/u.test(target);
  const deadline = now() + timeoutSec * 1000;
  const left = () => Math.floor(deadline - now());
  const call = (method) => (...args) => {
    if (left() <= 0) throw new Error(`no time left of the ${timeoutSec} s timeout`);
    return forgeAt({ timeoutMs: left(), killSignal: 'SIGKILL' })[method](...args);
  };
  const forge = { change: call('change'), changeEdits: call('changeEdits') };
  for (;;) {
    let view;
    try {
      view = forge.change(target, VIEW, { repo });
    } catch (failure) {
      error(`aidrian pr ready-wait: could not read pull request ${target} with gh (${String(failure?.message ?? failure).split('\n')[0]})`);
      return 3;
    }
    const n = Number.isInteger(view?.number) ? view.number : target;
    const ref = pullRef(view, elsewhere);
    if (view?.isDraft !== true) {
      log(`clear: pull request #${n} is not a draft, so marking it ready changes nothing`);
      return 0;
    }
    const reason = holdReason(view, forge, now, { elsewhere });
    if (reason === null) {
      log(`clear: no check on pull request #${n} is pending, and the run its last change re-queues has shown: mark it ready with \`gh pr ready ${ref}\``);
      return 0;
    }
    // Another poll only when its sleep ends with time left to read.
    if (left() <= intervalSec * 1000) {
      log(`held at the ${timeoutSec} s timeout: ${reason.replace(/^Blocked: /u, '')} Run \`aidrian pr ready-wait ${ref}\` again to keep waiting.`);
      return 2;
    }
    await sleep(intervalSec * 1000);
  }
}
