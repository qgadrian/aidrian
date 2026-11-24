// lib/hook-result.mjs: the verdict a hooks.json host draws from one hook script's exit and output, and from several hooks
// that matched one call.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { combineHookResults, NO_REASON, OVERFLOW_REASON, readHookResult, REWRITE_CONFLICT } from '../plugins/aidrian/lib/hook-result.mjs';

const EMPTY = { block: false, reason: null, context: null, systemMessage: null, updatedInput: null };
const result = (fields) => ({ ...EMPTY, ...fields });
const json = (event, fields) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } });

// Per event: what exit 2 with a reason gives, and what plain stdout on exit 0 gives.
const EVENTS = {
  PreToolUse: { exit2: result({ block: true, reason: 'not here' }), plain: EMPTY },
  UserPromptSubmit: { exit2: result({ block: true, reason: 'not here' }), plain: result({ context: 'lines' }) },
  Stop: { exit2: result({ block: true, reason: 'not here' }), plain: EMPTY },
  SubagentStop: { exit2: result({ block: true, reason: 'not here' }), plain: EMPTY },
  PostToolUse: { exit2: result({ context: 'not here' }), plain: EMPTY },
  SessionStart: { exit2: EMPTY, plain: result({ context: 'lines' }) },
  SubagentStart: { exit2: EMPTY, plain: EMPTY },
  PreCompact: { exit2: result({ block: true, reason: 'not here' }), plain: result({ context: 'lines' }) },
  SessionEnd: { exit2: EMPTY, plain: EMPTY },
  SomeFutureEvent: { exit2: EMPTY, plain: EMPTY },
};

// The events whose host reads additionalContext and systemMessage from a JSON answer.
const READS_JSON = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']);

for (const [event, want] of Object.entries(EVENTS)) {
  test(`${event}: exit 0 and 2, plain stdout, and JSON stdout`, () => {
    assert.deepEqual(readHookResult({ event, exit: 2, stdout: '', stderr: '  not here\n' }), want.exit2, 'exit 2');
    assert.deepEqual(readHookResult({ event, exit: 0, stdout: '\n lines \n', stderr: 'ignored' }), want.plain, 'plain stdout');
    assert.deepEqual(readHookResult({ event, exit: 0, stdout: '', stderr: 'ignored' }), EMPTY, 'exit 0 with nothing');
    if (READS_JSON.has(event)) {
      assert.deepEqual(
        readHookResult({ event, exit: 0, stdout: json(event, { additionalContext: 'more' }), stderr: '' }),
        result({ context: 'more' }),
        'additionalContext',
      );
      assert.deepEqual(
        readHookResult({ event, exit: 0, stdout: JSON.stringify({ systemMessage: 'banner', other: 1 }), stderr: '' }),
        result({ systemMessage: 'banner' }),
        'systemMessage',
      );
    }
    const rewrite = readHookResult({ event, exit: 0, stdout: json(event, { updatedInput: { run_in_background: false } }), stderr: '' });
    assert.deepEqual(rewrite, event === 'PreToolUse' ? result({ updatedInput: { run_in_background: false } }) : EMPTY, 'updatedInput');
    assert.ok(Object.isFrozen(rewrite));
  });
}

test('exit 2 with an empty stderr still blocks, with the fixed reason; on PostToolUse it adds nothing', () => {
  assert.deepEqual(readHookResult({ event: 'Stop', exit: 2, stdout: '', stderr: ' \n' }), result({ block: true, reason: NO_REASON }));
  assert.deepEqual(readHookResult({ event: 'PostToolUse', exit: 2, stdout: '', stderr: '' }), EMPTY);
});

test('the JSON a hook prints here: the banner and start context together, the context of a file write', () => {
  const start = JSON.stringify({ systemMessage: 'Resumed.', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'a\nb' } });
  assert.deepEqual(readHookResult({ event: 'SessionStart', exit: 0, stdout: start, stderr: '' }), result({ context: 'a\nb', systemMessage: 'Resumed.' }));
  // A JSON value that is not an object is plain text, as the host reads it.
  assert.deepEqual(readHookResult({ event: 'SessionStart', exit: 0, stdout: '[1]', stderr: '' }), result({ context: '[1]' }));
  assert.deepEqual(readHookResult({ event: 'PreToolUse', exit: 0, stdout: json('PreToolUse', { updatedInput: [1] }), stderr: '' }), EMPTY);
  // A blank answer adds nothing.
  assert.deepEqual(readHookResult({ event: 'SessionStart', exit: 0, stdout: json('SessionStart', { additionalContext: ' \n' }), stderr: '' }), EMPTY);
  assert.deepEqual(readHookResult({ event: 'SessionStart', exit: 0, stdout: JSON.stringify({ systemMessage: '  ' }), stderr: '' }), EMPTY);
});

test('a crash, a kill, a signal, output past the bound, or input it cannot read is the empty result', () => {
  const cases = [
    { event: 'PreToolUse', exit: 1, stdout: '', stderr: 'boom' },
    { event: 'PreToolUse', exit: 137, stdout: '', stderr: 'killed' },
    { event: 'PreToolUse', exit: null, signal: 'SIGKILL', stdout: '', stderr: 'x' },
    { event: 'PreToolUse', exit: 2, signal: 'SIGKILL', stdout: '', stderr: 'x' },
    { event: 'PostToolUse', exit: 2, stdout: '', stderr: 'x', overflow: true },
    { event: 'SessionStart', exit: 0, stdout: 'lines', stderr: '', overflow: true },
    { event: 'PreToolUse', exit: 0, stdout: json('PreToolUse', { updatedInput: { a: 1 } }), stderr: '', overflow: true },
    { event: 'PreToolUse', exit: '2', stdout: '', stderr: 'x' },
    { event: 7, exit: 2, stdout: '', stderr: 'x' },
    { event: 7, exit: 0, stdout: json('SessionStart', { additionalContext: 'more' }), stderr: '' },
    { event: 'PreToolUse', exit: 2, stdout: '', stderr: { text: 'x' } },
    null,
    undefined,
    'garbage',
    [],
  ];
  for (const input of cases) assert.deepEqual(readHookResult(input), EMPTY, JSON.stringify(input));
  assert.deepEqual(readHookResult(), EMPTY);
  assert.deepEqual(readHookResult({ get event() { throw new Error('x'); } }), EMPTY, 'an input that throws when read');
});

test('an exit 2 on an event that blocks still blocks when its output passed the bound, with no text of it', () => {
  for (const event of ['PreToolUse', 'Stop']) {
    const padded = { event, exit: 2, stdout: 'y'.repeat(10), stderr: `refused ${'x'.repeat(10)}`, overflow: true };
    assert.deepEqual(readHookResult(padded), result({ block: true, reason: OVERFLOW_REASON }), event);
  }
});

test('combine: any block wins and drops a rewrite, and reasons, contexts, and banners join in order', () => {
  const blocked = combineHookResults([
    result({ context: 'one' }),
    result({ block: true, reason: 'first' }),
    result({ updatedInput: { a: 1 }, systemMessage: 'banner' }),
    result({ block: true, reason: 'second', context: 'two' }),
  ]);
  assert.deepEqual(blocked, result({ block: true, reason: 'first\n\nsecond', context: 'one\n\ntwo', systemMessage: 'banner' }));
  assert.ok(Object.isFrozen(blocked));
  assert.deepEqual(combineHookResults([]), EMPTY);
  assert.deepEqual(combineHookResults('garbage'), EMPTY);
  assert.deepEqual(combineHookResults([null, result({ block: true })]), result({ block: true, reason: NO_REASON }), 'a block with no reason');
});

test('combine: equal rewrites pass, and two different rewrites refuse the call', () => {
  const same = combineHookResults([result({ updatedInput: { a: 1, b: [2] } }), EMPTY, result({ updatedInput: { a: 1, b: [2] } })]);
  assert.deepEqual(same, result({ updatedInput: { a: 1, b: [2] } }));
  const differ = combineHookResults([result({ updatedInput: { a: 1 } }), result({ updatedInput: { a: 2 } })]);
  assert.deepEqual(differ, result({ block: true, reason: REWRITE_CONFLICT }));
});
