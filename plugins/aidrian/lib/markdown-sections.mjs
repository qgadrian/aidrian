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
export const fenceOf = (line) => {
  const found = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)*)(`{3,}|~{3,})(.*)$/u.exec(line);
  // A backtick fence's info string has no backtick, so "```code``` stays literal" is inline code, not a fence.
  if (!found || (found[3][0] === '`' && found[4].includes('`'))) return null;
  return { char: found[3][0], length: found[3].length, bare: found[2] === '' && found[4].trim() === '', item: found[2] === '' ? null : found[1].length + found[2].length };
};
export const closes = (fence, open) => fence?.bare && fence.char === open.char && fence.length >= open.length;

// A list item's marker line, its markers alone included ("-", "1."): the item's content column, or null.
const MARKERS_ONLY = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)*(?:[-*+]|\d+[.)]))\s*$/u;
const NESTED_MARKERS = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)+)/u;
function itemColumn(line) {
  const bare = MARKERS_ONLY.exec(line);
  if (bare) return bare[1].length + bare[2].length + 1;
  const markers = NESTED_MARKERS.exec(line);
  return markers ? markers[1].length + markers[2].length : null;
}

// For each line, whether it is code: a fence line or a line inside a fenced block, by the delimiters blocksOf uses. A
// fence may open after list markers, as in "- ```bash", and one that opened after them ends where that item ends, so the
// bare fence that closes it never opens another. sectionOf and invariantsOf skip these lines as headings.
// Two CommonMark rules keep a fence-like line from hiding the rest of the doc:
// - a fence on a line of its own indented 4 or more columns past the list item it is in (past column 0 outside one) is
//   indented code, not a fence; the item is the last list item line outside a fence, until a line indented less than its
//   content column;
// - an unclosed fence on an indented line, such as a second bare fence inside a list item, ends before the first later
//   line indented less than it, as its container does; only one at column 0 runs to the end of the doc.
// The second also covers a container this reads wrong: a fence it misses leaves its closer to open a fence that is never
// closed, and that one then ends where the item does instead of hiding every later heading.
// Known limit: a lazy continuation line, indented less than its item, ends the item here.
export function fencedIn(lines) {
  const expanded = lines.map(expandTabs);
  let open = null;
  let item = null;
  return expanded.map((line, at) => {
    const indent = indentOf(line);
    const ends = (column) => column != null && line.trim() && indent < column;
    if (ends(open?.item) || ends(open?.until)) open = null;
    if (open) {
      if (closes(fenceOf(line), open)) open = null;
      return true;
    }
    if (ends(item) && itemColumn(line) === null) item = null;
    open = fenceOf(line);
    if (open && open.item === null && indent >= (item ?? 0) + 4) open = null;
    if (open && open.item === null && indent > 0 && !closedAfter(expanded, at, open)) open.until = indent;
    if (!open && line.trim()) item = itemColumn(line) ?? item;
    if (open?.item != null) item = open.item;
    return open !== null;
  });
}

// Whether a later line closes the fence `open` that opened on line `at`.
const closedAfter = (lines, at, open) => lines.slice(at + 1).some((line) => closes(fenceOf(line), open));

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
