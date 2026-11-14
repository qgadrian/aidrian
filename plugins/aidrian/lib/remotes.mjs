// The repositories a checkout's remotes name, as `owner/name`. It loads no forge, so a hook that only asks which
// repository a checkout is pays for no gh; lib/review-gate.mjs re-exports these for its own callers.

import { runGit } from './git.mjs';
import { normalizeRemote } from './project.mjs';

// `owner/name`, lower-cased, from any spelling gh takes: `[HOST/]OWNER/REPO`, a URL, a `.git` suffix; or null. A `.`
// or `..` owner or name is no repository: `../x` would otherwise match a remote at a path such as `/tmp/a/../x`.
export function repoName(value) {
  if (typeof value !== 'string') return null;
  const parts = normalizeRemote(value.replace(/\/(?:pull|issues)\/.*$/u, '')).toLowerCase().split('/').filter(Boolean);
  const name = parts.slice(-2);
  return name.length === 2 && !name.some((part) => part === '.' || part === '..') ? name.join('/') : null;
}

// The repository a `--repo` value names, as `owner/name`: the first step of every command's resolution of its pull
// request's repository (lib/review-gate.mjs prRepo), and all of it a hook reads, since a hook reads no forge. A value
// that is not OWNER/NAME throws.
export function givenRepo(given) {
  const name = repoName(given);
  if (!name) throw new Error(`--repo ${given} is not OWNER/NAME`);
  return name;
}

// ` --repo <repo>` for a command the review step prints about pull request repository `repo`, when this checkout's
// remotes name more than one repository, else ''. There the sign-off and round-raise rules count the Human's answer only
// on a command that names its repository (lib/rules/review-signoff.mjs approvalTarget), so the printed command runs as
// it is on the Human's answer, and acts on the repository the review ran on rather than the forge's default.
export const repoFlag = (project, repo) => (typeof repo === 'string' && repo !== '' && new Set(remoteRepos(project)).size > 1 ? ` --repo ${repo}` : '');

// This repository's `owner/name`, from its origin, or null.
export function originRepo(project) {
  const { status, stdout } = runGit(['config', '--get', 'remote.origin.url'], project.root);
  return status === 0 ? repoName(stdout) : null;
}

// The names of this checkout's remotes whose URL names repository `repo`, in git's order, or [] when none does or git
// cannot answer. A remote name may hold dots: `remote.<name>.url` is split at its last `.url`.
export function remotesNaming(project, repo, options) {
  const target = repoName(repo);
  if (target === null) return [];
  const { status, stdout } = runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], project.root, options);
  if (status !== 0) return [];
  return stdout.split('\n').flatMap((line) => {
    const match = /^remote\.(.+)\.url (.*)$/u.exec(line);
    return match && repoName(match[2]) === target ? [match[1]] : [];
  });
}

// The `owner/name` of every remote of this checkout, so a fork's parent counts with its origin. Empty when it has none.
export function remoteRepos(project, options) {
  const { status, stdout } = runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], project.root, options);
  if (status !== 0) return [];
  return stdout.split('\n').map((line) => repoName(line.slice(line.indexOf(' ') + 1))).filter(Boolean);
}
