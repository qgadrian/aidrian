// Keeps the plugin version the same in every file that carries it, keeps it out of pull requests, and raises it on main.
//
//   node scripts/version.mjs [patch|minor|major]       raise the version everywhere (npm run bump), for a local trial
//                                                      only; patch by default
//   node scripts/version.mjs --check                   exit 1 if the files disagree on the version, or if this branch
//                                                      changes it from the merge base with origin/main
//   node scripts/version.mjs lint-title "<title>"      exit 1 unless the title is a Conventional Commit subject
//   node scripts/version.mjs release [--level <level>] raise the version for the plugin commits since the latest v* tag,
//                                                      and print `version=x.y.z` last; no change when there are none
//
// An installed plugin updates only when its version changes, and a version change is a release: the release workflow
// runs `release` on main after each merge, then commits, tags, and pushes the new version. A pull request never changes
// the version, so two open pull requests never conflict on it. The squashed commit's subject is the pull request's
// title, and those titles pick the level: a breaking change raises major, feat raises minor, anything else patch.
// While the major version is 0, a breaking change raises minor: 1.0.0 comes only from an explicit --level major.
// Only commits that change plugins/aidrian/ count; docs, tests, examples, and scripts ship to no one.
// The version is written in both plugin manifests, package.json, package-lock.json (twice), and any marketplace entry
// that sets one. The comparison with main is skipped where it cannot run: without origin/main, and on main itself.
//
// This script imports only node: built-ins, so a test can copy it into a scratch repository and run it there.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = 'plugins/aidrian';
const MAIN = 'origin/main';
const LEVELS = ['patch', 'minor', 'major'];
const RELEASE_SUBJECT = 'chore(release)';
const USAGE = `usage: node scripts/version.mjs [${LEVELS.join('|')}] | --check | lint-title "<title>" | release [--level ${LEVELS.join('|')}]`;

// Each file that always carries the version, with the key path to each copy in it.
const FILES = [
  [`${PLUGIN}/.claude-plugin/plugin.json`, [['version']]],
  [`${PLUGIN}/plugin.json`, [['version']]],
  ['package.json', [['version']]],
  ['package-lock.json', [['version'], ['packages', '', 'version']]],
];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

// Every file that carries the version, parsed: [{ file, data, paths }]. `read` returns a file's parsed JSON, or null
// when the file does not exist there, and then the file carries no version.
function versionFiles(read) {
  return [
    ...FILES.map(([file, paths]) => ({ file, data: read(file), paths })),
    ...MARKETPLACES.map((file) => {
      const data = read(file);
      return { file, data, paths: (data?.plugins ?? []).flatMap((entry, index) => ('version' in entry ? [['plugins', index, 'version']] : [])) };
    }),
  ].filter(({ data }) => data !== null);
}

const readWorkingTree = (root) => (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

function locationsOf(files) {
  return files.flatMap(({ file, data, paths }) => paths.map((keys) => ({
    where: `${file}: ${keys.map((key) => (key === '' ? '""' : key)).join('.')}`,
    version: keys.reduce((value, key) => value?.[key], data),
  })));
}

// Every place the version is written: [{ where, version }].
export function versionLocations(root = ROOT) {
  return locationsOf(versionFiles(readWorkingTree(root)));
}

// Write `version` to every place in versionLocations. Files keep npm's format: two-space indent, final newline.
export function setVersion(version, root = ROOT) {
  for (const { file, data, paths } of versionFiles(readWorkingTree(root))) {
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

// The type of a Conventional Commit subject, such as `feat(review)!: drop x`, and whether it marks a breaking change;
// null when the subject is not one.
export function parseTitle(subject) {
  const match = /^(\w+)(\([^)]*\))?(!)?: .+/.exec(subject ?? '');
  return match ? { type: match[1], breaking: match[3] === '!' } : null;
}

// The release level these commit subjects call for: the highest of major for a breaking change, minor for feat, and
// patch for anything else, a subject that is not a Conventional Commit too. While `currentVersion` is 0.x, a breaking
// change raises minor: 1.0.0 is a decision, made with an explicit level.
export function levelFromSubjects(subjects, currentVersion) {
  const [major] = partsOf(currentVersion);
  const levelOf = (subject) => {
    const title = parseTitle(subject);
    if (title?.breaking) return major === 0 ? 'minor' : 'major';
    return title?.type === 'feat' ? 'minor' : 'patch';
  };
  return subjects.map(levelOf).reduce((high, level) => (LEVELS.indexOf(level) > LEVELS.indexOf(high) ? level : high), 'patch');
}

// Why the places disagree on the version, or hold no x.y.z version; null when all hold the same one.
export function agreementProblem(locations) {
  const versions = new Set(locations.map(({ version }) => version));
  if (versions.size === 1 && versionParts(locations[0].version)) return null;
  const list = locations.map(({ where, version }) => `\n  ${where}: ${JSON.stringify(version)}`).join('');
  return versions.size === 1
    ? `the version is not of the form x.y.z:${list}`
    : `the version is not the same everywhere; set every place to one version (main's, when you resolve a merge):${list}`;
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

// Whether this branch left the version alone: { skip } when there is no main to compare with, { problem } when the
// working tree holds a version other than the merge base's in any place, { ok } otherwise. Main may have released a
// higher version since the merge base; the branch takes it when it merges main, and need not before.
export function branchCheck(root = ROOT) {
  if (gitLine(root, 'rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`) === null) return { skip: `no ${MAIN} to compare with` };
  if (gitLine(root, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'main') return { skip: 'on main' };
  const base = gitLine(root, 'merge-base', 'HEAD', MAIN);
  if (base === null) return { skip: `no merge base with ${MAIN}` };
  const atBase = (file) => {
    if (gitLine(root, 'cat-file', '-e', `${base}:${file}`) === null) return null;
    return JSON.parse(gitOutput(root, 'show', `${base}:${file}`));
  };
  const before = new Map(locationsOf(versionFiles(atBase)).map(({ where, version }) => [where, version]));
  const now = versionLocations(root);
  const changed = [
    ...now.filter(({ where, version }) => before.get(where) !== version)
      .map(({ where, version }) => `\n  ${where}: ${JSON.stringify(before.get(where))} -> ${JSON.stringify(version)}`),
    ...[...before.keys()].filter((where) => !now.some((location) => location.where === where))
      .map((where) => `\n  ${where}: ${JSON.stringify(before.get(where))} -> removed`),
  ];
  const baseVersion = before.values().next().value;
  if (!changed.length) return { ok: `the branch keeps the version of its merge base with ${MAIN}` };
  return {
    problem: `this branch changes the plugin version, and a pull request never does: the release workflow raises it on main`
      + ` after the merge. Take main's version: set every place back to ${JSON.stringify(baseVersion)}, the version at the`
      + ` merge base with ${MAIN}, or merge ${MAIN} and keep its version.${changed.join('')}`,
  };
}

function check() {
  const locations = versionLocations();
  const problem = agreementProblem(locations);
  if (problem) return fail(problem);
  const { version } = locations[0];
  const result = branchCheck();
  if (result.problem) return fail(result.problem);
  console.log(`ok: version ${version} in all ${locations.length} places; ${result.ok ?? `branch check skipped: ${result.skip}`}`);
}

function bump(level) {
  const locations = versionLocations();
  const problem = agreementProblem(locations);
  if (problem) return fail(problem);
  const version = bumpVersion(locations[0].version, level);
  setVersion(version);
  console.log(`version ${locations[0].version} -> ${version} in:${locations.map(({ where }) => `\n  ${where}`).join('')}`);
}

function lintTitle(title) {
  if (parseTitle(title)) return console.log(`ok: ${JSON.stringify(title)} is a Conventional Commit subject`);
  fail(`the pull request title ${JSON.stringify(title)} is not a Conventional Commit subject, such as`
    + ' "fix(hooks): let a hook pass when it cannot read its input". It becomes the squashed commit\'s subject, and the'
    + ' release reads its type: feat raises minor, a "!" before the colon marks a breaking change, any other type patch.');
}

// Raise the version for the plugin commits since the latest v* tag. `level` overrides what their subjects call for,
// and releases even when there are none. Returns { version, from, subjects } or { none } when there is nothing to do.
export function release(level, root = ROOT) {
  const locations = versionLocations(root);
  const problem = agreementProblem(locations);
  if (problem) throw new Error(problem);
  const current = locations[0].version;
  const tag = gitLine(root, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  if (!tag) {
    throw new Error(`no v* tag is reachable from HEAD, so there is nothing to count commits from. Tag the commit that`
      + ` set ${current} once, then push the tag: git tag v${current} <commit> && git push origin v${current}`);
  }
  if (tag !== `v${current}`) {
    throw new Error(`the latest tag reachable from HEAD is ${tag}, but the files hold ${current}. Tag the commit that set`
      + ` ${current} as v${current} and push the tag, so the release counts commits from it.`);
  }
  const subjects = gitOutput(root, 'log', `${tag}..HEAD`, '--format=%s', '--', PLUGIN).split('\n')
    .filter((subject) => subject && !subject.startsWith(RELEASE_SUBJECT));
  if (!subjects.length && !level) return { none: `no commit since ${tag} changes ${PLUGIN}/: nothing to release` };
  const version = bumpVersion(current, level ?? levelFromSubjects(subjects, current));
  setVersion(version, root);
  return { version, from: current, subjects };
}

function runRelease(args) {
  let level;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--level' || !LEVELS.includes(args[1])) return fail(`${USAGE}\nunknown argument: ${args.join(' ')}`);
    level = args[1];
  }
  let result;
  try {
    result = release(level);
  } catch (error) {
    return fail(error.message);
  }
  if (result.none) return console.log(result.none);
  const why = level ? `--level ${level}` : `${result.subjects.length} plugin commit(s)`;
  console.log(`version ${result.from} -> ${result.version}, for ${why}:${result.subjects.map((subject) => `\n  ${subject}`).join('')}`);
  console.log(`version=${result.version}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main(args) {
  const [arg = 'patch', ...rest] = args;
  if (arg === 'release') return runRelease(rest);
  if (arg === 'lint-title') {
    if (rest.length !== 1) return fail(`${USAGE}\nlint-title takes one argument, the title`);
    return lintTitle(rest[0]);
  }
  // Any other argument fails: a mistyped --check must not fall through to a bump.
  if (rest.length || (arg !== '--check' && !LEVELS.includes(arg))) return fail(`${USAGE}\nunknown argument: ${rest[0] ?? arg}`);
  if (arg === '--check') check();
  else bump(arg);
}

// Run only as the entry script. process.argv[1] is unset under `node -e` and need not be a file under `node -p`.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) main(process.argv.slice(2));
