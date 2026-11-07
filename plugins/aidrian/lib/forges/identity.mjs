// The facade's own helper: which repository a remote URL or a `-R` value names. It reads text, calls no forge, and runs
// before a forge is chosen, so it belongs to no adapter. Shared code imports it from index.mjs, never from this file.

// The default forge's host: a bare `owner/repo` names a repository there, as gh reads `-R`.
const DEFAULT_HOST = 'github.com';
// Hosts that reach the same repositories as another, read as that one so every caller compares canonical hosts:
// GitHub's SSH endpoint on port 443, for networks that block port 22, on any port.
const HOST_ALIASES = { 'ssh.github.com': 'github.com' };
// `git@host:path`, git's scp-like form: no scheme, and a colon before the first slash.
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/u;
// A remote on this machine's disk, which names no forge: `/srv/git/x`, `./x`, `../x`, `~/x`, `C:/x`, `C:\x`.
const LOCAL_PATH = /^(?:[/.~\\]|[a-z]:[/\\])/iu;

const clean = (value) => value.toLowerCase().replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '').replace(/^\/+/u, '');
const identity = (host, rest) => {
  const repoPath = clean(rest);
  if (!host || !repoPath.includes('/') || repoPath.split('/').includes('')) return null;
  const name = host.toLowerCase();
  return { host: Object.hasOwn(HOST_ALIASES, name) ? HOST_ALIASES[name] : name, path: repoPath };
};

// A repository's identity, `{ host, path }`, from a `-R` value (`[HOST/]OWNER/REPO`), an https or ssh URL, or git's
// `git@host:path.git`. The path keeps every namespace level, so `a/sub/project` and `b/sub/project` stay apart, and a
// port or a user name is no part of it. A bare `owner/repo` is on the default forge's host, github.com; three parts are
// `host/owner/repo`, as gh reads `-R`, and a longer path is accepted for a namespaced forge, which gh itself refuses.
// An aliased host is read as its canonical one (HOST_ALIASES).
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
