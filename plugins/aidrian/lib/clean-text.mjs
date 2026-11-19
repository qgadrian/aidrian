// The text a project run keeps of what an issue's session wrote, and the test the tracker guard holds that session's
// own tracker text to (lib/tracker-guard.mjs). It imports nothing, so a hook loads it on every tracker call for free.

// The characters a result's text never keeps: format characters (bidirectional marks, zero-width joiners, tag
// characters), private-use and unassigned code points, and variation selectors, which are deleted, so none can hide
// between a mark and a word; and controls and line and paragraph separators, which become spaces.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// A domain-shaped token, such as evil.example or evil.example/path: labels of letters, digits, and dashes joined by dots,
// ending in a top-level label of 2 to 24 letters. A file name such as config.json reads as one too, and goes.
const DOMAIN = /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-])(?:[/:]\S*)?/giu;

// Text a result keeps of a field: INVISIBLE characters, images, links (their text kept), HTML, bare and domain-shaped
// addresses, and every `@` before a word, as a mention starts, removed until the text stops changing, so a removal cannot
// join a new one (`@@name`, `@<b></b>name`); white space folded, cut at `cap`. null for a value that is no string.
// `domains: false` keeps domain-shaped tokens, for the run's own reasons in its ledger, such as a forge's host, which the
// report cleans again with them before anything is posted.
export function cleanText(value, cap, { domains = true } = {}) {
  if (typeof value !== 'string') return null;
  let text = value;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = cleanOnce(text, domains);
    if (next === text) break;
    text = next;
  }
  return text.slice(0, cap);
}

const cleanOnce = (value, domains) => value.replace(INVISIBLE, '').replace(BREAKS, ' ')
    // Character references a renderer would decode, such as &#64;, &#x40;, or &commat;, which spell a mention marker.
    .replace(/&(?:#[0-9]{1,8};?|#[xX][0-9a-fA-F]{1,8};?|[A-Za-z][A-Za-z0-9]{1,31};)/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/\b(?:[a-z][a-z0-9+.-]*):\/\/\S*/giu, '')
    .replace(/\b(?:mailto|javascript|data|file):\S*/giu, '')
    .replace(/\bwww\.\S+/giu, '')
    .replace(domains ? DOMAIN : /(?!)/u, '')
    .replace(/@+(?=[\w-])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

// Whether `value` holds anything cleanText removes but white space: a mention, a link or address, an image, HTML, a
// character reference, or a hidden character. The tracker guard refuses an issue's session text that does.
export const textProblem = (value) => typeof value === 'string' && cleanText(value, Infinity) !== value.replace(/\s+/gu, ' ').trim();
