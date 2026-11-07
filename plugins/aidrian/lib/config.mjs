// Loads config.json from the project folder: the folder version and the project's settings for this plugin.
// docs/config.md lists the keys; docs/project-folder.md gives the version rule.
// No dependencies: this file runs from the installed plugin, which has no node_modules.
// The public entry: every config name is importable from here. The schema, its types, the defaults, the merge, the
// commit readers, the local caps, and the version checks live in the config-*.mjs files beside it.

import path from 'node:path';

import { DEFAULTS, deepFreeze } from './config-defaults.mjs';
import { localDecisions } from './config-local.mjs';
import { checkAgents, checkModels, legacyHandoff, merge } from './config-merge.mjs';
import { NO_REVIEWER, SCHEMA } from './config-schema.mjs';
import { older, pluginVersion, versionProblem } from './config-version.mjs';
import { isFile, readJson } from './fs.mjs';
import { checkLocalReview, checkLocalVisual } from './review/config.mjs';

export { committedAuthority, committedConfig, committedDecisions, committedQuorumProduct, configFromText, strictConfigFromText } from './config-committed.mjs';
export { DEFAULTS } from './config-defaults.mjs';
export { localDecisions, resolveAutoMerge } from './config-local.mjs';
export { AUDIT_LABEL_FIELDS, COMMIT_FIELDS, MAX_PLAN_OBJECTIONS, NO_REVIEWER, PR_FIELDS, VERSION } from './config-schema.mjs';
export { pluginRepository, pluginVersion, versionProblem } from './config-version.mjs';

// Returns { config, errors, gateErrors, current }. `config` is frozen and always complete: the file's values over DEFAULTS, one
// group at a time, with the default kept for any value that is missing or invalid. The local file's `models`, `names`,
// `telemetry`, and `agents` (`project.localModels`, `project.localNames`, `project.localTelemetry`, `project.localAgents`) then
// go over the file's. A hook can use it even when `errors` is not empty. `current` is false when the file is missing,
// unreadable, or of another version: then nothing in the folder
// can be trusted to have the shape this plugin reads. `gateErrors` holds the errors of `errors` that dropped a gate,
// as { file, problem }: see checkAgents.
export function loadConfig(project) {
  const errors = [];
  const gateErrors = [];
  const file = project.paths.config;
  const raw = readJson(project.root, file, errors);
  if (!raw) return { config: DEFAULTS, errors, gateErrors, current: false };
  const problem = versionProblem(file, raw.version);
  if (problem) return { config: DEFAULTS, errors: [problem], gateErrors, current: false };
  const { version, ...rest } = raw;
  const values = legacyHandoff(rest, file, errors);
  const config = merge(SCHEMA, DEFAULTS, values, '', file, errors, gateErrors);
  if (config.github.reviewer === NO_REVIEWER) config.github = { ...config.github, reviewer: null };
  if (project.localModels !== undefined) config.models = checkModels(project.localModels, project.paths.local, errors, config.models);
  for (const [key, local] of [['names', project.localNames], ['telemetry', project.localTelemetry]]) {
    if (local !== undefined) config[key] = merge({ [key]: SCHEMA[key] }, config, { [key]: local }, '', project.paths.local, errors)[key];
  }
  // The machine's review engine, from the local file; config.json `review.engine`, when set, wins (lib/review/reviewers.mjs).
  config.reviewEngine = project.localReview === undefined ? 'auto' : checkLocalReview(project.localReview, project.paths.local, errors);
  config.reviewVisual = checkLocalVisual(project.localReview, project.paths.local, errors);
  if (project.localAgents !== undefined) config.agents = checkAgents(project.localAgents, project.paths.local, errors, config.agents, gateErrors);
  config.decisions = localDecisions(config.decisions, project, errors);
  return { config: deepFreeze(config), errors, gateErrors, current: true };
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

// The problem when this plugin copy is older than the version the project requires (`requires` in config.json), or null. It names the copy that
// runs, because a session can load an older install than the one the project was set up with.
export function versionFloorProblem(config, running = pluginVersion()) {
  const { aidrian: floor } = config.requires ?? {};
  if (!floor || !older(running, floor)) return null;
  const root = path.resolve(import.meta.dirname, '..');
  return `this project requires aidrian ${floor} or later, and this session runs ${running} from ${root}: update the plugin, then start a new session`;
}

// The first of loadConfig's `gateErrors`, as { file, problem }, or null. Without that gate the hook treats the file
// as one it cannot read.
export function malformedGates(gateErrors) {
  return gateErrors[0] ?? null;
}
