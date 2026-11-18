// What every host adapter that runs its host's own command shares: the run of a command in spawnSync's shape, which a
// test replaces, and the lookup of a program on the absolute folders of PATH alone, since an empty or relative entry
// would run whatever program of that name the current folder holds. It reads no file when loaded.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

// Runs `command` with `args`, in `cwd`, at most `timeout` milliseconds, under `env` (this process's by default): the
// spawnSync result, with text output.
export const runCommand = (command, args, { cwd, timeout, env } = {}) => spawnSync(command, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });

// The first executable regular file of `names` in the absolute folders of `env.PATH`, in order, or null.
export function programOnPath(env, names) {
  const folders = String(env?.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '' && path.isAbsolute(dir));
  for (const file of folders.flatMap((dir) => names.map((name) => path.join(dir, name)))) {
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not there, or not executable: the next folder.
    }
  }
  return null;
}

// A program's names on this platform: `name`, or its .exe and .cmd forms on Windows.
export const programNames = (name) => (process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name]);
