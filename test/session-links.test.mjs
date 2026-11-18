// The sessions a handoff came from (lib/session-links.mjs): the parent a chain floor names, the lineage that walks those
// names, the reader of the row groups, and the ticket's rules.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { foldCase } from '../plugins/aidrian/lib/fs.mjs';
import { noteFrom, openStore, readFrom, readHop, storeNames } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { keyOfBranch, lineage, MAX_ANCESTORS, prefixList, rowReader, ticketOf } from '../plugins/aidrian/lib/session-links.mjs';
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
const FILES = { 'prs.jsonl': 256 * KB };
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

test('ticketOf: the current branch first, then the newest own row with a key, then the nearest ancestor`s as cut', { skip: !POSIX }, () => {
  const { state } = fixture();
  const repo = path.join(ROOT, `repo-${states}`);
  mkdirSync(repo);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  const own = sessionWith(state, 'kid-4', [ledgerRow({ branch: 'fix/42-login', at: at(9) }), ledgerRow({ branch: 'fix/43-later', at: at(8) }), ledgerRow({ kind: 'created', number: 9, branch: null, at: at(1) })]);
  assert.deepEqual(ticketOf(repo, '', { rows: readerOf(state, own, []) }), { key: '#43', source: 'ledger' }, 'the later at wins; a created row holds no branch');
  const tie = sessionWith(state, 'tie-4', [ledgerRow({ branch: 'fix/1-a', at: at(5) }), ledgerRow({ branch: 'fix/2-b', at: at(5) })]);
  assert.deepEqual(ticketOf(repo, '', { rows: readerOf(state, tie, []) }), { key: '#2', source: 'ledger' }, 'of one at, the later line');
  const keyed = sessionWith(state, 'abc-4', [ledgerRow({ branch: 'feat/abc-7-x' })]);
  assert.deepEqual(ticketOf(repo, 'ABC', { rows: readerOf(state, keyed, []) }), { key: 'ABC-7', source: 'ledger' });
  const empty = sessionWith(state, 'empty-4', [ledgerRow({ kind: 'touched', branch: 'main' })]);
  sessionWith(state, 'mom-4', [ledgerRow({ branch: 'fix/5-parent', at: at(20) }), ledgerRow({ branch: 'fix/6-after', at: at(1) }), ledgerRow({ kind: 'touched', branch: 'fix/7-touched', at: at(19) })]);
  assert.deepEqual(ticketOf(repo, '', { rows: readerOf(state, empty, [{ id: 'mom-4', hopAt: NOW - 10 * 60_000 }]) }), { key: '#5', source: 'ledger' }, 'the parent`s row as cut; not one after the hop, nor a touched one');
  assert.equal(ticketOf(repo, ''), null, 'without a session, rule 2 is not run');
  git('checkout', '-q', '-b', 'fix/99-current');
  assert.deepEqual(ticketOf(repo, '', { rows: readerOf(state, own, []) }), { key: '#99', source: 'branch' }, 'the current branch wins');
  const piped = sessionFolder(state, 'pipe-4', { checkouts: [] });
  spawnSync('mkfifo', [path.join(piped, 'prs.jsonl')]);
  assert.deepEqual(ticketOf(repo, '', { rows: readerOf(state, piped, []) }), { key: '#99', source: 'branch' }, 'rule 1 never reads a ledger');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  assert.throws(() => ticketOf(repo, '', { rows: readerOf(state, piped, []) }), 'an own ledger that cannot be read fails the section');
});

test('session-links.mjs and session-rows.mjs name no host, forge, or tracker outside their comments', () => {
  for (const file of ['session-links.mjs', 'session-rows.mjs']) {
    const code = readFileSync(path.join(LIB, file), 'utf8').split('\n')
      .filter((line) => !/^\s*\/\//u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');
    assert.doesNotMatch(code, /claude|codex|github|gitlab|linear/iu, file);
    assert.doesNotMatch(code, /['"`]gh['"`]/u, file);
  }
  assert.deepEqual(readdirSync(LIB).filter((name) => name === 'session-links.mjs').length, 1);
});
