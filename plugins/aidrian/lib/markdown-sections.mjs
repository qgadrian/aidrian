// Reads a Markdown body by its `## ` sections, outside code fences: a body may quote a heading or a list item as an
// example, and a quoted example is neither a section nor an item. Used by the pull request body rule
// (lib/rules/github/pr-body.mjs), the review gate (lib/review-gate.mjs), Markdown prose checks (lib/markdown-prose.mjs),
// and review flows (lib/review/flows.mjs), which share its fence detection. It imports nothing of the plugin's.

// An ATX level-2 heading: exactly two hashes, whitespace, then the title.
const HEADING = /^ {0,3}##(?!#)\s+(.+?)\s*$/u;
// A list item's first line: its indentation, then a bullet or an ordered marker.
export const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;

// The key two anchors are compared by: GitHub's anchor with `_` dropped and runs of spaces and hyphens collapsed, so
// an anchor written by hand, copied from GitHub, or made by `anchor` in review/flows.mjs finds its heading. Never shown
// as a link. Review flows and the decision resolver's `escalateDocs` (lib/decisions.mjs) read sections by it.
export const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/[\s-]+/gu, '-').replace(/^-|-$/gu, '');

// A fence line: its delimiter, and whether the line is the delimiter alone, which only a closing fence may be. An
// opening fence may follow list markers, as in "- ```js"; such a line is never bare, so it never closes one, and `item`
// is the content column of that list item (null for a fence on a line of its own).
// A fence counts at any indentation. CommonMark reads a fence 4 or more columns past its container as indented code,
// but measuring that needs every list container right (nested markers, marker-only lines, thematic breaks), and each
// miss hid the headings after it. Reading such a rare line as a fence costs less.
export const fenceOf = (line) => {
  const found = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)*)(`{3,}|~{3,})(.*)$/u.exec(line);
  // A backtick fence's info string has no backtick, so "```code``` stays literal" is inline code, not a fence.
  if (!found || (found[3][0] === '`' && found[4].includes('`'))) return null;
  return { char: found[3][0], length: found[3].length, bare: found[2] === '' && found[4].trim() === '', item: found[2] === '' ? null : found[1].length + found[2].length };
};
export const closes = (fence, open) => fence?.bare && fence.char === open.char && fence.length >= open.length;

// For each line, whether it is code: a fence line or a line inside a fenced block, by the delimiters blocksOf uses. A
// fence may open after list markers, as in "- ```bash", and one that opened after them ends where that item ends, so the
// bare fence that closes it never opens another. sectionOf and invariantsOf skip these lines as headings.
// Known limit: an unclosed fence on a line of its own runs to the end of the doc, even inside a list item, where
// blocksOf ends it with the item; and a lazy continuation line, indented less than its item, ends the item here.
export function fencedIn(lines) {
  let open = null;
  return lines.map((raw) => {
    const line = expandTabs(raw);
    if (open?.item != null && line.trim() && indentOf(line) < open.item) open = null;
    if (open) {
      if (closes(fenceOf(line), open)) open = null;
      return true;
    }
    open = fenceOf(line);
    return open !== null;
  });
}

// A line with the tabs of its indentation and list markers expanded to 4-column stops, so indentation is measured in
// columns: a tab-indented nested bullet stays nested.
export const expandTabs = (line) => {
  const prefix = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*/u.exec(line)[0];
  let out = '';
  for (const char of prefix) out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char;
  return out + line.slice(prefix.length);
};
export const indentOf = (line) => /^ */u.exec(line)[0].length;


// For each line of a body, CRLF or LF, whether it is code, by fencedIn.
export const fencedLines = (body) => fencedIn(String(body).split(/\r?\n/u));

// The lines outside fenced code blocks, in order.
export function* unfencedLines(body) {
  const fenced = fencedLines(body);
  const lines = String(body).split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) if (!fenced[i]) yield lines[i];
}

// The title of a `## ` heading line, or null.
export const headingOf = (line) => HEADING.exec(line)?.[1] ?? null;

// Every `## ` heading outside fences, in order.
export const headings = (body) => [...unfencedLines(body)].map(headingOf).filter((title) => title !== null);

// The list items of the `## <section>` sections, or null when the body has no such section. Each item is
// { text, first }: `text` the whole item with its wrapped lines and its own sub-list, `first` its own first line with
// the lines wrapped under it. A bullet indented past the item above it belongs to that item; prose that is no list item
// is not an item. Every doubt reads as fewer items: merging two misses a catch, splitting one blocks a correct body.
export function sectionItems(body, section) {
  let items = null;
  let inSection = false;
  let open = null;
  let last = null;
  for (const line of unfencedLines(body)) {
    const title = headingOf(line);
    if (title !== null) {
      inSection = title === section;
      if (inSection) items ??= [];
      open = last = null;
      continue;
    }
    if (!inSection) continue;
    if (line.trim() === '') {
      open = null;
      continue;
    }
    const bullet = LIST_ITEM.exec(line);
    if (bullet) {
      const indent = [...bullet[1]].reduce((columns, ch) => columns + (ch === '\t' ? 4 : 1), 0);
      if (last && indent > last.indent) {
        last.text += ` ${line.trim()}`;
        last.inFirst = false;
        open = last;
        continue;
      }
      last = { indent, text: line.trim(), first: line.trim(), inFirst: true };
      open = last;
      items.push(last);
      continue;
    }
    if (open) {
      open.text += ` ${line.trim()}`;
      if (open.inFirst) open.first += ` ${line.trim()}`;
    }
  }
  return items?.map(({ text, first }) => ({ text, first: first.replace(LIST_ITEM, '') })) ?? null;
}
