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

test('a short id goes to claude stop as it is, with no listing', () => {
  const { run, calls, resolve } = fake([{ id: '306d6ea0', sessionId: FULL, kind: 'background', state: 'blocked' }]);
  assert.equal(stopBackground({ id: '306d6ea0', run, resolve }), true);
  assert.deepEqual(calls, [['stop', '306d6ea0']]);
});

test('a recorded full id falls back to the listed short id, and a short id that fails reads the listing only for the full id', () => {
  const rows = [{ id: 'c0ffee01', sessionId: FULL, kind: 'background', state: 'blocked' }];
  const full = fake(rows);
  assert.equal(stopBackground({ id: FULL, started: FULL, run: full.run, resolve: full.resolve }), true);
  assert.deepEqual(full.calls.filter((args) => args[0] === 'stop'), [['stop', 'c0ffee01']]);
  const prefix = fake(rows);
  assert.equal(stopBackground({ id: FULL, started: '306d6ea0', run: prefix.run, resolve: prefix.resolve }), true);
  assert.deepEqual(prefix.calls.filter((args) => args[0] === 'stop'), [['stop', '306d6ea0'], ['stop', 'c0ffee01']]);
});

test('no prefix match: a short id that fails never stops another session that shares its prefix', () => {
  const other = '306d6ea0-0000-4000-8000-000000000000';
  const { run, calls, resolve } = fake([{ id: 'beef0001', sessionId: other, kind: 'background', state: 'working' }]);
  assert.equal(stopBackground({ id: '306d6ea0', run, resolve }), false);
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

test('the short id the start recorded goes first, with no listing, so a listing that times out never leaves the full id', () => {
  const calls = [];
  const run = (_claude, args) => (calls.push(args), args[0] === 'agents' ? { error: new Error('ETIMEDOUT'), status: null, stdout: '', stderr: '' } : { status: args[1] === '306d6ea0' ? 0 : 1, stdout: '', stderr: '' });
  assert.equal(stopBackground({ id: FULL, started: '306d6ea0', run, resolve: () => '/usr/local/bin/claude' }), true);
  assert.deepEqual(calls, [['stop', '306d6ea0']]);
});
