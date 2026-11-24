// The review bot's stock footer as a local reviewer may report it. A pass's input (dispatch.mjs passInput) carries no
// pull request conversation, but Codex reads it with its own shell, and its prompt calls review comments data to review
// (reviewers.mjs REQUEST_BRIEF): it raised the receipt's stock footer, `Try commenting "@codex address that feedback"`,
// as a request in a comment (#674). So where an exec pass's findings are recorded (stages.mjs), a finding that names no
// changed file, and quotes only text of that fixed footer, is dropped with a note, when a comment by the configured bot
// account carries the footer. Only the footer counts, never the rest of a comment: an instruction anywhere else in a
// receipt, or a phrase a contributor's comment shares with the bot's, stays a finding. It fails closed: a finding that
// quotes nothing, or quotes any other text, stays, and so does every finding once the bot rewords its footer.

// The receipt's "About Codex in GitHub" footer, line by line, as the bot posts it (#670's receipts), without its markup.
export const STOCK_FOOTER = Object.freeze([
  'About Codex in GitHub',
  '[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you',
  '- Open a pull request for review',
  '- Mark a draft as ready',
  '- Comment "@codex review".',
  'If Codex has suggestions, it will comment; otherwise it will react with 👍.',
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
]);

// A quoted span: in backticks, straight double quotes, or curly double quotes, on one line.
const QUOTED = /`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/gu;
// Punctuation and space a quote may carry at its ends, as `“@codex address that feedback,”`.
const EDGES = /^[\s.,;:!?]+|[\s.,;:!?]+$/gu;
// Shorter spans prove nothing: three letters match almost any text.
const MIN_QUOTE = 4;

// Whether `reviewer`, the review bot's account (`github.reviewer`), posted a comment that carries every footer line.
export function footerPosted(comments, reviewer) {
  if (typeof reviewer !== 'string' || !reviewer) return false;
  const carries = (body) => typeof body === 'string' && STOCK_FOOTER.every((line) => body.includes(line));
  return (Array.isArray(comments) ? comments : []).some((comment) => comment?.user?.login === reviewer && carries(comment.body));
}

// The quoted spans of a finding's title and body, their edges trimmed, each at least MIN_QUOTE characters.
export function quotesOf(finding) {
  const text = `${finding?.title ?? ''}\n${finding?.body ?? ''}`;
  return [...text.matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? match[3]).replace(EDGES, '')).filter((quote) => quote.length >= MIN_QUOTE);
}

// Whether `finding` is about the stock footer only: it names no file of `changed` (a Set of the change's files), quotes
// at least one span, and every span it quotes lies inside one footer line.
export function echoesFooter(finding, changed) {
  if (typeof finding?.file === 'string' && changed.has(finding.file)) return false;
  const quotes = quotesOf(finding);
  return quotes.length > 0 && quotes.every((quote) => STOCK_FOOTER.some((line) => line.includes(quote)));
}

export const ECHO_NOTE = 'a finding that names no changed file and quotes only the review bot\'s stock footer was dropped';

// An exec pass's findings without those about the bot's stock footer, and one note per drop. The note names no title:
// a security finding's text stays off a pull request that is not private.
export function dropBotEchoes(findings, { comments, reviewer, changes }) {
  if (!footerPosted(comments, reviewer)) return { findings: findings ?? [], notes: [] };
  const changed = new Set((changes ?? []).map((change) => change?.file).filter((file) => typeof file === 'string'));
  const kept = [];
  const notes = [];
  for (const finding of findings ?? []) {
    if (echoesFooter(finding, changed)) notes.push(ECHO_NOTE);
    else kept.push(finding);
  }
  return { findings: kept, notes };
}
