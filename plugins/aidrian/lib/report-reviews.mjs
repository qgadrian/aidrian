// `aidrian report reviews`, and `aidrian report --prs N`: the review bot's rounds on the last N merged pull requests, its
// findings per round, and its late findings. config.json `github.reviewer` names the bot. A round is one formal review by
// the bot; a pull request it answered with its 👍 and no review passed clean, in 0 rounds; one it never answered is left
// out. A finding is a top-level comment in one of its reviews; a late finding is one from round 2 on, and it sits on a
// line already reviewed when that line was there at the bot's first review. Read-only; needs gh.
// docs/dispatch-log.md#reviews describes the view.

import { forgeFor, REVIEWS_PAGE as PAGE } from './forges/index.mjs';

// gh's GraphQL fields name a bot without the `[bot]` suffix its REST fields carry.
const sameLogin = (login, reviewer) => typeof login === 'string' && login.replace(/\[bot\]$/u, '') === reviewer.replace(/\[bot\]$/u, '');

// GitHub's compare of two commits lists at most this many files.
const COMPARE_FILES = 300;
// The view lists this many pull requests, most rounds first.
const TOP_PRS = 5;
// The error of reviewRounds() for a project that runs no review bot (config.json `github.reviewer` null or "none").
export const NO_BOT = 'no review bot is set (github.reviewer is null)';

// Why a late finding was not checked, in the order the view names them.
const UNCHECKED = { file_level: 'file-level', deleted_line: 'on a deleted line', rebased: 'after a rebase', missing_commit: 'commit gone', too_large: 'diff too large' };

// { reviewer, merged, reviewed, clean_first_pass, avg_rounds, five_or_more, rounds: [{ number, rounds, findings }], ... },
// or { reviewer, error } when gh cannot answer. The first seven fields are the review rounds alone; `findings` lists a
// pull request's findings per round, and is null when gh could not read them. `sinceMs`, when set, keeps the pull
// requests merged since then; `truncated` says the limit cut that list short. `forge` reads the repository: pass the
// project root's (forgeFor), so that `--project` reads that project's repository, not the one the shell is in.
export function reviewRounds(limit, reviewer, forge = forgeFor(undefined), { sinceMs = null } = {}) {
  if (reviewer === null) return { reviewer, error: NO_BOT };
  try {
    const prs = forge.mergedChanges(limit, { sinceMs });
    const repo = forge.repo();
    const rounds = [];
    for (const pr of prs) {
      const count = (pr.reviews ?? []).filter((review) => sameLogin(review.author?.login, reviewer)).length;
      if (count > 0) rounds.push({ number: pr.number, rounds: count });
      else if (forge.reactions(repo, pr.number, '+1').some((r) => r.content === '+1' && sameLogin(r.user?.login, reviewer))) {
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
      ...findingsOf(rounds, repo, reviewer, forge),
      truncated: sinceMs !== null && prs.length >= limit,
    };
  } catch (error) {
    return { reviewer, error: String(error.message ?? error).split('\n')[0] };
  }
}

// Reads the findings of each pull request in `rounds` that has a round, sets its `findings`, and returns the totals:
// { findings, findings_rounds, by_round, late_findings, late_checked, late_on_seen_line, late_unchecked, capped, unread }.
// `by_round` buckets rounds 4 and later as `4+`; `capped` counts pull requests whose lists stopped at PAGE, and `unread`
// those gh could not read, which the finding totals leave out.
function findingsOf(rounds, repo, reviewer, forge) {
  const totals = {
    findings: 0, findings_rounds: 0, by_round: {}, late_findings: 0, late_checked: 0, late_on_seen_line: 0,
    late_unchecked: Object.fromEntries(Object.keys(UNCHECKED).map((key) => [key, 0])), capped: 0, unread: 0,
  };
  for (const row of rounds) {
    if (row.rounds === 0) {
      row.findings = [];
      continue;
    }
    let detail;
    try {
      detail = botReviews(repo, row.number, reviewer, forge);
    } catch {
      row.findings = null;
      totals.unread += 1;
      continue;
    }
    if (detail.capped) totals.capped += 1;
    row.findings = detail.reviews.map((review) => review.findings.length);
    const first = detail.reviews[0]?.commit ?? null;
    const compare = comparer(repo, first, forge);
    detail.reviews.forEach((review, index) => {
      const bucket = index >= 3 ? '4+' : String(index + 1);
      totals.by_round[bucket] = (totals.by_round[bucket] ?? 0) + review.findings.length;
      totals.findings += review.findings.length;
      totals.findings_rounds += 1;
      if (index === 0) return;
      for (const finding of review.findings) {
        totals.late_findings += 1;
        const seen = onSeenLine(finding, first, compare);
        if (typeof seen === 'string') totals.late_unchecked[seen] += 1;
        else {
          totals.late_checked += 1;
          if (seen) totals.late_on_seen_line += 1;
        }
      }
    });
  }
  return totals;
}

// The bot's reviews on pull request `number`, oldest first, each with its commit and findings, and whether a list
// stopped at PAGE: { reviews: [{ commit, findings: [{ path, line, commit, deleted }] }], capped }. A finding's `line` and
// `commit` are where the bot left it; `line` is null for a comment on the whole file.
function botReviews(repo, number, reviewer, forge) {
  const response = forge.reviewsWithComments(repo, number);
  const list = response?.data?.repository?.pullRequest?.reviews;
  if (!list || !Array.isArray(list.nodes)) throw new Error(`no reviews for pull request ${number}`);
  let capped = list.totalCount > list.nodes.length;
  const reviews = list.nodes.filter((review) => sameLogin(review?.author?.login, reviewer)).map((review) => {
    const comments = review.comments ?? { totalCount: 0, nodes: [] };
    if (comments.totalCount > comments.nodes.length) capped = true;
    return {
      commit: review.commit?.oid ?? null,
      findings: comments.nodes.filter((comment) => !comment.replyTo).map((comment) => ({
        path: comment.path,
        line: Number.isInteger(comment.originalLine) ? comment.originalLine : null,
        commit: comment.originalCommit?.oid ?? null,
        // A diff hunk ends at the line the comment is on; a `-` line was deleted, and its number counts the old side.
        deleted: (comment.diffHunk ?? '').trimEnd().split('\n').at(-1).startsWith('-'),
      })),
    };
  });
  return { reviews, capped };
}

// compare(head): GitHub's compare of `first` with `head`, read once per head, or null when gh cannot read it.
function comparer(repo, first, forge) {
  const diffs = new Map();
  return (head) => {
    if (!diffs.has(head)) {
      try {
        diffs.set(head, forge.compare(repo, first, head));
      } catch {
        diffs.set(head, null);
      }
    }
    return diffs.get(head);
  };
}

// Whether a late finding sits on a line that was already there at `first`, the commit of the bot's first review: true or
// false, or the UNCHECKED key that says why it cannot tell. The compare of `first` with the finding's commit lists the
// lines added since; a line it does not add was there. A compare that is not a straight line forward, after a rebase or
// a force push, cannot tell.
function onSeenLine(finding, first, compare) {
  if (finding.line === null) return 'file_level';
  if (finding.deleted) return 'deleted_line';
  if (!finding.commit || !first) return 'missing_commit';
  if (finding.commit === first) return true;
  const diff = compare(finding.commit);
  if (!diff) return 'missing_commit';
  if (diff.status !== 'ahead' && diff.status !== 'identical') return 'rebased';
  const files = Array.isArray(diff.files) ? diff.files : [];
  const file = files.find((each) => each.filename === finding.path);
  if (!file) return files.length >= COMPARE_FILES ? 'too_large' : true;
  return typeof file.patch === 'string' ? !addedLines(file.patch).has(finding.line) : 'too_large';
}

// The line numbers, on the new side, of the lines a unified diff adds.
export function addedLines(patch) {
  const added = new Set();
  let line = 0;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith('+')) added.add(line++);
    else if (text.startsWith(' ')) line += 1;
  }
  return added;
}

// The review rounds line, which `aidrian report --prs N` printed alone before findings were read.
export function formatRounds(result) {
  if (result.error === NO_BOT) return `Review rounds: ${NO_BOT}`;
  if (result.error) return `Review rounds: gh could not answer (${result.error})`;
  if (!result.reviewed) return `Review rounds: ${result.reviewer} answered none of the last ${result.merged} merged pull requests`;
  const share = Math.round((result.clean_first_pass / result.reviewed) * 100);
  return `Review rounds by ${result.reviewer} on ${result.reviewed} of the last ${result.merged} merged pull requests: ` +
    `${share}% clean on the first pass, ${result.avg_rounds} rounds on average, ${result.five_or_more} needed 5 or more`;
}

const percent = (part, whole) => (whole ? ` (${Math.round((part / whole) * 100)}%)` : '');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The view: the rounds line, what the counts leave out, the findings per round, the late findings, and the pull requests
// with the most rounds. `since` is the --since text, or null.
export function formatReviews(result, { since = null } = {}) {
  const lines = [formatRounds(result)];
  if (result.error || !result.reviewed) return lines.join('\n');
  if (result.truncated) lines.push(`Partial: ${result.merged} pull requests merged since ${since} is the --prs limit; raise it for the rest.`);
  if (result.capped) lines.push(`Partial: ${plural(result.capped, 'pull request')} had more than ${PAGE} reviews or comments in one review; the counts stop at ${PAGE}.`);
  if (result.unread) lines.push(`Partial: gh could not read the findings of ${plural(result.unread, 'pull request')}; the finding lines leave them out.`);
  const rounds = Object.entries(result.by_round).map(([round, count]) => `round ${round} ${count}`).join(', ');
  const perRound = result.findings_rounds ? (result.findings / result.findings_rounds).toFixed(1) : '-';
  lines.push(`Findings: ${result.findings} in ${plural(result.findings_rounds, 'round')}, ${perRound} a round${rounds ? `; ${rounds}` : ''}`);
  const unchecked = Object.entries(result.late_unchecked).filter(([, count]) => count).map(([key, count]) => `${count} ${UNCHECKED[key]}`);
  lines.push(
    `Late findings, from round 2 on: ${result.late_findings}${percent(result.late_findings, result.findings)}; ` +
      `${result.late_on_seen_line} of ${result.late_checked} checked sat on a line already there at the first review` +
      `${percent(result.late_on_seen_line, result.late_checked)}${unchecked.length ? `; not checked: ${unchecked.join(', ')}` : ''}`,
  );
  const top = [...result.rounds].filter((row) => row.rounds > 0).sort((a, b) => b.rounds - a.rounds || b.number - a.number).slice(0, TOP_PRS);
  if (top.length) lines.push(`Most rounds: ${top.map((row) => `#${row.number} ${row.rounds}`).join(', ')}`);
  return lines.join('\n');
}

// The checks at the review-round cap (lib/review/extension.mjs), from the dispatch log's `review_extension` rows written
// since `sinceMs`. Each pull request's round counts once, by its last decision: { checks, over_flags, granted_over_flags,
// signals, stopped_by_signals, stopped_by_judge, stopped_by_ceiling, granted, granted_by_human, denied, waiting }.
// `over_flags` counts the checks whose last row carries red flags, which go to the judge, and `granted_over_flags` those
// granted all the same; `signals` counts each red flag. `stopped_by_signals` counts the mechanical stops of rows from
// older versions, and `unreadable` is such a stop whose history held no signal.
export function extensionSummary(rows, { sinceMs = 0 } = {}) {
  const last = new Map();
  for (const row of rows ?? []) {
    if (row?.event !== 'review_extension' || !(Date.parse(row.ts) >= sinceMs)) continue;
    last.set(`${row.repo}#${row.pr}:${row.source}:${row.round}`, row);
  }
  const decided = [...last.values()];
  const count = (keep) => decided.filter(keep).length;
  const flagged = (row) => Array.isArray(row.signals) && row.signals.length > 0;
  const mechanical = (row) => row.outcome === 'stopped' && row.by === 'mechanical';
  const signals = {};
  for (const row of decided.filter((each) => flagged(each) || mechanical(each))) {
    for (const name of flagged(row) ? row.signals : ['unreadable']) signals[name] = (signals[name] ?? 0) + 1;
  }
  return {
    checks: decided.length,
    over_flags: count(flagged),
    granted_over_flags: count((row) => flagged(row) && row.outcome === 'granted'),
    signals,
    stopped_by_signals: count(mechanical),
    stopped_by_judge: count((row) => row.outcome === 'stopped' && row.by === 'judge'),
    stopped_by_ceiling: count((row) => row.outcome === 'stopped' && row.by === 'ceiling'),
    granted: count((row) => row.outcome === 'granted'),
    granted_by_human: count((row) => row.outcome === 'granted' && row.by === 'human'),
    denied: count((row) => row.outcome === 'denied'),
    waiting: count((row) => row.outcome === 'judging' || row.outcome === 'asking'),
  };
}

// The extra-rounds line of the reviews view, or null when no check ran in the window.
export function formatExtensions(summary, { since = null } = {}) {
  if (!summary?.checks) return null;
  const flags = Object.entries(summary.signals).map(([name, count]) => `${name} ${count}`).join(', ');
  const mechanical = summary.stopped_by_signals ? `${summary.stopped_by_signals} stopped by the signals, ` : '';
  return `Extra rounds${since ? ` since ${since}` : ''}: ${plural(summary.checks, 'check')} at the round cap; ` +
    `${summary.over_flags} with red flags${flags ? ` (${flags})` : ''}, ${summary.granted_over_flags} granted over them; ` +
    `${mechanical}${summary.stopped_by_judge} stopped by the judge, ` +
    `${summary.stopped_by_ceiling} at the ceiling; ${summary.granted} granted (${summary.granted_by_human} by the Human), ` +
    `${summary.denied} denied, ${summary.waiting} waiting`;
}
