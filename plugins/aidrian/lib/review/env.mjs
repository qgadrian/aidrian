// The environment a reviewer, a plan command, or a test runs in: none of the variables that change what the code
// they read does. scripts/test-state.mjs uses the same list for the test suite.
// - CLAUDE_CODE_AGENT and CLAUDE_CODE_SESSION_ID: the running session's identity.
// - AIDRIAN_ALLOW_*: the escape hatches that switch a rule off; a reviewer never runs with one.
// - GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the others git sets in a hook: with one set, a `git` call acts on
//   another repository than the one in its folder.

export const SESSION_VARS = Object.freeze(['CLAUDE_CODE_AGENT', 'CLAUDE_CODE_SESSION_ID']);
// The variables git reads to find a repository, as `git rev-parse --local-env-vars` lists them.
export const GIT_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_WORK_TREE',
]);

// `env` without those variables, changed in place and returned.
export function isolate(env) {
  for (const key of Object.keys(env)) {
    if (SESSION_VARS.includes(key) || GIT_VARS.includes(key) || key.startsWith('AIDRIAN_ALLOW_')) delete env[key];
  }
  return env;
}
