import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatFindings, readManifests, summarizeFindings } from '../plugins/aidrian/lib/report-findings.mjs';

const finding = (specialist, status) => ({ specialist, status });

test('precision counts only resolved and dismissed findings, per specialist', () => {
  const summary = summarizeFindings([
    { file: 'pr-1.json', manifest: { findings: [finding('code-reviewer', 'resolved'), finding('code-reviewer', 'dismissed'), finding('code-reviewer', 'open')] } },
    { file: 'pr-2.json', manifest: { findings: [finding('code-reviewer, security-engineer', 'resolved'), finding('critic', 'follow_up')] } },
  ]);
  assert.equal(summary.pull_requests, 2);
  const by = Object.fromEntries(summary.specialists.map((row) => [row.specialist, row]));
  assert.deepEqual(by['code-reviewer'], { specialist: 'code-reviewer', findings: 4, resolved: 2, dismissed: 1, unsettled: 1, precision: 2 / 3 });
  assert.equal(by['security-engineer'].precision, 1);
  assert.equal(by.critic.precision, null);
  assert.equal(summary.specialists[0].specialist, 'code-reviewer');
});

test('a resolved status is never read as a wrong finding, and fixed is not yet settled', () => {
  const { specialists } = summarizeFindings([{ file: 'pr-3.json', manifest: { findings: [finding('critic', 'fixed'), finding('critic', 'disputed')] } }]);
  assert.deepEqual(specialists[0], { specialist: 'critic', findings: 2, resolved: 0, dismissed: 0, unsettled: 2, precision: null });
});

test('readManifests reads pr-<n>.json only, names an unreadable one, and filters by --since on modification time', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'findings-'));
  try {
    writeFileSync(path.join(dir, 'pr-1.json'), JSON.stringify({ findings: [finding('critic', 'resolved')] }));
    writeFileSync(path.join(dir, 'pr-2.json'), '{not json');
    writeFileSync(path.join(dir, 'notes.json'), '{}');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(path.join(dir, 'pr-1.json'), old, old);
    const all = readManifests(dir);
    assert.equal(all.length, 2);
    const summary = summarizeFindings(all);
    assert.equal(summary.pull_requests, 1);
    assert.equal(summary.unreadable.length, 1);
    assert.match(formatFindings(summary, { dir }), /critic: 1 findings, precision 100% of 1 settled \(1 resolved, 0 dismissed\), 0 unsettled/u);
    assert.equal(readManifests(dir, { sinceMs: Date.parse('2026-06-01T00:00:00Z') }).filter((entry) => !entry.error).length, 0);
    assert.deepEqual(readManifests(path.join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
