// What a `git push` on a session's command line pushed, for the session ledger (lib/session-prs.mjs), read from what git
// itself recorded rather than rebuilt from the command's words and config. Git is no forge, so this names none. isPush
// says whether a walked command is a push the ledger may read; pushedRefs reads the remote-tracking refs a push updated
// from the reflogs git keeps for them.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';

import { changesVariable, readGit } from './shell-lex.mjs';

// The variables that move the repository, the work tree, or the config git reads: set, unset, or emptied by `env -i` on
// the line, they make every git and forge call on it record nothing. GIT_CONFIG_KEY_<n> takes effect only with
// GIT_CONFIG_COUNT, so that name covers them.
const GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
// The git global options a read push may carry: `-C` with its folder, which the walk reads, and switches that change no
// repository or config. Any other, such as `-c`, `--config-env`, `--git-dir`, or `--work-tree`, gives nothing.
const PLAIN_GLOBALS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs']);

// Whether readInvocation's invocation changes a variable of GIT_VARIABLES for what it runs, or for the shell after it.
export const changesGitTarget = (invocation) => GIT_VARIABLES.some((name) => changesVariable(invocation, name));

// Whether every git global option before `push` is `-C` with its folder or one of PLAIN_GLOBALS.
export function plainGlobals(globals) {
  for (let i = 0; i < globals.length; i += 1) {
    if (globals[i].text === '-C') i += 1;
    else if (!PLAIN_GLOBALS.has(globals[i].text)) return false;
  }
  return true;
}

// Whether one walked command (shell-lex walkCommands) is a `git push` whose record the ledger may read: one with no git
// global option that may move its repository or config, and that changes no variable of GIT_VARIABLES itself.
export function isPush(entry) {
  const git = readGit(entry.segment);
  return git?.subcommand === 'push' && plainGlobals(git.globals) && !changesGitTarget(entry.invocation);
}

// How long before the hook reads it a push's record may have been written and still be read as this call's.
export const PUSH_WINDOW_MS = 60_000;
// The most entries one read visits under logs/refs/remotes, and how much of each log's end it reads.
const MAX_ENTRIES = 4096;
const TAIL_BYTES = 4096;
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
// The message git writes in a remote-tracking ref's reflog when a push updates that ref.
const PUSHED = 'update by push';

// The last whole line of the regular file `file`, from its last TAIL_BYTES, opened no-follow, or null.
function lastLine(file) {
  let fd = null;
  try {
    fd = openSync(file, READ);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const { size } = stat;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8', 0, read).replace(/\n$/u, '').split('\n');
    return lines.length > 1 || read === size ? lines.at(-1) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Whether a reflog line, git's `<old> <new> <name> <email> <time> <zone>\t<message>`, records a push of the commit
// `head` within PUSH_WINDOW_MS of `now`.
function pushedWithin(line, now, head) {
  const tab = line.indexOf('\t');
  if (tab === -1 || line.slice(tab + 1) !== PUSHED) return false;
  const fields = line.slice(0, tab).split(' ');
  const time = Number(fields.at(-2)) * 1000;
  return fields[1] === head && Number.isFinite(time) && Math.abs(now - time) <= PUSH_WINDOW_MS;
}
// A full object id, as `git rev-parse HEAD` prints it: SHA-1 or SHA-256.
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

// The remote-tracking refs a push updated to the commit `head` within PUSH_WINDOW_MS of `now`, each as its path under
// refs/remotes/, such as `origin/feat/x`, from the reflogs under `<commonDir>/logs/refs/remotes`: a log whose mtime is
// older than the window is skipped, a symlink is never followed, and of each other log only its last line is read.
// MAX_ENTRIES entries at most. `head` is the HEAD commit of the folder the push ran in, so a push a sibling worktree
// made, which shares this common dir, gives none unless it pushed that same commit. No `head` gives none.
// A tag push, a delete, a push to a URL rather than a remote's name, and a repository whose refs git keeps in a reftable
// leave no such log, so they give none.
export function pushedRefs(commonDir, head, now = Date.now()) {
  if (typeof head !== 'string' || !OBJECT_ID.test(head)) return [];
  const found = [];
  let visited = 0;
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) return;
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile() && recent(file, now) && pushedWithin(lastLine(file) ?? '', now, head)) found.push(name);
    }
  };
  walk(path.join(commonDir, 'logs', 'refs', 'remotes'), '');
  return found;
}

// Whether the file `file` was changed within PUSH_WINDOW_MS of `now`.
function recent(file, now) {
  try {
    return now - lstatSync(file).mtimeMs <= PUSH_WINDOW_MS;
  } catch {
    return false;
  }
}
