// The prose of a Markdown file: what the doc says in its own voice, for the terms rule's `prose` rules (lib/terms.mjs).
// Text the doc quotes is not its voice, so it is left out: fenced code, blockquote lines, lines with `<!-- lint-skip -->`,
// and, on the lines read, inline code, URLs, "double-quoted" and “curly-quoted” spans, and a quote still open at the end
// of a line (a quotation that wraps). Blanked spans keep their length, so columns stay where they were.

import { fencedLines } from './markdown-sections.mjs';

export const SKIP_MARKER = '<!-- lint-skip -->';
const BLOCKQUOTE = /^\s*>/u;

const blank = (match) => ' '.repeat(match.length);

// One line with its quoted spans blanked.
export function maskQuoted(line) {
  let out = line
    .replace(/https?:\/\/\S+/gu, blank)
    .replace(/(`+)[\s\S]*?\1/gu, blank)
    .replace(/"[^"]*"/gu, blank)
    .replace(/“[^”]*”/gu, blank);
  // One quote left: an opening quote (after the start, a space, or a bracket) masks to the end of the line, a closing
  // one from its start.
  const index = out.indexOf('"');
  if (index !== -1) {
    const opening = index === 0 || /[\s([{]/u.test(out[index - 1]);
    out = opening ? out.slice(0, index) + blank(out.slice(index)) : blank(out.slice(0, index + 1)) + out.slice(index + 1);
  }
  return out;
}

// Each line of `text` as the prose it holds, masked, or null for a line that holds none.
export function proseLines(text) {
  const fenced = fencedLines(text);
  return String(text).split(/\r?\n/u).map((line, i) => {
    if (fenced[i] || BLOCKQUOTE.test(line) || line.includes(SKIP_MARKER)) return null;
    return maskQuoted(line);
  });
}
