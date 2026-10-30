// Keeps the plugin version the same in every file that carries it, and makes a branch that changes the plugin raise it.
//
//   node scripts/version.mjs [patch|minor|major]   raise the version everywhere (npm run bump); patch by default
//   node scripts/version.mjs --check               exit 1 if the files disagree on the version, or if this branch
//                                                  changes plugins/aidrian/ without a version above origin/main's
//
// An installed plugin updates only when its version changes, so a merged change without a bump reaches no one.
// The version is written in both plugin manifests, package.json, package-lock.json (twice), and any marketplace entry
// that sets one. Docs, tests, examples, and scripts live outside plugins/aidrian/ and ship to no one: no bump for them.
// The comparison with main is skipped where it cannot run: without origin/main, and on main itself.
//
// This script imports only node: built-ins, so a test can copy it into a scratch repository and run it there.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = 'plugins/aidrian';
// Main's copy of this manifest holds the version a branch must exceed.
const MANIFEST = `${PLUGIN}/.claude-plugin/plugin.json`;
const MAIN = 'origin/main';
const LEVELS = ['patch', 'minor', 'major'];

// Each file that always carries the version, with the key path to each copy in it.
const FILES = [
  [MANIFEST, [['version']]],
  [`${PLUGIN}/plugin.json`, [['version']]],
  ['package.json', [['version']]],
  ['package-lock.json', [['version'], ['packages', '', 'version']]],
];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

// Every file that carries the version, parsed: [{ file, data, paths }].
function versionFiles(root) {
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  return [
    ...FILES.map(([file, paths]) => ({ file, data: read(file), paths })),
    ...MARKETPLACES.map((file) => {
      const data = read(file);
      return { file, data, paths: data.plugins.flatMap((entry, index) => ('version' in entry ? [['plugins', index, 'version']] : [])) };
    }),
  ];
}

// Every place the version is written: [{ where, version }].
export function versionLocations(root = ROOT) {
  return versionFiles(root).flatMap(({ file, data, paths }) => paths.map((keys) => ({
    where: `${file}: ${keys.map((key) => (key === '' ? '""' : key)).join('.')}`,
    version: keys.reduce((value, key) => value?.[key], data),
  })));
}

// Write `version` to every place in versionLocations. Files keep npm's format: two-space indent, final newline.
export function setVersion(version, root = ROOT) {
  for (const { file, data, paths } of versionFiles(root)) {
    if (!paths.length) continue;
    for (const keys of paths) keys.slice(0, -1).reduce((value, key) => value[key], data)[keys.at(-1)] = version;
    writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  }
}

// [major, minor, patch] of a plain x.y.z version, or null.
function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function partsOf(version) {
  const parts = versionParts(version);
  if (!parts) throw new Error(`not an x.y.z version: ${JSON.stringify(version)}`);
  return parts;
}

export function bumpVersion(version, level) {
  const [major, minor, patch] = partsOf(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown level ${JSON.stringify(level)}: use ${LEVELS.join(', ')}`);
}

// Below zero when `a` is lower than `b`, zero when equal, above zero when higher.
export function compareVersions(a, b) {
  const [left, right] = [partsOf(a), partsOf(b)];
  return left.map((part, index) => part - right[index]).find((difference) => difference !== 0) ?? 0;
}

// Why the places disagree on the version, or hold no x.y.z version; null when all hold the same one.
export function agreementProblem(locations) {
  const versions = new Set(locations.map(({ version }) => version));
  if (versions.size === 1 && versionParts(locations[0].version)) return null;
  const list = locations.map(({ where, version }) => `\n  ${where}: ${JSON.stringify(version)}`).join('');
  return versions.size === 1
    ? `the version is not of the form x.y.z:${list}`
    : `the version is not the same everywhere; set every place to one version (main's, when you resolve a merge), then run npm run bump:${list}`;
}

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function gitLine(root, ...args) {
  const result = git(root, ...args);
  return result.status === 0 ? result.stdout.trim() : null;
}

// Once origin/main and the merge base are known, any git failure is unexpected: fail rather than pass unchecked.
function gitOutput(root, ...args) {
  const result = git(root, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

// Whether this branch raised the version it had to: { skip } when there is no main to compare with, { problem } when it
// changes the plugin without a version above main's, { ok } otherwise. `version` is the version the branch holds.
export function branchCheck(version, root = ROOT) {
  if (gitLine(root, 'rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`) === null) return { skip: `no ${MAIN} to compare with` };
  if (gitLine(root, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'main') return { skip: 'on main' };
  const base = gitLine(root, 'merge-base', 'HEAD', MAIN);
  if (base === null) return { skip: `no merge base with ${MAIN}` };
  // Against the working tree, untracked files too, so the check holds before a commit. The path limit applies before
  // rename detection, so a file moved out of the plugin still lists as a plugin file removed.
  const changed = [
    ...gitOutput(root, 'diff', '--name-only', base, '--', PLUGIN).split('\n'),
    ...gitOutput(root, 'ls-files', '--others', '--exclude-standard', '--', PLUGIN).split('\n'),
  ].filter(Boolean);
  if (!changed.length) return { ok: `nothing under ${PLUGIN}/ changed since ${MAIN}` };
  const mainVersion = JSON.parse(gitOutput(root, 'show', `${MAIN}:${MANIFEST}`)).version;
  if (compareVersions(version, mainVersion) > 0) return { ok: `version ${version} is above ${MAIN}'s ${mainVersion}` };
  const files = changed.length === 1 ? changed[0] : `${changed.length} files, ${changed[0]} first`;
  return { problem: `this branch changes ${PLUGIN}/ (${files}) but keeps version ${version}, not above ${MAIN}'s ${mainVersion}: run npm run bump` };
}

function check() {
  const locations = versionLocations();
  const problem = agreementProblem(locations);
  if (problem) return fail(problem);
  const { version } = locations[0];
  const result = branchCheck(version);
  if (result.problem) return fail(result.problem);
  console.log(`ok: version ${version} in all ${locations.length} places; ${result.ok ?? `bump check skipped: ${result.skip}`}`);
}

function bump(level) {
  const locations = versionLocations();
  const problem = agreementProblem(locations);
  if (problem) return fail(problem);
  const version = bumpVersion(locations[0].version, level);
  setVersion(version);
  console.log(`version ${locations[0].version} -> ${version} in:${locations.map(({ where }) => `\n  ${where}`).join('')}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main(args) {
  // Any other argument fails: a mistyped --check must not fall through to a bump.
  const [arg = 'patch', ...rest] = args;
  if (rest.length || (arg !== '--check' && !LEVELS.includes(arg))) {
    return fail(`usage: node scripts/version.mjs [${LEVELS.join('|')}] | --check\nunknown argument: ${rest[0] ?? arg}`);
  }
  if (arg === '--check') check();
  else bump(arg);
}

// Run only as the entry script. process.argv[1] is unset under `node -e` and need not be a file under `node -p`.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) main(process.argv.slice(2));
