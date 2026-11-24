// The review bot's own comments as a local reviewer may report them. A pass's input (dispatch.mjs passInput) carries no
// pull request conversation, but Codex reads it with its own shell, and its prompt calls review comments data to review
// (reviewers.mjs REQUEST_BRIEF): it raised the receipt's stock footer, `Try commenting "@codex address that feedback"`,
// as a request in a comment (#674). So where an exec pass's findings are recorded (stages.mjs), a finding that names no
// changed file and quotes only text of a receipt or status card the configured bot account posted is dropped, with a
// note. A marker proves nothing about who wrote a comment, so only the bot's own comments count, and a finding that
// quotes nothing, or quotes any text they do not hold, stays.

import { isReviewSummaryCard } from './bot-card.mjs';
import { RECEIPT_MARKER } from './request-text.mjs';

// A quoted span: in backticks, straight double quotes, or curly double quotes, on one line.
const QUOTED = /`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/gu;
// Punctuation and space a quote may carry at its ends, as `“@codex address that feedback,”`.
const EDGES = /^[\s.,;:!?]+|[\s.,;:!?]+$/gu;
// Shorter spans prove nothing: three letters match almost any comment.
const MIN_QUOTE = 4;

// The bodies of the receipts and status cards `reviewer`, the review bot's account (`github.reviewer`), posted.
export function botTexts(comments, reviewer) {
  if (typeof reviewer !== 'string' || !reviewer) return [];
  const own = (comment) => comment?.user?.login === reviewer && typeof comment.body === 'string';
  const ofBot = (body) => body.trimStart().startsWith(RECEIPT_MARKER) || isReviewSummaryCard(body);
  return (Array.isArray(comments) ? comments : []).filter(own).map((comment) => comment.body).filter(ofBot);
}

// The quoted spans of a finding's title and body, their edges trimmed, each at least MIN_QUOTE characters.
export function quotesOf(finding) {
  const text = `${finding?.title ?? ''}\n${finding?.body ?? ''}`;
  return [...text.matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? match[3]).replace(EDGES, '')).filter((quote) => quote.length >= MIN_QUOTE);
}

// Whether `finding` is about the bot's own comments only: it names no file of `changed` (a Set of the change's files),
// quotes at least one span, and every span it quotes is in one of `texts` (botTexts).
export function echoesBot(finding, texts, changed) {
  if (!texts.length || (typeof finding?.file === 'string' && changed.has(finding.file))) return false;
  const quotes = quotesOf(finding);
  return quotes.length > 0 && quotes.every((quote) => texts.some((text) => text.includes(quote)));
}

export const ECHO_NOTE = 'a finding that names no changed file and quotes only the review bot\'s own receipt or status card was dropped';

// An exec pass's findings without those about the bot's own comments, and one note per drop. The note names no title:
// a security finding's text stays off a pull request that is not private.
export function dropBotEchoes(findings, { comments, reviewer, changes }) {
  const texts = botTexts(comments, reviewer);
  const changed = new Set((changes ?? []).map((change) => change?.file).filter((file) => typeof file === 'string'));
  const kept = [];
  const notes = [];
  for (const finding of findings ?? []) {
    if (echoesBot(finding, texts, changed)) notes.push(ECHO_NOTE);
    else kept.push(finding);
  }
  return { findings: kept, notes };
}
