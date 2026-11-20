// A preload for a command a test runs as a program, `node --import <this file> <cli>`: each gh call the command makes is
// recorded in the parent, before gh is spawned, as one JSON line { args, timeout, killSignal, at } in the file
// GH_SPAWN_LOG names. A gh that a short deadline stops before it starts is still counted, and the test reads the time
// limit and the signal the command asked for. The forge runs gh through node:child_process execFileSync
// (lib/forges/github-cli.mjs runGh), so this wraps it and updates the builtin's ES module bindings.
// node --test also runs every file under test/ as a test file: with no GH_SPAWN_LOG it changes nothing, and it has no tests.

import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.GH_SPAWN_LOG;
if (log) {
  const real = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, options) => {
    if (file === 'gh') {
      appendFileSync(log, `${JSON.stringify({ args, timeout: options?.timeout ?? null, killSignal: options?.killSignal ?? null, at: Date.now() })}\n`);
    }
    return real(file, args, options);
  };
  syncBuiltinESMExports();
}
