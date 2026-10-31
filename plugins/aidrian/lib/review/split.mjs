// Splitting a large review (depth `split`): the changed files are cut into slices one reviewer pass each can read
// well, every slice runs in parallel, and one cross-cutting pass after them looks only for what crosses slices.
// docs/review.md#split describes it; plan.mjs calls `splitPasses` in place of the engine's single pass.
//
// - A slice is the changed files under one package root (the nearest folder with a package.json, go.mod, Cargo.toml,
//   pyproject.toml, or similar), else under the first two path segments. A test stays with the folder it sits in.
//   Slices are packed up to `sliceLines` changed lines; past `maxSlices`, the smallest neighbours merge.
// - A slice reads its own files' diff, the manifest of every changed file, and the repository at the head. It reports
//   findings in its files only, the contracts it changed, and notes about other slices.
// - The cross-cutting pass reads every slice's contracts, notes, and findings, plus the interface files, and reports
//   only what crosses slices.
// A slice's id is a hash of its key, so it stays the same across fixes and only touched slices run again.

import { createHash } from 'node:crypto';

export const SPLIT_DEFAULTS = Object.freeze({ sliceLines: 800, parallel: 4, maxSlices: 8 });
export const PACKAGE_FILES = Object.freeze(['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs']);

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

// The key a changed file belongs to: its nearest package root among `roots` (folders, '' for the repository root),
// else its first two path segments.
export function sliceKey(file, roots) {
  const dirs = file.split('/').slice(0, -1);
  for (let i = dirs.length; i > 0; i -= 1) {
    const dir = dirs.slice(0, i).join('/');
    if (roots.has(dir)) return dir;
  }
  return dirs.slice(0, 2).join('/') || '.';
}

// The package roots among the head's tracked files: the folders that hold a package file. The root folder is left out,
// or every file of a single-package repository would fall in one slice.
export function packageRoots(trackedFiles) {
  const roots = new Set();
  for (const file of trackedFiles) {
    const parts = file.split('/');
    if (parts.length > 1 && PACKAGE_FILES.includes(parts.at(-1))) roots.add(parts.slice(0, -1).join('/'));
  }
  return roots;
}

// [{ key, files, lines }] for the reviewed changes: grouped by key, big groups cut at `sliceLines`, then the smallest
// neighbours merged until at most `maxSlices` remain. Keys sort, so the same diff always makes the same slices.
export function partition(changes, roots, { sliceLines = SPLIT_DEFAULTS.sliceLines, maxSlices = SPLIT_DEFAULTS.maxSlices } = {}) {
  const groups = new Map();
  for (const change of changes) {
    const key = sliceKey(change.file, roots);
    const group = groups.get(key) ?? { key, files: [], lines: 0 };
    group.files.push(change.file);
    group.lines += change.added + change.removed;
    groups.set(key, group);
  }
  const lines = new Map(changes.map((change) => [change.file, change.added + change.removed]));
  const slices = [];
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    let current = { key: group.key, files: [], lines: 0 };
    let part = 0;
    for (const file of group.files.sort()) {
      const size = lines.get(file);
      if (current.files.length && current.lines + size > sliceLines) {
        slices.push(current);
        part += 1;
        current = { key: `${group.key}#${part}`, files: [], lines: 0 };
      }
      current.files.push(file);
      current.lines += size;
    }
    if (current.files.length) slices.push(current);
  }
  while (slices.length > maxSlices) {
    let best = 0;
    for (let i = 1; i < slices.length - 1; i += 1) if (slices[i].lines + slices[i + 1].lines < slices[best].lines + slices[best + 1].lines) best = i;
    const [a, b] = slices.splice(best, 2);
    slices.splice(best, 0, { key: `${a.key}+${b.key}`, files: [...a.files, ...b.files], lines: a.lines + b.lines });
  }
  return slices;
}

// The passes of a split review by one reviewer: a slice pass per slice, then the cross-cutting pass after all of them.
// `halved` names the slices that failed twice: each runs as two halves instead.
export function splitPasses(reviewer, slices, { kind, halved = {} } = {}) {
  const passes = [];
  for (const slice of slices) {
    const id = `slice:${reviewer}:${hash(slice.key)}`;
    if (halved[id] && slice.files.length > 1) {
      const middle = Math.ceil(slice.files.length / 2);
      for (const [suffix, files] of [['a', slice.files.slice(0, middle)], ['b', slice.files.slice(middle)]]) {
        passes.push({ id: `${id}.${suffix}`, reviewer, kind, role: 'slice', slice: `${slice.key} (${suffix})`, files, context: 'full' });
      }
    } else passes.push({ id, reviewer, kind, role: 'slice', slice: slice.key, files: slice.files, context: 'full' });
  }
  passes.push({ id: `cross:${reviewer}`, reviewer, kind, role: 'cross', files: null, context: 'full', after: passes.map((pass) => pass.id) });
  return passes;
}

// One finding per mistake across passes: the same file, lines within 3, and the same title words. The kept finding
// has the highest severity, and `sources` names every pass that reported it.
const RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const words = (title) => title.toLowerCase().replace(/[^a-z0-9 ]+/gu, ' ').split(/\s+/u).filter((word) => word.length > 3).sort().join(' ');
export function dedupe(lists) {
  const kept = [];
  for (const [source, findings] of lists) {
    for (const finding of findings) {
      const twin = kept.find((each) => each.file === finding.file && Math.abs(each.line - finding.line) <= 3 && words(each.title) === words(finding.title));
      if (!twin) kept.push({ ...finding, sources: [source] });
      else {
        if (RANK[finding.severity] > RANK[twin.severity]) Object.assign(twin, { ...finding, sources: twin.sources });
        if (!twin.sources.includes(source)) twin.sources.push(source);
      }
    }
  }
  return kept;
}
