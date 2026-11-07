// `aidrian report findings`: how often each review specialist was right, from the review manifests the pr-review skill
// writes, `<state>/reviews/pr-<n>.json` (skills/pr-review/references/manifest.md). Only two statuses are settled
// outcomes: `resolved`, a fix a later round confirmed, and `dismissed`, a finding the user judged wrong. Precision is
// resolved / (resolved + dismissed); every other status counts as unsettled. A finding two agents raised counts for each.
// docs/dispatch-log.md#findings describes the view. Read-only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MANIFEST = /^pr-\d+\.json$/u;

// The manifests in `dir` modified at or after `sinceMs` (null: all), as { file, manifest } or { file, error }.
export function readManifests(dir, { sinceMs = null } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => MANIFEST.test(name)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (sinceMs !== null && statSync(file).mtimeMs < sinceMs) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(manifest?.findings)) throw new Error('no findings list');
      out.push({ file, manifest });
    } catch (error) {
      out.push({ file, error: error.message });
    }
  }
  return out;
}

// { pull_requests, unreadable, specialists: [{ specialist, findings, resolved, dismissed, unsettled, precision }] },
// most settled first. precision is null while a specialist has no settled finding.
export function summarizeFindings(manifests) {
  const by = new Map();
  let pullRequests = 0;
  const unreadable = [];
  for (const entry of manifests) {
    if (entry.error) {
      unreadable.push({ file: entry.file, error: entry.error });
      continue;
    }
    pullRequests += 1;
    for (const finding of entry.manifest.findings) {
      const names = String(finding?.specialist ?? 'unknown').split(',').map((name) => name.trim()).filter(Boolean);
      for (const specialist of names.length ? names : ['unknown']) {
        const row = by.get(specialist) ?? { specialist, findings: 0, resolved: 0, dismissed: 0, unsettled: 0 };
        row.findings += 1;
        if (finding.status === 'resolved') row.resolved += 1;
        else if (finding.status === 'dismissed') row.dismissed += 1;
        else row.unsettled += 1;
        by.set(specialist, row);
      }
    }
  }
  const specialists = [...by.values()]
    .map((row) => {
      const settled = row.resolved + row.dismissed;
      return { ...row, precision: settled ? row.resolved / settled : null };
    })
    .sort((a, b) => b.resolved + b.dismissed - (a.resolved + a.dismissed) || a.specialist.localeCompare(b.specialist));
  return { pull_requests: pullRequests, unreadable, specialists };
}

const percent = (value) => `${Math.round(value * 100)}%`;

export function formatFindings(summary, { dir, since = null }) {
  const lines = [`Review manifests ${dir}${since ? `, changed since ${since}` : ''}: ${summary.pull_requests} pull requests`];
  if (!summary.specialists.length) lines.push('No findings yet.');
  for (const row of summary.specialists) {
    const settled = row.resolved + row.dismissed;
    const precision = row.precision === null ? 'precision unknown, nothing settled' : `precision ${percent(row.precision)} of ${settled} settled`;
    lines.push(`${row.specialist}: ${row.findings} findings, ${precision} (${row.resolved} resolved, ${row.dismissed} dismissed), ${row.unsettled} unsettled`);
  }
  for (const bad of summary.unreadable) lines.push(`Unreadable: ${bad.file}: ${bad.error}`);
  return lines.join('\n');
}
