import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SEVERITY_BADGES, severityBadge } from '../plugins/aidrian/lib/review/findings.mjs';
import { attributionLine, leadingMarkers, markerLine } from '../plugins/aidrian/lib/review/markers.mjs';
import { emptyState, headerStatus, isSummary, refreshSummary, stateFromComment, summaryBody, summaryHeader } from '../plugins/aidrian/lib/review/state.mjs';

// The look of the engine's posts changed (severity badges, a status emoji, a Details block); its readers did not. A post
// already on a pull request, in the layout before, reads exactly as one in the new layout.

const OPEN = { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } };

test('a severity shows as its badge and word; an unknown word as a white circle and the word', () => {
  assert.deepEqual(SEVERITY_BADGES, { critical: '🔴 P0', high: '🟠 P1', medium: '🟡 P2', low: '🟢 P3' });
  assert.equal(severityBadge('high'), '🟠 P1 · high');
  assert.equal(severityBadge('critical'), '🔴 P0 · critical');
  assert.equal(severityBadge('unknown'), '⚪ unknown');
});

test('a finding post in the old layout and in the badge layout name the same findings', () => {
  const old = [markerLine('R1-1'), attributionLine('R1-1'), '**high** at `src/a.js:2`', '> **A title**', '> ', '> what is wrong'].join('\n');
  const badged = [markerLine('R1-1'), attributionLine('R1-1'), `**${severityBadge('high')}** · \`src/a.js:2\``, '> **A title**', '> ', '> what is wrong'].join('\n');
  assert.deepEqual(leadingMarkers(old), ['R1-1']);
  assert.deepEqual(leadingMarkers(badged), leadingMarkers(old));
});

test('a summary in the old layout and in the new one carry the same record, and refresh to the same text', () => {
  const state = { ...emptyState(7, 'o/r'), revision: 4, rounds: [{ head: 'abc1234def' }], waivers: [{ kind: 'merge', head: 'abc1234def', verdict: 'waive', judge: 'judge' }] };
  const plan = { head: 'abc1234def', depth: 'standard', reasons: [], engine: null, flows: [] };
  const fresh = summaryBody(state, plan, 'fix_required', OPEN);
  const lines = fresh.split('\n');
  assert.equal(lines[1], '### 🛠️ Review: fix_required', 'the header shows the status emoji');
  const open = lines.indexOf('<details><summary>Details</summary>');
  const close = lines.indexOf('</details>');
  assert.ok(open > 0 && close > open, 'the secondary sections fold into one Details block');
  assert.equal(lines[open + 1], '', 'a blank line after the summary, so GitHub renders the Markdown inside');
  assert.ok(lines.slice(open, close).some((line) => line.startsWith('**Merge guard waivers:**')), 'the waivers sit inside it');
  assert.ok(lines.slice(open, close).some((line) => line.startsWith('A citation shows')), 'the citation line too');
  assert.ok(lines.indexOf('Head `abc1234`, depth **standard**, round 1.') < open, 'the plan line stays above it');

  // The layout before: the plain header, and every section at the top level.
  const old = lines.filter((line, at) => at !== open && at !== close && !(at === open + 1) && !(at === close - 1))
    .map((line) => (line === '### 🛠️ Review: fix_required' ? '### Review: fix_required' : line)).join('\n');
  assert.ok(!old.includes('<details>') && old.includes('\n### Review: fix_required\n'));

  for (const body of [old, fresh]) assert.ok(isSummary(body));
  assert.deepEqual(stateFromComment(old, 7), stateFromComment(fresh, 7));
  assert.equal(refreshSummary(old, state, OPEN), refreshSummary(fresh, state, OPEN), 'either layout refreshes to the same text');
  assert.equal(refreshSummary(old, state, OPEN), fresh, 'the old layout refreshes into the new one, status and plan line kept');
});

test('a summary header names its status in either layout', () => {
  assert.equal(summaryHeader('received'), '### ✅ Review: received');
  assert.equal(summaryHeader('human_required'), '### ⏸️ Review: human_required');
  assert.equal(summaryHeader('timed_out'), '### ⚠️ Review: timed_out');
  assert.equal(summaryHeader('waiver refuse'), '### ℹ️ Review: waiver refuse');
  assert.equal(summaryHeader('constructor'), '### ℹ️ Review: constructor', 'a status read back from a body never names a built-in');
  for (const status of ['received', 'fix_required', 'waiver refuse']) {
    assert.equal(headerStatus(`### Review: ${status}`), status);
    assert.equal(headerStatus(summaryHeader(status)), status);
  }
  assert.equal(headerStatus('Head `abc1234`'), null);
});
