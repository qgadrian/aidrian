// A preload for a hook or command a test runs as a program, `node --import <this file> <script>`: each wait the process
// starts, a `setTimeout` of node:timers/promises, as lib/handoff-continue.mjs takeCleared sleeps, or an Atomics.wait,
// as lib/fs.mjs pauseSync blocks a lock's poll, is recorded as one JSON line { kind, ms } in the file WAIT_LOG names,
// before it waits. A test then tells a process that waited from one that did not by the count, which a loaded machine
// does not change, instead of by its wall time, which it does.
// node --test also runs every file under test/ as a test file: with no WAIT_LOG it changes nothing, and it has no tests.

import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';

const log = process.env.WAIT_LOG;
if (log) {
  const note = (kind, ms) => appendFileSync(log, `${JSON.stringify({ kind, ms: ms ?? null })}\n`);
  const sleep = timers.setTimeout;
  timers.setTimeout = (ms, ...rest) => {
    note('sleep', ms);
    return sleep(ms, ...rest);
  };
  syncBuiltinESMExports();
  const wait = Atomics.wait;
  Atomics.wait = (array, index, value, ms) => {
    note('atomics', ms);
    return wait(array, index, value, ms);
  };
}
