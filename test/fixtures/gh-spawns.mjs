// A preload for a command a test runs as a program, `node --import <this file> <cli>`: each gh call the command makes is
// recorded in the parent, before gh is spawned, as one JSON line { args, timeout, killSignal, at } in the file
// GH_SPAWN_LOG names. A gh that a short deadline stops before it starts is still counted, and the test reads the time
// limit and the signal the command asked for. When the call ends, one JSON line { status, signal } goes to the file
// `<GH_SPAWN_LOG>.exits`: the exit status and the signal that ended gh, as the spawn's result reports them, so a test
// reads the signal delivered, not only the one asked for. The forge runs gh through node:child_process execFileSync
// (lib/forges/github-cli.mjs runGh), so this wraps it and updates the builtin's ES module bindings.
// node --test also runs every file under test/ as a test file: with no GH_SPAWN_LOG it changes nothing, and it has no tests.

import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.GH_SPAWN_LOG;
if (log) {
  const real = childProcess.execFileSync;
  const exited = (status, signal) => appendFileSync(`${log}.exits`, `${JSON.stringify({ status: status ?? null, signal: signal ?? null })}\n`);
  childProcess.execFileSync = (file, args, options) => {
    if (file !== 'gh') return real(file, args, options);
    appendFileSync(log, `${JSON.stringify({ args, timeout: options?.timeout ?? null, killSignal: options?.killSignal ?? null, at: Date.now() })}\n`);
    try {
      const out = real(file, args, options);
      exited(0, null);
      return out;
    } catch (error) {
      exited(error?.status, error?.signal);
      throw error;
    }
  };
  syncBuiltinESMExports();
}
