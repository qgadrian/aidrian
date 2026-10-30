// Loads config.json from the project folder: the folder version and the project's settings for this plugin.
// docs/config.md lists the keys; docs/project-folder.md gives the version rule.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { agentNameProblem, patternProblem } from './agent-gates.mjs';
import { isFile, isObject, readJson } from './fs.mjs';

// The project folder format this plugin reads. A format change raises it and documents the migration.
export const VERSION = 1;

// The `github.reviewer` that turns the review bot off, as null does.
export const NO_REVIEWER = 'none';

// The keys of the `git` group: the repository's branches, worktrees, checkout, and commits.
const GIT_SCHEMA = {
  defaultBranch: 'text',
  worktrees: { dir: 'text', bootstrap: 'textOrNull', disposable: 'folderNames' },
  mainCheckout: { guard: 'boolean', allowWrites: 'texts' },
  commits: { types: 'texts' },
};

// Deprecated: before the `git` group, its keys sat at the top level. loadConfig still reads them there, under the same
// names and checks, and a `git.*` value wins over its top-level one, key by key. docs/config.md#deprecated-top-level-git-keys.
export const LEGACY_GIT_KEYS = Object.freeze(Object.keys(GIT_SCHEMA));

// The type of every key. A nested object is one group of keys; a project sets any subset of a group.
const SCHEMA = {
  git: GIT_SCHEMA,
  state: { dir: 'textOrNull' },
  github: { requiredSections: 'texts', reviewer: 'textOrNull', maxReviewRounds: 'positive', requiredChecks: 'texts', ignoreCancelledChecks: 'texts', conditionalChecks: 'texts' },
  docs: { wrapLimit: 'zeroOrMore' },
  knowledge: { budgets: { alwaysBytes: 'positive', taggedDocBytes: 'positive' } },
  skills: { descriptionChars: 'positive', listingBytes: 'positive' },
  session: { handoff: 'handoffMode', maxTokens: 'zeroOrMore', maxCalls: 'zeroOrMore', maxHours: 'zeroOrMore' },
  lessons: { auto: 'boolean', maxOpen: 'zeroOrMore', maxAgeDays: 'zeroOrMore' },
  models: 'models',
  names: { human: 'text', ai: 'textOrNull' },
  telemetry: {
    enabled: 'boolean',
    docReads: 'boolean',
    hookDenies: 'boolean',
    maxMb: 'positive',
    health: {
      minSample: 'positive',
      redispatchPercent: 'percent',
      sentBackPercent: 'percent',
      topDocPercent: 'percent',
      reviewRounds: 'positive',
      lateFindingPercent: 'percent',
      denyHotSpot: 'positive',
      costRisePercent: 'positive',
    },
  },
  agents: 'agents',
};

// Keys a format change renamed or moved, old name to new; a key inside a group is named with its group, "group.key".
// A config that still uses the old name gets an error naming the new one.
const RENAMED = {
  pr: 'github',
  'docs.alwaysBudgetBytes': 'knowledge.budgets.alwaysBytes',
  'telemetry.doc_reads': 'telemetry.docReads',
  'telemetry.hook_denies': 'telemetry.hookDenies',
  'telemetry.max_mb': 'telemetry.maxMb',
};

// What `models` may set for one of this plugin's agents, per host; null takes any non-empty string.
// Claude Code's Agent tool takes only these model aliases. Codex reads any model name and names these efforts.
// docs/config.md#models cites both.
const MODEL_CHOICES = {
  claude: { model: ['sonnet', 'opus', 'haiku', 'fable'], effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { model: null, effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'] },
};

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const TYPES = {
  text: [isText, 'a non-empty string'],
  textOrNull: [(value) => value === null || isText(value), 'a non-empty string or null'],
  texts: [(value) => Array.isArray(value) && value.every(isText), 'a list of non-empty strings'],
  folderNames: [
    (value) => Array.isArray(value) && value.every((name) => isText(name) && !/[/\\]/u.test(name) && name !== '.' && name !== '..'),
    'a list of folder names with no "/", such as "node_modules"',
  ],
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  positive: [(value) => Number.isInteger(value) && value > 0, 'a whole number above 0'],
  percent: [(value) => Number.isInteger(value) && value > 0 && value <= 100, 'a whole number from 1 to 100'],
  zeroOrMore: [(value) => Number.isInteger(value) && value >= 0, 'a whole number, 0 or more'],
  handoffMode: [(value) => ['off', 'ask', 'auto'].includes(value), '"off", "ask", or "auto"'],
};

// `state.dir: null` is the per-project folder under `$XDG_STATE_HOME` (lib/project.mjs). Task worktrees sit beside the
// repository's files, where editors and agents expect them; the guard is off until a project opts in.
// `git.worktrees.disposable` names the folders of installed packages, build output, and caches, which a worktree cleanup
// may delete without asking (lib/worktree.mjs).
// `names.ai: null` is the host's own name, which only the running hook knows. `github.reviewer: null`, or "none", which
// loadConfig reads as null, runs no review bot: `aidrian pr await-review` then waits for nothing.
export const DEFAULTS = deepFreeze({
  git: {
    defaultBranch: 'main',
    worktrees: { dir: '.worktrees', bootstrap: null, disposable: ['node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.turbo'] },
    mainCheckout: { guard: false, allowWrites: [] },
    commits: { types: ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'] },
  },
  state: { dir: null },
  github: {
    requiredSections: ['Summary', 'Tests run'],
    reviewer: 'chatgpt-codex-connector[bot]',
    maxReviewRounds: 3,
    requiredChecks: [],
    ignoreCancelledChecks: [],
    conditionalChecks: [],
  },
  docs: { wrapLimit: 155 },
  knowledge: { budgets: { alwaysBytes: 16384, taggedDocBytes: 24576 } },
  skills: { descriptionChars: 160, listingBytes: 9216 },
  session: { handoff: 'ask', maxTokens: 150000, maxCalls: 250, maxHours: 4 },
  lessons: { auto: true, maxOpen: 20, maxAgeDays: 14 },
  models: { claude: { agents: {} }, codex: { agents: {} } },
  names: { human: 'the Human', ai: null },
  telemetry: {
    enabled: true,
    docReads: true,
    hookDenies: true,
    maxMb: 20,
    // The thresholds of `aidrian report health` (report-health.mjs). A signal with fewer than minSample samples is not judged.
    health: {
      minSample: 5,
      redispatchPercent: 20,
      sentBackPercent: 10,
      topDocPercent: 50,
      reviewRounds: 3,
      lateFindingPercent: 50,
      denyHotSpot: 5,
      costRisePercent: 50,
    },
  },
  agents: {},
});

// Returns { config, errors, current }. `config` is frozen and always complete: the file's values over DEFAULTS, one
// group at a time, with the default kept for any value that is missing or invalid. The local file's `models`, `names`,
// `telemetry`, and `agents` (`project.localModels`, `project.localNames`, `project.localTelemetry`, `project.localAgents`) then
// go over the file's. A hook can use it even when `errors` is not empty. `current` is false when the file is missing,
// unreadable, or of another version: then nothing in the folder
// can be trusted to have the shape this plugin reads.
export function loadConfig(project) {
  const errors = [];
  const file = project.paths.config;
  const raw = readJson(project.root, file, errors);
  if (!raw) return { config: DEFAULTS, errors, current: false };
  const problem = versionProblem(file, raw.version);
  if (problem) return { config: DEFAULTS, errors: [problem], current: false };
  const { version, ...values } = raw;
  // The deprecated top-level git keys go over the defaults first; `git.*` then goes over them, key by key.
  const legacy = Object.fromEntries(LEGACY_GIT_KEYS.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
  for (const key of LEGACY_GIT_KEYS) delete values[key];
  const gitBase = merge(GIT_SCHEMA, DEFAULTS.git, legacy, '', file, errors);
  const config = merge(SCHEMA, { ...DEFAULTS, git: gitBase }, values, '', file, errors);
  if (config.github.reviewer === NO_REVIEWER) config.github = { ...config.github, reviewer: null };
  if (project.localModels !== undefined) config.models = checkModels(project.localModels, project.paths.local, errors, config.models);
  for (const [key, local] of [['names', project.localNames], ['telemetry', project.localTelemetry]]) {
    if (local !== undefined) config[key] = merge({ [key]: SCHEMA[key] }, config, { [key]: local }, '', project.paths.local, errors)[key];
  }
  if (project.localAgents !== undefined) config.agents = checkAgents(project.localAgents, project.paths.local, errors, config.agents);
  return { config: deepFreeze(config), errors, current: true };
}

// The `code` of the error commandConfig throws; cli.mjs prints its message and exits with its `exitCode`.
export const CONFIG_ERROR = 'ERR_AIDRIAN_CONFIG';

// The config an `aidrian` command acts on. When loadConfig reports errors, the command must not run on defaults the
// project did not choose, so this throws: the message lists the errors, and `exitCode` is the command's error code.
// A project with no config.json yet runs on DEFAULTS. Hooks call loadConfig instead: a broken config never stops a session.
export function commandConfig(project, { exitCode = 1 } = {}) {
  const { config, errors } = loadConfig(project);
  if (!errors.length || !isFile(path.join(project.root, project.paths.config))) return config;
  throw Object.assign(new Error(errors.join('\n')), { code: CONFIG_ERROR, exitCode });
}

// The error for a `version` other than VERSION, or null.
export function versionProblem(file, version) {
  if (version === VERSION) return null;
  const found = version === undefined ? 'missing' : JSON.stringify(version);
  return `${file}: project folder version ${found}; this plugin reads version ${VERSION}; see ${migratingUrl()}`;
}

// The migration notes in the repository the plugin's manifest names, so a fork links to its own.
function migratingUrl() {
  const { repository } = JSON.parse(readFileSync(path.join(import.meta.dirname, '../plugin.json'), 'utf8'));
  return `${repository}/blob/main/docs/project-folder.md#migrating`;
}

function merge(schema, defaults, values, prefix, file, errors) {
  for (const key of Object.keys(values)) {
    const name = `${prefix}${key}`;
    if (Object.hasOwn(RENAMED, name)) errors.push(`${file}: "${name}" is now "${RENAMED[name]}": rename the key`);
    else if (!Object.hasOwn(schema, key)) errors.push(`${file}: unknown key "${name}"`);
  }
  const out = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = values[key];
    out[key] = defaults[key];
    if (!Object.hasOwn(values, key)) continue;
    if (typeof type === 'object') {
      if (isObject(value)) out[key] = merge(type, defaults[key], value, `${prefix}${key}.`, file, errors);
      else errors.push(`${file}: "${prefix}${key}" must be an object`);
    } else if (type === 'models') {
      out[key] = checkModels(value, file, errors, defaults[key]);
    } else if (type === 'agents') {
      out[key] = checkAgents(value, file, errors, defaults[key]);
    } else if (TYPES[type][0](value)) {
      out[key] = value;
    } else {
      errors.push(`${file}: "${prefix}${key}" must be ${TYPES[type][1]}`);
    }
  }
  return out;
}

// `models` from one file over `base`, per host, agent, and field: { claude: { agents }, codex: { agents } }.
// A bad host, agent, or value is an error and is left out, so the rest still applies.
function checkModels(value, file, errors, base) {
  const out = Object.fromEntries(Object.keys(MODEL_CHOICES).map((host) => [host, { agents: { ...base[host].agents } }]));
  if (!isObject(value)) {
    errors.push(`${file}: "models" must be an object`);
    return out;
  }
  for (const [host, groups] of Object.entries(value)) {
    const at = `models.${host}`;
    if (!Object.hasOwn(MODEL_CHOICES, host)) errors.push(`${file}: unknown key "${at}"`);
    else if (!isObject(groups)) errors.push(`${file}: "${at}" must be an object`);
    else {
      for (const [key, agents] of Object.entries(groups)) {
        if (key === 'skills') errors.push(`${file}: "${at}.skills" is not supported: neither host lets a project set a plugin skill's model or effort`);
        else if (key !== 'agents') errors.push(`${file}: unknown key "${at}.${key}"`);
        else if (!isObject(agents)) errors.push(`${file}: "${at}.agents" must be an object`);
        else for (const [name, choice] of Object.entries(agents)) checkAgentChoice(host, name, choice, out[host].agents, file, errors);
      }
    }
  }
  return out;
}

function checkAgentChoice(host, name, choice, agents, file, errors) {
  const at = `models.${host}.agents.${name}`;
  if (!pluginAgents().includes(name)) {
    errors.push(`${file}: unknown agent "${at}"; the plugin's agents are ${pluginAgents().join(', ')}`);
    return;
  }
  if (!isObject(choice)) {
    errors.push(`${file}: "${at}" must be an object with "model", "effort", or both`);
    return;
  }
  const kept = {};
  for (const [field, setting] of Object.entries(choice)) {
    const allowed = Object.hasOwn(MODEL_CHOICES[host], field) ? MODEL_CHOICES[host][field] : undefined;
    if (allowed === undefined) errors.push(`${file}: unknown key "${at}.${field}"`);
    else if (allowed === null ? isText(setting) : allowed.includes(setting)) kept[field] = setting;
    else errors.push(`${file}: "${at}.${field}" must be ${allowed === null ? 'a non-empty string' : oneOf(allowed)}`);
  }
  if (Object.keys(kept).length) agents[name] = { ...agents[name], ...kept };
}

// `agents` from one file over `base`, per agent and list: { <name>: { deny, allow } }, each a list of tool patterns.
// A file's `deny` or `allow` for an agent replaces the one below it. A bad name, key, or pattern is an error and is left
// out, so the rest still applies; a pattern left out of `allow` only makes the list stricter.
function checkAgents(value, file, errors, base) {
  const out = { ...base };
  if (!isObject(value)) {
    errors.push(`${file}: "agents" must be an object`);
    return out;
  }
  for (const [name, gates] of Object.entries(value)) {
    const at = `agents.${name}`;
    const problem = agentNameProblem(name);
    if (problem) errors.push(`${file}: "${at}": ${problem}`);
    else if (!isObject(gates)) errors.push(`${file}: "${at}" must be an object with "deny", "allow", or both`);
    else {
      const kept = {};
      for (const [list, patterns] of Object.entries(gates)) {
        if (list !== 'deny' && list !== 'allow') errors.push(`${file}: unknown key "${at}.${list}"`);
        else if (!Array.isArray(patterns)) errors.push(`${file}: "${at}.${list}" must be a list of tool patterns`);
        else kept[list] = patterns.filter((pattern) => !patternError(pattern, `${at}.${list}`, file, errors));
      }
      if (Object.keys(kept).length) out[name] = { ...out[name], ...kept };
    }
  }
  return out;
}

function patternError(pattern, at, file, errors) {
  const problem = patternProblem(pattern);
  if (problem) errors.push(`${file}: "${at}" has ${JSON.stringify(pattern)}: ${problem}`);
  return problem;
}

// The plugin's agent names, from the agent files it ships beside this folder.
let agentNames;
function pluginAgents() {
  agentNames ??= readdirSync(path.join(import.meta.dirname, '../agents'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
  return agentNames;
}

const oneOf = (list) => `${list.slice(0, -1).map((each) => JSON.stringify(each)).join(', ')}, or ${JSON.stringify(list.at(-1))}`;

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
