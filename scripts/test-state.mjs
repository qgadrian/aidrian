// Loaded before every test file (`node --test --import`). It keeps the tests apart from the shell that runs them.
//
// State: the tests and the commands they spawn keep their state in a temporary folder, never in the developer's
// `~/.local/state/aidrian`. A test that sets XDG_STATE_HOME itself wins.
//
// Git: an empty global config file and no system file, so no test reads the developer's git config.
//
// Temporary files: TMPDIR points inside that folder, so what the tests and the hooks they spawn write to the
// temporary folder, such as a hook's block counts, goes there too; the process that made the folder deletes it when it
// exits. Without this, every run left its files behind in the system's temporary folder.
//
// Network: a forge command that always fails comes first on PATH, so no test reads a real pull request. A test's own fake, put
// before it, still wins.
//
// Environment: a test sees none of the variables that change what the code under test does, so the suite gives
// the same result in a plain shell, a Claude session, or a git hook. A test that needs one sets it itself.
// The list lives in plugins/aidrian/lib/review/env.mjs, which local reviewers run under too. With GIT_DIR set, as a git
// hook sets it, the tests' own `git init` calls would act on the developer's repository.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DETECT_VARS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { isolate } from '../plugins/aidrian/lib/review/env.mjs';

export { isolate };

// Leftover processes: a fake that a test starts detached, as a host session runs, appends its pid to this file, and
// the process that made the state folder stops each one when it exits. A test's own cleanup can miss one, since a
// fixture's cleanup may delete the files the test kept the pid in first; before this, a run left hundreds behind.
export const SPAWNED_FILE = 'spawned-pids';

// The file a fake appends its pid to, a line each, in the suite's state folder, which outlives every fixture.
export const spawnedFile = () => path.join(process.env.AIDRIAN_TEST_STATE, SPAWNED_FILE);

// Stops each pid the file `file` lists, a line each; a pid gone already is skipped.
export function stopListed(file) {
  if (!existsSync(file)) return;
  for (const pid of readFileSync(file, 'utf8').split('\n').map(Number).filter((each) => Number.isInteger(each) && each > 0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
}

function stopSpawned(state) {
  stopListed(path.join(state, SPAWNED_FILE));
}

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
  process.env.TMPDIR = temp;
  const bin = path.join(state, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  // The developer's git config is never read: an empty global file and no system file.
  const gitconfig = path.join(state, 'gitconfig');
  writeFileSync(gitconfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.on('exit', () => {
    stopSpawned(state);
    rmSync(state, { recursive: true, force: true });
  });
}
