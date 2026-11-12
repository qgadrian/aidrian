import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reviewProblem } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { splitPasses } from '../plugins/aidrian/lib/review/split.mjs';
import { recordFindings } from '../plugins/aidrian/lib/review/findings.mjs';
import { escapeLines, gitPaths, postedCopy, textChecker, untextedBlocking } from '../plugins/aidrian/lib/review/publish.mjs';
import {
  BODY_LIMIT, clip, emptyState, HELD_LINE, heldMessage, heldRevision, prunePasses, publishState, readLocalState, readRecord, refreshSummary, stateFromComment, summaryBody, writeLocalState,
} from '../plugins/aidrian/lib/review/state.mjs';

const LIMIT = 65_536;
// A write on a private repository, from inside the team, whose checks pass every string: these tests are about the
// record's size and markers, not its text (test/review-publish.test.mjs holds the checks).
const OPEN = { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } };
const records = (body) => (body.match(/aidrian-review-state(?:-br|-held)?:/gu) ?? []).length;

// Deterministic text: words drawn from a fixed vocabulary, as prose compresses, and random letters, as nothing does.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const VOCABULARY = Array.from({ length: 600 }, (_, i) => {
  const next = rng(i + 1);
  return Array.from({ length: 3 + Math.floor(next() * 8) }, () => String.fromCharCode(97 + Math.floor(next() * 26))).join('');
});
const prose = (next, words) => Array.from({ length: words }, () => VOCABULARY[Math.floor(next() * VOCABULARY.length)]).join(' ');
const noise = (next, length) => Array.from({ length }, () => String.fromCharCode(33 + Math.floor(next() * 90))).join('');

// A slice result the way an exec reviewer records one: its itemized findings, contracts, notes, and dropped findings.
function sliceResult(next, files, head, findings) {
  const list = Array.from({ length: findings }, (_, i) => ({ file: files[i % files.length], line: 10 + i, title: prose(next, 8), body: prose(next, 200), severity: ['high', 'medium', 'low'][i % 3] }));
  return {
    head, reviewer: 'codex-local', files: [...files].sort(), findings, open: findings, list, verdicts: [],
    contracts: Array.from({ length: 6 }, () => prose(next, 30)), cross_notes: Array.from({ length: 6 }, () => prose(next, 30)), dropped: list.slice(0, 3),
  };
}

// A record shaped like a long split review: 17 passes, 12 of them slices of packings earlier fixes replaced, about
// 240 KB of JSON. `slices` is the head's packing: 4 slices, the first halved after it failed twice.
function oversizeRecord() {
  const next = rng(5970);
  const slices = ['apps/web', 'apps/api', 'packages/ui', 'packages/db'].map((key) => ({ key, files: Array.from({ length: 4 }, (_, i) => `${key}/src/f${i}.ts`) }));
  const halved = { [splitPasses('codex-local', slices)[0].id]: true };
  const state = { ...emptyState(5970, 'o/r'), revision: 41, halved, rounds: Array.from({ length: 5 }, (_, i) => ({ head: `h${i}`, at: '2026-11-01T00:00:00Z', open: 2, findings: [] })) };
  for (const pass of splitPasses('codex-local', slices, { halved })) {
    state.passes[pass.id] = pass.role === 'cross' ? { head: 'h4', reviewer: 'codex-local', files: null, findings: 1, open: 0, list: [], verdicts: [] } : sliceResult(next, pass.files, 'h4', 3);
  }
  // Twelve slices from packings no head makes any more: the halved slice before it was halved, and other keys.
  const dead = Array.from({ length: 12 }, (_, i) => ({ key: i === 0 ? slices[0].key : `apps/old${i}`, files: i === 0 ? slices[0].files : [`apps/old${i}/a.ts`, `apps/old${i}/b.ts`] }));
  for (const [i, pass] of splitPasses('codex-local', dead).filter((each) => each.role === 'slice').entries()) state.passes[pass.id] = sliceResult(next, pass.files, `h${i % 4}`, 6);
  return { state, slices };
}

test('prunePasses: a stale packing goes, the live one stays with its halves, another reviewer`s live slices and cross passes stay', () => {
  const slices = [{ key: 'src/a', files: ['src/a/1.js', 'src/a/2.js'] }, { key: 'src/b', files: ['src/b/1.js'] }];
  const halved = { [splitPasses('codex-local', slices)[0].id]: true };
  const live = splitPasses('codex-local', slices, { halved });
  const stale = splitPasses('codex-local', [{ key: 'src/a+src/b', files: ['src/a/1.js', 'src/b/1.js'] }])[0];
  const self = splitPasses('code-reviewer', slices)[1];
  const result = (files) => ({ head: 'h', files: files ? [...files].sort() : null, findings: 0, open: 0 });
  const state = { ...emptyState(7, 'o/r'), halved, passes: {} };
  for (const pass of live) state.passes[pass.id] = result(pass.files);
  state.passes[stale.id] = result(stale.files);
  state.passes[self.id] = result(self.files);
  // The same id over other files: a slice whose key now holds another set of files.
  const moved = splitPasses('code-reviewer', [{ key: 'src/a', files: ['src/a/9.js'] }])[0];
  state.passes[moved.id] = result(moved.files);
  state.passes['engine:codex-local'] = result(null);
  state.passes['agent:code-reviewer'] = result(null);

  prunePasses(state, slices);
  assert.deepEqual(Object.keys(state.passes).sort(), [...live.map((pass) => pass.id), self.id, 'engine:codex-local', 'agent:code-reviewer'].sort());
  assert.ok(live.some((pass) => pass.id.endsWith('.a')) && live.some((pass) => pass.id.endsWith('.b')), 'the halved slice is live as two halves');

  // A pass of the current plan stays whatever its id, such as a plan command's own partition named like a slice.
  const own = { ...emptyState(7, 'o/r'), passes: { [stale.id]: result(stale.files) } };
  assert.deepEqual(Object.keys(prunePasses(own, slices, new Set([stale.id])).passes), [stale.id]);

  const unsplit = { ...emptyState(7, 'o/r'), passes: { [stale.id]: result(stale.files) } };
  assert.deepEqual(Object.keys(prunePasses(unsplit, undefined).passes), [stale.id], 'a plan that is not split prunes nothing');
});

test('a record shaped like a long split review publishes under GitHub`s comment limit, with its record', () => {
  const { state, slices } = oversizeRecord();
  const json = JSON.stringify(state).length;
  assert.ok(json > 230_000, `the fixture is a large record (${json} characters)`);
  assert.ok(Buffer.from(JSON.stringify(state)).toString('base64').length > LIMIT, 'the old plain marker could never fit');
  prunePasses(state, slices);
  assert.equal(Object.keys(state.passes).length, 6, 'the live packing: 3 slices, the halved one as two halves, and the cross pass');
  const body = summaryBody(state, null, 'fix_required', OPEN);
  assert.ok(body.length < LIMIT, `${body.length} characters`);
  assert.equal(records(body), 1);
  assert.deepEqual(stateFromComment(body, 5970), { failures: {}, overrides: [], ...state });
});

test('a summary comment counts only when its author is an owner, a member, or a collaborator', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const remote = { ...emptyState(7, 'o/r'), revision: 12 };
  const comment = (author_association, id = 1) => ({ id, body: summaryBody(remote, null, 'x'), author_association });
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(readRecord(project, 7, [comment(association)], 'o/r').state.revision, 12, association);
  }
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', undefined]) {
    assert.equal(readRecord(project, 7, [comment(association)], 'o/r').state.revision, 0, String(association));
    const held = { id: 1, author_association: association, body: ['<!-- aidrian-review-summary -->', '<!-- aidrian-review-state-held:9 -->'].join('\n') };
    assert.equal(readRecord(project, 7, [held], 'o/r').held, undefined, `${association}: a stranger cannot stop a review with a held marker`);
  }
  assert.equal(readRecord(project, 7, [comment('MEMBER'), { ...comment('NONE', 2), body: summaryBody({ ...remote, revision: 99 }, null, 'x') }], 'o/r').state.revision, 12, 'a later stranger hides nothing');

  const posted = [];
  const stranger = [comment('NONE')];
  assert.equal(publishState(remote, { comments: () => stranger, post: (body) => posted.push(body), edit: () => assert.fail('a stranger\'s comment is never edited') }, 'x'), null);
  assert.equal(posted.length, 1);
});

test('an old-marker comment still reads, and is rewritten in place with one compressed record and no old marker', () => {
  const state = { ...emptyState(7, 'o/r'), revision: 3, rounds: [{ head: 'abc1234' }] };
  const old = ['<!-- aidrian-review-summary -->', '### Review: fix_required', '', 'A citation shows the cited line exists.', `<!-- aidrian-review-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->`].join('\n');
  assert.equal(stateFromComment(old, 7).revision, 3);
  const comments = [{ id: 1, body: old, author_association: 'MEMBER' }];
  const error = publishState({ ...state, revision: 4 }, { comments: () => comments, post: () => assert.fail('the comment is edited'), edit: (id, body) => (comments[id - 1].body = body) }, 'x', OPEN);
  assert.equal(error, null);
  assert.equal(records(comments[0].body), 1);
  assert.match(comments[0].body, /aidrian-review-state-br:/u);
  assert.doesNotMatch(comments[0].body, /aidrian-review-state:/u);
  assert.equal(stateFromComment(comments[0].body, 7).revision, 4);
});

test('a body an older release wrote with both markers reads as the newer record, and the next write leaves one', () => {
  const at = (revision) => ({ ...emptyState(7, 'o/r'), revision, rounds: Array.from({ length: revision }, () => ({ head: 'abc1234' })) });
  // 0.22.1 rewrites a comment by dropping only its own plain marker and appending one: the compressed one stays.
  const ours = summaryBody(at(3), null, 'fix_required');
  const both = `${ours}\n<!-- aidrian-review-state:${Buffer.from(JSON.stringify(at(5))).toString('base64')} -->`;
  assert.equal(records(both), 2);
  assert.equal(stateFromComment(both, 7).revision, 5, 'the plain marker is newer');
  const reversed = summaryBody(at(6), null, 'x').replace(/\n<!-- aidrian-review-state-br/u, `\n<!-- aidrian-review-state:${Buffer.from(JSON.stringify(at(4))).toString('base64')} -->\n<!-- aidrian-review-state-br`);
  assert.equal(stateFromComment(reversed, 7).revision, 6, 'and the compressed one when it is newer');
  assert.equal(records(refreshSummary(both, at(6))), 1);
});

test('the held message names the Human`s way out when the writer is gone', () => {
  assert.match(heldMessage(7, 12), /revision 12 on the machine that wrote it/u);
  assert.match(heldMessage(7, 12), /the Human deletes the review summary comment of #7; the review then restarts from this machine's record, or from round 1 with none/u);
});

test('a record too large even compressed is held: the table, the held line and marker, and the record back once it fits', () => {
  const next = rng(1);
  const big = { ...emptyState(7, 'o/r'), revision: 9, passes: { 'engine:codex-local': { head: 'h', files: null, findings: 1, open: 1, list: [{ body: noise(next, 120_000) }] } } };
  const held = summaryBody(big, null, 'fix_required', OPEN);
  assert.ok(held.length < LIMIT);
  assert.equal(records(held), 1);
  assert.equal(heldRevision(held), 9);
  assert.equal(stateFromComment(held, 7), null);
  assert.ok(held.includes(HELD_LINE));
  assert.match(held, /\| engine:codex-local \| `h` \| 1 \| 1 \|/u, 'the table a person reads is still there');

  const comments = [{ id: 1, body: held, author_association: 'MEMBER' }];
  const io = { comments: () => comments, post: () => assert.fail('the comment is edited'), edit: (id, body) => (comments[id - 1].body = body) };
  assert.equal(publishState({ ...big, revision: 10 }, io, 'x', OPEN), null);
  assert.equal(heldRevision(comments[0].body), 10, 'still too large: held at the new revision');
  assert.equal(records(comments[0].body), 1);
  assert.equal(comments[0].body.split(HELD_LINE).length, 2, 'the held line once');

  const small = { ...big, revision: 11, passes: { 'engine:codex-local': { head: 'h', files: null, findings: 0, open: 0 } } };
  assert.equal(publishState(small, io, 'x', OPEN), null);
  assert.equal(heldRevision(comments[0].body), null);
  assert.ok(!comments[0].body.includes(HELD_LINE), 'the held line goes with the held marker');
  assert.equal(records(comments[0].body), 1);
  assert.equal(stateFromComment(comments[0].body, 7).revision, 11);
  assert.equal(refreshSummary(comments[0].body, small, OPEN), comments[0].body, 'a rewrite with the same record changes nothing');
});

test('readRecord: a held comment stops a machine whose record is missing or older, and the writer goes on', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const comment = (revision) => [{ id: 1, body: ['<!-- aidrian-review-summary -->', '### Review: x', HELD_LINE, `<!-- aidrian-review-state-held:${revision} -->`].join('\n'), author_association: 'MEMBER' }];

  assert.deepEqual(readRecord(project, 7, comment(3), 'o/r'), { held: 3, why: 'size' }, 'no local record');
  const local = { ...emptyState(7, 'o/r'), revision: 1 };
  writeLocalState(project, local);
  assert.deepEqual(readRecord(project, 7, comment(3), 'o/r'), { held: 3, why: 'size' }, 'an older local record');
  assert.equal(readRecord(project, 7, comment(2), 'o/r').state.revision, 2, 'the machine that wrote the held record');
  assert.deepEqual(readRecord(project, 7, [], 'o/r').state.revision, 2);
  rmSync(path.join(dir, 'state'), { recursive: true, force: true });
  assert.deepEqual(readRecord(project, 7, [], 'o/r').state, emptyState(7, 'o/r'), 'no record anywhere: an empty one');
});

test('the visible summary is bounded: a 100,000-character visual reason is clipped, with the record or held', () => {
  const next = rng(2);
  const plan = { head: 'abcdef1234', depth: 'single', reasons: [`rule 1: ${'r'.repeat(5000)}`], engine: { name: 'codex-local', reason: 'e'.repeat(5000) }, flows: [] };
  for (const reason of [`capture failed: ${'x'.repeat(100_000)}`, `capture failed: ${noise(next, 100_000)}`]) {
    const state = { ...emptyState(7, 'o/r'), revision: 2, overrides: ['o'.repeat(5000)], visual: { head: 'abcdef1', status: 'failed', reason, error: 'y'.repeat(100_000), mode: 'none', visibility: 'PRIVATE' } };
    const body = summaryBody(state, plan, 'incomplete', OPEN);
    assert.ok(body.length < LIMIT, `${body.length} characters`);
    assert.equal(records(body), 1);
    // The final body is escaped (publish.mjs escapeLines): a mention in the noise gets its zero-width space.
    assert.ok(body.includes(`(${escapeLines([clip(reason)])[0]})`), 'the comment names the clipped reason');
    assert.ok(!body.includes(reason.slice(0, 301)));
  }
  const many = { ...plan, reasons: Array.from({ length: 1000 }, (_, i) => `plan command: reason ${i} ${noise(next, 400)}`) };
  const listed = summaryBody({ ...emptyState(7, 'o/r'), revision: 3 }, many, 'x');
  assert.ok(listed.length < LIMIT, `${listed.length} characters with 1,000 plan reasons`);
  assert.match(listed, /- plan command: reason 24 /u);
  assert.doesNotMatch(listed, /- plan command: reason 25 /u);
  assert.match(listed, /- and 975 more/u);
  const compressible = summaryBody({ ...emptyState(7, 'o/r'), visual: { head: 'a', status: 'failed', reason: 'x'.repeat(100_000), mode: 'none' } }, null, 'x', OPEN);
  assert.ok(stateFromComment(compressible, 7), 'a reason that compresses keeps the record');
  const incompressible = summaryBody({ ...emptyState(7, 'o/r'), visual: { head: 'a', status: 'failed', reason: noise(next, 100_000), mode: 'none' } }, null, 'x', OPEN);
  assert.equal(heldRevision(incompressible), 0, 'one that does not is held');
});

test('a non-member\'s repeated writes edit their own summary comment, which still supplies no record', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const state = (revision) => ({ ...emptyState(7, 'o/r'), revision });
  const summary = (id, login, author_association, revision = 1) => ({ id, user: { login }, author_association, body: summaryBody(state(revision), null, 'x') });
  const io = (comments, viewer) => ({
    comments: () => comments,
    post: (body) => comments.push({ id: comments.length + 100, user: { login: 'fork' }, author_association: 'CONTRIBUTOR', body }),
    edit: (id, body) => (comments.find((comment) => comment.id === id).body = body),
    viewer,
  });

  const own = [];
  for (const revision of [1, 2, 3, 4]) assert.equal(publishState(state(revision), io(own, () => 'fork'), 'x'), null);
  assert.equal(own.length, 1, 'four writes leave one comment');
  assert.equal(stateFromComment(own[0].body, 7).revision, 4);
  assert.equal(readRecord(project, 7, own, 'o/r').state.revision, 0, 'it still supplies no record');

  // Someone else's summary comment is never edited, a member's or a stranger's, whichever came last.
  const mixed = [summary(1, 'fork', 'CONTRIBUTOR'), summary(2, 'mallory', 'NONE'), summary(3, 'maintainer', 'MEMBER', 12)];
  const others = [mixed[1].body, mixed[2].body];
  assert.equal(publishState(state(5), io(mixed, () => 'fork'), 'x'), null);
  assert.deepEqual([mixed.length, stateFromComment(mixed[0].body, 7).revision, mixed[1].body, mixed[2].body], [3, 5, ...others]);
  assert.equal(readRecord(project, 7, mixed, 'o/r').state.revision, 12, 'readers still take the member\'s');

  // A login that cannot be read posts a new comment, even with the user's own comment there.
  for (const viewer of [() => { throw new Error('HTTP 401'); }, () => null, () => '', undefined]) {
    const unknown = [summary(1, 'fork', 'CONTRIBUTOR')];
    const before = unknown[0].body;
    assert.equal(publishState(state(2), io(unknown, viewer), 'x'), null);
    assert.deepEqual([unknown.length, unknown[0].body], [2, before], String(viewer));
  }

  // A non-member with no comment of their own posts when GitHub refuses the member's; then edits their own. Other errors report.
  const refused = [summary(1, 'maintainer', 'MEMBER', 12)];
  const memberBody = refused[0].body;
  const refusing = { ...io(refused, () => 'fork'), edit: (id, body) => {
    if (id === 1) throw new Error('gh: Must have admin rights to Repository. (HTTP 403)');
    refused.find((comment) => comment.id === id).body = body;
  } };
  assert.equal(publishState(state(2), refusing, 'x'), null);
  assert.deepEqual([refused.length, refused[0].body], [2, memberBody]);
  assert.equal(publishState(state(3), refusing, 'x'), null);
  assert.deepEqual([refused.length, stateFromComment(refused[1].body, 7).revision], [2, 3]);
  const outage = [summary(1, 'maintainer', 'MEMBER')];
  assert.match(publishState(state(2), { ...io(outage, () => 'me'), edit: () => { throw new Error('HTTP 502'); } }, 'x'), /HTTP 502/u);
  assert.equal(outage.length, 1);
  const quoted = new Error('Command failed: gh api -f body=the bot said (HTTP 403)\ngh: Bad Gateway (HTTP 502)\n');
  assert.match(publishState(state(2), { ...io(outage, () => 'me'), edit: () => { throw quoted; } }, 'x'), /HTTP 502/u);
  assert.equal(outage.length, 1, 'a status the body only quotes posts nothing');

  // A member's write keeps the one comment readers take, and asks gh nothing with no non-member's summary comment there.
  const members = [summary(1, 'other-member', 'MEMBER')];
  assert.equal(publishState(state(2), io(members, () => assert.fail('no login is read')), 'x'), null);
  assert.deepEqual([members.length, stateFromComment(members[0].body, 7).revision], [1, 2]);
  const member = [summary(1, 'other-member', 'MEMBER'), summary(2, 'mallory', 'NONE')];
  assert.equal(publishState(state(2), io(member, () => 'me'), 'x'), null);
  assert.deepEqual([member.length, stateFromComment(member[0].body, 7).revision, stateFromComment(member[1].body, 7).revision], [2, 2, 1]);
});

// ---- The posted copy of the record (lib/review/publish.mjs postedCopy) ----

const S = 'SENTINEL-TEXT-7f3c';
// A second sentinel, token-shaped and within the config's name format: the shape alone lets it through.
const T = 'ghp_SENTINEL2abcdefghijk0123';
const ISO = '2026-11-11T10:00:00.000Z';
const CONTEXT = { home: homedir(), state: '', roots: [], terms: { hosts: [], accounts: [], variables: [] }, env: {} };
const checker = () => textChecker({ context: CONTEXT, words: [] });
// Each reading a write can make, with no reading at all, and the checks every write runs.
const NOT_PRIVATE = [
  ['PUBLIC', { visibility: 'PUBLIC', inside: true }],
  ['INTERNAL', { visibility: 'INTERNAL', inside: true }],
  ['a failed read', { visibility: null, inside: false }],
  ['no reading', undefined],
  ['PRIVATE from outside the team', { visibility: 'PRIVATE', inside: false }],
];
const PRIVATE_READING = { visibility: 'PRIVATE', inside: true };

// A checkout whose head tracks src/a.js and src/b.js, 40 lines each, as the path checks read them.
function checkout(t, salt = '') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-copy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'src'));
  for (const file of ['src/a.js', 'src/b.js']) writeFileSync(path.join(dir, file), Array.from({ length: 40 }, (_, i) => `${i}${salt}\n`).join(''));
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root: dir, head: git('rev-parse', 'HEAD') };
}

// A record that holds every key the allowlist names and keys it leaves out, with S in every string a reviewer, a judge,
// the Human, or the author supplied, and T in a verdict's flow and invariant and in an attest's pass and reviewer.
function sentinelRecord(head) {
  const finding = (id, over = {}) => ({ id, mint: `0000000${id.at(-1)}`, title: `${S} title`, body: `${S} body`, evidence: `${S} evidence`, file: 'src/a.js', line: 3, severity: 'medium', likelihood: 'plausible', affects: 'users', state: 'open', disposition: 'fix_now', extra_key: S, ...over });
  const pass = 'engine:codex-local';
  return {
    ...emptyState(7, 'o/r'), revision: 5, updatedAt: ISO, idCounter: 6, floored: true, unknown_key: S,
    planNote: { head, passes: { [pass]: { stage: 'independent', reviewer: 'codex-local', security: false }, 'agent:code-reviewer': { stage: 'local', reviewer: 'code-reviewer', security: false } }, pairs: [{ flow: 'booking', invariant: 'no-double' }] },
    rounds: [{ head, at: ISO, open: 1, findings: [finding('R1-1', { pass })] }],
    passes: {
      [pass]: {
        head, reviewer: 'codex-local', seconds: 3, findings: 3, open: 1, files: null, list: [finding('R1-1')],
        ruled: [finding('R1-2', { already_ruled: `${S} ruled`, from: 'residual', residual: `${S} residual`, ruled_id: 'R1-1', severity: 'low', line: 20 })],
        carried: [finding('R1-3', { already_ruled: `${S} carried`, from: 'residual', residual: `${S} residual`, ended: true, ruled_id: 'R1-1', severity: 'medium', line: 30 })],
        verdicts: [{ flow: 'booking', invariant: 'no-double', verdict: 'holds', evidence: `${S} evidence`, reason: `${S} reason` }, { flow: T, invariant: T, verdict: 'holds', evidence: 'src/a.js:1' }],
        contracts: [`${S} contract`], cross_notes: [`${S} note`], dropped: [`${S} dropped`],
      },
      [T]: { head, reviewer: T, findings: 0, open: 0, verdicts: [] },
      'agent:code-reviewer': { head, reviewer: T, findings: 0, open: 0, verdicts: [] },
    },
    dispatched: { 'agent:code-reviewer': { head, files: null, stage: 'local', security: false } },
    signoffs: { booking: { head, at: ISO, by: `${S} signer` } },
    overrides: [`${S} override`, 'round 2 ran the independent stage first'],
    overrulings: [{ flow: 'booking', invariant: 'no-double', head, at: ISO, by: `${S} person`, reason: `${S} reason` }],
    acceptances: [{ flow: 'booking', invariant: 'no-double', head, at: ISO, by: `${S} person`, reason: `${S} reason`, kind: 'comment', evidence: 'https://github.com/o/r/pull/7#issuecomment-1' }],
    outside: { head, approvals: [{ flow: 'booking', invariant: 'no-double', login: 'amy-designer', url: 'https://github.com/o/r/pull/7#pullrequestreview-1', at: ISO }], acceptances: [{ flow: 'booking', invariant: 'no-double', head, at: ISO, by: `${S} person`, reason: `${S} reason`, evidence: 'https://github.com/o/r/pull/7#issuecomment-1', kind: 'comment' }] },
    failures: { [`${head}:${pass}`]: 1 },
    outcome: { status: 'fix_required', head, at: ISO, reason: `${S} outcome`, reasons: [`${S} plan reason`] },
    pending: [{ id: '123-0123abcd', kind: 'review', head, at: ISO, by: `${S} asker`, answered: { at: ISO, head, by: `${S} answerer` } }],
    invariants: { head, items: [{ flow: 'booking', invariant: 'no-double', state: 'unverified' }] },
    visual: { head, status: 'failed', mode: 'none', visibility: 'PRIVATE', reason: `${S} visual`, error: `${S} error`, captured: 0, of: 1 },
    quotaStops: [{ head, stage: 'independent', reviewer: 'codex-local', passes: [pass], reason: `${S} quota`, at: ISO, choice: 'human', chosen_at: ISO, signoff: { by: `${S} signer`, at: ISO } }],
    waivers: [{ head, kind: 'round_cap', verdict: 'waive', reason: `${S} waiver`, judge: 'code-reviewer', at: ISO }],
    extensions: [{
      source: 'plan', round: 2, head, at: ISO, status: 'granted', by: 'human', reasons: [`${S} extension`], red_flags: [`looping: ${S}`],
      judge: { verdict: 'extend', reason: `${S} judge`, head, at: ISO }, human: { answer: 'approve', by: `${S} human`, session: `${S} session`, at: ISO },
      signals: { converging: true, looping: true, drifting: null, bloating: null, unknown: [], evidence: { looping: [{ round: 2, earlier_round: 1, id: 'R1-1', file: 'src/a.js', line: 3, title: `${S} title`, match: 'place' }] } },
    }],
  };
}
const plan = (head) => ({ head, depth: 'single', reasons: ['rule 1: single'], engine: { name: 'codex-local', reason: 'auto' }, flows: [{ id: 'booking', signed: false, humanSigned: false, signoff: 'reviewer' }] });
// Every way a write ends in withRecord: the step's fresh summary, and every other writer's edit of the earlier body.
function writes(state, head, post) {
  const earlier = summaryBody(sentinelRecord(head), plan(head), 'fix_required', { reading: PRIVATE_READING, checker: { allows: () => true } });
  const comments = [{ id: 1, body: earlier, author_association: 'MEMBER' }];
  assert.equal(publishState(state, { comments: () => comments, post: () => assert.fail('the comment is edited'), edit: (id, body) => (comments[id - 1].body = body) }, 'x', post), null);
  return [['the step`s summary', summaryBody(state, plan(head), 'fix_required', post)], ['an edit of an earlier body that held the text', comments[0].body], ['a new comment', summaryBody(state, null, 'x', post)]];
}

test('the posted copy: on any reading but PRIVATE from inside the team, no free text, no unlisted key, and no name the plan does not define', (t) => {
  const { root, head } = checkout(t);
  for (const [label, reading] of NOT_PRIVATE) {
    const state = sentinelRecord(head);
    const post = reading === undefined ? {} : { reading, checker: checker(), root, names: [] };
    for (const [how, body] of writes(state, head, post)) {
      const record = stateFromComment(body, 7);
      const visible = body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n');
      for (const [name, value] of [['S', S], ['T', T]]) {
        assert.ok(!visible.includes(value), `${label}, ${how}: ${name} in the visible body`);
        assert.ok(!JSON.stringify(record).includes(value), `${label}, ${how}: ${name} in the decoded record`);
      }
      assert.ok(!/unknown_key|extra_key/u.test(JSON.stringify(record)), `${label}, ${how}: a key the allowlist does not name`);
      assert.equal(record.revision, 5, `${label}, ${how}: the engine keys are there`);
      assert.match(visible, /round_cap on `[0-9a-f]{7}`: waive by code-reviewer \(an audit entry/u, `${label}, ${how}: the waiver line keeps kind, head, verdict, and judge`);
      assert.match(visible, /- round 2 on `[0-9a-f]{7}`: granted by the Human \(an audit entry, not proof\) \(over red flags: looping\)/u, `${label}, ${how}: the extra rounds line`);
    }
  }
});

test('the posted copy: a value of the wrong shape is left out, and the local record keeps everything', (t) => {
  const { root, head } = checkout(t);
  const state = sentinelRecord(head);
  state.rounds.push({ head: 'not-a-sha', at: 'yesterday', open: -1 });
  state.waivers.push({ head, kind: 'round_cap', verdict: 'maybe', judge: 'code-reviewer', at: ISO });
  const { copy, withheld } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  assert.deepEqual(copy.rounds[1], {}, 'a head that is no SHA, a date that is none, a negative count');
  assert.deepEqual(copy.waivers[1], { head, kind: 'round_cap', judge: 'code-reviewer', at: ISO });
  assert.ok(withheld > 10, 'each left-out value is counted');
  assert.equal(state.passes['engine:codex-local'].list[0].title, `${S} title`, 'the local record is untouched');
});

test('the posted copy: names by value, from the plan note, the config, and the engine; a record with no note keeps none', (t) => {
  const { root, head } = checkout(t);
  const state = sentinelRecord(head);
  const { copy } = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  assert.deepEqual(Object.keys(copy.passes).sort(), ['agent:code-reviewer', 'engine:codex-local'], 'a pass the note does not hold is counted');
  assert.equal(copy.passes['agent:code-reviewer'].reviewer, undefined, 'a reviewer the note, the config, and the engine do not name');
  assert.deepEqual(copy.passes['engine:codex-local'].verdicts, [{ flow: 'booking', invariant: 'no-double', verdict: 'holds' }], 'a pair the note does not hold is counted');
  const named = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [T] }).copy;
  assert.equal(named.passes['agent:code-reviewer'].reviewer, undefined, 'a config name that is token-shaped still fails the always-on check');
  delete state.planNote;
  const bare = postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: ['codex-local'] }).copy;
  assert.deepEqual([bare.passes, bare.waivers[0].judge, bare.overrides], [{}, undefined, []], 'no note: no pass, no reviewer, no stage');
});

test('the posted copy on a private repository from inside the team: the text is there, less every string a check withholds', (t) => {
  const { root, head } = checkout(t);
  const state = sentinelRecord(head);
  const local = `${homedir()}/notes/secret.txt`;
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const pass = state.passes['engine:codex-local'];
  pass.verdicts[0].evidence = `${local} and ${token}`;
  pass.contracts.push(token);
  pass.cross_notes.push(local);
  pass.dropped.push(token);
  state.waivers[0].reason = local;
  state.extensions[0].human.by = token;
  state.extensions[0].judge.reason = local;
  state.overrides.push(`${token} overruled`);
  for (const [how, body] of writes(state, head, { reading: PRIVATE_READING, checker: checker(), root, names: [] })) {
    const text = body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n') + JSON.stringify(stateFromComment(body, 7));
    assert.ok(text.includes(S), `${how}: the free text is posted on a private repository`);
    for (const value of [T, token, local, homedir()]) assert.ok(!text.includes(value), `${how}: ${value.slice(0, 12)} is withheld`);
  }
});

test('the posted copy: a security finding, a finding with no id, and one of a pass the note does not hold post no file or line', (t) => {
  const { root, head } = checkout(t);
  const base = () => {
    const state = sentinelRecord(head);
    state.passes['engine:codex-local'].list = [
      { id: 'R1-1', mint: '00000001', title: 'a', file: 'src/a.js', line: 3, severity: 'medium' },
      { id: 'R1-4', mint: '00000004', title: 'b', file: 'src/b.js', line: 30, severity: 'high' },
      { title: 'c', file: 'src/b.js', line: 10, severity: 'medium' },
    ];
    state.passes['agent:old'] = { head, reviewer: 'code-reviewer', findings: 1, open: 1, list: [{ id: 'R1-5', mint: '00000005', title: 'd', file: 'src/a.js', line: 25, severity: 'low' }] };
    state.dispatched['agent:old'] = { head, files: null };
    state.rounds = [];
    state.extensions = [];
    return state;
  };
  const places = (state) => postedCopy(state, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] }).copy;
  const copy = places(base());
  assert.deepEqual(copy.passes['engine:codex-local'].list.map((each) => [each.id ?? null, each.file ?? null, each.line ?? null, each.security ?? false]),
    [['R1-1', 'src/a.js', 3, false], ['R1-4', null, null, true], [null, null, null, true]], 'an exec finding keeps its place on a head whose plan does not require the security reviewer');
  assert.deepEqual([copy.passes['agent:old'].list[0].file, copy.passes['agent:old'].list[0].security], [undefined, true], 'a pass with neither a plan-note entry nor a security flag of its own');
  const flagged = base();
  flagged.planNote.passes['engine:codex-local'].security = true;
  assert.equal(places(flagged).passes['engine:codex-local'].list[0].file, undefined, 'on a head whose plan requires the security reviewer, the exec finding loses it');
  // A writer whose checkout lacks the entry's head posts no file or line.
  const elsewhere = checkout(t, ' elsewhere');
  const away = postedCopy(base(), { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root: elsewhere.root, names: [] }).copy;
  assert.equal(away.passes['engine:codex-local'].list[0].file, undefined);
  assert.equal(postedCopy(base(), { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), names: [] }).copy.passes['engine:codex-local'].list[0].file, undefined, 'no checkout, no path check');
});

test('the posted copy: twins of a security finding post no place, in their own entries or in a looping evidence entry (K1)', (t) => {
  const { root, head } = checkout(t);
  const state = sentinelRecord(head);
  const slice = 'slice:codex-local:0123456789';
  state.planNote.passes[slice] = { stage: 'independent', reviewer: 'codex-local', security: false };
  state.planNote.passes['cross:codex-local'] = { stage: 'independent', reviewer: 'codex-local', security: false };
  state.passes = {
    'engine:codex-local': { head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R3-7', mint: '00000007', title: 'Late repeat', file: 'src/b.js', line: 12, severity: 'medium' }] },
    [slice]: { head, reviewer: 'codex-local', findings: 2, open: 2, list: [
      { id: 'R3-8', mint: '00000008', title: 'Refund total unchecked', file: 'src/a.js', line: 10, severity: 'high' },
      { id: 'R3-9', mint: '00000009', title: 'Place twin', file: 'src/a.js', line: 12, severity: 'medium' },
    ] },
    'cross:codex-local': { head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R3-10', mint: '00000010', title: 'refund TOTAL unchecked!', file: 'src/b.js', line: 35, severity: 'medium' }] },
  };
  // Round 1's high finding, which no pass's list holds any longer, and its medium report in round 3.
  state.rounds = [{ head, at: ISO, findings: [{ id: 'R1-1', mint: '00000001', title: 'Old high', file: 'src/b.js', line: 13, severity: 'high', pass: 'engine:codex-local' }] }, { head, at: ISO, findings: [] }, { head, at: ISO, findings: [{ id: 'R3-7', mint: '00000007', title: 'Late repeat', file: 'src/b.js', line: 12, severity: 'medium', pass: 'engine:codex-local' }] }];
  state.extensions[0].signals.evidence = { looping: [{ round: 3, earlier_round: 1, id: 'R3-7', file: 'src/b.js', line: 12, match: 'place' }, { round: 3, earlier_round: 1, file: 'src/a.js', line: 1, match: 'title' }, { round: 3, earlier_round: 1, id: 'R9-9', file: 'src/a.js', line: 2, match: 'place' }], drifting: [{ round: 3, id: 'R3-10', file: 'src/b.js', line: 35 }] };
  for (const [label, reading] of NOT_PRIVATE.filter(([, each]) => each)) {
    const { copy } = postedCopy(state, { reading, checker: checker(), root, names: [] });
    const all = [...Object.values(copy.passes).flatMap((result) => result.list), ...copy.rounds.flatMap((round) => round.findings)];
    assert.ok(all.every((each) => each.file === undefined && each.line === undefined && each.security === true), `${label}: ${JSON.stringify(all)}`);
    assert.ok(copy.extensions[0].signals.evidence.looping.every((entry) => entry.file === undefined && entry.line === undefined), `${label}: no place in a looping entry of a security finding, one with no id, or one whose id names no finding`);
    assert.equal(copy.extensions[0].signals.evidence.drifting[0].file, undefined, `${label}: nor in a drifting one`);
    // The security findings' file, which no pass's file list names, is nowhere in what any write posts (J1).
    for (const [how, body] of writes(state, head, { reading, checker: checker(), root, names: [] })) assert.ok(!body.includes('src/b.js') && !JSON.stringify(stateFromComment(body, 7)).includes('src/b.js'), `${label}, ${how}`);
  }
  // A twin finding no security finding ties keeps its place.
  const plain = sentinelRecord(head);
  plain.rounds = [];
  plain.extensions[0].signals.evidence.looping[0].id = 'R1-1';
  const kept = postedCopy(plain, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] }).copy;
  assert.deepEqual([kept.passes['engine:codex-local'].list[0].file, kept.extensions[0].signals.evidence.looping[0].file], ['src/a.js', 'src/a.js']);
});

test('a machine that builds on a higher-revision posted copy keeps every field the projection withheld, and a restarted record gets none', (t) => {
  const { root, head } = checkout(t);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-fill-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const local = sentinelRecord(head);
  local.passes['engine:codex-local'].list[0].severity = 'high';
  local.passes['engine:codex-local'].list[0].security = true;
  writeLocalState(project, local);
  const mine = readLocalState(project, 7);
  const posted = summaryBody({ ...mine, revision: mine.revision + 1 }, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  const adopted = readRecord(project, 7, [{ id: 1, body: posted, author_association: 'MEMBER' }], 'o/r').state;
  assert.equal(adopted.revision, mine.revision + 1, 'the posted copy is the newer record');
  const [first] = adopted.passes['engine:codex-local'].list;
  assert.deepEqual([first.title, first.body, first.evidence, first.file, first.line, first.security], [`${S} title`, `${S} body`, `${S} evidence`, 'src/a.js', 3, true], 'a security finding`s text, place, and mark');
  assert.equal(adopted.passes['engine:codex-local'].ruled[0].residual, `${S} residual`);
  assert.equal(adopted.waivers[0].reason, `${S} waiver`, 'a string outside a finding, by its entry`s key');
  assert.equal(adopted.extensions[0].human.by, `${S} human`);
  assert.deepEqual([adopted.extensions[0].signals.evidence.looping[0].file, adopted.extensions[0].signals.evidence.looping[0].line], ['src/a.js', 3], 'an evidence entry`s place');
  assert.equal(untextedBlocking(adopted), null);

  // A restarted record reuses the id: other mint marks, another waiver time.
  const restarted = sentinelRecord(head);
  restarted.revision = 50;
  for (const each of [...restarted.passes['engine:codex-local'].list, ...restarted.passes['engine:codex-local'].ruled]) each.mint = 'ffffffff';
  restarted.waivers[0].at = '2026-11-12T10:00:00.000Z';
  const other = summaryBody(restarted, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  const taken = readRecord(project, 7, [{ id: 1, body: other, author_association: 'MEMBER' }], 'o/r').state;
  assert.deepEqual([taken.passes['engine:codex-local'].list[0].title, taken.passes['engine:codex-local'].list[0].file, taken.waivers[0].reason], [undefined, 'src/a.js', undefined], 'none of this machine`s text, for a finding and for a waiver`s reason');
  assert.equal(untextedBlocking(taken), 'R1-1', 'an open, blocking finding with no text');
});

test('two machines that mint one id for different findings: the adopted one gets none of this machine`s text, file, or line', (t) => {
  const { root, head } = checkout(t);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-mint-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  // This machine's attest minted R1-1 for its finding.
  const local = { ...emptyState(7, 'o/r'), revision: 2, rounds: [{ head, at: ISO }], passes: { 'agent:code-reviewer': { head, reviewer: 'code-reviewer', findings: 1, open: 1, list: [{ id: 'R1-1', mint: 'aaaaaaaa', title: 'Mine', body: 'mine', file: 'src/b.js', line: 7, severity: 'high', state: 'open', disposition: 'fix_now', security: true }] } } };
  writeLocalState(project, local);
  // Another machine's step minted R1-1 for a different finding, and posted its copy on a public repository.
  const theirs = { ...emptyState(7, 'o/r'), revision: 9, rounds: [{ head, at: ISO }], planNote: { head, passes: { 'agent:code-reviewer': { stage: 'local', reviewer: 'code-reviewer', security: false } }, pairs: [] }, passes: { 'agent:code-reviewer': { head, reviewer: 'code-reviewer', findings: 1, open: 1, list: [{ id: 'R1-1', mint: 'bbbbbbbb', title: 'Theirs', body: 'theirs', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  for (const mark of ['bbbbbbbb', undefined]) {
    theirs.passes['agent:code-reviewer'].list[0].mint = mark;
    const body = summaryBody(theirs, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
    const adopted = readRecord(project, 7, [{ id: 1, body, author_association: 'MEMBER' }], 'o/r').state;
    const [finding] = adopted.passes['agent:code-reviewer'].list;
    assert.deepEqual([finding.title, finding.body, finding.file, finding.line], [undefined, undefined, undefined, undefined], String(mark));
    assert.equal(untextedBlocking(adopted), 'R1-1', `${mark}: an entry with no text, which stops the step`);
  }
});

test('a machine that adopts a copy ties its own closed high finding`s twin, and its next write posts the mark (L1)', (t) => {
  const { root, head } = checkout(t);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-twin-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const note = { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] };
  const high = { id: 'R1-1', mint: '11111111', title: 'Refund total unchecked', file: 'src/a.js', line: 10, severity: 'high', security: true, pass: 'engine:codex-local' };
  // This machine's record: round 1's high finding, closed, which no pass lists any longer.
  writeLocalState(project, { ...emptyState(7, 'o/r'), planNote: note, rounds: [{ head, at: ISO, findings: [high] }], passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 0, open: 0, list: [] } } });
  const mine = readLocalState(project, 7);
  // Another machine built on the copy (no place for the high finding) and recorded a medium finding at its place.
  const medium = { id: 'R2-2', mint: '22222222', title: 'Another wording', file: 'src/a.js', line: 11, severity: 'medium', state: 'open', disposition: 'fix_now' };
  const theirs = { ...mine, revision: mine.revision + 3, rounds: [{ head, at: ISO, findings: [{ ...high, file: undefined, line: undefined }] }, { head, at: ISO, findings: [] }], passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 1, open: 1, list: [medium] } } };
  delete theirs.rounds[0].findings[0].file;
  delete theirs.rounds[0].findings[0].line;
  // Its finding index came from the copy too, which holds no place for a security finding.
  theirs.index = JSON.parse(JSON.stringify(mine.index));
  delete theirs.index['R1-1'].file;
  delete theirs.index['R1-1'].line;
  const posted = summaryBody(theirs, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  assert.equal(stateFromComment(posted, 7).passes['engine:codex-local'].list[0].file, 'src/a.js', 'the other machine could tie nothing: it held no place for the high finding');
  const adopted = readRecord(project, 7, [{ id: 1, body: posted, author_association: 'MEMBER' }], 'o/r').state;
  writeLocalState(project, adopted);
  const next = stateFromComment(summaryBody(adopted, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] }), 7);
  const [twin] = next.passes['engine:codex-local'].list;
  assert.deepEqual([twin.id, twin.security, twin.file, twin.line], ['R2-2', true, undefined, undefined], 'the mark is stored and posted, and the place withheld');
  assert.equal(readLocalState(project, 7).passes['engine:codex-local'].list[0].security, true, 'stored in the local record');
});

test('the record with 200 itemized findings in one pass, each with an id and a full body, fits the comment or is held, on a private repository', () => {
  const next = rng(200);
  const head = 'c'.repeat(40);
  const list = Array.from({ length: 200 }, (_, i) => ({ id: `R1-${i + 1}`, mint: (i + 1).toString(16).padStart(8, '0'), file: `src/f${i % 7}.js`, line: 10 + i, title: prose(next, 8), body: prose(next, 300), severity: ['high', 'medium', 'low'][i % 3], state: 'open', disposition: 'fix_now' }));
  const state = { ...emptyState(7, 'o/r'), revision: 3, idCounter: 200, passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 200, open: 200, list } } };
  const body = summaryBody(state, null, 'fix_required', OPEN);
  assert.ok(body.length <= BODY_LIMIT + 5_000, `${body.length} characters`);
  const record = stateFromComment(body, 7);
  if (record) assert.equal(record.passes['engine:codex-local'].list.length, 200);
  else assert.equal(heldRevision(body), 3, 'or held exactly as before');
});

test('a waiver above low on a pass from an earlier plan survives adoption of a public copy, and still holds auto-merge', (t) => {
  const { root, head } = checkout(t);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hold-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const old = 'slice:codex-local:0123456789';
  const state = {
    ...emptyState(7, 'o/r'), revision: 4, outcome: { status: 'received', head, at: ISO },
    // The step's note keeps the slice of an earlier packing that this head's plan no longer names.
    planNote: { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false }, [old]: { stage: 'independent', reviewer: 'codex-local', security: false } }, pairs: [] },
    passes: {
      'engine:codex-local': { head, reviewer: 'codex-local', findings: 0, open: 0, list: [] },
      [old]: { head, reviewer: 'codex-local', findings: 1, open: 0, list: [], carried: [{ id: 'R1-2', mint: '00000002', ruled_id: 'R1-1', title: 'Retry loop', already_ruled: 'Retry loop', file: 'src/a.js', severity: 'medium', settled_severity: 'medium', residual: 'Retry loop: callers time out first', from: 'residual', ended: true }] },
    },
  };
  const body = summaryBody(state, null, 'received', { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  const adopted = readRecord(project, 7, [{ id: 1, body, author_association: 'MEMBER' }], 'o/r').state;
  assert.ok(adopted.passes[old], 'the pass of the earlier plan is on the copy');
  assert.match(reviewProblem(adopted, head) ?? '', /waived finding R1-1, above low severity and no listing holds it fixed/u);
});

test('the review step stops only on a finding with no text that is not this machine`s own', () => {
  const own = { ...emptyState(7, 'o/r'), passes: { p: { head: 'h', list: [{ id: 'R1-1', mint: '0000000a', title: ' ', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  assert.equal(untextedBlocking(own, own), null, 'its own finding, held by id and mint mark');
  assert.equal(untextedBlocking(own, null), 'R1-1');
  const adopted = structuredClone(own);
  adopted.passes.p.list[0].adopted = true;
  assert.equal(untextedBlocking(adopted, adopted), 'R1-1', 'one adopted from another machine`s copy, even once written locally');
});

test('an edit keeps only the plan block`s own lines: with no reasons and no engine line, a quota line is not kept, and a stage no copy names reads as a stage', (t) => {
  const { root, head } = checkout(t);
  const state = { ...emptyState(7, 'o/r'), revision: 3, quotaStops: [{ head, stage: 'independent', reviewer: 'codex-local', passes: [], at: ISO, chosen_at: ISO, choice: 'human', signoff: { at: ISO, by: 'Jane Private Person' } }] };
  const plan = { head, depth: 'none', reasons: [], flows: [], stages: [], engine: null };
  const earlier = summaryBody(state, plan, 'received', { reading: PRIVATE_READING, checker: checker(), root });
  assert.match(earlier, /Jane Private Person/u);
  const later = refreshSummary(earlier, { ...state, revision: 4 }, { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] });
  assert.doesNotMatch(later, /Jane Private Person|undefined/u);
  assert.match(later, /so the Human reviewed a stage instead, signed off \(an audit entry, not proof\)/u);
});

test('a machine fills its own override lines only into a copy of its own review', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-lineage-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const head = 'd'.repeat(40);
  writeLocalState(project, { ...emptyState(7, 'o/r'), rounds: [{ head, at: ISO }], overrides: ['Tester overruled the violated verdict on f/i at ddddddd: it holds'] });
  const copy = (rounds) => summaryBody({ ...emptyState(7, 'o/r'), revision: 9, rounds, overrides: ['round 2 ran the independent stage first'] }, null, 'x', OPEN);
  const same = readRecord(project, 7, [{ id: 1, body: copy([{ head, at: ISO }]), author_association: 'MEMBER' }], 'o/r').state;
  assert.equal(same.overrides.length, 2, 'the same first round: this machine`s line is filled');
  const other = readRecord(project, 7, [{ id: 1, body: copy([{ head: 'e'.repeat(40), at: ISO }]), author_association: 'MEMBER' }], 'o/r').state;
  assert.deepEqual(other.overrides, ['round 2 ran the independent stage first'], 'a restarted review gets none');
});


// ---- The finding index in the posted copy (S1b) ----

test('the posted copy with the finding index: no title in the index or in a refused id`s dropped note on any reading but PRIVATE, and no title of a closed entry on any', (t) => {
  const { root, head } = checkout(t);
  const state = sentinelRecord(head);
  recordFindings(state, 'agent:code-reviewer', { head, reviewer: 'code-reviewer', findings: 1, open: 1, verdicts: [], list: [{ title: `${S} refused`, body: `${S} body`, file: 'src/b.js', line: 5, severity: 'medium', state: 'open', disposition: 'fix_now', returned_id: `R9-9 ${S}` }] }, { mint: true, paths: gitPaths(root).at(head), listed: [] });
  const [refused] = state.passes['agent:code-reviewer'].list;
  assert.deepEqual(state.passes['agent:code-reviewer'].dropped, [`${refused.id}: its returned id is not an open finding its input listed, so it was read as no id`]);
  assert.deepEqual(Object.keys(state.index).sort(), ['R1-1', 'R1-2', 'R1-3', refused.id].sort(), 'every id has its entry');
  Object.assign(state.index['R1-1'], { state: 'not_reported', closed_in: { from: head, to: head } });
  assert.equal(state.index['R1-1'].title, `${S} title`, 'this machine keeps it');
  for (const [label, reading] of NOT_PRIVATE) {
    const post = reading === undefined ? {} : { reading, checker: checker(), root, names: [] };
    for (const [how, body] of writes(state, head, post)) {
      const record = stateFromComment(body, 7);
      assert.ok(!JSON.stringify(record).includes(S), `${label}, ${how}: S in the decoded record`);
      assert.ok(record.index[refused.id], `${label}, ${how}: the entry is posted by its id`);
      assert.ok(!('reviewer' in record.index[refused.id]), `${label}, ${how}: the recording reviewer stays local`);
    }
  }
  const { copy } = postedCopy(state, { reading: PRIVATE_READING, checker: { allows: () => true }, root, names: [] });
  assert.equal(copy.index['R1-1'].title, undefined, 'a closed entry holds no title on a private repository either');
  assert.equal(copy.index[refused.id].title, `${S} refused`, 'an open one does, there');
  assert.ok(!('reviewer' in copy.index[refused.id]));
  assert.ok(!JSON.stringify(copy.passes['agent:code-reviewer'].dropped).includes(S), 'the refused id`s note names it by its own id alone');
});

test('the twin match reads the index: an agent finding rated medium at an exec high finding`s place, and a medium report after the high id closed as fixed, post no file or line', (t) => {
  const { root, head } = checkout(t);
  const paths = gitPaths(root).at(head);
  const note = { head, passes: { 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false }, 'agent:code-reviewer': { stage: 'local', reviewer: 'code-reviewer', security: false } }, pairs: [] };
  const state = { ...emptyState(7, 'o/r'), revision: 2, floored: true, rounds: [{ head, at: ISO }], planNote: note, dispatched: { 'agent:code-reviewer': { head, files: null, stage: 'local', security: false } } };
  const [high] = recordFindings(state, 'engine:codex-local', { head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ title: 'Refund total unchecked', file: 'src/a.js', line: 10, severity: 'high' }] }, { mint: true, paths }).list;
  const agent = (line) => recordFindings(state, 'agent:code-reviewer', { head, reviewer: 'code-reviewer', findings: 1, open: 1, list: [{ title: `Other words ${line}`, file: 'src/a.js', line, severity: 'medium', likelihood: 'plausible', affects: 'users', state: 'open', disposition: 'fix_now' }] }, { mint: true, paths }).list[0];
  const post = { reading: { visibility: 'PUBLIC', inside: true }, checker: checker(), root, names: [] };
  const medium = agent(11);
  let posted = postedCopy(state, post).copy;
  assert.deepEqual([posted.passes['agent:code-reviewer'].list[0].file, posted.passes['agent:code-reviewer'].list[0].line, posted.passes['agent:code-reviewer'].list[0].security], [undefined, undefined, true], 'the itemized twin of the exec high finding');
  assert.deepEqual([posted.index[medium.id].file, posted.index[medium.id].security], [undefined, true]);
  // The high finding's id closes as fixed; nothing but its closed entry holds it.
  recordFindings(state, 'engine:codex-local', { head, reviewer: 'codex-local', findings: 0, open: 0, list: [] }, { mint: true, paths });
  delete state.passes['agent:code-reviewer'];
  Object.assign(state.index[high.id], { state: 'fixed', closed_in: { from: head, to: head } });
  delete state.index[medium.id];
  const after = agent(12);
  assert.notEqual(after.id, high.id);
  posted = postedCopy(state, post).copy;
  assert.deepEqual([posted.passes['agent:code-reviewer'].list[0].file, posted.passes['agent:code-reviewer'].list[0].line, posted.passes['agent:code-reviewer'].list[0].security], [undefined, undefined, true], 'the report after the id closed');
});

test('prunePasses deletes no index entry', () => {
  const slices = [{ key: 'apps/web', files: ['apps/web/a.ts'] }];
  const index = { 'R1-1': { id: 'R1-1', mint: '00000001', title: 't', state: 'open', pass: 'slice:codex-local:0123456789' } };
  const state = { ...emptyState(7, 'o/r'), index: JSON.parse(JSON.stringify(index)), passes: { 'slice:codex-local:0123456789': { head: 'h', files: ['gone.ts'], findings: 1, open: 1, list: [{ id: 'R1-1', mint: '00000001', title: 't' }] } } };
  prunePasses(state, slices);
  assert.deepEqual([Object.keys(state.passes), state.index], [[], index]);
});

test('the record with 200 itemized findings in one pass, each with a full body and an index entry, fits the comment or is held, on a private repository', () => {
  const next = rng(201);
  const head = 'c'.repeat(40);
  const list = Array.from({ length: 200 }, (_, i) => ({ id: `R1-${i + 1}`, mint: (i + 1).toString(16).padStart(8, '0'), file: `src/f${i % 7}.js`, line: 10 + i, title: prose(next, 8), body: prose(next, 300), severity: ['high', 'medium', 'low'][i % 3], likelihood: 'plausible', affects: 'users', state: 'open', disposition: 'fix_now' }));
  const state = { ...emptyState(7, 'o/r'), revision: 3, idCounter: 200, passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 200, open: 200, list } } };
  recordFindings(state, null, null);
  assert.equal(Object.keys(state.index).length, 200);
  const body = summaryBody(state, null, 'fix_required', { ...OPEN, publish: { summary: 'findings' } });
  assert.ok(body.length <= BODY_LIMIT, `${body.length} characters`);
  const record = stateFromComment(body, 7);
  if (record) assert.deepEqual([record.passes['engine:codex-local'].list.length, Object.keys(record.index).length], [200, 200]);
  else assert.equal(heldRevision(body), 3, 'held, as before');
});
