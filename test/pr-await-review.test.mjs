import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  latestTrigger,
  latestBotSignal,
  isStale,
  acknowledgedAt,
  acknowledgement,
  acknowledgedForHead,
  requestCommentBody,
  triggerHeadSha,
  postedTriggerInstant,
  flooredInstant,
  awaitReview,
  isQuotaNotice,
  isReviewSummaryCard,
  REVIEW_SUMMARY_CARD_MARKER,
  exitCodeFor,
  DEFAULT_REVIEWER,
  REQUEST_COMMENT,
  REQUEST_INSTRUCTIONS,
  codexRounds,
  recordedMaxRounds,
  runAwaitReview,
  latestTriggerHead,
  reviewedCommit,
} from '../plugins/aidrian/lib/pr-await-review.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { appendRow } from '../plugins/aidrian/lib/jsonl.mjs';
import { inboxPath, lessons } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';

const BOT = { login: DEFAULT_REVIEWER };
const T = (m) => `2026-08-23T07:${String(m).padStart(2, '0')}:00Z`;

test('parseArgs: defaults, URL form, #n form, and strict flag parsing', () => {
  const d = parseArgs([]);
  assert.equal(d.reviewer, DEFAULT_REVIEWER);
  assert.equal(d.timeoutSec, 840);
  assert.equal(d.intervalSec, 60);
  assert.equal(d.request, false);
  assert.equal(d.maxRounds, 3, 'the config.json github.maxReviewRounds default');
  assert.equal(parseArgs(['--max-rounds', '15']).maxRounds, 15);
  assert.throws(() => parseArgs(['--max-rounds', '0']), /max-rounds/);
  assert.throws(() => parseArgs(['--max-rounds', '2.5']), /max-rounds/);
  const u = parseArgs(['https://github.com/acme/notes/pull/5206', '--request']);
  assert.deepEqual([u.repo, u.pr, u.request], ['acme/notes', '5206', true]);
  assert.equal(parseArgs(['#12']).pr, '12');
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--interval-sec', '1']), /interval-sec/);
});

test('latestTrigger: only @codex review comments trigger — opening or marking ready triggers nothing', () => {
  assert.equal(latestTrigger({ pr: { draft: true, created_at: T(0) }, timeline: [], issueComments: [] }), null);
  // A PR opened for review used to be a trigger; with auto-review disabled it produces no review.
  assert.equal(latestTrigger({ pr: { draft: false, created_at: T(0) }, timeline: [], issueComments: [] }), null);
  // ready_for_review likewise triggers nothing — and must NOT mask an earlier comment-triggered review.
  assert.equal(
    latestTrigger({ pr: { draft: false, created_at: T(0) }, timeline: [{ event: 'ready_for_review', created_at: T(5) }], issueComments: [] }),
    null,
  );
  assert.equal(
    latestTrigger({
      pr: { draft: false, created_at: T(0) },
      timeline: [{ event: 'ready_for_review', created_at: T(11) }],
      issueComments: [{ body: 'Please @Codex review this again', created_at: T(9) }],
    }),
    T(9),
  );
  // The newest of several comment triggers wins.
  assert.equal(
    latestTrigger({
      pr: { draft: true, created_at: T(0) },
      timeline: [],
      issueComments: [
        { body: '@codex review', created_at: T(3) },
        { body: '@codex review', created_at: T(7) },
      ],
    }),
    T(7),
  );
});

test('latestBotSignal: review beats older thumbs-up, counts its line comments, ignores signals before `since` and other users', () => {
  const reviews = [
    { id: 1, user: BOT, submitted_at: T(2), commit_id: 'aaa', state: 'COMMENTED' },
    { id: 2, user: BOT, submitted_at: T(8), commit_id: 'bbb', state: 'COMMENTED' },
    { id: 3, user: { login: 'someone' }, submitted_at: T(9), commit_id: 'bbb', state: 'COMMENTED' },
  ];
  const reviewComments = [{ pull_request_review_id: 2 }, { pull_request_review_id: 2 }, { pull_request_review_id: 3 }];
  const reactions = [{ user: BOT, content: '+1', created_at: T(7) }];
  const s = latestBotSignal({ reviews, reviewComments, reactions, reviewer: DEFAULT_REVIEWER, since: T(5) });
  assert.deepEqual(s, { kind: 'review', at: T(8), review_id: 2, commit_id: 'bbb', state: 'COMMENTED', line_comments: 2 });
  assert.equal(latestBotSignal({ reviews, reviewComments, reactions, reviewer: DEFAULT_REVIEWER, since: T(10) }), null);
});

test('latestBotSignal: a bot-authored issue comment is a completed signal (draft PRs get task-summary comments, not reviews)', () => {
  // Observed on a draft: @codex review on a draft produced an issue
  // comment 30 minutes later; the review-only model timed out past it.
  const base = { reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER };
  const botComment = { id: 77, user: BOT, created_at: T(6), body: '### Summary …' };
  const ourRequest = { id: 76, user: { login: 'someone' }, created_at: T(5), body: '@codex review' };
  const s = latestBotSignal({ ...base, issueComments: [ourRequest, botComment], since: T(5) });
  assert.deepEqual(s, { kind: 'comment', at: T(6), review_id: null, commit_id: null, state: null, line_comments: 0, comment_id: 77 });
  // The requester's own comment is not a bot signal.
  assert.equal(latestBotSignal({ ...base, issueComments: [ourRequest], since: T(4) }), null);
  // A formal review newer than the comment still wins.
  const withReview = latestBotSignal({
    ...base,
    reviews: [{ id: 9, user: BOT, submitted_at: T(8), commit_id: 'bbb', state: 'COMMENTED' }],
    issueComments: [botComment],
    since: T(5),
  });
  assert.equal(withReview.kind, 'review');
  // Comment staleness follows the thumbs-up rule: older than head's committer date = stale.
  assert.equal(isStale({ kind: 'comment', at: T(6) }, 'bbb', T(7)), true);
  assert.equal(isStale({ kind: 'comment', at: T(8) }, 'bbb', T(7)), false);
});

test('latestBotSignal: a thumbs-up with no review is a completed review with nothing to address', () => {
  const s = latestBotSignal({ reviews: [], reviewComments: [], reactions: [{ user: BOT, content: '+1', created_at: T(6) }], reviewer: DEFAULT_REVIEWER, since: T(5) });
  assert.equal(s.kind, 'thumbs_up');
  assert.equal(s.line_comments, 0);
  assert.equal(isStale(s, 'anything', null), false, 'no head date known → not stale');
  assert.equal(isStale(s, 'anything', T(5)), false, 'head committed before the 👍 → covered');
  assert.equal(isStale(s, 'anything', T(9)), true, 'head committed after the 👍 → stale');
});

test('acknowledgedAt: a 👀 reaction is in-progress, not a completed signal', () => {
  const reactions = [{ user: BOT, content: 'eyes', created_at: T(6) }];
  assert.equal(acknowledgedAt({ reactions, reviewer: DEFAULT_REVIEWER, since: T(5) }), T(6));
  assert.equal(acknowledgedAt({ reactions, reviewer: DEFAULT_REVIEWER, since: T(7) }), null);
  assert.equal(latestBotSignal({ reviews: [], reviewComments: [], reactions, reviewer: DEFAULT_REVIEWER, since: T(5) }), null);
});

test('acknowledgedAt: 👀 on the trigger comment counts', () => {
  const issueComments = [{ user: { login: 'someone' }, body: '@codex review', created_at: T(6), reactions: { eyes: 1 } }];
  assert.equal(acknowledgedAt({ reactions: [], issueComments, reviewer: DEFAULT_REVIEWER, since: T(5) }), T(6));
  assert.equal(
    acknowledgedAt({ reactions: [], issueComments: [{ ...issueComments[0], reactions: { eyes: 0 } }], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    null,
  );
});

test('awaitReview --request: an acknowledged 👀 trigger is not re-requested', async () => {
  const ackedTrigger = { user: { login: 'someone' }, body: '@codex review', created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [ackedTrigger] }], { head: 'bbb' });
  const c = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, ...c });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.acknowledged_at, T(5));
  assert.equal(gh.posts.length, 0, 'no second @codex review while the bot is mid-review');
});

test('requestCommentBody / triggerHeadSha: the trigger records its head without changing what the bot reads', () => {
  const body = requestCommentBody('ccc');
  assert.ok(body.startsWith(REQUEST_COMMENT), 'the body still OPENS with the exact trigger phrase');
  assert.equal(triggerHeadSha(body), 'ccc');
  // A human-typed trigger, and one from before the marker existed, name nothing.
  assert.equal(triggerHeadSha(REQUEST_COMMENT), null);
  assert.equal(triggerHeadSha(undefined), null);
  // An unreadable head produces no marker rather than one naming nothing.
  assert.equal(requestCommentBody(null), `${REQUEST_COMMENT}\n\n${REQUEST_INSTRUCTIONS}`);
  // The review instructions ride in the same comment, right after the trigger phrase.
  assert.ok(body.startsWith(`${REQUEST_COMMENT}\n\n${REQUEST_INSTRUCTIONS}\n\n`));
  assert.ok(!REQUEST_INSTRUCTIONS.toLowerCase().includes(REQUEST_COMMENT), 'the instructions never repeat the trigger phrase');
  // The marker is invisible to the trigger matcher and to isReviewSummaryCard,
  // so a request carrying it is still found as the trigger it is.
  assert.equal(latestTrigger({ pr: {}, timeline: [], issueComments: [{ body, created_at: T(5) }] }), T(5));
  assert.equal(isReviewSummaryCard(body), false);
});

test('acknowledgement: the record carries the head its trigger named, or null when nothing names one', () => {
  const bound = { user: { login: 'someone' }, body: requestCommentBody('ccc'), created_at: T(6), reactions: { eyes: 1 } };
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [bound], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(6), headSha: 'ccc' },
  );
  // A human-typed trigger names no head.
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [{ ...bound, body: REQUEST_COMMENT }], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(6), headSha: null },
  );
  // A PR-level 👀 hangs off no comment, so it names no head either.
  assert.deepEqual(
    acknowledgement({ reactions: [{ user: BOT, content: 'eyes', created_at: T(6) }], issueComments: [], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(6), headSha: null },
  );
  assert.equal(acknowledgement({ reactions: [], issueComments: [], reviewer: DEFAULT_REVIEWER, since: T(5) }), null);
});

test('acknowledgedForHead: a SHA-bound trigger covers exactly its head; one naming none falls back to the committer date', () => {
  assert.equal(acknowledgedForHead(null, 'ccc', T(1)), false);
  // Bound to the head it named — covered whatever the dates say. The committer
  // date here is NEWER than the acknowledgement, which the date proxy alone
  // would have called stale.
  assert.equal(acknowledgedForHead({ at: T(5), headSha: 'ccc' }, 'ccc', T(9)), true);
  // Bound to another head — not covered, even though that head was COMMITTED
  // before the acknowledgement (committed locally, gates run, pushed after:
  // the flow this repo actually uses).
  assert.equal(acknowledgedForHead({ at: T(5), headSha: 'bbb' }, 'ccc', T(3)), false);
  // Legacy trigger with no SHA: the committer date is the only clock it has.
  assert.equal(acknowledgedForHead({ at: T(5), headSha: null }, 'ccc', T(1)), true);
  assert.equal(acknowledgedForHead({ at: T(5), headSha: null }, 'ccc', T(9)), false);
  // Unknown head date, and an unreadable head SHA, both fail open — same
  // direction as isStale, so a PR whose head could not be read keeps its answer.
  assert.equal(acknowledgedForHead({ at: T(5), headSha: null }, 'ccc', null), true);
  assert.equal(acknowledgedForHead({ at: T(5), headSha: 'bbb' }, null, T(1)), true);
});

test('awaitReview --request: an acknowledgement for head A does not cover head B, which was committed BEFORE it but pushed after', async () => {
  // The finding this binding exists for. B is committed at T(3), gates run, and
  // B is pushed only after the bot acknowledged A's trigger at T(5). B's
  // committer date therefore PRECEDES the acknowledgement, so the date proxy
  // called the 👀 for A a cover for B: no trigger was ever posted for B and the
  // wait could not end in a review. The trigger names 'bbb', so it covers
  // 'bbb' and nothing else.
  const triggerForA = { user: { login: 'someone' }, body: requestCommentBody('bbb'), created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh(
    [{ issueComments: [triggerForA] }, { head: 'ccc', headCommittedAt: T(3), issueComments: [triggerForA] }],
    { head: 'bbb', headCommittedAt: T(1) },
  );
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.head_sha, 'ccc');
  assert.equal(r.requested, true);
  assert.equal(gh.posts.length, 1, 'the head the bot never saw gets its own @codex review');
  assert.equal(gh.posts[0].fields.body, requestCommentBody('ccc'), 'and that request names the head it was made for');
  assert.equal(r.retry_recommended, false, 'no acknowledgement covers ccc, so a re-run without --request cannot help');
});

test('awaitReview --request: an acknowledged trigger naming the CURRENT head suppresses a second request', async () => {
  // The other direction: the head's committer date is newer than the
  // acknowledgement, which the date proxy alone calls stale — but the trigger
  // names this exact SHA, so the review in flight is this head's.
  const triggerForB = { user: { login: 'someone' }, body: requestCommentBody('ccc'), created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [triggerForB] }], { head: 'ccc', headCommittedAt: T(9) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.status, 'timed_out');
  assert.equal(gh.posts.length, 0, 'the bot is mid-review on this exact head; a second ask costs a run and buys nothing');
  assert.equal(r.retry_recommended, true, 'a review for ccc is in flight, so one re-run WITHOUT --request is worth its wait');
});

test('awaitReview --request: a legacy trigger naming no head still re-requests when it predates the head commit', async () => {
  // A human-typed trigger for head bbb, acknowledged, then ccc landed mid-wait.
  // Nothing names a SHA here, so the committer-date fallback decides — and it
  // does decide correctly whenever the push is what moved the head last.
  // Codex never reviews a later push on its own, so leaving the 👀 in force
  // meant no request ever covered ccc and the wait could not end in a review.
  const acked = { user: { login: 'someone' }, body: '@codex review', created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh(
    [{ issueComments: [acked] }, { head: 'ccc', headCommittedAt: T(9), issueComments: [acked] }],
    { head: 'bbb', headCommittedAt: T(1) },
  );
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.head_sha, 'ccc');
  assert.equal(r.requested, true);
  assert.equal(gh.posts.length, 1, 'the new head gets its own @codex review');
  assert.equal(triggerHeadSha(gh.posts[0].fields.body), 'ccc', 'and the replacement request is SHA-bound from here on');
});

test('postedTriggerInstant / flooredInstant: the created comment decides the boundary, with a floored pre-POST fallback', () => {
  assert.equal(postedTriggerInstant({ created_at: T(10) }), T(10));
  // A response that carries no usable timestamp yields null, so the caller falls back.
  assert.equal(postedTriggerInstant({}), null);
  assert.equal(postedTriggerInstant(null), null);
  assert.equal(postedTriggerInstant({ created_at: 'not a date' }), null);
  assert.equal(postedTriggerInstant({ created_at: 42 }), null);
  // GitHub truncates created_at DOWN to the second, so the fallback floors too.
  assert.equal(flooredInstant(Date.parse(T(10)) + 412), '2026-08-23T07:10:00.000Z');
  assert.equal(flooredInstant(Date.parse(T(10)) + 999), '2026-08-23T07:10:00.000Z');
});

/**
 * A fake `gh` for the POST seam that `fakeGh` does not model: it actually
 * CREATES the comment, stamping `created_at` truncated to the whole second the
 * way GitHub does, returns the created object, and carries the bot's 👀 on it
 * by the next read. The POST also burns `postMs` of wall clock, so a test can
 * tell a pre-POST boundary from a post-POST one.
 */
const fakeRequestGh = (c, { head = 'ccc', headCommittedAt = T(1), createdAt, postMs = 0, echoCreatedAt = true } = {}) => {
  const issueComments = [];
  const posts = [];
  return {
    posts,
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 42 }),
    api: (p, { method, fields } = {}) => {
      if (method === 'POST') {
        posts.push({ p, fields });
        c.advance(postMs);
        const created = { id: 1, user: { login: 'someone' }, body: fields.body, created_at: createdAt, reactions: { eyes: 1 } };
        issueComments.push(created);
        return echoCreatedAt ? created : {};
      }
      if (p.endsWith('/pulls/42')) return { draft: true, created_at: T(0), head: { sha: head } };
      if (p.includes('/commits/')) return { commit: { committer: { date: headCommittedAt } } };
      if (p.endsWith('/issues/42/comments')) return [...issueComments];
      if (p.endsWith('/reviews') || p.endsWith('/pulls/42/comments') || p.endsWith('/reactions') || p.endsWith('/timeline')) return [];
      throw new Error(`unexpected gh path ${p}`);
    },
  };
};

/** `clock()` plus a sub-second nudge, so the POST can consume wall time. */
const skewedClock = (startMs) => {
  let t = startMs;
  return { now: () => t, sleep: async (s) => { t += s * 1000; }, advance: (delta) => { t += delta; } };
};

test('awaitReview --request: the wait is anchored to the posted comment\'s server created_at, not the local clock after the POST', async () => {
  // GitHub stamps created_at truncated to the whole second and only then sends
  // the response back, so a clock read AFTER the POST is always later than the
  // timestamp the comment reports. Dating `since` from it excluded this run's
  // OWN trigger from the acknowledgement window (`created_at >= since`): the
  // bot's 👀 on the comment just posted went unseen, `acknowledged_at` reported
  // null, and an acknowledged timeout claimed retry_recommended: false while
  // the review was still running — so the review loop moved on.
  const c = skewedClock(Date.parse(T(10)) + 412);
  const gh = fakeRequestGh(c, { createdAt: T(10) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep: c.sleep });
  assert.equal(gh.posts.length, 1, 'one trigger, for this head');
  // The exact server string, which the floored fallback would render as
  // '…07:10:00.000Z' — so this pins the response path, not just the instant.
  assert.equal(r.trigger_at, T(10));
  assert.equal(r.acknowledged_at, T(10), 'the run\'s own trigger is inside its own window');
  assert.equal(r.status, 'timed_out');
  assert.equal(r.retry_recommended, true, 'the bot is mid-review on this head; one re-run WITHOUT --request is worth its wait');
});

test('awaitReview --request: a POST response with no usable created_at falls back to the PRE-post boundary', async () => {
  // 900 ms of POST separates the two candidate local instants: pre-POST floors
  // to 07:10:00, post-POST to 07:10:01. Only the pre-POST one still covers a
  // comment GitHub stamped 07:10:00Z.
  const c = skewedClock(Date.parse(T(10)) + 412);
  const gh = fakeRequestGh(c, { createdAt: T(10), postMs: 900, echoCreatedAt: false });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep: c.sleep });
  assert.equal(gh.posts.length, 1);
  assert.equal(r.trigger_at, '2026-08-23T07:10:00.000Z', 'pre-POST, floored to GitHub\'s own second granularity');
  assert.equal(r.acknowledged_at, T(10), 'so the trigger and its 👀 are still recognized');
  assert.equal(r.status, 'timed_out');
  assert.equal(r.retry_recommended, true);
});

test('awaitReview: a timeout whose acknowledgement predates head is NOT retry-recommended', async () => {
  // Retrying without --request can only wait again: the 👀 answers a head the
  // bot has already been past, and no request covers the current one.
  const acked = { user: { login: 'someone' }, body: '@codex review', created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [acked] }], { head: 'ccc', headCommittedAt: T(9) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 120, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.acknowledged_at, T(5), 'the acknowledgement is still reported verbatim');
  assert.equal(r.retry_recommended, false);

  // Same shape, acknowledgement newer than the head commit: still worth one
  // re-run, because the review it acknowledged is the current head's.
  const fresh = { user: { login: 'someone' }, body: '@codex review', created_at: T(11), reactions: { eyes: 1 } };
  const gh2 = fakeGh([{ issueComments: [fresh] }], { head: 'ccc', headCommittedAt: T(9) });
  const r2 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 120, intervalSec: 60 }, { gh: gh2, ...clock() });
  assert.equal(r2.status, 'timed_out');
  assert.equal(r2.retry_recommended, true);
});

test('awaitReview --request: an UNacknowledged trigger still gets one request', async () => {
  const gh = fakeGh([{ issueComments: [{ user: { login: 'someone' }, body: '@codex review', created_at: T(5), reactions: { eyes: 0 } }] }], { head: 'bbb' });
  const c = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, ...c });
  assert.equal(r.requested, true);
  assert.equal(gh.posts.length, 1);
});

test('isStale: a review of an older commit than head is stale', () => {
  assert.equal(isStale({ kind: 'review', commit_id: 'aaa' }, 'bbb'), true);
  assert.equal(isStale({ kind: 'review', commit_id: 'bbb' }, 'bbb'), false);
  assert.equal(isStale(null, 'bbb'), false);
});

/** Fake gh: a scripted sequence of snapshots, plus a record of POSTs. */
const fakeGh = (frames, { head = 'bbb', draft = false, created = T(0), headCommittedAt = T(1) } = {}) => {
  let tick = 0;
  const posts = [];
  const frame = () => frames[Math.min(tick, frames.length - 1)];
  return {
    posts,
    advance: () => { tick += 1; },
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 42 }),
    api: (p, { method, fields } = {}) => {
      if (method === 'POST') { posts.push({ p, fields }); return {}; }
      const f = frame();
      if (p.endsWith('/pulls/42')) return { draft, created_at: created, head: { sha: f.head ?? head } };
      if (p.includes('/commits/')) return { commit: { committer: { date: f.headCommittedAt ?? headCommittedAt } } };
      if (p.endsWith('/reviews')) return f.reviews ?? [];
      if (p.endsWith('/pulls/42/comments')) return f.reviewComments ?? [];
      if (p.endsWith('/issues/42/comments')) return f.issueComments ?? [];
      if (p.endsWith('/reactions')) return f.reactions ?? [];
      if (p.endsWith('/timeline')) return f.timeline ?? [];
      throw new Error(`unexpected gh path ${p}`);
    },
  };
};

const clock = () => {
  let t = Date.parse(T(10));
  return { now: () => t, sleep: async (s) => { t += s * 1000; } };
};

test('awaitReview: the final sleep is clamped to the remaining budget, never a full interval past it', async () => {
  // Timeout 100 s, interval 60 s: the loop sleeps 60, then 40 — not 60 + 60,
  // which with the snapshot's API calls is what overran the shell cap.
  const gh = fakeGh([{}]);
  const c = clock();
  const sleeps = [];
  const sleep = async (sec) => { sleeps.push(sec); await c.sleep(sec); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 100, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'timed_out');
  assert.deepEqual(sleeps, [60, 40]);
  assert.equal(r.waited_sec, 100);
});

test('awaitReview: review already on the PR → already_present, exit-0 shape, no POST', async () => {
  const gh = fakeGh([{ reviews: [{ id: 1, user: BOT, submitted_at: T(6), commit_id: 'bbb', state: 'COMMENTED' }], reviewComments: [{ pull_request_review_id: 1 }] }]);
  const c = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 900, intervalSec: 60 }, { gh, ...c });
  assert.equal(r.status, 'already_present');
  assert.equal(r.signal.line_comments, 1);
  assert.equal(r.stale, false);
  assert.equal(gh.posts.length, 0);
});

test('awaitReview: polls until the bot signal lands, then received; times out otherwise', async () => {
  const gh = fakeGh([{}, {}, { reactions: [{ user: BOT, content: '+1', created_at: T(12) }] }]);
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'received');
  assert.equal(r.signal.kind, 'thumbs_up');
  assert.equal(r.waited_sec, 120);

  const gh2 = fakeGh([{}]);
  const c2 = clock();
  const r2 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 180, intervalSec: 60 }, { gh: gh2, ...c2 });
  assert.equal(r2.status, 'timed_out');
  assert.equal(r2.waited_sec, 180);
  assert.equal(r2.acknowledged_at, null);
});

test('awaitReview: an acknowledged timeout is retry-recommended, an unacknowledged one is not', async () => {
  // 👀 on the trigger proves the bot picked the PR up, so the budget ran out
  // mid-review rather than on nothing. That is the one timeout worth exactly
  // one re-run WITHOUT --request, and the script decides it so the caller does
  // not have to re-derive it from acknowledged_at and signal.
  const acked = { user: { login: 'someone' }, body: '@codex review', created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [acked] }], { head: 'bbb' });
  const c = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 120, intervalSec: 60 }, { gh, ...c });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.acknowledged_at, T(5));
  assert.equal(r.retry_recommended, true);

  // No 👀 anywhere: nothing is in flight, so a re-run would spend the whole
  // budget again on a review that was never started.
  const gh2 = fakeGh([{}]);
  const c2 = clock();
  const r2 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 120, intervalSec: 60 }, { gh: gh2, ...c2 });
  assert.equal(r2.status, 'timed_out');
  assert.equal(r2.acknowledged_at, null);
  assert.equal(r2.retry_recommended, false);

  // Timeout-only: a run that got its answer keeps the exact shape it had
  // before this field existed.
  const gh3 = fakeGh([{ reactions: [{ user: BOT, content: '+1', created_at: T(6) }] }]);
  const c3 = clock();
  const r3 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 120, intervalSec: 60 }, { gh: gh3, ...c3 });
  assert.equal(r3.status, 'already_present');
  assert.ok(!('retry_recommended' in r3), 'retry_recommended never rides a non-timeout result');
});

test('awaitReview --request: a stale review (older commit than head) triggers one "@codex review" and waits from then', async () => {
  const stale = { id: 1, user: BOT, submitted_at: T(6), commit_id: 'aaa', state: 'COMMENTED' };
  const fresh = { id: 2, user: BOT, submitted_at: T(12), commit_id: 'bbb', state: 'COMMENTED' };
  const gh = fakeGh([{ reviews: [stale] }, { reviews: [stale, fresh] }], { head: 'bbb' });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.deepEqual(gh.posts, [{ p: 'repos/acme/notes/issues/42/comments', fields: { body: requestCommentBody('bbb') } }]);
  assert.equal(r.requested, true);
  assert.equal(r.status, 'received');
  assert.equal(r.signal.commit_id, 'bbb');
  assert.equal(r.stale, false);
});

test('awaitReview --request: a 👍 older than the head commit re-requests', async () => {
  const thumbs = { user: BOT, content: '+1', created_at: T(6) };
  const fresh = { id: 9, user: BOT, submitted_at: T(12), commit_id: 'bbb', state: 'COMMENTED' };
  const gh = fakeGh([{ reactions: [thumbs] }, { reactions: [thumbs], reviews: [fresh] }], { head: 'bbb', headCommittedAt: T(8) });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(gh.posts.length, 1);
  assert.equal(r.requested, true);
  assert.equal(r.status, 'received');
  assert.equal(r.head_committed_at, T(8));
});

test('awaitReview --request: a 👍 newer than the head commit does NOT re-request', async () => {
  const gh = fakeGh([{ reactions: [{ user: BOT, content: '+1', created_at: T(6) }] }], { head: 'bbb', headCommittedAt: T(1) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(gh.posts.length, 0);
  assert.equal(r.status, 'already_present');
  assert.equal(r.stale, false);
});

test('latestTriggerHead: the head the latest trigger recorded; a later hand-typed trigger names none', () => {
  const bound = { body: requestCommentBody('bbb'), created_at: T(5) };
  assert.equal(latestTriggerHead({ issueComments: [bound] }), 'bbb');
  assert.equal(latestTriggerHead({ issueComments: [bound, { body: REQUEST_COMMENT, created_at: T(6) }] }), null);
  assert.equal(latestTriggerHead({ issueComments: [{ body: REQUEST_COMMENT, created_at: T(4) }, bound] }), 'bbb');
  assert.equal(latestTriggerHead({ issueComments: [] }), null);
});

test('isStale: a 👍, comment, or quota notice is bound to the head its trigger recorded, not to the committer date', () => {
  // ccc was committed at T(3), before the bot answered at T(6), and pushed after: the committer date alone called it
  // covered, though the trigger the answer belongs to asked about bbb.
  for (const kind of ['thumbs_up', 'comment', 'quota_exhausted']) {
    const signal = { kind, at: T(6), commit_id: null };
    assert.equal(isStale(signal, 'ccc', T(3), 'bbb'), true, `${kind}: answers bbb, so ccc is not covered`);
    assert.equal(isStale(signal, 'ccc', T(9), 'ccc'), false, `${kind}: the trigger named this head, whatever the dates say`);
    assert.equal(isStale(signal, 'ccc', T(3)), false, `${kind}: with no SHA, the committer date still decides`);
    assert.equal(isStale(signal, 'ccc', T(9)), true, `${kind}: with no SHA, the committer date still decides`);
    assert.equal(isStale(signal, null, T(3), 'bbb'), false, `${kind}: an unreadable head keeps the date proxy`);
  }
});

test('latestBotSignal / isStale: a comment\'s "Reviewed commit" line names its commit, and outranks the trigger\'s', () => {
  const head = 'cdc936e80c1f2a3b4c5d6e7f8091a2b3c4d5e6f7';
  const old = '0123456789abcdef0123456789abcdef01234567';
  const body = (sha) => `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n`;
  const base = { reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER, since: T(5) };
  const current = latestBotSignal({ ...base, issueComments: [{ id: 7, user: BOT, created_at: T(6), body: body(head) }] });
  assert.equal(current.commit_id, head.slice(0, 10));
  assert.equal(isStale(current, head, T(9), old), false, 'the line names the head: covered, though the trigger named another');
  const older = latestBotSignal({ ...base, issueComments: [{ id: 8, user: BOT, created_at: T(6), body: body(old) }] });
  assert.equal(isStale(older, head, T(3), head), true, 'the line names an older commit: stale, though the trigger named this head');
  assert.equal(reviewedCommit('### Summary …'), null);
  assert.equal(reviewedCommit(undefined), null);
});

test('acknowledgedForHead: a 👀 that names no head is bound to the head the latest trigger recorded', () => {
  assert.equal(acknowledgedForHead({ at: T(6), headSha: null }, 'ccc', T(3), 'bbb'), false);
  assert.equal(acknowledgedForHead({ at: T(6), headSha: null }, 'ccc', T(9), 'ccc'), true);
  assert.equal(acknowledgedForHead({ at: T(6), headSha: 'ccc' }, 'ccc', T(9), 'bbb'), true, 'the 👀\'s own trigger outranks the latest one');
});

test('awaitReview: a 👍 answering head A does not cover head B, committed before the 👍 but pushed after', async () => {
  const triggerForA = { user: { login: 'someone' }, body: requestCommentBody('bbb'), created_at: T(5), reactions: { eyes: 1 } };
  const frames = [{ issueComments: [triggerForA], reactions: [{ user: BOT, content: '+1', created_at: T(6) }] }];
  const waited = await awaitReview(
    { pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 60, intervalSec: 60 },
    { gh: fakeGh(frames, { head: 'ccc', headCommittedAt: T(3) }), ...clock() },
  );
  assert.equal(waited.status, 'timed_out', 'the 👍 answers bbb, so the wait for ccc does not end on it');
  assert.equal(waited.stale, true);

  const gh = fakeGh(frames, { head: 'ccc', headCommittedAt: T(3) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 60, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(gh.posts.length, 1, 'ccc was never reviewed, so it gets its own @codex review');
  assert.equal(triggerHeadSha(gh.posts[0].fields.body), 'ccc');
  assert.equal(r.status, 'timed_out');
});

test('awaitReview --request: a 👍 answering a trigger for the current head ends the wait, though the head is newer', async () => {
  const trigger = { user: { login: 'someone' }, body: requestCommentBody('ccc'), created_at: T(5), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [trigger], reactions: [{ user: BOT, content: '+1', created_at: T(6) }] }], { head: 'ccc', headCommittedAt: T(9) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 60, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.status, 'already_present');
  assert.equal(gh.posts.length, 0);
});

test('awaitReview: a push that lands mid-wait moves the target — a review of the old head is stale, not received', async () => {
  const oldHeadReview = { id: 1, user: BOT, submitted_at: T(12), commit_id: 'bbb', state: 'COMMENTED' };
  const newHeadReview = { id: 2, user: BOT, submitted_at: T(14), commit_id: 'ccc', state: 'COMMENTED' };
  // frame0: nothing yet (head bbb). frame1: head moved to ccc, bot reviewed bbb. frame2: bot reviewed ccc.
  const gh = fakeGh([{}, { head: 'ccc', reviews: [oldHeadReview] }, { head: 'ccc', reviews: [oldHeadReview, newHeadReview] }], { head: 'bbb' });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'received');
  assert.equal(r.head_sha, 'ccc');
  assert.equal(r.signal.commit_id, 'ccc');
  assert.equal(r.stale, false);
  // Requested once for bbb (no signal at start) and once more for ccc (old-head review was stale).
  assert.equal(gh.posts.length, 2);

  // Without --request the stale old-head review is never reported as received.
  const gh2 = fakeGh([{}, { head: 'ccc', reviews: [oldHeadReview] }], { head: 'bbb' });
  const c2 = clock();
  const sleep2 = async (s) => { await c2.sleep(s); gh2.advance(); };
  const r2 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 180, intervalSec: 60 }, { gh: gh2, now: c2.now, sleep: sleep2 });
  assert.equal(r2.status, 'timed_out');
  assert.equal(r2.head_sha, 'ccc');
  assert.equal(r2.stale, true);
});

test('snapshot reads the head AFTER the signals: a push landing mid-snapshot makes the gathered review stale', async () => {
  // gh fake whose head advances the moment the reviews endpoint is read — i.e. a
  // push lands after the signals are gathered. Head-last ordering must see it.
  const review = { id: 1, user: BOT, submitted_at: T(6), commit_id: 'bbb', state: 'COMMENTED' };
  let head = 'bbb';
  const calls = [];
  const gh = {
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 42 }),
    api: (p) => {
      calls.push(p.replace(/^repos\/acme\/notes\//, ''));
      if (p.endsWith('/reviews')) { const out = [review]; head = 'ccc'; return out; }
      if (p.endsWith('/pulls/42')) return { draft: false, created_at: T(0), head: { sha: head } };
      if (p.includes('/commits/')) return { commit: { committer: { date: T(7) } } };
      return [];
    },
  };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 0, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.head_sha, 'ccc');
  assert.equal(r.stale, true);
  assert.equal(r.status, 'timed_out');
  assert.ok(calls.indexOf('pulls/42') > calls.indexOf('pulls/42/reviews'), 'head is read after the signals');
});

test('awaitReview --request: a fresh review on head does NOT re-request', async () => {
  const gh = fakeGh([{ reviews: [{ id: 2, user: BOT, submitted_at: T(6), commit_id: 'bbb', state: 'COMMENTED' }] }], { head: 'bbb' });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(gh.posts.length, 0);
  assert.equal(r.status, 'already_present');
});

// Verbatim body of the bot's usage-limit comment,
// posted six seconds after the `@codex review` trigger.
const QUOTA_BODY =
  'You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).\n' +
  'To continue using code reviews, you can upgrade your account or add credits to your account and enable them for code reviews in your [settings](https://chatgpt.com/codex/cloud/settings/code-review).';

test('latestBotSignal: the usage-limit notice is quota_exhausted, never a comment signal', () => {
  assert.equal(isQuotaNotice(QUOTA_BODY), true);
  assert.equal(isQuotaNotice('### Summary …'), false);
  assert.equal(isQuotaNotice(undefined), false);
  const base = { reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER, since: T(5) };
  const notice = { id: 5499221496, user: BOT, created_at: T(6), body: QUOTA_BODY };
  const s = latestBotSignal({ ...base, issueComments: [notice] });
  assert.equal(s.kind, 'quota_exhausted');
  assert.equal(s.comment_id, 5499221496);
  assert.equal(s.line_comments, 0);
  // A real task-summary comment keeps its kind.
  assert.equal(latestBotSignal({ ...base, issueComments: [{ ...notice, body: '### Summary …' }] }).kind, 'comment');
  // Staleness follows the comment rule, so a later push can re-request after a top-up.
  assert.equal(isStale(s, 'bbb', T(7)), true);
  assert.equal(isStale(s, 'bbb', T(5)), false);
});

test('awaitReview --request: the quota notice ends the wait as blocked_quota, not received, and is not re-asked', async () => {
  // frame0: nothing on the PR yet → one request. frame1: the bot answers with
  // the usage-limit notice. The wait ends at the first poll: no amount of
  // waiting turns "no credits" into a review, and a second ask buys nothing.
  const notice = { id: 1, user: BOT, created_at: T(11), body: QUOTA_BODY };
  const gh = fakeGh([{}, { issueComments: [notice] }], { head: 'bbb' });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'blocked_quota');
  assert.equal(r.signal.kind, 'quota_exhausted');
  assert.equal(r.stale, false);
  assert.equal(r.waited_sec, 60, 'stops at the poll that saw the notice, not at the timeout');
  assert.equal(gh.posts.length, 1);
  assert.equal(exitCodeFor(r.status), 3);
  assert.equal(exitCodeFor('timed_out'), 2);
  assert.equal(exitCodeFor('received'), 0);
  assert.equal(exitCodeFor('already_present'), 0);
});

test('awaitReview: a quota notice already answering the trigger is blocked_quota at first look, with no POST', async () => {
  const trigger = { id: 1, user: { login: 'someone' }, created_at: T(5), body: '@codex review', reactions: { eyes: 0 } };
  const notice = { id: 2, user: BOT, created_at: T(6), body: QUOTA_BODY };
  const gh = fakeGh([{ issueComments: [trigger, notice] }], { head: 'bbb', headCommittedAt: T(1) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.status, 'blocked_quota');
  assert.equal(r.waited_sec, 0);
  assert.equal(gh.posts.length, 0, 'the notice already answers this trigger; asking again only produces another notice');
});

test('awaitReview --request: a quota notice older than the head re-requests once, and a real review then counts (top-up recovery)', async () => {
  const trigger = { id: 1, user: { login: 'someone' }, created_at: T(5), body: '@codex review', reactions: { eyes: 0 } };
  const notice = { id: 2, user: BOT, created_at: T(6), body: QUOTA_BODY };
  const fresh = { id: 9, user: BOT, submitted_at: T(12), commit_id: 'bbb', state: 'COMMENTED' };
  const gh = fakeGh([{ issueComments: [trigger, notice] }, { issueComments: [trigger, notice], reviews: [fresh] }], { head: 'bbb', headCommittedAt: T(8) });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(gh.posts.length, 1, 'the stale notice predates the head, so the new head is asked once');
  assert.equal(r.status, 'received');
  assert.equal(r.signal.kind, 'review');
});

test('main exits by exitCodeFor, so a blocked_quota run is distinguishable from timed_out and success', () => {
  const src = readFileSync(new URL('../plugins/aidrian/lib/pr-await-review.mjs', import.meta.url), 'utf8');
  assert.match(src, /return exitCodeFor\(result\.status\)/);
  assert.doesNotMatch(src, /status === 'timed_out' \? 2 : 0/);
});

// Verbatim body of the bot's status card on a draft, posted twelve seconds after the `@codex review` trigger.
const RUNNING_CARD_BODY =
  '<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\nThis comment shows the latest Codex review activity on this pull request.\n\n' +
  '| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n' +
  '| 📝 **Code Review** | 🔄 **Running** since <relative-time datetime="2026-09-02T14:52:49.448276Z">2026-09-02T14:52:49.448276Z</relative-time> | `c9de3bc` | Manual request |\n\n\n\n' +
  '<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment "@codex review" or "@codex security review".\n\n' +
  'Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>';
// The same card after its in-place edit.
const COMPLETED_CARD_BODY = RUNNING_CARD_BODY.replace(
  '🔄 **Running** since <relative-time datetime="2026-09-02T14:52:49.448276Z">2026-09-02T14:52:49.448276Z</relative-time>',
  '✅ **Completed** <relative-time datetime="2026-09-02T15:01:04.856075Z">2026-09-02T15:01:04.856075Z</relative-time>',
);

test('latestBotSignal: the review-summary status card is never a signal, at any status', () => {
  assert.equal(isReviewSummaryCard(RUNNING_CARD_BODY), true);
  assert.equal(isReviewSummaryCard(COMPLETED_CARD_BODY), true);
  assert.equal(isReviewSummaryCard('### Summary …'), false);
  assert.equal(isReviewSummaryCard(undefined), false);
  assert.ok(RUNNING_CARD_BODY.startsWith(REVIEW_SUMMARY_CARD_MARKER));
  const base = { reviews: [], reviewComments: [], reactions: [], reviewer: DEFAULT_REVIEWER, since: T(5) };
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  // Running: the wait must continue — this is the false `received` that sent a draft toward `gh pr ready`.
  assert.equal(latestBotSignal({ ...base, issueComments: [card] }), null);
  // Completed: still not the signal; the 👍 / review / result comment that accompanies completion is.
  assert.equal(latestBotSignal({ ...base, issueComments: [{ ...card, body: COMPLETED_CARD_BODY }] }), null);
  const withThumbs = latestBotSignal({ ...base, issueComments: [{ ...card, body: COMPLETED_CARD_BODY }], reactions: [{ user: BOT, content: '+1', created_at: T(7) }] });
  assert.equal(withThumbs.kind, 'thumbs_up');
  // Another shape: the "Didn't find any major issues" result comment lands beside the card and is the comment signal, not the card.
  const result = { id: 5511479468, user: BOT, created_at: T(7), body: "Codex Review: Didn't find any major issues. Another round soon." };
  const withResult = latestBotSignal({ ...base, issueComments: [{ ...card, body: COMPLETED_CARD_BODY }, result] });
  assert.deepEqual([withResult.kind, withResult.comment_id], ['comment', 5511479468]);
  // A quota notice is still classified even when a card sits beside it.
  assert.equal(latestBotSignal({ ...base, issueComments: [card, { id: 3, user: BOT, created_at: T(7), body: QUOTA_BODY }] }).kind, 'quota_exhausted');
});

test('awaitReview --request: a Running card plus 👀 keeps waiting without a second request, and the later review is received', async () => {
  // frame0: nothing on the PR → one request. frame1: 12 s later the card (Running)
  // and the PR-level 👀 are up. frame2: the formal review lands on head.
  const card = { id: 5511518662, user: BOT, created_at: T(11), body: RUNNING_CARD_BODY };
  const eyes = { user: BOT, content: 'eyes', created_at: T(11) };
  const review = { id: 9, user: BOT, submitted_at: T(13), commit_id: 'bbb', state: 'COMMENTED' };
  const gh = fakeGh(
    [{}, { issueComments: [card], reactions: [eyes] }, { issueComments: [{ ...card, body: COMPLETED_CARD_BODY }], reviews: [review] }],
    { head: 'bbb' },
  );
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 900, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'received');
  assert.equal(r.signal.kind, 'review');
  assert.equal(r.waited_sec, 120, 'the Running card at the first poll did not end the wait');
  assert.equal(gh.posts.length, 1, 'the acknowledged run is not re-requested');

  // Without a review ever landing, the card alone times out rather than reporting received.
  const gh2 = fakeGh([{}, { issueComments: [card], reactions: [eyes] }], { head: 'bbb' });
  const c2 = clock();
  const sleep2 = async (s) => { await c2.sleep(s); gh2.advance(); };
  const r2 = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: false, timeoutSec: 180, intervalSec: 60 }, { gh: gh2, now: c2.now, sleep: sleep2 });
  assert.equal(r2.status, 'timed_out');
  assert.equal(r2.signal, null);
  assert.equal(r2.acknowledged_at, T(11));
});

test('acknowledgedAt: a review-summary card at/after the trigger says the bot STARTED', () => {
  // Complements the "never a completed signal" test above: the same card that
  // must not end the wait is still evidence the bot picked the trigger up, so
  // --request does not re-ask. Observed: the card
  // landed 7 s after `@codex review`, before any 👀 was visible.
  const trigger = { id: 80, user: { login: 'someone' }, created_at: T(5), body: '@codex review', reactions: { eyes: 0 } };
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  assert.equal(acknowledgedAt({ reactions: [], issueComments: [trigger, card], reviewer: DEFAULT_REVIEWER, since: T(5) }), T(6));
  // The card is created once per PR and reused, so one predating this trigger
  // acknowledges nothing — a later run falls back to the 👀 reaction.
  assert.equal(acknowledgedAt({ reactions: [], issueComments: [trigger, { ...card, created_at: T(4) }], reviewer: DEFAULT_REVIEWER, since: T(5) }), null);
  // A non-bot author posting the marker is not an acknowledgement either.
  assert.equal(
    acknowledgedAt({ reactions: [], issueComments: [{ ...card, user: { login: 'someone' } }], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    null,
  );
});

test('acknowledgedAt: with NO trigger on the PR, a leftover card acknowledges nothing and --request still asks', () => {
  // The card is created once per PR and edited in place, so it carries no
  // per-run identity. On a PR holding a card from an earlier automatic
  // review but no `@codex review` comment, latestTrigger() is null and every
  // card passed the `!since` branch of the filter — so --request read the stale
  // card as "already working", skipped the trigger on every poll, and timed out
  // without ever requesting the review it was invoked for.
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  assert.equal(acknowledgedAt({ reactions: [], issueComments: [card], reviewer: DEFAULT_REVIEWER, since: null }), null);
  // Reachability: the card's own "About Codex in GitHub" block quotes the
  // trigger phrase, so a plain substring match dated `since` to the card and
  // the acknowledgement clause then read that same card as answering it.
  assert.ok(RUNNING_CARD_BODY.toLowerCase().includes(REQUEST_COMMENT), 'the card quotes the trigger phrase');
  assert.equal(latestTrigger({ pr: {}, timeline: [], issueComments: [card] }), null);
  // A real request still triggers, card or no card.
  const trigger = { id: 80, user: { login: 'someone' }, created_at: T(5), body: '@codex review' };
  assert.equal(latestTrigger({ pr: {}, timeline: [], issueComments: [card, trigger] }), T(5));
});

test('awaitReview --request: a leftover card with no trigger does not suppress the request', async () => {
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  const gh = fakeGh([{ issueComments: [card] }], { head: 'bbb' });
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'timed_out');
  assert.equal(gh.posts.length, 1, 'the trigger was posted despite the leftover card');
  assert.deepEqual(gh.posts[0].fields, { body: requestCommentBody('bbb') });
});

test('acknowledgement: a trigger naming a head outranks a NEWER status card, which decides only when nothing names one', () => {
  // The card is posted after the trigger it answers, so a newest-first sort
  // always picked it on a PR's first run — and the card carries no marker, so
  // that discarded the SHA the trigger recorded and fell back to the
  // committer-date proxy the marker exists to replace.
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  const bound = { id: 80, user: { login: 'someone' }, created_at: T(5), body: requestCommentBody('bbb'), reactions: { eyes: 1 } };
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [bound, card], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(5), headSha: 'bbb' },
    'the reacted trigger wins, and `acknowledged_at` is its own instant',
  );
  // Order in the payload does not decide it either.
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [card, bound], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(5), headSha: 'bbb' },
  );
  // Legacy: a human-typed trigger names no head, so the newest candidate still
  // decides and the committer-date fallback is untouched.
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [{ ...bound, body: REQUEST_COMMENT }, card], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(6), headSha: null },
  );
  // A trigger the bot has not reacted to is not an acknowledgement at all, so
  // the card is still what answers here.
  assert.deepEqual(
    acknowledgement({ reactions: [], issueComments: [{ ...bound, reactions: { eyes: 0 } }, card], reviewer: DEFAULT_REVIEWER, since: T(5) }),
    { at: T(6), headSha: null },
  );
});

test('awaitReview --request: a first-run card does not override the SHA-bound trigger, so the new head still gets its request', async () => {
  // The finding. Head bbb is triggered and acknowledged; the card lands at
  // T(6). Head ccc was committed at T(3) — BEFORE the card — and pushed only
  // after it. Preferring the card by recency threw away the trigger's SHA, and
  // the committer-date proxy then read the card as covering ccc: no trigger was
  // ever posted for it and the wait could not end in a review.
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  const triggerForA = { id: 80, user: { login: 'someone' }, created_at: T(5), body: requestCommentBody('bbb'), reactions: { eyes: 1 } };
  const comments = [triggerForA, card];
  const gh = fakeGh(
    [{ issueComments: comments }, { head: 'ccc', headCommittedAt: T(3), issueComments: comments }],
    { head: 'bbb', headCommittedAt: T(1) },
  );
  const c = clock();
  const sleep = async (s) => { await c.sleep(s); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'timed_out');
  assert.equal(r.head_sha, 'ccc');
  assert.equal(gh.posts.length, 1, 'the head the bot never saw gets its own @codex review, card or no card');
  assert.equal(gh.posts[0].fields.body, requestCommentBody('ccc'));
  assert.equal(r.retry_recommended, false, 'no acknowledgement covers ccc, so a re-run without --request cannot help');
});

test('awaitReview --request: a first-run card does not override a trigger naming the CURRENT head either', async () => {
  // The other direction, same precedence: the head's committer date is newer
  // than the card, which the date proxy alone calls stale — but the trigger
  // names this exact SHA, so the review in flight is this head's and a second
  // ask would only cost a run.
  const card = { id: 5511518662, user: BOT, created_at: T(6), body: RUNNING_CARD_BODY };
  const triggerForB = { id: 80, user: { login: 'someone' }, created_at: T(5), body: requestCommentBody('ccc'), reactions: { eyes: 1 } };
  const gh = fakeGh([{ issueComments: [triggerForB, card] }], { head: 'ccc', headCommittedAt: T(9) });
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh, ...clock() });
  assert.equal(r.status, 'timed_out');
  assert.equal(gh.posts.length, 0, 'the bot is mid-review on this exact head');
  assert.equal(r.acknowledged_at, T(5), 'the trigger the bot reacted to is the acknowledgement, not the card beside it');
  assert.equal(r.retry_recommended, true, 'a review for ccc is in flight, so one re-run WITHOUT --request is worth its wait');
});

test('awaitReview: --max-rounds stops before the request that would start one round too many', async () => {
  const rounds = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, user: BOT, submitted_at: T(1), commit_id: 'aaa', state: 'COMMENTED' }));
  const human = { id: 99, user: { login: 'someone' }, submitted_at: T(1), commit_id: 'aaa', state: 'COMMENTED' };
  assert.equal(codexRounds([...rounds(3), human], DEFAULT_REVIEWER), 3, 'only the bot reviews count');
  assert.equal(codexRounds(undefined, DEFAULT_REVIEWER), 0);

  // At the limit, with head ahead of the last review: nothing is posted.
  const atLimit = fakeGh([{ reviews: rounds(10) }], { head: 'bbb' });
  const c1 = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, maxRounds: 10, timeoutSec: 120, intervalSec: 60 }, { gh: atLimit, ...c1 });
  assert.equal(r.status, 'round_limit');
  assert.equal(r.codex_rounds, 10);
  assert.equal(r.max_rounds, 10);
  assert.equal(r.requested, false);
  assert.equal(atLimit.posts.length, 0);
  assert.equal(exitCodeFor(r.status), 4);

  // The default applies when the caller passes no limit.
  const byDefault = fakeGh([{ reviews: rounds(3) }], { head: 'bbb' });
  const c2 = clock();
  const d = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 120, intervalSec: 60 }, { gh: byDefault, ...c2 });
  assert.equal(d.status, 'round_limit');
  assert.equal(d.max_rounds, 3);

  // Human raised the limit: the request goes out.
  const raised = fakeGh([{ reviews: rounds(10) }], { head: 'bbb' });
  const c3 = clock();
  const up = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, maxRounds: 15, timeoutSec: 60, intervalSec: 60 }, { gh: raised, ...c3 });
  assert.equal(up.status, 'timed_out');
  assert.equal(raised.posts.length, 1);
  assert.equal(up.codex_rounds, 10, 'every status reports the round count');
  assert.ok(!('max_rounds' in up), 'only round_limit names the limit');

  // A review that already covers head is reported, never refused: no request is needed.
  const covered = fakeGh([{ reviews: [...rounds(9), { id: 50, user: BOT, submitted_at: T(2), commit_id: 'bbb', state: 'COMMENTED' }] }], { head: 'bbb' });
  const c4 = clock();
  const ok = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, maxRounds: 10, timeoutSec: 60, intervalSec: 60 }, { gh: covered, ...c4 });
  assert.equal(ok.status, 'already_present');
  assert.equal(covered.posts.length, 0);
});

// A project whose own config keeps the inbox in `base/state`, away from the developer's state folder, and a run of
// `await-review --request` on a pull request with `reviews` bot reviews, at the default limit of 3.
function roundsProject(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'aidrian-rounds-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, '.aidrian'));
  writeFileSync(path.join(base, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' } }));
  const project = projectAt(base);
  const { config } = loadConfig(project);
  assert.equal(inboxPath(project, config), path.join(base, 'state/lessons/inbox.jsonl'));
  const log = t.mock.method(console, 'log', () => {});
  const run = ({ reviews = 3, args = [], settings = config, proj = project } = {}) => {
    const rounds = Array.from({ length: reviews }, (_, i) => ({ id: i + 1, user: BOT, submitted_at: T(1), commit_id: 'aaa', state: 'COMMENTED' }));
    return runAwaitReview(['42', '--request', ...args], settings, proj, { gh: fakeGh([{ reviews: rounds }], { head: 'bbb' }), ...clock() });
  };
  return { project, config, log, run, all: () => lessons(inboxPath(project, config)) };
}

test('runAwaitReview: the round limit becomes one lesson per pull request in the project\'s inbox', async (t) => {
  const { config, log, run, all } = roundsProject(t);
  assert.equal(await run(), 4);
  assert.equal(await run(), 4);
  assert.equal(await run({ proj: null }), 4, 'no project, no lesson');
  assert.equal(await run({ settings: { ...config, lessons: { ...config.lessons, auto: false } } }), 4);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).status, 'round_limit', 'the result prints as before');
  const [only, ...rest] = all();
  assert.deepEqual([only.key, only.seen, only.target, only.evidence, rest.length], ['review-rounds', 1, 'project', ['https://github.com/acme/notes/pull/42'], 0]);
});

test('runAwaitReview: a re-run at the same round count is the same event and never reopens a resolved lesson', async (t) => {
  const { project, config, run, all } = roundsProject(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T12:00:00Z') });
  const later = () => t.mock.timers.tick(60_000);
  await run();
  const [first] = all();
  later();
  appendRow(inboxPath(project, config), { event: 'resolve', id: first.id, at: new Date().toISOString(), outcome: 'mechanism', link: 'abc1234' });
  later();
  await run();
  await run();
  assert.deepEqual([all()[0].status, all()[0].seen, all()[0].resolutions[0].recurred], ['resolved', 1, 0], 'the same pull request at the same count again is no new event');
  later();
  await run({ reviews: 4 });
  later();
  await run({ args: ['--repo', 'acme/other'] });
  await run({ args: ['--repo', 'acme/other'] });
  const [only, ...rest] = all();
  assert.deepEqual(
    [only.status, only.reopened, only.seen, only.resolutions[0].recurred, rest.length],
    ['open', 1, 3, 2, 0],
    'a new round count and another pull request are one occurrence each',
  );
});

test('awaitReview: a push mid-wait past the limit ends with round_limit, not received', async () => {
  const rounds = (n, commit) => Array.from({ length: n }, (_, i) => ({ id: i + 1, user: BOT, submitted_at: T(2), commit_id: commit, state: 'COMMENTED' }));
  // frame0: 9 reviews, head bbb unreviewed → one request. frame1: the 10th review
  // answers bbb, then a push moves head to ccc, which would need an 11th round.
  const gh = fakeGh([{ reviews: rounds(9, 'aaa') }, { reviews: rounds(10, 'bbb'), head: 'ccc' }], { head: 'bbb' });
  const c = clock();
  const sleep = async (sec) => { await c.sleep(sec); gh.advance(); };
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, maxRounds: 10, timeoutSec: 300, intervalSec: 60 }, { gh, now: c.now, sleep });
  assert.equal(r.status, 'round_limit');
  assert.equal(gh.posts.length, 1, 'only the request under the limit went out');
  assert.equal(exitCodeFor(r.status), 4);
});

test('a raised limit is recorded in the request and kept by later runs', async () => {
  const rounds = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, user: BOT, submitted_at: T(1), commit_id: 'aaa', state: 'COMMENTED' }));
  assert.ok(requestCommentBody('bbb', 15).includes('<!-- pr-await-review: max-rounds=15 -->'));
  assert.ok(!requestCommentBody('bbb', 3).includes('max-rounds'), 'the default is never recorded');
  const raised = { user: { login: 'someone' }, created_at: T(1), body: requestCommentBody('aaa', 15) };
  const quoted = { user: { login: 'someone' }, created_at: T(1), body: 'see `<!-- pr-await-review: max-rounds=99 -->`' };
  assert.equal(recordedMaxRounds([raised, quoted]), 15, 'a marker outside a request raises nothing');
  assert.equal(recordedMaxRounds([]), null);

  // A bare --request (default 10) on a PR with 12 reviews and a recorded 15 still asks.
  const gh = fakeGh([{ reviews: rounds(12), issueComments: [raised] }], { head: 'bbb' });
  const c = clock();
  const r = await awaitReview({ pr: '42', repo: null, reviewer: DEFAULT_REVIEWER, request: true, timeoutSec: 60, intervalSec: 60 }, { gh, ...c });
  assert.equal(r.status, 'timed_out');
  assert.equal(gh.posts.length, 1);
  assert.ok(gh.posts[0].fields.body.includes('max-rounds=15'), 'the raised limit rides on every later request');
});

test('REQUEST_INSTRUCTIONS asks for every location of a repeated mistake in one finding', () => {
  assert.match(REQUEST_INSTRUCTIONS, /same mistake/);
  assert.match(REQUEST_INSTRUCTIONS, /every other location in that one finding/);
});

test('config.json github.reviewer and github.maxReviewRounds are the defaults, and flags still win', () => {
  const fromConfig = parseArgs([], { reviewer: 'review-bot[bot]', maxRounds: 4 });
  assert.deepEqual([fromConfig.reviewer, fromConfig.maxRounds, fromConfig.timeoutSec], ['review-bot[bot]', 4, 840]);
  assert.deepEqual(parseArgs(['--reviewer', 'other[bot]', '--max-rounds', '6'], { reviewer: 'review-bot[bot]', maxRounds: 4 }).maxRounds, 6);
});

test('aidrian pr prints its usage for an unknown action, and await-review reports a bad flag on one line', () => {
  const cli = new URL('../plugins/aidrian/bin/aidrian', import.meta.url).pathname;
  const unknown = spawnSync(cli, ['pr', 'merge'], { encoding: 'utf8' });
  assert.deepEqual([unknown.status, unknown.stderr.split('\n')[0]], [1, 'usage: aidrian pr await-review [PR] [--request] [--max-rounds N] | checks [PR] [--json] | disposition --severity S [--likelihood L --affects A] [--cost C] [--source bot [--round N]] [--vocab]']);
  const bad = spawnSync(cli, ['pr', 'await-review', '--bogus'], { encoding: 'utf8' });
  assert.deepEqual([bad.status, bad.stderr], [1, 'aidrian pr await-review: unknown argument: --bogus\n']);
});
