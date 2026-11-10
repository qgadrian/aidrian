// A subagent's background agent dispatch is moved to the foreground by the Agent hook, so the subagent cannot end its
// turn with a child still running (lib/foreground-dispatch.mjs, docs/hooks.md#background-check).

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { foregroundDispatch } from '../plugins/aidrian/lib/foreground-dispatch.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-pre.mjs');
// A key the hook never sets, as Claude Code may add later: updatedInput replaces the whole call, so it must come back.
const CALL = { description: 'Review the change', prompt: 'Review it', subagent_type: 'aidrian:critic', run_in_background: true, a_later_key: { nested: [1] } };
const SUBAGENT = { agent_id: 'a01ce654b256eca0f', agent_type: 'aidrian:product-manager' };

function tempProject(t, config) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-foreground-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return dir;
}

const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });

test('foregroundDispatch turns off run_in_background on a subagent\'s dispatch and on nothing else', () => {
  assert.deepEqual(foregroundDispatch(SUBAGENT, CALL), { ...CALL, run_in_background: false });
  assert.equal(foregroundDispatch({}, CALL), null, 'the main session keeps its background dispatch: the report wakes it');
  assert.equal(foregroundDispatch({ agent_id: '' }, CALL), null);
  assert.equal(foregroundDispatch(SUBAGENT, { ...CALL, run_in_background: false }), null);
  assert.equal(foregroundDispatch(SUBAGENT, { ...CALL, run_in_background: undefined }), null);
  assert.equal(foregroundDispatch(SUBAGENT, undefined), null);
});

test('the Agent hook runs a subagent\'s background dispatch in the foreground, with the project\'s model kept', (t) => {
  const project = tempProject(t, { version: 1, models: { claude: { agents: { critic: { model: 'opus' } } } } });
  const moved = run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: CALL, ...SUBAGENT });
  assert.deepEqual([moved.status, moved.stderr], [0, '']);
  assert.deepEqual(JSON.parse(moved.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...CALL, model: 'opus', run_in_background: false } },
  });

  const other = run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: { ...CALL, subagent_type: 'Explore' }, ...SUBAGENT });
  assert.deepEqual(JSON.parse(other.stdout).hookSpecificOutput.updatedInput, { ...CALL, subagent_type: 'Explore', run_in_background: false }, 'any agent type, not only this plugin\'s');

  const main = run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: { ...CALL, subagent_type: 'Explore' } });
  assert.deepEqual([main.status, main.stdout, main.stderr], [0, '', ''], 'the main session\'s background dispatch runs as written');
});
