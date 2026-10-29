// Loads a project's .aidrian/config.json, the one file a project writes for this plugin. docs/config.md lists the keys.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const CONFIG = '.aidrian/config.json';

// The type of every key. A nested object is one group of keys; a project sets any subset of a group.
const SCHEMA = {
  buckets: 'folders',
  defaultBranch: 'text',
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
  folders: [(value) => Array.isArray(value) && value.length > 0 && value.every(isText), 'a non-empty list of folders'],
  boolean: [(value) => typeof value === 'boolean', 'true or false'],
  positive: [(value) => Number.isInteger(value) && value > 0, 'a whole number above 0'],
  zeroOrMore: [(value) => Number.isInteger(value) && value >= 0, 'a whole number, 0 or more'],
};

// `buckets` has no default: a project must list its knowledge folders.
export const DEFAULTS = deepFreeze({
  buckets: [],
  defaultBranch: 'main',
  worktrees: { dir: '.aidrian/worktrees', bootstrap: null },
  mainCheckout: { guard: true, allowWrites: [] },
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

// Walks up from `start` to the folder that holds .aidrian/config.json.
export function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Returns { config, errors }. `config` is frozen and always complete: the file's values over DEFAULTS, one group at a
// time, with the default kept for any value that is missing or invalid. A hook can use it even when `errors` is not empty.
export function loadConfig(root) {
  const errors = [];
  const file = readJson(root, CONFIG, errors) ?? {};
  if (!errors.length && !Object.hasOwn(file, 'buckets')) errors.push(`${CONFIG}: "buckets" must be ${TYPES.folders[1]}`);
  return { config: deepFreeze(merge(SCHEMA, DEFAULTS, file, '', errors)), errors };
}

function merge(schema, defaults, values, prefix, errors) {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(schema, key)) errors.push(`${CONFIG}: unknown key "${prefix}${key}"`);
  }
  const out = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = values[key];
    out[key] = defaults[key];
    if (!Object.hasOwn(values, key)) continue;
    if (typeof type === 'object') {
      if (isObject(value)) out[key] = merge(type, defaults[key], value, `${prefix}${key}.`, errors);
      else errors.push(`${CONFIG}: "${prefix}${key}" must be an object`);
    } else if (TYPES[type][0](value)) {
      out[key] = value;
    } else {
      errors.push(`${CONFIG}: "${prefix}${key}" must be ${TYPES[type][1]}`);
    }
  }
  return out;
}

export const commands = {
  check: {
    usage: '[--project DIR]',
    about: `check ${CONFIG}; DIR defaults to the current folder or the nearest one above it with that file`,
    run(args) {
      const { values } = parseArgs({ args, options: { project: { type: 'string' } } });
      const start = path.resolve(values.project ?? '.');
      const root = findProjectRoot(start);
      if (!root) {
        console.error(`no ${CONFIG} at or above ${start}`);
        return 1;
      }
      const { errors } = loadConfig(root);
      if (errors.length) {
        console.error(errors.join('\n'));
        return 1;
      }
      console.log('ok');
      return 0;
    },
  },
};

// File helpers, shared with knowledge.mjs. Paths are relative to `root`.

// The parsed JSON object at `rel`, or null with the reason added to `errors`.
export function readJson(root, rel, errors) {
  const file = path.join(root, rel);
  if (!isFile(file)) {
    errors.push(`${rel}: not found`);
    return null;
  }
  if (linksOutside(root, rel)) {
    errors.push(`${rel}: links outside the project`);
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

// True when `rel` exists but, with symlinks resolved, lies outside the folder `within` (relative to `root`; the
// project when empty). A missing path is left to the caller.
export function linksOutside(root, rel, within = '') {
  let real;
  try {
    real = realpathSync(path.join(root, rel));
  } catch {
    return false;
  }
  const realWithin = realpathSync(path.join(root, within));
  return real !== realWithin && !real.startsWith(`${realWithin}${path.sep}`);
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
