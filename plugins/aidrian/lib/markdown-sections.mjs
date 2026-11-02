// Reads a Markdown body by its `## ` sections, outside code fences: a body may quote a heading or a list item as an
// example, and a quoted example is neither a section nor an item. Used by the pull request body rule
// (lib/rules/github/pr-body.mjs), the review gate (lib/review-gate.mjs), Markdown prose checks (lib/markdown-prose.mjs),
// and review flows (lib/review/flows.mjs), which share its fence detection.

// An ATX level-2 heading: exactly two hashes, whitespace, then the title.
const HEADING = /^ {0,3}##(?!#)\s+(.+?)\s*$/u;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;

// A fence line: its delimiter, and whether the line is the delimiter alone, which only a closing fence may be. An
// opening fence may follow list markers, as in "- ```js"; such a line is never bare, so it never closes one, and `item`
// is the content column of that list item (null for a fence on a line of its own).
// As in CommonMark, a fence is indented at most 3 columns past `container`, the column its container starts at: 0
// outside a list item, the item's content column inside one. A line indented 4 or more past it is indented code.
// CommonMark: https://spec.commonmark.org/0.31.2/#fenced-code-blocks
export const fenceOf = (line, container = 0) => {
  const found = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)*)(`{3,}|~{3,})(.*)$/u.exec(line);
  // A backtick fence's info string has no backtick, so "```code``` stays literal" is inline code, not a fence.
  if (!found || (found[3][0] === '`' && found[4].includes('`'))) return null;
  if (found[1].length - container > 3) return null;
  return { char: found[3][0], length: found[3].length, bare: found[2] === '' && found[4].trim() === '', item: found[2] === '' ? null : found[1].length + found[2].length };
};
export const closes = (fence, open) => fence?.bare && fence.char === open.char && fence.length >= open.length;

// For each line, whether it is code: a fence line or a line inside a fenced block, by the delimiters blocksOf uses. A
// fence may open after list markers, as in "- ```bash", and one that opened after them ends where that item ends, so the
// bare fence that closes it never opens another. sectionOf and invariantsOf skip these lines as headings.
// A fence counts only within 3 columns of its container: `items` holds the content columns of the list items a line
// may sit in, innermost last, and a non-blank line indented less than an item's column ends that item.
// Known limit: an unclosed fence on a line of its own runs to the end of the doc, even inside a list item, where
// blocksOf ends it with the item; and a lazy continuation line, indented less than its item, ends the item here.
export function fencedIn(lines) {
  let open = null;
  const items = [];
  return lines.map((raw) => {
    const line = expandTabs(raw);
    const indent = indentOf(line);
    if (open?.item != null && line.trim() && indent < open.item) open = null;
    if (open) {
      if (closes(fenceOf(line, open.container), open)) open = null;
      return true;
    }
    if (line.trim()) while (items.length && indent < items.at(-1)) items.pop();
    const container = items.at(-1) ?? 0;
    const item = itemOf(line);
    // A line such as "- - nested" opens one item per marker: each marker's content column goes on the stack.
    if (item && indent - container <= 3) for (const marker of line.matchAll(NESTED_MARKER)) items.push(marker.index + marker[0].length);
    const fence = fenceOf(line, container);
    open = fence && { ...fence, container: fence.item ?? container };
    return fence !== null;
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

// A list item's marker and the content column after it, or null. A thematic break such as `* * *` or `- - -` looks like
// an item but is not one (CommonMark), so it opens no container a later fence could be measured against.
export const THEMATIC_BREAK = /^ *([-*_])(?: *\1){2,} *$/u;
export const itemOf = (line) => (THEMATIC_BREAK.test(line) ? null : /^( *)((?:[-*+]|\d+[.)]) +)\S/u.exec(line));
// Each list marker at the start of a line, the leading one and any nested after it, such as both in "- 1. step".
const NESTED_MARKER = /(?<=^ *(?:(?:[-*+]|\d+[.)]) +)*)(?:[-*+]|\d+[.)]) +/gu;

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
