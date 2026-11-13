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
