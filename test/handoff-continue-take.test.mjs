// The session start's wait for a clear's ready marker (lib/handoff-continue.mjs takeCleared), in this process: it
// waits for a promotion that comes late, its length is a count of looks that no clock change stretches, and a marker
// too large to read stops nothing.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { CLEAR_STEP, CLEAR_WAIT, takeCleared } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { arm, MARKER_CAP, openStore, promote, readArmed } from '../plugins/aidrian/lib/handoff-markers.mjs';

const HOUR = 60 * 60 * 1000;

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-continue-take-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handoffs = path.join(root, 'state', 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  const store = openStore(path.join(root, 'state'), { checkouts: [path.join(root, 'project')], maxChain: 3 });
  const marker = { route: 'clear', session: 'old', brief: path.join(handoffs, '2026-11-15-widget.md'), slug: 'widget', chain: 0, sha256: 'a'.repeat(64) };
  return { store, marker };
}

// Resolves with what `promise` gives, or rejects after `ms`, so a wait that never ends fails instead of hanging.
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

test('a promotion that comes 150 ms after the start began to look is taken', async (t) => {
  const { store, marker } = setup(t);
  arm(store, marker);
  setTimeout(() => promote(store, 'old', { hostPid: process.pid }), 150);
  const at = performance.now();
  const taken = await takeCleared(store, process.pid);
  assert.equal(taken?.slug, 'widget');
  assert.ok(performance.now() - at >= 100, 'it waited');
});

test('a clock set back while it waits does not stretch the wait past CLEAR_WAIT and one step', async (t) => {
  const { store, marker } = setup(t);
  // Armed hours ago, so a clock that runs back for a second still reads the marker as armed.
  arm(store, marker, { now: Date.now() - 2 * HOUR });
  utimesSync(path.join(store.dir, 'armed-old.json'), new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));
  let clock = Date.now();
  t.mock.method(Date, 'now', () => (clock -= 20));
  const at = performance.now();
  assert.equal(await within(takeCleared(store, process.pid), 3000), null);
  assert.ok(performance.now() - at < CLEAR_WAIT + CLEAR_STEP + 400, `took ${performance.now() - at} ms`);
});

test('an armed marker larger than the cap is never read, so a start does not wait on it', async (t) => {
  const { store, marker } = setup(t);
  arm(store, marker);
  const file = path.join(store.dir, 'armed-old.json');
  writeFileSync(file, JSON.stringify({ ...marker, armed_at: Date.now(), pad: 'x'.repeat(MARKER_CAP) }));
  assert.equal(readArmed(store, 'old'), null);
  const at = performance.now();
  assert.equal(await takeCleared(store, process.pid), null);
  assert.ok(performance.now() - at < CLEAR_STEP, `took ${performance.now() - at} ms`);
});
