import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { commitMode } from '../plugins/aidrian/lib/main-commits.mjs';

const config = (mainCheckout) => ({ ...DEFAULTS, git: { ...DEFAULTS.git, mainCheckout: { ...DEFAULTS.git.mainCheckout, ...mainCheckout } } });

test('commitMode: null follows the guard, block when it is on and allow when it is off', () => {
  assert.equal(DEFAULTS.git.mainCheckout.commits, null);
  assert.equal(commitMode(DEFAULTS), 'allow', 'a fresh project, guard off, is never blocked');
  assert.equal(commitMode(config({ guard: true, commits: null })), 'block');
  assert.equal(commitMode(config({ guard: false, commits: null })), 'allow');
});

test('commitMode: an explicit value wins over the guard', () => {
  for (const guard of [true, false]) {
    for (const commits of ['block', 'warn', 'allow']) {
      assert.equal(commitMode(config({ guard, commits })), commits, `guard ${guard}, commits ${commits}`);
    }
  }
});
