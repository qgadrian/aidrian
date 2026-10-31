// Loaded before every test file (`node --test --import`). It keeps the tests apart from the shell that runs them.
//
// State: the tests and the commands they spawn keep their state in a temporary folder, never in the developer's
// `~/.local/state/aidrian`. A test that sets XDG_STATE_HOME itself wins.
//
// Environment: a test sees none of the variables that change what the code under test does, so the suite gives
// the same result in a plain shell, a Claude session, or a git hook. A test that needs one sets it itself.
// - CLAUDE_CODE_AGENT and CLAUDE_CODE_SESSION_ID: the running session's identity, which the logs record.
// - AIDRIAN_ALLOW_*: the escape hatches that switch a rule off.
// - GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the others git sets in a hook: with one of them set, the
//   tests' own `git init` and `git -C <temp repo>` calls act on the developer's repository instead.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SESSION = ['CLAUDE_CODE_AGENT', 'CLAUDE_CODE_SESSION_ID'];
// The variables git reads to find a repository, as `git rev-parse --local-env-vars` lists them.
const GIT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_WORK_TREE',
];

export function isolate(env = process.env) {
  for (const key of Object.keys(env)) {
    if (SESSION.includes(key) || GIT.includes(key) || key.startsWith('AIDRIAN_ALLOW_')) delete env[key];
  }
  return env;
}

isolate();

if (!process.env.AIDRIAN_TEST_STATE) {
  process.env.AIDRIAN_TEST_STATE = mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-'));
  process.env.XDG_STATE_HOME = process.env.AIDRIAN_TEST_STATE;
}
