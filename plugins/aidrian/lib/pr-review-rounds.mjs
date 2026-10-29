// Review rounds on the last N merged pull requests, for `aidrian report --prs N`: how many formal reviews the bot
// (config.json `pr.reviewer`) left on each, and how many passed clean on the first look (its 👍 and no review).
// A pull request the bot never answered is left out. Read-only; needs gh.

import { execFileSync } from 'node:child_process';

const ghJson = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));

// gh's GraphQL fields name a bot without the `[bot]` suffix its REST fields carry.
const sameLogin = (login, reviewer) => typeof login === 'string' && login.replace(/\[bot\]$/u, '') === reviewer.replace(/\[bot\]$/u, '');

// { reviewer, merged, reviewed, clean_first_pass, avg_rounds, five_or_more, rounds: [{ number, rounds }] }, or
// { reviewer, error } when gh cannot answer.
export function reviewRounds(limit, reviewer, gh = ghJson) {
  try {
    const prs = gh(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,reviews']);
    const repo = gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
    const rounds = [];
    for (const pr of prs) {
      const count = (pr.reviews ?? []).filter((review) => sameLogin(review.author?.login, reviewer)).length;
      if (count > 0) rounds.push({ number: pr.number, rounds: count });
      else if (gh(['api', `repos/${repo}/issues/${pr.number}/reactions`]).some((r) => r.content === '+1' && sameLogin(r.user?.login, reviewer))) {
        rounds.push({ number: pr.number, rounds: 0 });
      }
    }
    const total = rounds.reduce((sum, row) => sum + row.rounds, 0);
    return {
      reviewer,
      merged: prs.length,
      reviewed: rounds.length,
      clean_first_pass: rounds.filter((row) => row.rounds === 0).length,
      avg_rounds: rounds.length ? Math.round((total / rounds.length) * 10) / 10 : null,
      five_or_more: rounds.filter((row) => row.rounds >= 5).length,
      rounds,
    };
  } catch (error) {
    return { reviewer, error: String(error.message ?? error).split('\n')[0] };
  }
}

export function formatRounds(result) {
  if (result.error) return `Review rounds: gh could not answer (${result.error})`;
  if (!result.reviewed) return `Review rounds: ${result.reviewer} answered none of the last ${result.merged} merged pull requests`;
  const share = Math.round((result.clean_first_pass / result.reviewed) * 100);
  return `Review rounds by ${result.reviewer} on ${result.reviewed} of the last ${result.merged} merged pull requests: ` +
    `${share}% clean on the first pass, ${result.avg_rounds} rounds on average, ${result.five_or_more} needed 5 or more`;
}
