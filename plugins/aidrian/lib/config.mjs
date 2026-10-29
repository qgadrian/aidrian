// Loads config.json from the project folder: the folder version and the project's settings for this plugin.
// docs/config.md lists the keys; docs/project-folder.md gives the version rule.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// The project folder format this plugin reads. A format change raises it and documents the migration.
export const VERSION = 1;
const MIGRATING = 'https://github.com/qgadrian/aidrian-harness/blob/main/docs/project-folder.md#migrating';

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
};

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const TYPES = {
  text: [isText, 'a non-empty string'],
  textOrNull: [(value) => value === null || isText(value), 'a non-empty string or null'],
  texts: [(value) => Array.isArray(value) && value.every(isText), 'a list of non-empty strings'],
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  positive: [(value) => Number.isInteger(value) && value > 0, 'a whole number above 0'],
  zeroOrMore: [(value) => Number.isInteger(value) && value >= 0, 'a whole number, 0 or more'],
};

// `state.dir: null` is the per-project folder under `$XDG_STATE_HOME` (lib/project.mjs). Task worktrees sit beside the
// repository's files, where editors and agents expect them; the guard is off until a project opts in.
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
});

// Returns { config, errors, current }. `config` is frozen and always complete: the file's values over DEFAULTS, one
// group at a time, with the default kept for any value that is missing or invalid. A hook can use it even when `errors`
// is not empty. `current` is false when the file is missing, unreadable, or of another version: then nothing in the
// folder can be trusted to have the shape this plugin reads.
export function loadConfig(project) {
  const errors = [];
  const file = project.paths.config;
  const raw = readJson(project.root, file, errors);
  if (!raw) return { config: DEFAULTS, errors, current: false };
  const problem = versionProblem(file, raw.version);
  if (problem) return { config: DEFAULTS, errors: [problem], current: false };
  const { version, ...values } = raw;
  return { config: deepFreeze(merge(SCHEMA, DEFAULTS, values, '', file, errors)), errors, current: true };
}

// The error for a `version` other than VERSION, or null.
export function versionProblem(file, version) {
  if (version === VERSION) return null;
  const found = version === undefined ? 'missing' : JSON.stringify(version);
  return `${file}: project folder version ${found}; this plugin reads version ${VERSION}; see ${MIGRATING}`;
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
    } else if (TYPES[type][0](value)) {
      out[key] = value;
    } else {
      errors.push(`${file}: "${prefix}${key}" must be ${TYPES[type][1]}`);
    }
  }
  return out;
}

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
