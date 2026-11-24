// The store root of a project (review/signoff-store.mjs storeRoot) for a command that has not resolved its run's state
// folder: the sign-off store's writer (`aidrian pr signoff`) and its readers on the way to a merge (`aidrian pr
// auto-merge`, the merge guard, the waiver). A project run's start and preflight, and the recorded-decision store's
// writer, take it from the state folder runPlace resolved instead (lib/project-run.mjs), and this gives the same folder:
// the state root while no state.dir places the state folder, else that folder, as the base branch's config names it,
// which no variable moves.

import { baseBranchConfig } from './handoff-continue.mjs';
import { loadConfig } from './config.mjs';
import { stateDir, stateRoot } from './project.mjs';
import { readHumanSignoffs, storeRoot } from './review/signoff-store.mjs';

// { root } or { problem }. With no state.dir in the working config `config` the root is the state root, and git is not
// asked. With one, it must be the base branch's, never a working copy's alone, which a confined session may edit to
// point at a folder it writes: a base branch that names another state.dir is a problem. `trusted` is the default
// branch's config a caller already read, such as the forge's copy a merge reads its policy from; with none, this
// checkout's git reads the base branch's.
export function projectStoreRoot(project, { env = process.env, config = null, trusted = null } = {}) {
  const working = config ?? loadConfig(project).config;
  if (!working.state.dir) return { root: stateRoot(env) };
  // A repository whose base branch git cannot name keeps no team config to place them by: the state root, as before.
  const base = trusted ? { config: trusted } : baseBranchConfig(project, 'the state folder the stores are kept in');
  if (base.why) return { root: stateRoot(env) };
  if (base.config.state?.dir !== working.state.dir) return { problem: 'the working copy\'s state.dir is not the one the base branch\'s config.json names, and only that one holds the stores' };
  try {
    return { root: storeRoot(stateDir(project, { config: base.config, env }), true) };
  } catch (error) {
    return { problem: `the base branch's state.dir cannot be resolved (${String(error?.message ?? error).split('\n')[0]})` };
  }
}

// The Human's sign-offs of pull request `pr` of `repo` from the store of `project` under its store root
// (projectStoreRoot), as readHumanSignoffs answers; { problem } when the root cannot be placed, which counts every flow
// unsigned. With no project, the store under the state root `env` names, as before any project was known.
export function storeSignoffs(project, { repo, pr, env = process.env, config = null, trusted = null }) {
  if (!project) return readHumanSignoffs({ repo, pr, env });
  const placed = projectStoreRoot(project, { env, config, trusted });
  if (placed.problem) return { problem: `the sign-off store cannot be placed: ${placed.problem}` };
  return readHumanSignoffs({ repo, pr, env, root: placed.root });
}
