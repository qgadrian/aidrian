// The docs a flow's invariants come from, and whether a change touches the part a flow cites. An invariants doc, or a
// citation with no `#anchor`, is cited whole; `doc.md#section` cites only that section, so an edit elsewhere in the doc
// leaves how the project is reviewed as it was.

import { fileAt } from './diff.mjs';
import { sectionOf } from './flows.mjs';

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

// The cited docs among `changedPaths` whose cited part the change from `from` to `to` touches. A section counts as
// touched when its heading or text differs between the two sides, or its heading is missing on either side: an edit
// inside it, a heading inserted into it or removed after it, and a renamed heading all change what the citation reads.
// A flow names a doc from the project root; git reports a change from the repository's, so `prefix` is the project's
// folder there, as `git rev-parse --show-prefix` prints it, and a doc comes back as git names it.
export function touchedCitations(root, from, to, flows, changedPaths, prefix = '') {
  const touched = [];
  for (const [doc, anchors] of citedDocs(flows)) {
    const file = `${prefix}${doc}`;
    if (!changedPaths.has(file)) continue;
    if (anchors === WHOLE) {
      touched.push(file);
      continue;
    }
    const before = fileAt(root, from, `./${doc}`);
    const after = fileAt(root, to, `./${doc}`);
    if (before === null || after === null) {
      touched.push(file);
      continue;
    }
    const hit = [...anchors].some((anchor) => {
      const old = sectionOf(before, anchor);
      const now = sectionOf(after, anchor);
      return !old || !now || old.heading !== now.heading || old.raw !== now.raw;
    });
    if (hit) touched.push(file);
  }
  return touched;
}
