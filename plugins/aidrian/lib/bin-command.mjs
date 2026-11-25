// How the plugin's own commands are named to a session: in a start line, and in a reason a hook sends back.

import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';

const BIN = path.resolve(import.meta.dirname, '../bin');

function real(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

// The first folder on PATH that holds an executable `name`, the one a bare `name` runs, as { dir, own }: `own` is whether
// it is this copy's bin/, and not another copy of the plugin, such as an installed release. null when none holds one.
export function firstOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      accessSync(path.join(dir, name), constants.X_OK);
    } catch {
      continue;
    }
    return { dir, own: real(dir) === real(BIN) };
  }
  return null;
}

// This copy's command `name` by its full path, as a shell takes it.
export function commandPath(name) {
  const full = path.join(BIN, name);
  return /\s/.test(full) ? `"${full}"` : full;
}

// The bare name when it runs this copy's command; the full path otherwise, so the line works on either host and never
// runs another copy's code.
export const binCommand = (name) => (firstOnPath(name)?.own ? name : commandPath(name));
