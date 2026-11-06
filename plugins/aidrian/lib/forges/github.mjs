// The GitHub adapter of the forge facade: what the plugin asks of the code forge a pull request lives on, through gh
// (github-cli.mjs). Shared code calls the facade, from forgeFor in index.mjs, instead of a forge's commands and routes.
// Payloads stay GitHub's shapes until a second adapter gives a reason to change them.

import { runGh } from './github-cli.mjs';

// The author associations GitHub gives the people who belong to a repository.
export const MEMBER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Whether GitHub says the comment's author belongs to the repository. Anyone can comment on a pull request.
export const isTrustedCommenter = (comment) => MEMBER_ASSOCIATIONS.has(comment?.author_association);

const DEFAULT_HOST = 'github.com';
// `git@host:path`, git's scp-like form: no scheme, and a colon before the first slash.
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/u;
// A remote on this machine's disk, which names no forge: `/srv/git/x`, `./x`, `../x`, `~/x`, `C:/x`, `C:\x`.
const LOCAL_PATH = /^(?:[/.~\\]|[a-z]:[/\\])/iu;

const clean = (value) => value.toLowerCase().replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '').replace(/^\/+/u, '');
const identity = (host, rest) => {
  const repoPath = clean(rest);
  return host && repoPath.includes('/') && !repoPath.split('/').includes('') ? { host: host.toLowerCase(), path: repoPath, fork: null } : null;
};

// A repository's identity, `{ host, path, fork }`, from a `-R` value (`[HOST/]OWNER/REPO`), an https or ssh URL, or git's
// `git@host:path.git`. The path keeps every namespace level, so `a/sub/project` and `b/sub/project` stay apart, and a
// port or a user name is no part of it. A bare `owner/repo` is on github.com; three parts are `host/owner/repo`, as gh
// reads `-R`, and a longer path is accepted for a namespaced forge, which gh itself refuses. `fork` stays null here.
// Anything else is null: one bare name, and a local remote (an absolute, relative, or home path, a drive letter, file://).
export function repoIdentity(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (LOCAL_PATH.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    try {
      const url = new URL(text);
      return identity(url.hostname, decodeURIComponent(url.pathname));
    } catch {
      return null;
    }
  }
  const scp = SCP_LIKE.exec(text);
  if (scp) return identity(scp[1], scp[2]);
  const parts = clean(text).split('/');
  if (parts.length === 2) return identity(DEFAULT_HOST, parts.join('/'));
  return parts.length > 2 ? identity(parts[0], parts.slice(1).join('/')) : null;
}

// The adapter for the repository at `cwd`. `run` is gh, the test seam: the adapter's methods call it, and it stays in
// this closure, so no caller of the facade gets a raw gh. No method calls it yet: they move in with the later slices.
export function createGithubForge({ cwd, run = runGh } = {}) {
  return Object.freeze({
    id: 'github',
    cwd,
    isTrustedCommenter,
    repoIdentity,
  });
}
