// What happened in a pull request's review: the rounds, each pass's result per head, flow verdicts, the Human's
// sign-offs, and the overrides used. It is kept in two places that agree: a file in the state folder, and one summary
// comment on the pull request, edited in place, that carries the same record in a marker so another machine can read it.
// With config.json `review.record: "local"` it is kept in the state folder only, and another machine cannot read it.
//
// The record is the reviewers' word, not proof: an agent with a shell can write it. What protects the review is that
// every entry is visible in the pull request, overrides included.
//
// The comment carries the record brotli-compressed under `aidrian-review-state-br:`; the older plain-base64 marker is
// still read. A write by this release leaves one record; a write by an older one keeps the compressed marker and adds a
// plain one, so a reader takes the newer of every record a body holds. When even the compressed record would push the comment past
// BODY_LIMIT (GitHub refuses a comment over 65,536 characters), the comment holds `aidrian-review-state-held:<revision>`
// instead: the record stays on the machine that wrote it, and another machine with an older record waits for it
// (readRecord) rather than start over.
//
// Anyone can comment on a pull request, so a summary comment counts only when GitHub says its author belongs to the
// repository (MEMBER_ASSOCIATIONS, summaryComment): a stranger's comment never supplies a record.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

import { isObject } from '../fs.mjs';
import { stateDir } from '../project.mjs';
import { summaryLines as quotaLines } from './quota.mjs';
import { splitPasses } from './split.mjs';

export const SUMMARY_MARKER = '<!-- aidrian-review-summary -->';
// The author associations GitHub gives the people who belong to a repository.
export const MEMBER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const STATE = /<!--\s*aidrian-review-state:([A-Za-z0-9+/=]+)\s*-->/u;
const STATE_BR = /<!--\s*aidrian-review-state-br:([A-Za-z0-9+/=]+)\s*-->/u;
const HELD = /<!--\s*aidrian-review-state-held:(\d+)\s*-->/u;
// The longest summary comment written with its record; past it the record is held. Under GitHub's 65,536.
export const BODY_LIMIT = 60_000;
export const HELD_LINE = '_Record kept locally; too large for a comment. Another machine waits for the one that wrote it._';
// A decoded record larger than this is not a review record.
const MAX_RECORD = 32 * 1024 * 1024;
// The longest free text, such as a reason, the visible summary shows.
const CLIP = 300;
// The most plan reasons the visible summary lists, as a flow keeps at most 25.
const MAX_REASONS = 25;
export const clip = (text) => String(text).replace(/\s+/gu, ' ').slice(0, CLIP);

// Two spellings of one commit: equal, or one a prefix of the other, at least 7 hex long.
export const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))));

// `outcome` is the review step's last return, { status, head, at, reason? }, which the merge guard reads
// (lib/rules/github/merge-review.mjs). `pending` holds the reviews owed: { kind: 'request' | 'review', head, at, by,
// sent?, answered?, repo?, id }. A `request` is a bot review the Human asked for (`aidrian pr request`): `sent` once
// `aidrian pr await-review --request` posts it, `answered` once the bot's answer arrives. A `review` is a gate review
// dispatched: `answered` once `aidrian pr attest` records it or a review step finishes. An entry is never removed, only
// marked, so the review step can merge in what was recorded while it ran (mergePending).
export const emptyState = (pr, repo) => ({ version: 1, revision: 0, pr, repo, rounds: [], passes: {}, signoffs: {}, overrides: [], failures: {}, outcome: null, pending: [] });

// The review step's statuses after which nothing is left to review on that head.
export const FINISHED = new Set(['received', 'none_needed']);

// Whether `entry` of `state` is for repository `repo` (null: any), compared as `owner/name` in any case.
export const ofRepo = (state, entry, repo) => {
  const own = entry?.repo ?? state?.repo ?? null;
  return !repo || !own || String(own).toLowerCase() === String(repo).toLowerCase();
};

const pendingOf = (state) => (Array.isArray(state?.pending) ? state.pending.filter(isObject) : []);

// Marks the owed entries of `kind` on `state` answered by `by`'s answer for `head`. An answer counts for an entry made
// for that head, or for an earlier head that `head` descends from: `isAncestor(a, b)`, git's `merge-base
// --is-ancestor`, the test seam. Time plays no part, so a late answer for an older head never answers a newer head's
// entry. When git cannot tell (an unknown commit, no repository), only the entry's own head counts. Returns how many
// it marked.
// With `repo` (`owner/name`), only an entry for that repository counts: its own `repo`, else the record's.
export function answerPending(state, kind, { head, by, repo = null, isAncestor = () => false }) {
  const covers = (entry) => sameCommit(entry.head, head) || (typeof entry.head === 'string' && typeof head === 'string' && isAncestor(entry.head, head));
  const open = pendingOf(state).filter((entry) => entry.kind === kind && !entry.answered && covers(entry) && ofRepo(state, entry, repo));
  for (const entry of open) entry.answered = { at: new Date().toISOString(), head, by };
  return open.length;
}

// Notes the review step's return on `state`: its outcome, and, once finished, every gate review owed on that head or
// an earlier one it descends from answered.
// `repo` is the step's repository: a gate review owed for another one stays owed.
export function noteOutcome(state, { status, head, reason }, isAncestor = () => false, repo = null) {
  state.outcome = { status, head, at: new Date().toISOString(), ...(reason ? { reason: clip(reason) } : {}) };
  if (FINISHED.has(status)) answerPending(state, 'review', { head, by: status, isAncestor, repo });
  return state;
}

// The reviews still owed on `state`: its pending entries not answered, a request sent included.
export const owed = (state) => pendingOf(state).filter((entry) => !entry.answered);

// One list from two copies of `pending`, such as the one on disk and one a long step read before: every entry of
// either, and of an entry in both, each mark either holds.
export function mergePending(a, b) {
  const out = new Map();
  for (const entry of [...pendingOf({ pending: a }), ...pendingOf({ pending: b })]) {
    const key = entry.id ?? `${entry.kind}@${entry.at}@${entry.head}@${entry.by}`;
    const seen = out.get(key) ?? {};
    const merged = { ...seen, ...entry };
    for (const mark of ['sent', 'answered']) if (seen[mark] ?? entry[mark]) merged[mark] = seen[mark] ?? entry[mark];
    out.set(key, merged);
  }
  return [...out.values()];
}

const file = (project, pr) => path.join(stateDir(project), 'reviews', `pr-${pr}-review.json`);

function wellFormed(state, pr) {
  return isObject(state) && state.version === 1 && state.pr === pr && Array.isArray(state.rounds) && isObject(state.passes) && isObject(state.signoffs);
}

export function readLocalState(project, pr) {
  try {
    const state = JSON.parse(readFileSync(file(project, pr), 'utf8'));
    return wellFormed(state, pr) ? { failures: {}, overrides: [], outcome: null, pending: [], ...state } : null;
  } catch {
    return null;
  }
}

// Every write raises the record's revision, so the newer of two records is the one written last.
export function writeLocalState(project, state) {
  state.revision = (state.revision ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  const target = file(project, state.pr);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
}

// An id that tells two owed entries apart, even two made in the same millisecond.
export const entryId = () => `${process.pid}-${randomBytes(4).toString('hex')}`;

// One record marker's record, or null.
function decode(data, compressed, pr) {
  try {
    const bytes = Buffer.from(data, 'base64');
    const state = JSON.parse(compressed ? brotliDecompressSync(bytes, { maxOutputLength: MAX_RECORD }).toString('utf8') : bytes.toString('utf8'));
    return wellFormed(state, pr) ? { failures: {}, overrides: [], outcome: null, pending: [], ...state } : null;
  } catch {
    return null;
  }
}

// The record a summary comment carries, or null: the newer of every record marker in it, compressed or plain. An older
// release's write keeps this release's compressed marker and appends its own plain one, so a body can hold both.
export function stateFromComment(body, pr) {
  if (typeof body !== 'string') return null;
  let found = null;
  for (const [pattern, compressed] of [[STATE_BR, true], [STATE, false]]) {
    for (const match of body.matchAll(new RegExp(pattern.source, 'gu'))) found = newer(found, decode(match[1], compressed, pr));
  }
  return found;
}

// The revision a held summary comment names, or null when it is not held.
export function heldRevision(body) {
  const match = typeof body === 'string' ? HELD.exec(body) : null;
  return match ? Number(match[1]) : null;
}

// What a machine without the held record is told: the review step returns it as `incomplete`, and `aidrian pr extend`
// and `aidrian pr await-review` fail with it.
export const heldMessage = (pr, revision) => `the review record of #${pr} is at revision ${revision} on the machine that wrote it, too large for the pull request's comment: continue the review on that machine, or wait until its next write fits the comment again. If that machine is gone, the Human deletes the review summary comment of #${pr}; the review then restarts from this machine's record, or from round 1 with none`;

// The record to build on: { state }, the newer of this machine's and the one the pull request's summary comment
// carries (an empty one when neither exists), or { held: revision } when the comment holds a record this machine's is
// older than. `comments` are the pull request's comments as read; [] under `review.record: "local"`.
export function readRecord(project, pr, comments, repo) {
  const body = summaryComment(comments)?.body;
  const local = readLocalState(project, pr);
  const remote = stateFromComment(body, pr);
  const held = remote ? null : heldRevision(body);
  if (held !== null && (local?.revision ?? 0) < held) return { held };
  return { state: newer(local, remote) ?? emptyState(pr, repo) };
}

// The newer of two records: the higher revision, which every write raises, then the later write. Every write first
// reads the newer of this machine's record and the pull request's, so a revision always builds on the newest one
// either side has seen. Nothing merges half of each, so a record never mixes two reviews.
export function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((a.revision ?? 0) !== (b.revision ?? 0)) return (b.revision ?? 0) > (a.revision ?? 0) ? b : a;
  return String(b.updatedAt ?? '') > String(a.updatedAt ?? '') ? b : a;
}

// The summary comment's text: a table a person reads, then the marker with the record.
export function summaryBody(state, plan, status) {
  const lines = [SUMMARY_MARKER, `### Review: ${status}`, ''];
  if (plan) {
    lines.push(`Head \`${plan.head.slice(0, 7)}\`, depth **${plan.depth}**, round ${state.rounds.length}.`);
    if (plan.reasons.length) lines.push('', ...plan.reasons.slice(0, MAX_REASONS).map((reason) => `- ${clip(reason)}`));
    if (plan.reasons.length > MAX_REASONS) lines.push(`- and ${plan.reasons.length - MAX_REASONS} more`);
    if (plan.engine) lines.push(`- engine: ${plan.engine.name} (${clip(plan.engine.reason)})`);
  }
  const passes = Object.entries(state.passes);
  if (passes.length) {
    lines.push('', '| Pass | Head | Findings | Open |', '| --- | --- | --- | --- |');
    for (const [id, result] of passes) lines.push(`| ${id} | \`${String(result.head).slice(0, 7)}\` | ${result.findings ?? 0} | ${result.open ?? 0} |`);
  }
  for (const flow of plan?.flows ?? []) {
    const signoff = state.signoffs[flow.id];
    const human = !flow.humanSigned ? 'needed' : signoff?.head === plan.head ? 'recorded (an audit entry, not proof)' : `recorded on \`${String(signoff?.head).slice(0, 7)}\` and kept: nothing since touches the flow`;
    lines.push(`- flow **${flow.id}**${flow.unspecified ? ' (unspecified: no invariants stated)' : ''}: ${flow.signed ? 'signed by its reviewer' : 'not signed'}${flow.signoff === 'human' ? `; Human sign-off ${human}` : ''}`);
  }
  if (state.visual) {
    const visual = state.visual;
    lines.push('', `- visual capture of \`${String(visual.head).slice(0, 7)}\`: ${visual.status}${visual.status === 'captured' ? ` (${visual.captured} of ${visual.of})` : visual.reason ? ` (${clip(visual.reason)})` : ''}; attach **${visual.mode}**${visual.visibility ? `, ${String(visual.visibility).toLowerCase()} repository` : ', visibility unknown'}${visual.error ? `; ${clip(visual.error)}` : ''}`);
  }
  lines.push(...quotaLines(state));
  lines.push(...extensionLines(state));
  if (state.overrides.length) lines.push('', '**Overrides used:**', ...state.overrides.map((each) => `- ${clip(each)}`));
  lines.push('', 'A citation shows the cited line exists, not that it proves the invariant; the independent reviewer challenges each one.');
  return withRecord(lines, state);
}

// The one way a summary comment ends: the visible `lines`, then the record's marker, or, when that would pass
// BODY_LIMIT, the held line and the held marker with the record's revision.
function withRecord(lines, state) {
  const record = `<!-- aidrian-review-state-br:${brotliCompressSync(Buffer.from(JSON.stringify(state))).toString('base64')} -->`;
  const body = [...lines, record].join('\n');
  if (body.length <= BODY_LIMIT) return body;
  return [...lines, HELD_LINE, `<!-- aidrian-review-state-held:${state.revision ?? 0} -->`].join('\n');
}

const RECORD_LINE = (line) => STATE.test(line) || STATE_BR.test(line) || HELD.test(line) || line === HELD_LINE;

export const isSummary = (body) => typeof body === 'string' && body.startsWith(SUMMARY_MARKER);

// The last summary comment among `comments`, as GitHub's REST API returns them, by a member of the repository, or null.
export const summaryComment = (comments) => (comments ?? []).filter((comment) => isSummary(comment.body) && MEMBER_ASSOCIATIONS.has(comment.author_association)).at(-1) ?? null;

// The summary comment a write edits, or null to post a new one. A non-member edits the last one they wrote, which still
// supplies no record, so their steps keep one comment; everyone else edits the one readers take (summaryComment).
// `viewer()` gives the current gh user's login, and is asked only when a non-member's summary comment is there. A login
// it cannot give matches nobody, so no one else's comment is edited for it.
export function summaryToEdit(comments, viewer) {
  const outside = (comments ?? []).filter((comment) => isSummary(comment.body) && !MEMBER_ASSOCIATIONS.has(comment.author_association));
  const login = outside.length ? currentLogin(viewer) : null;
  return (login && outside.filter((comment) => comment.user?.login === login).at(-1)) || summaryComment(comments);
}

function currentLogin(viewer) {
  try {
    return viewer?.() ?? null;
  } catch {
    return null;
  }
}

const EXTRA_HEADING = '**Extra rounds:**';
// The decisions after which the cap stands.
const STOPS = new Set(['stopped', 'denied']);

// Every check at the round cap, and who decided it: the signals, the judge, the Human, or the ceiling. A blank line,
// the heading, and one line per check; nothing when there is none.
function extensionLines(state) {
  const extensions = (state.extensions ?? []).filter((entry) => entry.status !== 'new');
  if (!extensions.length) return [];
  const lines = ['', EXTRA_HEADING];
  for (const entry of extensions) {
    const who = entry.by === 'human' ? `the Human (${entry.human?.by ?? 'unknown'}; an audit entry, not proof)` : entry.by ? `the ${entry.by === 'mechanical' ? 'signals' : entry.by}` : null;
    const reasons = (entry.reasons ?? []).slice(0, 3).map(clip);
    const at = entry.head ? ` on \`${String(entry.head).slice(0, 7)}\`` : '';
    const round = `${entry.source === 'bot' ? 'bot round' : 'round'} ${entry.round}`;
    // A decision over red flags names them, so a round granted past one says so on the pull request.
    const flags = entry.status !== 'judging' && entry.red_flags?.length ? ` (over red flags: ${[...new Set(entry.red_flags.map((reason) => (reason.includes(':') ? reason.slice(0, reason.indexOf(':')) : 'no readable signal')))].join(', ')})` : '';
    lines.push(`- ${round}${at}: ${entry.status}${who ? ` by ${who}` : ''}${reasons.length ? `: ${reasons.join('; ')}` : ''}${flags}`);
    // The cap stood on a fix no round reviewed: the Human sees it before merging. A plan round on that head since, after
    // a later grant, reviewed it.
    const reviewed = entry.source !== 'bot' && (state.rounds ?? []).some((each) => sameCommit(each.head, entry.unreviewed?.head));
    if (entry.unreviewed?.head && STOPS.has(entry.status) && !reviewed) {
      lines.push(`- fix head \`${String(entry.unreviewed.head).slice(0, 7)}\`, pushed after ${round} on \`${String(entry.unreviewed.from).slice(0, 7)}\`, is reviewed by no pass: the cap stopped the review before it`);
    }
  }
  return lines;
}

// A summary comment's text with `state` in place of the record it carried, and its Extra rounds list rewritten from
// it; the rest, which only the review step can write, is kept as it was.
export function refreshSummary(body, state) {
  const kept = [];
  const lines = String(body).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (RECORD_LINE(lines[i])) continue;
    if (lines[i] === EXTRA_HEADING) {
      if (kept.at(-1) === '') kept.pop();
      while (lines[i + 1]?.startsWith('- ')) i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  const extra = extensionLines(state);
  const at = kept.findIndex((line) => line === '**Overrides used:**' || line.startsWith('A citation shows'));
  const before = at === -1 ? kept : kept.slice(0, at > 0 && kept[at - 1] === '' ? at - 1 : at);
  const after = at === -1 ? [] : kept.slice(before.length);
  return withRecord([...before, ...extra, ...after], state);
}

// Writes `state`, already written to the state folder, to the pull request's summary comment, as the review step does,
// so another machine reads the same record. `io` is { comments(), post(body), edit(id, body), viewer() }. With no summary
// comment to edit (summaryToEdit), it posts one under `status`. Returns the error message, or null.
export function publishState(state, io, status) {
  try {
    const summary = summaryToEdit(io.comments(), io.viewer);
    if (summary) io.edit(summary.id, refreshSummary(summary.body, state));
    else io.post(summaryBody(state, null, status));
    return null;
  } catch (error) {
    return error.message;
  }
}

// The record's `passes` without the slice results no slice of the head can count again: for each reviewer with
// `slice:<reviewer>:` results, the live slices are the ones `splitPasses` makes for it from the plan's `slices` and the
// record's halved slices, and a result whose id is not live, or whose files differ from the live slice's, goes. Cross
// passes, every other pass, and every pass of the current plan (`keep`, its pass ids, such as a plan command's own
// partitions) stay; each round's open findings stay on its round entry. With no `slices` (the plan is not split),
// nothing goes.
export function prunePasses(state, slices, keep = new Set()) {
  if (!Array.isArray(slices)) return state;
  const live = new Map();
  for (const [id, result] of Object.entries(state.passes)) {
    const reviewer = /^slice:(.+):[0-9a-f]{10}(?:\.[ab])?$/u.exec(id)?.[1];
    if (!reviewer || keep.has(id)) continue;
    if (!live.has(reviewer)) live.set(reviewer, new Map(splitPasses(reviewer, slices, { halved: state.halved ?? {} }).filter((pass) => pass.role === 'slice').map((pass) => [pass.id, JSON.stringify([...pass.files].sort())])));
    if (live.get(reviewer).get(id) !== JSON.stringify(result.files ?? null)) delete state.passes[id];
  }
  return state;
}
