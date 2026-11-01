// The one way the plugin runs gh. `runGh` returns gh's stdout and throws when gh exits non-zero or cannot start, as
// execFileSync does, so a caller still reads `error.stdout`; `ghJson` parses that stdout. `cwd` picks the repository gh
// reads, and `exec` is the test seam.

import { execFileSync } from 'node:child_process';

// Stdout ceiling for every gh read. Node's synchronous default is 1 MB, and the head-commit read embeds every changed
// file's patch: an ordinary large pull request passed it. maxBuffer caps; it does not preallocate.
export const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// How long one gh call may take. A gh that waits on its sign-in or a stalled network would hang the command that ran it;
// it is stopped and the call fails. Far above git's (lib/git.mjs): gh goes over the network, and no hook runs it.
export const GH_TIMEOUT_MS = 60_000;
export const GH_EXEC_OPTIONS = Object.freeze({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GH_MAX_BUFFER_BYTES, timeout: GH_TIMEOUT_MS });

// gh's stdout, so no call site inherits the 1 MB default or waits forever. An overflow names the command and the limit;
// a timeout names the command and how long it waited.
// `timeoutMs` raises the limit for a call that is long by nature, such as an upload of many files.
export function runGh(args, { cwd, exec = execFileSync, timeoutMs = GH_TIMEOUT_MS } = {}) {
  try {
    return exec('gh', args, { ...GH_EXEC_OPTIONS, ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === GH_TIMEOUT_MS ? {} : { timeout: timeoutMs }) });
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      throw new Error(`gh ${args.join(' ')} did not finish in ${timeoutMs / 1000} s and was stopped. Check the network and \`gh auth status\`.`);
    }
    if (err?.code !== 'ENOBUFS') throw err;
    const mb = Math.round(GH_MAX_BUFFER_BYTES / 1024 / 1024);
    throw new Error(`gh ${args.join(' ')} wrote more than the ${mb} MB stdout ceiling. Raise GH_MAX_BUFFER_BYTES in lib/gh.mjs, or narrow the request.`);
  }
}

export const ghJson = (args, options) => JSON.parse(runGh(args, options));
