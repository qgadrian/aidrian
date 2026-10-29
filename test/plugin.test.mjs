import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { pluginTags } from '../plugins/aidrian/lib/knowledge.mjs';
import { readAgents } from '../scripts/build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const json = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const VOCABULARY = pluginTags();
// Both hosts list every agent and skill description in every session, used or not. Say when to use it, nothing more.
const MAX_DESCRIPTION = 160;

test('both marketplaces publish the same plugin, and both plugin manifests agree', () => {
  const claudeMarket = json('.claude-plugin/marketplace.json');
  const codexMarket = json('.agents/plugins/marketplace.json');
  assert.equal(claudeMarket.name, codexMarket.name);
  assert.deepEqual(claudeMarket.plugins.map((p) => [p.name, p.source]), [['aidrian', './plugins/aidrian']]);
  assert.deepEqual(codexMarket.plugins.map((p) => [p.name, p.source]), [['aidrian', { source: 'local', path: './plugins/aidrian' }]]);

  const claude = json('plugins/aidrian/.claude-plugin/plugin.json');
  const codex = json('plugins/aidrian/plugin.json');
  for (const key of ['name', 'version', 'description', 'author', 'repository']) assert.deepEqual(codex[key], claude[key], key);
  // An explicit "agents" list replaces Claude Code's agents/ scan; with one, Claude Code 2.1.312 loaded no agents at all.
  assert.equal('agents' in claude, false);
});

test('every agent has the frontmatter Claude Code needs and preloads the knowledge skill', () => {
  const agents = readAgents();
  assert.ok(agents.length > 0);
  for (const { file, meta, body } of agents) {
    assert.equal(meta.name, file.replace(/\.md$/, ''), file);
    assert.ok(meta.description?.length > 20, `${file}: description`);
    assert.ok(meta.description.length <= MAX_DESCRIPTION, `${file}: description over ${MAX_DESCRIPTION} characters`);
    assert.ok(['haiku', 'sonnet', 'opus', 'fable', 'inherit'].includes(meta.model), `${file}: model`);
    assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(meta.effort), `${file}: effort`);
    assert.deepEqual(meta.skills, ['aidrian:knowledge'], `${file}: skills`);
    const loads = body.match(/^Before you start, follow the `knowledge` skill\. (.*)$/gm) ?? [];
    assert.equal(loads.length, 1, `${file}: one knowledge-loading line`);
  }
});

// A frontmatter `tools` or `disallowedTools` value: Claude Code takes a YAML list or a comma-separated string.
const toolList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : String(value).split(',')).map((tool) => String(tool).trim());
const mcpTools = (tools) => toolList(tools).filter((tool) => tool.startsWith('mcp__'));

// Claude Code gives an agent without `tools` every tool the session has, the project's own MCP servers included.
// An allowlist that names one vendor's MCP tools ties the agent to that setup and hides any other tracker or server.
// Add an agent here, with the reason, only when its whole purpose is that vendor.
const MCP_ALLOWLISTS = new Map();

test('no agent allowlists an MCP tool, so a project\'s own MCP tools reach it', () => {
  assert.deepEqual(mcpTools('Read, mcp__github__get_commit'), ['mcp__github__get_commit']);
  assert.deepEqual(mcpTools(['Bash', 'mcp__plugin_linear_linear__get_issue']), ['mcp__plugin_linear_linear__get_issue']);
  const agents = readAgents();
  for (const { file, meta } of agents) {
    if (!MCP_ALLOWLISTS.has(meta.name)) assert.deepEqual(mcpTools(meta.tools), [], `${file}: drop the mcp__ tools, or the whole \`tools\` list`);
  }
  for (const name of MCP_ALLOWLISTS.keys()) {
    assert.ok(agents.some(({ meta }) => meta.name === name && mcpTools(meta.tools).length), `${name} allowlists no MCP tool; remove it from MCP_ALLOWLISTS`);
  }
});

// With no allowlist, an agent also inherits NotebookEdit, which writes files as Write and Edit do.
test('an agent denied Write and Edit is denied NotebookEdit too', () => {
  for (const { file, meta } of readAgents()) {
    const denied = toolList(meta.disallowedTools);
    if (denied.includes('Write') && denied.includes('Edit')) assert.ok(denied.includes('NotebookEdit'), `${file}: add NotebookEdit to disallowedTools`);
  }
});

test('every skill has a name matching its folder and a description', () => {
  const skills = readdirSync(path.join(PLUGIN, 'skills'));
  assert.ok(skills.includes('knowledge'));
  for (const skill of skills) {
    const text = readFileSync(path.join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
    const meta = parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);
    assert.equal(meta.name, skill);
    assert.ok(meta.description?.length > 20, `${skill}: description`);
    assert.ok(meta.description.length <= MAX_DESCRIPTION, `${skill}: description over ${MAX_DESCRIPTION} characters`);
  }
});

// Codex cuts a SKILL.md at 8,000 bytes without a warning: MAX_SKILL_PROMPT_BYTES in codex-rs/ext/skills/src/render.rs.
// Keep a margin. A longer skill keeps its steps in SKILL.md and moves detail into references/ or steps/ files,
// each named in SKILL.md with when to read it.
const MAX_SKILL_BYTES = 7500;

test('every SKILL.md fits in Codex\'s skill size, with a margin', () => {
  const over = readdirSync(path.join(PLUGIN, 'skills'))
    .map((skill) => [skill, statSync(path.join(PLUGIN, 'skills', skill, 'SKILL.md')).size])
    .filter(([, bytes]) => bytes > MAX_SKILL_BYTES);
  assert.deepEqual(over, [], `move detail into references/ or steps/ files; the limit is ${MAX_SKILL_BYTES} bytes`);
});

test('a skill names each of its references/ and steps/ files, and every such file the plugin names exists', () => {
  const skills = path.join(PLUGIN, 'skills');
  const extra = (skill) => ['references', 'steps'].flatMap((sub) => {
    const dir = path.join(skills, skill, sub);
    return existsSync(dir) ? readdirSync(dir).map((file) => `${sub}/${file}`) : [];
  });
  const shipped = new Set(readdirSync(skills).flatMap(extra));
  const unnamed = [];
  for (const skill of readdirSync(skills)) {
    const text = readFileSync(path.join(skills, skill, 'SKILL.md'), 'utf8');
    for (const file of extra(skill)) if (!text.includes(file)) unnamed.push(`${skill}/${file}`);
  }
  assert.deepEqual(unnamed, [], 'SKILL.md must say when to read each of its files');
  const dangling = [];
  for (const file of markdownFiles(PLUGIN)) {
    for (const [ref] of readFileSync(file, 'utf8').matchAll(/\b(?:references|steps)\/[\w.-]+\.md\b/g)) {
      if (!shipped.has(ref)) dangling.push(`${path.relative(ROOT, file)}: ${ref}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('every tag the agents and skills ask for is in the knowledge skill tag list', () => {
  assert.ok(VOCABULARY.length >= 5, 'the knowledge skill lists its tags');
  for (const tag of ['backend', 'security', 'review', 'support', 'marketing']) assert.ok(VOCABULARY.includes(tag), tag);
  const used = new Set();
  for (const file of markdownFiles(PLUGIN)) {
    const text = readFileSync(file, 'utf8');
    // A tag list may wrap: read on to the end of its paragraph.
    for (const list of text.match(/[Kk]nowledge tags: .*(?:\n.+)*/g) ?? []) {
      for (const [, tag] of list.matchAll(/`([a-z][a-z0-9_]*)`/g)) used.add(tag);
    }
    for (const [, tag] of text.matchAll(/`([a-z][a-z0-9_]*)` knowledge\b/g)) used.add(tag);
  }
  // `always` is the bucket list every agent loads, not a tag.
  const unknown = [...used].filter((tag) => tag !== 'always' && !VOCABULARY.includes(tag));
  assert.deepEqual(unknown, [], 'add the tag to the knowledge skill, or use an existing one');
});

test('a skill that names this plugin\'s agents says how each host names them, or loads the knowledge skill, which does', () => {
  const HOST_NAMES = 'as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex';
  const agents = readAgents().map(({ meta }) => meta.name);
  const skill = (name) => readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
  assert.ok(skill('knowledge').includes(HOST_NAMES), 'the knowledge skill states the rule');
  for (const name of readdirSync(path.join(PLUGIN, 'skills'))) {
    const text = skill(name);
    const named = agents.filter((agent) => agent !== name && text.includes(`\`${agent}\``));
    if (!named.length) continue;
    const loadsKnowledge = /^Before you start, follow the `knowledge` skill\./m.test(text);
    assert.ok(loadsKnowledge || text.includes(HOST_NAMES), `${name} names ${named.join(', ')}`);
  }
});

test('plugin content holds no project-specific paths or leftover template markers', () => {
  const banned = [
    /docs\/ai-rules/,
    /(^|[^.\w])\.agent\//,
    /\.agents\/skills/,
    /\{\{(slot|host|provider):/,
    /consuming project/,
    /primary provider/,
    /scripts\/agent-context/,
  ];
  const hits = [];
  for (const file of allFiles(PLUGIN)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
});

// The repository names no project it came from and no person. The owner's GitHub slug appears only where a user needs it
// to install the plugin: the README, the manifests' repository URLs, and the example's marketplace source.
// The brackets keep this file from matching its own patterns; the owner comes from the manifest for the same reason.
test('no tracked file names a source project, its tracker keys, or a person', () => {
  const { repository } = json('plugins/aidrian/plugin.json');
  const slug = new URL(repository).pathname.replace(/^\/|\.git$/g, '');
  const owner = slug.split('/')[0];
  const installFiles = ['README.md', 'examples/consumer/.claude/settings.json', 'plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json'];
  const banned = [/t[a]blesit/i, /T[B]L-\d+/, /\ba[d]ri[aá]n\b/i, /q[u]intas/i];
  const hits = [];
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const text = `${file}\n${readFileSync(path.join(ROOT, file), 'utf8')}`;
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
    const outsideInstall = installFiles.includes(file) ? text.replaceAll(slug, '') : text;
    if (outsideInstall.toLowerCase().includes(owner.toLowerCase())) hits.push(`${file}: the owner's GitHub name`);
  }
  assert.deepEqual(hits, []);
});

test('only lib/project.mjs names the project folder; other plugin code asks it for paths', () => {
  const naming = allFiles(PLUGIN).filter((file) => file.endsWith('.mjs') && readFileSync(file, 'utf8').includes('.aidrian'));
  assert.deepEqual(naming.map((file) => path.relative(PLUGIN, file)), ['lib/project.mjs']);
});

test('plugin text names no bare slash command', () => {
  // Claude Code runs this plugin's skills as /aidrian:<skill>, so a bare /<name> is not a command this plugin provides.
  // Name the skill instead (it works on every host), or write /aidrian:<skill>.
  const hits = [];
  for (const file of markdownFiles(PLUGIN)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/(^|[\s`"(])\/(?!aidrian:)[a-z][a-z0-9-]*(?=[\s`"),.;:]|$)/.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the example consumer supplies only its project folder, its docs, and settings, and enables this plugin', () => {
  const example = path.join(ROOT, 'examples/consumer');
  for (const own of ['.claude/agents', '.claude/skills', '.agents/skills', '.codex/agents', 'agents', 'skills']) {
    assert.equal(existsSync(path.join(example, own)), false, `${own} belongs in the plugin`);
  }
  const outsideFolder = allFiles(example).filter((file) => file.endsWith('.json') && !file.includes(`${path.sep}.aidrian${path.sep}`));
  assert.deepEqual(outsideFolder.map((file) => path.relative(example, file)).sort(), ['.claude/settings.json', 'package.json']);
  const marketplace = json('.claude-plugin/marketplace.json').name;
  const settings = json('examples/consumer/.claude/settings.json');
  assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), [marketplace]);
  assert.deepEqual(settings.enabledPlugins, { [`aidrian@${marketplace}`]: true });
});

function allFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? allFiles(file) : [file];
  });
}

function markdownFiles(dir) {
  return allFiles(dir).filter((file) => file.endsWith('.md'));
}
