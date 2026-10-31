// The prose of a Markdown file: what the doc says in its own voice, for the terms rule's `prose` rules (lib/terms.mjs).
// Text the doc quotes is not its voice, so it is left out: fenced code, blockquote lines, lines with `<!-- lint-skip -->`,
// and, on the lines read, inline code, URLs, and "double-quoted" or “curly-quoted” spans, which may wrap over lines
// until a blank line or a code block ends the paragraph. Blanked spans keep their length, so columns stay where they were.

import { fencedLines } from './markdown-sections.mjs';

export const SKIP_MARKER = '<!-- lint-skip -->';
const BLOCKQUOTE = /^\s*>/u;
const CLOSES = { '"': '"', '“': '”' };

const blank = (match) => ' '.repeat(match.length);

// One line with its quoted spans blanked, and the quote still open at its end. `open` is the quote mark open before it.
export function maskQuoted(line, open = null) {
  const plain = line.replace(/https?:\/\/\S+/gu, blank).replace(/(`+)[\s\S]*?\1/gu, blank);
  let out = '';
  for (const char of plain) {
    if (open !== null) {
      if (char === CLOSES[open]) open = null;
      out += ' ';
    } else if (char in CLOSES) {
      open = char;
      out += ' ';
    } else {
      out += char;
    }
  }
  return { text: out, open };
}

// Each line of `text` as the prose it holds, masked, or null for a line that holds none.
export function proseLines(text) {
  const fenced = fencedLines(text);
  let open = null;
  return String(text).split(/\r?\n/u).map((line, i) => {
    if (fenced[i] || line.trim() === '') {
      open = null;
      return null;
    }
    if (BLOCKQUOTE.test(line) || line.includes(SKIP_MARKER)) return null;
    const masked = maskQuoted(line, open);
    open = masked.open;
    return masked.text;
  });
}
