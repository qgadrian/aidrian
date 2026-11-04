import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { splitPasses } from '../plugins/aidrian/lib/review/split.mjs';
import {
  emptyState, HELD_LINE, heldMessage, heldRevision, prunePasses, publishState, readRecord, refreshSummary, stateFromComment, summaryBody, writeLocalState,
} from '../plugins/aidrian/lib/review/state.mjs';

const LIMIT = 65_536;
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
  const body = summaryBody(state, null, 'fix_required');
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
  const error = publishState({ ...state, revision: 4 }, { comments: () => comments, post: () => assert.fail('the comment is edited'), edit: (id, body) => (comments[id - 1].body = body) }, 'x');
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
  const held = summaryBody(big, null, 'fix_required');
  assert.ok(held.length < LIMIT);
  assert.equal(records(held), 1);
  assert.equal(heldRevision(held), 9);
  assert.equal(stateFromComment(held, 7), null);
  assert.ok(held.includes(HELD_LINE));
  assert.match(held, /\| engine:codex-local \| `h` \| 1 \| 1 \|/u, 'the table a person reads is still there');

  const comments = [{ id: 1, body: held, author_association: 'MEMBER' }];
  const io = { comments: () => comments, post: () => assert.fail('the comment is edited'), edit: (id, body) => (comments[id - 1].body = body) };
  assert.equal(publishState({ ...big, revision: 10 }, io, 'x'), null);
  assert.equal(heldRevision(comments[0].body), 10, 'still too large: held at the new revision');
  assert.equal(records(comments[0].body), 1);
  assert.equal(comments[0].body.split(HELD_LINE).length, 2, 'the held line once');

  const small = { ...big, revision: 11, passes: { 'engine:codex-local': { head: 'h', files: null, findings: 0, open: 0 } } };
  assert.equal(publishState(small, io, 'x'), null);
  assert.equal(heldRevision(comments[0].body), null);
  assert.ok(!comments[0].body.includes(HELD_LINE), 'the held line goes with the held marker');
  assert.equal(records(comments[0].body), 1);
  assert.equal(stateFromComment(comments[0].body, 7).revision, 11);
  assert.equal(refreshSummary(comments[0].body, small), comments[0].body, 'a rewrite with the same record changes nothing');
});

test('readRecord: a held comment stops a machine whose record is missing or older, and the writer goes on', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(dir);
  const comment = (revision) => [{ id: 1, body: ['<!-- aidrian-review-summary -->', '### Review: x', HELD_LINE, `<!-- aidrian-review-state-held:${revision} -->`].join('\n'), author_association: 'MEMBER' }];

  assert.deepEqual(readRecord(project, 7, comment(3), 'o/r'), { held: 3 }, 'no local record');
  const local = { ...emptyState(7, 'o/r'), revision: 1 };
  writeLocalState(project, local);
  assert.deepEqual(readRecord(project, 7, comment(3), 'o/r'), { held: 3 }, 'an older local record');
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
    const body = summaryBody(state, plan, 'incomplete');
    assert.ok(body.length < LIMIT, `${body.length} characters`);
    assert.equal(records(body), 1);
    assert.ok(body.includes(`(${reason.slice(0, 300)})`), 'the comment names the clipped reason');
    assert.ok(!body.includes(reason.slice(0, 301)));
  }
  const many = { ...plan, reasons: Array.from({ length: 1000 }, (_, i) => `plan command: reason ${i} ${noise(next, 400)}`) };
  const listed = summaryBody({ ...emptyState(7, 'o/r'), revision: 3 }, many, 'x');
  assert.ok(listed.length < LIMIT, `${listed.length} characters with 1,000 plan reasons`);
  assert.match(listed, /- plan command: reason 24 /u);
  assert.doesNotMatch(listed, /- plan command: reason 25 /u);
  assert.match(listed, /- and 975 more/u);
  const compressible = summaryBody({ ...emptyState(7, 'o/r'), visual: { head: 'a', status: 'failed', reason: 'x'.repeat(100_000), mode: 'none' } }, null, 'x');
  assert.ok(stateFromComment(compressible, 7), 'a reason that compresses keeps the record');
  const incompressible = summaryBody({ ...emptyState(7, 'o/r'), visual: { head: 'a', status: 'failed', reason: noise(next, 100_000), mode: 'none' } }, null, 'x');
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
