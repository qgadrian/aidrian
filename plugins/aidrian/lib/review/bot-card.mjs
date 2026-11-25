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

// A failed run's identity, which the review record keeps once a step counted it (stages.mjs `failedRuns`, which
// publish.mjs checks against this pattern): a notice's comment id, or the status card's id and the instant of its edit
// to `failed`. Null when the forge gave no id.
export const FAILURE_ID_PATTERN = /^(?:comment:\d+|card:\d+@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/u;
export const failureId = ({ comment = null, card = null }) => {
  const id = comment ? `comment:${comment.id}` : card ? `card:${card.id}@${card.updated_at ?? card.created_at}` : null;
  return id && FAILURE_ID_PATTERN.test(id) ? id : null;
};
