import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parse } from 'smol-toml';

import { CODEX_AGENTS, PREFIX, agentSettings, compareGenerated, readAgents, readProviders, renderAgents } from '../scripts/build.mjs';

const BUILD = path.resolve(import.meta.dirname, '../scripts/build.mjs');
const INSTALL = path.resolve(import.meta.dirname, '../plugins/aidrian/codex/install-agents.mjs');

test('the generated Codex agents are current (npm run build regenerates them)', () => {
  assert.deepEqual(compareGenerated('codex'), []);
});

const renderCodexAgents = (agents, defaults = { model_reasoning_effort: 'low' }) => renderAgents('codex', agents, { defaults, entries: {} });

// What the Codex role carries after its preamble: the agent's body, then its Codex add-on.
const roleText = ({ body, addons }) => (addons.codex ? `${body}\n\n${addons.codex}` : body);

// Codex's reasoning efforts, as `aidrian check` takes them for models.codex (docs/config.md#models).
const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];

test('each Codex agent is valid TOML that carries its agent source and its providers/codex.json settings', () => {
  const agents = readAgents();
  const { codex } = readProviders({ agents });
  for (const agent of agents) {
    const { meta, body, addons } = agent;
    const role = parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${meta.name}.toml`), 'utf8'));
    const settings = agentSettings('codex', agent, codex);
    assert.equal(role.name, `${PREFIX}${meta.name}`);
    assert.equal(role.description, meta.description.replace(/\s+/g, ' ').trim());
    assert.ok(CODEX_EFFORTS.includes(role.model_reasoning_effort), `${meta.name}: effort`);
    assert.equal(role.model_reasoning_effort, settings.model_reasoning_effort);
    assert.equal('model' in role, false, 'Codex roles inherit the session model');
    assert.ok(role.developer_instructions.endsWith(`${roleText({ body, addons })}\n`), `${meta.name}: body`);
  }
});

test('Codex agents whose source has access: read-only are told not to edit files', () => {
  const role = (name) => parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${name}.toml`), 'utf8')).developer_instructions;
  for (const { meta } of readAgents()) {
    const told = /Do not create or edit files directly/.test(role(meta.name));
    assert.equal(told, meta.access === 'read-only', meta.name);
  }
  assert.match(role('explorer'), /Do not create or edit files directly/);
  assert.doesNotMatch(role('planning-agent'), /read-only|Do not create or edit files/);
});

test('a Codex role carries providers/codex.json fields, tables included, and says where its model comes from', () => {
  const lead = agent('lead', 'Lead.');
  const role = renderAgents('codex', [lead], {
    defaults: { model_reasoning_effort: 'medium' },
    entries: { lead: { model: 'gpt-5.5', model_verbosity: 'low', features: { shell_tool: false } } },
  }).get(`${PREFIX}lead.toml`);
  const { developer_instructions: instructions, ...fields } = parse(role);
  // smol-toml returns objects without a prototype, which a strict deepEqual tells apart from a literal.
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), {
    name: `${PREFIX}lead`,
    description: 'lead test agent',
    model: 'gpt-5.5',
    model_reasoning_effort: 'medium',
    model_verbosity: 'low',
    features: { shell_tool: false },
  });
  assert.ok(instructions.endsWith('\n\nLead.\n'));
  assert.match(role, /^# providers\/codex\.json sets this role's model\.$/m);
  assert.match(renderCodexAgents([lead]).get(`${PREFIX}lead.toml`), /^# This role inherits the Codex session's model\.$/m);
});

const agent = (name, body, addons = {}, access = 'write') => ({ file: `${name}.md`, meta: { name, description: `${name} test agent`, access }, body, addons });

test('Codex roles give Codex names only to this plugin\'s agents, never to a project\'s own roles', () => {
  const rendered = renderCodexAgents([agent('lead', 'Ask `helper`, then `architect`. You are `lead`.'), agent('helper', 'Help.')]);
  const lead = parse(rendered.get(`${PREFIX}lead.toml`)).developer_instructions;
  assert.match(lead, /`helper` is `aidrian-helper`/);
  assert.doesNotMatch(lead, /aidrian-architect|aidrian-lead/);
  assert.doesNotMatch(parse(rendered.get(`${PREFIX}helper.toml`)).developer_instructions, /Codex names/);

  const shipped = new Set(readAgents().map(({ meta }) => `${PREFIX}${meta.name}`));
  for (const { meta, body, addons } of readAgents()) {
    const role = parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${meta.name}.toml`), 'utf8')).developer_instructions;
    const preamble = role.slice(0, -(roleText({ body, addons }).length + 1));
    for (const [, name] of preamble.matchAll(/`(aidrian-[a-z-]+)`/g)) assert.ok(shipped.has(name), `${meta.name}: ${name} is not a plugin agent`);
  }
});

test('Codex roles do not rename an agent that is named only as a skill', () => {
  const leadInstructions = (body) => parse(renderCodexAgents([agent('lead', body), agent('helper', 'Help.')]).get(`${PREFIX}lead.toml`)).developer_instructions;
  assert.doesNotMatch(leadInstructions('Read the `helper` skill\'s references, then load the skill `helper`.'), /aidrian-helper/);
  assert.doesNotMatch(leadInstructions('Load and follow the `helper` skill.'), /aidrian-helper/);
  assert.match(leadInstructions('Load the `helper` skill, then ask `helper` to check it.'), /`helper` is `aidrian-helper`/);

  const initiative = parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}initiative-agent.toml`), 'utf8')).developer_instructions;
  assert.doesNotMatch(initiative, /aidrian-agent-issue-writer/, 'initiative-agent reads the agent-issue-writer skill; it spawns no such agent');
});

test('a Codex add-on follows the agent body in the Codex role, and the agents it names get their Codex names', () => {
  const rendered = renderCodexAgents([agent('lead', 'Lead the work.', { codex: 'On Codex, ask `helper` first.' }), agent('helper', 'Help.')]);
  const lead = parse(rendered.get(`${PREFIX}lead.toml`)).developer_instructions;
  assert.ok(lead.endsWith('Lead the work.\n\nOn Codex, ask `helper` first.\n'));
  assert.match(lead, /`helper` is `aidrian-helper`/);
  assert.ok(parse(rendered.get(`${PREFIX}helper.toml`)).developer_instructions.endsWith('\n\nHelp.\n'));
});

test('build fails on an unknown argument instead of regenerating the files', () => {
  const file = path.join(CODEX_AGENTS, readdirSync(CODEX_AGENTS)[0]);
  const before = statSync(file).mtimeMs;
  for (const args of [['--chek'], ['--check', '--force']]) {
    const { status, stdout, stderr } = spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8' });
    assert.equal(status, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^usage: node scripts/build\\.mjs \\[--check\\]\nunknown argument: ${args.at(-1)}`));
  }
  assert.equal(statSync(file).mtimeMs, before);
});

test('build runs only as the entry script, including through a symlinked path', (t) => {
  // `node -e` leaves process.argv[1] unset; importing the module there must neither throw nor build.
  const imported = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(BUILD).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');

  // A path through a symlink must still run --check, not exit 0 having checked nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-build-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(path.resolve(import.meta.dirname, '..'), path.join(dir, 'repo'));
  const linked = spawnSync(process.execPath, [path.join(dir, 'repo/scripts/build.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /^ok: \d+ Claude Code agents and \d+ Codex agents are current/);
});

test('install-agents adds and updates its own roles, removes stale ones, and leaves other files alone', (t) => {
  const target = mkdtempSync(path.join(tmpdir(), 'aidrian-codex-agents-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(path.join(target, 'my-own-agent.toml'), 'name = "mine"\n');
  writeFileSync(path.join(target, `${PREFIX}retired.toml`), 'name = "old"\n');
  writeFileSync(path.join(target, `${PREFIX}explorer.toml`), 'name = "outdated"\n');

  const run = () => execFileSync(process.execPath, [INSTALL, '--target', target], { encoding: 'utf8' });
  assert.match(run(), /added .*; updated aidrian-explorer; removed aidrian-retired/);
  const shipped = readdirSync(CODEX_AGENTS).sort();
  assert.deepEqual(readdirSync(target).sort(), [...shipped, 'my-own-agent.toml'].sort());
  for (const file of shipped) assert.equal(readFileSync(path.join(target, file), 'utf8'), readFileSync(path.join(CODEX_AGENTS, file), 'utf8'));
  assert.match(run(), new RegExp(`are up to date \\(${shipped.length}\\)`));
});

test('install-agents fails on a bad argument, and touches nothing', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aidrian-codex-agents-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, `${PREFIX}retired.toml`), 'name = "old"\n');

  // CODEX_HOME is the temporary folder too, so a fallback to the default target would show up below.
  const cases = [
    [['--target'], /--target needs a folder/],
    [['--target', ''], /--target needs a folder/],
    [['--target', '--force'], /--target needs a folder/],
    [['--targte', cwd], /unknown argument: --targte/],
    [['--target', cwd, '--force'], /unknown argument: --force/],
  ];
  for (const [args, expected] of cases) {
    const env = { ...process.env, CODEX_HOME: cwd };
    const { status, stderr } = spawnSync(process.execPath, [INSTALL, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(status, 1, args.join(' '));
    assert.match(stderr, /^usage: node install-agents\.mjs/);
    assert.match(stderr, expected);
  }
  assert.deepEqual(readdirSync(cwd), [`${PREFIX}retired.toml`]);
});
