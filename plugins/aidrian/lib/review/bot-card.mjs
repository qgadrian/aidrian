// The review bot's status card on a pull request, read the same way by `aidrian pr await-review` (pr-await-review.mjs) and
// by merge trust (merge-trust.mjs). Kept apart, with no import, so a hook rule that reads it loads nothing that runs gh.

// The bot's review-summary status card. It is created once per pull request and edited in place as runs progress, and
// its "Completed" edit lands after the real signal, so it is never the signal at any status. Created at or after a
// trigger, it does say the bot started, so `acknowledgement` reads it then. Matched on the stable machine marker.
export const REVIEW_SUMMARY_CARD_MARKER = '<!-- codex-pull-request-review-summary -->';
export const isReviewSummaryCard = (body) => typeof body === 'string' && body.includes(REVIEW_SUMMARY_CARD_MARKER);

// The status card's machine state, `<!-- codex-review-state:v1 {...} -->`: its `code_review` names the commit the review
// ran on, its status, and whether it left unresolved findings. Null when the card carries none or it does not parse.
const REVIEW_STATE_PATTERN = /<!--\s*codex-review-state:v1\s+(.*?)\s*-->/su;
export const cardState = (body) => {
  const json = typeof body === 'string' ? body.match(REVIEW_STATE_PATTERN)?.[1] : null;
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// The bot's out-of-credits reply: an ordinary comment, by the same author, that names the condition.
export const QUOTA_NOTICE_PATTERN = /codex usage limits?/i;
export const isQuotaNotice = (body) => typeof body === 'string' && QUOTA_NOTICE_PATTERN.test(body);

// The bot names the commit it reviewed in its answer: `**Reviewed commit:** \`cdc936e80c\``, a short SHA.
export const REVIEWED_COMMIT_PATTERN = /Reviewed commit:\**\s*`([0-9a-f]{7,40})`/i;
export const reviewedCommit = (body) => (typeof body === 'string' ? body.match(REVIEWED_COMMIT_PATTERN)?.[1] ?? null : null);

// The bot's receipt: on every clean pass it posts this conversation comment, naming the commit it reviewed, and adds
// its 👍 to the pull request a few seconds later. Its footer quotes "@codex review", so it is never a trigger.
export const RECEIPT_MARKER = '<!-- codex-review-receipt:v1 -->';
export const isReceipt = (body) => typeof body === 'string' && body.trimStart().startsWith(RECEIPT_MARKER);

// Whether a comment is the bot's clean receipt, matched on its layout, never on its words anywhere: it opens with the
// receipt marker, the text after it opens with "Codex Review: Didn't find any major issues", and it names the reviewed
// commit. A comment that only quotes the phrase, such as a finding about a screen that shows it, is never clean.
const CLEAN_RECEIPT_LEAD = /^Codex Review: Didn['’]t find any major issues\b/u;
export const isCleanReceipt = (body) => {
  if (!isReceipt(body) || isQuotaNotice(body)) return false;
  const rest = body.trimStart().slice(RECEIPT_MARKER.length).trimStart();
  return CLEAN_RECEIPT_LEAD.test(rest) && reviewedCommit(rest) !== null;
};
