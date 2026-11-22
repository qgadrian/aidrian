// Logs the git calls a test's code makes: a `git` first on PATH that appends each call to a log and runs the real git.
// factReads gives the four reads lib/git.mjs withGitFacts remembers, by name, for a call in the test's own process;
// gitLog gives a PATH value to hand a call that reads its own environment, and every line it logged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GATE_CONFIG } from '../plugins/aidrian/lib/git.mjs';

// The four reads lib/git.mjs withGitFacts remembers, by name, with their arguments as a plugin call gives them.
export const FACT_READS = {
  roots: 'rev-parse --path-format=absolute --git-common-dir --git-dir --show-toplevel',
  prefix: 'rev-parse --show-prefix',
  origin: 'config --get remote.origin.url',
  remotes: 'config --get-regexp ^remote\\..*\\.url$',
};
// The line factReads writes to the log each time its `act` calls `mark()`, so a fact read after it shows.
export const READING_MARK = 'forge reading';

// A temporary folder whose `git` appends `<working folder> <arguments>` to `log` and runs the real git, the one the
// test's PATH finds now. `path` is the PATH value with that folder first.
function logFolder(t) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-log-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'calls.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s %s\\n' "$(pwd -P)" "$*" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  // Every plugin git call runs hardened (lib/git.mjs GATE_CONFIG): the log shows each call's own arguments after it.
  const hardened = ` ${GATE_CONFIG.join(' ')}`;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).map((line) => line.replace(hardened, ''));
  return { log, path: `${bin}${path.delimiter}${process.env.PATH}`, calls };
}

// A logging `git` for a call that takes its PATH from an environment the test gives, such as a hook's: `path` is the
// PATH value with its folder first, and `calls()` every line it logged, `<working folder> <arguments>`, in order.
export function gitLog(t) {
  const { path: value, calls } = logFolder(t);
  return { path: value, calls };
}

// The log of the git calls `act(mark)` makes while a `git` that logs each call and runs the real one comes first on PATH:
// each fact read as `<working folder> <fact name>`, and READING_MARK each time `act` calls `mark()`. Other calls are left out.
export function factReads(t, act) {
  const { log, path: value, calls } = logFolder(t);
  const before = process.env.PATH;
  process.env.PATH = value;
  try {
    act(() => writeFileSync(log, `${READING_MARK}\n`, { flag: 'a' }));
  } finally {
    process.env.PATH = before;
  }
  return calls().flatMap((line) => {
    if (line === READING_MARK) return [line];
    const fact = Object.entries(FACT_READS).find(([, args]) => line.endsWith(` ${args}`));
    return fact ? [`${line.slice(0, -fact[1].length - 1)} ${fact[0]}`] : [];
  });
}

// How many times each line of `reads` occurs, as an object.
export const tally = (reads) => Object.fromEntries([...new Set(reads)].map((line) => [line, reads.filter((each) => each === line).length]));
