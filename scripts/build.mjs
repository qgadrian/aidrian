// Generates each host's agents from one provider-neutral source per agent.
//
//   node scripts/build.mjs           write plugins/aidrian/agents/*.md (Claude Code) and plugins/aidrian/codex/agents/*.toml
//   node scripts/build.mjs --check   exit 1 if a generated file is missing, stale (a hand edit included), or extra
//
// plugins/aidrian/agents-src/<group>/<name>.md holds an agent once: the neutral fields in NEUTRAL, and the body every host
// gets. The group folders are GROUPS. They only sort the sources: names stay unique across groups, and the output is flat.
// plugins/aidrian/providers/<provider>.json holds what one host decides per agent, such as model, effort, and tools,
// with an optional "*" entry of defaults. Each field merges on its own, most specific last: the "*" defaults, then the
// `access` shortcut, then the agent's own entry, which can extend or replace what the shortcut set. A project's `models`
// config applies after all of these, at run time (docs/config.md#models). docs/agent-sources.md describes the layout.
//
// Claude Code loads plugins/aidrian/agents/*.md from the plugin. A subfolder there would become part of the agent's name,
// agents/build/x.md as aidrian:build:x, so the build writes none. Codex cannot load agents from a plugin, so each agent
// becomes a standalone TOML role that plugins/aidrian/codex/install-agents.mjs copies into ~/.codex/agents/.
// Text only one host needs goes in plugins/aidrian/agent-addons/<name>.<provider>.md, after the body in that host's agent.
// Adding a host takes a providers/<name>.json and an entry in GENERATORS.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const SOURCES = path.join(PLUGIN, 'agents-src');
const PROVIDERS = path.join(PLUGIN, 'providers');
const ADDONS = path.join(PLUGIN, 'agent-addons');
const SKILLS = path.join(PLUGIN, 'skills');
export const CLAUDE_AGENTS = path.join(PLUGIN, 'agents');
export const CODEX_AGENTS = path.join(PLUGIN, 'codex/agents');
export const PREFIX = 'aidrian-';
const rel = (file) => path.relative(ROOT, file);

// The fields an agent source may set. Whatever one host decides belongs in that host's providers/<name>.json.
export const NEUTRAL = ['name', 'description', 'access', 'skills'];

// The agents-src/ folders, in the order docs/agents-and-skills.md lists them, each with its table heading there.
export const GROUPS = {
  coordination: 'Coordination',
  planning: 'Planning',
  build: 'Build',
  review: 'Review and quality',
  'product-design': 'Product and design',
  'support-growth': 'Support and growth',
  harness: 'Harness',
};
const ACCESS = ['read-only', 'write'];
const FILE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

// A provider's model or tool name in a neutral field ties the agent to that provider. Tool names that are also English
// words count only as a whole value or in backticks, so "Read-only code review" and "Write a plan" stay neutral.
const MODEL_NAMES = /\b(?:opus|sonnet|haiku|fable|mythos|claude-[\w.-]+|gpt-[\w.-]+|codex-[\w.-]+|o[134](?:-mini)?)\b/i;
const TOOL_NAMES = /\b(?:Bash|NotebookEdit|MultiEdit|WebFetch|WebSearch|TodoWrite|SendMessage|ToolSearch|Glob|Grep|apply_patch|update_plan|exec_command|spawn_agent|view_image)\b|\bmcp__\w+/;
const WORD_NAMES = ['Read', 'Write', 'Edit', 'Agent', 'Skill', 'Task', 'shell', 'inherit'];

// The provider names in one neutral frontmatter value, a string or a list of them.
export function providerNames(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string').flatMap((text) => [
    ...[MODEL_NAMES, TOOL_NAMES].map((pattern) => pattern.exec(text)?.[0]).filter(Boolean),
    ...WORD_NAMES.filter((word) => text === word || text.includes(`\`${word}\``)),
  ]);
}

// Each agent source with its add-ons: { file, group, meta, body, addons: { <provider>: text } }, where file is the path
// under agents-src/, such as build/doc-updater.md.
export function readAgents({ sourcesDir = SOURCES, addonsDir = ADDONS, skillsDir = SKILLS } = {}) {
  const agents = sourceFiles(sourcesDir)
    .map((file) => {
      const text = readFileSync(path.join(sourcesDir, file), 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error(`agents-src/${file}: missing frontmatter`);
      const agent = { file, group: path.dirname(file), meta: parseYaml(match[1]) ?? {}, body: match[2].trim(), addons: {} };
      checkSource(agent, skillsDir);
      return agent;
    });
  const byName = new Map(agents.map((agent) => [agent.meta.name, agent]));
  const hosts = Object.keys(GENERATORS);
  for (const file of existsSync(addonsDir) ? readdirSync(addonsDir).sort() : []) {
    const [, name, host] = /^(.+)\.([a-z]+)\.md$/.exec(file) ?? [];
    const where = `agent-addons/${file}`;
    if (!byName.has(name) || !host) throw new Error(`${where}: name it <agent>.<provider>.md after an agent in agents-src/`);
    if (!hosts.includes(host)) throw new Error(`${where}: no ${host} agents are generated; the providers are ${hosts.join(', ')}`);
    byName.get(name).addons[host] = readFileSync(path.join(addonsDir, file), 'utf8').trim();
  }
  return agents;
}

// The sources as <group>/<name>.md, sorted by name, which is the order the Codex preamble names other agents in.
function sourceFiles(sourcesDir) {
  const groups = Object.keys(GROUPS);
  for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith('.md')) throw new Error(`agents-src/${entry.name}: move it into a group folder (${groups.join(', ')})`);
    if (entry.isDirectory() && !groups.includes(entry.name)) {
      throw new Error(`agents-src/${entry.name}/ is not a group (${groups.join(', ')}); add it to GROUPS in scripts/build.mjs and to docs/agents-and-skills.md`);
    }
  }
  const byName = new Map();
  for (const group of groups.filter((name) => existsSync(path.join(sourcesDir, name)))) {
    for (const entry of readdirSync(path.join(sourcesDir, group), { withFileTypes: true })) {
      const file = `${group}/${entry.name}`;
      if (entry.isDirectory()) throw new Error(`agents-src/${file}/: a group holds agent files, not folders`);
      if (!entry.name.endsWith('.md')) continue;
      if (byName.has(entry.name)) throw new Error(`agents-src/${byName.get(entry.name)} and agents-src/${file}: an agent name is unique across groups`);
      byName.set(entry.name, file);
    }
  }
  return [...byName.keys()].sort().map((name) => byName.get(name));
}

function checkSource({ file, meta }, skillsDir) {
  const where = `agents-src/${file}`;
  for (const key of Object.keys(meta)) {
    if (!NEUTRAL.includes(key)) throw new Error(`${where}: "${key}" is not a neutral field (${NEUTRAL.join(', ')}); a host setting goes in providers/<provider>.json`);
  }
  if (meta.name !== path.basename(file, '.md')) throw new Error(`${where}: name must be "${path.basename(file, '.md')}", the file name`);
  if (typeof meta.description !== 'string' || !meta.description.trim()) throw new Error(`${where}: no description`);
  if (!ACCESS.includes(meta.access)) throw new Error(`${where}: access must be ${ACCESS.join(' or ')}`);
  if (meta.skills !== undefined && !(Array.isArray(meta.skills) && meta.skills.every((skill) => typeof skill === 'string'))) {
    throw new Error(`${where}: skills must be a list of skill names`);
  }
  for (const key of NEUTRAL) {
    const names = providerNames(meta[key]);
    if (names.length) throw new Error(`${where}: ${key} names ${names.join(', ')}, which belongs to one provider; put it in providers/<provider>.json`);
  }
  for (const skill of meta.skills ?? []) {
    if (!existsSync(path.join(skillsDir, skill, 'SKILL.md'))) throw new Error(`${where}: no skill "${skill}" in plugins/aidrian/skills/`);
  }
}

// Each provider's file: { <provider>: { defaults, entries: { <agent>: settings } } }.
export function readProviders({ providersDir = PROVIDERS, agents = readAgents() } = {}) {
  const names = new Set(agents.map((agent) => agent.meta.name));
  const files = readdirSync(providersDir).filter((file) => file.endsWith('.json')).sort();
  const out = {};
  for (const file of files) {
    const provider = file.replace(/\.json$/, '');
    const where = `providers/${file}`;
    const generator = GENERATORS[provider];
    if (!generator) throw new Error(`${where}: no ${provider} generator in scripts/build.mjs; the providers are ${Object.keys(GENERATORS).join(', ')}`);
    const data = JSON.parse(readFileSync(path.join(providersDir, file), 'utf8'));
    if (!isPlainObject(data)) throw new Error(`${where}: must be an object of agent entries`);
    for (const [name, entry] of Object.entries(data)) {
      if (name !== '*' && !names.has(name)) throw new Error(`${where}: "${name}" is not an agent in agents-src/`);
      if (!isPlainObject(entry)) throw new Error(`${where}: "${name}" must be an object of ${provider} fields`);
      for (const field of Object.keys(entry)) {
        if (generator.owned.includes(field)) throw new Error(`${where}: "${name}" sets ${field}, which the build writes from agents-src/`);
        if (!generator.fields.includes(field)) throw new Error(`${where}: "${name}" sets ${field}, which is not a ${provider} field this build supports (${generator.fields.join(', ')})`);
      }
    }
    const { '*': defaults = {}, ...entries } = data;
    out[provider] = { defaults, entries };
  }
  for (const provider of Object.keys(GENERATORS)) if (!out[provider]) throw new Error(`providers/${provider}.json is missing`);
  return out;
}

// One agent's settings for one provider, merged one field at a time: defaults, the access shortcut, the agent's entry.
export function agentSettings(provider, { file, meta }, { defaults = {}, entries = {} } = {}) {
  const generator = GENERATORS[provider];
  const settings = { ...defaults, ...generator.shortcut[meta.access], ...(Object.hasOwn(entries, meta.name) ? entries[meta.name] : {}) };
  const problem = generator.accessProblem?.(meta.access, settings);
  if (problem) throw new Error(`providers/${provider}.json: ${meta.name} (agents-src/${file}): ${problem}`);
  return settings;
}

// The files one provider should have, keyed by file name.
export function renderAgents(provider, agents = readAgents(), config = readProviders({ agents })[provider]) {
  const generator = GENERATORS[provider];
  const names = agents.map((agent) => agent.meta.name);
  return new Map(agents.map((agent) => [generator.fileName(agent.meta.name), generator.render(agent, agentSettings(provider, agent, config), names)]));
}

// Claude Code: the frontmatter fields a provider entry may set, in the order they are written. A plugin agent ignores
// hooks, mcpServers, permissionMode, and initialPrompt, so they are not here.
const CLAUDE_FIELDS = ['model', 'effort', 'color', 'tools', 'disallowedTools', 'maxTurns', 'autoCompactWindow', 'memory', 'background', 'omitClaudeMd', 'isolation', 'experimental'];

function renderClaudeAgent({ file, meta, body, addons }, settings) {
  const fields = { name: meta.name, description: meta.description };
  for (const field of CLAUDE_FIELDS) if (settings[field] !== undefined) fields[field] = settings[field];
  // Claude Code names a plugin's skills <plugin>:<skill>.
  if (meta.skills?.length) fields.skills = meta.skills.map((skill) => `aidrian:${skill}`);
  const yaml = Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n');
  if (!isDeepStrictEqual(parseYaml(yaml), fields)) throw new Error(`agents-src/${file}: its Claude Code frontmatter does not read back as written`);
  const text = addons.claude ? `${body}\n\n${addons.claude}` : body;
  return `---\n# Generated by scripts/build.mjs from plugins/aidrian/agents-src/${file} and providers/claude.json. Do not edit.\n${yaml}\n---\n\n${text}\n`;
}

// A frontmatter value as one line of YAML: a plain scalar where YAML reads it back unchanged, else a quoted one.
function yamlValue(value, flow = false) {
  if (Array.isArray(value)) return `[${value.map((item) => yamlValue(item, true)).join(', ')}]`;
  if (isPlainObject(value)) return `{${Object.entries(value).map(([key, item]) => `${yamlValue(key, true)}: ${yamlValue(item, true)}`).join(', ')}}`;
  if (typeof value !== 'string') return String(value);
  const plain = value !== '' && !/^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: | #|:$/.test(value) && !(flow && /[,[\]{}]/.test(value));
  return plain && parseYaml(`v: ${value}`).v === value ? value : JSON.stringify(value);
}

function claudeAccessProblem(access, { tools, disallowedTools }) {
  const denied = toList(disallowedTools);
  const allowed = tools === undefined ? null : toList(tools);
  const usable = FILE_TOOLS.filter((tool) => !denied.includes(tool) && (!allowed || allowed.includes(tool)));
  if (access === 'read-only' && usable.length) return `access is read-only, but its tools still include ${usable.join(', ')}`;
  if (access === 'write' && !usable.includes('Write') && !usable.includes('Edit')) return 'access is write, but its tools include neither Write nor Edit';
  return null;
}

// Codex: the role fields a provider entry may set. A role cannot set sandbox_mode, approval_policy, or mcp_servers;
// a spawned agent keeps the parent session's.
const CODEX_FIELDS = ['model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'features', 'skills'];

function renderCodexAgent({ file, meta, body, addons }, settings, pluginAgents) {
  const { model, model_reasoning_effort: effort, ...rest } = settings;
  const text = addons.codex ? `${body}\n\n${addons.codex}` : body;
  const instructions = `${codexPreamble(meta, text, pluginAgents)}\n\n${text}`;
  const lines = [
    `# Generated by scripts/build.mjs from plugins/aidrian/agents-src/${file} and providers/codex.json. Do not edit.`,
    model === undefined ? "# This role inherits the Codex session's model." : "# providers/codex.json sets this role's model.",
    `name = ${basicString(PREFIX + meta.name)}`,
    `description = ${basicString(meta.description)}`,
    ...(model === undefined ? [] : [`model = ${basicString(model)}`]),
    ...(effort === undefined ? [] : [`model_reasoning_effort = ${basicString(effort)}`]),
    `developer_instructions = """`,
    multilineBody(instructions),
    `"""`,
    // Any other field, tables included, after the instructions: TOML keeps a table's keys until the next header.
    ...(Object.keys(rest).length ? [stringifyToml(rest).trimEnd()] : []),
    '',
  ];
  const role = lines.join('\n');
  const expected = { name: PREFIX + meta.name, description: meta.description.replace(/\s+/g, ' ').trim(), ...settings, developer_instructions: `${instructions}\n` };
  // smol-toml returns objects without a prototype; JSON gives both sides the same kind of object.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  if (!isDeepStrictEqual(plain(parseToml(role)), plain(expected))) throw new Error(`agents-src/${file}: its Codex role does not read back as written`);
  return role;
}

function codexPreamble(meta, body, pluginAgents) {
  const lines = ['This role comes from the aidrian plugin and was written for Claude Code. On Codex:'];
  // Only this plugin's agents carry the prefix. A project's own roles, such as `frontend-developer`, keep their names.
  const named = pluginAgents.filter((name) => name !== meta.name && namesAgent(body, name));
  if (named.length) {
    const renames = named.map((name) => `\`${name}\` is \`${PREFIX}${name}\``).join(', ');
    lines.push(`- This plugin's agents named below have Codex names: ${renames}. Spawn them by those names; any other agent named below is the project's own.`);
  }
  lines.push(
    '- `Agent` or `subagent_type` means spawn that Codex agent, `SendMessage` means follow up with it, and the `Skill` tool means load the named skill.',
    '- Claude tool names such as `Read`, `Grep`, `Glob`, `Edit`, `Write`, and `Bash` mean your equivalent file and shell tools.',
  );
  // The access shortcut for Codex. A role cannot set its own sandbox, so the instructions carry it.
  if (meta.access === 'read-only') lines.push('- Do not create or edit files directly; change the repository only through the commands these instructions allow.');
  return lines.join('\n');
}

// Some agents share a name with a skill. "The `agent-issue-writer` skill" or "the skill `agent-issue-writer`" names
// the skill, which keeps its name on Codex; any other backticked use of the name is the agent.
function namesAgent(body, name) {
  return new RegExp(`(?<!skill )\`${name}\`(?! skill\\b)`).test(body);
}

// Each provider: where its agents go, the fields its entries may set, the fields the build owns, what `access` sets,
// and how one agent is written.
const GENERATORS = {
  claude: {
    label: 'Claude Code',
    dir: CLAUDE_AGENTS,
    fileName: (name) => `${name}.md`,
    fields: CLAUDE_FIELDS,
    owned: ['name', 'description', 'skills'],
    shortcut: { 'read-only': { disallowedTools: FILE_TOOLS } },
    accessProblem: claudeAccessProblem,
    render: renderClaudeAgent,
  },
  codex: {
    label: 'Codex',
    dir: CODEX_AGENTS,
    fileName: (name) => `${PREFIX}${name}.toml`,
    fields: CODEX_FIELDS,
    owned: ['name', 'description', 'developer_instructions'],
    // read-only is a line in codexPreamble, not a role field.
    shortcut: {},
    render: renderCodexAgent,
  },
};

export const PROVIDER_NAMES = Object.keys(GENERATORS);

// What differs between one provider's folder and the files it should have. Any subfolder is extra: Claude Code would load
// an agent in one under another name.
export function compareGenerated(provider, expected = renderAgents(provider), dir = GENERATORS[provider].dir) {
  const ext = path.extname(GENERATORS[provider].fileName('x'));
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  const actual = entries.filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name);
  const problems = [];
  for (const [file, text] of expected) {
    if (!actual.includes(file)) problems.push(`missing ${rel(path.join(dir, file))}`);
    else if (readFileSync(path.join(dir, file), 'utf8') !== text) problems.push(`stale ${rel(path.join(dir, file))}`);
  }
  for (const file of actual) if (!expected.has(file)) problems.push(`extra ${rel(path.join(dir, file))}`);
  for (const entry of entries) if (entry.isDirectory()) problems.push(`extra ${rel(path.join(dir, entry.name))}/`);
  return problems;
}

function toList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : String(value).split(',').map((item) => item.trim());
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function basicString(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

// Body of a TOML multi-line basic string: escape backslashes and any run of three quotes.
function multilineBody(text) {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error('agent text contains a control character');
  return text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
}

function main(args) {
  // Any other argument fails: a mistyped --check must not fall through to regenerating the files.
  const unknown = args.find((arg) => arg !== '--check');
  if (unknown !== undefined) {
    console.error(`usage: node scripts/build.mjs [--check]\nunknown argument: ${unknown}`);
    process.exit(1);
  }
  const agents = readAgents();
  const providers = readProviders({ agents });
  const outputs = PROVIDER_NAMES.map((provider) => ({ provider, ...GENERATORS[provider], files: renderAgents(provider, agents, providers[provider]) }));
  const counted = outputs.map(({ label, files }) => `${files.size} ${label} agents`).join(' and ');
  if (args.includes('--check')) {
    const problems = outputs.flatMap(({ provider, files }) => compareGenerated(provider, files));
    if (problems.length) {
      console.error(`Generated agents are out of date; edit agents-src/ or providers/, then run npm run build:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`ok: ${counted} are current`);
    return;
  }
  for (const { dir, files } of outputs) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of files) writeFileSync(path.join(dir, file), text);
  }
  console.log(`wrote ${counted}`);
}

// Run only as the entry script. process.argv[1] is unset under `node -e` and need not be a file under `node -p`.
// import.meta.url has symlinks resolved, so resolve the entry path too, or a symlinked --check passes having checked nothing.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) main(process.argv.slice(2));
