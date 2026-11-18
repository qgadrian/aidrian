// What a handoff brief must hold for a session that resumes it with nothing else, for `aidrian handoff check`
// (lib/handoff-brief.mjs). The check holds only the brief it checks: a superseded brief of any older format compares as
// it is.
//   - sectionProblems: one finding for each required section the brief lacks, or holds nothing of what it must.
//     A heading matches by its first words in any case, so `## Next steps (ordered)` is Next steps; a heading or a line
//     inside a code fence counts for nothing.
//   - supersedesOf: the header's `Supersedes:` value, which says whether the brief supersedes another.
//   - branchOf: the `Branch:` value of the Current state section, which the background route's progress check reads.
// Imports only lib/markdown-sections.mjs.

import { headingOf, unfencedLines } from './markdown-sections.mjs';

const hasText = (lines) => lines.some((line) => line.trim() !== '');
// A numbered item at the start of a line: an item indented under a bullet is a sub-step, not the next step.
const numbered = (lines) => lines.some((line) => /^\d+[.)][ \t]+\S/u.test(line));

// A label's value with its spaces and emphasis marks trimmed, so `**Worktree:** x` reads as `x`.
const unemphasized = (value) => value.replace(/^[\s*_]+|[\s*_]+$/gu, '');

// The value of `label:` on a line, in any case: the text after it up to a `|` or the line's end, emphasis marks dropped.
const labelValues = (lines, label) => {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${label}:([^|\\n]*)`, 'giu');
  return lines.flatMap((line) => [...line.matchAll(pattern)].map((match) => unemphasized(match[1])));
};

// Each required section, with the test of what it must hold and what a finding asks to add.
const REQUIRED = [
  { name: 'Objective', holds: hasText, missing: 'holds no line of text', add: 'a line on the task and what done means' },
  { name: 'Current state', labels: ['Worktree', 'Branch'], add: '`Worktree: <path, or none yet>` and `Branch: <name>`, each on its own line' },
  { name: 'Still running', holds: hasText, missing: 'holds no line of text', add: 'one item per agent or job left running, or `None.`' },
  { name: 'Next steps', holds: numbered, missing: 'has no numbered item at the start of a line', add: '`1. <the smallest next action>`' },
  { name: 'Open risks and questions', holds: hasText, missing: 'holds no line of text', add: 'each open risk or question, or `None.`' },
].map((section) => ({ ...section, heading: new RegExp(`^${section.name}(?![\\p{L}\\p{N}])`, 'iu') }));

// The findings for the required sections of a brief: [] when it holds all five.
export function sectionProblems(text) {
  const found = new Map();
  let current = null;
  for (const line of unfencedLines(String(text ?? ''))) {
    const title = headingOf(line);
    if (title !== null) {
      current = REQUIRED.find((section) => section.heading.test(title)) ?? null;
      if (current && !found.has(current)) found.set(current, []);
    } else if (current) {
      found.get(current).push(line);
    }
  }
  return REQUIRED.flatMap((section) => {
    const lines = found.get(section);
    if (!lines) return [`${section.name}: no \`## ${section.name}\` section: add it, with ${section.add}`];
    if (section.labels) {
      return section.labels
        .filter((label) => !labelValues(lines, label).some((value) => value !== ''))
        .map((label) => `${section.name}: no \`${label}:\` value: add \`${label}: <${label === 'Worktree' ? 'path, or none yet' : 'name'}>\` to the section`);
    }
    return section.holds(lines) ? [] : [`${section.name}: the section ${section.missing}: add ${section.add}`];
  });
}

const CURRENT_STATE = REQUIRED.find((section) => section.name === 'Current state').heading;

// The first `Branch:` value of the brief's Current state section, without backticks, or null when it has none.
export function branchOf(text) {
  let inState = false;
  for (const line of unfencedLines(String(text ?? ''))) {
    const title = headingOf(line);
    if (title !== null) inState = CURRENT_STATE.test(title);
    const value = inState && title === null ? labelValues([line], 'Branch').find((each) => each !== '') : undefined;
    if (value) return value.replace(/^`+|`+$/gu, '');
  }
  return null;
}

// The header's `Supersedes:` value, trimmed of spaces and emphasis marks, in the text above the first `## `: from the
// label to the next `|` or the line's end. null when the header has no such field.
export function supersedesOf(text) {
  const header = String(text ?? '').split(/^##\s/mu)[0];
  const match = /(?<![\w-])Supersedes:([^|\n]*)/iu.exec(header);
  return match ? unemphasized(match[1]) : null;
}

// Whether a `Supersedes:` value names a brief: any value but one that begins with `none`, in any case.
export const namesBrief = (value) => Boolean(value) && !/^[`*_"']*none(?![\p{L}\p{N}])/iu.test(value);

// The finding for a header with no `Supersedes:` value, or null.
export const supersedesProblem = (text) =>
  supersedesOf(text) ? null : 'Supersedes: no value in the header: add `Supersedes: <the brief this one replaces, or none>` to the line under the title';

// Whether a `Supersedes:` value names the brief's own file, `name`: by that name, or as the same or this file or brief.
const namesItself = (value, name) => (name && value.includes(name)) || /^(?:the )?(?:same|this) (?:file|brief)\b/iu.test(value);

// The finding for a brief whose `Supersedes:` value names a brief when no prior resolved to compare with, or null. A
// value that names the brief's own file, `name`, has no earlier text left to compare: only the Human can settle it.
export function unresolvedProblem(text, name = '') {
  const value = supersedesOf(text);
  if (!namesBrief(value)) return null;
  if (namesItself(value, name)) {
    return `Carry-forward: the header names this same file, \`Supersedes: ${value}\`, and no snapshot of its earlier text exists: that text is gone and nothing can be compared, so tell the Human`;
  }
  return `Carry-forward: the header names \`Supersedes: ${value}\`, but no superseded brief was found, so nothing was compared: run the check with \`--prior <that brief>\``;
}
