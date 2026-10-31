// Code names for the terms rule's `code` rules (lib/terms.mjs): a banned name matches an identifier whole, in any case
// style, never as a part of a longer one. `party size` is `partySize`, `PartySize`, `party_size`, `PARTY_SIZE`, and
// `party-size`, and never `minimumPartySize`. A project's own linter can apply the same rule with `codeName`.
//
// It reads text, not a syntax tree. String literals ('…', "…", `…`) and C-family comments (`//`, `/* … */`) are blanked
// first, so a quoted word or a comment never matches; a block comment and a template literal carry over lines when the
// whole file is read. Known limits: code inside a template literal's `${…}` is blanked with it, a quote or `//` inside
// a regular-expression literal can blank the rest of its line, and JSX text reads as code.
// Letters of any script: `caféparty` is one identifier, never `café` and `party`.
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*(?:-[\p{L}_$][\p{L}\p{N}_$]*)*/gu;
const WORDS = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lo}+|\p{N}+/gu;

// An identifier, or a term written as words or as an identifier, as its lowercase words joined by one space.
export const codeName = (text) => (String(text).match(WORDS) ?? []).map((word) => word.toLowerCase()).join(' ');

// `text` with its strings and comments blanked, line breaks kept. A '…' or "…" string ends at its line's end.
export function maskCode(text) {
  let out = '';
  let state = null; // null (code), '//', '/*', "'", '"', or '`'
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '\n') {
      out += char;
      if (state === '//' || state === "'" || state === '"') state = null;
      continue;
    }
    if (state === null) {
      if (char === '/' && (next === '/' || next === '*')) {
        state = `/${next}`;
        out += '  ';
        i += 1;
      } else if (char === "'" || char === '"' || char === '`') {
        state = char;
        out += ' ';
      } else {
        out += char;
      }
      continue;
    }
    if (char === '\\' && state !== '//' && state !== '/*' && next !== undefined) {
      // An escaped line break continues the string on the next line.
      out += next === '\n' ? ' \n' : '  ';
      i += 1;
      continue;
    }
    if (state === '/*' && char === '*' && next === '/') {
      out += '  ';
      i += 1;
      state = null;
      continue;
    }
    if (char === state) state = null;
    out += ' ';
  }
  return out;
}

// The identifiers in code already masked by maskCode, or in one line read on its own.
export const identifiers = (line, masked = false) => (masked ? line : maskCode(line)).match(IDENTIFIER) ?? [];
