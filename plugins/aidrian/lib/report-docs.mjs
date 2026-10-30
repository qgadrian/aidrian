// `aidrian report docs`: per knowledge doc, how often agents and main conversations read it and how many bytes that
// cost, from the dispatch log, beside the project's `always` docs and the indexed docs nobody read.
// docs/dispatch-log.md#doc-reads describes the view.

import path from 'node:path';

import { docsRead } from './dispatch-log.mjs';
import { fileBytes } from './fs.mjs';
import { latestRows as latest } from './jsonl.mjs';
import { checkBudgets, indexRows, loadKnowledge } from './knowledge.mjs';

// `aidrian report docs` lists the docs with the most bytes read, and the docs with the most readers.
const TOP_DOCS = 10;
const SHARED_DOCS = 5;
// ...and at most this many of the indexed docs nobody read.
const NEVER_READ = 20;

// Per knowledge doc read since `sinceMs`: `reads`, `bytes` (its size as last logged), `read_bytes` (reads × bytes), and
// `readers`, the agent types that read it plus `main` for a main conversation. Most bytes read first. A stop row counts
// for its subagent and a session row for its main conversation, so no read counts twice. `totals.rows` counts the rows
// that recorded doc reads. With `indexed`, the index's docs as { path, bytes }, `never_read` lists those nobody read.
export function summarizeDocs(rows, { sinceMs = 0, indexed } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs);
  const counted = new Set([...latest(fresh, 'stop', 'agent_id'), ...latest(fresh, 'session', 'session_id')]);
  const byPath = new Map();
  let recorded = 0;
  for (const row of fresh.filter((each) => counted.has(each))) {
    if (Array.isArray(row.docs_read)) recorded += 1;
    const reader = row.event === 'session' ? 'main' : (row.agent_type ?? 'general-purpose');
    for (const { path: doc, bytes } of docsRead(row)) {
      const entry = byPath.get(doc) ?? { path: doc, reads: 0, bytes: null, readers: new Set() };
      entry.reads += 1;
      if (Number.isFinite(bytes)) entry.bytes = bytes;
      entry.readers.add(reader);
      byPath.set(doc, entry);
    }
  }
  const docs = [...byPath.values()]
    .map(({ path: doc, reads, bytes, readers }) => ({ path: doc, reads, bytes, read_bytes: bytes === null ? null : reads * bytes, readers: [...readers].sort() }))
    .sort((a, b) => (b.read_bytes ?? -1) - (a.read_bytes ?? -1) || b.reads - a.reads || a.path.localeCompare(b.path));
  const total = (key) => docs.reduce((sum, doc) => sum + (doc[key] ?? 0), 0);
  const readers = [...new Set(docs.flatMap((doc) => doc.readers))].sort();
  const summary = { docs, totals: { docs: docs.length, reads: total('reads'), read_bytes: total('read_bytes'), readers, rows: recorded } };
  return indexed ? { ...summary, never_read: indexed.filter((doc) => !byPath.has(doc.path)) } : summary;
}

// The project's indexed docs in index order, as { path, bytes }, its `always` docs against their budget, and `tags`, each
// indexed doc's tags by path.
export function knowledgeOf(project, config) {
  const { buckets } = loadKnowledge(project);
  const rows = indexRows(buckets);
  const indexed = rows.map((doc) => ({ path: doc.path, bytes: fileBytes(path.resolve(project.root, doc.path)) }));
  const tags = Object.fromEntries(rows.map((doc) => [doc.path, doc.tags]));
  return { indexed, always: checkBudgets(project.root, buckets, config.knowledge.budgets).always, tags };
}

export function formatDocs({ docs, totals, never_read: neverRead }, { file, since, skipped, notes = [], always }) {
  const lines = [`Knowledge docs read, from ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`, ...notes];
  if (always) {
    const buckets = Object.entries(always.buckets).map(([id, bytes]) => `${id} ${bytes}`).join(', ');
    const over = always.bytes > always.budget ? ', over knowledge.budgets.alwaysBytes' : '';
    lines.push(`Always docs: ${always.bytes} of ${always.budget} bytes${over}, read by every session and subagent${buckets ? ` (${buckets})` : ''}`);
  }
  if (!totals.rows) return [...lines, 'No knowledge doc reads yet.'].join('\n');
  const kb = (bytes) => (bytes === null ? '?' : `${(bytes / 1024).toFixed(1)} KB`);
  if (!docs.length) lines.push(`${totals.rows} agent and session rows recorded doc reads, and none read a knowledge doc.`);
  else lines.push(
    `${totals.reads} reads of ${totals.docs} docs, ${kb(totals.read_bytes)} in all, by ${totals.readers.length} readers: ${totals.readers.join(', ')}`,
    `Most bytes read (reads × size), top ${Math.min(TOP_DOCS, docs.length)}:`,
    ...docs.slice(0, TOP_DOCS).map((doc) =>
      `  ${String(doc.reads).padStart(5)} × ${kb(doc.bytes).padStart(9)} = ${kb(doc.read_bytes).padStart(9)}  ${doc.path}  (${doc.readers.join(', ')})`),
  );
  const shared = docs.filter((doc) => doc.readers.length > 1).sort((a, b) => b.readers.length - a.readers.length || b.reads - a.reads).slice(0, SHARED_DOCS);
  if (shared.length) {
    lines.push('Read by the most readers:', ...shared.map((doc) => `  ${doc.readers.length} of ${totals.readers.length}  ${doc.path}`));
  }
  if (neverRead?.length) {
    lines.push(
      `Indexed docs never read since ${since}, ${neverRead.length}:`,
      ...neverRead.slice(0, NEVER_READ).map((doc) => `  ${kb(doc.bytes).padStart(9)}  ${doc.path}`),
      ...(neverRead.length > NEVER_READ ? [`  and ${neverRead.length - NEVER_READ} more; --json lists them all`] : []),
    );
  }
  return lines.join('\n');
}
