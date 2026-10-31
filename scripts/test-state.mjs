// Loaded before every test file (`node --test --import`). It keeps the tests apart from the shell that runs them.
//
// State: the tests and the commands they spawn keep their state in a temporary folder, never in the developer's
// `~/.local/state/aidrian`. A test that sets XDG_STATE_HOME itself wins.
//
// Environment: a test sees none of the variables that change what the code under test does, so the suite gives
// the same result in a plain shell, a Claude session, or a git hook. A test that needs one sets it itself.
// The list lives in plugins/aidrian/lib/review/env.mjs, which local reviewers run under too. With GIT_DIR set, as a git
// hook sets it, the tests' own `git init` calls would act on the developer's repository.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isolate } from '../plugins/aidrian/lib/review/env.mjs';

export { isolate };

isolate(process.env);

if (!process.env.AIDRIAN_TEST_STATE) {
  process.env.AIDRIAN_TEST_STATE = mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-'));
  process.env.XDG_STATE_HOME = process.env.AIDRIAN_TEST_STATE;
}
