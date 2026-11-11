// The repositories a checkout's remotes name, as `owner/name`. It loads no forge, so a hook that only asks which
// repository a checkout is pays for no gh; lib/review-gate.mjs re-exports these for its own callers.

import { runGit } from './git.mjs';
import { normalizeRemote } from './project.mjs';

// `owner/name`, lower-cased, from any spelling gh takes: `[HOST/]OWNER/REPO`, a URL, a `.git` suffix; or null.
export function repoName(value) {
  if (typeof value !== 'string') return null;
  const parts = normalizeRemote(value.replace(/\/(?:pull|issues)\/.*$/u, '')).toLowerCase().split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

// This repository's `owner/name`, from its origin, or null.
export function originRepo(project) {
  const { status, stdout } = runGit(['config', '--get', 'remote.origin.url'], project.root);
  return status === 0 ? repoName(stdout) : null;
}

// The `owner/name` of every remote of this checkout, so a fork's parent counts with its origin. Empty when it has none.
export function remoteRepos(project, options) {
  const { status, stdout } = runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], project.root, options);
  if (status !== 0) return [];
  return stdout.split('\n').map((line) => repoName(line.slice(line.indexOf(' ') + 1))).filter(Boolean);
}
