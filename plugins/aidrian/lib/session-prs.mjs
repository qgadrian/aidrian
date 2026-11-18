// The session's pull request ledger, `<state>/sessions/<session id>/prs.jsonl` (docs/hooks.md#session-ledger): one row a
// change request a session's shell call creates, pushes a branch of, or acts on. Display data only: no hook, gate, skill,
// or agent decides anything from it. scripts/hook-bash-post.mjs writes it after each shell call that succeeded.
//
// This file names no forge. A forge's reader of its own command comes in the `readers` table, keyed by its adapter's
// id; the adapter, from forgeFor, gives that id, its `hosts`, and `changeRef`, the one shape check of a ref. What is
// read here is git's, which is no forge: a push (lib/git-push.mjs), and the remotes and the branch of the folder a call
// ran in. A row is `{ at, agentId, kind, forge, host, path, number, branch, cwd }`, with no raw URL, command text, or
// output, and every field checked first, so no row exceeds a fixed size. `aidrian session snapshot` reads it back:
// readLedger, then sessionRefs, then resolveChanges through the adapter's one batched read.

import { lstatSync } from 'node:fs';
import path from 'node:path';

import { repoIdentity } from './forges/index.mjs';
import { isRefName, runGit } from './git.mjs';
import { changesGitTarget, CURRENT, readPush } from './git-push.mjs';
import { SESSION_ID } from './handoff-markers.mjs';
import { hasHidden } from './hidden-text.mjs';
import { appendSessionFile, readSessionTail, writeSessionFile } from './session-folder.mjs';
import { changesVariable, commandLines, lexCommand, readInvocation, walkCommands } from './shell-lex.mjs';

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
const CWD_MAX_BYTES = 1024;
// A remote word git reads as a URL rather than a remote's name: a scheme, or git's `host:path` form.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/|^[^/]*:/iu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

// What git says of a folder, read once each and for MAX_FOLDERS folders at most: its remotes by name, each
// `{ fetch, push }` as repoIdentity reads the first `remote.<name>.url` and the first `remote.<name>.pushurl`, null for
// one it cannot read and absent for none, and its current branch.
// SHORTCUT: a `url.<base>.insteadOf` or `pushInsteadOf` rewrite in the folder's config is not applied, so a rewritten
// remote records the URL as written. Enough for display data; applying git's rewrite rules here would replace it.
function folderReader(read) {
  const remotes = new Map();
  const branches = new Map();
  const readable = (folder) => remotes.has(folder) || remotes.size < MAX_FOLDERS;
  const remotesOf = (folder) => {
    if (!readable(folder)) return new Map();
    if (!remotes.has(folder)) {
      const { status, stdout } = read(['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], folder);
      const named = new Map();
      for (const line of status === 0 ? stdout.split('\n') : []) {
        const match = /^remote\.(.+)\.(url|pushurl) (.*)$/u.exec(line);
        if (!match) continue;
        const each = named.get(match[1]) ?? {};
        const key = match[2] === 'url' ? 'fetch' : 'push';
        if (!Object.hasOwn(each, key)) each[key] = repoIdentity(match[3]);
        named.set(match[1], each);
      }
      remotes.set(folder, named);
    }
    return remotes.get(folder);
  };
  const branchOf = (folder) => {
    if (!readable(folder)) return null;
    remotesOf(folder);
    if (!branches.has(folder)) {
      const { status, stdout } = read(['symbolic-ref', '--short', '-q', 'HEAD'], folder);
      branches.set(folder, status === 0 ? stdout.trim() || null : null);
    }
    return branches.get(folder);
  };
  return { remotes: remotesOf, branch: branchOf };
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

// A push's rows: the repository of the remote it names, read through its push URL alone when it has one, and none when
// that URL names no repository, else its URL; a URL as written; or origin when it names none.
function pushedRows(push, folder, folders) {
  const remotes = folders.remotes(folder);
  const name = push.remote ?? 'origin';
  let repo = null;
  if (remotes.has(name)) {
    const remote = remotes.get(name);
    repo = (Object.hasOwn(remote, 'push') ? remote.push : remote.fetch) ?? null;
  }
  else if (URL_LIKE.test(name)) repo = repoIdentity(name);
  if (!repo) return [];
  const branches = push.refs.length === 0 ? [CURRENT] : push.refs;
  return branches.map((ref) => (ref === CURRENT ? folders.branch(folder) : ref)).filter(Boolean)
    .map((branch) => ({ kind: 'pushed', repo, number: null, branch, cwd: folder }));
}

// A touched call's row: a link names its repository; anything else takes the repository `-R` or GH_REPO names, else the
// one repository on a declared host the folder's remotes name, and none when they name several.
function touchedRows(call, folder, folders, hosts) {
  const { target } = call;
  const declared = declaredRepos(folders, folder, hosts);
  const repo = target?.repo ?? call.repo ?? (declared.length === 1 ? declared[0] : null);
  const branch = target === null ? folders.branch(folder) : target.branch ?? null;
  if (!repo || (target === null && !branch)) return [];
  return [{ kind: 'touched', repo, number: target?.number ?? null, branch, cwd: folder }];
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

const validCwd = (cwd) => typeof cwd === 'string' && path.isAbsolute(cwd) && Buffer.byteLength(cwd) <= CWD_MAX_BYTES && !hasHidden(cwd);

// The rows of one walked command, before their checks.
function entryRows(entry, folder, context) {
  const { folders, forge, reader, env, links, changers } = context;
  const push = readPush(entry);
  if (push) return pushedRows(push, folder, folders);
  if (changers.some((other) => other !== entry)) return [];
  const call = reader.readCall(entry.invocation, env);
  if (call?.kind === 'created') return createdRows(call, folder, folders, forge.hosts, links);
  if (call?.kind === 'touched') return touchedRows(call, folder, folders, forge.hosts);
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
  const context = { folders, forge, reader, env, changers, links: () => (links ??= typeof output === 'string' ? reader.createdChanges(outputTail(output)) : []) };
  const known = knownFolders(command, cwd, entries);
  const found = entries.flatMap((entry, index) => (known[index] ? entryRows(entry, known[index], context) : []));
  const agent = typeof agentId === 'string' && SESSION_ID.test(agentId) ? agentId : null;
  const rows = found.filter(({ repo, number, branch, cwd: folder }) => forge.changeRef({ host: repo.host, path: repo.path, number, branch }) !== null && validCwd(folder))
    .map(({ kind, repo, number, branch, cwd: folder }) => ({ at, agentId: agent, kind, forge: forge.id, host: repo.host, path: repo.path, number, branch, cwd: folder }));
  return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()].slice(0, MAX_ROWS);
}

// The fields that say what a row records, so the same call made again adds no row: all but `at` and `agentId`.
const rowKey = ({ kind, forge, host, path: repoPath, number, branch, cwd }) => JSON.stringify([kind, forge, host, repoPath, number, branch, cwd]);
const keyOfLine = (line) => {
  try {
    return rowKey(JSON.parse(line));
  } catch {
    return null;
  }
};
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
// and writes it: a row whose cwd is no folder on disk, or whose fields a row of the ledger's last LEDGER_MAX_BYTES
// already holds, is left out. The rest are appended; when the ledger is already past LEDGER_MAX_BYTES, as two appends
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
  const seen = new Set(lines.map(keyOfLine));
  const fresh = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
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

// The most change requests the snapshot shows, each a ref of the ledger, a number or a branch, counted before branches
// resolve, so a branch with no change request uses one. The forge's batched read takes as many at most.
export const MAX_REFS = 25;
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
// ordered by each ref's latest row, newest first, since the ledger keeps a row's first time alone; MAX_REFS at most.
// { refs, unsupported }: the refs `forge` reads, each `{ host, path, number, branch }`, and the rest as rows of the
// change request's shape with `unsupported: true`, no forge, and null for all the forge would answer: they start no call.
export function sessionRefs(rows, forge) {
  const found = new Map();
  rows.forEach((row, index) => {
    const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
    if (!KINDS.has(row.kind) || !Number.isFinite(at)) return;
    const { host, path: repoPath, number = null, branch = null } = row;
    const declared = forge.hosts.includes(host);
    if (declared ? forge.changeRef({ host, path: repoPath, number, branch }) === null || !validCwd(row.cwd) : !isUnsupportedRow(row)) return;
    const key = JSON.stringify(number === null ? [host, repoPath, null, branch] : [host, repoPath, number, null]);
    const ref = found.get(key) ?? { host, path: repoPath, number, branch: number === null ? branch : null, declared, at, index };
    found.set(key, { ...ref, at: Math.max(ref.at, at), index });
  });
  const newest = [...found.values()].sort((a, b) => b.at - a.at || b.index - a.index).slice(0, MAX_REFS);
  return {
    refs: newest.filter((ref) => ref.declared).map(({ host, path: repoPath, number, branch }) => ({ host, path: repoPath, number, branch })),
    unsupported: newest.filter((ref) => !ref.declared).map(({ host, path: repo, number }) => ({ host, repo, number, ...UNKNOWN, unsupported: true })),
  };
}

// What a row on a host no adapter declares cannot know.
const UNKNOWN = Object.freeze({ title: null, url: null, isDraft: null, state: null, mergeable: null, reviewDecision: null, unresolvedThreads: null, checks: null });

// The change requests `refs` resolve to, through the adapter's one batched read (changesState): rows that resolved to
// the same change request, by the repository and number the forge answered, give one entry, the newest ref's. Throws
// what the read throws.
export function resolveChanges(forge, refs) {
  const rows = forge.changesState(refs);
  if (!Array.isArray(rows)) throw new Error('no rows');
  const seen = new Set();
  return rows.filter((row) => {
    if (!isChangeRow(row)) return false;
    const key = JSON.stringify([row.host, row.repo, row.number]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
export const isChangeRows = (value) => Array.isArray(value) && value.length <= MAX_REFS && value.every(isChangeRow);

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
