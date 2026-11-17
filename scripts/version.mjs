// Keeps each marketplace plugin's version the same in every file that carries it, keeps it out of pull requests, and
// raises it on main, each plugin on its own, under its own tags.
//
//   node scripts/version.mjs [patch|minor|major]        raise aidrian's version everywhere (npm run bump), for a local
//                                                       trial only; patch by default
//   node scripts/version.mjs --check                    exit 1 if a plugin's files disagree on its version, if this
//                                                       branch changes a plugin's version from the merge base with
//                                                       origin/main, or if a marketplace entry sets a version for no plugin
//   node scripts/version.mjs lint-title "<title>"       exit 1 unless the title is a Conventional Commit subject
//   node scripts/version.mjs release [--level <level>]  raise each plugin's version for its commits since its own latest
//                                                       tag; print one result line per released plugin on stdout, and
//                                                       everything else on stderr
//   node scripts/version.mjs check-results <file>       exit 1 unless every line of the file is a well-formed result line
//   node scripts/version.mjs commit-and-tag <name>...   commit the released plugins' version files once, and tag each
//   node scripts/version.mjs tag-check                  exit 1 while a plugin whose folder exists has no tag of its prefix
//
// An installed plugin updates only when its version changes, and a version change is a release: the release workflow
// runs `release` on main after each merge, then `commit-and-tag`, and pushes the commit and the tags. A pull request
// never changes a version, so two open pull requests never conflict on it. The squashed commit's subject is the pull
// request's title, and those titles pick the level: a breaking change raises major, feat raises minor, anything else
// patch. While the major version is 0, a breaking change raises minor: 1.0.0 comes only from an explicit --level major,
// which reaches aidrian alone. Only commits that change a plugin's own folder count for it.
//
// A result line is `<name>=<x.y.z> <tag> <previous tag or ->`. A plugin with no tag of its prefix anywhere has its first
// release: its manifest's version, with no bump, tagged on the commit that added the manifest. When a later commit
// touches the plugin's folder, that first release is refused with the tag-by-hand message, and tag-check fails the run.
// A table plugin whose folder does not exist is skipped. The comparison with main is skipped where it cannot run:
// without origin/main, and on main itself.
//
// This script imports only node: built-ins, so a test can copy it into a scratch repository and run it there.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = 'origin/main';
const LEVELS = ['patch', 'minor', 'major'];
const RELEASE_SUBJECT = 'chore(release)';
const USAGE = `usage: node scripts/version.mjs [${LEVELS.join('|')}] | --check | lint-title "<title>" | release [--level ${LEVELS.join('|')}]`
  + ' | check-results <file> | commit-and-tag <name>... | tag-check';

// Each plugin of the marketplaces: its folder, its tag prefix, and each file that always carries its version, with the
// key path to each copy in it. The first file is the plugin's manifest, whose adding commit a first release tags.
export const PLUGINS = [
  {
    name: 'aidrian',
    dir: 'plugins/aidrian',
    prefix: 'v',
    files: [
      ['plugins/aidrian/.claude-plugin/plugin.json', [['version']]],
      ['plugins/aidrian/plugin.json', [['version']]],
      ['package.json', [['version']]],
      ['package-lock.json', [['version'], ['packages', '', 'version']]],
    ],
  },
  {
    name: 'aidrian-cockpit',
    dir: 'plugins/aidrian-cockpit',
    prefix: 'aidrian-cockpit-v',
    files: [['plugins/aidrian-cockpit/.claude-plugin/plugin.json', [['version']]]],
  },
];
const AIDRIAN = PLUGINS[0];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;

const pluginNamed = (name) => PLUGINS.find((plugin) => plugin.name === name);
// The tag glob of a plugin: `v[0-9]*` never matches `aidrian-cockpit-v0.1.0`, and the cockpit's never matches `v0.65.0`.
export const tagPattern = (plugin) => `${plugin.prefix}[0-9]*`;
// The table plugins whose folder exists in the working tree.
export const presentPlugins = (root = ROOT) => PLUGINS.filter((plugin) => existsSync(path.join(root, plugin.dir)));

// Every file that carries a plugin's version, parsed: [{ file, data, paths }]. `read` returns a file's parsed JSON, or
// null when the file does not exist there, and then the file carries no version. A marketplace entry counts for the
// plugin its name matches exactly.
function versionFiles(read, plugin) {
  return [
    ...plugin.files.map(([file, paths]) => ({ file, data: read(file), paths })),
    ...MARKETPLACES.map((file) => {
      const data = read(file);
      const paths = (data?.plugins ?? []).flatMap((entry, index) => (entry?.name === plugin.name && 'version' in entry ? [['plugins', index, 'version']] : []));
      return { file, data, paths };
    }),
  ].filter(({ data }) => data !== null);
}

const readWorkingTree = (root) => (file) => {
  try {
    return JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
};

function locationsOf(files) {
  return files.flatMap(({ file, data, paths }) => paths.map((keys) => ({
    where: `${file}: ${keys.map((key) => (key === '' ? '""' : key)).join('.')}`,
    version: keys.reduce((value, key) => value?.[key], data),
  })));
}

// Every place a plugin's version is written: [{ where, version }]. aidrian's by default.
export function versionLocations(root = ROOT, plugin = AIDRIAN) {
  return locationsOf(versionFiles(readWorkingTree(root), plugin));
}

// The files a plugin's version is written in, by path from PLUGINS and the marketplaces.
const versionPaths = (root, plugin) => versionFiles(readWorkingTree(root), plugin).filter(({ paths }) => paths.length).map(({ file }) => file);

// Write `version` to every place in versionLocations. Files keep npm's format: two-space indent, final newline.
export function setVersion(version, root = ROOT, plugin = AIDRIAN) {
  for (const { file, data, paths } of versionFiles(readWorkingTree(root), plugin)) {
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

// The one version a plugin's files agree on; throws, naming the plugin, when they do not.
function agreedVersion(root, plugin) {
  let locations;
  try {
    locations = versionLocations(root, plugin);
  } catch (error) {
    throw new Error(`${plugin.name}: ${error.message}`);
  }
  const problem = agreementProblem(locations);
  if (problem) throw new Error(`${plugin.name}: ${problem}`);
  return locations[0].version;
}

// Why a marketplace entry sets a version for no table plugin; null when none does.
export function marketplaceProblem(root = ROOT) {
  const read = readWorkingTree(root);
  const stray = MARKETPLACES.flatMap((file) => {
    if (!existsSync(path.join(root, file))) return [];
    return (read(file)?.plugins ?? []).flatMap((entry, index) => (entry && 'version' in entry && !pluginNamed(entry.name)
      ? [`\n  ${file}: plugins.${index} (${JSON.stringify(entry.name)})`] : []));
  });
  return stray.length ? `a marketplace entry sets a version, but its name is no plugin in PLUGINS of scripts/version.mjs:${stray.join('')}` : null;
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

const lines = (text) => text.split('\n').filter(Boolean);

// Whether this branch left a plugin's version alone: { skip } when there is no main to compare with, { problem } when
// the working tree holds a version other than the merge base's in any place, { ok } otherwise. A plugin with no version
// file at the merge base is new on the branch, and its version is no change. Main may have released a higher version
// since the merge base; the branch takes it when it merges main, and need not before.
export function branchCheck(root = ROOT, plugin = AIDRIAN) {
  if (gitLine(root, 'rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`) === null) return { skip: `no ${MAIN} to compare with` };
  if (gitLine(root, 'symbolic-ref', '--quiet', '--short', 'HEAD') === 'main') return { skip: 'on main' };
  const base = gitLine(root, 'merge-base', 'HEAD', MAIN);
  if (base === null) return { skip: `no merge base with ${MAIN}` };
  const atBase = (file) => {
    if (gitLine(root, 'cat-file', '-e', `${base}:${file}`) === null) return null;
    return JSON.parse(gitOutput(root, 'show', `${base}:${file}`));
  };
  if (plugin.files.every(([file]) => atBase(file) === null)) return { ok: `the plugin is new on this branch, with no version file at its merge base with ${MAIN}` };
  const before = new Map(locationsOf(versionFiles(atBase, plugin)).map(({ where, version }) => [where, version]));
  const now = versionLocations(root, plugin);
  const changed = [
    ...now.filter(({ where, version }) => before.get(where) !== version)
      .map(({ where, version }) => `\n  ${where}: ${JSON.stringify(before.get(where))} -> ${JSON.stringify(version)}`),
    ...[...before.keys()].filter((where) => !now.some((location) => location.where === where))
      .map((where) => `\n  ${where}: ${JSON.stringify(before.get(where))} -> removed`),
  ];
  const baseVersion = before.values().next().value;
  if (!changed.length) return { ok: `the branch keeps the version of its merge base with ${MAIN}` };
  return {
    problem: `this branch changes the ${plugin.name} version, and a pull request never does: the release workflow raises it on main`
      + ` after the merge. Take main's version: set every place back to ${JSON.stringify(baseVersion)}, the version at the`
      + ` merge base with ${MAIN}, or merge ${MAIN} and keep its version.${changed.join('')}`,
  };
}

function check() {
  const stray = marketplaceProblem();
  if (stray) return fail(stray);
  for (const plugin of presentPlugins()) {
    const locations = versionLocations(ROOT, plugin);
    const problem = agreementProblem(locations);
    if (problem) return fail(`${plugin.name}: ${problem}`);
    const result = branchCheck(ROOT, plugin);
    if (result.problem) return fail(result.problem);
    console.log(`ok: ${plugin.name} version ${locations[0].version} in all ${locations.length} places; ${result.ok ?? `branch check skipped: ${result.skip}`}`);
  }
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

// The commit that last added the plugin's manifest, reachable from HEAD, or null.
const manifestCommit = (root, plugin) => lines(gitOutput(root, 'log', '--diff-filter=A', '--format=%H', 'HEAD', '--', plugin.files[0][0]))[0] ?? null;
const hasTag = (root, plugin) => lines(gitOutput(root, 'tag', '--list', tagPattern(plugin))).length > 0;

// A plugin's first release: its manifest's version, no bump, tagged on the commit that added the manifest. Refused,
// with the tag-by-hand message, when a later commit touches the plugin's folder.
function firstRelease(root, plugin, current) {
  const added = manifestCommit(root, plugin);
  const tag = `${plugin.prefix}${current}`;
  if (!added) throw new Error(`${plugin.name}: no commit reachable from HEAD adds ${plugin.files[0][0]}, so its first release has nothing to tag`);
  const later = lines(gitOutput(root, 'log', '--format=%H', `${added}..HEAD`, '--', plugin.dir));
  if (later.length) {
    return {
      refused: `${plugin.name}: its first release is refused. ${later.length} commit(s) after ${added}, the commit that added`
        + ` ${plugin.files[0][0]}, change ${plugin.dir}/, so ${tag} on that commit would name a version whose installs got later`
        + ` content. Tag it by hand, then the next release counts from it: git tag -a ${tag} ${added} -m "${plugin.name} v${current}"`
        + ` && git push origin refs/tags/${tag}`,
    };
  }
  return { name: plugin.name, version: current, tag, previous: '-', first: true, target: added, subjects: [] };
}

// What releasing one plugin means, computed without writing: a result, { refused }, or { none }. Throws on a failure.
function planRelease(root, plugin, level) {
  const current = agreedVersion(root, plugin);
  if (!hasTag(root, plugin)) return firstRelease(root, plugin, current);
  const tag = gitLine(root, 'describe', '--tags', '--abbrev=0', '--match', tagPattern(plugin), 'HEAD');
  const want = `${plugin.prefix}${current}`;
  if (!tag) {
    throw new Error(`${plugin.name}: a ${tagPattern(plugin)} tag exists, but none is reachable from HEAD, so there is nothing to`
      + ` count commits from. Tag the commit that set ${current} once, then push the tag: git tag ${want} <commit> && git push origin ${want}`);
  }
  if (tag !== want) {
    throw new Error(`${plugin.name}: the latest tag reachable from HEAD is ${tag}, but the files hold ${current}. Tag the commit`
      + ` that set ${current} as ${want} and push the tag, so the release counts commits from it.`);
  }
  const subjects = lines(gitOutput(root, 'log', `${tag}..HEAD`, '--format=%s', '--', plugin.dir))
    .filter((subject) => !subject.startsWith(RELEASE_SUBJECT));
  if (!subjects.length && !level) return { none: `${plugin.name}: no commit since ${tag} changes ${plugin.dir}/: nothing to release` };
  const version = bumpVersion(current, level ?? levelFromSubjects(subjects, current));
  return { name: plugin.name, version, tag: `${plugin.prefix}${version}`, previous: tag, from: current, level, subjects };
}

// Raise each present plugin's version for its commits since its own latest tag. `level` sets aidrian's level, and
// releases it even with no commit waiting; every other plugin takes the level its own commits call for. All or nothing:
// every plugin is planned before any file is written, and any failure throws with no file changed. A refused first
// release is the one exception: it lands in `refused` and the others still release.
// Returns { results, refused, notes }.
export function release(level, root = ROOT) {
  const stray = marketplaceProblem(root);
  if (stray) throw new Error(stray);
  const plans = presentPlugins(root).map((plugin) => planRelease(root, plugin, plugin === AIDRIAN ? level : undefined));
  const results = plans.filter((plan) => plan.name);
  for (const result of results) if (!result.first) setVersion(result.version, root, pluginNamed(result.name));
  return {
    results,
    refused: plans.filter((plan) => plan.refused).map((plan) => plan.refused),
    notes: plans.filter((plan) => plan.none).map((plan) => plan.none),
  };
}

export const resultLine = ({ name, version, tag, previous }) => `${name}=${version} ${tag} ${previous}`;

// Why this text is not a block of result lines, each `<name>=<x.y.z> <tag> <previous tag or ->` with a PLUGINS name,
// that plugin's prefix on both tags, and no name twice; null when it is one. An empty block is one.
export function resultsProblem(text) {
  const seen = new Set();
  for (const line of String(text).split('\n').filter((each, index, all) => each || index < all.length - 1)) {
    const match = /^([a-z][a-z0-9-]*)=(\S+) (\S+) (\S+)$/u.exec(line);
    const plugin = match && pluginNamed(match[1]);
    const escape = (prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const tagOf = plugin && new RegExp(`^${escape(plugin.prefix)}${VERSION}$`, 'u');
    const ok = plugin && new RegExp(`^${VERSION}$`, 'u').test(match[2]) && match[3] === `${plugin.prefix}${match[2]}`
      && (match[4] === '-' || tagOf.test(match[4])) && !seen.has(plugin.name);
    if (!ok) return `not a result line: ${JSON.stringify(line)}`;
    seen.add(plugin.name);
  }
  return null;
}

function runRelease(args) {
  let level;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--level' || !LEVELS.includes(args[1])) return fail(`${USAGE}\nunknown argument: ${args.join(' ')}`);
    level = args[1];
  }
  let outcome;
  try {
    outcome = release(level);
  } catch (error) {
    return fail(error.message);
  }
  for (const note of outcome.notes) console.error(note);
  for (const refused of outcome.refused) console.error(refused);
  for (const result of outcome.results) {
    const why = result.first ? 'its first release, from its manifest' : (result.level ? `--level ${result.level}` : `${result.subjects.length} plugin commit(s)`);
    console.error(`${result.name} ${result.from ?? '-'} -> ${result.version}, for ${why}:${result.subjects.map((subject) => `\n  ${subject}`).join('')}`);
  }
  for (const result of outcome.results) console.log(resultLine(result));
}

// Commit the version files of the named plugins once, and tag each: on that commit, or for a first release on the
// commit that added its manifest. Refuses an unknown or repeated name, a tag that exists, and any changed path other
// than those plugins' version files, before it commits or tags anything. Returns { commit, tags }.
export function commitAndTag(names, root = ROOT) {
  if (!names.length) throw new Error('commit-and-tag takes the name of each released plugin');
  const plugins = names.map((name, index) => {
    const plugin = pluginNamed(name);
    if (!plugin || names.indexOf(name) !== index) throw new Error(`commit-and-tag: ${JSON.stringify(name)} is not a PLUGINS name, or repeats`);
    if (!existsSync(path.join(root, plugin.dir))) throw new Error(`commit-and-tag: ${plugin.dir} does not exist`);
    return plugin;
  });
  const allowed = new Set(plugins.flatMap((plugin) => versionPaths(root, plugin)));
  const changed = lines(gitOutput(root, 'status', '--porcelain', '--untracked-files=all')).map((line) => line.slice(3));
  const stray = changed.filter((file) => !allowed.has(file));
  if (stray.length) throw new Error(`commit-and-tag: paths other than the released plugins' version files changed:${stray.map((file) => `\n  ${file}`).join('')}`);
  const planned = plugins.map((plugin) => {
    const version = agreedVersion(root, plugin);
    const tag = `${plugin.prefix}${version}`;
    if (gitLine(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`) !== null) throw new Error(`commit-and-tag: the tag ${tag} exists; a tag never moves`);
    const first = !hasTag(root, plugin);
    const files = versionPaths(root, plugin).filter((file) => changed.includes(file));
    if (first === Boolean(files.length)) throw new Error(`commit-and-tag: ${plugin.name} ${first ? 'has its first release but changed a version file' : 'changed no version file'}`);
    return { plugin, version, tag, first, files };
  });
  const files = [...new Set(planned.flatMap((each) => each.files))];
  let commit = null;
  if (files.length) {
    gitOutput(root, 'add', '--', ...files);
    gitOutput(root, 'commit', '-q', '-m', `${RELEASE_SUBJECT}: ${planned.map(({ plugin, version }) => `${plugin.name} v${version}`).join(', ')}`);
    commit = gitOutput(root, 'rev-parse', 'HEAD').trim();
  }
  for (const { plugin, version, tag, first } of planned) {
    gitOutput(root, 'tag', '-a', tag, '-m', `${plugin.name} v${version}`, first ? manifestCommit(root, plugin) : commit);
  }
  return { commit, tags: planned.map(({ tag }) => tag) };
}

// The present plugins with no tag of their prefix: a first release that was refused, waiting for its hand tag.
export const untagged = (root = ROOT) => presentPlugins(root).filter((plugin) => !hasTag(root, plugin)).map((plugin) => plugin.name);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function attempt(action) {
  try {
    action();
  } catch (error) {
    fail(error.message);
  }
}

function main(args) {
  const [arg = 'patch', ...rest] = args;
  if (arg === 'release') return runRelease(rest);
  if (arg === 'lint-title') {
    if (rest.length !== 1) return fail(`${USAGE}\nlint-title takes one argument, the title`);
    return lintTitle(rest[0]);
  }
  if (arg === 'check-results') {
    if (rest.length !== 1) return fail(`${USAGE}\ncheck-results takes one argument, the file`);
    return attempt(() => {
      const problem = resultsProblem(readFileSync(rest[0], 'utf8'));
      if (problem) throw new Error(problem);
    });
  }
  if (arg === 'commit-and-tag') {
    return attempt(() => {
      const { commit, tags } = commitAndTag(rest);
      console.log(`${commit ? `committed ${commit}` : 'no commit'}; tagged ${tags.join(', ')}`);
    });
  }
  if (arg === 'tag-check') {
    if (rest.length) return fail(`${USAGE}\nunknown argument: ${rest[0]}`);
    const missing = untagged();
    if (missing.length) return fail(`no tag of its prefix yet, so its release waits for a hand tag (see the release log): ${missing.join(', ')}`);
    return console.log('ok: every plugin has a tag');
  }
  // Any other argument fails: a mistyped --check must not fall through to a bump.
  if (rest.length || (arg !== '--check' && !LEVELS.includes(arg))) return fail(`${USAGE}\nunknown argument: ${rest[0] ?? arg}`);
  if (arg === '--check') attempt(check);
  else bump(arg);
}

// Run only as the entry script. process.argv[1] is unset under `node -e` and need not be a file under `node -p`.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) main(process.argv.slice(2));
