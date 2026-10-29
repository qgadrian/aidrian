import assert from 'node:assert/strict';
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
    const loads = body.match(/^Before you start, load project knowledge with the `knowledge` skill\. (.*)$/gm) ?? [];
    assert.equal(loads.length, 1, `${file}: one knowledge-loading line`);
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

test('every tag the agents and skills ask for is in the knowledge skill tag list', () => {
  assert.ok(VOCABULARY.length >= 5, 'the knowledge skill lists its tags');
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
    const loadsKnowledge = /^Before you start, load project knowledge with the `knowledge` skill\./m.test(text);
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
    /acme/i,
    /scripts\/agent-context/,
  ];
  const hits = [];
  for (const file of allFiles(PLUGIN)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
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

test('the example consumer supplies only knowledge and settings, and enables this plugin', () => {
  const example = path.join(ROOT, 'examples/consumer');
  for (const own of ['.claude/agents', '.claude/skills', '.agents/skills', '.codex/agents', 'agents', 'skills']) {
    assert.equal(existsSync(path.join(example, own)), false, `${own} belongs in the plugin`);
  }
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
