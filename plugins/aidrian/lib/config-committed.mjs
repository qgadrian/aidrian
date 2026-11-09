// The project config as a commit holds it, with no machine settings: what a pull request cannot change from its own
// working copy, and the team's `decisions`, auto-merge allowance, and `quorum.product` at a commit.

import { spawnSync } from 'node:child_process';

import { DEFAULTS, deepFreeze } from './config-defaults.mjs';
import { legacyHandoff, merge } from './config-merge.mjs';
import { NO_REVIEWER, SCHEMA } from './config-schema.mjs';
import { versionProblem } from './config-version.mjs';
import { isObject } from './fs.mjs';
import { runGit } from './git.mjs';

// The project config as committed at `commit`, with no machine settings: what a pull request cannot change from its
// own working copy, such as github.maxReviewRounds. A commit with no config, or one that does not parse, gives
// DEFAULTS; a value that fails its check keeps its default, as loadConfig does, and goes to `errors` when the caller
// passes that list. `options` overrides the spawn's, such as a hook's shorter timeout.
export function committedConfig(project, commit, errors = [], options = {}) {
  // `./`: the path from project.root, where git runs, so a project below the repository root reads its own file.
  const shown = spawnSync('git', ['show', `${commit}:./${project.paths.config}`], { cwd: project.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000, ...options });
  if (shown.error || shown.signal) throw new Error(`git show ${commit}:./${project.paths.config} failed: ${shown.error?.message ?? shown.signal}`);
  return configFromText(shown.status === 0 ? shown.stdout : null, project.paths.config, errors);
}

// The commit of origin's default branch, from names the working copy cannot set: origin/HEAD, then the plugin's default
// branch name on origin, never the `git.defaultBranch` a working copy's config names. Null when neither resolves. Throws
// when git fails on one, whose answer the next ref must not replace: for rev-parse, 1 is git saying no such ref.
// `git` gives each read's options.
export function originDefaultTip(root, git = () => undefined) {
  for (const ref of ['refs/remotes/origin/HEAD', `refs/remotes/origin/${DEFAULTS.git.defaultBranch}`]) {
    const tip = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, git());
    if (tip.status === 0) return tip.stdout.trim();
    if (tip.status !== 1) throw new Error(`git rev-parse ${ref} failed`);
  }
  return null;
}

// Why a record read through the working copy's `state.dir` is not the one the committed config names, or null. `working`
// and `committed` are configs, `where` names the commit's branch in the message, and `record` the record the reader reads.
// Every command that holds does it through this one check.
export function stateDirProblem(working, committed, where, record = 'the review record') {
  if (working.state.dir === committed.state.dir) return null;
  return `the working copy's state.dir differs from ${where}, and ${record} is read from it`;
}

// The project config committed as `text` at `file`, with no machine settings, by committedConfig's rules: null (no file)
// or text that does not parse gives DEFAULTS, and a value that fails its check keeps its default and goes to `errors`.
// For a commit read some other way, such as a base branch read through GitHub.
export function configFromText(text, file, errors = []) {
  if (typeof text !== 'string') return DEFAULTS;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULTS;
  }
  if (!isObject(raw) || versionProblem(file, raw.version)) return DEFAULTS;
  const { version, ...rest } = raw;
  const config = merge(SCHEMA, DEFAULTS, legacyHandoff(rest, file, errors), '', file, errors, []);
  if (config.github.reviewer === NO_REVIEWER) config.github = { ...config.github, reviewer: null };
  return deepFreeze(config);
}

// configFromText for a reader that must not take a broken file for the defaults: text that does not parse, is no object,
// or has another version throws, and so does an error `fatal` picks out. Null, no file, is still the defaults.
export function strictConfigFromText(text, file, fatal = () => false) {
  if (typeof text !== 'string') return DEFAULTS;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  if (!isObject(raw)) throw new Error(`${file}: must be a JSON object`);
  const problem = versionProblem(file, raw.version);
  if (problem) throw new Error(problem);
  const errors = [];
  const config = configFromText(text, file, errors);
  const broken = errors.find(fatal);
  if (broken) throw new Error(broken);
  return config;
}

// The team's `decisions` at `commit`, from the config file `file` that commit names (project.mjs committedConfigFile),
// with what committedConfig does not say: a commit where that file is missing, does not parse, or has another version,
// or `file` null, has no team block to read, and one with an error under `decisions` has a block no one can read as the
// team meant it. Either way the ceiling is "ask", spelled here so it does not follow the default, and the block's other
// values are the defaults, not a partial block's. committedConfig returns DEFAULTS itself only in the first cases.
// No one can say what such a block listed, so `safeDefaults` is null, which no config can set, and an unattended run parks:
// a commit whose config.json is missing, does not parse, or has another version, and one with an error under `decisions`.
// A config.json with no `decisions` key says nothing to misread: it takes the defaults, as any other unset group does.
export const committedDecisions = (project, commit, file) => committedAuthority(project, commit, file).decisions;

// committedDecisions' block and `autoMergeAllow`, whether that same commit sets `github.autoMerge.allow` true: false for a
// block no one can read, since its team said nothing anyone can read. resolveAuthority takes it as the team's acceptance.
export function committedAuthority(project, commit, file) {
  const askOnly = { decisions: { ...DEFAULTS.decisions, maxMode: 'ask', unattended: { safeDefaults: null } }, autoMergeAllow: false };
  if (file === null) return askOnly;
  const errors = [];
  const committed = committedConfig({ ...project, paths: { ...project.paths, config: file } }, commit, errors);
  if (committed === DEFAULTS || errors.some((error) => /"decisions[".]/u.test(error))) return askOnly;
  return { decisions: committed.decisions, autoMergeAllow: committed.github.autoMerge.allow === true };
}

// The team's `quorum.product` at `commit`, from the config file `file` that commit names, as committedAuthority finds it:
// the defaults, which are off, for a commit with no readable config, `file` null, or an error in this block, which no one
// can read as the team meant it. An error elsewhere in the config leaves this block readable.
export function committedQuorumProduct(project, commit, file) {
  if (file === null) return DEFAULTS.quorum.product;
  const errors = [];
  const committed = committedConfig({ ...project, paths: { ...project.paths, config: file } }, commit, errors);
  return errors.some((error) => /"quorum(?:"|\.product[".])/u.test(error)) ? DEFAULTS.quorum.product : committed.quorum.product;
}
