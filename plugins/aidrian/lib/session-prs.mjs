// The session's pull request ledger, `<state>/sessions/<session id>/prs.jsonl` (docs/hooks.md#session-ledger): one row a
// change request a session's shell call creates, pushes a branch of, or acts on. Display data only: no hook, gate, skill,
// or agent decides anything from it. scripts/hook-bash-post.mjs writes it after each shell call that succeeded.
//
// This file names no forge. A forge's reader of its own command comes in the `readers` table, keyed by its adapter's
// id; the adapter, from forgeFor, gives that id, its `hosts`, and `changeRef`, the one shape check of a ref. What is
// read here is git's, which is no forge: a push (lib/git-push.mjs), and the remotes and the branch of the folder a call
// ran in. A row is `{ at, agentId, kind, forge, host, path, number, branch, cwd }`, with no raw URL, command text, or
// output, and every field checked first, so no row exceeds a fixed size. `aidrian session snapshot` reads it back:
// readLedger, then sessionRefs, then resolveSelection through the adapter's one batched read, cached, and shownChanges.
// It holds both the writer and the reader of the one ledger, so the hook's forge-seam test reads a single file.

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { repoIdentity } from './forges/index.mjs';
import { isRefName, runGit } from './git.mjs';
import { changesGitTarget, CURRENT, readPush } from './git-push.mjs';
import { SESSION_ID } from './handoff-markers.mjs';
import { hasHidden } from './hidden-text.mjs';
import { appendSessionFile, readSessionTail, writeSessionFile } from './session-folder.mjs';
import { changesVariable, commandLines, lexCommand, readInvocation, shellRedirections, walkCommands } from './shell-lex.mjs';

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
// A remote word git reads as a URL rather than a remote's name: a scheme, or git's `host:path` form.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/|^[^/]*:/iu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

// What git says of a folder, read once each and for MAX_FOLDERS folders at most, from one `git config` read: its remotes
// by name, each `{ fetch, push }` as repoIdentity reads the first `remote.<name>.url` and the first `remote.<name>.pushurl`,
// null for one it cannot read and absent for none, and `refspecs: true` when `remote.<name>.push` is set; `pushDefault`
// and `pushMode`, git's `remote.pushDefault` and `push.default`; each branch's `pushRemote`, `remote`, and `merge`; and
// the current branch. A key git keeps one value of takes its last, as git does. No value of the ledger reaches git's argv.
// SHORTCUT: a `url.<base>.insteadOf` or `pushInsteadOf` rewrite in the folder's config is not applied, so a rewritten
// remote records the URL as written. Enough for display data; applying git's rewrite rules here would replace it.
const CONFIG_KEYS = '^(remote\\..*\\.(url|pushurl|push)|remote\\.pushdefault|push\\.default|branch\\..*\\.(pushremote|remote|merge))$';
const BRANCH_KEYS = { pushremote: 'pushRemote', remote: 'remote', merge: 'merge' };
function readConfig(stdout) {
  const config = { remotes: new Map(), branches: new Map(), pushDefault: null, pushMode: null };
  for (const line of stdout.split('\n')) {
    const remote = /^remote\.([^ ]+)\.(url|pushurl|push)(?: (.*))?$/u.exec(line);
    const branch = /^branch\.([^ ]+)\.(pushremote|remote|merge) (.*)$/u.exec(line);
    const single = /^(remote\.pushdefault|push\.default) (.*)$/u.exec(line);
    if (remote?.[2] === 'push') config.remotes.set(remote[1], { ...config.remotes.get(remote[1]), refspecs: true });
    else if (remote && remote[3] !== undefined) {
      const each = config.remotes.get(remote[1]) ?? {};
      const key = remote[2] === 'url' ? 'fetch' : 'push';
      if (!Object.hasOwn(each, key)) each[key] = repoIdentity(remote[3]);
      config.remotes.set(remote[1], each);
    } else if (branch) config.branches.set(branch[1], { ...config.branches.get(branch[1]), [BRANCH_KEYS[branch[2]]]: branch[3] });
    else if (single) config[single[1] === 'push.default' ? 'pushMode' : 'pushDefault'] = single[2];
  }
  return config;
}
const NO_CONFIG = Object.freeze({ remotes: new Map(), branches: new Map(), pushDefault: null, pushMode: null });
function folderReader(read) {
  const configs = new Map();
  const branches = new Map();
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
  return { config: configOf, remotes: (folder) => configOf(folder).remotes, branch: branchOf };
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

// The branch a push with no refspec to the remote `name` updates, as git's push.default reads it: the current branch
// for `simple` (git's default) or `current`, the branch `branch.<current>.merge` names for `upstream` when `name` is that
// branch's remote, and none for `matching`, `nothing`, any other, or a remote whose `remote.<name>.push` is set.
function defaultBranch(name, config, current) {
  if (current === null || config.remotes.get(name)?.refspecs) return null;
  const mode = config.pushMode ?? 'simple';
  if (mode === 'simple' || mode === 'current') return current;
  const { remote = null, merge = null } = config.branches.get(current) ?? {};
  if ((mode === 'upstream' || mode === 'tracking') && remote === name && merge?.startsWith('refs/heads/')) return merge.slice('refs/heads/'.length) || null;
  return null;
}

// A push's rows: the repository of the remote it names, read through its push URL alone when it has one, and none when
// that URL names no repository, else its URL; a URL as written; or, when it names none, the remote git pushes to:
// `branch.<current>.pushRemote`, then `remote.pushDefault`, then `branch.<current>.remote`, then origin.
function pushedRows(push, folder, folders) {
  const config = folders.config(folder);
  const current = folders.branch(folder);
  const tracking = (current === null ? null : config.branches.get(current)) ?? {};
  const name = push.remote ?? tracking.pushRemote ?? config.pushDefault ?? tracking.remote ?? 'origin';
  let repo = null;
  if (config.remotes.has(name)) {
    const remote = config.remotes.get(name);
    repo = (Object.hasOwn(remote, 'push') ? remote.push : remote.fetch) ?? null;
  }
  else if (URL_LIKE.test(name)) repo = repoIdentity(name);
  if (!repo) return [];
  const branches = push.refs.length === 0 ? [defaultBranch(name, config, current)] : push.refs.map((ref) => (ref === CURRENT ? current : ref));
  return branches.filter(Boolean).map((branch) => ({ kind: 'pushed', repo, number: null, branch, cwd: folder }));
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

const validCwd = (cwd) => typeof cwd === 'string' && path.isAbsolute(cwd) && Buffer.byteLength(cwd) <= CWD_MAX_BYTES && !hasHidden(cwd);

// The rows of one walked command, before their checks.
function entryRows(entry, folder, context) {
  const { folders, forge, reader, env, links, changers } = context;
  const push = readPush(entry);
  if (push) return pushedRows(push, folder, folders);
  if (changers.some((other) => other !== entry)) return [];
  const call = reader.readCall(entry.invocation, env);
  if (call?.kind === 'created') return printsAlone(context.entries, entry, context.command) ? createdRows(call, folder, folders, forge.hosts, links) : [];
  if (call?.kind === 'touched') return touchedRows(call, folder, folders, forge.hosts, reader);
  return [];
}

// The ledger rows of one shell call that succeeded, every field checked, duplicates once, MAX_ROWS at most: `command`
// its text, `cwd` the payload's folder, `output` what it printed as the host's adapter reads it (null when unreadable:
// no created row), `env` the hook's environment, `forge` the adapter forgeFor gives, and `readers` the table of forge
// readers by id, each with `readCall(invocation, env)`, `createdChanges(output)`, and `variables`, the environment
// names its command reads. A line that changes a variable git reads its repository or config from, or reads a shell
// file into the shell (`source`, `.`), which may set any, records nothing.
// `read` runs git, which a test may replace.
export function ledgerRows({ command, cwd, output = null, env = {}, forge, readers, agentId = null, at = new Date().toISOString(), read = runGit }) {
  const reader = forge && Object.hasOwn(readers ?? {}, forge.id) ? readers[forge.id] : null;
  if (typeof command !== 'string' || typeof cwd !== 'string' || !reader || !Array.isArray(forge.hosts)) return [];
  const entries = walkCommands(command, cwd);
  if (entries.some(({ invocation }) => changesGitTarget(invocation) || runs(invocation, SOURCES))) return [];
  const folders = folderReader(read);
  let links = null;
  // The commands that may change a variable the reader's command reads: one pass, so a long line costs linear time.
  const variables = reader.variables ?? [];
  const changers = entries.filter(({ invocation }) => variables.some((name) => changesVariable(invocation, name)));
  const context = { folders, forge, reader, env, changers, entries, command, links: () => (links ??= typeof output === 'string' ? reader.createdChanges(outputTail(output)) : []) };
  const known = knownFolders(command, cwd, entries);
  const found = entries.flatMap((entry, index) => (known[index] ? entryRows(entry, known[index], context) : []));
  const agent = typeof agentId === 'string' && SESSION_ID.test(agentId) ? agentId : null;
  const rows = found.filter(({ repo, number, branch, cwd: folder }) => forge.changeRef({ host: repo.host, path: repo.path, number, branch }) !== null && validCwd(folder))
    .map(({ kind, repo, number, branch, cwd: folder }) => ({ at, agentId: agent, kind, forge: forge.id, host: repo.host, path: repo.path, number, branch, cwd: folder }));
  return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()].slice(0, MAX_ROWS);
}

// The fields that say what a row records, so a repeat within REPEAT_WINDOW_MS adds none: all but `at` and `agentId`.
const rowKey = ({ kind, forge, host, path: repoPath, number, branch, cwd }) => JSON.stringify([kind, forge, host, repoPath, number, branch, cwd]);
const parsedLine = (line) => {
  try {
    const row = JSON.parse(line);
    return { key: rowKey(row), at: typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN };
  } catch {
    return null;
  }
};
const keyOfLine = (line) => parsedLine(line)?.key ?? null;
// How long a row the ledger holds keeps the same call from writing it again, as a hook run on every shell call may.
// Past it, a repeat is written with its new time, so the change request it names shows as acted on last.
export const REPEAT_WINDOW_MS = 60_000;

// The keys of the ledger's rows written within REPEAT_WINDOW_MS of `at`, read from its newest line back to the first
// older than that, since rows are appended in time order.
function recentKeys(lines, at) {
  const keys = new Set();
  if (!Number.isFinite(at)) return keys;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = parsedLine(lines[index]);
    if (line === null || !Number.isFinite(line.at)) continue;
    if (at - line.at >= REPEAT_WINDOW_MS) break;
    if (Math.abs(at - line.at) < REPEAT_WINDOW_MS) keys.add(line.key);
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

// The ledger's lines kept when a write would pass LEDGER_MAX_BYTES: the newest rows that fit in half of it.
function newestLines(lines) {
  const kept = [];
  let bytes = 0;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const size = Buffer.byteLength(lines[at]) + 1;
    if (keyOfLine(lines[at]) === null) continue;
    if (bytes + size > LEDGER_MAX_BYTES / 2) break;
    kept.unshift(lines[at]);
    bytes += size;
  }
  return kept;
}

// Writes `rows`, MAX_ROWS at most, to the ledger in `folder`, which sessionFolder gave, as lib/session-folder.mjs reads
// and writes it: a row whose cwd is no folder on disk, or whose fields a row written within REPEAT_WINDOW_MS of its `at`
// holds, is left out; any other repeat is written with its new time, so its ref is shown first again and stays shown
// while newer ones come. The rest are appended; when the ledger is already past LEDGER_MAX_BYTES, as two appends
// racing can leave it, or the append would pass it, the ledger is rewritten through a temporary file and a rename with
// the newest rows of that tail that fit in half of it, then these, so the newest always show. Nothing is written when
// the ledger cannot be read as the session folder's rules allow. Returns whether it wrote. Never throws.
export function appendLedger(folder, rows, options = {}) {
  if (typeof folder !== 'string' || !Array.isArray(rows) || rows.length === 0) return false;
  const read = readSessionTail(folder, LEDGER, { ...options, maxBytes: LEDGER_MAX_BYTES });
  if (read === null) return false;
  // As readLedger reads it: a first line the cut fell inside and a last line still being written are no rows.
  const lines = read.text.split('\n');
  lines.pop();
  if (read.cut) lines.shift();
  const taken = rows.slice(0, MAX_ROWS);
  const seen = recentKeys(lines, typeof taken[0]?.at === 'string' ? Date.parse(taken[0].at) : Number.NaN);
  const fresh = [];
  for (const row of taken) {
    const key = rowKey(row);
    if (seen.has(key) || !isFolder(row.cwd)) continue;
    seen.add(key);
    fresh.push(`${JSON.stringify(row)}\n`);
  }
  if (fresh.length === 0) return false;
  const text = fresh.join('');
  if (!read.cut && Buffer.byteLength(read.text) + Buffer.byteLength(text) <= LEDGER_MAX_BYTES) return appendSessionFile(folder, LEDGER, text, { ...options, maxBytes: LEDGER_MAX_BYTES });
  // SHORTCUT: two hooks of one session writing together can lose a row in a compaction or add a duplicate. Enough for
  // display data: the next touch records it again and the snapshot dedupes. Compacting under reserveSessionFile closes it.
  const compacted = newestLines(lines).map((line) => `${line}\n`).join('') + text;
  return writeSessionFile(folder, LEDGER, compacted, options) !== null;
}

const KINDS = new Set(['created', 'pushed', 'touched']);
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const PATH_MAX_BYTES = 1024;

// The ledger's rows in `folder`, oldest first, read no-follow from its last LEDGER_MAX_BYTES: a first line the cut fell
// inside and a last line still being written are dropped, and so is a line that is no row object. Null when the ledger
// cannot be read as the session folder's rules allow, such as a named pipe or a symlink there.
export function readLedger(folder, options = {}) {
  const read = readSessionTail(folder, LEDGER, { ...options, maxBytes: LEDGER_MAX_BYTES });
  if (read === null) return null;
  const lines = read.text.split('\n');
  lines.pop();
  if (read.cut) lines.shift();
  return lines.flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row !== null && typeof row === 'object' && !Array.isArray(row) ? [row] : [];
    } catch {
      return [];
    }
  });
}

const isNumber = (number) => number === null || (Number.isSafeInteger(number) && number > 0);
const isBranch = (branch) => branch === null || (isRefName(branch) && !hasHidden(branch));
const isRepoPath = (repoPath) => typeof repoPath === 'string' && repoPath !== '' && Buffer.byteLength(repoPath) <= PATH_MAX_BYTES && !hasHidden(repoPath);
// Whether a row on a host no adapter declares passes the snapshot's own field checks before it is shown: a host name, a
// path, cwd absolute, a number a positive integer or none, a branch the ref-name check or none, and one of the two.
const isUnsupportedRow = ({ host, path: repoPath, number = null, branch = null, cwd }) => typeof host === 'string' && HOST_NAME.test(host)
  && isRepoPath(repoPath) && validCwd(cwd) && isNumber(number) && isBranch(branch) && (number !== null || branch !== null);

// The refs the snapshot shows from the ledger's `rows`: each row of a known kind with a time, on a host the adapter
// `forge` declares and whose fields pass its changeRef and the cwd check, or on another host and passing
// isUnsupportedRow; deduped by repository and number, else by repository and branch, touched rows as well as pushed;
// ordered by each ref's latest row, newest first, since one ref has rows of several kinds and folders; MAX_REFS at most.
// A branch's `rank` comes from the ref's newest row: 'open' for a touched row, whose `gh pr` call looked the branch up
// in the forge's own order, an open change request first, then the newest; 'own' for a created or pushed row, the
// forge user's own first (changesState). A number's is null.
// { refs, unsupported }: the refs `forge` reads, each `{ host, path, number, branch, rank }`, and the rest as rows of the
// change request's shape with `unsupported: true`, no forge, and null for all the forge would answer: they start no call.
const RANKS = Object.freeze({ created: 'own', pushed: 'own', touched: 'open' });
export function sessionRefs(rows, forge) {
  const found = new Map();
  rows.forEach((row, index) => {
    const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
    if (!KINDS.has(row.kind) || !Number.isFinite(at)) return;
    const { host, path: repoPath, number = null, branch = null } = row;
    const declared = forge.hosts.includes(host);
    if (declared ? forge.changeRef({ host, path: repoPath, number, branch }) === null || !validCwd(row.cwd) : !isUnsupportedRow(row)) return;
    const key = JSON.stringify(number === null ? [host, repoPath, null, branch] : [host, repoPath, number, null]);
    const rank = number === null ? RANKS[row.kind] : null;
    const ref = found.get(key) ?? { host, path: repoPath, number, branch: number === null ? branch : null, rank, declared, at, index };
    found.set(key, { ...ref, at: Math.max(ref.at, at), index, rank: at >= ref.at ? rank : ref.rank });
  });
  const newest = [...found.values()].sort((a, b) => b.at - a.at || b.index - a.index).slice(0, MAX_REFS);
  return {
    refs: newest.filter((ref) => ref.declared).map(({ host, path: repoPath, number, branch, rank }) => ({ host, path: repoPath, number, branch, rank })),
    unsupported: newest.filter((ref) => !ref.declared).map(({ host, path: repo, number }) => ({ host, repo, number, ...UNKNOWN, unsupported: true })),
  };
}

// What a row on a host no adapter declares cannot know.
const UNKNOWN = Object.freeze({ title: null, url: null, isDraft: null, state: null, mergeable: null, reviewDecision: null, unresolvedThreads: null, checks: null });

// A ref's key in the change requests' cache: every field the forge's answer for it depends on.
const refKey = ({ host, path: repoPath, number, branch, rank = null }) => JSON.stringify([host, repoPath, number, branch, rank]);
const REF_KEY_MAX_BYTES = 4096;

// The answer the cache keeps for `refs`, through the adapter's one batched read (changesState): `{ refs, rows }`, each
// ref's key and the change request it resolved to, or null. Throws what the read throws.
export function resolveSelection(forge, refs) {
  const rows = forge.changesState(refs);
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

// The change requests `refs` resolve to, one entry each (distinctRows). Throws what the read throws.
export const resolveChanges = (forge, refs) => distinctRows(resolveSelection(forge, refs).rows);

// What the snapshot shows of the session's change requests, MAX_REFS at most: the cached answer `cache`, as
// resolveSelection gave it, for the refs `refs` still selects alone, newest first and one entry a change request, then
// the `unsupported` rows. A row is `stale: true` when `stale` says the cache is past its window, or when a selected
// ref has no answer in it, since the ledger moved on since the forge was read; the cache's own window refreshes it.
export function shownChanges({ refs, unsupported, cache, stale }) {
  const answers = new Map(cache.refs.map((key, index) => [key, cache.rows[index]]));
  const keys = refs.map(refKey);
  const behind = stale || keys.some((key) => !answers.has(key));
  const rows = distinctRows(keys.map((key) => answers.get(key) ?? null));
  return [...rows.map((row) => (behind ? { ...row, stale: true } : row)), ...unsupported].slice(0, MAX_REFS);
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
