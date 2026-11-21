// The text a project run keeps of what an issue's session wrote, and the test the tracker guard holds that session's
// own tracker text to (lib/tracker-guard.mjs). It imports nothing, so a hook loads it on every tracker call for free.

// The characters a result's text never keeps: format characters (bidirectional marks, zero-width joiners, tag
// characters), private-use and unassigned code points, and variation selectors, which are deleted, so none can hide
// between a mark and a word; and controls and line and paragraph separators, which become spaces.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// A domain-shaped token, such as evil.example or evil.example/path: labels of letters, digits, and dashes joined by dots,
// ending in a top-level label of 2 to 24 letters. A file name such as config.json reads as one too. It is kept, as an
// inline code span, which a tracker renders as text and never as a link.
const DOMAIN = /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-])(?:[/:]\S*)?/giu;

// `text` with anything shaped like a credential masked as `[redacted]`: a forge, chat, cloud, or API token by its
// prefix, a JSON web token, the password of a URL's user part, and the value after an HTTP Authorization scheme.
export const maskSecrets = (text) => String(text)
  .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/gu, '[redacted]')
  .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}/gu, '[redacted]')
  .replace(/(:\/\/[^\s/:@]+:)[^\s/@]+@/gu, '$1[redacted]@')
  .replace(/\b((?:basic|bearer|token)\s+)[A-Za-z0-9+/=._-]{12,}/giu, '$1[redacted]');

// Text a result keeps of a field: INVISIBLE characters, images, links (their text kept), HTML, bare addresses, backticks,
// and every `@` before a word, as a mention starts, removed until the text stops changing, so a removal cannot join a new
// one (`@@name`, `@<b></b>name`); each domain-shaped token wrapped in an inline code span; white space folded, cut at
// `cap`. null for a value that is no string. `domains: false` leaves domain-shaped tokens bare, for the run's own reasons
// in its ledger, such as a forge's host, which the report cleans again before anything is posted.
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
    .replace(/`+/gu, '')
    .replace(domains ? DOMAIN : /(?!)/u, (token) => `\`${token}\``)
    .replace(/@+(?=[\w-])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

// Whether `value` holds anything cleanText changes but white space: a mention, a link or address, an image, HTML, a
// character reference, a hidden character, a backtick that is not a code span around one domain-shaped token, or such a
// token left bare. The tracker guard refuses an issue's session text that does; a file or host name goes in backticks.
export const textProblem = (value) => typeof value === 'string' && cleanText(value, Infinity) !== value.replace(/\s+/gu, ' ').trim();

// `value` with its hidden characters removed (INVISIBLE), and nothing else changed: for text kept as a fenced file.
export const stripHidden = (value) => (typeof value === 'string' ? value.replace(INVISIBLE, '') : '');
