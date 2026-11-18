// The characters no display text keeps: every character of the Unicode categories Cc, Cf, Zl, Zp, and Cs, which are C0,
// C1, DEL, the line and paragraph separators, the bidi controls and marks, zero-width and tag characters, and lone
// surrogates. One pattern for the snapshot, which removes them (session-snapshot.mjs displayText), and the session
// ledger, which writes no row holding one (session-prs.mjs, forges/github.mjs changeRef). No dependencies: hooks load it.

const HIDDEN_CLASS = String.raw`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]`;

// Every hidden character, for a replace.
export const HIDDEN = new RegExp(HIDDEN_CLASS, 'gu');
const ANY_HIDDEN = new RegExp(HIDDEN_CLASS, 'u');

// Whether `text` holds a hidden character. A non-global pattern, so no call leaves state for the next.
export const hasHidden = (text) => ANY_HIDDEN.test(text);
