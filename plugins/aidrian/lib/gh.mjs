// The one way the plugin runs gh. `runGh` returns gh's stdout and throws when gh exits non-zero or cannot start, as
// execFileSync does, so a caller still reads `error.stdout`; `ghJson` parses that stdout. `cwd` picks the repository gh
// reads, and `exec` is the test seam.

import { execFileSync } from 'node:child_process';

// Stdout ceiling for every gh read. Node's synchronous default is 1 MB, and the head-commit read embeds every changed
// file's patch: an ordinary large pull request passed it. maxBuffer caps; it does not preallocate.
export const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const GH_EXEC_OPTIONS = Object.freeze({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GH_MAX_BUFFER_BYTES });

// gh's stdout, so no call site inherits the 1 MB default. An overflow names the command and the limit.
export function runGh(args, { cwd, exec = execFileSync } = {}) {
  try {
    return exec('gh', args, cwd === undefined ? GH_EXEC_OPTIONS : { ...GH_EXEC_OPTIONS, cwd });
  } catch (err) {
    if (err?.code !== 'ENOBUFS') throw err;
    const mb = Math.round(GH_MAX_BUFFER_BYTES / 1024 / 1024);
    throw new Error(`gh ${args.join(' ')} wrote more than the ${mb} MB stdout ceiling. Raise GH_MAX_BUFFER_BYTES in lib/gh.mjs, or narrow the request.`);
  }
}

export const ghJson = (args, options) => JSON.parse(runGh(args, options));
