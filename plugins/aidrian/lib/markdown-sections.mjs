// Reads a Markdown body by its `## ` sections, outside code fences: a body may quote a heading or a list item as an
// example, and a quoted example is neither a section nor an item. Used by the pull request body rule
// (lib/rules/github/pr-body.mjs) and the review gate (lib/review-gate.mjs).

// A fence line: any indent (a fence under a list item is indented), a run of 3 or more backticks or tildes, the rest.
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;
// An ATX level-2 heading: exactly two hashes, whitespace, then the title.
const HEADING = /^ {0,3}##(?!#)\s+(.+?)\s*$/u;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;

// The lines outside fenced code blocks, in order. A fence closes on the same character at a run at least as long and
// with no info string, as CommonMark says; an unterminated fence runs to the end. A backtick "fence" whose info string
// holds a backtick is a line that opens with an inline code span, not a fence.
export function* unfencedLines(body) {
  let open = null;
  for (const line of String(body).split(/\r?\n/u)) {
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, rest] = fence;
      if (open === null) {
        if (marker[0] === '`' && rest.includes('`')) {
          yield line;
          continue;
        }
        open = { char: marker[0], length: marker.length };
      } else if (marker[0] === open.char && marker.length >= open.length && rest.trim() === '') {
        open = null;
      }
      continue;
    }
    if (open === null) yield line;
  }
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
