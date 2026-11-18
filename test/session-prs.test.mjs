// The snapshot's side of the session ledger (lib/session-prs.mjs): reading prs.jsonl back, choosing the refs the forge
// reads, and folding its answer into one entry a change request. The forge is the GitHub adapter over a recording gh.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createGithubForge } from '../plugins/aidrian/lib/forges/github.mjs';
import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import { changesSummary, isChangeRow, LEDGER_MAX_BYTES, MAX_REFS, readLedger, resolveChanges, sessionRefs } from '../plugins/aidrian/lib/session-prs.mjs';
import { readSessionTail, sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-prs-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const POSIX = process.platform !== 'win32';
const STATE = path.join(ROOT, 'state');
mkdirSync(STATE, { mode: 0o700 });
let sessions = 0;
const folderOf = () => sessionFolder(STATE, `reader-${(sessions += 1)}`, { checkouts: [] });

const forge = forgeFor(ROOT);
// One ledger row, `at` minutes past a fixed hour.
const row = (fields, minute = 0) => ({
  at: new Date(Date.UTC(2026, 10, 18, 10, minute)).toISOString(), agentId: null, kind: 'pushed', forge: 'github', host: 'github.com',
  path: 'acme/notes', number: null, branch: null, cwd: ROOT, ...fields,
});
const lines = (rows) => rows.map((each) => `${JSON.stringify(each)}\n`).join('');

test('readLedger reads the last 256 KB: a cut first line and a line still being written are dropped', { skip: !POSIX }, () => {
  const folder = folderOf();
  assert.deepEqual(readLedger(folder), [], 'no ledger yet: no rows');
  const file = path.join(folder, 'prs.jsonl');
  const old = row({ branch: 'old' });
  const filler = Array.from({ length: Math.ceil(LEDGER_MAX_BYTES / 150) }, (_, i) => row({ branch: `fill-${i}` }, i % 60));
  const newest = row({ branch: 'newest' }, 59);
  writeFileSync(file, `${lines([old, ...filler, newest])}{"at":"2026-11-18T10:59:00.000Z","kind":"pus`, { mode: 0o600 });
  const rows = readLedger(folder);
  assert.equal(rows.at(-1).branch, 'newest', 'the newest whole row is read, the partial line after it is not');
  assert.ok(!rows.some((each) => each.branch === 'old'), 'rows before the last 256 KB are not read');
  assert.ok(rows.length < filler.length + 1, 'the file holds more than the cap, and only the tail is read');
  const tail = readSessionTail(folder, 'prs.jsonl', { maxBytes: LEDGER_MAX_BYTES });
  assert.ok(Buffer.byteLength(tail.text) <= LEDGER_MAX_BYTES);
  assert.equal(tail.cut, true, 'the cut fell inside a line');
  const first = tail.text.slice(0, tail.text.indexOf('\n'));
  assert.throws(() => JSON.parse(first), 'that first line is no whole row, and readLedger skips it');
  writeFileSync(file, `${lines([row({ branch: 'a' })])}not json\n[1]\nnull\n${lines([row({ branch: 'b' })])}`, { mode: 0o600 });
  assert.deepEqual(readLedger(folder).map((each) => each.branch), ['a', 'b'], 'a line that is no row object is skipped');
});

test('readSessionTail says the tail starts a line when the byte before it is a line feed', { skip: !POSIX }, () => {
  const folder = folderOf();
  writeFileSync(path.join(folder, 'prs.jsonl'), 'abc\ndef\n', { mode: 0o600 });
  assert.deepEqual(readSessionTail(folder, 'prs.jsonl', { maxBytes: 4 }), { text: 'def\n', cut: false });
  assert.deepEqual(readSessionTail(folder, 'prs.jsonl', { maxBytes: 3 }), { text: 'ef\n', cut: true });
  assert.deepEqual(readSessionTail(folder, 'prs.jsonl', { maxBytes: 100 }), { text: 'abc\ndef\n', cut: false });
  assert.equal(readSessionTail(folder, 'usage.json', { maxBytes: 100 }), null, 'only the ledger');
});

test('readLedger refuses a named pipe, a symlink, a hard link, and a file others may read, without waiting', { skip: !POSIX }, () => {
  const other = path.join(ROOT, 'elsewhere.jsonl');
  writeFileSync(other, lines([row({ branch: 'x' })]), { mode: 0o600 });
  const cases = {
    pipe: (file) => spawnSync('mkfifo', [file]),
    symlink: (file) => symlinkSync(other, file),
    'hard link': (file) => linkSync(other, file),
    shared: (file) => writeFileSync(file, lines([row({ branch: 'x' })]), { mode: 0o644 }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const folder = folderOf();
    make(path.join(folder, 'prs.jsonl'));
    const started = Date.now();
    assert.equal(readLedger(folder), null, name);
    assert.ok(Date.now() - started < 2000, name);
  }
});

test('sessionRefs dedupes by repository and number, else by repository and branch, and orders by latest activity', () => {
  const rows = [
    row({ kind: 'touched', branch: 'feat/x' }, 1),
    row({ kind: 'created', number: 7 }, 2),
    row({ kind: 'touched', branch: 'feat/x', cwd: path.join(ROOT, 'other') }, 3),
    row({ kind: 'pushed', branch: 'feat/y' }, 4),
    row({ kind: 'touched', number: 7, branch: null }, 5),
    row({ kind: 'touched', branch: 'feat/x' }, 6),
  ];
  const { refs, unsupported } = sessionRefs(rows, forge);
  assert.deepEqual(refs, [
    { host: 'github.com', path: 'acme/notes', number: null, branch: 'feat/x' },
    { host: 'github.com', path: 'acme/notes', number: 7, branch: null },
    { host: 'github.com', path: 'acme/notes', number: null, branch: 'feat/y' },
  ], 'three touched rows of one branch give one ref; the ref touched last comes first');
  assert.deepEqual(unsupported, []);
});

test('sessionRefs keeps the 25 newest refs, unsupported ones counted, and drops rows whose fields fail', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ branch: `b-${i}` }, i));
  rows.push(row({ host: 'gitlab.com', path: 'acme/notes', number: 3 }, 59));
  const { refs, unsupported } = sessionRefs(rows, forge);
  assert.equal(refs.length + unsupported.length, MAX_REFS);
  assert.equal(unsupported.length, 1);
  assert.deepEqual(refs.map((each) => each.branch), Array.from({ length: 24 }, (_, i) => `b-${29 - i}`), 'the newest first');
  const bad = [
    row({ branch: 'a..b' }), row({ number: 0 }), row({ number: '7' }), row({ branch: 'x'.repeat(256) }), row({ path: 'acme/sub/notes', number: 1 }),
    row({ branch: 'ok', cwd: 'relative' }), row({ branch: 'ok', kind: 'merged' }), row({ branch: 'ok', at: 'never' }), row({ branch: 'feat‮x' }),
  ];
  assert.deepEqual(sessionRefs(bad, forge), { refs: [], unsupported: [] });
});

test('a row on gitlab.com or a made-up host is unsupported, with no forge, only after the snapshot`s own field checks', () => {
  const rows = [
    row({ host: 'gitlab.com', path: 'acme/notes', number: 3, forge: 'github' }, 1),
    row({ host: 'git.example.test', path: 'team/sub/notes', branch: 'feat/x' }, 2),
    row({ host: 'gitlab.com', path: 'acme/notes', number: 4, cwd: 'relative/folder' }, 3),
    row({ host: 'gitlab.com', path: 'acme/notes', number: 0 }, 4),
    row({ host: 'gitlab.com', path: 'acme/notes', branch: 'a..b' }, 5),
    row({ host: 'gitlab.com', path: 'acme/notes', branch: 'feat x' }, 6),
    row({ host: 'GitLab.com\u001b[2J', path: 'acme/notes', number: 5 }, 7),
    row({ host: 'gitlab.com', path: 'acme/notes‮', number: 6 }, 8),
    row({ host: 'gitlab.com', path: 'acme/notes' }, 9),
  ];
  const { refs, unsupported } = sessionRefs(rows, forge);
  assert.deepEqual(refs, []);
  const unknown = { title: null, url: null, isDraft: null, state: null, mergeable: null, reviewDecision: null, unresolvedThreads: null, checks: null, unsupported: true };
  assert.deepEqual(unsupported, [
    { host: 'git.example.test', repo: 'team/sub/notes', number: null, ...unknown },
    { host: 'gitlab.com', repo: 'acme/notes', number: 3, ...unknown },
  ]);
  for (const each of unsupported) assert.ok(!('forge' in each), 'an unsupported row carries no forge');
});

test('resolveChanges sends the refs in one batched read, and rows of one pull request give one entry, the newest ref`s', () => {
  const calls = [];
  const node = (number, branch) => ({
    number, title: `t${number}`, url: `https://github.com/acme/notes/pull/${number}`, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null,
    createdAt: '2026-11-18T10:00:00Z', headRefName: branch, headRepository: { name: 'notes', owner: { login: 'acme' } }, repository: { name: 'notes', owner: { login: 'acme' } },
    reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  });
  const answer = { data: { r0: { pullRequests: { nodes: [node(7, 'feat/x')] }, parent: null }, r1: { pullRequest: node(7, 'feat/x') }, r2: { pullRequests: { nodes: [] }, parent: null } } };
  const adapter = createGithubForge({ cwd: ROOT, run: (args, options) => (calls.push({ args, options }), JSON.stringify(answer)) });
  const refs = [
    { host: 'github.com', path: 'acme/notes', number: null, branch: 'feat/x' },
    { host: 'github.com', path: 'acme/notes', number: 7, branch: null },
    { host: 'github.com', path: 'acme/notes', number: null, branch: 'feat/none' },
  ];
  const rows = resolveChanges(adapter, refs);
  assert.equal(calls.length, 1, 'one call for every ref');
  assert.deepEqual(rows.map((each) => [each.repo, each.number]), [['acme/notes', 7]], 'a pushed and a created row of one pull request: one entry');
  assert.ok(rows.every(isChangeRow));
  assert.deepEqual(resolveChanges(createGithubForge({ cwd: ROOT, run: () => '{"data":{"r0":{"pullRequests":{"nodes":[]},"parent":null}}}' }), refs.slice(2)), [], 'a branch with none: no row');
});

test('the summary counts pull requests: failed, then pending, then passed or skipped; one with no check counts in none', () => {
  const pr = (checks) => ({ checks });
  const prs = [pr({ passed: 3, failed: 1, pending: 2, skipped: 0 }), pr({ passed: 1, failed: 0, pending: 1, skipped: 0 }), pr({ passed: 0, failed: 0, pending: 0, skipped: 2 }),
    pr({ passed: 0, failed: 0, pending: 0, skipped: 0 }), pr(null)];
  assert.equal(changesSummary(prs), '5 PRs · ✓1 ✗1 ⏳1');
  assert.equal(changesSummary([pr({ passed: 1, failed: 0, pending: 0, skipped: 0 })]), '1 PR · ✓1 ✗0 ⏳0');
});
