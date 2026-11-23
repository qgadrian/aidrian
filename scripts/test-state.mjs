// Loaded before every test file (`node --test --import`). It keeps the tests apart from the shell that runs them.
//
// State: the tests and the commands they spawn keep their state in a temporary folder, never in the developer's
// `~/.local/state/aidrian`. A test that sets XDG_STATE_HOME itself wins.
//
// Git: a global config file that holds only a user identity, and no system file, so no test reads the developer's git config.
//
// Temporary files: TMPDIR points inside that folder, so what the tests and the hooks they spawn write to the
// temporary folder, such as a hook's block counts, goes there too; the process that made the folder deletes it when it
// exits. Without this, every run left its files behind in the system's temporary folder.
//
// Network: a forge command that always fails comes first on PATH, so no test reads a real pull request, and a keychain
// tool that finds no entry, so none reads this machine's keychain. A test's own fake, put before them, still wins.
//
// Environment: a test sees none of the variables that change what the code under test does, so the suite gives
// the same result in a plain shell, a Claude session, or a git hook. A test that needs one sets it itself.
// The list lives in plugins/aidrian/lib/review/env.mjs, which local reviewers run under too. With GIT_DIR set, as a git
// hook sets it, the tests' own `git init` calls would act on the developer's repository.
//
// Timing: with AIDRIAN_TEST_LOG set, as scripts/run-tests.mjs sets it, and a test file as the main script, the setup
// counts the child processes the file starts, git apart from the others. It appends one JSON line { file, started: true }
// to that file as it loads, and the file fails there when it cannot, then { file, ms, git, other } when the process exits,
// if it can: the script fails a run in which a file that started left no row. It removes the variable, so nothing a test
// starts inherits it; without it, node:child_process stays as it is.
import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DETECT_VARS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { isolate } from '../plugins/aidrian/lib/review/env.mjs';

export { isolate };

isolate(process.env);
// Which host runs the suite changes no answer, so a test that needs a host names it.
for (const name of DETECT_VARS) delete process.env[name];

if (!process.env.AIDRIAN_TEST_STATE) {
  const state = mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-'));
  const temp = path.join(state, 'tmp');
  mkdirSync(temp);
  process.env.AIDRIAN_TEST_STATE = state;
  process.env.XDG_STATE_HOME = state;
  // Which host this machine has installed changes no answer either: `aidrian check` reads Codex's config (lib/hosts/codex.mjs).
  process.env.CODEX_HOME = path.join(state, 'codex');
  // And OpenCode's global config, which says whether OpenCode is set up to run this plugin (lib/hosts/opencode-setup.mjs).
  process.env.OPENCODE_CONFIG_DIR = path.join(state, 'opencode');
  process.env.TMPDIR = temp;
  const bin = path.join(state, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // macOS's keychain tool, which finds no entry, so no test reads this machine's keychain (lib/project-token.mjs).
  writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  // The developer's git config is never read: an empty global file and no system file.
  const gitconfig = path.join(state, 'gitconfig');
  // An identity, though: git without one guesses an email from the machine's host name to write a reflog, and on a
  // machine whose name does not resolve, each clone, checkout, or commit then waits about 5 seconds for that lookup.
  writeFileSync(gitconfig, '[user]\n\tname = aidrian tests\n\temail = tests@aidrian.invalid\n');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.on('exit', () => rmSync(state, { recursive: true, force: true }));
}

const testLog = process.env.AIDRIAN_TEST_LOG;
delete process.env.AIDRIAN_TEST_LOG;
if (testLog && process.argv[1]?.endsWith('.test.mjs')) countChildProcesses(testLog, process.argv[1]);

// The program a node:child_process call starts: its file, the first word of an exec command, and node for fork.
function programOf(name, first) {
  if (name === 'fork') return process.execPath;
  const file = String(first ?? '');
  return name === 'exec' || name === 'execSync' ? file.trim().split(/\s+/u)[0] : file;
}

// Wraps every function of node:child_process that starts a process, and its promisified form where it has one, and
// writes the counts when the process exits. exec calls execFile through the module, so a call made inside another
// wrapped call is not counted again.
function countChildProcesses(log, main) {
  const counts = { git: 0, other: 0 };
  let depth = 0;
  const counted = (name, real) => function (...args) {
    const kind = path.basename(programOf(name, args[0])) === 'git' ? 'git' : 'other';
    if (depth === 0) counts[kind] += 1;
    depth += 1;
    try {
      return real.apply(this, args);
    } finally {
      depth -= 1;
    }
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const real = childProcess[name];
    const wrapper = counted(name, real);
    if (real[promisify.custom]) wrapper[promisify.custom] = counted(name, real[promisify.custom]);
    childProcess[name] = wrapper;
  }
  syncBuiltinESMExports();
  // The folder the run started in: a test may leave the process in a folder it then removes.
  const start = process.cwd();
  const file = path.relative(start, main);
  // Not caught: a file whose start cannot be logged fails as it loads, so no file runs that the script cannot judge.
  appendFileSync(log, `${JSON.stringify({ file, started: true })}\n`);
  // Best effort: a log that cannot be written, as when its folder is gone, loses the row, never the file's exit status;
  // the script then fails the run for the started file with no row.
  process.on('exit', () => {
    try {
      appendFileSync(log, `${JSON.stringify({ file, ms: Math.round(process.uptime() * 1000), ...counts })}\n`);
    } catch {
      // The table leaves this file out.
    }
  });
}
