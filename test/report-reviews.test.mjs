import assert from 'node:assert/strict';
import test from 'node:test';

import { addedLines, formatReviews, formatRounds, reviewRounds } from '../plugins/aidrian/lib/report-reviews.mjs';

const BOT = 'chatgpt-codex-connector[bot]';
const LOGIN = 'chatgpt-codex-connector';

// A fake gh: merged pull requests with their reviews (GraphQL logins, no [bot]), the reactions of each, the GraphQL
// detail of each answered one, and the compares of two commits. A detail or compare that is not listed fails, as gh does.
function fakeGh(prs, { reactions = {}, details = {}, compares = {} } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr') return prs;
    if (args[0] === 'repo') return { nameWithOwner: 'acme/notes' };
    if (args[1] === 'graphql') {
      const number = Number(args.find((arg) => arg.startsWith('number=')).slice('number='.length));
      if (!details[number]) throw new Error(`gh: no detail for ${number}`);
      return { data: { repository: { pullRequest: { reviews: details[number] } } } };
    }
    const compare = /compare\/(.+)$/.exec(args[1]);
    if (compare) {
      if (!compares[compare[1]]) throw new Error('gh: HTTP 404: No common ancestor');
      return compares[compare[1]];
    }
    return reactions[/issues\/(\d+)\/reactions/.exec(args[1])[1]] ?? [];
  };
  return { gh, calls };
}

const review = (login) => ({ author: { login } });
// The detail of one review: its author, commit, and comments.
const detail = (commit, comments, { login = LOGIN, total } = {}) => ({
  author: { login }, commit: { oid: commit }, comments: { totalCount: total ?? comments.length, nodes: comments },
});
const comment = (path, line, commit, { reply = false, hunk = '@@ -1,2 +1,2 @@\n context\n+added' } = {}) => ({
  path, originalLine: line, diffHunk: hunk, replyTo: reply ? { id: 'x' } : null, originalCommit: { oid: commit },
});
const reviews = (nodes, totalCount = nodes.length) => ({ totalCount, nodes });

// The fixture the rounds alone were tested on, and the findings behind it. Pull request 1: two rounds, then a human
// review. Pull request 4: six rounds, one of them with more comments than a page holds. 2 passed clean; 3 has no answer.
const PRS = [
  { number: 1, reviews: [review(LOGIN), review(LOGIN), review('someone')] },
  { number: 2, reviews: [] },
  { number: 3, reviews: [] },
  { number: 4, reviews: Array.from({ length: 6 }, () => review(LOGIN)) },
];
const DETAILS = {
  1: reviews([
    detail('c1', [comment('src/a.js', 10, 'c1'), comment('src/a.js', 11, 'c1', { reply: true })]),
    // Round 2, at c2: line 12 was there at c1, line 20 was added since, and one comment is on the whole file.
    detail('c2', [comment('src/a.js', 12, 'c2'), comment('src/a.js', 20, 'c2'), comment('src/b.js', null, 'c2')]),
    detail('h1', [], { login: 'someone' }),
  ]),
  4: reviews([
    detail('d1', [comment('src/c.js', 1, 'd1')]),
    detail('d2', [comment('src/c.js', 5, 'd2', { hunk: '@@ -3,3 +3,2 @@\n keep\n-old line' })]),
    detail('d3', [comment('src/c.js', 3, 'd3')]),
    detail('d4', [comment('src/d.js', 1, 'd4')]),
    detail('d5', [comment('src/c.js', 2, 'd1')], { total: 120 }),
    detail('d6', [comment('src/e.js', 7, 'd6')]),
  ]),
};
const COMPARES = {
  'c1...c2': { status: 'ahead', files: [{ filename: 'src/a.js', patch: '@@ -18,2 +18,4 @@\n line 18\n line 19\n+line 20\n+line 21' }] },
  'd1...d3': { status: 'diverged', files: [] },
  'd1...d6': { status: 'ahead', files: [{ filename: 'src/other.js', patch: '@@ -1 +1 @@\n-a\n+b' }] },
};

test('the rounds are what --prs printed: the bot`s formal reviews; a bot 👍 with no review is a clean first pass; unanswered pull requests are left out', () => {
  const { gh, calls } = fakeGh(PRS, {
    reactions: { 2: [{ content: '+1', user: { login: BOT } }], 3: [{ content: '+1', user: { login: 'someone' } }] },
    details: DETAILS,
    compares: COMPARES,
  });
  const result = reviewRounds(4, BOT, gh);
  const { reviewer, merged, reviewed, clean_first_pass: clean, avg_rounds: avg, five_or_more: five } = result;
  assert.deepEqual({ reviewer, merged, reviewed, clean, avg, five }, { reviewer: BOT, merged: 4, reviewed: 3, clean: 1, avg: 2.7, five: 1 });
  assert.deepEqual(result.rounds.map(({ number, rounds }) => ({ number, rounds })), [{ number: 1, rounds: 2 }, { number: 2, rounds: 0 }, { number: 4, rounds: 6 }]);
  assert.equal(calls.filter((call) => call.includes('reactions')).length, 2, 'reactions are read only where the bot left no review');
  assert.equal(formatRounds(result), `Review rounds by ${BOT} on 3 of the last 4 merged pull requests: 33% clean on the first pass, 2.7 rounds on average, 1 needed 5 or more`);
});

test('findings per round, and late findings checked against the lines there at the first review', () => {
  const { gh, calls } = fakeGh(PRS, { reactions: { 2: [{ content: '+1', user: { login: BOT } }] }, details: DETAILS, compares: COMPARES });
  const result = reviewRounds(4, BOT, gh);
  assert.deepEqual(result.rounds.map((row) => [row.number, row.findings]), [[1, [1, 3]], [2, []], [4, [1, 1, 1, 1, 1, 1]]], 'a reply is no finding');
  assert.deepEqual(
    { findings: result.findings, rounds: result.findings_rounds, byRound: result.by_round, capped: result.capped, unread: result.unread, truncated: result.truncated },
    { findings: 10, rounds: 8, byRound: { 1: 2, 2: 4, 3: 1, '4+': 3 }, capped: 1, unread: 0, truncated: false },
  );
  // Seen: 1#12 (not added since c1), 4 at d1 itself, and 4 at d6 (its file untouched since d1). Not seen: 1#20 (added).
  assert.deepEqual(
    { late: result.late_findings, checked: result.late_checked, seen: result.late_on_seen_line, unchecked: result.late_unchecked },
    { late: 8, checked: 4, seen: 3, unchecked: { file_level: 1, deleted_line: 1, rebased: 1, missing_commit: 1, too_large: 0 } },
  );
  const compares = calls.filter((call) => call.includes('/compare/'));
  assert.deepEqual(compares, ['api repos/acme/notes/compare/c1...c2', 'api repos/acme/notes/compare/d1...d3', 'api repos/acme/notes/compare/d1...d4', 'api repos/acme/notes/compare/d1...d6'],
    'one compare per later commit; none for a finding at the first commit');
  assert.equal(formatReviews(result), [
    `Review rounds by ${BOT} on 3 of the last 4 merged pull requests: 33% clean on the first pass, 2.7 rounds on average, 1 needed 5 or more`,
    'Partial: 1 pull request had more than 100 reviews or comments in one review; the counts stop at 100.',
    'Findings: 10 in 8 rounds, 1.3 a round; round 1 2, round 2 4, round 3 1, round 4+ 3',
    'Late findings, from round 2 on: 8 (80%); 3 of 4 checked sat on a line already there at the first review (75%); ' +
      'not checked: 1 file-level, 1 on a deleted line, 1 after a rebase, 1 commit gone',
    'Most rounds: #4 6, #1 2',
  ].join('\n'));
});

test('a pull request whose findings gh cannot read is left out of the finding totals, and said so', () => {
  const { gh } = fakeGh([{ number: 7, reviews: [review(LOGIN)] }]);
  const result = reviewRounds(1, BOT, gh);
  assert.deepEqual([result.rounds, result.unread, result.findings], [[{ number: 7, rounds: 1, findings: null }], 1, 0]);
  assert.match(formatReviews(result), /\nPartial: gh could not read the findings of 1 pull request; the finding lines leave them out\.\nFindings: 0 in 0 rounds, - a round\n/);
});

test('--since keeps the pull requests merged since then, and says when --prs cut the list short', () => {
  const { gh, calls } = fakeGh([{ number: 5, reviews: [] }, { number: 6, reviews: [] }], { reactions: { 5: [{ content: '+1', user: { login: BOT } }] } });
  const result = reviewRounds(2, BOT, gh, { sinceMs: Date.parse('2026-10-22T12:00:00.500Z') });
  assert.equal(calls[0], 'pr list --state merged --limit 2 --search merged:>=2026-10-22T12:00:00+00:00 --json number,reviews');
  assert.equal(result.truncated, true);
  assert.match(formatReviews(result, { since: '7d' }), /\nPartial: 2 pull requests merged since 7d is the --prs limit; raise it for the rest\.\nFindings: 0 in 0 rounds/);
  assert.equal(reviewRounds(3, BOT, fakeGh([{ number: 5, reviews: [] }]).gh, { sinceMs: 0 }).truncated, false);
  assert.equal(reviewRounds(1, BOT, fakeGh([{ number: 5, reviews: [] }]).gh).truncated, false, 'without --since, the last N is the whole ask');
});

test('addedLines reads the new-side numbers of the added lines, across hunks', () => {
  const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10,2 +11,3 @@\n x\n+y\n\\ No newline at end of file';
  assert.deepEqual([...addedLines(patch)], [2, 3, 12]);
});

test('a gh failure is reported, not thrown, and no answered pull request says so', () => {
  const failing = reviewRounds(5, BOT, () => {
    throw new Error('gh: not logged in\nmore');
  });
  assert.deepEqual(failing, { reviewer: BOT, error: 'gh: not logged in' });
  assert.equal(formatRounds(failing), 'Review rounds: gh could not answer (gh: not logged in)');
  assert.equal(formatReviews(failing), 'Review rounds: gh could not answer (gh: not logged in)');
  assert.match(formatReviews(reviewRounds(1, BOT, fakeGh([{ number: 9, reviews: [] }]).gh)), /^Review rounds: .* answered none of the last 1 merged pull requests$/);
});
