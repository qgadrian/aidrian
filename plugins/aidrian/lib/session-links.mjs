// What `aidrian session snapshot` (lib/session-snapshot.mjs) reads of the sessions a handoff came from, and the tickets
// (docs/handoff.md#the-snapshot). Display data only: no hook, gate, skill, or agent decides anything from it.
//
// A chain floor names the session that handed off as its `parent` (lib/handoff-markers.mjs noteFrom). `lineage` walks
// those names back, nearest first; `rowReader` reads the rows of the session's own files, then each ancestor's, each
// file at most once a snapshot, and gives an ancestor's rows only as they were when it handed off, and only those it
// hands down: a created, pushed, or worktree row on a repository the project's remotes name. `ticketsOf` holds every rule
// of the tickets, and `linksOf` the snapshot's worktree, from the rows of `links.jsonl` that lib/session-links-writer.mjs
// gives the ledger's hook. Nothing here starts a process on a row's value, or makes a filesystem call on one; an ancestor's folder
// is found by its full id alone, through existingSessionFolder, which creates and sweeps nothing. This file names no
// host, forge, or tracker.

import { memoGit, runGit } from './git.mjs';
import { foldCase } from './fs.mjs';
import { openStore, readHop, SESSION_ID, storeNames } from './handoff-markers.mjs';
import { existingSessionFolder, sessionFolderNames } from './session-folder.mjs';
import { isWorktreeRow, LINKS } from './session-links-writer.mjs';
import { LEDGER, ledgerRowCheck, remoteRepos, remoteRepository } from './session-prs.mjs';
import { readRows } from './session-rows.mjs';

export { LINKS, LINKS_MAX_BYTES } from './session-links-writer.mjs';

// The most ancestors a lineage holds, and the most chain floor files its walk opens.
export const MAX_ANCESTORS = 5;
export const MAX_FLOOR_READS = 16;
// How much of an ancestor's file is read, from its end.
export const ANCESTOR_MAX_BYTES = 64 * 1024;
// How far ahead of the snapshot's clock a row's time may be, for two processes of one machine that read it apart.
export const AHEAD_MS = 60_000;
// The kinds of row an ancestor hands down; a touched row, from only viewing or commenting on a pull request, stays.
const HANDED_DOWN = new Set(['created', 'pushed', 'worktree']);

// The sessions `session` came from, nearest first: [{ id, hopAt }], where `hopAt` is the time of the floor that names
// `id` as its parent. The walk reads the floor readHop picks for each session of it, from `names`, one listing of the
// store `store`, and ends at MAX_ANCESTORS, at an id it has seen, the session's own included, compared in the case the
// disk folds to, at a floor with no usable parent, once MAX_FLOOR_READS floor files are read, and at a refused store,
// for which it gives []. A floor filed under a short id gives a parent only when no session folder name `sessionNames()`
// lists, called once a walk and only for such a floor, starts with that short id but the session's own; the scan ends at
// the first other one, and with no listing the floor gives none. Never throws.
export function lineage(store, session, { now = Date.now(), names, sessionNames } = {}) {
  try {
    if (store.refused || typeof session !== 'string' || !SESSION_ID.test(session)) return [];
    const seen = new Set([foldCase(session)]);
    const out = [];
    let listed;
    const folderNames = () => (listed ??= typeof sessionNames === 'function' ? sessionNames() ?? null : null);
    let read = 0;
    for (let current = session; out.length < MAX_ANCESTORS;) {
      const hop = readHop(store, current, { now, names, limit: MAX_FLOOR_READS - read });
      if (hop === null || hop.parent === null || seen.has(foldCase(hop.parent))) break;
      read += hop.read;
      if (hop.short !== null && !onlyOwn(folderNames(), hop.short, current)) break;
      seen.add(foldCase(hop.parent));
      out.push({ id: hop.parent, hopAt: hop.at });
      current = hop.parent;
    }
    return out;
  } catch {
    return [];
  }
}

// Whether no name of `names` starts with `short` but `own`, each compared in the case the disk folds to, so a folder
// whose name differs only in case is still another session's on a disk that folds case, and a second spelling of the
// session's own folder is still its own: false with no listing.
function onlyOwn(names, short, own) {
  if (names === null || typeof names[Symbol.iterator] !== 'function') return false;
  const [prefix, self] = [foldCase(short), foldCase(own)];
  for (const name of names) if (typeof name === 'string' && foldCase(name).startsWith(prefix) && foldCase(name) !== self) return false;
  return true;
}

// Whether a row's time parses and is no more than AHEAD_MS after `now`.
const timely = (row, now) => {
  const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
  return Number.isFinite(at) && at <= now + AHEAD_MS;
};

// Whether an ancestor hands `row` down: a kind of HANDED_DOWN, on one of `repos`, host and path equal as strings; a row
// with no repository only when `repos` is empty.
const handedDown = (row, repos) => HANDED_DOWN.has(row.kind)
  && (row.host === null && row.path === null ? repos.length === 0 : repos.some((repo) => repo.host === row.host && repo.path === row.path));

// The one reader of a snapshot's row groups. `own` is the session's own folder, `files` each file's name and the most
// of the session's own that is read, `chain()` its lineage, `remotes()` the repositories the project's remotes name or
// null, `state` and `checkouts` what existingSessionFolder takes, and `checks` a file's row check, by its name, which a row
// of it must pass, as a row time must, to be read at all. Each is asked at most once, and only when needed:
// the lineage once an ancestor's rows are, and the remotes once there is an ancestor. Each file is read at most once.
//   own(name)            the session's own rows, timely, or null when the file cannot be read
//   ancestor(index, name) the rows the ancestor at `index` hands down, read from its file's last ANCESTOR_MAX_BYTES and
//                        cut at its hop; null past the last ancestor, once the walk ended: a refused folder or file ends
//                        it, and so do remotes that cannot be read; a missing folder gives []
//   inherited(name)      each ancestor's rows of `name` in turn, nearest first, read only as they are pulled
export function rowReader({ own, files, chain, remotes, state, checkouts, checks = {}, now = Date.now(), read = readRows }) {
  const kept = (name) => (row) => timely(row, now) && (checks[name]?.(row) ?? true);
  const memo = new Map();
  const once = (key, make) => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const ancestors = () => once('chain', () => chain());
  const repos = () => once('remotes', () => remotes());
  const folderOf = (id) => once(`folder:${id}`, () => existingSessionFolder(state, id, { checkouts }));
  const ownRows = (name) => once(`own:${name}`, () => read(own, name, { maxBytes: files[name] })?.filter(kept(name)) ?? null);
  const ancestor = (index, name) => once(`${index}:${name}`, () => {
    const hop = ancestors()[index];
    if (!hop || (index > 0 && ancestor(index - 1, name) === null)) return null;
    const handed = repos();
    if (!Array.isArray(handed)) return null;
    const { folder, refused } = folderOf(hop.id);
    if (refused) return null;
    const rows = folder === null ? [] : read(folder, name, { maxBytes: ANCESTOR_MAX_BYTES });
    return rows?.filter((row) => kept(name)(row) && Date.parse(row.at) <= hop.hopAt && handedDown(row, handed)) ?? null;
  });
  function* inherited(name) {
    for (let index = 0; ; index += 1) {
      const rows = ancestor(index, name);
      if (rows === null) return;
      yield rows;
    }
  }
  return { own: ownRows, ancestor, inherited };
}

// What one snapshot of the session `session` shares between its sections: { store(), names(), rows, origin() }. `store()`
// is the continuation store of the state folder `state`, opened once, and `names()` its one listing (storeNames), which
// the handoff section and the lineage both read. `rows` is the rowReader of the session's own folder `folder`, null with
// none, over the files of `files`, a ledger row passing the ref check of `forge` (session-prs.mjs ledgerRowCheck), and
// `origin()` origin's `{ host, path }` or null, as originRepository records it, with no `url.<base>.insteadOf` rewrite,
// read once, when first asked: it and the rows' remotes share one `git config` read in `cwd`, with `git`, runGit's
// options. `io` replaces storeNames, sessionFolderNames, and readRows for a test that counts their calls.
export function sessionLinks({ state, checkouts, maxChain, folder, session, cwd, files, forge = null, git = {}, now = Date.now(), io = {} }) {
  let store;
  let names;
  let origin;
  const storeOf = () => (store ??= openStore(state, { checkouts, maxChain }));
  const namesOf = () => (names ??= (io.storeNames ?? storeNames)(storeOf()));
  const sessionNames = () => (io.sessionNames ?? sessionFolderNames)(state, { checkouts });
  const config = memoGit(git);
  const rows = folder === null ? null : rowReader({
    own: folder, files, now, state, checkouts, checks: { [LINKS]: isWorktreeRow, [LEDGER]: ledgerRowCheck(forge) }, read: io.readRows,
    chain: () => lineage(storeOf(), session, { now, names: namesOf(), sessionNames }),
    remotes: () => remoteRepos(cwd, config),
  });
  return { store: storeOf, names: namesOf, rows, origin: () => (origin ??= { repo: remoteRepository(cwd, 'origin', config) }).repo };
}

// Ticket prefixes: at most 32, each a letter and up to 15 letters or digits.
const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,15}$/u;
const MAX_PREFIXES = 32;

// The prefixes of `--ticket-prefixes`, pipe-separated; a prefix of the wrong shape, or more than MAX_PREFIXES, throws.
export function prefixList(prefixes) {
  const list = prefixes === '' ? [] : prefixes.split('|');
  if (list.length > MAX_PREFIXES || !list.every((prefix) => PREFIX.test(prefix))) throw new Error('prefixes');
  return list;
}

// The ticket key a branch name holds, or null: a key of `prefixes`, a list prefixList gave, matched as
// `(^|/)(PREFIXES)-[0-9]+` in any case and given as the configured prefix that matched, in ASCII capitals, so a letter
// of another script that folds into a prefix, such as U+212A KELVIN SIGN, reaches no key; with none matching, `#N` from
// a branch named `<type>/<N>-<slug>`.
export function keyOfBranch(branch, prefixes) {
  if (typeof branch !== 'string') return null;
  const escaped = prefixes.map((prefix) => `(${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})`);
  const keyed = prefixes.length ? new RegExp(`(?:^|/)(?:${escaped.join('|')})-([0-9]+)`, 'iu').exec(branch) : null;
  if (keyed) return `${prefixes[keyed.slice(1, -1).findIndex((part) => part !== undefined)].toUpperCase()}-${keyed.at(-1)}`;
  const numbered = /^[^/]+\/([0-9]+)-/u.exec(branch);
  return numbered ? `#${numbered[1]}` : null;
}

// Whether `key`, of a row on the repository `host` and `repoPath`, counts: a tracker key always; a `#N` only when the row
// records no repository, or the one `origin()` gives, asked only then: an issue number names an issue in one repository.
const counts = (key, origin, host, repoPath) => key !== null && (!key.startsWith('#') || (host === null && repoPath === null) || ofRepo(origin(), host, repoPath));
const ofRepo = (repo, host, repoPath) => Boolean(repo) && host === repo.host && typeof repoPath === 'string' && repoPath.toLowerCase() === String(repo.path).toLowerCase();

// The files whose rows give tickets, in the order a tie of times goes: an earlier one first.
const TICKET_FILES = ['links.jsonl', 'prs.jsonl'];
// The most tickets a snapshot shows.
export const MAX_TICKETS = 10;

// The keys of the rows of `groups`, one row list a file in TICKET_FILES order, whose branch holds one that counts, newest
// first: the latest `at`, then the earlier file, then the later line.
function newestKeys(groups, prefixes, origin) {
  const keyed = groups.flatMap((rows, file) => rows.map((row, line) => ({ row, key: keyOfBranch(row.branch, prefixes), at: Date.parse(row.at), file, line })));
  return keyed.filter(({ row, key }) => counts(key, origin, row.host, row.path)).sort((a, b) => b.at - a.at || a.file - b.file || b.line - a.line).map(({ key }) => key);
}

// A change row's `closes` entry, as a ticket: `#<n>`, the forge's own closing reference, as it is; a tracker-shaped key
// only when a prefix of `prefixes` is its prefix, in any letter case, given as that prefix in capitals and its digits;
// else null. The entry is checked again here, so no other character of a row reaches a key.
const CLOSES_NUMBER = /^#([1-9][0-9]{0,9})$/u;
const CLOSES_KEY = /^([A-Za-z][A-Za-z0-9]{0,15})-([0-9]{1,9})$/u;
function closesKey(entry, prefixes) {
  if (typeof entry !== 'string') return null;
  const number = CLOSES_NUMBER.exec(entry);
  if (number) return `#${number[1]}`;
  const keyed = CLOSES_KEY.exec(entry);
  const prefix = keyed && prefixes.find((each) => each.toUpperCase() === keyed[1].toUpperCase());
  return prefix ? `${prefix.toUpperCase()}-${keyed[2]}` : null;
}

// A key-shaped run of a title: not preceded or followed by an ASCII letter or digit. ASCII classes with no `i` flag, so
// no other script's letter folds into a prefix; every quantifier is bounded.
const TITLE_KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,15})-([0-9]{1,9})(?![A-Za-z0-9])/gu;
// The keys of `prefixes` a change row's title holds, left to right, each a prefix in capitals and its digits. A `#N` in a
// title is never a key: there it is as often a change request's number. Accepted residual: a title's keys count from any
// author, since they are display only, matched by a configured prefix alone, and rebuilt in ASCII.
const titleKeys = (title, prefixes) => {
  if (typeof title !== 'string' || prefixes.length === 0) return [];
  const upper = new Set(prefixes.map((prefix) => prefix.toUpperCase()));
  return [...title.matchAll(TITLE_KEY)].filter((match) => upper.has(match[1].toUpperCase())).map((match) => `${match[1].toUpperCase()}-${match[2]}`);
};

// The keys a change row names: its `closes` that count, in order, then its title's. A row with no `closes`, as a cache an
// older plugin wrote holds, gives no closing reference.
const changeKeys = (row, prefixes, origin) => [
  ...(Array.isArray(row?.closes) ? row.closes : []).map((entry) => closesKey(entry, prefixes)).filter((key) => counts(key, origin, row.host, row.repo)),
  ...titleKeys(row?.title, prefixes),
];
// The most new keys one change request adds, its `closes` and title together, so one title cannot fill every place.
export const MAX_CHANGE_KEYS = 3;

// The snapshot's tickets: { tickets, unread }. `tickets` is a list of { key, source }, MAX_TICKETS at most, each key once,
// compared in capitals, with the `source` of the first rule that names it, in this order:
// 1. The branch of the folder `cwd`, from one `git symbolic-ref` there with constant arguments: source `branch`.
// 2. With `rows`, a rowReader of the session, the key of every row of the session's own files whose branch holds one,
//    newest first: source `ledger`. A session file of its own that cannot be read gives none here, and `unread` true.
// 3. With `changes`, the change requests the snapshot shows (session-prs.mjs shownChanges), each of the session's own
//    in order: its `closes`, then its title's keys, MAX_CHANGE_KEYS new ones at most: source `pr`.
// 4. Each ancestor's rows as rowReader hands them down, nearest first, each newest first, read only while the list is
//    not full: source `ledger`. An ancestor's that cannot be read ends the walk.
// 5. Each inherited change request of `changes`, in order, as in rule 3: source `pr`.
// `origin()` gives origin's `{ host, path }`, spelled as the rows are (sessionLinks' origin()), or null: a `#N` of rules
// 2 to 5 counts only from a row of its repository, or one that records none. `prefixes` is the `--ticket-prefixes` text;
// a bad one throws. `git` options are runGit's. Every rule gives its keys in capitals: a key is its own comparison.
export function ticketsOf(cwd, prefixes, { rows = null, changes = null, origin = () => null, git = {} } = {}) {
  const list = prefixList(prefixes);
  const held = new Map();
  const full = () => held.size >= MAX_TICKETS;
  const add = (keys, source, most = MAX_TICKETS) => {
    for (const key of [...new Set(keys)].filter((each) => !held.has(each)).slice(0, most)) if (!full()) held.set(key, { key, source });
  };
  const head = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, git);
  const branchKey = head.status === 0 ? keyOfBranch(head.stdout.trim(), list) : null;
  if (branchKey !== null) add([branchKey], 'branch');
  let unread = false;
  const own = rows === null ? [] : TICKET_FILES.map((name) => rows.own(name));
  if (own.some((each) => each === null)) unread = true;
  else add(newestKeys(own, list, origin), 'ledger');
  const shown = Array.isArray(changes) ? changes : [];
  const pullRequests = (inherited) => shown.filter((row) => (row?.inherited === true) === inherited).forEach((row) => add(changeKeys(row, list, origin), 'pr', MAX_CHANGE_KEYS));
  pullRequests(false);
  for (let index = 0; rows !== null && !full(); index += 1) {
    const groups = TICKET_FILES.map((name) => rows.ancestor(index, name));
    if (groups.every((each) => each === null)) break;
    add(newestKeys(groups.map((each) => each ?? []), list, origin), 'ledger');
  }
  pullRequests(true);
  return { tickets: [...held.values()], unread };
}

// The read-time key of a worktree row: `host/path:branch`, or the branch alone with no repository.
const linkKey = (row) => (row.host === null ? row.branch : `${row.host}/${row.path}:${row.branch}`);

// Of `rows`, the newest row of each key, the later line on a tie, newest first.
function newestOfKeys(rows) {
  const newest = new Map();
  rows.forEach((row, line) => {
    const at = Date.parse(row.at);
    const held = newest.get(linkKey(row));
    if (!held || at >= held.at) newest.set(linkKey(row), { row, at, line });
  });
  return [...newest.values()].sort((a, b) => b.at - a.at || b.line - a.line).map(({ row }) => row);
}

// The snapshot's `links` section: { branch, worktree, source } or null. Of the session's own worktree rows, the newest of
// each key whose `cwd` is, string for string, the path of an entry of `worktrees()`, the snapshot's one worktree list,
// not prunable, the newest: `source: "own"`. With none, the same for each earlier session's rows as rowReader hands
// them down, nearest first: `source: "inherited"`. The list is read only when a row needs it, with no filesystem call on
// a row's value. Throws, so the section fails, with no reader, or when the session's own file or the list cannot be read.
export function linksOf(rows, worktrees) {
  if (rows === null) throw new Error('no session');
  const own = rows.own(LINKS);
  if (own === null) throw new Error('own links');
  const shown = (group) => {
    const candidates = newestOfKeys(group.filter(isWorktreeRow));
    if (candidates.length === 0) return null;
    const listed = worktrees().filter((entry) => !entry.prunable).map((entry) => entry.path);
    return candidates.find((row) => listed.includes(row.cwd)) ?? null;
  };
  const found = shown(own);
  if (found) return { branch: found.branch, worktree: found.cwd, source: 'own' };
  for (let index = 0; ; index += 1) {
    const group = rows.ancestor(index, LINKS);
    if (group === null) return null;
    const inherited = shown(group);
    if (inherited) return { branch: inherited.branch, worktree: inherited.cwd, source: 'inherited' };
  }
}
