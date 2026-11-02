import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningOut } from './index.js';

test('lists the items that expire within the window', () => {
  const items = [
    { name: 'milk', expires: '2026-01-03' },
    { name: 'rice', expires: '2027-06-01' },
  ];
  assert.deepEqual(runningOut(items, 7, new Date('2026-01-01')), ['milk']);
});
