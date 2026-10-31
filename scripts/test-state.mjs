// Loaded before every test file (`node --test --import`): the tests and the commands they spawn keep their state in a
// temporary folder, never in the developer's `~/.local/state/aidrian`. A test that sets XDG_STATE_HOME itself wins.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.AIDRIAN_TEST_STATE) {
  process.env.AIDRIAN_TEST_STATE = mkdtempSync(path.join(tmpdir(), 'aidrian-test-state-'));
  process.env.XDG_STATE_HOME = process.env.AIDRIAN_TEST_STATE;
}
