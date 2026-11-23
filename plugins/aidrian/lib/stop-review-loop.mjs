// The review-loop check behind the Stop hook: a main-session turn that opened or updated a draft pull request, under
// config.json `github.reviewLoop` "auto", and ran no review after it. A direct run of a skill such as issue-implement
// ends at the draft and its report, and the turn then stopped there, so the review loop, marking the draft ready, and
// auto-merge never ran. The hook sends the agent back once, to run the loop as the session's own step.
// docs/hooks.md#review-loop-check describes it.
//
// The turn is what lib/transcript.mjs turnActions reads: since the Human's last prompt, so a draft opened before the
// Human wrote, such as before a request to stop, never counts. Pure: the hook passes in the payload and the actions.

import { backgroundRunning } from './stop-announce.mjs';

// The reason's first sentence, by which the Stop hook knows its send-back in the transcript (hook-stop.mjs).
export const REVIEW_LOOP_LEAD = 'This turn opened or updated a draft pull request and ran no review after it.';

// Why the agent is sent back, or null. `actions` is turnActions' result, or null with no transcript to read; `reviewLoop`
// is config.json `github.reviewLoop`; `human` the name config.json `names` gives (docs/config.md#names). Null unless the
// loop is "auto", no background task still runs, and a draft action of the turn has no review action of its pull request
// after it, nor a merge of it: a merged pull request owes no review. A merge action's `pr` is 0 for a `gh pr merge` that
// names none (the current branch's), read as none here. A draft and a review are of the same pull request when both name it, or either names none (`pr` null or
// missing): a false send-back costs more than a missed one. The loop's own update after its review, as when it copies
// residuals into the body through pr-write before it marks the draft ready, is no draft action (transcript.mjs
// turnActions), so a draft after a review is a new pull request, or an update of another. The reason names every draft
// still owed, once each, by its number, or as one with no number shown, so its one send-back in the turn asks for each.
const pullOf = (action) => (Number.isSafeInteger(action?.pr) && action.pr > 0 ? action.pr : null);
const SETTLES = new Set(['review', 'merge']);
const samePull = (a, b) => a === null || b === null || a === b;
export function reviewLoopOwed(input, actions, { reviewLoop, human = 'the Human' } = {}) {
  if (reviewLoop !== 'auto' || !Array.isArray(actions) || backgroundRunning(input)) return null;
  const owed = actions.filter((action, at) => action?.kind === 'draft'
    && !actions.slice(at + 1).some((later) => SETTLES.has(later?.kind) && samePull(pullOf(later), pullOf(action))));
  if (!owed.length) return null;
  const numbers = [...new Set(owed.map(pullOf).filter((pr) => pr !== null))].map((pr) => `#${pr}`);
  const unnumbered = owed.filter((action) => pullOf(action) === null).length;
  const names = [...numbers, ...(unnumbered ? [unnumbered === 1 ? 'a draft with no number shown' : `${unnumbered} drafts with no number shown`] : [])];
  const several = numbers.length + unnumbered > 1;
  return `${REVIEW_LOOP_LEAD} ${several ? 'The drafts owed a review' : 'The draft owed a review'}: ${names.join(', ')}. ` +
    `config.json \`github.reviewLoop\` is "auto", so run the \`pr-review-loop\` skill on ${several ? 'each' : 'it'} now, as the session's own step and not ` +
    'as a step of the skill that opened it: its last step marks the draft ready as `github.markReady` says and runs ' +
    '`pr-auto-merge`, which merges only when `aidrian pr auto-merge <n>` exits 0. ' +
    'End the turn again instead when a skill or agent that runs its own review loop owns the pull request, ' +
    'when no pull request was opened or updated, when the run is stopped on a question only ' +
    `${human} can answer, or when ${human} asked the run to stop at the draft.`;
}
