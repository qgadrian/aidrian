import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const HOOK_IO = pathToFileURL(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/hook-io.mjs')).href;

// Runs a tiny hook that imports hook-io.mjs, with `input` on stdin.
function hook(body, input = '') {
  const code = `import { allow, deny, runHook } from ${JSON.stringify(HOOK_IO)};\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { input, encoding: 'utf8' });
}

test('deny exits 2 with the reason on stderr and nothing on stdout', () => {
  const { status, stdout, stderr } = hook(`runHook(() => deny('Blocked: use a worktree.'));`, '{}');
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.equal(stderr, 'Blocked: use a worktree.\n');
});

test('allow exits 0 and prints nothing', () => {
  const { status, stdout, stderr } = hook(`runHook(() => allow());`, '{}');
  assert.deepEqual([status, stdout, stderr], [0, '', '']);
});

test('runHook passes the payload, or {} when stdin is empty, not JSON, or not an object', () => {
  const cases = [
    ['{"tool_name":"Bash","tool_input":{"command":"ls"}}', '{"tool_name":"Bash","tool_input":{"command":"ls"}}'],
    ['', '{}'],
    ['not json', '{}'],
    ['[1,2]', '{}'],
    ['null', '{}'],
  ];
  for (const [input, expected] of cases) {
    const { status, stdout } = hook(`runHook((payload) => console.log(JSON.stringify(payload)));`, input);
    assert.equal(status, 0, input);
    assert.equal(stdout, `${expected}\n`, input);
  }
});

test('runHook turns a thrown error, sync or async, into exit 0 with nothing printed', () => {
  for (const body of [`runHook(() => { throw new Error('boom'); });`, `runHook(async () => { await null; throw new Error('boom'); });`]) {
    const { status, stdout, stderr } = hook(body, '{"tool_name":"Bash"}');
    assert.deepEqual([status, stdout, stderr], [0, '', ''], body);
  }
});
