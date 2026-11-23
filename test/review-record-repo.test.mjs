// The local review state is keyed by each repository's own owner/name, whichever remote is origin, and a reader gets its
// own repository's record or none (the security re-review of #251). One test per scenario the review probed.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { gateReview, readRecord, writeRecord } from '../plugins/aidrian/lib/review-gate.mjs';
import { sweepDrafts } from '../plugins/aidrian/lib/review/drafts.mjs';
import { brotliCompressSync } from 'node:zlib';

import { answerOwed } from '../plugins/aidrian/lib/review/pending.mjs';
import { emptyState, noteLocalOutcome, noteOutcome, otherRecordMessage, readLocalState, readRecord as readStepRecord, recordFile, SUMMARY_MARKER, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check as mergeRule } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { check as fallbackRule } from '../plugins/aidrian/lib/rules/review-fallback.mjs';
import { question } from '../plugins/aidrian/lib/review/quota.mjs';

const HEAD = 'a'.repeat(40);

// A checkout with `remotes` ([name, url]), its own state folder, and one commit.
function checkout(t, remotes) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-record-repo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [name, url] of remotes) git('remote', 'add', name, url);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' } }));
  git('add', '.');
  git('commit', '-qm', 'init');
  const project = projectAt(dir);
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  return { dir, git, project, transcript };
}

// A record written before the key, under the old name, naming `repo`.
function legacy(project, pr, repo, edit = () => {}) {
  const state = { ...emptyState(pr, repo), revision: 3 };
  edit(state);
  mkdirSync(path.dirname(recordFile(project, pr)), { recursive: true });
  writeFileSync(recordFile(project, pr), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

const running = (state) => {
  state.rounds.push({ head: HEAD });
  state.outcome = { status: 'running', head: HEAD, at: '2026-11-10T10:00:00.000Z' };
};
const merge = (c, command) => mergeRule(command, { cwd: c.dir, env: {}, input: { transcript_path: c.transcript }, viewPr: () => ({ number: 5, headRefOid: HEAD }) });

test('every repository`s record is its own file, whichever remote is origin', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  assert.match(path.basename(recordFile(c.project, 5, 'o/r')), /^pr-5-review-o--r\.json$/u, 'origin`s is keyed too');
  assert.match(path.basename(recordFile(c.project, 5, 'Up/R')), /^pr-5-review-up--r\.json$/u);
});

test('a held-finding stop noted on one repository never builds on another`s record', (t) => {
  // noteLocalOutcome, as the review step's held-finding stop and the bot cap call it, and run.mjs's error note.
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const before = legacy(c.project, 12, 'o/r', running);
  noteLocalOutcome(c.project, 12, 'up/r', { status: 'incomplete', head: HEAD, reason: 'held' });
  const upstream = readLocalState(c.project, 12, 'up/r');
  assert.deepEqual([upstream.repo, upstream.rounds.length, upstream.outcome.status], ['up/r', 0, 'incomplete'], 'a fresh record of its own');
  assert.equal(JSON.parse(readFileSync(recordFile(c.project, 12), 'utf8')).rounds.length, before.rounds.length, 'origin`s record is untouched');
  assert.equal(readLocalState(c.project, 12, 'o/r').outcome.status, 'running');
});

test('a write of origin`s record never overwrites another repository`s, so its merge stays refused', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/acme/notes.git'], ['upstream', 'https://github.com/up/notes.git']]);
  legacy(c.project, 5, 'up/notes', running);
  writeLocalState(c.project, emptyState(5, 'acme/notes'));
  assert.match(merge(c, `gh pr merge 5 -R up/notes --match-head-commit ${HEAD}`) ?? '', /is `running`/u, 'the upstream`s record is still there');
  assert.equal(readLocalState(c.project, 5, 'up/notes').outcome.status, 'running');
  // The same for the attest record.
  const reviews = path.dirname(recordFile(c.project, 5));
  writeFileSync(path.join(reviews, 'pr-6.json'), JSON.stringify({ pr: 6, repo: 'up/notes', head: 'abcdef1', reviewer: 'upstream-reviewer', findings: 0, fixed: 0 }));
  writeRecord(c.project, { pr: 6, repo: 'acme/notes', head: 'abcdef1', reviewer: 'origin-reviewer', findings: 0, fixed: 0, note: null });
  assert.equal(gateReview(c.project, 6, 'up/notes').reviewer, 'upstream-reviewer');
  assert.equal(readRecord(c.project, 6, 'acme/notes').reviewer, 'origin-reviewer');
});

test('origin renamed to upstream: the old record stays its repository`s, and the new origin gets none of it', (t) => {
  // `gh repo fork` renames origin to upstream and adds the fork as origin.
  const c = checkout(t, [['origin', 'https://github.com/acme/notes.git']]);
  legacy(c.project, 5, 'acme/notes', running);
  c.git('remote', 'rename', 'origin', 'upstream');
  c.git('remote', 'add', 'origin', 'https://github.com/me/notes.git');
  assert.equal(readLocalState(c.project, 5, 'me/notes'), null, 'the fork`s #5 has no record');
  assert.equal(merge(c, `gh pr merge 5 -R me/notes --match-head-commit ${HEAD}`), null, 'so its merge is not held by acme/notes#5');
  writeLocalState(c.project, emptyState(5, 'me/notes'));
  assert.match(merge(c, `gh pr merge 5 -R acme/notes --match-head-commit ${HEAD}`) ?? '', /is `running`/u, 'the fork`s write left acme/notes#5 in place');
  writeLocalState(c.project, { ...readLocalState(c.project, 5, 'acme/notes') });
  assert.equal(existsSync(recordFile(c.project, 5)), false, 'acme/notes`s own write moves it to its file');
  assert.equal(readLocalState(c.project, 5, 'acme/notes').outcome.status, 'running');
});

test('an old-name record that names no repository is served to origin alone', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  legacy(c.project, 7, null, running);
  assert.equal(readLocalState(c.project, 7, 'up/r'), null);
  assert.equal(readLocalState(c.project, 7, 'o/r').outcome.status, 'running');
});

test('the quota-fallback rule never takes another repository`s stop as the call`s', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const stop = { head: HEAD, stage: 'independent', reviewer: 'codex-local', passes: ['engine:codex-local'], reason: 'usage limit', at: '2026-11-01T10:00:00.000Z', choice: null };
  legacy(c.project, 12, 'o/r', (state) => (state.quotaStops = [stop]));
  const asked = question({ pr: 12, stop, repo: 'up/r', repoArg: ' --repo up/r' });
  writeFileSync(c.transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-11-01T10:05:00.000Z', toolUseResult: { questions: [{ question: asked.question }], answers: { [asked.question]: asked.options[0].label } } })}\n`);
  assert.match(fallbackRule(asked.options[0].run, { cwd: c.dir, input: { transcript_path: c.transcript } }) ?? '', /holds no such choice/u, 'up/r#12 has no stop of its own');
});

test('drafts: a draft naming no repository goes only when every repository holding a record of its number has ended', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const tmp = path.join(stateDir(c.project), 'tmp');
  const draft = (name) => {
    mkdirSync(path.join(tmp, name), { recursive: true });
    writeFileSync(path.join(tmp, name, 'agent-code-reviewer-1a2b3c4d.findings.json'), '[]');
  };
  writeLocalState(c.project, emptyState(9, 'o/r'));
  writeLocalState(c.project, emptyState(9, 'up/r'));
  for (const name of ['review-9', 'review-9-up--r']) draft(name);
  const states = { 'o/r': 'OPEN', 'up/r': 'MERGED' };
  const forge = { change: (_ref, _fields, options) => ({ state: states[options.repo] ?? 'OPEN' }) };
  const first = sweepDrafts(c.project, { forge });
  assert.deepEqual(first.removed, [{ pr: 9, repo: 'up/r', state: 'merged', files: ['review-9-up--r'] }], 'the upstream`s own folder, by its own state');
  assert.deepEqual(first.kept, [{ pr: 9, reason: 'open' }], 'the legacy draft waits for o/r#9, still open, though the newest record`s #9 merged');
  assert.equal(existsSync(path.join(tmp, 'review-9')), true);
  states['o/r'] = 'CLOSED';
  assert.deepEqual(sweepDrafts(c.project, { forge }).removed.map((row) => row.files), [['review-9']], 'once every one has ended');
});

test('the other-repository refusal never suggests switching to the other repository', () => {
  const message = otherRecordMessage(9, 'qg/voila', 'acme/notes', 'this command records on');
  assert.doesNotMatch(message, /--repo qg\/voila/u);
  assert.match(message, /`aidrian pr review 9 --repo acme\/notes`/u);
});

// The third security review of #251: probes p5 to p8.
const unique = (tag) => `${tag}${process.pid}x${Date.now().toString(36)}`;

// A checkout whose config sets no state.dir, so its state folder is the default one, keyed by origin's URL.
function defaultFolder(t, remotes) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-record-folder-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [name, url] of remotes) git('remote', 'add', name, url);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  return { dir, git, transcript, project: () => projectAt(dir) };
}

test('p5: a pull request`s comment copy that names another repository is never built on or written as its record', (t) => {
  const own = `${unique('own')}/b`;
  const c = checkout(t, [['origin', `https://github.com/${own}.git`], ['up', 'https://github.com/c5/d.git']]);
  const finished = 'd'.repeat(40);
  writeLocalState(c.project, { ...emptyState(12, own), rounds: [{ head: finished }], outcome: { status: 'received', head: finished, at: 'x' } });
  const ownBefore = readFileSync(recordFile(c.project, 12, own), 'utf8');
  // c5/d#12's summary comment carries a copy naming the origin's repository, with a grant by the Human.
  const copy = { ...emptyState(12, own), revision: 9, updatedAt: '2026-11-01T00:00:00Z', extensions: [{ source: 'bot', round: 3, head: 'a'.repeat(40), status: 'granted', by: 'human', human: { answer: 'approve' } }] };
  const body = `${SUMMARY_MARKER}\nsummary\n<!-- aidrian-review-state-br:${brotliCompressSync(Buffer.from(JSON.stringify(copy))).toString('base64')} -->`;
  const comments = [{ id: 1, body, author_association: 'OWNER', user: { login: 'm' } }];
  const reading = () => ({ visibility: 'PRIVATE', inside: true });
  const read = readStepRecord(c.project, 12, comments, 'c5/d', reading, { ignoreOther: true });
  assert.deepEqual([read.state.repo, read.state.extensions ?? []], ['c5/d', []], 'the copy is not c5/d`s: a fresh record');
  const step = readStepRecord(c.project, 12, comments, 'c5/d', reading);
  assert.equal(step.state.repo, 'c5/d', 'await-review and extend read alike');
  const stamped = { ...copy, repo: undefined };
  const noName = `${SUMMARY_MARKER}\nsummary\n<!-- aidrian-review-state-br:${brotliCompressSync(Buffer.from(JSON.stringify(stamped))).toString('base64')} -->`;
  assert.equal(readStepRecord(c.project, 12, [{ id: 1, body: noName, author_association: 'OWNER', user: { login: 'm' } }], 'c5/d', reading).state.repo, 'c5/d', 'a copy naming none is the pull request`s own, and takes its name');
  const head = 'c'.repeat(40);
  writeLocalState(c.project, noteOutcome(read.state, { status: 'fix_required', head, at: 'x' }, () => false, 'c5/d'), { repo: 'c5/d' });
  assert.equal(readFileSync(recordFile(c.project, 12, own), 'utf8'), ownBefore, 'the origin`s record is untouched');
  assert.match(merge(c, `gh pr merge 12 -R c5/d --match-head-commit ${head}`) ?? '', /fix_required/u, 'c5/d#12 stays refused');
  assert.throws(() => writeLocalState(c.project, { ...emptyState(12, own) }, { repo: 'c5/d' }), /is .*'s, not c5\/d's: it records nothing/u, 'a writer refuses a state of another repository');
});

test('p6: an entry owed on one repository in another`s old record moves to its own on its write, and its answer counts', (t) => {
  const own = `${unique('own')}/b`;
  const c = checkout(t, [['origin', `https://github.com/${own}.git`], ['up', 'https://github.com/c6/d.git']]);
  const head = 'c'.repeat(40);
  legacy(c.project, 12, own, (state) => (state.pending = [{ id: 'x1', kind: 'review', head, at: '2026-10-01T00:00:00Z', by: 'H', repo: 'c6/d' }]));
  writeLocalState(c.project, noteOutcome({ ...emptyState(12, 'c6/d'), rounds: [{ head }] }, { status: 'received', head }, () => false, 'c6/d'));
  assert.equal(answerOwed(c.project, 12, 'review', { head, by: 'attest', repo: 'c6/d', isAncestor: () => false }), 1, 'the attest answers it in c6/d`s own record');
  assert.equal(merge(c, `gh pr merge 12 -R c6/d --match-head-commit ${head}`), null, 'so the merge at the reviewed head runs');
  assert.equal(JSON.parse(readFileSync(recordFile(c.project, 12), 'utf8')).pending[0].moved, 'c6/d', 'the old record marks it moved');
});

test('p7: with no record of the number, a draft naming no repository waits for every remote`s repository', (t) => {
  const own = `${unique('own')}/b`;
  const c = checkout(t, [['origin', `https://github.com/${own}.git`], ['up', 'https://github.com/c7/d.git']]);
  const tmp = path.join(c.dir, 'drafts');
  mkdirSync(path.join(tmp, 'review-12'), { recursive: true });
  // An issue session's findings folder, which goes whole, whatever it holds.
  mkdirSync(path.join(tmp, 'review-12@eng-1', 'sub'), { recursive: true });
  writeFileSync(path.join(tmp, 'review-12@eng-1', 'agent-x-0011aabb.findings.json'), '[]');
  writeFileSync(path.join(tmp, 'review-12@eng-1', 'sub', 'notes.md'), 'x');
  // An issue session's own scratch, named for its key, is no draft, whatever it holds, and takes no forge lookup.
  mkdirSync(path.join(tmp, 'eng-2-review-12'), { recursive: true });
  writeFileSync(path.join(tmp, 'eng-2-review-12', 'agent-y-0011aabb.findings.json'), '[]');
  writeFileSync(path.join(tmp, 'eng-3-review-12'), 'x');
  mkdirSync(path.join(tmp, 'eng-4-review-9'), { recursive: true });
  writeFileSync(path.join(tmp, 'pr-12-review.md'), 'x');
  const states = { [own]: 'OPEN', 'c7/d': 'MERGED', default: 'MERGED' };
  const forge = { change: (_ref, _fields, options = {}) => ({ state: states[options.repo ?? 'default'] }) };
  const swept = sweepDrafts(c.project, { forge, dir: tmp, limit: 1 });
  assert.deepEqual([swept.removed, swept.kept], [[], [{ pr: 12, reason: 'open' }]], 'the origin`s #12 is still open, though the forge`s default merged, and read within a limit of 1');
  states[own] = 'CLOSED';
  assert.deepEqual(sweepDrafts(c.project, { forge, dir: tmp }).removed.map((row) => row.files), [['pr-12-review.md', 'review-12', 'review-12@eng-1']], 'an issue session\'s findings folder too, never its other scratch');
  assert.deepEqual([existsSync(path.join(tmp, 'review-12@eng-1')), existsSync(path.join(tmp, 'eng-2-review-12', 'agent-y-0011aabb.findings.json')), existsSync(path.join(tmp, 'eng-3-review-12')), existsSync(path.join(tmp, 'eng-4-review-9'))], [false, true, true, true]);
});

test('p8: a review record survives origin renamed to upstream and a new origin, so the merge stays refused', (t) => {
  const org = `${unique('org')}/x`;
  const c = defaultFolder(t, [['origin', `https://github.com/${org}.git`]]);
  const head = 'c'.repeat(40);
  writeLocalState(c.project(), noteOutcome({ ...emptyState(12, org), rounds: [{ head }] }, { status: 'fix_required', head, at: 'x' }, () => false, org));
  const merging = () => mergeRule(`gh pr merge 12 -R ${org} --match-head-commit ${head}`, { cwd: c.dir, env: {}, input: { transcript_path: c.transcript }, viewPr: () => null });
  assert.match(merging() ?? '', /fix_required/u, 'before the fork');
  const before = stateDir(c.project());
  c.git('remote', 'rename', 'origin', 'upstream');
  c.git('remote', 'add', 'origin', `https://github.com/${unique('me')}/x.git`);
  assert.notEqual(stateDir(c.project()), before, 'the default state folder moved with origin');
  assert.match(merging() ?? '', /fix_required/u, 'the record in the folder the old origin keyed is still found');
  assert.equal(readLocalState(c.project(), 12, org).outcome.status, 'fix_required');
  writeLocalState(c.project(), { ...readLocalState(c.project(), 12, org) });
  assert.ok(existsSync(recordFile(c.project(), 12, org)), 'its next write lands in the new folder');
});

// The fourth security review of #251: probes p9 and p10.
test('p9: a record naming no repository in a folder another remote keys is nobody`s here', (t) => {
  const e = `${unique('e')}/f`;
  const other = defaultFolder(t, [['origin', `https://github.com/${e}.git`]]);
  const grant = [{ source: 'bot', round: 3, head: 'a'.repeat(40), status: 'granted', by: 'human', human: { answer: 'approve' } }];
  const folder = path.dirname(recordFile(other.project(), 12, e));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'pr-12-review.json'), JSON.stringify({ ...emptyState(12, null), revision: 4, extensions: grant }));
  const own = `${unique('own')}/b`;
  const me = defaultFolder(t, [['origin', `https://github.com/${own}.git`]]);
  me.git('remote', 'add', 'x', `https://github.com/${e}.git`);
  assert.equal(readLocalState(me.project(), 12, own), null, 'origin`s read through the added remote gets no record, and no grant');
  assert.equal(merge({ ...me, project: me.project() }, `gh pr merge 12 --match-head-commit ${HEAD}`), null, 'nor does the merge guard count it');
});

test('p9: an entry the owed repository`s own record holds is counted there alone, when the other record cannot be marked', (t) => {
  // adoptOwed marks a moved entry where it can write; where it cannot, owedElsewhere skips the entry by id.
  const two = `${unique('two')}/b`;
  const c = checkout(t, [['origin', `https://github.com/${two}.git`], ['up', 'https://github.com/c10/d.git']]);
  const e1 = { id: 'e1', kind: 'review', head: HEAD, at: '2026-10-01T00:00:00Z', by: 'H', repo: 'c10/d' };
  writeLocalState(c.project, { ...emptyState(12, two), pending: [e1] }, { repo: two });
  const held = recordFile(c.project, 12, two);
  chmodSync(held, 0o444);
  t.after(() => {
    try {
      chmodSync(held, 0o644);
    } catch {}
  });
  writeLocalState(c.project, noteOutcome({ ...emptyState(12, 'c10/d'), rounds: [{ head: HEAD }] }, { status: 'received', head: HEAD }, () => false, 'c10/d'), { repo: 'c10/d' });
  assert.equal(JSON.parse(readFileSync(held, 'utf8')).pending[0].moved, undefined, 'the other record could not be marked');
  assert.equal(readLocalState(c.project, 12, 'c10/d').pending[0].id, 'e1', 'c10/d`s own record took the entry first');
  assert.equal(answerOwed(c.project, 12, 'review', { head: HEAD, by: 'attest', repo: 'c10/d', isAncestor: () => false }), 1);
  assert.equal(merge(c, `gh pr merge 12 -R c10/d --match-head-commit ${HEAD}`), null, 'answered in c10/d`s own record, it is not counted again from the other');
});

test('p10: an entry owed on a repository, left in the folder an origin rename moved away from, is answered by its attest', (t) => {
  const org = `${unique('org')}/x`;
  const c = defaultFolder(t, [['origin', `https://github.com/${org}.git`], ['c', 'https://github.com/c11/d.git']]);
  legacy(c.project(), 12, org, (state) => (state.pending = [{ id: 'e1', kind: 'review', head: HEAD, at: '2026-10-01T00:00:00Z', by: 'H', repo: 'c11/d' }]));
  c.git('remote', 'rename', 'origin', 'upstream');
  c.git('remote', 'add', 'origin', `https://github.com/${unique('me')}/x.git`);
  writeLocalState(c.project(), noteOutcome({ ...emptyState(12, 'c11/d'), rounds: [{ head: HEAD }] }, { status: 'received', head: HEAD }, () => false, 'c11/d'), { repo: 'c11/d' });
  assert.equal(answerOwed(c.project(), 12, 'review', { head: HEAD, by: 'attest', repo: 'c11/d', isAncestor: () => false }), 1, 'the entry moved into c11/d`s own record');
  assert.equal(merge({ ...c, project: c.project() }, `gh pr merge 12 -R c11/d --match-head-commit ${HEAD}`), null, 'so the merge at the reviewed head runs');
});

// The confirming review of #251: probe p11.
test('p11: a write never marks entries in another checkout`s folder, so that checkout keeps refusing the merge', (t) => {
  const own = `${unique('own')}/b`;
  const cd = `${unique('c')}/d`;
  // Checkout B: origin cd, no remote for own; its pre-key record of #12 owes a request on own.
  const b = defaultFolder(t, [['origin', `https://github.com/${cd}.git`]]);
  const head = HEAD;
  const bFile = path.join(path.dirname(recordFile(b.project(), 12, cd)), 'pr-12-review.json');
  mkdirSync(path.dirname(bFile), { recursive: true });
  writeFileSync(bFile, JSON.stringify({ ...emptyState(12, cd), revision: 5, outcome: { status: 'received', head: 'e'.repeat(40), at: 'x' }, rounds: [{ head: 'e'.repeat(40) }], pending: [{ id: 'e1', kind: 'request', head, at: '2026-10-01T00:00:00Z', by: 'H', repo: own }] }));
  const before = readFileSync(bFile, 'utf8');
  const bMerge = () => mergeRule(`gh pr merge 12 -R ${own} --match-head-commit ${head}`, { cwd: b.dir, env: {}, input: { transcript_path: b.transcript }, viewPr: () => null });
  assert.match(bMerge() ?? '', /never sent|no answer/u, 'B refuses before');
  // Checkout A: origin own, and a remote for cd, so A reads B's folder too.
  const a = defaultFolder(t, [['origin', `https://github.com/${own}.git`], ['c', `https://github.com/${cd}.git`]]);
  writeLocalState(a.project(), emptyState(12, own), { repo: own });
  assert.equal(readFileSync(bFile, 'utf8'), before, 'B`s record is byte-identical');
  assert.match(bMerge() ?? '', /never sent|no answer/u, 'B still refuses the merge');
  assert.equal(readLocalState(a.project(), 12, own).pending[0].id, 'e1', 'A`s own record holds the entry');
});
