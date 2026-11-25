// What the OpenCode bridge (bridge.mjs) reads and changes of its process's and a shell's environment: the Node program its
// scripts run under, the trace file AIDRIAN_OPENCODE_TRACE names, and the PATH of a shell OpenCode starts. It imports
// node: built-ins and output.mjs's file check, so it loads in OpenCode's Bun and under `node --test` alike.

import { accessSync, appendFileSync, constants } from 'node:fs';
import path from 'node:path';

import { isFile } from './output.mjs';

export const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
const isProgram = (file) => {
  if (!absolute(file) || !isFile(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// A trace value that names no path, command, or payload: a script's file name, a word, or a number.
const SCRIPT = /^[a-z0-9-]+\.mjs$/u;
const WORD = /^[A-Za-z0-9._-]{1,40}$/u;
const kept = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : undefined);
const counted = (value) => (Number.isInteger(value) ? value : undefined);

// The trace writer of `env`: appends { at, step, script?, status?, count? } to an absolute AIDRIAN_OPENCODE_TRACE, else
// nothing. A value of another shape is left out.
export function tracer(env) {
  const file = env?.AIDRIAN_OPENCODE_TRACE;
  if (!absolute(file)) return () => {};
  return (step, { script, status, count } = {}) => {
    const line = { at: new Date().toISOString(), step, script: kept(script, SCRIPT), status: counted(status) ?? kept(status, WORD), count: counted(count) };
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // A trace that cannot be written changes nothing the bridge does.
    }
  };
}

// The Node program as an absolute file, or null: an absolute AIDRIAN_NODE, else this process's own program when it is
// Node, else the first `node` on an absolute PATH entry. OpenCode's own binary is Bun, and a bare `node` would be
// looked up on each spawn.
export function nodeOf(env, execPath = process.execPath) {
  if (isProgram(env?.AIDRIAN_NODE)) return env.AIDRIAN_NODE;
  if (/^node(?:\.exe)?$/u.test(path.basename(execPath ?? '')) && isProgram(execPath)) return execPath;
  const dirs = typeof env?.PATH === 'string' ? env.PATH.split(path.delimiter).filter(absolute) : [];
  return dirs.map((dir) => path.join(dir, 'node')).find(isProgram) ?? null;
}

// The PATH hook: prepends `bin` to a shell's PATH unless the PATH holds it, and returns normally whatever fails inside
// it. A `bin` that is not absolute, or that holds the delimiter, would add a relative entry or more than one, so it
// changes nothing.
export function addBin(event, bin) {
  try {
    if (!absolute(bin) || bin.includes(path.delimiter)) return;
    const vars = event?.env;
    if (typeof vars !== 'object' || vars === null) return;
    // A shell with no PATH of its own keeps none: bin alone would hide every system program. In OpenCode 2.4.0 the event
    // lacks a PATH only for a shell on another machine, where the server's own PATH is not that machine's.
    const current = vars.PATH;
    if (typeof current !== 'string' || current === '' || current.split(path.delimiter).includes(bin)) return;
    vars.PATH = `${bin}${path.delimiter}${current}`;
  } catch {
    // A shell whose environment cannot be changed starts as it would without the plugin.
  }
}
