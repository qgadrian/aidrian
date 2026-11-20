// `solo` in config.json (docs/config.md#solo): the team's word that one person runs the project, which turns on each
// unattended machine switch the local file leaves unset (config-local.mjs machineSwitch). It is policy, so it is read
// from the base branch only, never the working copy or loadConfig: first as this checkout's git holds the default
// branch (handoff-continue.mjs localRefSolo), which may only refuse, then from the forge where a command acts, as each
// branch commits it now, at `refs/heads/<branch>` (pr-auto-merge.mjs branchPolicies): true only when the default branch
// and the base both commit it. A read that fails is false. With no pull request, the forge's repository is the one the
// origin remote names, so the guards refuse a subagent and an unattended session a change of remotes
// (handoff-guard.mjs remoteChangeDenial).

import { forgeFor, repoIdentity } from './forges/index.mjs';
import { knownPrefix, runGit } from './git.mjs';
import { localRefSolo } from './handoff-continue.mjs';
import { branchPolicies, soloOn } from './pr-auto-merge.mjs';
import { hostOf, repoName } from './remotes.mjs';

export { localRefSolo };

// The repository the origin remote names on its forge: { repo, host }, or null. Read from the repository's own config
// file alone, with no file it includes, and only when it holds exactly one URL for origin: a global or included config,
// or a second URL, cannot point it at another repository.
function originOf(project) {
  const { status, stdout } = runGit(['config', '--local', '--no-includes', '--get-all', 'remote.origin.url'], project.root);
  const urls = status === 0 ? stdout.split('\n').filter((line) => line.trim() !== '') : [];
  const id = urls.length === 1 ? repoIdentity(urls[0].trim()) : null;
  return id ? { repo: id.path, host: id.host } : null;
}

// Whether the forge says the default branch and `base` both commit `solo: true`, for `project`. `repo` and `host` name a
// pull request's repository; without `repo`, origin's, and a null `base` is its default branch. `forge` is the facade,
// forgeFor's at the project root unless a test passes its own. Any failure is false. It reads no local ref: a caller
// that has not read one calls soloOf.
export function forgeSolo(project, { forge = null, repo = null, host = null, base = null } = {}) {
  try {
    const where = repo ? { repo, host } : originOf(project);
    const prefix = knownPrefix(project.root);
    if (!where || prefix === null) return false;
    return soloOn(branchPolicies(forge ?? forgeFor(project.root), { ...where, base }, prefix));
  } catch {
    return false;
  }
}

// Whether `solo` is on for `project`: the local ref first, which only refuses, then the forge (forgeSolo).
export const soloOf = (project, options) => localRefSolo(project) && forgeSolo(project, options);

// Whether `solo` is on for a pull request the forge described as `view`, { baseRefName, url }: soloOf at the repository
// and host its URL names and at its base. A view with no base, or a URL that names no repository, is false. `localRef`
// is localRefSolo's answer when the caller read it already.
export function viewSolo(project, view, { forge = null, localRef = null } = {}) {
  const repo = repoName(typeof view?.url === 'string' ? view.url : null);
  const host = hostOf(view?.url);
  const base = typeof view?.baseRefName === 'string' && view.baseRefName !== '' ? view.baseRefName : null;
  if (!repo || !host || !base) return false;
  return (localRef ?? localRefSolo(project)) === true && forgeSolo(project, { forge, repo, host, base });
}

// Whether `solo` is on for a command on pull request `pr`, of `repo` when given: viewSolo of its view, read from the
// forge only once the local ref says solo. A pull request the forge does not describe is false.
export function prSolo(project, pr, { forge = null, repo = null } = {}) {
  if (!localRefSolo(project)) return false;
  try {
    const facade = forge ?? forgeFor(project.root);
    const view = repo ? facade.change(String(pr), 'baseRefName,url', { repo }) : facade.change(String(pr), 'baseRefName,url');
    return viewSolo(project, view, { forge: facade, localRef: true });
  } catch {
    return false;
  }
}
