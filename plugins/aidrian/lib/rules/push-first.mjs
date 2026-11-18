// Bash rule: no full test suite while the branch holds a commit its remote lacks (docs/hooks.md#push-first). A fix held
// back for a local full run once waited two hours on a loaded machine while CI, green on the previous head, could have
// run it at once. A command of config.json `testing.fullSuite`, as written with no more arguments (check-runs.mjs
// isFullSuite), is refused when the folder it runs in is on a branch whose remote copy exists and lacks a commit older
// than `testing.pushFirstMinutes`; 0 turns the rule off. The remote is the branch's push remote, else `remote.pushDefault`,
// else its upstream's remote, else `origin`, and the copy is `refs/remotes/<remote>/<branch>`: a branch never pushed has
// none, so the rule leaves its first full run alone. Runs git only for a command whose words match a full suite.

import { isFullSuite } from '../check-runs.mjs';
import { loadConfig } from '../config.mjs';
import { runGit } from '../git.mjs';
import { findProject } from '../project.mjs';
import { walkCommands } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_FULL_SUITE';
const MAY_RUN = /test|check/u;
const MAX_ENTRIES = 16;

// The deny reason for `command`, or null. `now` is in milliseconds; `git` is runGit's seam.
export function check(command, { cwd = process.cwd(), env = process.env, now = Date.now(), git = runGit } = {}) {
  if (env[OVERRIDE] === '1' || !MAY_RUN.test(command)) return null;
  const configs = new Map();
  for (const { invocation, folder } of walkCommands(command, cwd).slice(0, MAX_ENTRIES)) {
    if (invocation.dynamic || !invocation.program) continue;
    const where = folder ?? cwd;
    if (!configs.has(where)) {
      const project = findProject(where);
      configs.set(where, project ? loadConfig(project).config.testing : null);
    }
    const testing = configs.get(where);
    if (!testing?.pushFirstMinutes || !isFullSuite(invocation, testing)) continue;
    const held = unpushed(where, git);
    if (!held) continue;
    const minutes = Math.floor((now / 1000 - held.oldest) / 60);
    if (minutes < testing.pushFirstMinutes) continue;
    return reason({ ...held, minutes, command: [invocation.program, ...invocation.args.map((token) => token.text)].join(' ') });
  }
  return null;
}

// The branch at `cwd` and its remote copy, as { branch, remote, ref }, `ref` the full ref, or null when HEAD is no branch
// or the branch has no remote copy.
export function remoteCopy(cwd, git = runGit) {
  const line = (args) => {
    const result = git(args, cwd);
    return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null;
  };
  const branch = line(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return null;
  const remote = line(['config', `branch.${branch}.pushRemote`]) ?? line(['config', 'remote.pushDefault'])
    ?? line(['config', `branch.${branch}.remote`]) ?? 'origin';
  const ref = `refs/remotes/${remote}/${branch}`;
  return line(['rev-parse', '--verify', '--quiet', ref]) ? { branch, remote, ref } : null;
}

// The commits of the branch at `cwd` that its remote copy lacks, as { branch, remoteRef, count, oldest }, `oldest` the
// earliest committer time in seconds; null when there is no remote copy (remoteCopy), or it lacks none.
export function unpushed(cwd, git = runGit) {
  const copy = remoteCopy(cwd, git);
  if (!copy) return null;
  const log = git(['log', '--format=%ct', `${copy.ref}..HEAD`], cwd);
  const times = log.status === 0 ? log.stdout.split('\n').map(Number).filter((time) => Number.isFinite(time) && time > 0) : [];
  if (!times.length) return null;
  return { branch: copy.branch, remoteRef: `${copy.remote}/${copy.branch}`, count: times.length, oldest: Math.min(...times) };
}

// The first sentence stays as it is: lessons and reports group this rule's denies by it.
function reason({ branch, remoteRef, count, minutes, command }) {
  return `Blocked: \`${command}\` runs the full suite while branch \`${branch}\` holds ${count} commit(s) that \`${remoteRef}\` lacks, ` +
    `the oldest ${minutes} minutes old. Push first: CI runs the full suite on the pushed head, and a reviewer's re-check runs ` +
    'on that head beside CI, never as a gate before the push. Locally, run only the test files the change touches: ' +
    '`aidrian test changed`. A test that fails only under load in a file the change does not touch is rerun alone, not chased. ' +
    'A project whose CI cannot run the suite sets config.json `testing.pushFirstMinutes` to 0, and runs it once before marking ready. ' +
    `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
