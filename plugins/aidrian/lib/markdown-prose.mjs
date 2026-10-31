// The prose of a Markdown file: what the doc says in its own voice, for the terms rule's `prose` rules (lib/terms.mjs).
// Text the doc quotes is not its voice, so it is left out: fenced code, blockquote lines, lines with `<!-- lint-skip -->`,
// and, on the lines read, inline code, URLs, and "double-quoted" or “curly-quoted” spans, each of which may wrap over lines
// until a blank line or a code block ends the paragraph. Blanked spans keep their length, so columns stay where they were.

import { fencedLines } from './markdown-sections.mjs';

export const SKIP_MARKER = '<!-- lint-skip -->';
const BLOCKQUOTE = /^\s*>/u;
const CLOSES = { '"': '"', '“': '”' };

const blank = (match) => ' '.repeat(match.length);

// One line with its quoted spans blanked, and what is still open at its end: a quote mark, or a code span's backtick
// run. `open` is what was open before the line. A code span closes only on a run of the same length.
export function maskQuoted(line, open = null) {
  const plain = line.replace(/https?:\/\/[^\s"“”`]+/gu, blank);
  let out = '';
  for (let i = 0; i < plain.length; i += 1) {
    const char = plain[i];
    if (char === '`') {
      let run = 1;
      while (plain[i + run] === '`') run += 1;
      if (open === null) open = '`'.repeat(run);
      else if (open === '`'.repeat(run)) open = null;
      out += ' '.repeat(run);
      i += run - 1;
    } else if (open !== null) {
      if (open[0] !== '`' && char === CLOSES[open]) open = null;
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
