// stopBackground: `claude stop` takes the listing's short id and refuses a full session id, so a full one is turned
// into the short id of the one listed row that holds it before the stop runs.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { stopBackground } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';

const FULL = '306d6ea0-6f93-4ac6-abe0-473db3caabb0';

// A fake `claude`: `agents --json --all` lists `rows`; `stop` exits 0 only for a short id the listing names, as 2.1.330 does.
function fake(rows) {
  const calls = [];
  const run = (_claude, args) => {
    calls.push(args);
    if (args[0] === 'agents') return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
    if (args[0] === 'stop') return rows.some((row) => row.id === args[1]) ? { status: 0, stdout: `stopped ${args[1]}\n`, stderr: '' } : { status: 1, stdout: '', stderr: `No session matching '${args[1]}'.` };
    return { status: 1, stdout: '', stderr: '' };
  };
  return { run, calls, resolve: () => '/usr/local/bin/claude' };
}

test('a full session id is stopped by the short id the listing gives it', () => {
  const { run, calls, resolve } = fake([{ id: '306d6ea0', sessionId: FULL, kind: 'background', state: 'blocked' }]);
  assert.equal(stopBackground({ id: FULL, run, resolve }), true);
  assert.deepEqual(calls.filter((args) => args[0] === 'stop'), [['stop', '306d6ea0']]);
});

test('a short id goes to claude stop as it is', () => {
  const { run, calls, resolve } = fake([{ id: '306d6ea0', sessionId: FULL, kind: 'background', state: 'blocked' }]);
  assert.equal(stopBackground({ id: '306d6ea0', run, resolve }), true);
  assert.deepEqual(calls.filter((args) => args[0] === 'stop'), [['stop', '306d6ea0']]);
});

test('a full id no row holds goes as it is, and the refusal is a false answer', () => {
  const { run, calls, resolve } = fake([]);
  assert.equal(stopBackground({ id: FULL, run, resolve }), false);
  assert.deepEqual(calls.filter((args) => args[0] === 'stop'), [['stop', FULL]]);
});

test('a listing that cannot be read leaves the id as it is', () => {
  const calls = [];
  const run = (_claude, args) => (calls.push(args), args[0] === 'agents' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' });
  assert.equal(stopBackground({ id: FULL, run, resolve: () => '/usr/local/bin/claude' }), true);
  assert.deepEqual(calls.filter((args) => args[0] === 'stop'), [['stop', FULL]]);
});
