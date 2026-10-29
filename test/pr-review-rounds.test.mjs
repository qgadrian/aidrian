import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRounds, reviewRounds } from '../plugins/aidrian/lib/pr-review-rounds.mjs';

const BOT = 'chatgpt-codex-connector[bot]';

// A fake gh: merged pull requests with their reviews (GraphQL logins, no [bot]), and the reactions of each.
function fakeGh(prs, reactions = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr') return prs;
    if (args[0] === 'repo') return { nameWithOwner: 'acme/notes' };
    return reactions[/issues\/(\d+)\/reactions/.exec(args[1])[1]] ?? [];
  };
  return { gh, calls };
}

test('rounds count the bot`s formal reviews; a bot 👍 with no review is a clean first pass; unanswered pull requests are left out', () => {
  const review = (login) => ({ author: { login } });
  const { gh, calls } = fakeGh(
    [
      { number: 1, reviews: [review('chatgpt-codex-connector'), review('chatgpt-codex-connector'), review('someone')] },
      { number: 2, reviews: [] },
      { number: 3, reviews: [] },
      { number: 4, reviews: Array.from({ length: 6 }, () => review('chatgpt-codex-connector')) },
    ],
    { 2: [{ content: '+1', user: { login: BOT } }], 3: [{ content: '+1', user: { login: 'someone' } }] },
  );
  const result = reviewRounds(4, BOT, gh);
  assert.deepEqual(result, {
    reviewer: BOT, merged: 4, reviewed: 3, clean_first_pass: 1, avg_rounds: 2.7, five_or_more: 1,
    rounds: [{ number: 1, rounds: 2 }, { number: 2, rounds: 0 }, { number: 4, rounds: 6 }],
  });
  assert.equal(calls.filter((call) => call.includes('reactions')).length, 2, 'reactions are read only where the bot left no review');
  assert.equal(formatRounds(result), `Review rounds by ${BOT} on 3 of the last 4 merged pull requests: 33% clean on the first pass, 2.7 rounds on average, 1 needed 5 or more`);
});

test('a gh failure is reported, not thrown, and no answered pull request says so', () => {
  const failing = reviewRounds(5, BOT, () => {
    throw new Error('gh: not logged in\nmore');
  });
  assert.deepEqual(failing, { reviewer: BOT, error: 'gh: not logged in' });
  assert.equal(formatRounds(failing), 'Review rounds: gh could not answer (gh: not logged in)');
  assert.match(formatRounds(reviewRounds(1, BOT, fakeGh([{ number: 9, reviews: [] }]).gh)), /answered none of the last 1 merged/);
});
