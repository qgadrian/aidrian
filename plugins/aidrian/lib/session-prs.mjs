// The session's pull request ledger, `<state>/sessions/<session id>/prs.jsonl` (docs/hooks.md#session-ledger): one row a
// change request a session's shell call creates, pushes a branch of, or acts on. Display data only: no hook, gate, skill,
// or agent decides anything from it. scripts/hook-bash-post.mjs writes it after each shell call that succeeded.
//
// This file names no forge. A forge's reader of its own command comes in the `readers` table, keyed by its adapter's
// id; the adapter, from forgeFor, gives that id, its `hosts`, and `changeRef`, the one shape check of a ref. What is
// read here is git's, which is no forge: what a push recorded (lib/git-push.mjs), and the remotes and the branch of the
// folder a call ran in. A row is `{ at, agentId, kind, forge, host, path, number, branch, cwd }`, with no raw URL, command text, or
// output, and every field checked first, so no row exceeds a fixed size. `aidrian session snapshot` reads it back:
// readLedger, then sessionRefs, then resolveSelection through the adapter's one batched read, cached, and shownChanges.
// It holds both the writer and the reader of the one ledger, so the hook's forge-seam test reads a single file.

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { remoteIdentity } from './forges/index.mjs';
import { isRefName, runGit } from './git.mjs';
import { changesGitTarget, isPush, pushedRefs } from './git-push.mjs';
import { SESSION_ID } from './handoff-markers.mjs';
import { hasHidden } from './hidden-text.mjs';
import { appendRows, readRows } from './session-rows.mjs';
import { changesVariable, commandLines, lexCommand, readGit, readInvocation, shellRedirections, walkCommands } from './shell-lex.mjs';

// The ledger's name in the session folder (lib/session-folder.mjs APPENDED_FILES).
export const LEDGER = 'prs.jsonl';
// The largest the ledger grows. The snapshot and the writer read at most this much of it, from its end. A write that
// would pass it, or finds the ledger past it, compacts the ledger first, keeping the newest rows within half of it.
export const LEDGER_MAX_BYTES = 256 * 1024;
// How much of a call's output is read, from its end, for the links a create prints.
export const OUTPUT_TAIL = 64 * 1024;
// The most folders one call has git read, and the most rows it writes.
export const MAX_FOLDERS = 8;
export const MAX_ROWS = 32;
// The most change requests the snapshot shows, each a ref of the ledger, a number or a branch, counted before branches
// resolve, so a branch with no change request uses one. The forge's batched read takes as many at most.
export const MAX_REFS = 25;
const CWD_MAX_BYTES = 1024;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

// What git says of a folder, read once each and for MAX_FOLDERS folders at most: from one `git config` read, its remotes
// by name, each `{ fetch, push }` as remoteIdentity reads the first `remote.<name>.url` and the first
// `remote.<name>.pushurl`, null for one it cannot read or that git reads as a path on this machine, such as a `file:`
// URL or `archive/widgets`, and absent for none, and
// each branch's `merge`; the current branch; and the remote-tracking refs a push updated to the folder's HEAD commit,
// which one `git rev-parse HEAD` reads (pushedRefs), in the git common dir one `git rev-parse --git-common-dir` names.
// A key git keeps one value of takes its last, as git does. No value of the ledger reaches git's argv.
// SHORTCUT: a `url.<base>.insteadOf` or `pushInsteadOf` rewrite in the folder's config is not applied, so a rewritten
// remote records the URL as written. Enough for display data; applying git's rewrite rules here would replace it.
const CONFIG_KEYS = '^(remote\\..*\\.(url|pushurl)|branch\\..*\\.merge)$';
function readConfig(stdout) {
  const config = { remotes: new Map(), branches: new Map() };
  for (const line of stdout.split('\n')) {
    const remote = /^remote\.([^ ]+)\.(url|pushurl) (.*)$/u.exec(line);
    const branch = /^branch\.([^ ]+)\.merge (.*)$/u.exec(line);
    if (remote) {
      const each = config.remotes.get(remote[1]) ?? {};
      const key = remote[2] === 'url' ? 'fetch' : 'push';
      if (!Object.hasOwn(each, key)) each[key] = remoteIdentity(remote[3]);
      config.remotes.set(remote[1], each);
    } else if (branch) config.branches.set(branch[1], { merge: branch[2] });
  }
  return config;
}
const NO_CONFIG = Object.freeze({ remotes: new Map(), branches: new Map() });
function folderReader(read) {
  const configs = new Map();
  const branches = new Map();
  const pushes = new Map();
  const readable = (folder) => configs.has(folder) || configs.size < MAX_FOLDERS;
  const configOf = (folder) => {
    if (!readable(folder)) return NO_CONFIG;
    if (!configs.has(folder)) {
      const { status, stdout } = read(['config', '--get-regexp', CONFIG_KEYS], folder);
      configs.set(folder, status === 0 ? readConfig(stdout) : NO_CONFIG);
    }
    return configs.get(folder);
  };
  const branchOf = (folder) => {
    if (!readable(folder)) return null;
    configOf(folder);
    if (!branches.has(folder)) {
      const { status, stdout } = read(['symbolic-ref', '--short', '-q', 'HEAD'], folder);
      branches.set(folder, status === 0 ? stdout.trim() || null : null);
    }
    return branches.get(folder);
  };
  const pushedOf = (folder, now) => {
    if (!readable(folder)) return [];
    configOf(folder);
    if (!pushes.has(folder)) {
      const { status, stdout } = read(['rev-parse', '--git-common-dir'], folder);
      const common = status === 0 ? stdout.replace(/\n$/u, '') : '';
      const head = common === '' ? null : read(['rev-parse', 'HEAD'], folder);
      pushes.set(folder, head?.status === 0 ? pushedRefs(path.resolve(folder, common), head.stdout.trim(), now) : []);
    }
    return pushes.get(folder);
  };
  return { config: configOf, remotes: (folder) => configOf(folder).remotes, branch: branchOf, pushed: pushedOf };
}

// The repositories the remotes of `folder` name, each remote's `url` and `pushurl` as readConfig reads them, from one
// `git config --get-regexp` with constant arguments, distinct, as `{ host, path }`; [] when git finds no key, and null
// when the read fails. A remote git reads as a folder on disk names none. `read` runs git, which a test may replace.
export function remoteRepos(folder, read = runGit) {
  const { status, stdout } = read(['config', '--get-regexp', CONFIG_KEYS], folder);
  if (status === 1 && stdout === '') return [];
  if (status !== 0) return null;
  const out = [];
  for (const { fetch = null, push = null } of readConfig(stdout).remotes.values()) {
    for (const repo of [fetch, push]) if (repo && !out.some((each) => sameRepo(each, repo))) out.push({ host: repo.host, path: repo.path });
  }
  return out;
}

// The repository the remote `name` of `folder` fetches from, `{ host, path }`, read as remoteRepos reads every remote,
// from the same `git config --get-regexp` with constant arguments, so a writer that records it and a reader that
// compares it with remoteRepos spell it alike, with no `url.<base>.insteadOf` rewrite on either side; null for none or
// a failed read. `read` runs git, which a test may replace.
export function remoteRepository(folder, name, read = runGit) {
  const { status, stdout } = read(['config', '--get-regexp', CONFIG_KEYS], folder);
  const repo = status === 0 ? readConfig(stdout).remotes.get(name)?.fetch ?? null : null;
  return repo && { host: repo.host, path: repo.path };
}

const sameRepo = (a, b) => Boolean(a && b) && a.host === b.host && a.path === b.path;

// The distinct repositories on a host in `hosts` that the remotes of `folder` fetch from.
function declaredRepos(folders, folder, hosts) {
  const out = [];
  for (const { fetch = null } of folders.remotes(folder).values()) {
    if (fetch && hosts.includes(fetch.host) && !out.some((each) => sameRepo(each, fetch))) out.push(fetch);
  }
  return out;
}

// A push's rows: each remote-tracking ref git recorded a push of the HEAD commit of `folder` to (pushedRefs) in its git
// common dir, on the repository its remote pushes to, the configured remote whose name, then `/`, starts the ref's path,
// the longest such: its push URL when one is set, so a push URL that names none records nothing, else its URL.
function pushedRows(folder, folders, now) {
  const remotes = folders.remotes(folder);
  return folders.pushed(folder, now).flatMap((ref) => {
    const name = [...remotes.keys()].filter((each) => ref.startsWith(`${each}/`)).sort((a, b) => b.length - a.length)[0];
    const remote = name === undefined ? {} : remotes.get(name);
    const repo = (Object.hasOwn(remote, 'push') ? remote.push : remote.fetch) ?? null;
    return repo ? [{ kind: 'pushed', repo, number: null, branch: ref.slice(name.length + 1), cwd: folder }] : [];
  });
}

// A touched call's row: a link names its repository; anything else takes the repository `-R` or GH_REPO names, else the
// one repository on a declared host the folder's remotes name, and none when they name several. An owner on a branch
// target puts its head in that owner's repository (the reader's headRepository). No target is the folder's current
// branch, or the change request the reader's checkedOutChange reads from its `branch.<name>.merge`.
function touchedRows(call, folder, folders, hosts, reader) {
  const { target } = call;
  const declared = declaredRepos(folders, folder, hosts);
  const base = target?.repo ?? call.repo ?? (declared.length === 1 ? declared[0] : null);
  if (!base || (target?.owner && !reader.headRepository)) return [];
  if (target !== null) {
    const repo = target.owner ? reader.headRepository(base, target.owner) : base;
    return [{ kind: 'touched', repo, number: target.number ?? null, branch: target.branch ?? null, cwd: folder }];
  }
  const branch = folders.branch(folder);
  if (!branch) return [];
  const number = reader.checkedOutChange?.(folders.config(folder).branches.get(branch)?.merge) ?? null;
  return [{ kind: 'touched', repo: base, number, branch: number === null ? branch : null, cwd: folder }];
}

// A create's rows: each link its output holds whose repository is the one `-R` or GH_REPO names, else one of the
// repositories on a declared host the folder's remotes name.
function createdRows(call, folder, folders, hosts, links) {
  const allowed = call.repo ? [call.repo] : declaredRepos(folders, folder, hosts);
  return links().filter(({ repo }) => allowed.some((each) => sameRepo(each, repo)))
    .map(({ repo, number }) => ({ kind: 'created', repo, number, branch: null, cwd: folder }));
}

// The bounded tail of a call's output, its first line dropped when the cut fell inside it.
export function outputTail(output) {
  if (output.length <= OUTPUT_TAIL) return output;
  const tail = output.slice(-OUTPUT_TAIL);
  return output[output.length - OUTPUT_TAIL - 1] === '\n' ? tail : tail.slice(tail.indexOf('\n') + 1);
}

// Whether readInvocation's invocation is `program`, run plain or by `builtin`, as `builtin cd /x` is.
const runs = ({ program, args = [] }, names) => names.has(program) || (program === 'builtin' && names.has(args[0]?.text));
// Whether a command line, or any line it runs, changes directory anywhere.
const changesDirectory = (lines) => lines.some((line) => lexCommand(line).some((segment) => runs(readInvocation(segment), CHANGES_DIRECTORY)));
// A shell file read into this shell may set any variable.
const SOURCES = new Set(['source', '.']);

// The folder each command of `command` runs in, in walk order, under either reading of a payload's `cwd`, the folder the
// line started in or the one it ended in: the folder an absolute leading `cd`, `git -C`, or `env -C` names; the payload's
// `cwd` only when no command on the line changes directory and nothing else moves this one; else null.
function knownFolders(command, cwd, fromCwd) {
  const named = walkCommands(command, null);
  const moved = changesDirectory([...new Set([command, ...fromCwd.map((entry) => entry.line)])].flatMap(commandLines));
  return named.map((entry, at) => {
    if (entry.folder !== null) return entry.folder;
    return !moved && fromCwd[at]?.folder === cwd ? cwd : null;
  });
}

// Whether the output of the line `command`, its walked `entries`, is the create `entry`'s alone: the line's own commands
// are bare variable assignments and then `entry`, last (a `cd` the walk leaves out), and every other command the walk
// found runs inside a substitution, whose output the shell captures, as a `cat` with no redirection, such as the heredoc
// of a `--body "$(cat <<'EOF' … EOF)"`. Any other command on the line could print a link.
function printsAlone(entries, entry, command) {
  const own = entries.filter(({ line }) => line === command);
  const assigns = ({ invocation }) => !invocation.program && (invocation.args ?? []).length === 0;
  return own.at(-1) === entry && own.slice(0, -1).every(assigns)
    && entries.every((each) => each.line === command || (each.invocation.program === 'cat' && shellRedirections(each.segment).length === 0));
}

// Whether a row's folder is absolute, within CWD_MAX_BYTES, with no hidden character: the ledger's check, and the links' (lib/session-links.mjs).
export const validCwd = (cwd) => typeof cwd === 'string' && path.isAbsolute(cwd) && Buffer.byteLength(cwd) <= CWD_MAX_BYTES && !hasHidden(cwd);

// Whether a walked command moves its folder's HEAD to another branch: `git checkout`, `git switch`, or `git worktree add`.
const HEAD_MOVES = new Set(['checkout', 'switch']);
const movesHead = ({ segment }) => {
  const git = readGit(segment);
  return HEAD_MOVES.has(git?.subcommand) || (git?.subcommand === 'worktree' && git.rest[0]?.text === 'add');
};

// The rows of the walked command `entry`, the line's `index`th, before their checks. A touched call with no target
// records nothing when a command after it on the line moves HEAD (movesHead), since the branch read after the line
// may not be the one it acted on.
function entryRows(entry, index, folder, context) {
  const { folders, forge, reader, env, links, changers } = context;
  if (isPush(entry)) return pushedRows(folder, folders, context.now);
  if (changers.some((other) => other !== entry)) return [];
  const call = reader.readCall(entry.invocation, env);
  if (call?.kind === 'created') return printsAlone(context.entries, entry, context.command) ? createdRows(call, folder, folders, forge.hosts, links) : [];
  if (call?.kind === 'touched') return call.target === null && index < context.lastHeadMove ? [] : touchedRows(call, folder, folders, forge.hosts, reader);
  return [];
}

// The ledger rows of one shell call that succeeded, every field checked, duplicates once, MAX_ROWS at most: `command`
// its text, `cwd` the payload's folder, `output` what it printed as the host's adapter reads it (null when unreadable:
// no created row), `env` the hook's environment, `forge` the adapter forgeFor gives, and `readers` the table of forge
// readers by id, each with `readCall(invocation, env)`, `createdChanges(output)`, and `variables`, the environment
// names its command reads. A line that changes a variable git reads its repository or config from, or reads a shell
// file into the shell (`source`, `.`), which may set any, records nothing.
// `read` runs git, which a test may replace, and `now` is the time a push's record is read against (PUSH_WINDOW_MS).
export function ledgerRows({ command, cwd, output = null, env = {}, forge, readers, agentId = null, at = new Date().toISOString(), now = Date.now(), read = runGit }) {
  const reader = forge && Object.hasOwn(readers ?? {}, forge.id) ? readers[forge.id] : null;
  if (typeof command !== 'string' || typeof cwd !== 'string' || !reader || !Array.isArray(forge.hosts)) return [];
  const entries = walkCommands(command, cwd);
  if (entries.some(({ invocation }) => changesGitTarget(invocation) || runs(invocation, SOURCES))) return [];
  const folders = folderReader(read);
  let links = null;
  // The commands that may change a variable the reader's command reads: one pass, so a long line costs linear time.
  const variables = reader.variables ?? [];
  const changers = entries.filter(({ invocation }) => variables.some((name) => changesVariable(invocation, name)));
  const context = { folders, forge, reader, env, changers, entries, command, now, lastHeadMove: entries.findLastIndex(movesHead), links: () => (links ??= typeof output === 'string' ? reader.createdChanges(outputTail(output)) : []) };
  const known = knownFolders(command, cwd, entries);
  const found = entries.flatMap((entry, index) => (known[index] ? entryRows(entry, index, known[index], context) : []));
  const agent = typeof agentId === 'string' && SESSION_ID.test(agentId) ? agentId : null;
  const rows = found.filter(({ repo, number, branch, cwd: folder }) => forge.changeRef({ host: repo.host, path: repo.path, number, branch }) !== null && validCwd(folder))
    .map(({ kind, repo, number, branch, cwd: folder }) => ({ at, agentId: agent, kind, forge: forge.id, host: repo.host, path: repo.path, number, branch, cwd: folder }));
  return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()].slice(0, MAX_ROWS);
}

// The fields that say what a row records, so a repeat within REPEAT_WINDOW_MS adds none: all but `at` and `agentId`.
const rowKey = ({ kind, forge, host, path: repoPath, number, branch, cwd }) => JSON.stringify([kind, forge, host, repoPath, number, branch, cwd]);
// The change request a row names, as sessionRefs dedupes them: its repository and number, else its repository and branch.
const rowRef = ({ forge, host, path: repoPath, number = null, branch = null }) => JSON.stringify(number === null ? [forge, host, repoPath, null, branch] : [forge, host, repoPath, number, null]);
const parsedLine = (line) => {
  try {
    const row = JSON.parse(line);
    return { key: rowKey(row), ref: rowRef(row), at: typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN };
  } catch {
    return null;
  }
};
// How long a row the ledger holds keeps the same call from writing it again, as a hook run on every shell call may.
// Past it, a repeat is written with its new time, so the change request it names shows as acted on last.
export const REPEAT_WINDOW_MS = 60_000;

// The key of each change request's newest row (rowRef) among the ledger's rows written within REPEAT_WINDOW_MS of `at`,
// read from its newest line back to the first older than that, since rows are appended in time order.
function newestKeys(lines, at) {
  const keys = new Map();
  if (!Number.isFinite(at)) return keys;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = parsedLine(lines[index]);
    if (line === null || !Number.isFinite(line.at)) continue;
    if (at - line.at >= REPEAT_WINDOW_MS) break;
    if (Math.abs(at - line.at) < REPEAT_WINDOW_MS && !keys.has(line.ref)) keys.set(line.ref, line.key);
  }
  return keys;
}
const isFolder = (folder) => {
  try {
    return lstatSync(folder).isDirectory();
  } catch {
    return false;
  }
};

// Writes `rows`, MAX_ROWS at most, to the ledger in `folder`, which sessionFolder gave, as lib/session-folder.mjs reads
// and writes it: a row whose cwd is no folder on disk, or whose fields the newest row of its change request holds when
// that row was written within REPEAT_WINDOW_MS of its `at`, is left out; any other repeat is written with its new time,
// so its ref is shown first again, ranked by its newest kind, and stays shown while newer ones come. The rest are
// appended; when the ledger is already past LEDGER_MAX_BYTES, as an older writer could leave it, or the append would
// pass it, the ledger is rewritten through a temporary file and a rename with the newest rows of that tail that fit in
// half of it, then these, so the newest always show. Nothing is written when the ledger cannot be read as the session
// folder's rules allow. Returns whether it wrote. Never throws. The append and the compaction are lib/session-rows.mjs
// appendRows', which runs each write as one step no other writer of the ledger runs beside, so two hooks of one session
// writing together lose no row; this one decides the repeats from the lines it read.
export function appendLedger(folder, rows, options = {}) {
  if (!Array.isArray(rows)) return false;
  const select = (lines, taken) => {
    const newest = newestKeys(lines, typeof taken[0]?.at === 'string' ? Date.parse(taken[0].at) : Number.NaN);
    return taken.filter((row) => {
      const key = rowKey(row);
      if (newest.get(rowRef(row)) === key || !isFolder(row.cwd)) return false;
      newest.set(rowRef(row), key);
      return true;
    });
  };
  return appendRows(folder, LEDGER, rows.slice(0, MAX_ROWS), { ...options, maxBytes: LEDGER_MAX_BYTES, select });
}

const KINDS = new Set(['created', 'pushed', 'touched']);
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const PATH_MAX_BYTES = 1024;

// The ledger's rows in `folder`, oldest first, read no-follow from its last LEDGER_MAX_BYTES: a first line the cut fell
// inside and a last line still being written are dropped, and so is a line that is no row object. Null when the ledger
// cannot be read as the session folder's rules allow, such as a named pipe or a symlink there.
export const readLedger = (folder, options = {}) => readRows(folder, LEDGER, { ...options, maxBytes: LEDGER_MAX_BYTES });

const isNumber = (number) => number === null || (Number.isSafeInteger(number) && number > 0);
const isBranch = (branch) => branch === null || (isRefName(branch) && !hasHidden(branch));
const isRepoPath = (repoPath) => typeof repoPath === 'string' && repoPath !== '' && Buffer.byteLength(repoPath) <= PATH_MAX_BYTES && !hasHidden(repoPath);
// Whether `host` and `path` name a repository as the snapshot's own checks take one: a host name and a path.
export const isRepository = (host, repoPath) => typeof host === 'string' && HOST_NAME.test(host) && isRepoPath(repoPath);
// Whether a row on a host no adapter declares passes the snapshot's own field checks before it is shown: a host name, a
// path, cwd absolute, a number a positive integer or none, a branch the ref-name check or none, and one of the two.
const isUnsupportedRow = ({ host, path: repoPath, number = null, branch = null, cwd }) => typeof host === 'string' && HOST_NAME.test(host)
  && isRepoPath(repoPath) && validCwd(cwd) && isNumber(number) && isBranch(branch) && (number !== null || branch !== null);
// Whether `row` has the shape of a ledger row, as lib/session-links.mjs checks each row of a ledger before the ticket or
// any other reader takes it: a known kind, a time that parses, and the fields isUnsupportedRow checks.
export const isLedgerRow = (row) => row !== null && typeof row === 'object' && KINDS.has(row.kind) && typeof row.at === 'string'
  && Number.isFinite(Date.parse(row.at)) && isUnsupportedRow(row);

// The refs the snapshot shows from the ledger's `rows`: each row of a known kind with a time, on a host the adapter
// `forge` declares and whose fields pass its changeRef and the cwd check, or on another host and passing
// isUnsupportedRow; deduped by repository and number, else by repository and branch, touched rows as well as pushed;
// ordered by each ref's latest row, newest first, since one ref has rows of several kinds and folders; MAX_REFS at most.
// A branch's `rank` comes from the ref's newest row: 'open' for a touched row, whose `gh pr` call looked the branch up
// in the forge's own order, an open change request first, then the newest; 'own' for a created or pushed row, the
// forge user's own first (changesState). A number's is null.
// { refs, unsupported }: the refs `forge` reads, each `{ host, path, number, branch, rank }`, and the rest as rows of the
// change request's shape with `unsupported: true`, no forge, and null for all the forge would answer: they start no call.
// `ancestors`, an iterable of row groups, nearest first, as lib/session-links.mjs reads them, adds the refs of each group
// that no nearer one holds, newest first, each `inherited: true`, while there are fewer than MAX_REFS: no further group
// is read once there are. The session's own refs come first and fill the places first.
const RANKS = Object.freeze({ created: 'own', pushed: 'own', touched: 'open' });
export function sessionRefs(rows, forge, ancestors = []) {
  const held = new Map();
  const take = (group, inherited) => {
    for (const ref of groupRefs(group, forge)) if (held.size < MAX_REFS && !held.has(ref.key)) held.set(ref.key, { ...ref, inherited });
  };
  take(rows, false);
  const groups = ancestors[Symbol.iterator]();
  while (held.size < MAX_REFS) {
    const next = groups.next();
    if (next.done) break;
    take(next.value, true);
  }
  const chosen = [...held.values()];
  const mark = (ref, inherited) => (inherited ? { ...ref, inherited: true } : ref);
  return {
    refs: chosen.filter((ref) => ref.declared).map(({ host, path: repoPath, number, branch, rank, inherited }) => mark({ host, path: repoPath, number, branch, rank }, inherited)),
    unsupported: chosen.filter((ref) => !ref.declared).map(({ host, path: repo, number, inherited }) => mark({ host, repo, number, ...UNKNOWN, unsupported: true }, inherited)),
  };
}

// The refs of one group of rows, as sessionRefs reads them, newest first, MAX_REFS at most, each with its `key`.
function groupRefs(rows, forge) {
  const found = new Map();
  rows.forEach((row, index) => {
    const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
    if (!KINDS.has(row.kind) || !Number.isFinite(at)) return;
    const { host, path: repoPath, number = null, branch = null } = row;
    const declared = forge.hosts.includes(host);
    if (declared ? forge.changeRef({ host, path: repoPath, number, branch }) === null || !validCwd(row.cwd) : !isUnsupportedRow(row)) return;
    const key = JSON.stringify(number === null ? [host, repoPath, null, branch] : [host, repoPath, number, null]);
    const rank = number === null ? RANKS[row.kind] : null;
    const ref = found.get(key) ?? { key, host, path: repoPath, number, branch: number === null ? branch : null, rank, declared, at, index };
    found.set(key, { ...ref, at: Math.max(ref.at, at), index, rank: at >= ref.at ? rank : ref.rank });
  });
  return [...found.values()].sort((a, b) => b.at - a.at || b.index - a.index).slice(0, MAX_REFS);
}

// What a row on a host no adapter declares cannot know.
const UNKNOWN = Object.freeze({ title: null, url: null, isDraft: null, state: null, mergeable: null, reviewDecision: null, unresolvedThreads: null, checks: null });

// A ref's key in the change requests' cache: every field the forge's answer for it depends on.
const refKey = ({ host, path: repoPath, number, branch, rank = null }) => JSON.stringify([host, repoPath, number, branch, rank]);
const REF_KEY_MAX_BYTES = 4096;

// The answer the cache keeps for `refs`, through the adapter's one batched read (changesState): `{ refs, rows }`, each
// ref's key and the change request it resolved to, or null. Throws what the read throws.
export function resolveSelection(forge, refs) {
  const rows = forge.changesState(refs.map(({ inherited, ...ref }) => ref));
  if (!Array.isArray(rows)) throw new Error('no rows');
  return { refs: refs.map(refKey), rows: refs.map((_, index) => (isChangeRow(rows[index]) ? rows[index] : null)) };
}

// `rows` less the nulls, and one entry for rows of the same change request, by the repository and number the forge
// answered: the first, the newest ref's.
function distinctRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (row === null) return false;
    const key = JSON.stringify([row.host, row.repo, row.number]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The change requests `refs` resolve to, one entry each (distinctRows), each with the `inherited` of the ref it
// answers, so a ref of the session's own, which comes first, wins over an inherited one. Throws what the read throws.
export const resolveChanges = (forge, refs) => distinctRows(withInherited(resolveSelection(forge, refs).rows, refs));
const withInherited = (rows, refs) => rows.map((row, index) => row && { ...row, inherited: refs[index].inherited === true });

// What the snapshot shows of the session's change requests, MAX_REFS at most: the cached answer `cache`, as
// resolveSelection gave it, for the refs `refs` still selects alone, newest first and one entry a change request, then
// the `unsupported` rows. A row is `stale: true` when `stale` says the cache is past its window, or when a selected
// ref has no answer in it, since the ledger moved on since the forge was read; the cache's own window refreshes it.
// When no selected ref has an answer in it, it throws, so the section shows as unavailable rather than as no change
// requests. Each row's `url` is the one the adapter `forge` takes for it (changeUrl), else null, so a cache never
// names a link. Every row holds `inherited`, the boolean of its ref, never the cache's: an inherited row shows only
// while its state is `open`, and an unsupported one, whose state nothing knows, shows.
export function shownChanges({ forge, refs, unsupported, cache, stale }) {
  const answers = new Map(cache.refs.map((key, index) => [key, cache.rows[index]]));
  const keys = refs.map(refKey);
  if (keys.length > 0 && !keys.some((key) => answers.has(key))) throw new Error('no answer for the selected refs');
  const behind = stale || keys.some((key) => !answers.has(key));
  const rows = distinctRows(withInherited(keys.map((key) => answers.get(key) ?? null), refs)).filter((row) => !row.inherited || row.state === 'open')
    .map((row) => ({ ...row, url: typeof forge?.changeUrl === 'function' ? forge.changeUrl(row) : null }));
  const others = unsupported.map((row) => ({ ...row, inherited: row.inherited === true }));
  return [...rows.map((row) => (behind ? { ...row, stale: true } : row)), ...others].slice(0, MAX_REFS);
}

const STATES = new Set(['open', 'closed', 'merged']);
const DECISIONS = new Set(['approved', 'changes_requested', 'review_required']);
const CHECKS = ['passed', 'failed', 'pending', 'skipped'];
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isText = (value) => typeof value === 'string' && value.length <= PATH_MAX_BYTES;

// Whether `row` has the forge-neutral shape of a change request (docs/providers/adding-a-host.md#adding-a-forge), as a
// row the forge answers, or a cached one, must before it is shown.
export const isChangeRow = (row) => row !== null && typeof row === 'object' && isText(row.forge) && isText(row.host) && isText(row.repo)
  && Number.isSafeInteger(row.number) && row.number > 0 && isText(row.title) && (row.url === null || isText(row.url))
  && typeof row.isDraft === 'boolean' && STATES.has(row.state) && [true, false, null].includes(row.mergeable)
  && (row.reviewDecision === null || DECISIONS.has(row.reviewDecision)) && isCount(row.unresolvedThreads)
  && row.checks !== null && typeof row.checks === 'object' && CHECKS.every((name) => isCount(row.checks[name]));
// Whether `value` is the shape resolveSelection gives, as a cached one must be before it is read.
export const isChangeCache = (value) => value !== null && typeof value === 'object' && Array.isArray(value.refs) && Array.isArray(value.rows)
  && value.refs.length === value.rows.length && value.refs.length <= MAX_REFS
  && value.refs.every((key) => typeof key === 'string' && key.length <= REF_KEY_MAX_BYTES) && value.rows.every((row) => row === null || isChangeRow(row));

// The pull request summary of a status line: how many, then how many have a failed check, a pending one and none failed,
// or only passed or skipped ones. One with no check counts in none.
export function changesSummary(prs) {
  const states = prs.map(({ checks }) => {
    if (!checks) return null;
    if (checks.failed > 0) return 'failed';
    if (checks.pending > 0) return 'pending';
    return checks.passed + checks.skipped > 0 ? 'passed' : null;
  });
  const count = (state) => states.filter((each) => each === state).length;
  return `${prs.length} PR${prs.length === 1 ? '' : 's'} · ✓${count('passed')} ✗${count('failed')} ⏳${count('pending')}`;
}
