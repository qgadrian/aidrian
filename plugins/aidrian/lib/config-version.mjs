// This plugin copy's manifest, and the error for a project folder of another version.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { VERSION } from './config-schema.mjs';

const manifest = () => JSON.parse(readFileSync(path.join(import.meta.dirname, '../plugin.json'), 'utf8'));

// The version of this plugin copy, from its manifest.
export const pluginVersion = () => manifest().version;

// The repository the plugin's manifest names, such as `https://github.com/<owner>/<repo>`, or null.
export const pluginRepository = () => {
  const { repository } = manifest();
  return typeof repository === 'string' && repository.trim() ? repository.trim() : null;
};

// Whether semver `a` is older than `b`; both are x.y.z.
export const older = (a, b) => {
  const [x, y] = [a, b].map((each) => each.split('.').map(Number));
  const at = x.findIndex((part, i) => part !== y[i]);
  return at !== -1 && x[at] < y[at];
};

// The error for a `version` other than VERSION, or null.
export function versionProblem(file, version) {
  if (version === VERSION) return null;
  const found = version === undefined ? 'missing' : JSON.stringify(version);
  return `${file}: project folder version ${found}; this plugin reads version ${VERSION}; see ${migratingUrl()}`;
}

// The migration notes in the repository the plugin's manifest names, so a fork links to its own.
function migratingUrl() {
  return `${pluginRepository()}/blob/main/docs/project-folder.md#migrating`;
}
