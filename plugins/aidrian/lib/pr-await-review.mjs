// `aidrian pr await-review`: wait, deterministically, for the Codex review bot (config.json `github.reviewer`) to finish
// with a pull request, then report what it left behind. The bot reviews once per "@codex review" comment, 5 to 25
// minutes later; opening a pull request or marking it ready triggers nothing; a later push is not re-reviewed; and a
// clean pass is a 👍 on the pull request instead of a review. A prose rule cannot hold that, so this command does:
//
//   1. Resolve the pull request (argument, URL, or current branch) and its head commit.
//   2. Find the latest trigger: the last "@codex review" comment.
//   3. Find the latest bot signal after it: a review (its commit and line-comment count), a 👍, or a bot comment.
//      A 👀 (on the pull request, or on the trigger comment, where the bot puts it) means the bot started; it is
//      reported as `acknowledged_at`, never as a finished signal. The usage-limit notice ends the wait as
//      `blocked_quota`; the review-summary status card is never a signal.
//   4. With --request: when there is no signal, or it covers an older commit than head, post "@codex review" once,
//      recording the head it asks about, unless a 👀 already acknowledges a trigger for this head.
//   5. Poll until a signal covers the current head or the timeout ends. Head is re-read on every poll; with
//      --request the bot is asked once per new head.
//   7. GitHub can report the old head for minutes after a push. When the checkout tracks the pull request's branch in
//      its repository, the head it waits for is that upstream commit (or --head <sha>): while GitHub reports an
//      ancestor of it, nothing counts as covered and nothing is posted, so a review of the previous head never answers
//      for the push.
//   0. With --request and config.json `github.reviewGate` on: post nothing and end with `review_required` until a review
//      is on record (lib/review-gate.mjs), and put the record's marker in the request.
//   6. With --request: at --max-rounds bot reviews (config.json `github.maxReviewRounds`) post nothing and end with
//      `round_limit`; a long run of rounds is a design problem more review will not fix. Raising --max-rounds past
//      the config value is the Human's call: it needs ROUNDS_OVERRIDE set in their own shell (roundCapProblem), whatever
//      reviews the pull request. A raised limit is recorded in the request comment, and later runs keep the highest one.
//   8. With config.json `github.reviewRequest: "automatic"`, the connector reviews by its own Automatic review setting:
//      nothing is ever posted, with or without --request. --request still ends at round_limit, and steps 3, 5, and 7
//      run as above; a timeout carries a hint naming the connector settings to check.
//
// stdout: one JSON object. Exit 0 received | already_present | no_reviewer, 2 timed_out (re-run once without --request
// when `retry_recommended` is true), 3 blocked_quota, 4 round_limit, 5 review_required, 1 error. Read-only except the
// --request comment (none when automatic) and,
// at round_limit, a lesson in the local lesson inbox (lib/lesson-signals.mjs). With no review bot (config.json
// `github.reviewer` null or "none", or `--reviewer none`) it ends at once as `no_reviewer`: it runs no gh, posts nothing,
// and waits for nothing.
// The default timeout is 840 s: a foreground Claude Code Bash call stops at 900 s, gh calls included.

import { DEFAULTS as CONFIG_DEFAULTS, NO_REVIEWER } from './config.mjs';
import { runGh } from './gh.mjs';
import { runGit } from './git.mjs';

export const DEFAULT_REVIEWER = CONFIG_DEFAULTS.github.reviewer;
export const REQUEST_COMMENT = '@codex review';
export const DEFAULTS = Object.freeze({ timeoutSec: 840, intervalSec: 60, maxRounds: CONFIG_DEFAULTS.github.maxReviewRounds, reviewRequest: CONFIG_DEFAULTS.github.reviewRequest });

// What a timeout says when the bot reviews on its own: the harness asked for nothing, so only the bot's settings can.
export const AUTOMATIC_HINT =
  'config.json github.reviewRequest is "automatic", so nothing asked the bot for this review. Check that the Codex ' +
  'connector\'s Automatic review is on for this repository (Codex settings > Personal preferences) and that its Review ' +
  'trigger covers this pull request and push, then run this again. Never post a review request instead.';

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

// A limit above the default, recorded in the request comment that used it.
export const MAX_ROUNDS_PATTERN = /<!--\s*pr-await-review:\s*max-rounds=(\d+)\s*-->/i;

// The highest limit an earlier request on the pull request recorded, or null. Only a request counts, so quoting the
// marker in prose raises nothing.
export const recordedMaxRounds = (issueComments) =>
  (issueComments ?? []).reduce((best, c) => {
    const body = typeof c?.body === 'string' ? c.body : '';
    if (!body.trimStart().toLowerCase().startsWith(REQUEST_COMMENT)) return best;
    const n = Number(body.match(MAX_ROUNDS_PATTERN)?.[1]);
    return Number.isInteger(n) && n > (best ?? 0) ? n : best;
  }, null);

// The bot's reviews on the pull request: one per round that reported findings.
export const codexRounds = (reviews, reviewer) => (reviews ?? []).filter((r) => r?.user?.login === reviewer).length;

// The head SHA a trigger was posted for, recorded as an HTML comment: GitHub renders nothing, and the body still opens
// with the exact phrase the bot matches. A 👀 names no commit, and a commit made before the bot acknowledged the
// previous trigger but pushed after it was never seen, so the acknowledgement covers exactly the recorded SHA.
// The pattern accepts short hex so fixtures stay readable; this command always writes the full SHA.
export const TRIGGER_HEAD_PATTERN = /<!--\s*pr-await-review:\s*head=([0-9a-f]{3,40})\s*-->/i;
export const triggerHeadSha = (body) => (typeof body === 'string' ? body.match(TRIGGER_HEAD_PATTERN)?.[1] ?? null : null);
export const requestCommentBody = (headSha, maxRounds = DEFAULTS.maxRounds, reviewMarker = null) => {
  const request = `${REQUEST_COMMENT}\n\n${REQUEST_INSTRUCTIONS}`;
  const marked = headSha ? `${request}\n\n<!-- pr-await-review: head=${headSha} -->` : request;
  const rounds = maxRounds > DEFAULTS.maxRounds ? `${marked}\n<!-- pr-await-review: max-rounds=${maxRounds} -->` : marked;
  return reviewMarker ? `${rounds}\n${reviewMarker}` : rounds;
};

// The bot's out-of-credits reply: an ordinary comment, by the same author, that names the condition.
export const QUOTA_NOTICE_PATTERN = /codex usage limits?/i;
export const isQuotaNotice = (body) => typeof body === 'string' && QUOTA_NOTICE_PATTERN.test(body);

// The bot's review-summary status card. It is created once per pull request and edited in place as runs progress, and
// its "Completed" edit lands after the real signal, so it is never the signal at any status. Created at or after a
// trigger, it does say the bot started, so `acknowledgement` reads it then. Matched on the stable machine marker.
export const REVIEW_SUMMARY_CARD_MARKER = '<!-- codex-pull-request-review-summary -->';
export const isReviewSummaryCard = (body) => typeof body === 'string' && body.includes(REVIEW_SUMMARY_CARD_MARKER);

// Process exit code for a terminal status.
export const exitCodeFor = (status) => {
  if (status === 'timed_out') return 2;
  if (status === 'blocked_quota') return 3;
  if (status === 'round_limit') return 4;
  if (status === 'review_required') return 5;
  return 0;
};

// The variable the Human sets, in their own shell before the session starts, to let --max-rounds go past config.json
// `github.maxReviewRounds`. An agent never sets it: more rounds is a decision the cap exists to hand back.
export const ROUNDS_OVERRIDE = 'AIDRIAN_ALLOW_EXTRA_ROUNDS';

// Why `maxRounds` may not run, or null: a cap above the project's `cap` without ROUNDS_OVERRIDE in `env`. It judges the
// command's own flag, so it holds for any reviewer the command waits on; a lower cap always runs.
export function roundCapProblem(maxRounds, cap, env = process.env) {
  if (maxRounds <= cap || env[ROUNDS_OVERRIDE] === '1') return null;
  return `--max-rounds ${maxRounds} goes past config.json github.maxReviewRounds (${cap}). More review rounds are the Human's ` +
    `decision: stop and ask them to raise the cap, redesign, or stop. To raise it, the Human sets ${ROUNDS_OVERRIDE}=1 in their ` +
    "own shell before starting the session (agents must never set it on the user's behalf).";
}

// `defaults` carries config.json `github.reviewer`, `github.reviewRequest`, and `github.maxReviewRounds`; flags win.
export const parseArgs = (argv, defaults = {}) => {
  const out = { pr: null, repo: null, head: null, request: false, ...DEFAULTS, reviewer: DEFAULT_REVIEWER, ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--repo') out.repo = next();
    else if (a === '--reviewer') out.reviewer = next();
    else if (a === '--request') out.request = true;
    else if (a === '--timeout-sec') out.timeoutSec = Number(next());
    else if (a === '--interval-sec') out.intervalSec = Number(next());
    else if (a === '--max-rounds') out.maxRounds = Number(next());
    else if (a === '--pr') out.pr = next();
    else if (a === '--head') out.head = next();
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
    else if (out.pr === null) out.pr = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec < 0) throw new Error('--timeout-sec must be >= 0');
  if (!Number.isFinite(out.intervalSec) || out.intervalSec < 5) throw new Error('--interval-sec must be >= 5');
  if (!Number.isInteger(out.maxRounds) || out.maxRounds < 1) throw new Error('--max-rounds must be an integer >= 1');
  if (out.head !== null && !/^[0-9a-f]{7,40}$/iu.test(out.head)) throw new Error('--head must be a commit SHA');
  const m = typeof out.pr === 'string' && out.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) {
    out.repo = out.repo ?? m[1];
    out.pr = m[2];
  }
  if (typeof out.pr === 'string') out.pr = out.pr.replace(/^#/, '');
  if (out.reviewer === NO_REVIEWER) out.reviewer = null;
  return out;
};

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);
const latest = (...isos) => isos.filter((x) => Number.isFinite(ms(x))).sort((a, b) => ms(b) - ms(a))[0] ?? null;

// The boundary a trigger this run just posted is dated against: the created comment's own server timestamp. A local
// clock read after the POST is later than that timestamp (GitHub truncates it to the second), which hid the run's own
// trigger from its acknowledgement. Null when the response has none; the caller then uses a pre-POST instant.
export const postedTriggerInstant = (posted) =>
  (typeof posted?.created_at === 'string' && Number.isFinite(ms(posted.created_at)) ? posted.created_at : null);

// The pre-POST fallback boundary, floored to the second, as GitHub floors `created_at`.
export const flooredInstant = (epochMs) => new Date(Math.floor(epochMs / 1000) * 1000).toISOString();

// The latest trigger: the last "@codex review" comment, ours or a person's. The status card quotes the phrase in its
// help text, so it is never a trigger. Opening a pull request or marking it ready triggers nothing.
const latestTriggerComment = ({ issueComments }) => {
  const requests = issueComments.filter(
    (c) => typeof c.body === 'string' && !isReviewSummaryCard(c.body) && c.body.toLowerCase().includes(REQUEST_COMMENT),
  );
  const at = latest(...requests.map((c) => c.created_at));
  return requests.find((c) => c.created_at === at) ?? null;
};

// The latest trigger's instant, and the head it recorded (null for a hand-typed trigger).
export const latestTrigger = (input) => latestTriggerComment(input)?.created_at ?? null;
export const latestTriggerHead = (input) => triggerHeadSha(latestTriggerComment(input)?.body);

// The bot names the commit it reviewed in its answer: `**Reviewed commit:** \`cdc936e80c\``, a short SHA.
export const REVIEWED_COMMIT_PATTERN = /Reviewed commit:\**\s*`([0-9a-f]{7,40})`/i;
export const reviewedCommit = (body) => (typeof body === 'string' ? body.match(REVIEWED_COMMIT_PATTERN)?.[1] ?? null : null);

// Latest bot signal at or after `since`: a review (with commit), a 👍, or a bot comment, which is how the bot answers on
// a draft; a comment's `commit_id` is the short SHA its "Reviewed commit" line names, or null. The usage-limit notice is
// classified `quota_exhausted` here and the status card dropped, so no caller can mistake either for feedback.
export const latestBotSignal = ({ reviews, reviewComments, reactions, issueComments = [], reviewer, since }) => {
  const after = (iso) => Number.isFinite(ms(iso)) && (!since || ms(iso) >= ms(since));
  const review = reviews
    .filter((r) => r.user?.login === reviewer && after(r.submitted_at))
    .sort((a, b) => ms(b.submitted_at) - ms(a.submitted_at))[0] ?? null;
  const reaction = reactions
    .filter((r) => r.user?.login === reviewer && r.content === '+1' && after(r.created_at))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0] ?? null;
  // A comment that names no reviewed commit counts only as the answer to a trigger: with none, it is the summary of a
  // separate Codex task (it can be posted after a push while describing an older head), not a review of this one.
  const comment = issueComments
    .filter(
      (c) =>
        c.user?.login === reviewer &&
        !isReviewSummaryCard(c.body) &&
        after(c.created_at) &&
        (since || reviewedCommit(c.body) || isQuotaNotice(c.body)),
    )
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0] ?? null;
  const newest = [
    review && { kind: 'review', at: review.submitted_at },
    reaction && { kind: 'thumbs_up', at: reaction.created_at },
    comment && { kind: 'comment', at: comment.created_at },
  ].filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at))[0] ?? null;
  if (!newest) return null;
  if (newest.kind === 'review') {
    const lineComments = reviewComments.filter((c) => c.pull_request_review_id === review.id).length;
    return { kind: 'review', at: review.submitted_at, review_id: review.id, commit_id: review.commit_id, state: review.state, line_comments: lineComments };
  }
  if (newest.kind === 'comment') {
    const kind = isQuotaNotice(comment.body) ? 'quota_exhausted' : 'comment';
    return { kind, at: comment.created_at, review_id: null, commit_id: reviewedCommit(comment.body), state: null, line_comments: 0, comment_id: comment.id ?? null };
  }
  return { kind: 'thumbs_up', at: reaction.created_at, review_id: null, commit_id: null, state: null, line_comments: 0 };
};

// The bot's acknowledgement at or after `since`, as { at, headSha } or null: started, not finished. `headSha` is the
// head the acknowledged trigger recorded, or null for a pull request 👀, the status card, or a hand-typed trigger.
// The bot reacts 👀 on the trigger comment, whose payload carries its own `reactions.eyes` count. A trigger that names a
// head outranks a newer status card. The card counts only against a real trigger: it belongs to no single run.
export const acknowledgement = ({ reactions, issueComments = [], reviewer, since }) => {
  const triggered = Number.isFinite(ms(since));
  const atOrAfter = (iso) => Number.isFinite(ms(iso)) && (!since || ms(iso) >= ms(since));
  const prLevel = reactions
    .filter((r) => r.user?.login === reviewer && r.content === 'eyes' && atOrAfter(r.created_at))
    .map((r) => r.created_at)
    .sort((a, b) => ms(b) - ms(a))[0] ?? null;
  if (prLevel) return { at: prLevel, headSha: null };
  const candidates = issueComments
    .filter(
      (c) =>
        atOrAfter(c.created_at) &&
        ((typeof c.body === 'string' && c.body.toLowerCase().includes(REQUEST_COMMENT) && (c.reactions?.eyes ?? 0) > 0) ||
          (triggered && c.user?.login === reviewer && isReviewSummaryCard(c.body))),
    )
    .sort((a, b) => ms(b.created_at) - ms(a.created_at));
  const comment = candidates.find((c) => triggerHeadSha(c.body)) ?? candidates[0] ?? null;
  return comment ? { at: comment.created_at, headSha: triggerHeadSha(comment.body) } : null;
};

// The acknowledgement's instant alone: the reported `acknowledged_at`.
export const acknowledgedAt = (input) => acknowledgement(input)?.at ?? null;

// Whether an instant that names no commit still covers the head: false only when the head's committer date is known
// and later. The committer date is a loose proxy for what the bot saw: a commit made before the bot answered but pushed
// after it reads as covered. It decides only when no SHA does.
const coversHead = (at, headCommittedAt) => !(Number.isFinite(ms(headCommittedAt)) && ms(at) < ms(headCommittedAt));

// Two spellings of one commit: equal, or one a prefix of the other, at least 7 hex long (the bot writes 10).
const sameCommit = (a, b) => a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a)));

// Whether `at`, bound to `sha` when one is known, covers the head: the SHA decides, else the committer-date proxy.
const coversHeadCommit = (sha, at, headSha, headCommittedAt) => (sha && headSha ? sameCommit(sha, headSha) : coversHead(at, headCommittedAt));

// A signal is stale when it no longer covers the head: a review of another commit, or a 👍, comment, or quota notice
// for another commit. Those three are bound to the commit a comment's "Reviewed commit" line names, else to
// `triggerHead`, the head the trigger they answer recorded; only with neither does the committer date decide.
// A stale quota notice re-requests on purpose, so a later push recovers after a top-up.
export const isStale = (signal, headSha, headCommittedAt = null, triggerHead = null) => {
  if (!signal) return false;
  if (signal.kind === 'review') return Boolean(signal.commit_id) && signal.commit_id !== headSha;
  if (signal.kind === 'thumbs_up' || signal.kind === 'comment' || signal.kind === 'quota_exhausted') {
    return !coversHeadCommit(signal.commit_id ?? triggerHead, signal.at, headSha, headCommittedAt);
  }
  return false;
};

// Whether an acknowledgement answers the current head: the SHA its trigger recorded, else `triggerHead` (a 👀 on the
// pull request or the status card names none, and answers the latest trigger), else the committer-date proxy.
export const acknowledgedForHead = (ack, headSha, headCommittedAt, triggerHead = null) =>
  Boolean(ack) && coversHeadCommit(ack.headSha ?? triggerHead, ack.at, headSha, headCommittedAt);

const defaultGh = {
  api: (p, { paginate = false, method, fields } = {}) => {
    const args = ['api', p, '--header', 'Accept: application/vnd.github+json'];
    if (paginate) args.push('--paginate', '--slurp');
    if (method) args.push('--method', method);
    for (const [k, v] of Object.entries(fields ?? {})) args.push('-f', `${k}=${v}`);
    const parsed = JSON.parse(runGh(args) || 'null');
    return paginate && Array.isArray(parsed) ? parsed.flat() : parsed;
  },
  currentPr: () => JSON.parse(runGh(['pr', 'view', '--json', 'number,headRepository,headRepositoryOwner,url'])),
  repo: () => JSON.parse(runGh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner,
};

// Reads the signals first and the head last: a push that lands mid-snapshot then makes the gathered signals stale.
const snapshot = (gh, repo, n) => {
  const reviews = gh.api(`repos/${repo}/pulls/${n}/reviews`, { paginate: true });
  const reviewComments = gh.api(`repos/${repo}/pulls/${n}/comments`, { paginate: true });
  const issueComments = gh.api(`repos/${repo}/issues/${n}/comments`, { paginate: true });
  const reactions = gh.api(`repos/${repo}/issues/${n}/reactions`, { paginate: true });
  const pr = gh.api(`repos/${repo}/pulls/${n}`);
  const headSha = pr.head?.sha ?? null;
  const headCommit = headSha ? gh.api(`repos/${repo}/commits/${headSha}`) : null;
  return { pr, reviews, reviewComments, issueComments, reactions, headCommittedAt: headCommit?.commit?.committer?.date ?? null };
};

// The local view of the push, through git in the current folder. `pushedHead(repo, branch)` is the upstream commit of
// the checked-out branch when that upstream is `branch` on a remote of GitHub repository `repo`, else null.
// `behind(a, b)` is whether commit a is a known, strict ancestor of commit b; a commit git does not have is never behind.
export const localGit = (cwd = process.cwd()) => {
  const line = (args) => {
    const r = runGit(args, cwd);
    return r.status === 0 ? r.stdout.trim() || null : null;
  };
  return {
    pushedHead: (repo, branch) => {
      const local = line(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const remote = local && line(['config', `branch.${local}.remote`]);
      const url = remote && line(['remote', 'get-url', remote]);
      const named = url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/iu)?.[1];
      if (!repo || !branch || !named || named.toLowerCase() !== repo.toLowerCase()) return null;
      if (line(['config', `branch.${local}.merge`]) !== `refs/heads/${branch}`) return null;
      return line(['rev-parse', '--verify', '--quiet', '@{u}']);
    },
    behind: (a, b) => a !== b && runGit(['merge-base', '--is-ancestor', a, b], cwd).status === 0,
  };
};

// The whole wait. `gh` (api, currentPr, repo), `git` (localGit), `sleep`, and `now` are the only side-effect seams. `gate(repo, n)`, with
// --request, returns { reason } to post nothing, or { marker } to carry in the request (lib/review-gate.mjs).
export const awaitReview = async (opts, { gh = defaultGh, git = localGit(), sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), now = () => Date.now(), gate = null } = {}) => {
  if (opts.reviewer === null) {
    return { status: 'no_reviewer', pr: opts.pr === null ? null : Number(opts.pr), repo: opts.repo, reviewer: null, requested: false, signal: null, waited_sec: 0 };
  }
  const repo = opts.repo ?? gh.repo();
  const n = opts.pr ?? String(gh.currentPr().number);
  const review = opts.request && gate ? gate(repo, n) : {};
  if (review.reason) return { status: 'review_required', pr: Number(n), repo, reviewer: opts.reviewer, requested: false, reason: review.reason, signal: null, waited_sec: 0 };
  const started = now();
  let s = snapshot(gh, repo, n);
  let head = s.pr.head?.sha ?? null;
  // The head the push left behind, when known. GitHub lags only when it reports a commit the push built on; a head git
  // does not know, or one past the push, is someone else's newer work and counts as the pull request's state.
  const pushed = opts.head ?? git.pushedHead(s.pr.head?.repo?.full_name ?? null, s.pr.head?.ref ?? null);
  const lagging = () => Boolean(pushed && head) && !sameCommit(pushed, head) && git.behind(head, pushed);
  let since = latestTrigger(s);
  let sinceHead = latestTriggerHead(s);
  let signal = null;
  let requested = false;
  let requestedForHead = null;
  let stale = false;
  let maxRounds = opts.maxRounds ?? DEFAULTS.maxRounds;
  const automatic = opts.reviewRequest === 'automatic';
  // One step for the first look and every poll: read the current head, find the newest bot signal, and request once
  // per head when the signal is missing or covers an older head. Returns covered, blocked_quota, round_limit, or null.
  const evaluate = () => {
    head = s.pr.head?.sha ?? null;
    if (lagging()) return null;
    signal = latestBotSignal({ ...s, reviewer: opts.reviewer, since });
    stale = isStale(signal, head, s.headCommittedAt, sinceHead);
    const ack = acknowledgement({ reactions: s.reactions, issueComments: s.issueComments, reviewer: opts.reviewer, since });
    // 👀 on a trigger for this head: the bot is mid-review, and a second request only costs another run.
    if (opts.request && !signal && acknowledgedForHead(ack, head, s.headCommittedAt, sinceHead)) return null;
    if (opts.request && (!signal || stale) && requestedForHead !== head) {
      // Accepted residual: a push while a request is in flight at limit - 1 posts one more, so a pull request can end
      // at limit + 1 reviews; the bot exposes no per-trigger completion to reserve against.
      maxRounds = Math.max(maxRounds, recordedMaxRounds(s.issueComments) ?? 0);
      if (codexRounds(s.reviews, opts.reviewer) >= maxRounds) return 'round_limit';
      // The bot reviews by its own settings: the cap is checked, and nothing is posted, ever.
      if (automatic) {
        requestedForHead = head;
        return null;
      }
      const beforePost = flooredInstant(now());
      const posted = gh.api(`repos/${repo}/issues/${n}/comments`, { method: 'POST', fields: { body: requestCommentBody(head, maxRounds, review.marker ?? null) } });
      requested = true;
      requestedForHead = head;
      since = postedTriggerInstant(posted) ?? beforePost;
      sinceHead = head;
      signal = null;
      stale = false;
    }
    if (signal?.kind === 'quota_exhausted' && !stale) return 'blocked_quota';
    return Boolean(signal) && !stale ? 'covered' : null;
  };
  const result = (status) => {
    const ack = acknowledgement({ reactions: s.reactions, issueComments: s.issueComments, reviewer: opts.reviewer, since });
    return {
      status,
      pr: Number(n),
      repo,
      reviewer: opts.reviewer,
      head_sha: head,
      pushed_head: pushed,
      // GitHub still reported a head older than the push when the wait ended: re-run once it catches up.
      ...(status === 'timed_out' && lagging() ? { head_lag: true } : {}),
      head_committed_at: s.headCommittedAt,
      trigger_at: since,
      requested,
      acknowledged_at: ack?.at ?? null,
      // A timeout after the bot acknowledged this head ran past a budget that cannot grow: one re-run without --request
      // is worth its wait. A timeout with nothing acknowledged, or acknowledged for another head, is not.
      ...(status === 'timed_out' ? { retry_recommended: acknowledgedForHead(ack, head, s.headCommittedAt, sinceHead) && !(Boolean(signal) && !stale) } : {}),
      ...(automatic ? { review_request: 'automatic' } : {}),
      ...(status === 'timed_out' && automatic ? { hint: AUTOMATIC_HINT } : {}),
      // The review round, for `aidrian pr disposition --round`.
      codex_rounds: codexRounds(s.reviews, opts.reviewer),
      ...(status === 'round_limit' ? { max_rounds: maxRounds } : {}),
      signal,
      stale,
      waited_sec: Math.round((now() - started) / 1000),
    };
  };
  const first = evaluate();
  if (first === 'blocked_quota' || first === 'round_limit') return result(first);
  if (first) return result('already_present');
  // The last sleep is clamped to the remaining budget, so the wait never overruns the shell's cap.
  for (;;) {
    const remainingMs = opts.timeoutSec * 1000 - (now() - started);
    if (remainingMs <= 0) break;
    await sleep(Math.min(opts.intervalSec, Math.ceil(remainingMs / 1000)));
    s = snapshot(gh, repo, n);
    const verdict = evaluate();
    if (verdict === 'blocked_quota' || verdict === 'round_limit') return result(verdict);
    if (verdict) return result('received');
  }
  return result('timed_out');
};

// The review gate for this project: the request passes only with a review on record, and carries its marker.
async function reviewGate(project, config) {
  const { attestation, judgeRequests, originRepo } = await import('./review-gate.mjs');
  const origin = originRepo(project);
  return (repo, n) => {
    const reason = judgeRequests([{ pr: Number(n), repo, markers: [] }], { project, config, origin });
    return reason ? { reason } : { marker: attestation(project, Number(n), repo, origin) };
  };
}

// The CLI body: prints the result JSON and returns its exit code; a usage or gh error prints one line and returns 1.
// At round_limit, `project` gets a lesson; `deps` replaces awaitReview's gh, clock, and sleep, and `env`, in tests.
export async function runAwaitReview(args, config, project = null, deps = {}) {
  try {
    const gate = project && config.github.reviewGate.enabled ? await reviewGate(project, config) : null;
    const opts = parseArgs(args, { reviewer: config.github.reviewer, reviewRequest: config.github.reviewRequest, maxRounds: config.github.maxReviewRounds });
    const capped = roundCapProblem(opts.maxRounds, config.github.maxReviewRounds, deps.env ?? process.env);
    if (capped) throw new Error(capped);
    const result = await awaitReview(opts, { gate, ...deps });
    if (result.status === 'review_required') console.error(result.reason);
    if (result.status === 'round_limit' && project) {
      const { recordSignal, roundLimitSignal } = await import('./lesson-signals.mjs');
      const where = { session: process.env.CLAUDE_CODE_SESSION_ID || null, agent: process.env.CLAUDE_CODE_AGENT || null };
      const signal = roundLimitSignal({ repo: result.repo, pr: result.pr, maxRounds: result.max_rounds, rounds: result.codex_rounds, ...where });
      recordSignal(project, signal, { config });
    }
    console.log(JSON.stringify(result, null, 2));
    return exitCodeFor(result.status);
  } catch (err) {
    console.error(`aidrian pr await-review: ${err.message}`);
    return 1;
  }
}
