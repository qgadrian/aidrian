// The project's `models` config reaching each host: the Claude Code Agent hook and the Codex role install.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'smol-toml';

import { agentCall, codexRole } from '../plugins/aidrian/lib/agent-models.mjs';
import { CODEX_AGENTS, PREFIX } from '../scripts/build.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');
const HOOK = path.join(PLUGIN, 'scripts/hook-agent-pre.mjs');
const INSTALL = path.join(PLUGIN, 'codex/install-agents.mjs');
const MODELS = {
  claude: { agents: { explorer: { model: 'haiku', effort: 'low' }, integrator: { effort: 'high' } } },
  codex: { agents: {} },
};
// A call to this plugin's agent with keys the hook never sets, one of them a key Claude Code may add later.
// updatedInput replaces the whole call, so every one of them must come back as it was.
const CALL = {
  description: 'Find the routes',
  prompt: 'Find them',
  subagent_type: 'aidrian:explorer',
  run_in_background: true,
  name: 'routes',
  a_later_key: { nested: [1, 'two'] },
};

test('agentCall adds the chosen model and effort to a call to this plugin\'s agent, and keeps what the call set', () => {
  assert.deepEqual(agentCall(CALL, MODELS), { ...CALL, model: 'haiku', effort: 'low' });
  assert.deepEqual(agentCall({ ...CALL, model: 'opus' }, MODELS), { ...CALL, model: 'opus', effort: 'low' });
  assert.equal(agentCall({ ...CALL, model: 'opus', effort: 'max' }, MODELS), null, 'nothing left to add');
  assert.deepEqual(agentCall({ ...CALL, subagent_type: 'aidrian:integrator' }, MODELS), { ...CALL, subagent_type: 'aidrian:integrator', effort: 'high' });
  for (const type of ['explorer', 'other:explorer', 'aidrian:planning-agent', 'aidrian:__proto__', 'aidrian:constructor', undefined]) {
    assert.equal(agentCall({ ...CALL, subagent_type: type }, MODELS), null, String(type));
  }
  assert.equal(agentCall(undefined, MODELS), null);
});

test('codexRole sets model and model_reasoning_effort in a generated role, and changes nothing without a choice', () => {
  const role = readFileSync(path.join(CODEX_AGENTS, `${PREFIX}planning-agent.toml`), 'utf8');
  assert.equal(codexRole(role), role);
  assert.equal(codexRole(role, {}), role);

  const both = codexRole(role, { model: 'gpt-5.5', effort: 'medium' });
  const parsed = parse(both);
  assert.deepEqual([parsed.model, parsed.model_reasoning_effort], ['gpt-5.5', 'medium']);
  assert.equal(parsed.developer_instructions, parse(role).developer_instructions);
  assert.match(both, /^# The Claude Code agent pins model "fable"; the project's aidrian config sets this role's model\.$/m);

  const effortOnly = codexRole(role, { effort: 'low' });
  assert.deepEqual([parse(effortOnly).model, parse(effortOnly).model_reasoning_effort], [undefined, 'low']);
  assert.match(effortOnly, /this role inherits the Codex session's model\.$/m);
});

test('the Agent hook prints the rewritten call as updatedInput, and nothing outside a project or for other agents', (t) => {
  const project = tempProject(t, { version: 1, models: { claude: MODELS.claude } });
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-models-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });

  const rewritten = run({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: CALL });
  assert.deepEqual([rewritten.status, rewritten.stderr], [0, '']);
  assert.deepEqual(JSON.parse(rewritten.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...CALL, model: 'haiku', effort: 'low' } },
  });

  for (const input of [
    { tool_name: 'Agent', cwd: outside, tool_input: CALL },
    { tool_name: 'Agent', cwd: project, tool_input: { ...CALL, subagent_type: 'explorer' } },
    { tool_name: 'Bash', cwd: project, tool_input: CALL },
  ]) {
    const { status, stdout, stderr } = run(input);
    assert.deepEqual([status, stdout, stderr], [0, '', ''], JSON.stringify(input));
  }
});

test('install-agents writes the project\'s models.codex into the roles it installs inside the project, local over team', (t) => {
  const project = tempProject(t, { version: 1, models: { codex: { agents: { explorer: { model: 'gpt-5.5', effort: 'medium' } } } } });
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ models: { codex: { agents: { explorer: { effort: 'xhigh' } } } } }));
  const target = path.join(project, '.codex/agents');
  const install = () => execFileSync(process.execPath, [INSTALL, '--target', target], { cwd: project, encoding: 'utf8' });

  assert.match(install(), /added .*\nFrom the project's models\.codex: explorer \(model gpt-5\.5, effort xhigh\)\.\n$/);
  const explorer = parse(readFileSync(path.join(target, `${PREFIX}explorer.toml`), 'utf8'));
  assert.deepEqual([explorer.model, explorer.model_reasoning_effort], ['gpt-5.5', 'xhigh']);
  for (const file of readdirSync(CODEX_AGENTS).filter((each) => each !== `${PREFIX}explorer.toml`)) {
    assert.equal(readFileSync(path.join(target, file), 'utf8'), readFileSync(path.join(CODEX_AGENTS, file), 'utf8'), file);
  }
  assert.match(install(), /are up to date/);

  rmSync(path.join(project, '.aidrian.local.json'));
  assert.match(install(), /updated aidrian-explorer\b.*\nFrom the project's models\.codex: explorer \(model gpt-5\.5, effort medium\)\.\n$/);
});

test('install-agents into the user folder leaves the roles as shipped, and says a project install applies models.codex', (t) => {
  const project = tempProject(t, { version: 1, models: { codex: { agents: { explorer: { effort: 'low' } } } } });
  const codexHome = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-models-home-')));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [INSTALL], { cwd: project, env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8' });
  assert.match(output, /\nThis project sets models\.codex, which only a project install applies: --target \.codex\/agents\n$/);
  for (const file of readdirSync(CODEX_AGENTS)) {
    assert.equal(readFileSync(path.join(codexHome, 'agents', file), 'utf8'), readFileSync(path.join(CODEX_AGENTS, file), 'utf8'), file);
  }
});

function tempProject(t, config) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-models-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return dir;
}
