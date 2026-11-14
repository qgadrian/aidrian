// The engine's finding markers, and the finding index's map of the engine's posts: what the inline review
// (lib/review/inline.mjs), the delete (lib/review/delete.mjs), and the replies (lib/review/replies.mjs) share.
//
// Every inline comment, review body, fallback comment, and reply the engine posts starts with one
// `<!-- aidrian-review-finding:<id> -->` line per finding it holds, then the visible line `aidrian review, finding <id>`
// of the first: the fixed layout. Only that layout is read, so a marker line quoted in reviewer text, which the escaping
// breaks anyway, is never read as one.

import { isObject } from '../fs.mjs';
import { isFindingId } from './findings.mjs';
import { escapeLines, LINE_BREAK, plainFence, quotedLines } from './publish.mjs';

export const FINDING_MARKER = 'aidrian-review-finding';
const MARKER_LINE = /^<!-- aidrian-review-finding:(R\d{1,3}-\d{1,6}) -->$/u;

// The marker line of finding `id`, and the visible line that names it after the marker lines.
export const markerLine = (id) => `<!-- ${FINDING_MARKER}:${id} -->`;
export const attributionLine = (id) => `aidrian review, finding ${id}`;

// The finding ids a body's leading marker lines name, in the engine's fixed layout: from its first line, each line one
// marker in the exact format, within the id's digit limits, then the attribution line of the first id. Any other body
// names none.
export function leadingMarkers(body) {
  if (typeof body !== 'string') return [];
  const lines = body.split('\n');
  const ids = [];
  for (const line of lines) {
    const match = MARKER_LINE.exec(line);
    if (!match) break;
    ids.push(match[1]);
  }
  return ids.length && lines[ids.length] === attributionLine(ids[0]) ? ids : [];
}

// The lines a post shows: every line escaped, no line exempt (R3), reviewer text quoted after it is escaped (G7), and
// every fence opener of every line a plain fence unless its info string is a plain language name.
const rendered = (lines) => lines.flatMap((line) => (line.quoted ? quotedLines(line.text) : escapeLines(String(line.text).split(LINE_BREAK)))).map(plainFence);

// One post's body: the leading marker lines of `ids`, added after the escaping, then `lines` rendered.
export const withMarkers = (ids, lines) => [...ids.map(markerLine), ...rendered(lines)].join('\n');

// The kinds of post the engine reads back, as its read of the marked posts (inline.mjs readMarked) names them.
export const KINDS = Object.freeze({ comment: 'comment', review: 'review', reviewComment: 'review_comment' });

// The marked items of a member of the repository: the only ones the engine reads as its own posts.
export const memberMarked = (items) => (items ?? []).filter((item) => item.member && item.markers.length);

// Whether two logins are the same, in any case; a login that is not text matches nothing.
export const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Every id a finding answers to: its own, then its aliases.
export const idsOf = (entry) => [entry?.id, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].filter(isFindingId);

// The index entries of `state` that carry a finding id.
export const entries = (state) => Object.values(isObject(state?.index) ? state.index : {}).filter((entry) => isObject(entry) && isFindingId(entry.id));

// The posts the index maps, by `<kind>:<id>`, each with the finding ids posted there.
export function mappedPosts(state) {
  const out = new Map();
  const add = (kind, id, entry) => {
    if (!Number.isSafeInteger(id)) return;
    const key = `${kind}:${id}`;
    out.set(key, new Set([...(out.get(key) ?? []), ...idsOf(entry)]));
  };
  for (const entry of entries(state)) {
    const thread = isObject(entry.thread) ? entry.thread : {};
    add(KINDS.reviewComment, thread.commentId, entry);
    add(KINDS.reviewComment, thread.replyId, entry);
    // The replies of closings before the finding opened again stay the engine's posts for it (replies.mjs noteReopened).
    for (const id of Array.isArray(thread.earlier) ? thread.earlier : []) add(KINDS.reviewComment, id, entry);
    add(KINDS.comment, thread.fallbackId, entry);
    add(KINDS.review, thread.reviewId, entry);
  }
  return out;
}

// The step's read of the forge's current user, `read` the forge's own: the login, or null when it cannot be read. A
// step passes one function to every part that compares a login (lib/review/step.mjs), which reads it once.
export function currentUser(read) {
  try {
    const login = read?.();
    return typeof login === 'string' && login !== '' ? login : null;
  } catch {
    return null;
  }
}
