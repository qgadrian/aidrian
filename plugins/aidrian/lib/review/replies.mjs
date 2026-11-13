// The replies (docs/review.md#replies): once a finding with a thread closes, one reply on that thread with its outcome,
// and the thread resolved when it is the engine's alone; once it opens again, the thread unresolved, and the next
// closing answered with a reply of its own. Every forge call goes through the step's forge (lib/forges/index.mjs).

import { isTrustedCommenter } from '../forges/index.mjs';
import { isObject } from '../fs.mjs';
import { attributionLine, currentUser, entries, idsOf, KINDS, leadingMarkers, markerLine, sameLogin, withMarkers } from './markers.mjs';
import { replyLines, securityIds } from './publish.mjs';

// The states a finding's thread is answered in: closed as fixed or not reported again, or accepted. Only fixed and
// not_reported are final: an accepted finding can open again (findings.mjs entryState).
const ANSWERED = new Set(['fixed', 'not_reported', 'accepted']);
// The lists of a step's delete (delete.mjs deleteOwn) whose findings get no reply: a comment it deleted, or one it meant
// to and did not, which holds what may be a security finding's text (G4).
const UNDELETED = ['deleted', 'waiting', 'left', 'failed'];

const hasRoot = (entry) => isObject(entry.thread) && Number.isSafeInteger(entry.thread.commentId);
// A closed finding whose thread still lacks its reply or its resolve.
const closedDue = (entry) => ANSWERED.has(entry.state) && !(entry.thread.replied === true && entry.thread.resolved === true);
// An open finding whose thread an earlier closing resolved.
const reopenDue = (entry) => entry.state === 'open' && entry.thread.resolved === true;

// Notes each finding that opened again after its thread was answered: the reply's id moves to the thread's `earlier`,
// the replies of closings before, and `replied` clears, so its next closing gets a reply of its own and an earlier
// reply is never taken for it. `resolved` stays until the forge answers that the thread is open (unresolve). A record
// change alone: no forge call.
export function noteReopened(state) {
  for (const entry of entries(state)) {
    const thread = entry.thread;
    if (entry.state !== 'open' || !isObject(thread) || !(thread.replied === true || Number.isSafeInteger(thread.replyId))) continue;
    if (Number.isSafeInteger(thread.replyId)) thread.earlier = [...new Set([...(Array.isArray(thread.earlier) ? thread.earlier : []).filter(Number.isSafeInteger), thread.replyId])];
    delete thread.replyId;
    delete thread.replied;
  }
}

// The review threads of the pull request, read once a step through the forge: { at(rootId) }, the thread whose first
// comment is that review comment, or null; or { error } when the read fails.
export function readThreads(forge, repo, n) {
  let threads;
  try {
    threads = forge.findingThreads(repo, n);
  } catch {
    return { error: 'the pull request\'s review threads could not be read' };
  }
  if (!Array.isArray(threads)) return { error: 'the pull request\'s review threads could not be read' };
  const byRoot = new Map();
  for (const thread of threads) {
    const root = isObject(thread) && Array.isArray(thread.comments) ? thread.comments[0] : null;
    if (Number.isSafeInteger(root?.id) && !byRoot.has(root.id)) byRoot.set(root.id, thread);
  }
  return { at: (id) => byRoot.get(id) ?? null };
}

// Answers each finding's thread (review.publish.replies, with inline on). `s` is the step context (lib/review/step.mjs),
// with `deletes`, the step's deleteOwn result, and `viewer`, its one read of the forge's current user.
// - A closed finding (fixed, not reported again, or accepted) gets one reply, the marker line and the attribution line,
//   then `Fixed in <compare link>.`, `Not reported again in <compare link>.`, or `Accepted as <disposition>.`
//   (publish.mjs replyLines), checked by the text checks and escaped as every post is (R3), and no reviewer text. Then
//   the thread is resolved, when nobody else has replied in it (R8). The entry's thread records `replied` and the
//   reply's `replyId`, and `resolved`, each only once its own forge call succeeded (A5), and the reply joins the step's
//   read of the marked posts. One a step could not answer is tried again by the next.
// - A finding that opened again after its thread was answered (noteReopened) has its thread unresolved, and `resolved`
//   clears once the forge answers that the thread is open; a failed unresolve is tried again by the next step.
// - A security finding the reading does not show (the projection's securityIds) gets no call, nor one the delete named
//   (G4).
// - The pull request's threads are read once (readThreads). A call goes only to a thread whose root is the finding's
//   comment, written by the forge's current user, whose leading markers name the finding's id. One another member wrote
//   is not this machine's (Q2-A5): it is listed in `waiting` with the root's login as the forge returned it, and the
//   record keeps no login. Any other root, and a thread whose root the step's read of the review comments no longer
//   holds, gets nothing and is listed in `left`, which nothing acts on. A thread the read finds none for, though that
//   read still holds its root, was missed, and is unanswered. A reply the current user posted with the finding's marker,
//   and no earlier closing's, counts as the reply, so a mark a stale write lost never posts a second.
// - A thread anyone else replied in, the current user without the marker included, stays open, and counts as done:
//   listed in `open`. One already resolved counts as resolved.
// Returns null when no finding is due, else { replied, resolved, reopened, open, waiting, left, unanswered }: the ids
// replied to, resolved, and unresolved on this step, those left open, those waiting on another machine ({ finding,
// login }), those not this machine's, and the ids still unanswered, which the next step tries again, with `reasons` by
// id (`error` says why when none could be tried).
export function answerThreads(s) {
  const { forge, repo, n, state } = s;
  noteReopened(state);
  const context = s.post();
  if (context.publish?.inline !== true || context.publish?.replies !== true) return null;
  const shown = context.reading?.visibility === 'PRIVATE' || context.publish?.publicSecurity === 'full';
  const secure = shown ? new Set() : securityIds(state);
  const undeleted = new Set(UNDELETED.flatMap((key) => (Array.isArray(s.deletes?.[key]) ? s.deletes[key] : [])).map((each) => each.finding));
  const due = entries(state).filter((entry) => hasRoot(entry) && (closedDue(entry) || reopenDue(entry)) && !idsOf(entry).some((id) => secure.has(id) || undeleted.has(id)));
  if (!due.length) return null;
  const out = { replied: [], resolved: [], reopened: [], open: [], waiting: [], left: [], unanswered: [] };
  const reasons = {};
  const miss = (id, reason) => {
    out.unanswered.push(id);
    reasons[id] = reason;
  };
  const viewer = currentUser(s.viewer ?? (() => forge.viewer()));
  const threads = viewer ? readThreads(forge, repo, n) : { error: 'the forge\'s current user could not be read' };
  if (threads.error) {
    for (const entry of due) miss(entry.id, threads.error);
    return { ...out, reasons, error: threads.error };
  }
  const t = { s, context, viewer, out, miss };
  // A reply's check withholds nothing the record holds: the flag the summary reads stays as it was.
  const failedBefore = context.checker.failed;
  for (const entry of due) {
    const read = ownThread(t, entry, threads.at(entry.thread.commentId));
    if (!read) continue;
    if (entry.state === 'open') unresolve(t, entry, read);
    else if (reply(t, entry, read)) resolve(t, entry, read);
  }
  if ('failed' in context.checker) context.checker.failed = failedBefore;
  return Object.keys(reasons).length ? { ...out, reasons } : out;
}

// The thread `read` of `entry` when it is this machine's to answer, else null, with the entry listed where it belongs.
function ownThread({ s, viewer, out, miss }, entry, read) {
  const { id, thread } = entry;
  // A root the step's read of the review comments no longer holds is gone: nothing is left to answer. One it still
  // holds is a thread the read missed. With no such read, the step cannot tell, and tries again.
  const held = !Array.isArray(s.marked?.items) || s.marked.items.some((item) => item.kind === KINDS.reviewComment && item.id === thread.commentId);
  if (read === null) {
    if (held) miss(id, 'no thread was found at its comment, which the pull request still holds');
    else out.left.push(id);
    return null;
  }
  if (!isObject(read) || !Array.isArray(read.comments) || read.complete !== true) {
    miss(id, 'the thread was read only in part');
    return null;
  }
  const root = read.comments[0];
  if (!isObject(root) || root.id !== thread.commentId || !leadingMarkers(root.body).includes(id)) {
    out.left.push(id);
    return null;
  }
  if (!sameLogin(root.user?.login, viewer)) {
    if (isTrustedCommenter(root)) out.waiting.push({ finding: id, login: typeof root.user?.login === 'string' ? root.user.login : null });
    else out.left.push(id);
    return null;
  }
  return read;
}

// Whether `comment` is the current user's, with the finding `id`'s marker.
const ours = (comment, id, viewer) => isObject(comment) && sameLogin(comment.user?.login, viewer) && leadingMarkers(comment.body).includes(id);

// The closing's reply on the thread of `entry`, unless it already has one. Returns whether it has one now.
function reply({ s, context, viewer, out, miss }, entry, read) {
  const { id, thread } = entry;
  if (thread.replied === true) return true;
  const earlier = new Set(Array.isArray(thread.earlier) ? thread.earlier : []);
  const found = read.comments.slice(1).find((comment) => ours(comment, id, viewer) && Number.isSafeInteger(comment.id) && !earlier.has(comment.id));
  if (found) {
    Object.assign(thread, { replied: true, replyId: found.id });
    return true;
  }
  const body = replyLines(entry, context.compareUrl).map((line) => ({ raw: [markerLine(id), attributionLine(id), line].join('\n'), line }))
    .find((each) => context.checker.allows(each.raw));
  if (!body) {
    miss(id, 'the text checks withheld every form of the reply');
    return false;
  }
  let answer;
  try {
    answer = s.forge.replyToReviewComment(s.repo, s.n, thread.commentId, withMarkers([id], [{ text: attributionLine(id) }, { text: body.line }]));
  } catch {
    miss(id, 'the reply failed');
    return false;
  }
  // A reply the forge answered with no id is not marked: the next step finds it on the thread, with its id, as an
  // earlier reply, so it is never left unmapped.
  if (!Number.isSafeInteger(answer?.id)) {
    miss(id, 'the forge answered the reply with no id');
    return false;
  }
  Object.assign(thread, { replied: true, replyId: answer.id });
  out.replied.push(id);
  s.marked?.items?.push({ kind: KINDS.reviewComment, id: answer.id, login: viewer, member: true, markers: [id], starts: false, review: null });
  return true;
}

// Resolves the thread of `entry` once it has its reply, when nobody else has replied in it.
function resolve({ s, viewer, out, miss }, entry, read) {
  const { id, thread } = entry;
  if (thread.resolved === true) return;
  if (read.resolved === true) {
    thread.resolved = true;
    return;
  }
  const rest = read.comments.slice(1);
  if (rest.some((comment) => !ours(comment, id, viewer))) {
    out.open.push(id);
    return;
  }
  // The forge reads the thread again just before it resolves it, and resolves nothing when a comment other than the
  // root and this user's marked replies landed since this step's read: that thread stays open, as one replied in (R8).
  const only = [thread.commentId, ...rest.map((comment) => comment.id), thread.replyId].filter(Number.isSafeInteger);
  let resolved;
  try {
    resolved = s.forge.resolveThread(s.repo, s.n, thread.commentId, { only: [...new Set(only)] });
  } catch {
    miss(id, 'the resolve failed');
    return;
  }
  if (resolved?.others === true) {
    out.open.push(id);
    return;
  }
  if (resolved?.resolved !== true) {
    miss(id, 'the forge did not answer that the thread is resolved');
    return;
  }
  thread.resolved = true;
  out.resolved.push(id);
}

// Unresolves the thread of `entry`, a finding that opened again after an earlier closing resolved it. A thread someone
// already opened again needs no call.
function unresolve({ s, out, miss }, entry, read) {
  const { id, thread } = entry;
  if (read.resolved === true) {
    let answer;
    try {
      answer = s.forge.unresolveThread(s.repo, s.n, thread.commentId);
    } catch {
      miss(id, 'the unresolve failed');
      return;
    }
    if (answer?.resolved !== false) {
      miss(id, 'the forge did not answer that the thread is open');
      return;
    }
  }
  delete thread.resolved;
  out.reopened.push(id);
}
