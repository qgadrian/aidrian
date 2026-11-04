// The line-length check for Markdown files: one sentence per line reads well in every diff, and the limit
// (config.json `docs.wrapLimit`) keeps a line on one screen. Text that wrapping would damage is never reported:
// YAML frontmatter, fenced and indented code, table rows, a decision marker line (lib/decisions.mjs), and a line whose
// overflow is one unbreakable token, such as a URL.
// Fenced code is what the shared detector in markdown-sections.mjs reads, so a fence opened after a list marker closes.

import { isDecisionLine } from './decisions.mjs';
import { fencedLines } from './markdown-sections.mjs';

const FRONTMATTER = /^---\s*$/;
const FRONTMATTER_END = /^(?:---|\.\.\.)\s*$/;

// The lines of a Markdown document longer than `limit`, as { line (1-based), length }.
export function findWrapViolations(text, limit) {
  const violations = [];
  const lines = String(text ?? '').split('\n');
  // A leading --- opens frontmatter only when a --- or ... closes it; otherwise it is a rule.
  const frontmatterEnd = FRONTMATTER.test(lines[0] ?? '') ? lines.findIndex((line, index) => index > 0 && FRONTMATTER_END.test(line)) : -1;
  // Fences are read after the frontmatter, so a fence-like YAML value opens none; blank lines keep the line numbers.
  const fenced = fencedLines(lines.map((line, index) => (index <= frontmatterEnd ? '' : line)).join('\n'));
  for (const [index, line] of lines.entries()) {
    if (index <= frontmatterEnd) continue;
    if (fenced[index]) continue;
    if (line.trimStart().startsWith('|') || line.startsWith('    ') || line.startsWith('\t') || isDecisionLine(line)) continue;
    // Wrapping breaks only at whitespace, so a line whose longest token is over the limit cannot be fixed.
    if (line.length > limit && line.split(/\s+/).every((token) => token.length <= limit)) violations.push({ line: index + 1, length: line.length });
  }
  return violations;
}

// The 1-based lines of `fileText` that `introduced` spans; null when it is not in the file. With `replaceAll`, every
// occurrence. Without it the edit wrote one occurrence, and the file after it cannot tell which: more than one is an
// empty set, so no line the edit did not write is named.
export function affectedLines(fileText, introduced, replaceAll = false) {
  if (typeof introduced !== 'string' || introduced === '') return null;
  const hits = new Set();
  let found = 0;
  for (let at = fileText.indexOf(introduced); at !== -1; at = fileText.indexOf(introduced, at + introduced.length)) {
    found += 1;
    const first = fileText.slice(0, at).split('\n').length;
    for (let n = first; n < first + introduced.split('\n').length; n += 1) hits.add(n);
  }
  if (found === 0) return null;
  return replaceAll || found === 1 ? hits : new Set();
}
