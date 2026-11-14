// The engine's posts on a pull request's diff (review.publish.inline, docs/review.md#publishing), and what it reads of
// them back:
//
// - The marked comments (readMarked): the pull request's conversation comments, reviews, and review comments, read once
//   a step whose record is posted. From them the step raises the id counter past every member's marker (raiseFloor),
//   lists the engine's comments for pr-review-loop (engineLists), and finds a comment no record maps for the delete.
// - The inline review (postInline): one review a step, each new blocking finding on an added line of the diff as its
//   own thread, the rest in its body, and one conversation comment in its place when the forge refuses it.
//
// The markers every post starts with are in lib/review/markers.mjs, the delete of the engine's own comment for a
// security finding in lib/review/delete.mjs, and the replies on a finding's thread in lib/review/replies.mjs.
// Every forge call goes through the step's forge (lib/forges/index.mjs): no route, status code, or gh message here.

import { isTrustedCommenter, MAX_BODY } from '../forges/index.mjs';
import { loadTable } from '../finding-disposition.mjs';
import { isObject } from '../fs.mjs';
import { showPrefix } from '../git.mjs';
import { diffLines } from './diff.mjs';
import { blocks, FINDING_ID, freshId, isFindingId, severityOf } from './findings.mjs';
import { attributionLine, entries, idsOf, KINDS, leadingMarkers, mappedPosts, memberMarked, withMarkers } from './markers.mjs';
import { capped, LINE_BREAK, POST_CAP, securityIds, TEXT_CAP, TITLE_CAP, WITHHELD } from './publish.mjs';

export { attributionLine, FINDING_MARKER, leadingMarkers, markerLine } from './markers.mjs';
// The most inline comments one review holds; the rest are listed in its body and get their thread from a later review.
export const MAX_THREADS = 25;

// ---- The marked comments ----

// Every conversation comment (`conversation`, as the step read them), review, and review comment of the pull request, as
// { items }: each { kind, id, login, member, markers, starts }, `starts` false for a review comment that replies in a
// thread, and on a review comment `review`, the id of the review that holds it (null when the forge names none).
// { error } when a read fails or answers anything but a list of items with a safe-integer id: a partial read counts as
// failed, since the floor and the lists fail closed.
export function readMarked(forge, repo, n, conversation) {
  let lists;
  try {
    lists = [[KINDS.comment, conversation], [KINDS.review, forge.reviews(repo, n)], [KINDS.reviewComment, forge.reviewComments(repo, n)]];
  } catch {
    return { error: 'the pull request\'s comments and reviews could not be read' };
  }
  const items = [];
  for (const [kind, list] of lists) {
    if (!Array.isArray(list) || list.some((each) => !isObject(each) || !Number.isSafeInteger(each.id))) return { error: 'the pull request\'s comments and reviews were read only in part' };
    for (const each of list) {
      const review = Number.isSafeInteger(each.pull_request_review_id) ? each.pull_request_review_id : null;
      items.push({
        kind, id: each.id, login: typeof each.user?.login === 'string' ? each.user.login : null, member: isTrustedCommenter(each),
        markers: leadingMarkers(each.body), starts: !(kind === KINDS.reviewComment && each.in_reply_to_id !== undefined && each.in_reply_to_id !== null),
        ...(kind === KINDS.reviewComment ? { review } : {}),
      });
    }
  }
  return { items };
}

// Raises `state`'s id counter past the highest id among the markers of members' posts (R4), so an id restarted or lost
// with a record is never minted again. Returns the highest marker number, 0 with none.
export function raiseFloor(state, items) {
  const highest = Math.max(0, ...memberMarked(items).flatMap((item) => item.markers).map((id) => Number(FINDING_ID.exec(id)[2])));
  const counter = Number.isSafeInteger(state.idCounter) && state.idCounter > 0 ? state.idCounter : 0;
  if (highest > counter) state.idCounter = highest;
  return highest;
}

// The two lists of the engine's posts a step returns (R7, G3), from the marked items of members: `engine_comments`, each
// one whose own id the index of `state` maps to a finding its markers name, a thread's root or the engine's reply in it,
// and `engine_comments_unmapped`, the rest, all of them with no `state`. Each entry is { kind, id, findings, login }.
// A reply with no marker and a marked post by someone who is no member are on neither.
export function engineLists(items, state = null) {
  const mapped = state ? mappedPosts(state) : new Map();
  const shown = (item) => ({ kind: item.kind, id: item.id, findings: item.markers, login: item.login });
  const own = (item) => item.markers.some((id) => mapped.get(`${item.kind}:${item.id}`)?.has(id));
  const marked = memberMarked(items);
  return { engine_comments: marked.filter(own).map(shown), engine_comments_unmapped: marked.filter((item) => !own(item)).map(shown) };
}

// Fills in the comment id of each entry whose thread holds a review's id alone, as postInline leaves an inline comment
// whose review it could not read back: from `items` (readMarked's), the one review comment of a member that starts a
// thread, is held by that same review, and whose leading markers name the entry's id. A review body's finding has no such
// comment and keeps the review's id alone. Returns the ids filled in.
export function fillThreads(state, items) {
  if (!Array.isArray(items)) return [];
  const filled = [];
  for (const entry of entries(state)) {
    const thread = entry.thread;
    if (!isObject(thread) || !Number.isSafeInteger(thread.reviewId) || thread.commentId !== undefined || thread.fallbackId !== undefined) continue;
    const found = memberMarked(items).filter((item) => item.kind === KINDS.reviewComment && item.starts && item.review === thread.reviewId && item.markers.includes(entry.id));
    if (found.length !== 1) continue;
    thread.commentId = found[0].id;
    filled.push(entry.id);
  }
  return filled;
}

// ---- The inline review ----

const SEVERITIES = loadTable().severities;
const ID_PARTS = /^R(\d+)-(\d+)$/u;
const order = (a, b) => {
  const rank = (entry) => {
    const at = SEVERITIES.indexOf(severityOf(entry.severity));
    return at === -1 ? SEVERITIES.length : at;
  };
  const [ra, rb] = [a, b].map((entry) => ID_PARTS.exec(entry.id).slice(1).map(Number));
  return rank(a) - rank(b) || ra[0] - rb[0] || ra[1] - rb[1];
};
const posted = (entry) => isObject(entry.thread) && ['reviewId', 'commentId', 'fallbackId'].some((key) => Number.isSafeInteger(entry.thread[key]));

// The new blocking findings of `open` (a step's open passes, each with its `findings`) that get posted: each listed
// finding that blocks, with an open index entry and no post yet, once per id, in severity order. A security finding, by
// the projection's reading (publish.mjs securityIds) and its twins with it, is left out unless `shown`.
function newBlocking(state, open, shown) {
  const secure = shown ? new Set() : securityIds(state);
  const index = isObject(state.index) ? state.index : {};
  const seen = new Map();
  for (const pass of Array.isArray(open) ? open : []) {
    for (const finding of Array.isArray(pass?.findings) ? pass.findings : []) {
      if (!isObject(finding) || !isFindingId(finding.id) || seen.has(finding.id) || !blocks(finding)) continue;
      const entry = index[finding.id];
      if (!isObject(entry) || entry.state !== 'open' || posted(entry) || idsOf(entry).some((id) => secure.has(id))) continue;
      seen.set(finding.id, { finding, entry });
    }
  }
  return [...seen.values()].sort((a, b) => order(a.entry, b.entry));
}

// The section of one finding in a post, as raw lines, each { text, quoted }: the attribution line, the severity with
// its location when `place` is given, and the reviewer's title and body quoted, or `text withheld` when `withheld`.
// The title and body are capped first, each with one line counting what was cut.
function section({ id, severity, place, title, body, withheld }) {
  const lines = [{ text: attributionLine(id) }, { text: `**${severity}**${place ? ` at \`${place.replaceAll('`', '')}\`` : ''}` }];
  if (withheld) return [...lines, { text: WITHHELD }];
  const head = capped(title, TITLE_CAP);
  const text = capped(body, TEXT_CAP);
  lines.push({ text: `**${head.text}**`, quoted: true });
  if (text.text) lines.push({ text: '', quoted: true }, ...text.text.split(LINE_BREAK).map((line) => ({ text: line, quoted: true })));
  const cut = head.cut + text.cut;
  if (cut) lines.push({ text: `_${cut} more ${cut === 1 ? 'character' : 'characters'} not shown._` });
  return lines;
}

// The most ids one line of a post lists; the rest are counted. A list of leftover findings is bounded on its own, so it
// never crowds every section out of a body: ids only (each at most R999-999999), no location, at most MAX_LISTED.
export const MAX_LISTED = 20;
const idList = (ids) => (ids.length > MAX_LISTED ? `${ids.slice(0, MAX_LISTED).join(', ')}, and ${ids.length - MAX_LISTED} more` : ids.join(', '));
const findings = (count) => `${count} more ${count === 1 ? 'finding' : 'findings'}`;

// The line that lists the ids a body could not hold.
const notice = (left) => (left.length ? [{ text: '' }, { text: `${findings(left.length)} not shown here, posted by a later step: ${idList(left)}` }] : []);

// A body of several findings' sections, as many as fit: the raw text at most POST_CAP characters, and the escaped body
// with its markers at most the forge's MAX_BODY, each measured with the `trailer` and with the notice of what is left at
// its longest, as if every later part were left too: the last part that fits is measured with exactly the notice the
// body ends with. Returns { body, ids, left }, `left` the ids that did not fit.
export function fitBody(parts, trailer = []) {
  const ids = [];
  const lines = [];
  const left = [];
  const raw = (each) => each.reduce((total, line) => total + String(line.text).length + 1, 0);
  parts.forEach((part, at) => {
    const next = [...lines, ...(lines.length ? [{ text: '' }] : []), ...part.lines];
    const whole = [...next, ...trailer, ...notice([...left, ...parts.slice(at + 1).map((each) => each.id)])];
    if (raw(whole) > POST_CAP || withMarkers([...ids, part.id], whole).length > MAX_BODY) {
      left.push(part.id);
      return;
    }
    ids.push(part.id);
    lines.splice(0, lines.length, ...next);
  });
  return { body: withMarkers(ids, [...lines, ...trailer, ...notice(left)]), ids, left };
}

// Posts the step's new blocking findings as one review on `head` (review.publish.inline), and records where each went on
// its index entry: `thread: { reviewId, commentId }` for an inline comment, `{ reviewId }` for the review body, and
// `{ fallbackId }` for the fallback comment. `s` is the step context (lib/review/step.mjs): forge, repo, n, head, base,
// root, state, paths, marked, and post(), the write's post context. Returns the step result's `inline_review`, or null
// when nothing is posted.
// - An id that already has a thread, or whose marker a member's post already carries, is never posted under that id: the
//   second takes a fresh one first (findings.mjs freshId).
// - A finding gets an inline comment on an added line of the diff from the merge base to `head`, at a file and line that
//   pass the File and line check there, at most MAX_THREADS of them, the most severe first; the rest are listed in the
//   review body by id alone, at most MAX_LISTED of them and the rest counted, unposted. Any other goes in the body, its location printed only from a
//   file and line that pass that check.
// - On a pull request from outside the team, where a text check withholds the title or the body, and for a security
//   finding (securityIds) on a repository that does not read as PRIVATE, which only publicSecurity "full" lets through,
//   the post holds the id, the severity, the location, and `text withheld`. A path is printed, and anchored to, only when
//   the text checks pass it too; else the finding goes in the body with no location.
// - A review the forge refuses is posted once as a conversation comment with the same content. A fallback that fails,
//   or a review whose post fails, leaves its findings unposted: the result names them, and the next step tries again.
export function postInline(s, open) {
  const { forge, repo, n, head, base, root, state } = s;
  const context = s.post();
  if (context.publish?.inline !== true) return null;
  if (!Array.isArray(s.marked?.items)) return { posted: false, reason: 'the pull request\'s comments could not be read, so no review was posted on this step' };
  const shown = context.reading?.visibility === 'PRIVATE' || context.publish?.publicSecurity === 'full';
  const found = newBlocking(state, open, shown);
  if (!found.length) return null;
  // An id a member's post already carries is never posted again: it takes a fresh id first (R4).
  const carried = new Set(memberMarked(s.marked.items).flatMap((item) => item.markers));
  const unminted = [];
  for (const each of found) {
    if (!carried.has(each.entry.id)) continue;
    const id = freshId(state, each.entry.id);
    if (id) each.entry = state.index[id];
    else unminted.push(each.entry.id);
  }
  const ready = found.filter((each) => !unminted.includes(each.entry.id));

  const prefix = showPrefix(root);
  let added = {};
  try {
    // Renames detected, as the forge's diff of the pull request shows them: an unchanged line of a moved file is no
    // added line.
    added = diffLines(root, base, head, null, { renames: true }).addedAt;
  } catch {}
  const checked = (entry) => {
    const file = entry.file;
    // A path that holds a line break would print lines of its own into a post: it is neither printed nor anchored.
    if (typeof file !== 'string' || LINE_BREAK.test(file) || s.paths?.tracked(head, file) !== true || !context.checker.allows(file)) return null;
    const count = s.paths.lines(head, file);
    const line = Number.isSafeInteger(entry.line) && entry.line >= 1 && Number.isSafeInteger(count) && entry.line <= count ? entry.line : null;
    return { file, line };
  };
  const inside = context.reading?.inside === true;
  // A security finding's text is never posted where the repository does not read as PRIVATE, under either value of
  // publicSecurity: "full" gives it a thread and its place alone (R5).
  const secret = context.reading?.visibility === 'PRIVATE' ? new Set() : securityIds(state);
  // A check that withholds a finding's text holds no record: the flag the summary reads stays as it was.
  const failedBefore = context.checker.failed;
  const parts = ready.map(({ finding, entry }) => {
    const place = checked(entry);
    const withheld = !inside || idsOf(entry).some((id) => secret.has(id)) || !context.checker.allows(String(finding.title ?? ''))
      || (typeof finding.body === 'string' && !context.checker.allows(finding.body));
    const severity = severityOf(entry.severity) ?? 'unknown';
    const anchored = place?.line && (added[place.file] ?? []).includes(place.line);
    const shownPlace = place ? (place.line ? `${place.file}:${place.line}` : place.file) : null;
    return { id: entry.id, entry, anchored, place, severity, shownPlace, text: { title: finding.title, body: finding.body, withheld } };
  });
  if ('failed' in context.checker) context.checker.failed = failedBefore;
  const threads = parts.filter((part) => part.anchored).slice(0, MAX_THREADS);
  const listed = parts.filter((part) => part.anchored).slice(MAX_THREADS);
  const inBody = parts.filter((part) => !part.anchored);
  const full = (part, place) => ({ id: part.id, lines: section({ id: part.id, severity: part.severity, place, ...part.text }) });
  const drafted = threads.map((part) => ({ part, path: `${prefix}${part.place.file}`, line: part.place.line, side: 'RIGHT', body: withMarkers([part.id], section({ id: part.id, severity: part.severity, ...part.text })) }));
  const comments = drafted.filter((comment) => comment.body.length <= MAX_BODY);
  const tooLong = drafted.filter((comment) => comment.body.length > MAX_BODY).map((comment) => comment.part.id);
  const overflow = listed.length ? [{ text: '' }, { text: `${findings(listed.length)} on the diff, posted by a later step: ${idList(listed.map((part) => part.id))}` }] : [];
  const onDiff = (part) => ({ id: part.id, lines: [{ text: attributionLine(part.id) }, { text: `**${part.severity}**, on the diff at \`${part.shownPlace.replaceAll('`', '')}\`` }] });
  const review = fitBody([...comments.map(({ part }) => onDiff(part)), ...inBody.map((part) => full(part, part.shownPlace))], overflow);
  const result = { posted: false, threads: [], in_body: [], listed: [...listed.map((part) => part.id), ...tooLong, ...review.left], ...(unminted.length ? { unminted } : {}) };
  // An inline comment whose section did not fit the review body is not posted with it: a later step posts it.
  const sent = comments.filter((comment) => review.ids.includes(comment.part.id));
  const bodyIds = inBody.map((part) => part.id).filter((id) => review.ids.includes(id));
  if (!sent.length && !bodyIds.length) return { ...result, unposted: ready.map((each) => each.entry.id) };

  let answer;
  try {
    answer = forge.postReview(repo, n, { commitId: head, body: review.body, comments: sent.map(({ path, line, side, body }) => ({ path, line, side, body })) });
  } catch (error) {
    return { ...result, unposted: [...sent.map((comment) => comment.part.id), ...bodyIds], error: String(error?.message ?? error).split('\n')[0].slice(0, 200) };
  }
  if (answer?.refused === true) return fallback(s, { result, sent, bodyIds, inBody, full });
  const reviewId = answer.id;
  // The step's lists name the new posts with the login the forge answered the post with, as a later step reads it.
  const login = typeof answer.login === 'string' ? answer.login : null;
  // When the read of the review's comments fails, an inline comment's entry keeps the review's id alone, and reads as
  // posted in the body: it is never posted twice. A later step maps its comment by its marker (fillThreads).
  const byMarker = new Map((Array.isArray(answer.comments) ? answer.comments : []).filter((each) => Number.isSafeInteger(each?.id))
    .map((each) => [leadingMarkers(each.body)[0], each.id]));
  for (const { part } of sent) {
    const commentId = byMarker.get(part.id);
    part.entry.thread = { reviewId, ...(Number.isSafeInteger(commentId) ? { commentId } : {}) };
    if (Number.isSafeInteger(commentId)) s.marked.items.push({ kind: KINDS.reviewComment, id: commentId, login, member: true, markers: [part.id], starts: true });
  }
  for (const id of bodyIds) state.index[id].thread = { reviewId };
  s.marked.items.push({ kind: KINDS.review, id: reviewId, login, member: true, markers: review.ids, starts: true });
  return { ...result, posted: true, review_id: reviewId, threads: sent.map((comment) => comment.part.id), in_body: bodyIds };
}

// The refused review's content as one conversation comment: every finding it held, each with its full section. A
// comment that fails leaves them unposted.
function fallback(s, { result, sent, bodyIds, inBody, full }) {
  const { forge, repo, n, state } = s;
  const parts = [...sent.map((comment) => full(comment.part, comment.part.shownPlace)), ...inBody.filter((part) => bodyIds.includes(part.id)).map((part) => full(part, part.shownPlace))];
  const comment = fitBody(parts);
  const refused = { ...result, refused: true, listed: [...result.listed, ...comment.left] };
  let answer;
  try {
    answer = forge.postComment(repo, n, comment.body);
  } catch (error) {
    return { ...refused, unposted: comment.ids, error: String(error?.message ?? error).split('\n')[0].slice(0, 200) };
  }
  const fallbackId = answer?.id;
  if (!Number.isSafeInteger(fallbackId)) return { ...refused, unposted: comment.ids, error: 'the forge answered the fallback comment with no id' };
  for (const id of comment.ids) state.index[id].thread = { fallbackId };
  s.marked.items.push({ kind: KINDS.comment, id: fallbackId, login: typeof answer?.user?.login === 'string' ? answer.user.login : null, member: true, markers: comment.ids, starts: true });
  return { ...refused, posted: true, fallback_comment: fallbackId, in_body: comment.ids };
}
