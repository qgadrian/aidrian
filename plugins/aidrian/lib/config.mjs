// Loads config.json from the project folder: the folder version and the project's settings for this plugin.
// docs/config.md lists the keys; docs/project-folder.md gives the version rule.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// The project folder format this plugin reads. A format change raises it and documents the migration.
export const VERSION = 1;

// The type of every key. A nested object is one group of keys; a project sets any subset of a group.
const SCHEMA = {
  defaultBranch: 'text',
  state: { dir: 'textOrNull' },
  worktrees: { dir: 'text', bootstrap: 'textOrNull' },
  mainCheckout: { guard: 'boolean', allowWrites: 'texts' },
  commits: { types: 'texts' },
  pr: { requiredSections: 'texts', reviewer: 'text', maxReviewRounds: 'positive', requiredChecks: 'texts', ignoreCancelledChecks: 'texts' },
  docs: { wrapLimit: 'zeroOrMore', alwaysBudgetBytes: 'positive' },
  skills: { descriptionChars: 'positive', listingBytes: 'positive' },
  session: { handoff: 'handoffMode', maxTokens: 'zeroOrMore', maxCalls: 'zeroOrMore', maxHours: 'zeroOrMore' },
  models: 'models',
  names: { human: 'text', ai: 'textOrNull' },
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
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  positive: [(value) => Number.isInteger(value) && value > 0, 'a whole number above 0'],
  zeroOrMore: [(value) => Number.isInteger(value) && value >= 0, 'a whole number, 0 or more'],
  handoffMode: [(value) => ['off', 'ask', 'auto'].includes(value), '"off", "ask", or "auto"'],
};

// `state.dir: null` is the per-project folder under `$XDG_STATE_HOME` (lib/project.mjs). Task worktrees sit beside the
// repository's files, where editors and agents expect them; the guard is off until a project opts in.
// `names.ai: null` is the host's own name, which only the running hook knows.
export const DEFAULTS = deepFreeze({
  defaultBranch: 'main',
  state: { dir: null },
  worktrees: { dir: '.worktrees', bootstrap: null },
  mainCheckout: { guard: false, allowWrites: [] },
  commits: { types: ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'] },
  pr: {
    requiredSections: ['Summary', 'Tests run'],
    reviewer: 'chatgpt-codex-connector[bot]',
    maxReviewRounds: 10,
    requiredChecks: [],
    ignoreCancelledChecks: [],
  },
  docs: { wrapLimit: 155, alwaysBudgetBytes: 40000 },
  skills: { descriptionChars: 160, listingBytes: 9216 },
  session: { handoff: 'ask', maxTokens: 150000, maxCalls: 250, maxHours: 4 },
  models: { claude: { agents: {} }, codex: { agents: {} } },
  names: { human: 'the Human', ai: null },
});

// Returns { config, errors, current }. `config` is frozen and always complete: the file's values over DEFAULTS, one
// group at a time, with the default kept for any value that is missing or invalid. The local file's `models` and
// `names` (`project.localModels`, `project.localNames`) then go over the file's. A hook can use it even when `errors` is
// not empty. `current` is false when the file is missing, unreadable, or of another version: then nothing in the folder
// can be trusted to have the shape this plugin reads.
export function loadConfig(project) {
  const errors = [];
  const file = project.paths.config;
  const raw = readJson(project.root, file, errors);
  if (!raw) return { config: DEFAULTS, errors, current: false };
  const problem = versionProblem(file, raw.version);
  if (problem) return { config: DEFAULTS, errors: [problem], current: false };
  const { version, ...values } = raw;
  const config = merge(SCHEMA, DEFAULTS, values, '', file, errors);
  if (project.localModels !== undefined) config.models = checkModels(project.localModels, project.paths.local, errors, config.models);
  if (project.localNames !== undefined) {
    config.names = merge({ names: SCHEMA.names }, config, { names: project.localNames }, '', project.paths.local, errors).names;
  }
  return { config: deepFreeze(config), errors, current: true };
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
    if (!Object.hasOwn(schema, key)) errors.push(`${file}: unknown key "${prefix}${key}"`);
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

// File helpers, shared with project.mjs and knowledge.mjs. Paths are relative to `root`.

// The parsed JSON object at `rel`, or null with the reason added to `errors`. `scope` names `root` in that reason.
export function readJson(root, rel, errors, scope = 'the project') {
  const file = path.join(root, rel);
  if (!isFile(file)) {
    errors.push(`${rel}: not found`);
    return null;
  }
  if (linksOutside(root, rel)) {
    errors.push(`${rel}: links outside ${scope}`);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (isObject(value)) return value;
    errors.push(`${rel}: must be a JSON object`);
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${error.message})`);
  }
  return null;
}

// True when `rel`, with symlinks resolved, lies outside the folder `within` (both relative to `root`; `within` is the
// project when empty). A path that does not exist yet is judged where a write would create it: below its nearest
// existing folder, with that folder's symlinks resolved. A broken symlink on the way counts as outside.
export function linksOutside(root, rel, within = '') {
  const real = resolvedPath(path.join(root, rel));
  const realWithin = resolvedPath(path.join(root, within));
  return real === null || realWithin === null || (real !== realWithin && !real.startsWith(`${realWithin}${path.sep}`));
}

// `file` with every symlink resolved: the real path of its nearest existing part, then the parts that do not exist yet.
// Null when that part is a broken symlink, whose target a write would create.
function resolvedPath(file) {
  const tail = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      if (isEntry(current) || path.dirname(current) === current) return null;
      tail.unshift(path.basename(current));
    }
  }
}

// `base` and `rel` are POSIX-style paths relative to `root`; returns the joined relative path, or null if it escapes,
// either as text or through a symlink.
export function insidePath(root, base, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\\')) return null;
  const joined = path.posix.normalize(path.posix.join(base || '.', rel)).replace(/\/$/, '');
  if (joined === '.' || joined.startsWith('../') || joined === '..') return null;
  if (base && !joined.startsWith(`${base}/`)) return null;
  // path.relative uses the platform separator, "\" on Windows; `rel` cannot hold one, so mapping it back is safe.
  if (path.relative(root, path.join(root, joined)).replaceAll('\\', '/') !== joined) return null;
  return linksOutside(root, joined, base) ? null : joined;
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Whether `file` is there at all, a broken symlink included.
function isEntry(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
