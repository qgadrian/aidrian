// A home folder of the test file's own. Code that reads the unattended marks reads them in the user's own state folder
// too, `~/.local/state/aidrian/unattended`, which no HOME or XDG_STATE_HOME moves (lib/unattended-mark.mjs markFolders),
// so a test passes this folder as `home`: without it, a mark of a session running on the machine reaches the test.
// Import it after scripts/test-state.mjs, so the folder lands in the run's temporary folder.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const TEST_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-test-home-')));
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));
