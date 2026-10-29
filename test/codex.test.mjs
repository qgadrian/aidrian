import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parse } from 'smol-toml';

import { CODEX_AGENTS, PREFIX, compareCodexAgents, readAgents, renderCodexAgents } from '../scripts/build.mjs';

const BUILD = path.resolve(import.meta.dirname, '../scripts/build.mjs');
const INSTALL = path.resolve(import.meta.dirname, '../plugins/aidrian/codex/install-agents.mjs');

test('the generated Codex agents are current (npm run build regenerates them)', () => {
  assert.deepEqual(compareCodexAgents(), []);
});

// What the Codex role carries after its preamble: the agent's body, then its Codex add-on.
const roleText = ({ body, addons }) => (addons.codex ? `${body}\n\n${addons.codex}` : body);

test('each Codex agent is valid TOML that carries its Claude Code agent', () => {
  for (const { meta, body, addons } of readAgents()) {
    const role = parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${meta.name}.toml`), 'utf8'));
    assert.equal(role.name, `${PREFIX}${meta.name}`);
    assert.equal(role.description, meta.description.replace(/\s+/g, ' ').trim());
    assert.equal(role.model_reasoning_effort, meta.effort === 'max' ? 'xhigh' : meta.effort);
    assert.equal('model' in role, false, 'Codex roles inherit the session model');
    assert.ok(role.developer_instructions.endsWith(`${roleText({ body, addons })}\n`), `${meta.name}: body`);
  }
});

test('Codex agents that cannot edit in Claude Code are told so', () => {
  const role = (name) => parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${name}.toml`), 'utf8')).developer_instructions;
  assert.match(role('explorer'), /You are read-only/);
  assert.match(role('integrator'), /Do not create or edit files directly/);
  assert.doesNotMatch(role('planning-agent'), /read-only|Do not create or edit files/);
});

const agent = (name, body, addons = {}) => ({ file: `${name}.md`, meta: { name, description: `${name} test agent`, model: 'sonnet', effort: 'low' }, body, addons });

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

test('build reads <agent>.codex.md add-ons and fails on any other add-on name', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-addons-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentsDir = path.join(dir, 'agents');
  const addonsDir = path.join(dir, 'agent-addons');
  mkdirSync(agentsDir);
  mkdirSync(addonsDir);
  writeFileSync(path.join(agentsDir, 'lead.md'), '---\nname: lead\neffort: low\n---\n\nLead.\n');
  assert.deepEqual(readAgents({ agentsDir, addonsDir }).map(({ addons }) => addons), [{}]);
  writeFileSync(path.join(addonsDir, 'lead.codex.md'), '\nOn Codex only.\n');
  assert.deepEqual(readAgents({ agentsDir, addonsDir }).map(({ addons }) => addons), [{ codex: 'On Codex only.' }]);

  const cases = [
    ['lead.claude.md', /lead\.claude\.md: Claude Code reads agents\/lead\.md as it is/],
    ['lead.opencode.md', /lead\.opencode\.md: no OpenCode role is generated yet/],
    ['ghost.codex.md', /ghost\.codex\.md: name it <agent>\.codex\.md after an agent/],
    ['lead.cursor.md', /lead\.cursor\.md: name it <agent>\.codex\.md/],
    ['notes.md', /notes\.md: name it <agent>\.codex\.md/],
  ];
  for (const [file, message] of cases) {
    writeFileSync(path.join(addonsDir, file), 'text\n');
    assert.throws(() => readAgents({ agentsDir, addonsDir }), message, file);
    rmSync(path.join(addonsDir, file));
  }
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
  assert.match(linked.stdout, /^ok: \d+ Codex agents are current/);
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
  assert.match(run(), /are up to date \(9\)/);
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
