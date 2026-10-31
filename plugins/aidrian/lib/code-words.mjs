// Code names for the terms rule's `code` rules (lib/terms.mjs): a banned name matches an identifier whole, in any case
// style, never as a part of a longer one. `party size` is `partySize`, `PartySize`, `party_size`, `PARTY_SIZE`, and
// `party-size`, and never `minimumPartySize`. A project's own linter can apply the same rule with `codeName`.
//
// It reads text, not a syntax tree. Each line is read on its own: string literals ('…', "…", `…`) and C-family comments
// (`//`, `/* … */`) are blanked first, so a quoted word or a comment never matches. Known limits: code inside a template
// literal's `${…}` is blanked with it, a quote or `//` inside a regular-expression literal can blank the rest of its
// line, and JSX text reads as code.

const STRING_OR_COMMENT = /\/\*.*?(?:\*\/|$)|\/\/.*$|'(?:[^'\\]|\\.)*(?:'|$)|"(?:[^"\\]|\\.)*(?:"|$)|`(?:[^`\\]|\\.)*(?:`|$)/gu;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z_$][A-Za-z0-9_$]*)*/gu;
const WORDS = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/gu;

// An identifier, or a term written as words or as an identifier, as its lowercase words joined by one space.
export const codeName = (text) => (String(text).match(WORDS) ?? []).map((word) => word.toLowerCase()).join(' ');

// The identifiers on one line of code, outside strings and comments.
export const identifiers = (line) => line.replace(STRING_OR_COMMENT, (match) => ' '.repeat(match.length)).match(IDENTIFIER) ?? [];
