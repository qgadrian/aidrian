// A step's write keeps what another write of the record closed or mapped in the finding index (lib/review/state.mjs
// mergeIndex, docs/review.md#finding-ids, Two writers), as `pending` is merged, and what another command recorded
// while the step held the record (state.mjs writeState).

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { removedPosts } from '../plugins/aidrian/lib/review/delete.mjs';
import { recordHuman, recordVerdict } from '../plugins/aidrian/lib/review/extension.mjs';
import { freshId, parseFindings, recordFindings } from '../plugins/aidrian/lib/review/findings.mjs';
import { retryInstead } from '../plugins/aidrian/lib/review/run.mjs';
import { emptyState, mergeIndex, noteOutcome, takeRecorded } from '../plugins/aidrian/lib/review/state.mjs';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const entry = (id, over = {}) => ({ id, mint: 'abcd0123', title: `finding ${id}`, file: 'src/a.js', line: 2, severity: 'medium', state: 'open', ...over });
const record = (...entries) => ({ ...emptyState(7, 'o/r'), index: Object.fromEntries(entries.map((each) => [each.id, each])) });

test('mergeIndex: a closed id another write made stays closed, with its range; an open one it reads never reopens one', () => {
  const ours = record(entry('R1-1'), entry('R1-2', { state: 'accepted' }), entry('R1-3', { state: 'fixed', closed_in: { from: FROM, to: TO } }));
  const theirs = record(entry('R1-1', { state: 'not_reported', closed_in: { from: FROM, to: TO } }), entry('R1-2', { state: 'fixed' }), entry('R1-3'));
  assert.deepEqual(mergeIndex(ours, theirs), ['R1-1', 'R1-2']);
  assert.deepEqual([ours.index['R1-1'].state, ours.index['R1-1'].closed_in], ['not_reported', { from: FROM, to: TO }]);
  assert.equal(ours.index['R1-2'].state, 'fixed');
  assert.equal(ours.index['R1-3'].state, 'fixed', 'a stale open copy never reopens a closed id');
});

test('mergeIndex: a post another write mapped is kept where this write maps none, unless this step deleted it or found it gone', () => {
  const ours = record(entry('R1-1'), entry('R1-2', { thread: { reviewId: 900, commentId: 61, replied: true } }), entry('R1-3'), entry('R1-4'));
  const theirs = record(
    entry('R1-1', { thread: { reviewId: 901, commentId: 62, replied: true, replyId: 63, resolved: true } }),
    entry('R1-2', { thread: { reviewId: 902, commentId: 64, fallbackId: 70 } }),
    entry('R1-3', { thread: { commentId: 65 } }),
    entry('R1-4', { thread: { fallbackId: 71 } }),
  );
  const removed = removedPosts({ deleted: [{ finding: 'R1-3', kind: 'review_comment', id: 65 }], gone: [{ finding: 'R1-4', kind: 'comment', id: 71 }] });
  assert.deepEqual(mergeIndex(ours, theirs, removed), ['R1-1', 'R1-2']);
  assert.deepEqual(ours.index['R1-1'].thread, { reviewId: 901, commentId: 62 }, 'the post alone: a reply`s marks are read back from the thread');
  assert.deepEqual(ours.index['R1-2'].thread, { reviewId: 900, commentId: 61, replied: true, fallbackId: 70 }, 'this write`s own post wins');
  assert.equal(ours.index['R1-3'].thread, undefined, 'a comment this step deleted is never mapped again');
  assert.equal(ours.index['R1-4'].thread, undefined, 'nor one it found gone');
});

test('mergeIndex: two findings under one id, by their mint marks, and an id only one write holds, take nothing', () => {
  const ours = record(entry('R1-1'), entry('R1-2'));
  const theirs = record(entry('R1-1', { mint: '99999999', state: 'fixed', thread: { commentId: 61 } }), entry('R1-9', { thread: { commentId: 62 } }));
  assert.deepEqual(mergeIndex(ours, theirs), []);
  assert.deepEqual([ours.index['R1-1'].state, ours.index['R1-1'].thread, ours.index['R1-9']], ['open', undefined, undefined]);
  assert.deepEqual(mergeIndex(ours, null), []);
  assert.deepEqual(mergeIndex(emptyState(7, 'o/r'), theirs), []);
});

test('mergeIndex: the other copy`s security mark survives on the same finding, and the summary`s row then withholds its title', async () => {
  const { residualRows, textChecker } = await import('../plugins/aidrian/lib/review/publish.mjs');
  const { homedir } = await import('node:os');
  const checker = textChecker({ context: { home: homedir(), state: '', roots: [], terms: { hosts: [], accounts: [], variables: [] }, env: {} }, words: [] });
  const post = { reading: { visibility: 'PUBLIC', inside: true }, checker };
  const ours = { ...record(entry('R1-1', { title: 'a refund left unchecked', severity: 'low', pass: 'p' })), planNote: { passes: { p: { stage: 'local', reviewer: 'codex-local', security: false } } } };
  const row = [{ pass: 'p', id: 'R1-1', title: 'a refund left unchecked', file: 'src/a.js', line: 2, severity: 'low' }];
  assert.equal(residualRows(row, ours, post).rows[0].title, 'a refund left unchecked', 'a finding that is no security finding shows its title');
  assert.deepEqual(mergeIndex(ours, record(entry('R1-1', { title: undefined, security: true }))), ['R1-1'], 'the mark alone counts as a change');
  assert.equal(ours.index['R1-1'].security, true);
  assert.deepEqual(residualRows(row, ours, post).rows.map((each) => [each.id, each.title ?? null, each.file ?? null]), [['R1-1', null, null]], 'named by id alone now');
  assert.deepEqual(mergeIndex(ours, record(entry('R1-1', { security: false }))), [], 'the mark only widens');
  assert.equal(ours.index['R1-1'].security, true);
});

test('mergeIndex from a copy that is not private: the marks and posts of this machine`s own findings, by mint mark, and never a closed state', () => {
  const ours = record(entry('R1-1'), entry('R1-2', { mint: undefined }));
  const theirs = record(
    entry('R1-1', { state: 'fixed', closed_in: { from: FROM, to: TO }, security: true, thread: { reviewId: 900, commentId: 61 } }),
    entry('R1-2', { mint: undefined, thread: { commentId: 62 } }),
  );
  assert.deepEqual(mergeIndex(ours, theirs, new Set(), { closed: false, strict: true }), ['R1-1']);
  assert.deepEqual([ours.index['R1-1'].state, ours.index['R1-1'].security, ours.index['R1-1'].thread], ['open', true, { reviewId: 900, commentId: 61 }]);
  assert.equal(ours.index['R1-2'].thread, undefined, 'a finding with no mint mark on both is not known to be the same one');
});

test('mergeIndex: the replies another write set aside when the finding opened again join this write`s, less a removed one and its own reply', () => {
  const ours = record(entry('R1-1', { thread: { reviewId: 900, commentId: 61, earlier: [70] } }), entry('R1-2', { thread: { commentId: 62, replyId: 80 } }));
  const theirs = record(entry('R1-1', { thread: { reviewId: 900, commentId: 61, earlier: [70, 71, 72, 0] } }), entry('R1-2', { thread: { commentId: 62, earlier: [80] } }));
  const removed = removedPosts({ deleted: [{ finding: 'R1-1', kind: 'review_comment', id: 72 }] });
  assert.deepEqual(mergeIndex(ours, theirs, removed), ['R1-1']);
  assert.deepEqual(ours.index['R1-1'].thread.earlier, [70, 71], 'the union, less a deleted reply and an id that names no post');
  assert.deepEqual(ours.index['R1-2'].thread, { commentId: 62, replyId: 80 }, 'this write`s own current reply stays its own');
  // From a copy that is not private, only for a finding both copies hold by its mint mark.
  const unknown = record(entry('R1-1', { mint: undefined, thread: { commentId: 61 } }));
  assert.deepEqual(mergeIndex(unknown, record(entry('R1-1', { mint: undefined, thread: { commentId: 61, earlier: [71] } })), new Set(), { closed: false, strict: true }), []);
  assert.equal(unknown.index['R1-1'].thread.earlier, undefined);
  const known = record(entry('R1-1', { thread: { commentId: 61 } }));
  assert.deepEqual(mergeIndex(known, record(entry('R1-1', { thread: { commentId: 61, earlier: [71] } })), new Set(), { closed: false, strict: true }), ['R1-1']);
  assert.deepEqual(known.index['R1-1'].thread.earlier, [71]);
});

// A review step holds the record it read for minutes, as while a visual capture runs, and another command records into
// the same record meanwhile. The step's write takes in what that command recorded since the read (state.mjs writeState
// and takeRecorded, docs/review.md, A command while a step runs), so nothing recorded is lost. Each writer's change is
// made by the function the command records with, on the copy the step did not read.
const HEAD = 'c'.repeat(40);
const PASS = 'agent:code-reviewer';
const AT = '2026-11-25T10:00:00.000Z';
const LATER = '2026-11-25T10:05:00.000Z';
const finding = (title) => ({ title, state: 'open', severity: 'high', likelihood: 'plausible', affects: 'internal', cost: 'bounded' });

// The record a review step on HEAD read: its round open, the pass dispatched, and a check at the cap waiting for its
// judge. `step` is the step's copy; `wrote(change)` is the record on disk once another command made `change` and wrote,
// now.
function stepping() {
  const read = {
    ...emptyState(7, 'o/r'), revision: 3, updatedAt: AT, floored: true, rounds: [{ head: HEAD, at: AT }], dispatched: { [PASS]: { stage: 'local' } },
    extensions: [{ source: 'plan', round: 2, head: HEAD, at: AT, mode: 'ask', status: 'judging', by: null, reasons: [] }],
  };
  const wrote = (change) => {
    const disk = structuredClone(read);
    change(disk);
    recordFindings(disk, null, null);
    return Object.assign(disk, { revision: read.revision + 1, updatedAt: new Date().toISOString() });
  };
  return { step: structuredClone(read), wrote };
}

// `aidrian pr attest --findings-file`: the findings read one by one, and the result recorded, with ids minted.
const attest = (list) => (state) => {
  const { findings, fixed, accepted, list: items } = parseFindings(JSON.stringify(list), [], { round: 1 });
  recordFindings(state, PASS, { head: HEAD, reviewer: 'code-reviewer', files: null, findings, open: findings - fixed - accepted, verdicts: [], list: items, itemized: true }, { mint: true, stage: 'local' });
};

test('an attest that lands while a review step runs is in the record the step saves, with its findings', () => {
  const { step, wrote } = stepping();
  takeRecorded(step, wrote(attest([finding('One'), finding('Two')])));
  const pass = step.passes[PASS];
  assert.deepEqual([pass?.head, pass?.findings, pass?.open], [HEAD, 2, 2], 'the pass is on the head, so the next round does not dispatch it again');
  const ids = pass.list.map((each) => each.id);
  assert.deepEqual(ids, ['R1-1', 'R1-2']);
  assert.deepEqual(ids.map((id) => step.index?.[id]?.state), ['open', 'open'], 'its findings, open in the index');
  assert.deepEqual([step.idCounter, step.revision], [2, 4], 'no id is minted twice, and the write is past the other`s');
});

test('a sign-off that lands while a review step runs is in the record the step saves', () => {
  const { step, wrote } = stepping();
  takeRecorded(step, wrote((state) => (state.signoffs.checkout = { head: HEAD, by: 'the Human', at: LATER })));
  assert.deepEqual(step.signoffs.checkout, { head: HEAD, by: 'the Human', at: LATER });
});

test('an extend that lands while a review step runs is in the record the step saves', () => {
  const { step, wrote } = stepping();
  takeRecorded(step, wrote((state) => recordVerdict(state, { verdict: 'extend', reason: 'the findings converge', current: HEAD, at: LATER })));
  const [check] = step.extensions;
  assert.deepEqual([step.extensions.length, check.status, check.judge?.verdict], [1, 'asking', 'extend'], 'the judge`s verdict, not the step`s stale copy of the waiting check');
  // A step that changed the check too, as a catch-up retiring it does, takes the judge's word whole, and says so.
  const again = stepping();
  Object.assign(again.step.extensions[0], { status: 'stopped', by: 'catch_up', decided_at: '2026-11-25T10:09:00.000Z' });
  assert.deepEqual(takeRecorded(again.step, again.wrote((state) => recordVerdict(state, { verdict: 'extend', reason: 'r', current: HEAD, at: LATER }))), ['extensions']);
  assert.equal(again.step.extensions[0].status, 'asking');
});

test('a write with no other writer since its read takes nothing: a pass it dropped stays dropped', () => {
  const { step, wrote } = stepping();
  const disk = wrote(attest([]));
  // The step read the record after the attest, then dropped the pass.
  const own = structuredClone(disk);
  delete own.passes[PASS];
  takeRecorded(own, disk);
  assert.equal(own.passes[PASS], undefined);
  // Its own write, the review step's running mark, raised the revision on disk alone: still its own.
  const marked = structuredClone(disk);
  marked.revision -= 1;
  delete marked.passes[PASS];
  takeRecorded(marked, disk);
  assert.deepEqual([marked.passes[PASS], marked.revision], [undefined, disk.revision - 1]);
  // A pass in the record the step read, which the step dropped, is not taken back from a later write either.
  const read = stepping();
  const before = read.wrote(attest([]));
  const dropping = structuredClone(before);
  delete dropping.passes[PASS];
  takeRecorded(dropping, { ...before, revision: before.revision + 1, updatedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(dropping.passes[PASS], undefined);
  assert.equal(step.passes[PASS], undefined, 'and a copy no write followed holds what it held');
});

test('a pass both writers hold: the one recorded last counts, and an open finding stays in the index', () => {
  // The step records its own result after the attest: the step's counts.
  const first = stepping();
  const attested = first.wrote(attest([finding('One')]));
  recordFindings(first.step, PASS, { head: HEAD, reviewer: 'code-reviewer', findings: 0, open: 0, list: [] });
  first.step.passes[PASS].at = '2026-11-25T10:09:00.000Z';
  attested.passes[PASS].at = LATER;
  takeRecorded(first.step, attested);
  assert.equal(first.step.passes[PASS].open, 0);
  assert.equal(first.step.index?.['R1-1']?.state, 'open', 'the attest`s open finding is never dropped by the merge');
  // The attest records after the step's result: the attest's counts.
  const second = stepping();
  recordFindings(second.step, PASS, { head: HEAD, reviewer: 'code-reviewer', findings: 0, open: 0, list: [] });
  second.step.passes[PASS].at = '2026-11-25T10:01:00.000Z';
  const later = second.wrote(attest([finding('One')]));
  later.passes[PASS].at = LATER;
  takeRecorded(second.step, later);
  assert.equal(second.step.passes[PASS].open, 1);
});

// The local record a write's state was read from, as the readers note it (state.mjs noteRead): its revision, write time,
// first round, and extension checks.
const snapshot = (record) => ({ revision: record.revision, updatedAt: record.updatedAt, rounds: record.rounds.slice(0, 1), extensions: structuredClone(record.extensions ?? []) });

test('a write during the first round: a record read with no round yet takes in what another command recorded', () => {
  const { step, wrote } = stepping();
  const read = { ...structuredClone(step), rounds: [] };
  const opened = structuredClone(read);
  // The step read the record before its first round, then opened it.
  opened.rounds = [{ head: HEAD, at: LATER }];
  const disk = Object.assign(wrote(attest([finding('One')])), { rounds: [] });
  assert.deepEqual(takeRecorded(structuredClone(opened), disk), [], 'by the first round alone, the two are not one review');
  assert.deepEqual(takeRecorded(opened, disk, { read: snapshot(read) }), [PASS], 'by the read, they are');
  assert.equal(opened.passes[PASS].open, 1);
  // A step that started another review than the one it read takes nothing of the old one.
  const restart = stepping();
  const restarted = structuredClone(restart.step);
  restarted.rounds = [{ head: 'd'.repeat(40), at: LATER }];
  assert.deepEqual(takeRecorded(restarted, restart.wrote(attest([finding('One')])), { read: snapshot(restart.step) }), []);
  assert.equal(restarted.passes[PASS], undefined);
});

test('a write is another command`s by the local record read, not by the revision a posted copy gave the state', () => {
  const { step, wrote } = stepping();
  const local = snapshot(step);
  // The state is the pull request's posted copy, at a higher revision than this machine's file.
  const adopted = Object.assign(structuredClone(step), { revision: 9, updatedAt: '2026-11-25T10:02:00.000Z' });
  const disk = wrote(attest([finding('One')]));
  assert.equal(disk.revision, 4, 'the attest built on the file, past it and below the copy');
  assert.deepEqual(takeRecorded(structuredClone(adopted), disk), [], 'by revision alone, the copy is newer and the attest lost');
  assert.deepEqual(takeRecorded(adopted, disk, { read: local }), [PASS]);
  assert.equal(adopted.revision, 9, 'the higher revision stays the floor of the next write');
  // The file as read, or as this state last wrote it, with its running mark's revision lowered after: its own.
  const own = Object.assign(structuredClone(disk), { revision: disk.revision - 1 });
  delete own.passes[PASS];
  assert.deepEqual(takeRecorded(own, disk, { read: snapshot(disk) }), []);
  assert.equal(own.passes[PASS], undefined);
});

test('a finding this write moved to a fresh id while another command recorded it under the old id holds both ids, open: it fails closed', () => {
  const { step } = stepping();
  attest([finding('One')])(step);
  const read = Object.assign(structuredClone(step), { updatedAt: '2026-11-25T10:01:00.000Z' });
  read.passes[PASS].at = '2026-11-25T10:00:30.000Z';
  const ours = structuredClone(read);
  // This write moved R1-1 to a fresh id, as when a comment already carries its marker.
  const fresh = freshId(ours, 'R1-1');
  assert.equal(fresh, 'R1-2');
  // Another command recorded the pass again meanwhile, its finding still under R1-1: the pass is taken as written.
  const disk = structuredClone(read);
  attest([finding('One')])(disk);
  Object.assign(disk, { revision: read.revision + 1, updatedAt: new Date().toISOString() });
  assert.deepEqual(takeRecorded(ours, disk, { read: snapshot(read) }), [PASS]);
  recordFindings(ours, null, null);
  assert.deepEqual(ours.passes[PASS].list.map((each) => each.id), ['R1-1']);
  assert.deepEqual([ours.index['R1-1']?.state, ours.index[fresh]?.state], ['open', 'open'], 'one finding under two ids, both open: never fewer');
});

test('a step outcome decided without a pass recorded meanwhile is the retry, which answers no owed review', () => {
  const result = { status: 'received', pr: 7, repo: 'o/r', head: HEAD, round: 1, engine: { name: 'codex' }, open: [{ pass: PASS }], dispatch: [] };
  assert.equal(retryInstead(result, [PASS]), result);
  assert.deepEqual(Object.keys(result).sort(), ['engine', 'head', 'pr', 'reason', 'recorded_meanwhile', 'repo', 'retry_recommended', 'round', 'status']);
  assert.deepEqual([result.status, result.retry_recommended, result.recorded_meanwhile], ['incomplete', true, [PASS]]);
  const state = { ...emptyState(7, 'o/r'), pending: [{ kind: 'review', head: HEAD, at: AT, by: 't', id: 'x' }] };
  noteOutcome(state, result);
  assert.deepEqual([state.outcome.status, state.pending[0].answered], ['incomplete', undefined]);
});

test('the write`s decide sees exactly what its merge took, after the merge and before anything else', () => {
  const { step, wrote } = stepping();
  const disk = wrote(attest([finding('One')]));
  disk.pending = [{ kind: 'review', head: HEAD, at: AT, by: 't', id: 'owed' }];
  let seen = null;
  const taken = takeRecorded(step, disk, { read: snapshot(step), decide: (ids) => (seen = { ids, open: step.passes[PASS]?.open, owed: step.pending.map((each) => each.id) }) });
  assert.deepEqual(seen, { ids: taken, open: 1, owed: ['owed'] });
  assert.deepEqual(taken, [PASS]);
  // A sign-off alone takes no pass, and the file as read takes nothing: decide runs with none.
  const signed = stepping();
  const calls = [];
  takeRecorded(signed.step, signed.wrote((state) => (state.signoffs.checkout = { head: HEAD, by: 'the Human', at: LATER })), { read: snapshot(signed.step), decide: (ids) => calls.push(ids) });
  takeRecorded(signed.step, structuredClone(signed.step), { read: snapshot(signed.step), decide: (ids) => calls.push(ids) });
  assert.deepEqual(calls, [[], []]);
  assert.equal(signed.step.signoffs.checkout.by, 'the Human');
  // The step's save turns its outcome into the retry from that same list.
  const result = { status: 'received', pr: 7, repo: 'o/r', head: HEAD };
  if (taken.length) retryInstead(result, taken);
  assert.deepEqual([result.status, result.recorded_meanwhile], ['incomplete', [PASS]]);
});

test('extension checks another command changed while the step ran are kept whole, and the step`s outcome is the retry', () => {
  const NEXT = 'e'.repeat(40);
  // The step read a check waiting for the Human, then read it again on a new head (extension.mjs revalidate).
  const asking = () => {
    const s = stepping();
    s.step.extensions[0].status = 'asking';
    return { ...s, read: snapshot(s.step), move: () => Object.assign(s.step.extensions[0], { head: NEXT }) };
  };
  const decline = (state) => {
    state.extensions[0].status = 'asking';
    recordHuman(state, { answer: 'deny', by: 'the Human', current: HEAD, at: LATER });
  };
  const save = ({ step, read }, disk) => {
    const result = { status: 'extension_ask', pr: 7, repo: 'o/r', head: NEXT };
    const taken = takeRecorded(step, disk, { read, decide: (ids) => (ids.length && retryInstead(result, ids), noteOutcome(step, result)) });
    return { taken, result };
  };
  // The Human declined before the step moved the check, and after it: either way the decline is kept.
  for (const order of ['decline first', 'move first']) {
    const s = asking();
    let disk;
    if (order === 'decline first') (disk = s.wrote(decline), s.move());
    else (s.move(), disk = s.wrote(decline));
    const { taken, result } = save(s, disk);
    assert.deepEqual(taken, ['extensions'], order);
    assert.deepEqual(s.step.extensions.map((each) => [each.status, each.head, each.human?.answer]), [['denied', HEAD, 'deny']], `${order}: the Human's decline, whole`);
    assert.deepEqual([result.status, result.retry_recommended, s.step.outcome.status], ['incomplete', true, 'incomplete'], `${order}: the retry`);
  }
  // A file whose checks are the ones the step read keeps the step's own move, and its outcome.
  const s = asking();
  s.move();
  const { taken, result } = save(s, s.wrote((state) => (state.extensions[0].status = 'asking', state.signoffs.checkout = { head: HEAD, by: 'the Human', at: LATER })));
  assert.deepEqual([taken, s.step.extensions[0].head, result.status], [[], NEXT, 'extension_ask']);
});
