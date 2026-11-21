// The text of the harness's request to the review bot, which `aidrian pr await-review` posts (pr-await-review.mjs
// requestCommentBody), and which the local review's prompt quotes so it can tell that request from any other comment
// (reviewers.mjs REQUEST_BRIEF). A leaf module: reviewers.mjs cannot import pr-await-review.mjs, which loads it back
// through in-force.mjs.
export const REQUEST_COMMENT = '@codex review';

// What the request asks for after the trigger phrase. A bare "@codex review" returned about two findings per review,
// and most later-round findings were copies of a mistake an earlier round had named, so this asks for the whole
// review in one pass and for every copy in one finding. Codex reads free text after the trigger as that review's focus.
export const REQUEST_INSTRUCTIONS = [
  'Perform a thorough review of the complete PR. Inspect relevant surrounding',
  'code and affected call paths, not only the changed lines.',
  '',
  'Check for correctness, regressions, edge cases, concurrency issues,',
  'error handling, security, data consistency, performance, API compatibility,',
  'and missing tests.',
  '',
  'Continue reviewing after finding issues and complete the full review before',
  'reporting findings.',
  '',
  'When you find an issue, search the whole PR for the same mistake and list',
  'every other location in that one finding.',
].join('\n');

// The request as the harness posts it, before the markers it adds after it.
export const REQUEST_TEXT = `${REQUEST_COMMENT}\n\n${REQUEST_INSTRUCTIONS}`;
