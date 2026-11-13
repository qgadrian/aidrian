// The delete (docs/review.md#inline-reviews): on a repository that does not read as PRIVATE, under either publicSecurity
// value, the engine's own inline comment, reply, or fallback comment for a security finding goes, each checked through
// the forge at the point of action. Every forge call goes through the step's forge (lib/forges/index.mjs).

import { isTrustedCommenter } from '../forges/index.mjs';
import { isObject } from '../fs.mjs';
import { attributionLine, currentUser, entries, idsOf, KINDS, leadingMarkers, mappedPosts, memberMarked, sameLogin } from './markers.mjs';
import { securityIds } from './publish.mjs';

// The thread keys that name a comment, each with its kind.
const COMMENT_KEYS = Object.freeze({ replyId: KINDS.reviewComment, commentId: KINDS.reviewComment, fallbackId: KINDS.comment });

// Takes comment `id` of `kind` out of every entry's thread that maps it, a thread's root or the engine's reply in it, and
// an emptied thread off its entry: a deleted fallback comment's other findings then read as unposted, and a later step
// posts them again. A deleted reply keeps `replied`, so no step posts it again.
function unmap(state, kind, id) {
  const keys = Object.keys(COMMENT_KEYS).filter((key) => COMMENT_KEYS[key] === kind);
  for (const entry of entries(state)) {
    if (!isObject(entry.thread)) continue;
    for (const key of keys) {
      if (entry.thread[key] !== id) continue;
      delete entry.thread[key];
      spare(entry.thread, key, false);
    }
    if (!Object.keys(entry.thread).length) delete entry.thread;
  }
}

// Sets or clears the mark that the comment a thread's `key` names was spared under publicSecurity "full" for holding
// none of its finding's text (`textless`): a later step does not read it again while "full" holds.
function spare(thread, key, on) {
  const kept = new Set(Array.isArray(thread.textless) ? thread.textless.filter((each) => each in COMMENT_KEYS) : []);
  if (on) kept.add(key);
  else kept.delete(key);
  if (kept.size) thread.textless = [...kept].sort();
  else delete thread.textless;
}

// The comments the record maps to a security id of `state`, the reply first, then the root, then the fallback comment,
// each { finding, ids, kind, id, key, entry }, less one `done` holds and, under "full", one already spared.
function mappedCandidates(state, secure, { done, full }) {
  const out = [];
  for (const entry of entries(state)) {
    if (!idsOf(entry).some((id) => secure.has(id)) || !isObject(entry.thread)) continue;
    const spared = full && Array.isArray(entry.thread.textless) ? entry.thread.textless : [];
    for (const [key, kind] of Object.entries(COMMENT_KEYS)) {
      const id = entry.thread[key];
      if (!Number.isSafeInteger(id) || done?.has(`${kind}:${id}`) || spared.includes(key)) continue;
      out.push({ finding: entry.id, ids: idsOf(entry), kind, id, key, entry });
    }
  }
  return out;
}

// Deletes the engine's own inline comment, its reply in that thread, or its fallback comment of each security-marked id
// of `state` (G4, H1, J2, K2), on a repository that does not read as PRIVATE, under either publicSecurity value,
// whatever review.publish.inline, the local file, and review.record say: a delete removes and never posts. Under
// "counts" every such comment goes, since even one with its text withheld shows the finding's place. Under "full" a
// place may show, so a comment whose section of that finding holds no reviewer text, as postInline posts a security
// finding there, is spared and listed as `textless`, and its thread notes it (`textless`), so a later step under "full"
// reads it no more; one posted with its text before the mark goes. `mode` is "posted" (the record is on the pull
// request), "local" (review.record "local": the comments the record maps alone), or "held" (a held record: this
// machine's own record alone, and no change to it, since no record is written there). `items` is readMarked's, null
// when it failed or was not made. `done` holds the comments, as `<kind>:<id>`, an earlier sweep of the same step settled
// whichever ids are security (handledKeys): none of them is read or listed again. `readVisibility` reads the
// repository's visibility and `viewer` the forge's current user, by default through the forge; a step passes ones that
// keep their first answer, so a second sweep, and the replies, read neither again.
// Candidates: each comment the record maps to such an id, less one a whole read (`items`) no longer holds, which is gone
// and gets no call; and where the record is posted, each review comment, a thread's root or a reply in it, or
// conversation comment the forge's current user wrote whose leading markers name such an id or alias, though no record
// maps it, so a reply whose mark a stale write lost still goes. With no candidate, no forge call. Else the visibility
// and the current user are read, and each candidate is read by its own id in its own kind, held to the pull request,
// and deleted only when the current user wrote it and its body starts with that id's marker in the fixed layout. One
// another member wrote is left and listed as waiting on that login's machine, but only when the current user could be
// read: with no current user, no comment is known to be another's, and each is listed as left, which the next step
// reads again. A comment the forge no longer finds on the pull request is gone, as one a whole read lacks; any other,
// and a read that fails, deletes nothing and is listed as left. A delete that works takes its id out of every entry's
// thread (unmap); one that fails is listed, and the next step tries again. A deleted comment, and a gone one, leave
// `items` too, so the rest of the step reads neither: no fresh id for its markers, and no list names it.
// Returns null when nothing was a candidate, else { deleted, waiting, left, failed, gone, textless, unmapped_unread }, each
// list of { finding, kind, id } (`login` on a waiting one).
export function deleteOwn({ forge, repo, n, state, items, mode, publicSecurity = 'counts', done = null, readVisibility = () => forge.visibility(repo), viewer: readViewer = () => forge.viewer() }) {
  if (!isObject(state)) return null;
  const secure = securityIds(state);
  if (!secure.size) return null;
  const held = mode === 'held';
  const whole = mode !== 'local' && Array.isArray(items);
  const present = new Set((whole ? items : []).map((item) => `${item.kind}:${item.id}`));
  const out = { deleted: [], waiting: [], left: [], failed: [], gone: [], textless: [] };
  // Takes a deleted or gone comment out of the step's read of the marked posts, and out of the record.
  const forget = (kind, id) => {
    const at = Array.isArray(items) ? items.findIndex((item) => item.kind === kind && item.id === id) : -1;
    if (at !== -1) items.splice(at, 1);
    if (!held) unmap(state, kind, id);
  };
  const candidates = [];
  for (const candidate of mappedCandidates(state, secure, { done, full: publicSecurity === 'full' })) {
    const { finding, kind, id } = candidate;
    if (whole && !present.has(`${kind}:${id}`)) {
      out.gone.push({ finding, kind, id });
      forget(kind, id);
    } else candidates.push(candidate);
  }
  const mapped = mappedPosts(state);
  const unmapped = mode === 'posted' && whole ? memberMarked(items).filter((item) => item.kind !== KINDS.review
    && !mapped.has(`${item.kind}:${item.id}`) && !done?.has(`${item.kind}:${item.id}`) && item.markers.some((id) => secure.has(id))) : [];
  if (mode === 'posted' && !whole) out.unmapped_unread = true;
  const nothing = () => (out.gone.length || out.unmapped_unread ? out : null);
  if (!candidates.length && !unmapped.length) return nothing();

  let visibility = null;
  try {
    visibility = readVisibility();
  } catch {}
  if (visibility === 'PRIVATE') return nothing();
  const viewer = currentUser(readViewer);
  for (const item of unmapped) {
    const finding = item.markers.find((id) => secure.has(id));
    if (sameLogin(item.login, viewer)) candidates.push({ finding, ids: item.markers.filter((id) => secure.has(id)), kind: item.kind, id: item.id });
    else if (viewer) out.waiting.push({ finding, kind: item.kind, id: item.id, login: item.login });
    else out.left.push({ finding, kind: item.kind, id: item.id });
  }
  for (const candidate of candidates) settle(candidate, { forge, repo, n, viewer, publicSecurity, held, out, forget });
  return out;
}

// One candidate of the delete: read, judged, and deleted or listed in `out`.
function settle(candidate, { forge, repo, n, viewer, publicSecurity, held, out, forget }) {
  const { finding, kind, id } = candidate;
  let comment;
  try {
    comment = kind === KINDS.reviewComment ? forge.reviewComment(repo, n, id) : forge.comment(repo, id, { pr: n });
  } catch {
    out.left.push({ finding, kind, id });
    return;
  }
  // The forge finds no such comment on the pull request: deleted by hand, or never this pull request's.
  if (comment === null) {
    out.gone.push({ finding, kind, id });
    forget(kind, id);
    return;
  }
  const marked = isObject(comment) && leadingMarkers(comment.body).some((each) => candidate.ids.includes(each));
  if (!marked) {
    out.left.push({ finding, kind, id });
    return;
  }
  if (!sameLogin(comment.user?.login, viewer)) {
    if (viewer && isTrustedCommenter(comment)) out.waiting.push({ finding, kind, id, login: comment.user?.login ?? null });
    else out.left.push({ finding, kind, id });
    return;
  }
  if (publicSecurity === 'full' && !holdsText(comment.body, candidate.ids)) {
    out.textless.push({ finding, kind, id });
    if (!held && candidate.entry && candidate.ids.every((each) => idsOf(candidate.entry).includes(each))) spare(candidate.entry.thread, candidate.key, true);
    return;
  }
  try {
    if (kind === KINDS.reviewComment) forge.deleteReviewComment(repo, id);
    else forge.deleteComment(repo, id);
  } catch {
    out.failed.push({ finding, kind, id });
    return;
  }
  out.deleted.push({ finding, kind, id });
  forget(kind, id);
}

// The lists a delete result holds, each of { finding, kind, id }.
const DELETE_LISTS = ['deleted', 'waiting', 'left', 'failed', 'gone', 'textless'];

// The lists whose comments a sweep settled whichever ids are security: deleted, gone, one whose delete failed (the next
// step tries again), and another member's. A comment spared as `textless`, or `left`, was judged against the ids that
// were security then: a mark the step sets later may name another finding it holds, so a later sweep reads it again.
const SETTLED_LISTS = ['deleted', 'gone', 'failed', 'waiting'];

// The comments a delete result settled, as `<kind>:<id>`: what a later sweep of the same step passes as `done`.
export const handledKeys = (out) => new Set(SETTLED_LISTS.flatMap((key) => (Array.isArray(out?.[key]) ? out[key] : [])).map((each) => `${each.kind}:${each.id}`));

// The comments a delete result removed from the record, deleted or gone, as `<kind>:<id>`: what a merge of another
// write's finding index (state.mjs mergeIndex) never maps again.
export const removedPosts = (out) => new Set(['deleted', 'gone'].flatMap((key) => (Array.isArray(out?.[key]) ? out[key] : [])).map((each) => `${each.kind}:${each.id}`));

// Two delete results of one step as one, `b` the later: each list joined, and `unmapped_unread` when either says so.
// Null when both are. A comment the later sweep lists for a finding counts as it says there for that finding, and one
// either deleted is listed as deleted alone, so one textless or left in the first and deleted in the second is listed
// as deleted alone; and a list names a comment once for each finding. A comment the later sweep did not read again for
// a finding, as one spared for it already, keeps what the first said.
export function mergeDeletes(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const key = (each) => `${each.kind}:${each.id}`;
  const later = new Set(DELETE_LISTS.flatMap((name) => (b[name] ?? []).map((each) => `${key(each)}:${each.finding}`)));
  const deleted = new Set([...(a.deleted ?? []), ...(b.deleted ?? [])].map(key));
  const out = Object.fromEntries(DELETE_LISTS.map((name) => {
    const seen = new Set();
    const joined = [...(a[name] ?? []).filter((each) => !later.has(`${key(each)}:${each.finding}`)), ...(b[name] ?? [])]
      .filter((each) => name === 'deleted' || !deleted.has(key(each)))
      .filter((each) => !seen.has(`${key(each)}:${each.finding}`) && seen.add(`${key(each)}:${each.finding}`));
    return [name, joined];
  }));
  return a.unmapped_unread || b.unmapped_unread ? { ...out, unmapped_unread: true } : out;
}

// A line that is exactly the attribution line of some finding id: the only line that ends a finding's section.
const ATTRIBUTION = /^aidrian review, finding R\d{1,3}-\d{1,6}$/u;

// Whether a post's section of any of `ids` holds reviewer text: a quoted line between that finding's attribution line and
// the next line that is exactly an attribution line. A post with no such section for them counts as holding text, so it
// is never spared by mistake. No engine line can forge a boundary: reviewer text is quoted, and a path that holds a line
// break is never printed (inline.mjs postInline).
function holdsText(body, ids) {
  const lines = String(body ?? '').split('\n');
  const starts = lines.flatMap((line, at) => (ids.some((id) => line === attributionLine(id)) ? [at] : []));
  if (!starts.length) return true;
  return starts.some((start) => {
    const end = lines.findIndex((line, at) => at > start && ATTRIBUTION.test(line));
    return lines.slice(start + 1, end === -1 ? lines.length : end).some((line) => line.startsWith('>'));
  });
}
