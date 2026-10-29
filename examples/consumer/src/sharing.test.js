import assert from 'node:assert/strict';
import test from 'node:test';

import { canRead } from './sharing.js';

const note = { ownerId: 'ana', shareToken: 'link-1', deletedAt: null };

test('a note is private to its owner by default', () => {
  assert.equal(canRead(note, 'ana'), true);
  assert.equal(canRead(note, 'ben'), false);
  assert.equal(canRead({ ...note, ownerId: undefined }, undefined), false);
});

test('anyone with the share link can read the note', () => {
  assert.equal(canRead(note, 'ben', 'link-1'), true);
  assert.equal(canRead(note, undefined, 'link-1'), true);
  assert.equal(canRead(note, 'ben', 'link-2'), false);
});

test('revoking the link makes the note private again', () => {
  for (const shareToken of [null, undefined, '']) {
    const revoked = { ...note, shareToken };
    assert.equal(canRead(revoked, 'ben', 'link-1'), false);
    assert.equal(canRead(revoked, 'ben', shareToken), false, `caller token ${shareToken}`);
    assert.equal(canRead(revoked, 'ben'), false);
  }
});

test('a deleted note is never readable, even by its owner or a share link', () => {
  const deleted = { ...note, deletedAt: '2026-01-01T00:00:00Z' };
  assert.equal(canRead(deleted, 'ana'), false);
  assert.equal(canRead(deleted, 'ben', 'link-1'), false);
});
