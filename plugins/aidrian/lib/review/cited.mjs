// The docs a flow's invariants come from, and whether a change touches the part a flow cites. An invariants doc, or a
// citation with no `#anchor`, is cited whole; `doc.md#section` cites only that section, so an edit elsewhere in the doc
// leaves how the project is reviewed as it was.

import { changedRanges, fileAt } from './diff.mjs';
import { sectionRange } from './flows.mjs';

const WHOLE = null;

// Map of doc path to the anchors cited in it, or WHOLE when any citation takes the whole doc.
export function citedDocs(flows) {
  const docs = new Map();
  const add = (file, anchor) => {
    if (!file) return;
    if (anchor === WHOLE || docs.get(file) === WHOLE) return docs.set(file, WHOLE);
    docs.set(file, new Set([...(docs.get(file) ?? []), anchor]));
  };
  for (const flow of Object.values(flows ?? {})) {
    if (typeof flow?.invariants === 'string') add(flow.invariants, WHOLE);
    else if (Array.isArray(flow?.invariants)) {
      for (const each of flow.invariants) {
        if (typeof each?.cite !== 'string') continue;
        const at = each.cite.indexOf('#');
        add(at < 0 ? each.cite : each.cite.slice(0, at), at < 0 || !each.cite.slice(at + 1) ? WHOLE : each.cite.slice(at + 1));
      }
    }
  }
  return docs;
}

const overlaps = (ranges, section) => ranges.some(([first, last]) => first <= section.end && last >= section.start + 1);

// The cited docs among `changedPaths` whose cited part the change from `from` to `to` touches. A section counts as
// touched when a changed line falls inside it on either side, or when its heading is missing on either side: a
// renamed or removed heading changes what the citation points at.
export function touchedCitations(root, from, to, flows, changedPaths) {
  const touched = [];
  for (const [file, anchors] of citedDocs(flows)) {
    if (!changedPaths.has(file)) continue;
    if (anchors === WHOLE) {
      touched.push(file);
      continue;
    }
    const before = fileAt(root, from, file);
    const after = fileAt(root, to, file);
    if (before === null || after === null) {
      touched.push(file);
      continue;
    }
    const ranges = changedRanges(root, from, to, file);
    const hit = [...anchors].some((anchor) => {
      const old = sectionRange(before, anchor);
      const now = sectionRange(after, anchor);
      return !old || !now || overlaps(ranges.old, old) || overlaps(ranges.new, now);
    });
    if (hit) touched.push(file);
  }
  return touched;
}
