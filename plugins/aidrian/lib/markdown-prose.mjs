// The prose of a Markdown file: what the doc says in its own voice, for the terms rule's `prose` rules (lib/terms.mjs).
// Text the doc quotes is not its voice, so it is left out: fenced code, blockquote lines, lines with `<!-- lint-skip -->`,
// and, within a paragraph, code spans, URLs, and "double-quoted" or “curly-quoted” spans, each of which may wrap over
// lines. A code span needs a closing run of the same length, and an escaped backtick opens none, as in Markdown.
// Blanked spans keep their length and line breaks, so lines and columns stay where they were.

import { fencedLines } from './markdown-sections.mjs';

export const SKIP_MARKER = '<!-- lint-skip -->';
const BLOCKQUOTE = /^\s*>/u;
// An opening run counts after an even number of backslashes, which escape each other, never after an odd one.
const CODE_SPAN = /(?<![`\\])((?:\\\\)*)(`+)(?!`)[\s\S]*?(?<!`)\2(?!`)/gu;
const URL = /https?:\/\/[^\s"“”`]+/gu;
const CLOSES = { '"': '"', '“': '”' };

const blank = (match) => match.replace(/[^\n]/gu, ' ');

// A paragraph with its code spans, URLs, and quotations blanked.
export function maskParagraph(text) {
  let open = null;
  let out = '';
  for (const char of text.replace(CODE_SPAN, (match, escapes) => escapes + blank(match.slice(escapes.length))).replace(URL, blank)) {
    if (char === '\n') {
      out += char;
    } else if (open !== null) {
      if (char === CLOSES[open]) open = null;
      out += ' ';
    } else if (char in CLOSES) {
      open = char;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}

// Each line of `text` as the prose it holds, masked, or null for a line that holds none. A paragraph is a run of read
// lines; a blank, fenced, blockquote, or lint-skip line ends it.
export function proseLines(text) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedLines(text);
  const out = lines.map(() => null);
  let start = null;
  const flush = (end) => {
    if (start === null) return;
    maskParagraph(lines.slice(start, end).join('\n')).split('\n').forEach((line, i) => { out[start + i] = line; });
    start = null;
  };
  lines.forEach((line, i) => {
    const read = !fenced[i] && line.trim() !== '' && !BLOCKQUOTE.test(line) && !line.includes(SKIP_MARKER);
    if (!read) flush(i);
    else if (start === null) start = i;
  });
  flush(lines.length);
  return out;
}
