// The transcript guard (lib/transcript-guard.mjs) through the agent gate hook, in this process: while a project run is
// under way, no session or subagent writes a host transcript, since a project run reads the driver's continuation there.
// Every run comes from test/project-start-fixture.mjs: no real session, forge, or home.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { hookCall } from './hook-call.mjs';
import { DRIVER, OTHER, runFixture } from './project-start-fixture.mjs';

const AGENT_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const NEXT = 'abcd1234-0000-4000-8000-00000000c0a1';

test('while a run is under way, no session or subagent writes a host transcript, and a project folder\'s deeper entries stay writable', async (t) => {
  const fx = runFixture(t);
  const hook = (session, command, more = {}) => hookCall(AGENT_HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: fx.dir, ...more }),
    cwd: fx.dir, env: { ...fx.as(session), HOME: fx.home }, encoding: 'utf8',
  });
  const folder = path.join(fx.env.CLAUDE_CONFIG_DIR, 'projects', fx.dir.replace(/[^A-Za-z0-9]/gu, '-'));
  const forged = `printf '{}\\n' >> ${path.join(folder, `${DRIVER}.jsonl`)}`;
  for (const [session, more] of [[OTHER, {}], [DRIVER, {}], [OTHER, { agent_id: 'a1' }]]) {
    const refused = await hook(session, forged, more);
    assert.equal(refused.status, 2, `${session} ${JSON.stringify(more)}`);
    assert.match(refused.stderr, /may change a host's session transcript/u);
  }
  assert.equal((await hook(OTHER, `printf x > ${path.join(path.dirname(folder), 'forged', 'x.jsonl')}`)).status, 2, 'a new project folder');
  assert.equal((await hook(OTHER, `cd "$CONFIG" && printf x > projects/a/${NEXT}.jsonl`)).status, 2, 'spelled from a folder no path gives');
  assert.equal((await hook(OTHER, `printf x > ${path.dirname(folder)}/*/x.jsonl`)).status, 2, 'a glob that may reach one');
  mkdirSync(path.join(folder, 'memory'), { recursive: true });
  assert.equal((await hook(OTHER, `printf x > ${path.join(folder, 'memory', 'note.md')}`)).status, 0, 'a host memory file');
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal((await hook(OTHER, forged)).status, 0, 'no run under way');
});
