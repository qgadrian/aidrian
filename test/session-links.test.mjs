// The sessions a handoff came from (lib/session-links.mjs): the parent a chain floor names, the lineage that walks those
// names, the reader of the row groups, and the tickets' rules.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { foldCase } from '../plugins/aidrian/lib/fs.mjs';
import { noteFrom, openStore, readFrom, readHop, storeNames } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { keyOfBranch, lineage, linksOf, MAX_ANCESTORS, MAX_TICKETS, prefixList, rowReader, ticketsOf } from '../plugins/aidrian/lib/session-links.mjs';
import { createdWorktrees, isWorktreeRow, printedResults, recordLinks, worktreeCalls, worktreeRows } from '../plugins/aidrian/lib/session-links-writer.mjs';
import { sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';
import { remoteRepos } from '../plugins/aidrian/lib/session-prs.mjs';
import { readRows } from '../plugins/aidrian/lib/session-rows.mjs';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-links-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const POSIX = process.platform !== 'win32';
const FOLDS = foldCase('A') === 'a';
const LIB = path.resolve(import.meta.dirname, '../plugins/aidrian/lib');
let states = 0;
const KB = 1024;

// A fresh state folder and its continuation store, with a floor writer: `floor(session, parent, secondsAgo)`.
function fixture() {
  const state = path.join(ROOT, `state-${(states += 1)}`);
  mkdirSync(state, { mode: 0o700 });
  const store = openStore(state, { checkouts: [], maxChain: 3 });
  const brief = path.join(store.handoffs, '2026-11-17-task.md');
  const floor = (session, parent, ago = 0, chain = 1) => noteFrom(store, session, { slug: 'task', chain, brief, route: 'clear', parent }, { now: Date.now() - ago * 1000 });
  return { state, store, brief, floor };
}

test('noteFrom writes parent only when it passes SESSION_ID and is not the session itself; isFrom never reads it', () => {
  const { store, brief, floor } = fixture();
  assert.ok(floor('child-1', 'parent-1'));
  assert.equal(readHop(store, 'child-1').parent, 'parent-1');
  assert.deepEqual(readFrom(store, 'child-1'), { slug: 'task', chain: 1, brief, route: 'clear', parent: 'parent-1', at: readFrom(store, 'child-1').at });
  for (const [index, bad] of ['x'.repeat(200), 'a/b', 7, null, 'child-x'].entries()) {
    const session = bad === 'child-x' ? 'child-x' : `bad-${index}`;
    assert.ok(floor(session, bad), String(bad));
    const value = JSON.parse(readFileSync(path.join(store.dir, `from-${session}.json`), 'utf8'));
    assert.equal(Object.hasOwn(value, 'parent'), false, String(bad));
    assert.deepEqual([value.slug, value.chain, value.brief, value.route], ['task', 1, brief, 'clear']);
  }
  assert.ok(floor('case-1', 'CASE-1'));
  const folded = JSON.parse(readFileSync(path.join(store.dir, 'from-case-1.json'), 'utf8'));
  assert.equal(Object.hasOwn(folded, 'parent'), !FOLDS, 'on a disk that folds case, the same id in other letters is no parent');
  const file = path.join(store.dir, 'from-hand-1.json');
  writeFileSync(file, `${JSON.stringify({ slug: 'task', chain: 2, brief, route: 'clear', parent: '../x', at: Date.now() })}\n`, { mode: 0o600 });
  assert.equal(readFrom(store, 'hand-1').chain, 2, 'a malformed parent is still the same floor');
  assert.equal(readHop(store, 'hand-1').parent, null);
});

test('readHop answers the floor readFrom picks, its short id, and the files it opened; with names, the store is not listed', () => {
  const { store, floor } = fixture();
  assert.equal(readHop(store, 'none-1'), null);
  assert.ok(floor('abcd1234-full', 'own-parent', 10, 1));
  assert.deepEqual({ ...readHop(store, 'abcd1234-full'), at: 0 }, { parent: 'own-parent', at: 0, short: null, read: 1 });
  assert.ok(floor('abcd1234', 'short-parent', 5, 2));
  assert.deepEqual({ ...readHop(store, 'abcd1234-full'), at: 0 }, { parent: 'short-parent', at: 0, short: 'abcd1234', read: 2 }, 'the higher chain answers');
  assert.equal(readFrom(store, 'abcd1234-full').chain, 2);
  const names = storeNames(store);
  assert.ok(names.includes('from-abcd1234.json'));
  assert.equal(readHop(store, 'abcd1234-full', { names: [] }).short, null, 'a listing given is the one read: no short floor in it');
  assert.equal(readFrom(store, 'abcd1234-full', { names: [] }).chain, 1);
  assert.equal(readHop(store, 'abcd1234-full', { names, limit: 1 }), null, 'more files than the limit: no answer');
  const refused = openStore(path.join(ROOT, 'missing', '..', 'x'), { checkouts: null, maxChain: 3 });
  assert.equal(readHop(refused, 'abcd1234-full'), null);
  assert.deepEqual(storeNames(refused), []);
});

test('lineage walks the parents nearest first, with the time of each hop', () => {
  const { store, floor } = fixture();
  assert.deepEqual(lineage(store, 'alone-1'), []);
  floor('c-1', 'b-1', 3);
  floor('b-1', 'a-1', 20);
  floor('a-1', 'root-1', 40);
  const walk = lineage(store, 'c-1');
  assert.deepEqual(walk.map(({ id }) => id), ['b-1', 'a-1', 'root-1']);
  assert.deepEqual(walk.map(({ hopAt }) => hopAt), ['c-1', 'b-1', 'a-1'].map((id) => readFrom(store, id).at));
  assert.deepEqual(lineage(store, 'b-1').map(({ id }) => id), ['a-1', 'root-1']);
  assert.deepEqual(lineage(openStore(path.join(ROOT, 'refused'), { checkouts: null, maxChain: 3 }), 'c-1'), [], 'a refused store');
});

test('lineage ends at the session itself, an ancestor seen, a folded twin of the session, and after 5 ancestors', () => {
  const { store, brief, floor } = fixture();
  floor('first-1', 'any-1');
  writeFileSync(path.join(store.dir, 'from-self-1.json'), `${JSON.stringify({ slug: 'task', chain: 1, brief, route: 'clear', parent: 'self-1', at: Date.now() })}\n`, { mode: 0o600 });
  assert.deepEqual(lineage(store, 'self-1'), []);
  floor('loop-c', 'loop-b');
  floor('loop-b', 'loop-a');
  floor('loop-a', 'loop-c');
  assert.deepEqual(lineage(store, 'loop-c').map(({ id }) => id), ['loop-b', 'loop-a'], 'back to the session');
  floor('seen-c', 'seen-b');
  floor('seen-b', 'seen-a');
  floor('seen-a', 'seen-b');
  assert.deepEqual(lineage(store, 'seen-c').map(({ id }) => id), ['seen-b', 'seen-a'], 'back to an ancestor seen');
  floor('twin-x', 'twin-p');
  floor('twin-p', 'TWIN-X');
  assert.deepEqual(lineage(store, 'twin-x').map(({ id }) => id), FOLDS ? ['twin-p'] : ['twin-p', 'TWIN-X']);
  for (let index = 0; index < 7; index += 1) floor(`hop-${index}`, `hop-${index + 1}`, index);
  assert.deepEqual(lineage(store, 'hop-0').map(({ id }) => id), ['hop-1', 'hop-2', 'hop-3', 'hop-4', 'hop-5']);
  assert.equal(MAX_ANCESTORS, 5);
});

test('lineage opens at most 16 floor files: a walk that would open more ends at the 16th', () => {
  const { store, floor } = fixture();
  const first = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const second = 'zyxwvutsrqponmlkjihgfedcba9876543210';
  floor(first, second, 2);
  floor(second, 'third-1', 1);
  floor('third-1', 'fourth-1');
  assert.deepEqual(lineage(store, first).map(({ id }) => id), [second, 'third-1', 'fourth-1']);
  // Nine floors under short ids of each of the first two, of the same chain, so the own floor still answers: 10 files a
  // lookup, 20 for both.
  for (let length = 4; length < 13; length += 1) {
    floor(first.slice(0, length), second, 2, 1);
    floor(second.slice(0, length), 'third-1', 1, 1);
  }
  assert.equal(readHop(store, first).read, 10);
  assert.equal(readHop(store, second).read, 10);
  assert.deepEqual(lineage(store, first).map(({ id }) => id), [second], 'the second lookup would pass 16 files, so the walk ends before it');
});

// A documented limit (docs/handoff.md#across-a-handoff): whether ids fold case is the system's (foldCase), not the
// volume's, so a case-sensitive volume on macOS or Windows is read as one that folds.
test('ids fold case by the system the snapshot runs on, not by the volume', () => {
  assert.equal(foldCase('Kid-1'), ['darwin', 'win32'].includes(process.platform) ? 'kid-1' : 'Kid-1');
});

test('short ids, floors and folder names alike, compare in the case the disk folds to', () => {
  const { store, floor } = fixture();
  const full = 'abcd1234-0000-4000-8000-000000000001';
  floor('ABCD1234', 'parent-1');
  // A floor under the short id in other letters: on a disk that folds case it is the session's.
  assert.equal(readHop(store, full)?.parent ?? null, FOLDS ? 'parent-1' : null);
  floor('abcd1234', 'parent-1');
  const lineageOf = (names) => lineage(store, full, { sessionNames: () => names }).map(({ id }) => id);
  assert.deepEqual(lineageOf([full, 'ABCD1234-other']), FOLDS ? [] : ['parent-1'], 'a folder whose name differs only in case is another session`s');
  assert.deepEqual(lineageOf([full.toUpperCase()]), ['parent-1'], 'the session`s own folder in other letters is its own, or, on a disk that does not fold case, starts with no short id');
});

test('a floor under a short id gives a parent only when no other folder name starts with it, scanning to the second', () => {
  const { store, floor } = fixture();
  const full = 'abcd1234-0000-4000-8000-000000000001';
  floor('abcd1234', 'parent-1');
  assert.deepEqual(lineage(store, full, { sessionNames: () => [] }).map(({ id }) => id), ['parent-1'], 'no folder name starts with it');
  assert.deepEqual(lineage(store, full, { sessionNames: () => [full, 'other-1'] }).map(({ id }) => id), ['parent-1'], 'only the session`s own');
  assert.deepEqual(lineage(store, full, { sessionNames: () => [full, 'abcd1234-other'] }), [], 'another name starts with it');
  assert.deepEqual(lineage(store, full), [], 'no listing');
  assert.deepEqual(lineage(store, full, { sessionNames: () => null }), [], 'a listing that failed');
  let pulled = 0;
  function* many() {
    for (let index = 0; index < 1000; index += 1) {
      pulled += 1;
      yield `abcd1234-${index}`;
    }
  }
  assert.deepEqual(lineage(store, full, { sessionNames: many }), []);
  assert.ok(pulled <= 2, `${pulled} names read`);
  let calls = 0;
  floor(full.replace('abcd', 'bbbb'), 'p-1');
  lineage(store, full.replace('abcd', 'bbbb'), { sessionNames: () => (calls += 1, []) });
  assert.equal(calls, 0, 'no floor under a short id: the sessions folder is not listed');
  lineage(store, full, { sessionNames: () => (calls += 1, []) });
  assert.equal(calls, 1);
});

// The rows of a session folder, `rows` each `{ minute, ...fields }`, `minute` minutes before now.
const NOW = Date.now();
const at = (minute) => new Date(NOW - minute * 60_000).toISOString();
const ledgerRow = (fields) => ({ at: at(10), agentId: null, kind: 'pushed', forge: 'github', host: 'github.com', path: 'acme/notes', number: null, branch: 'feat/x', cwd: ROOT, ...fields });
function sessionWith(state, id, rows) {
  const folder = sessionFolder(state, id, { checkouts: [] });
  writeFileSync(path.join(folder, 'prs.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  return folder;
}
const REMOTES = [{ host: 'github.com', path: 'acme/notes' }];
const FILES = { 'prs.jsonl': 256 * KB, 'links.jsonl': 64 * KB };
function readerOf(state, own, chain, { remotes = () => REMOTES, read } = {}) {
  return rowReader({ own, files: FILES, chain: () => chain, remotes, state, checkouts: [], now: NOW, ...(read ? { read } : {}) });
}

test('an ancestor`s rows are those at or before its hop, from its last 64 KB; a missing folder gives none and creates none', { skip: !POSIX }, () => {
  const { state } = fixture();
  const own = sessionWith(state, 'kid-1', []);
  const hopAt = NOW - 5 * 60_000;
  sessionWith(state, 'mom-1', [
    ledgerRow({ branch: 'kept', at: new Date(hopAt).toISOString() }),
    ledgerRow({ branch: 'late', at: new Date(hopAt + 1).toISOString() }),
    ledgerRow({ branch: 'no-time', at: undefined }),
  ]);
  sessionWith(state, 'gran-1', [ledgerRow({ branch: 'gran', at: at(30) })]);
  const reader = readerOf(state, own, [{ id: 'gone-1', hopAt }, { id: 'mom-1', hopAt }, { id: 'gran-1', hopAt: NOW - 20 * 60_000 }]);
  const groups = [...reader.inherited('prs.jsonl')].map((rows) => rows.map(({ branch }) => branch));
  assert.deepEqual(groups, [[], ['kept'], ['gran']]);
  assert.equal(existsSync(path.join(state, 'sessions', 'gone-1')), false, 'no folder made for a missing ancestor');
  const big = Array.from({ length: 1500 }, (_, index) => ledgerRow({ branch: `b-${index}`, at: at(60) }));
  sessionWith(state, 'big-1', big);
  const [rows] = [...readerOf(state, own, [{ id: 'big-1', hopAt: NOW }]).inherited('prs.jsonl')];
  assert.ok(rows.length < 1500 && rows.length > 100 && rows.at(-1).branch === 'b-1499', 'the last 64 KB alone');
});

test('a refused ancestor folder, or a named pipe at its file, ends the walk: the ancestor after it is not read', { skip: !POSIX }, () => {
  const { state } = fixture();
  const own = sessionWith(state, 'kid-2', []);
  const open = sessionWith(state, 'open-2', [ledgerRow({})]);
  chmodSync(open, 0o755);
  sessionWith(state, 'after-2', [ledgerRow({})]);
  const reads = [];
  const read = (folder, name, options) => (reads.push(path.basename(folder)), readRows(folder, name, options));
  assert.deepEqual([...readerOf(state, own, [{ id: 'open-2', hopAt: NOW }, { id: 'after-2', hopAt: NOW }], { read }).inherited('prs.jsonl')], []);
  assert.deepEqual(reads, [], 'neither is read');
  const piped = sessionFolder(state, 'pipe-2', { checkouts: [] });
  spawnSync('mkfifo', [path.join(piped, 'prs.jsonl')]);
  const started = Date.now();
  assert.deepEqual([...readerOf(state, own, [{ id: 'pipe-2', hopAt: NOW }, { id: 'after-2', hopAt: NOW }], { read }).inherited('prs.jsonl')], []);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(reads, ['pipe-2'], 'the ancestor after the pipe is not read');
});

test('an ancestor hands down created, pushed, and worktree rows on the project`s repositories alone; remotes that fail hand down none', { skip: !POSIX }, () => {
  const { state } = fixture();
  const own = sessionWith(state, 'kid-3', [ledgerRow({ kind: 'touched', host: 'github.com', path: 'outsider/x' }), ledgerRow({ at: new Date(NOW + 365 * 86_400_000).toISOString() }), ledgerRow({ at: new Date(NOW + 30_000).toISOString(), branch: 'soon' })]);
  sessionWith(state, 'mom-3', [
    ledgerRow({ kind: 'touched', branch: 'touched-branch' }), ledgerRow({ kind: 'touched', number: 4, branch: null }),
    ledgerRow({ kind: 'created', number: 5, branch: null, path: 'other/repo' }), ledgerRow({ kind: 'pushed', branch: 'other', path: 'other/repo' }),
    ledgerRow({ kind: 'created', number: 6, branch: null }), ledgerRow({ kind: 'pushed', branch: 'mine' }),
    ledgerRow({ kind: 'worktree', host: null, path: null, branch: 'loose' }),
    ledgerRow({ kind: 'pushed', branch: 'ahead', at: new Date(NOW + 365 * 86_400_000).toISOString() }),
  ]);
  const chain = [{ id: 'mom-3', hopAt: NOW + 400 * 86_400_000 }];
  let asked = 0;
  const reader = readerOf(state, own, chain, { remotes: () => (asked += 1, REMOTES) });
  assert.deepEqual(reader.own('prs.jsonl').map(({ kind, path: repo, branch }) => `${kind} ${repo} ${branch}`), ['touched outsider/x feat/x', 'pushed acme/notes soon'], 'the own rows unfiltered but for time');
  assert.equal(asked, 0, 'no ancestor read yet: no remotes read');
  assert.deepEqual(reader.ancestor(0, 'prs.jsonl').map(({ kind, number, branch }) => `${kind} ${number} ${branch}`), ['created 6 null', 'pushed null mine']);
  reader.ancestor(0, 'prs.jsonl');
  [...reader.inherited('prs.jsonl')];
  assert.equal(asked, 1, 'the remotes are read once');
  assert.deepEqual(readerOf(state, own, chain, { remotes: () => [] }).ancestor(0, 'prs.jsonl').map(({ branch }) => branch), ['loose'], 'a row with no repository when the remotes name none');
  assert.equal(readerOf(state, own, chain, { remotes: () => null }).ancestor(0, 'prs.jsonl'), null, 'remotes that cannot be read');
  let none = 0;
  readerOf(state, own, [], { remotes: () => (none += 1, REMOTES) }).ancestor(0, 'prs.jsonl');
  assert.equal(none, 0, 'no ancestor: no remotes read');
});

test('in a checkout whose origin is a fork and whose upstream its parent, a parent`s created ref on either is handed down', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `fork-${states}`);
  mkdirSync(repo);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:me/notes.git');
  git('remote', 'add', 'upstream', 'https://github.com/acme/notes.git');
  git('remote', 'add', 'local', '/srv/mirror.git');
  const remotes = remoteRepos(repo);
  assert.deepEqual(remotes, [{ host: 'github.com', path: 'me/notes' }, { host: 'github.com', path: 'acme/notes' }], 'a remote on disk names none');
  const own = sessionWith(state, 'kid-5', []);
  sessionWith(state, 'mom-5', [ledgerRow({ kind: 'created', number: 1, path: 'me/notes' }), ledgerRow({ kind: 'created', number: 2 }), ledgerRow({ kind: 'created', number: 3, path: 'else/notes' })]);
  const reader = readerOf(state, own, [{ id: 'mom-5', hopAt: NOW }], { remotes: () => remotes });
  assert.deepEqual(reader.ancestor(0, 'prs.jsonl').map(({ number }) => number), [1, 2]);
  assert.equal(remoteRepos(repo, () => ({ status: 128, stdout: '' })), null, 'a read that fails');
  assert.deepEqual(remoteRepos(repo, () => ({ status: 1, stdout: '' })), [], 'no key at all');
});

test('keyOfBranch reads a prefixed key, else #N from <type>/<N>-<slug>', () => {
  assert.equal(keyOfBranch('feat/abc-7-x', prefixList('ABC')), 'ABC-7');
  assert.equal(keyOfBranch('fix/42-login', []), '#42');
  assert.equal(keyOfBranch('main', []), null);
  assert.equal(keyOfBranch(null, []), null);
  assert.throws(() => prefixList('1AB'));
});

test('keyOfBranch gives the configured prefix in ASCII capitals: a lookalike letter that folds into it reaches no key', () => {
  // U+212A KELVIN SIGN folds to k under Unicode case folding.
  const kelvin = keyOfBranch('feat/Key-12-x', prefixList('key'));
  assert.equal(kelvin, 'KEY-12');
  assert.match(kelvin, /^[\x20-\x7e]+$/u);
  assert.equal(keyOfBranch('feat/kEy-12-x', prefixList('ABC|key')), 'KEY-12', 'the matching prefix, not the first');
});

test('ticketsOf: a zero-padded branch number and the closing reference of the same issue take one place; a number of zeros gives none', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-padded-${states}`);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'fix/0042-login'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const own = sessionWith(state, 'kid-14', [ledgerRow({ branch: 'fix/042-again', at: at(2) }), ledgerRow({ branch: 'fix/000-none', at: at(1) })]);
  sessionWith(state, 'mom-14', [ledgerRow({ branch: 'fix/00042-parent', at: at(30) }), ledgerRow({ branch: 'fix/007-parent', at: at(31) })]);
  const changes = [{ host: 'github.com', repo: 'acme/notes', number: 1, inherited: false, closes: ['#42'], title: 'Change 1' }];
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, own, [{ id: 'mom-14', hopAt: NOW }]), changes, origin: ORIGIN })).keys, ['#42 branch', '#7 ledger'],
    'the branch, own, and inherited rows give #42 as the closing reference does; fix/000 gives no key');
  assert.equal(keyOfBranch('fix/0-x', []), null);
});

// The tickets ticketsOf gives, each `key source`, and whether an own file could not be read.
const keysOf = ({ tickets, unread }) => ({ keys: tickets.map(({ key, source }) => `${key} ${source}`), unread });
// The current folder's origin, as ticketsOf asks for it: the repository the fixtures' rows record.
const ORIGIN = () => ({ host: 'github.com', path: 'acme/notes' });

test('ticketsOf: the current branch first, then every own row with a key newest first, then the nearest ancestor`s as cut', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-${states}`);
  mkdirSync(repo);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  const origin = ORIGIN;
  const own = sessionWith(state, 'kid-4', [ledgerRow({ branch: 'fix/42-login', at: at(9) }), ledgerRow({ branch: 'fix/43-later', at: at(8) }), ledgerRow({ kind: 'created', number: 9, branch: null, at: at(1) })]);
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, own, []), origin })), { keys: ['#43 ledger', '#42 ledger'], unread: false }, 'the later at first; a created row holds no branch');
  const tie = sessionWith(state, 'tie-4', [ledgerRow({ branch: 'fix/1-a', at: at(5) }), ledgerRow({ branch: 'fix/2-b', at: at(5) })]);
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, tie, []), origin })).keys, ['#2 ledger', '#1 ledger'], 'of one at, the later line first');
  const keyed = sessionWith(state, 'abc-4', [ledgerRow({ branch: 'feat/abc-7-x' }), ledgerRow({ branch: 'feat/ABC-7-again', at: at(5) })]);
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: readerOf(state, keyed, []), origin })).keys, ['ABC-7 ledger'], 'a key in either letter case once');
  const empty = sessionWith(state, 'empty-4', [ledgerRow({ kind: 'touched', branch: 'main' })]);
  sessionWith(state, 'mom-4', [ledgerRow({ branch: 'fix/5-parent', at: at(20) }), ledgerRow({ branch: 'fix/6-after', at: at(1) }), ledgerRow({ kind: 'touched', branch: 'fix/7-touched', at: at(19) })]);
  const chain = [{ id: 'mom-4', hopAt: NOW - 10 * 60_000 }];
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, empty, chain), origin })).keys, ['#5 ledger'], 'the parent`s row as cut; not one after the hop, nor a touched one');
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, own, chain), origin })).keys, ['#43 ledger', '#42 ledger', '#5 ledger'], 'the parent`s keys after the session`s own');
  assert.deepEqual(ticketsOf(repo, ''), { tickets: [], unread: false }, 'without a session, rule 2 is not run');
  git('checkout', '-q', '-b', 'fix/99-current');
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, own, []), origin })).keys, ['#99 branch', '#43 ledger', '#42 ledger'], 'the current branch first, the ledger`s keys after it');
  assert.deepEqual(keysOf(ticketsOf(repo, '')).keys, ['#99 branch'], 'without rows: the branch alone');
  const piped = sessionFolder(state, 'pipe-4', { checkouts: [] });
  spawnSync('mkfifo', [path.join(piped, 'prs.jsonl')]);
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: readerOf(state, piped, []), origin })), { keys: ['#99 branch'], unread: true }, 'an own ledger that cannot be read: unread, the branch`s key kept');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  assert.deepEqual(ticketsOf(repo, '', { rows: readerOf(state, piped, chain), origin }), { tickets: [{ key: '#5', source: 'ledger' }], unread: true }, 'the ancestors are still read');
  assert.throws(() => ticketsOf(repo, '1AB'), 'a bad prefix list');
});

test('ticketsOf: a ledger branch`s #N counts only from a row on origin`s repository, or one that records none; a tracker key from any', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-origin-${states}`);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const own = sessionWith(state, 'kid-11', [
    ledgerRow({ kind: 'touched', branch: 'fix/5-elsewhere', path: 'other/repo', at: at(3) }),
    ledgerRow({ kind: 'touched', branch: 'feat/abc-6-elsewhere', path: 'other/repo', at: at(2) }),
    ledgerRow({ branch: 'fix/7-here', at: at(1) }),
  ]);
  writeFileSync(path.join(own, 'links.jsonl'), `${JSON.stringify(linkRow({ branch: 'fix/8-loose', host: null, path: null }, 4))}\n`, { mode: 0o600 });
  const rows = () => readerOf(state, own, []);
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: rows(), origin: ORIGIN })).keys, ['#7 ledger', 'ABC-6 ledger', '#8 ledger'], 'another repository`s #5 gives none; its tracker key counts; a row that records no repository keeps its #N');
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: rows(), origin: () => null })).keys, ['ABC-6 ledger', '#8 ledger'], 'no origin: no row`s repository is the current one');
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: rows(), origin: () => ({ host: 'github.com', path: 'other/repo' }) })).keys, ['ABC-6 ledger', '#5 ledger', '#8 ledger'], 'origin decides which #N counts');
  const loose = sessionWith(state, 'kid-13', [ledgerRow({ branch: 'feat/abc-6-here', at: at(1) }), ledgerRow({ branch: 'fix/9-loose', host: null, path: null, at: at(2) })]);
  let asked = 0;
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: readerOf(state, loose, []), origin: () => (asked += 1, ORIGIN()) })).keys, ['ABC-6 ledger', '#9 ledger']);
  assert.equal(asked, 0, 'origin is asked only for a #N of a row that records a repository');
});

test('ticketsOf: pull requests give their closing references, then their title`s keys; own before inherited; 10 keys at most; a repeat once', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-prs-${states}`);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'feat/abc-3-x'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const on = { host: 'github.com', repo: 'acme/notes' };
  const changes = [
    { ...on, number: 1, inherited: false, closes: ['#12', 'abc-3', 'DEF-9', 'ABC-4‮', 'ABC-0x', '#0', 42, 'xy-11'],
      title: 'XY-5 and xy-5: Follow up #99, xABC-6, ABC-7x, ABC-1234567890, ABC​-8, ABC-13' },
    { ...on, number: 2, inherited: true, closes: ['ABC-20'], title: 'ABC-21' },
    { ...on, number: 3, inherited: false, title: 'abc-10 later' },
    { host: 'git.example.com', repo: 'acme/notes', number: null, inherited: false, unsupported: true, title: null },
    { ...on, number: 4, inherited: false, closes: 'ABC-30', title: 7 },
  ];
  const own = sessionWith(state, 'kid-10', [ledgerRow({ branch: 'fix/50-own' })]);
  sessionWith(state, 'mom-10', [ledgerRow({ branch: 'fix/51-parent', at: at(30) })]);
  const rows = readerOf(state, own, [{ id: 'mom-10', hopAt: NOW }]);
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC|XY', { rows, changes, origin: ORIGIN })), {
    keys: ['ABC-3 branch', '#50 ledger', '#12 pr', 'XY-11 pr', 'XY-5 pr', 'ABC-10 pr', '#51 ledger', 'ABC-20 pr', 'ABC-21 pr'], unread: false,
  }, 'the branch, the own ledger, the own pull requests, 3 new keys each, so not ABC-13, the parent`s ledger, then the inherited pull requests');
  assert.deepEqual(keysOf(ticketsOf(repo, '', { changes, origin: ORIGIN })).keys, ['#12 pr'], 'no prefix: the forge`s own closing reference alone, never a #N of a title');
  const many = Array.from({ length: 4 }, (_, row) => ({ ...on, number: row + 1, inherited: false, title: Array.from({ length: 3 }, (_, index) => `ABC-${100 + row * 10 + index}`).join(' ') }));
  const reads = [];
  const counted = readerOf(state, own, [{ id: 'mom-10', hopAt: NOW }], { read: (folder, name, options) => (reads.push(path.basename(folder)), readRows(folder, name, options)) });
  const full = ticketsOf(repo, 'ABC', { rows: counted, changes: many, origin: ORIGIN });
  assert.equal(MAX_TICKETS, 10);
  assert.equal(full.tickets.length, MAX_TICKETS);
  assert.deepEqual(full.tickets.slice(0, 3).map(({ key }) => key), ['ABC-3', '#50', 'ABC-100']);
  assert.ok(!reads.includes('mom-10'), 'a full list reads no ancestor');
  assert.deepEqual(ticketsOf(repo, 'ABC', { changes: null }).tickets, [{ key: 'ABC-3', source: 'branch' }], 'no change rows: none from pull requests');
});

test('ticketsOf: a pull request of another repository gives no #N from its closing references; its tracker keys still count', () => {
  const repo = path.join(ROOT, `repo-elsewhere-${states}`);
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const changes = [
    { host: 'github.com', repo: 'other/repo', number: 3, inherited: false, closes: ['#5', 'ABC-9'], title: 'Change 3' },
    { host: 'github.com', repo: 'Acme/Notes', number: 4, inherited: false, closes: ['#6'], title: 'Change 4' },
  ];
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { changes, origin: ORIGIN })).keys, ['ABC-9 pr', '#6 pr'], 'the repository compared in any letter case');
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { changes })).keys, ['ABC-9 pr'], 'no origin: no #N of a pull request');
});

test('ticketsOf: one pull request adds at most 3 keys, its closing references and title together, so an earlier session`s key still shows', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-cap-${states}`);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const own = sessionWith(state, 'kid-12', [ledgerRow({ branch: 'fix/50-own' })]);
  sessionWith(state, 'mom-12', [ledgerRow({ branch: 'fix/51-parent', at: at(30) })]);
  const title = Array.from({ length: 12 }, (_, index) => `ABC-${index + 100}`).join(' ');
  const changes = [
    { host: 'github.com', repo: 'acme/notes', number: 1, inherited: false, closes: ['#50', 'ABC-1'], title },
    { host: 'github.com', repo: 'acme/notes', number: 2, inherited: true, closes: [], title: 'ABC-200 ABC-201 ABC-202 ABC-203' },
  ];
  assert.deepEqual(keysOf(ticketsOf(repo, 'ABC', { rows: readerOf(state, own, [{ id: 'mom-12', hopAt: NOW }]), changes, origin: ORIGIN })).keys, [
    '#50 ledger', 'ABC-1 pr', 'ABC-100 pr', 'ABC-101 pr', '#51 ledger', 'ABC-200 pr', 'ABC-201 pr', 'ABC-202 pr',
  ], 'a key already held takes none of the 3; the parent`s key and the inherited pull request`s still show');
});

test('session-links.mjs, its writer, and session-rows.mjs name no host, forge, or tracker outside their comments', () => {
  for (const file of ['session-links.mjs', 'session-links-writer.mjs', 'session-rows.mjs']) {
    const code = readFileSync(path.join(LIB, file), 'utf8').split('\n')
      .filter((line) => !/^\s*\/\//u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');
    assert.doesNotMatch(code, /claude|codex|github|gitlab|linear/iu, file);
    assert.doesNotMatch(code, /['"`]gh['"`]/u, file);
  }
  assert.deepEqual(readdirSync(LIB).filter((name) => name === 'session-links.mjs').length, 1);
});

// A worktree row of `links.jsonl`, `minute` minutes before now.
const linkRow = (fields, minute = 10) => ({ at: at(minute), kind: 'worktree', host: 'github.com', path: 'acme/notes', branch: 'feat/x', cwd: '/w/x', ...fields });
function linksWith(state, id, rows) {
  const folder = sessionFolder(state, id, { checkouts: [] });
  writeFileSync(path.join(folder, 'links.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  return folder;
}
const linkReader = (state, own, chain, options = {}) => rowReader({ own, files: FILES, chain: () => chain, remotes: () => REMOTES, state, checkouts: [], now: NOW, checks: { 'links.jsonl': isWorktreeRow }, ...options });
const listOf = (...paths) => () => paths.map((entry) => (typeof entry === 'string' ? { path: entry, prunable: false } : entry));

test('a worktree row has exactly its six checked fields; the reader drops one that fails any', () => {
  assert.equal(isWorktreeRow(linkRow({})), true);
  assert.equal(isWorktreeRow(linkRow({ host: null, path: null })), true, 'no origin');
  for (const bad of [linkRow({ cwd: 'relative/w' }), linkRow({ branch: 'feat/\u0007x' }), linkRow({ branch: 'a..b' }), { ...linkRow({}), extra: 'x'.repeat(10 * KB) },
    linkRow({ host: null }), linkRow({ at: 'never' }), linkRow({ kind: 'issue' }), linkRow({ cwd: `/${'x'.repeat(1100)}` }), linkRow({ path: 'acme/notes‮' })]) {
    assert.equal(isWorktreeRow(bad), false, JSON.stringify(bad).slice(0, 80));
  }
});

test('worktreeCalls reads aidrian worktree new through the shared lexer, with the folder each runs in and its place', () => {
  const branches = (command) => worktreeCalls(command, '/here').map(({ branch }) => branch);
  assert.deepEqual(worktreeCalls('aidrian worktree new feat/x', '/here'), [{ branch: 'feat/x', folder: '/here', at: 0 }]);
  assert.deepEqual(worktreeCalls('cd /repo && aidrian worktree new --base origin/main feat/x --slug x --fetch', '/here'), [{ branch: 'feat/x', folder: path.resolve('/repo'), at: 0 }], 'the folder an absolute cd names, as this system resolves it');
  assert.deepEqual(branches('cd sub && aidrian worktree new feat/x'), [], 'a relative cd: the payload may name the folder the line started in or ended in');
  assert.deepEqual(branches('node /p/plugins/aidrian/lib/cli.mjs worktree new feat/y --reuse-existing'), ['feat/y']);
  for (const command of ['aidrian worktree new "$B"', 'aidrian worktree new -x', 'aidrian worktree new feat/x --plan', 'aidrian worktree new --plan=1 feat/x',
    'aidrian worktree new', 'aidrian worktree new a b', 'aidrian worktree cleanup', 'echo aidrian worktree new feat/x', 'aidrian worktree new $(echo x)', 'aidrian worktree new a..b',
    'cd "$X" && aidrian worktree new feat/x']) {
    assert.deepEqual(branches(command), [], command);
  }
  assert.deepEqual(worktreeCalls('aidrian worktree new feat/x', null), [], 'no folder to start from');
});

test('worktreeCalls takes the calls that open the line joined by &&, and what follows them may print', () => {
  const calls = (command) => worktreeCalls(command, '/here').map(({ branch, at }) => [branch, at]);
  assert.deepEqual(calls('aidrian worktree new feat/x && npm test'), [['feat/x', 0]]);
  assert.deepEqual(calls('aidrian worktree new feat/x;'), [['feat/x', 0]], 'a trailing ; ends the line');
  assert.deepEqual(calls('aidrian worktree new feat/a && aidrian worktree new feat/b && npm test'), [['feat/a', 0], ['feat/b', 1]]);
  assert.deepEqual(calls('X=1; aidrian worktree new feat/x && echo done'), [['feat/x', 0]], 'a bare assignment prints nothing');
  assert.deepEqual(calls('aidrian worktree new "$B" && aidrian worktree new feat/b'), [['feat/b', 1]], 'a call the shell fills in keeps its place');
  assert.deepEqual(calls('aidrian worktree new feat/a 2>/dev/null && npm test'), [['feat/a', 0]], 'its error output may go elsewhere');
  assert.deepEqual(calls('aidrian worktree new feat/x\n'), [['feat/x', 0]], 'a trailing newline ends the line');
  assert.deepEqual(calls('aidrian worktree new feat/x && npm test | tee log'), [['feat/x', 0]], 'a pipe inside a command after the calls');
  assert.deepEqual(calls('aidrian worktree new feat/a && aidrian worktree new feat/b | jq .'), [['feat/a', 0]], 'a call piped elsewhere is left out, the one before it kept');
  assert.deepEqual(calls('aidrian worktree new feat/a && aidrian worktree new feat/b --base "$(git rev-parse HEAD)"'), [['feat/a', 0]],
    'a substitution that may print its errors ends the calls before the command that holds it');
  for (const command of [
    // Something that may print comes first.
    `echo '{"status":"created"}'; aidrian worktree new feat/x`, 'npm test && aidrian worktree new feat/x', 'false && aidrian worktree new feat/x',
    // A call that may print nothing before something else prints.
    'aidrian worktree new feat/x; cat saved.json', 'aidrian worktree new feat/x || cat saved.json', 'aidrian worktree new feat/x\ncat saved.json',
    // From the first call on, anything but && lets a later command run after a call that failed.
    'aidrian worktree new feat/a && aidrian worktree new feat/b; npm test', 'aidrian worktree new feat/x && npm test; cat saved.json',
    'aidrian worktree new feat/x && npm test || cat saved.json', "aidrian worktree new feat/x <<'EOF'\nbody\nEOF\ncat saved.json",
    // Its output goes elsewhere, or runs beside another command's.
    'aidrian worktree new feat/x | jq .', 'aidrian worktree new feat/x > out.json && cat out.json', 'aidrian worktree new feat/x & cat saved.json',
    'aidrian worktree new feat/x && npm test & cat saved.json', 'aidrian worktree new feat/x &', 'aidrian worktree new feat/x && npm test &',
    '! aidrian worktree new feat/x && cat saved.json', 'X=1 || aidrian worktree new feat/x && cat saved.json',
    // A substitution in the lead whose error output reaches the call's output.
    'X=$(git rev-parse HEAD 2>&1); aidrian worktree new feat/x',
  ]) assert.deepEqual(calls(command), [], command);
});

test('createdWorktrees pairs each call with the result at its place, and takes only a created one of its branch', () => {
  const line = (branch, fields = {}) => JSON.stringify({ status: 'created', worktree_path: `/w/${branch}`, branch, ...fields });
  const blocked = JSON.stringify({ status: 'blocked', phase: 'validate', reason: 'x' });
  const made = (command, output) => createdWorktrees(command, '/here', output).map(({ branch, path: tree }) => [branch, tree]);
  assert.deepEqual(made('aidrian worktree new a', `noise\n${line('a')}\n`), [['a', '/w/a']], 'a line of another shape is skipped');
  assert.deepEqual(made('aidrian worktree new a && npm test', `${line('a')}\ntest output\n${line('b')}\n`), [['a', '/w/a']]);
  assert.deepEqual(made('aidrian worktree new a && aidrian worktree new b', `${line('a')}\n${line('b')}\n`), [['a', '/w/a'], ['b', '/w/b']]);
  assert.deepEqual(made('aidrian worktree new a && aidrian worktree new b', `${blocked}\n${line('b')}\n`), [], 'a refused call ran nothing after it, so no later place is a call`s');
  assert.deepEqual(made('aidrian worktree new a && aidrian worktree new b', `${line('a')}\n${blocked}\n`), [['a', '/w/a']], 'a refusal after it leaves an earlier call`s result');
  assert.deepEqual(made('aidrian worktree new a && aidrian worktree new b && cat saved', `${line('a')}\n${line('a')}\n${line('b')}\n`), [['a', '/w/a']], 'a result at another call`s place');
  for (const output of [null, '', line('a', { status: 'planned' }), blocked, line('a', { worktree_path: 'w/rel' }), line('a..b'), `x ${line('a')}`, '{"status":"created"']) {
    assert.deepEqual(made('aidrian worktree new a', output), [], String(output));
  }
  assert.deepEqual(printedResults(`${'x'.repeat(70 * 1024)}\n${line('a')}`), [], 'read from the output`s first 64 KiB, where the results are');
});

test('worktreeRows writes a row only for a worktree the call created: git`s path, at the path the result names', () => {
  const list = () => [{ path: '/repo', branch: 'main', main: true, prunable: false }, { path: '/w/feat-x', branch: 'feat/x', main: false, prunable: false }, { path: '/w/old', branch: 'old', main: false, prunable: true }];
  const created = [{ branch: 'feat/x', path: '/w/feat-x' }, { branch: 'old', path: '/w/old' }, { branch: 'main', path: '/repo' }];
  const rows = worktreeRows({ branches: ['feat/x', 'none', 'old', 'main'], created, main: '/repo', origin: { host: 'github.com', path: 'acme/notes' }, at: at(0), list });
  assert.deepEqual(rows, [{ at: at(0), kind: 'worktree', host: 'github.com', path: 'acme/notes', branch: 'feat/x', cwd: '/w/feat-x' }], 'not prunable, not the main checkout');
  assert.deepEqual(worktreeRows({ branches: ['feat/x'], created, main: '/repo', origin: null, at: at(0), list }).map(({ host, path: repo }) => [host, repo]), [[null, null]], 'no origin');
  assert.deepEqual(worktreeRows({ branches: ['feat/x'], created: [], main: '/repo', origin: null, list }), [], 'no created result');
  assert.deepEqual(worktreeRows({ branches: ['feat/x'], created: [{ branch: 'feat/x', path: '/elsewhere' }], main: '/repo', origin: null, list }), [], 'another path');
  assert.deepEqual(worktreeRows({ branches: ['feat/x'], created: [{ branch: 'feat/x', path: '/link/feat-x' }], main: '/repo', origin: null, list, same: (a, b) => a === b.replace('/link', '/w') }).length, 1, 'a path the caller resolves');
  assert.deepEqual(worktreeRows({ branches: ['feat/x'], created, main: '/repo', origin: null, list: () => { throw new Error('git'); } }), [], 'a list that fails');
});

test('the links section: the newest row of each key whose cwd git still lists, own first, then the parent`s as cut', { skip: !POSIX }, () => {
  const { state } = fixture();
  const own = linksWith(state, 'kid-6', [linkRow({ branch: 'feat/a', cwd: '/w/a' }, 20), linkRow({ branch: 'feat/a', cwd: '/w/a-moved' }, 10), linkRow({ branch: 'feat/b', cwd: '/w/b' }, 15)]);
  assert.deepEqual(linksOf(linkReader(state, own, []), listOf('/w/a', '/w/b')), { branch: 'feat/b', worktree: '/w/b', source: 'own' }, 'the newer row of feat/a names a path git does not list');
  assert.deepEqual(linksOf(linkReader(state, own, []), listOf('/w/a-moved', '/w/b')), { branch: 'feat/a', worktree: '/w/a-moved', source: 'own' });
  for (const [label, paths] of [['a trailing slash', ['/w/a-moved/', '/w/b/']], ['letter case', ['/W/a-moved', '/W/b']], ['prunable', [{ path: '/w/a-moved', prunable: true }, { path: '/w/b', prunable: true }]]]) {
    assert.equal(linksOf(linkReader(state, own, []), listOf(...paths)), null, label);
  }
  const empty = linksWith(state, 'kid-7', [linkRow({ cwd: '/w/gone' }, 1)]);
  linksWith(state, 'mom-7', [linkRow({ branch: 'feat/p', cwd: '/w/p' }, 30), linkRow({ branch: 'feat/late', cwd: '/w/late' }, 1), linkRow({ branch: 'feat/other', cwd: '/w/other', path: 'other/repo' }, 29), linkRow({ branch: 'feat/next', cwd: '/w/next', at: new Date(NOW + 365 * 86_400_000).toISOString() })]);
  const chain = [{ id: 'mom-7', hopAt: NOW - 5 * 60_000 }];
  assert.deepEqual(linksOf(linkReader(state, empty, chain), listOf('/w/p', '/w/late', '/w/other', '/w/next')), { branch: 'feat/p', worktree: '/w/p', source: 'inherited' }, 'not one written after the hop, on another repository, or dated ahead');
  let asked = 0;
  assert.equal(linksOf(linkReader(state, sessionFolder(state, 'none-7', { checkouts: [] }), []), () => (asked += 1, [])), null, 'no links.jsonl');
  assert.equal(asked, 0, 'no row: the list is not read');
  assert.throws(() => linksOf(null, listOf()), Error, 'with no session reader');
  assert.throws(() => linksOf(linkReader(state, own, []), () => { throw new Error('git'); }), 'a list that fails');
  const piped = sessionFolder(state, 'pipe-7', { checkouts: [] });
  spawnSync('mkfifo', [path.join(piped, 'links.jsonl')]);
  assert.throws(() => linksOf(linkReader(state, piped, []), listOf()), 'a named pipe');
  const dropped = linksWith(state, 'bad-7', [linkRow({ cwd: 'relative' }), { ...linkRow({}), extra: 1 }]);
  assert.equal(linksOf(linkReader(state, dropped, []), listOf('relative', '/w/x')), null);
});

test('the tickets read both files: a worktree row gives one, and of one at, the links row comes first', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-links-${states}`);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const own = linksWith(state, 'kid-8', [linkRow({ branch: 'fix/42-login' }, 5)]);
  assert.deepEqual(ticketsOf(repo, '', { rows: linkReader(state, own, []), origin: ORIGIN }).tickets, [{ key: '#42', source: 'ledger' }]);
  writeFileSync(path.join(own, 'prs.jsonl'), `${JSON.stringify(ledgerRow({ branch: 'fix/7-pushed', at: at(5) }))}\n`, { mode: 0o600 });
  assert.deepEqual(keysOf(ticketsOf(repo, '', { rows: linkReader(state, own, []), origin: ORIGIN })).keys, ['#42 ledger', '#7 ledger'], 'a tie goes to links.jsonl');
  sessionWith(state, 'kid-9', []);
  linksWith(state, 'kid-9', []);
  linksWith(state, 'mom-9', [linkRow({ branch: 'fix/9-other', path: 'other/repo' }, 30), linkRow({ branch: 'fix/8-mine' }, 31)]);
  assert.deepEqual(ticketsOf(repo, '', { rows: linkReader(state, path.join(state, 'sessions', 'kid-9'), [{ id: 'mom-9', hopAt: NOW }]), origin: ORIGIN }).tickets, [{ key: '#8', source: 'ledger' }], 'a parent`s worktree row on another repository gives none');
});

test('recordLinks appends every row with no key, and none that fails the row checks', { skip: !POSIX }, () => {
  const { state } = fixture();
  const folder = sessionFolder(state, 'rec-1', { checkouts: [] });
  assert.equal(recordLinks(folder, [linkRow({}), linkRow({})]), true);
  assert.equal(recordLinks(folder, [linkRow({ cwd: 'relative' })]), false);
  assert.equal(readRows(folder, 'links.jsonl', { maxBytes: 64 * KB }).length, 2);
});
