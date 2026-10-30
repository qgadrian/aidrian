import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { gateDenial } from '../plugins/aidrian/lib/agent-gates.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const names = { human: 'the Human', ai: null };
const paths = { config: '.aidrian/config.json', knowledge: '.aidrian/knowledge', local: '.aidrian.local.json' };

// The PreToolUse payloads Claude Code 2.1.314 sends, as a live session logged them: a subagent's call carries
// agent_type and agent_id, the main session's carries neither, and one started with --agent carries agent_type alone.
const mainCall = (tool, toolInput = {}) => ({ tool_name: tool, tool_input: toolInput });
const agentCall = (type, tool, toolInput = {}) => ({ tool_name: tool, tool_input: toolInput, agent_type: type, agent_id: 'a5f0c1' });
const bash = (command) => ({ command });
const verdict = (agents, input) => gateDenial(input, { agents, names }, paths)?.reason ?? null;

test('deny blocks the tools it names and names the rule; any other tool runs', () => {
  const agents = { explorer: { deny: ['Bash', 'WebFetch'] } };
  const reason = verdict(agents, agentCall('aidrian:explorer', 'Bash', bash('ls')));
  assert.match(reason, /^aidrian: Bash is blocked for the agent "aidrian:explorer" in this project: agents\.explorer\.deny has "Bash"/);
  assert.match(reason, / \(\.aidrian\/config\.json, or \.aidrian\.local\.json, which wins\)\. This is a project rule: do not reach the same result/);
  assert.match(reason, /do not reach the same result with another tool; tell the Human what the task needs\.$/);
  assert.notEqual(verdict(agents, agentCall('aidrian:explorer', 'WebFetch')), null);
  assert.equal(verdict(agents, agentCall('aidrian:explorer', 'Read')), null);
});

test('allow alone blocks every tool it does not list, and deny wins over allow', () => {
  const agents = { reviewer: { allow: ['Read', 'Grep', 'Bash'], deny: ['Bash(git push)'] } };
  assert.equal(verdict(agents, agentCall('reviewer', 'Grep')), null);
  assert.match(verdict(agents, agentCall('reviewer', 'Edit')), /agents\.reviewer\.allow does not list it/);
  assert.equal(verdict(agents, agentCall('reviewer', 'Bash', bash('git status'))), null);
  assert.match(verdict(agents, agentCall('reviewer', 'Bash', bash('git push'))), /agents\.reviewer\.deny has "Bash\(git push\)"/);
  assert.match(verdict({ quiet: { allow: [] } }, agentCall('quiet', 'Read')), /agents\.quiet\.allow does not list it/);
});

test('a name ending in * matches by prefix, and * alone matches every tool', () => {
  const agents = { explorer: { deny: ['mcp__github__*'] }, sealed: { deny: ['*'] } };
  assert.notEqual(verdict(agents, agentCall('explorer', 'mcp__github__create_issue')), null);
  assert.equal(verdict(agents, agentCall('explorer', 'mcp__linear__get_issue')), null);
  assert.equal(verdict(agents, agentCall('explorer', 'mcp__github')), null, 'the prefix is the whole text before the *');
  assert.notEqual(verdict(agents, agentCall('sealed', 'Read')), null);
  assert.equal(verdict({ open: { allow: ['*'] } }, agentCall('open', 'Write')), null);
});

test('Bash(prefix) in deny matches any command in the line, read past wrappers, git options, and substitutions', () => {
  const agents = { main: { deny: ['Bash(git push)', 'Bash(npm publish)'] } };
  for (const command of [
    'git push',
    'git push origin main --force',
    'cd app && git -C sub push',
    'rtk git push',
    'sudo env FOO=1 /usr/bin/git push',
    'echo "$(git push)"',
    'npm test; npm publish --dry-run',
    'git status | tee x && npm publish',
  ]) {
    assert.match(verdict(agents, mainCall('Bash', bash(command))), /agents\.main\.deny has "Bash\(/, command);
  }
  for (const command of ['git pushx', 'git status', 'echo git push', "echo 'git push'", 'git log --grep push', 'npm run publish']) {
    assert.equal(verdict(agents, mainCall('Bash', bash(command))), null, command);
  }
  assert.equal(verdict(agents, mainCall('Read', { file_path: 'git push' })), null, 'Bash(...) never matches another tool');
});

test('Bash(prefix) in allow lets a call run only when every command in it starts with an allowed prefix', () => {
  const agents = { tester: { allow: ['Read', 'Bash(npm test)', 'Bash(git status)', 'Bash(git log)'] } };
  for (const command of ['npm test', 'npm test -- --watch=false', 'git status && git log -3', 'git -C app status']) {
    assert.equal(verdict(agents, agentCall('tester', 'Bash', bash(command))), null, command);
  }
  for (const command of ['npm test && rm -rf build', 'npm install', 'echo $(git status)', '$TOOL status', 'sh -c "npm test"', 'cd app && npm test']) {
    assert.match(verdict(agents, agentCall('tester', 'Bash', bash(command))), /agents\.tester\.allow does not list it/, command);
  }
  assert.notEqual(verdict(agents, agentCall('tester', 'Bash', {})), null, 'a call with no command is not on the list');
});

test('* applies to every caller; main to the main session, also one started with --agent; a name to that agent', () => {
  const agents = { '*': { deny: ['WebSearch'] }, main: { deny: ['Write'] }, explorer: { deny: ['Grep'] } };
  const plugin = (tool) => agentCall('aidrian:explorer', tool);
  const sessionAgent = (tool) => ({ tool_name: tool, tool_input: {}, agent_type: 'aidrian:explorer' });
  assert.match(verdict(agents, mainCall('WebSearch')), /agents\.\*\.deny/);
  assert.match(verdict(agents, plugin('WebSearch')), /agents\.\*\.deny/);
  assert.match(verdict(agents, mainCall('Write')), /blocked for the main session in this project: agents\.main\.deny/);
  assert.equal(verdict(agents, plugin('Write')), null, 'a subagent is not the main session');
  assert.match(verdict(agents, plugin('Grep')), /agents\.explorer\.deny/);
  assert.equal(verdict(agents, mainCall('Grep')), null);
  assert.match(verdict(agents, sessionAgent('Write')), /agents\.main\.deny/);
  assert.match(verdict(agents, sessionAgent('Grep')), /agents\.explorer\.deny/);
});

test('an agent answers to its full name, its short name, and Codex`s aidrian- role name; a full key names one plugin', () => {
  const agents = { explorer: { deny: ['Read'] }, 'aidrian:architect': { deny: ['Read'] }, 'local-probe': { deny: ['Read'] } };
  for (const type of ['aidrian:explorer', 'other:explorer', 'explorer', 'aidrian-explorer', 'aidrian:architect', 'local-probe']) {
    assert.notEqual(verdict(agents, agentCall(type, 'Read')), null, type);
  }
  for (const type of ['other:architect', 'architect', 'explorer-2', 'local']) {
    assert.equal(verdict(agents, agentCall(type, 'Read')), null, type);
  }
});

test('the hook blocks with exit 2 and the rule on stderr, and exits 0 silently without gates or a project', (t) => {
  const project = (config) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gates-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
    return dir;
  };
  const run = (cwd, input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...input, cwd }), cwd, encoding: 'utf8' });
  const gated = project({ version: 1, agents: { main: { deny: ['Bash(git push)'] } }, names: { human: 'the product owner' } });

  const blocked = run(gated, mainCall('Bash', bash('git push')));
  assert.deepEqual([blocked.status, blocked.stdout], [2, '']);
  assert.match(blocked.stderr, /^aidrian: Bash is blocked for the main session in this project: agents\.main\.deny has "Bash\(git push\)"/);
  assert.match(blocked.stderr, /tell the product owner what the task needs\.\n$/);
  for (const [cwd, input] of [
    [gated, mainCall('Bash', bash('git status'))],
    [gated, agentCall('aidrian:explorer', 'Bash', bash('git push'))],
    [project({ version: 1 }), mainCall('Bash', bash('git push'))],
    [path.dirname(gated), mainCall('Bash', bash('git push'))],
  ]) {
    const { status, stdout, stderr } = run(cwd, input);
    assert.deepEqual([status, stdout, stderr], [0, '', ''], `${cwd}: ${input.tool_input.command}`);
  }
});
