// A step's write keeps what another write of the record closed or mapped in the finding index (lib/review/state.mjs
// mergeIndex, docs/review.md#finding-ids, Two writers), as `pending` is merged.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { removedPosts } from '../plugins/aidrian/lib/review/delete.mjs';
import { emptyState, mergeIndex } from '../plugins/aidrian/lib/review/state.mjs';

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
