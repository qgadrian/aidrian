// What happened in a pull request's review: the rounds, each pass's result per head, flow verdicts, the Human's
// sign-offs, and the overrides used. It is kept in two places that agree: a file in the state folder, and one summary
// comment on the pull request, edited in place, that carries the same record in a marker so another machine can read it.
// With config.json `review.record: "local"` it is kept in the state folder only, and another machine cannot read it.
//
// The record is the reviewers' word, not proof: an agent with a shell can write it. What protects the review is that
// every entry is visible in the pull request, overrides included: on a repository that is not private, by its engine
// keys alone. The comment carries the posted copy of the record (lib/review/publish.mjs postedCopy), never the record
// itself, and its visible lines are rendered from that copy: finding text, reasons, and names a check withholds stay on
// the machine that recorded them. A machine that builds on another's posted copy fills them from its own record
// (fillWithheld).
//
// The comment carries the record brotli-compressed under `aidrian-review-state-br:`; the older plain-base64 marker is
// still read. A write by this release leaves one record; a write by an older one keeps the compressed marker and adds a
// plain one, so a reader takes the newer of every record a body holds. When even the compressed record would push the comment past
// BODY_LIMIT (GitHub refuses a comment over 65,536 characters), the comment holds `aidrian-review-state-held:<revision>`
// instead: the record stays on the machine that wrote it, and another machine with an older record waits for it
// (readRecord) rather than start over.
//
// Anyone can comment on a pull request, so a summary comment counts only when GitHub says its author belongs to the
// repository (isTrustedCommenter, summaryComment): a stranger's comment never supplies a record.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

import { isTrustedCommenter } from '../forges/index.mjs';
import { isObject } from '../fs.mjs';
import { recordsFolder, stateDir } from '../project.mjs';
import { originRepo, repoName } from '../remotes.mjs';
import { recordFindings } from './findings.mjs';
import { escapeLines, fillWithheld, findingsTable, flagName, isPrivate, JUDGE_RULING, plainChecker, postedCopy, WITHHELD } from './publish.mjs';
import { summaryLines as quotaLines } from './quota.mjs';
import { ruledLines } from './settled.mjs';
import { splitPasses } from './split.mjs';

export const SUMMARY_MARKER = '<!-- aidrian-review-summary -->';
const STATE = /<!--\s*aidrian-review-state:([A-Za-z0-9+/=]+)\s*-->/u;
const STATE_BR = /<!--\s*aidrian-review-state-br:([A-Za-z0-9+/=]+)\s*-->/u;
const HELD = /<!--\s*aidrian-review-state-held:(\d+)\s*-->/u;
// The longest summary comment written with its record; past it the record is held. Under GitHub's 65,536.
export const BODY_LIMIT = 60_000;
export const HELD_LINE = '_Record kept locally; too large for a comment. Another machine waits for the one that wrote it._';
// The held line of a record held because a text check could not run where it was written. It names no word, pattern,
// or list.
export const CHECK_HELD_LINE = '_Record kept locally; a text check could not run on the machine that wrote it. Another machine waits for that one._';
// A decoded record larger than this is not a review record.
const MAX_RECORD = 32 * 1024 * 1024;
// The longest free text, such as a reason, the visible summary shows.
const CLIP = 300;
// The most plan reasons the visible summary lists, as a flow keeps at most 25.
const MAX_REASONS = 25;
// Free text as the visible summary shows it: one line, at most CLIP characters, and no HTML comment opened or closed,
// so a reason cannot carry a record marker of its own into the comment.
export const clip = (text) => String(text).replace(/\s+/gu, ' ').slice(0, CLIP).replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');

// Two spellings of one commit: equal, or one a prefix of the other, at least 7 hex long.
export const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))));
// A commit SHA as a command takes it: 7 to 40 hex.
export const SHA_REF = /^[0-9a-f]{7,40}$/iu;

// `outcome` is the review step's last return, { status, head, at, reason?, reasons?, depth?, carried_from?, carried_base? }, which the
// merge guard reads (lib/rules/github/merge-review.mjs). `reasons` and `depth`, on a `none_needed` alone, are its plan's, which
// `aidrian pr auto-merge` reads (lib/pr-auto-merge.mjs reviewProblem). `carried_from` is the head whose `received` review a clean
// merge from the base branch carried to `head` (lib/review/run.mjs), and `carried_base` the base commit it merged in;
// the summary comment shows both under **Carried review** (carriedLines). `remerge` is { head, from }: the merge head
// whose review covers only what the merge itself changed, and the reviewed head it builds on. `pending` holds the
// reviews owed: { kind: 'request' | 'review', head, at, by, sent?, answered?, repo?, id }. A `request` is a bot review the Human asked for (`aidrian pr request`): `sent` once
// `aidrian pr await-review --request` posts it, `answered` once the bot's answer arrives. A `review` is a gate review
// dispatched: `answered` once `aidrian pr attest` records it or a review step finishes. An entry is never removed, only
// marked, so the review step can merge in what was recorded while it ran (mergePending). `waivers`, there once
// `aidrian pr waive` writes one, lists the judge verdicts the merge guard may take in place of the Human's answer:
// { head, kind: 'round_cap', verdict: 'waive' | 'refuse', reason, judge, at } (lib/review/waiver.mjs). A
// record without it has none.
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

// Notes the review step's return on `state`: its outcome, and, once finished by a review, every gate review owed on
// that head or an earlier one it descends from answered.
// `repo` is the step's repository: a gate review owed for another one stays owed.
export function noteOutcome(state, { status, head, reason, carried_from, carried_base, plan }, isAncestor = () => false, repo = null) {
  const carried = typeof carried_from === 'string' ? { carried_from, ...(typeof carried_base === 'string' ? { carried_base } : {}) } : {};
  const reasons = status === 'none_needed' && Array.isArray(plan?.reasons) ? { reasons: plan.reasons.slice(0, MAX_REASONS).map(clip), depth: plan.depth } : {};
  state.outcome = { status, head, at: new Date().toISOString(), ...(reason ? { reason: clip(reason) } : {}), ...reasons, ...carried };
  // A carried outcome ran no review, so it answers none: a review owed on the merge head stays owed.
  if (FINISHED.has(status) && typeof carried_from !== 'string') answerPending(state, 'review', { head, by: status, isAncestor, repo });
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

// This machine's review record of a pull request is one file a repository and number: `pr-<N>-review.json` for origin's
// repository, for a repository no record names, and in a checkout with no origin, as before; `pr-<N>-review-<owner>--<name>.json` for any other, which
// a checkout whose remotes name several repositories reviews too. GitHub owners hold no `--`, so the name is one
// repository's. The origin's file keeps its old name, so a record written before the key changed is still origin's.
const folder = (project) => recordsFolder(stateDir(project));
const plainFile = (project, pr) => path.join(folder(project), `pr-${pr}-review.json`);
// What a per-pull-request file's name adds for repository `repo`: '' for origin's, for no repository, and in a checkout
// with no origin, so those keep the old name; `-<owner>--<name>` for any other. Every file this machine keeps of one
// pull request by its number takes it: the review record, the attest record (review-gate.mjs), and the findings
// files of a dispatch (dispatch.mjs).
export function repoSuffix(project, repo) {
  const name = repoName(repo);
  const origin = name === null ? null : originRepo(project);
  return name === null || origin === null || name === origin ? '' : `-${name.replace('/', '--')}`;
}
function file(project, pr, repo = null) {
  const suffix = repoSuffix(project, repo);
  return suffix === '' ? plainFile(project, pr) : path.join(folder(project), `pr-${pr}-review${suffix}.json`);
}
// The file that holds this machine's review record of `pr` of `repo` (origin's when it names none).
export const recordFile = file;

function wellFormed(state, pr) {
  return isObject(state) && state.version === 1 && state.pr === pr && Array.isArray(state.rounds) && isObject(state.passes) && isObject(state.signoffs);
}

function readFile(target, pr) {
  try {
    const state = JSON.parse(readFileSync(target, 'utf8'));
    return wellFormed(state, pr) ? { failures: {}, overrides: [], outcome: null, pending: [], ...state } : null;
  } catch {
    return null;
  }
}

// Every record this machine holds of number `pr`, whatever its repository.
function recordsOf(project, pr) {
  let names = [];
  try {
    names = readdirSync(folder(project)).filter((name) => name === `pr-${pr}-review.json` || (name.startsWith(`pr-${pr}-review-`) && name.endsWith('.json')));
  } catch {}
  return names.map((name) => readFile(path.join(folder(project), name), pr)).filter(Boolean);
}

// This machine's review record of pull request `pr` of `repo`, or null. A repository other than origin's reads its own
// file; until it has one, it reads the old name, as every reader did before the key changed, whatever repository that
// record names: a record written before then, or origin's own, which may hold that repository's owed entries. The
// callers tell such a record apart by its `repo` (otherRecordRepo, merge-review.mjs scoped), and the next write of the
// repository's own record moves it to its file. With no `repo` (a reader that cannot tell it, such as a merge with no
// `-R`), the newest record of that number, whatever its repository, as the one file of a number held before.
export function readLocalState(project, pr, repo) {
  if (repo === undefined || repo === null || repoName(repo) === null) return recordsOf(project, pr).reduce((a, b) => newer(a, b), null);
  return readFile(file(project, pr, repo), pr) ?? readFile(plainFile(project, pr), pr);
}

// Every write raises the record's revision, so the newer of two records is the one written last. Before it, the one
// writer of finding ids keeps the finding index, giving an entry to each id that has none, and every twin of a security
// finding the record holds takes the mark (findings.mjs recordFindings), so the copy it posts carries both.
export function writeLocalState(project, state) {
  recordFindings(state, null, null);
  state.revision = (state.revision ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  writeAt(project, state);
}

// Writes `state` to its repository's file, and removes a record of that repository left under the old name.
function writeAt(project, state) {
  const target = file(project, state.pr, state.repo);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
  const plain = plainFile(project, state.pr);
  if (target !== plain && repoName(readFile(plain, state.pr)?.repo) === repoName(state.repo)) rmSync(plain, { force: true });
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

// The lines that end `body`, last first, with the blank lines after them left out: where withRecord puts the marker.
function endLines(body) {
  const lines = body.split('\n').map((line) => line.trim());
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.reverse();
}

const whole = (pattern) => new RegExp(`^${pattern.source}$`, 'u');
const ENDING = [[whole(STATE_BR), true], [whole(STATE), false]];

// The record a summary comment carries, or null: the newer of the record markers on the lines that end it, each a line
// of its own, compressed or plain. An older release's write keeps this release's compressed marker and appends its own
// plain one, so the body can end with both. A marker anywhere else, such as one quoted in free text, is not read.
export function stateFromComment(body, pr) {
  if (typeof body !== 'string') return null;
  let found = null;
  for (const line of endLines(body)) {
    const [match, compressed] = ENDING.map(([pattern, br]) => [pattern.exec(line), br]).find(([each]) => each) ?? [null];
    if (!match) break;
    found = newer(found, decode(match[1], compressed, pr));
  }
  return found;
}

// The revision a held summary comment names on its last line, or null when it is not held.
export function heldRevision(body) {
  const match = typeof body === 'string' ? whole(HELD).exec(endLines(body)[0] ?? '') : null;
  return match ? Number(match[1]) : null;
}

// Why a held summary comment holds its record: `check` when its held line says a text check could not run, else `size`.
export const heldWhy = (body) => (typeof body === 'string' && endLines(body)[1] === CHECK_HELD_LINE ? 'check' : 'size');

// What a machine without the held record is told: the review step returns it as `incomplete`, and `aidrian pr extend`
// and `aidrian pr await-review` fail with it. `why` is the hold's cause (heldWhy); a caller that does not know it gets
// both.
const HOLD_CAUSE = {
  size: ['too large for the pull request\'s comment', 'or wait until its next write fits the comment again'],
  check: ['because a text check could not run there', 'or wait until its checks run again'],
  undefined: ['too large for the pull request\'s comment or because a text check could not run there', 'or wait until its next write posts the record again'],
};
export const heldMessage = (pr, revision, why) => {
  const [cause, wait] = HOLD_CAUSE[why] ?? HOLD_CAUSE.undefined;
  return `the review record of #${pr} is at revision ${revision} on the machine that wrote it, ${cause}: continue the review on that machine, ${wait}. If that machine is gone, the Human deletes the review summary comment of #${pr}; the review then restarts from this machine's record, or from round 1 with none`;
};

// The repository record `state` names, as `owner/name`, when it is not `repo`, else null. This machine keeps one record
// a pull request number, so a checkout whose remotes name several repositories may hold another repository's record
// of the same number: a command on `repo` never builds on it.
export function otherRecordRepo(state, repo) {
  if (typeof state?.repo !== 'string' || state.repo === '' || typeof repo !== 'string' || repo === '') return null;
  const recorded = repoName(state.repo) ?? state.repo;
  return recorded === (repoName(repo) ?? repo) ? null : recorded;
}

// The refusal of a command on `repo` whose record of #`pr` names `recorded`, another repository: `what` says what the
// command signs off. `aidrian pr signoff --last` and the long form share it.
export const otherRecordMessage = (pr, recorded, repo, what) =>
  `the review record of #${pr} is for ${recorded}, not ${repo}: ${what} the pull request that record names. Give --repo ${recorded}, or the long form`;

// The record to build on: { state }, the newer of this machine's and the one the pull request's summary comment
// carries (an empty one when neither exists), or { held: revision, why } when the comment holds a record this machine's
// is older than, `why` its cause (heldWhy). `comments` are the pull request's comments as read; [] under `review.record: "local"`.
// With `ignoreOther`, this machine's record is left out when it names another repository than `repo` (otherRecordRepo).
export function readRecord(project, pr, comments, repo, { ignoreOther = false } = {}) {
  const body = summaryComment(comments)?.body;
  const read = readLocalState(project, pr, repo);
  const local = ignoreOther && otherRecordRepo(read, repo) ? null : read;
  const remote = stateFromComment(body, pr);
  const held = remote ? null : heldRevision(body);
  if (held !== null && (local?.revision ?? 0) < held) return { held, why: heldWhy(body) };
  const chosen = newer(local, remote);
  // The posted copy holds less than the record: what it withheld is filled from this machine's own record. A machine
  // with none fills from an empty one, so every finding of the copy is marked adopted.
  if (chosen && chosen === remote) fillWithheld(remote, local ?? emptyState(pr, repo));
  return { state: chosen ?? emptyState(pr, repo) };
}

// Notes `outcome` on this machine's record of `pr` without making it a newer record: its revision and write time stay,
// so a higher-revision posted copy still wins the next read. The review step's stop on a finding it holds no text for
// writes it, so the merge guard keeps refusing the head.
export function noteLocalOutcome(project, pr, repo, outcome) {
  const state = noteOutcome(readLocalState(project, pr, repo) ?? emptyState(pr, repo), outcome);
  writeAt(project, state);
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

// The summary comment's text: the lines a person reads, then the marker with the record. `post` is the write's post
// context (lib/review/publish.mjs postedCopy): the record goes on the pull request as its posted copy, and every line the
// record feeds is rendered from that copy, so a line shows nothing the copy lacks. The status, the plan line, its reasons,
// the engine, and the flows come from `plan`, the step's own.
export function summaryBody(state, plan, status, post = {}) {
  const planLines = [];
  if (plan) {
    planLines.push(`Head \`${plan.head.slice(0, 7)}\`, depth **${plan.depth}**, round ${state.rounds.length}.`);
    if (plan.reasons.length) planLines.push('', ...plan.reasons.slice(0, MAX_REASONS).map((reason) => `- ${clip(reason)}`));
    if (plan.reasons.length > MAX_REASONS) planLines.push(`- and ${plan.reasons.length - MAX_REASONS} more`);
    if (plan.engine) planLines.push(`${ENGINE_LINE}${plan.engine.name} (${clip(plan.engine.reason)})`);
  }
  const flowLines = (plan?.flows ?? []).map((flow) => {
    const signoff = state.signoffs[flow.id];
    const human = !flow.humanSigned ? 'needed' : signoff?.head === plan.head ? 'recorded (an audit entry, not proof)' : `recorded on \`${String(signoff?.head).slice(0, 7)}\` and kept: nothing since touches the flow`;
    return `- flow **${flow.id}**${flow.unspecified ? ' (unspecified: no invariants stated)' : ''}: ${flow.signed ? 'signed by its reviewer' : 'not signed'}${flow.signoff === 'human' ? `; Human sign-off ${human}` : ''}`;
  });
  return assemble({ header: `### Review: ${status}`, planLines, flowLines, outsideHead: plan?.head ?? null }, state, post);
}

// The record-fed lines, from the posted copy `copy`, and the summary's whole text around them.
function assemble({ header, planLines, flowLines, outsideHead }, state, post) {
  const { copy, withheld } = postedCopy(state, post);
  const open = isPrivate(post.reading);
  const lines = [header, '', ...planLines];
  const passes = Object.entries(isObject(copy.passes) ? copy.passes : {});
  if (passes.length) {
    lines.push('', '| Pass | Head | Findings | Open |', '| --- | --- | --- | --- |');
    for (const [id, result] of passes) lines.push(`| ${id} | \`${String(result.head ?? 'unknown').slice(0, 7)}\` | ${result.findings ?? 0} | ${result.open ?? 0} |`);
  }
  // With review.publish.summary "findings", each finding and its outcome, from the copy's finding index.
  if (post.publish?.summary === 'findings') lines.push(...findingsTable(copy, post));
  lines.push(...flowLines);
  if (isObject(copy.visual)) {
    const visual = copy.visual;
    lines.push('', `- visual capture of \`${String(visual.head).slice(0, 7)}\`: ${visual.status}${visual.status === 'captured' ? ` (${visual.captured} of ${visual.of})` : visual.reason ? ` (${clip(visual.reason)})` : ''}; attach **${visual.mode}**${visual.visibility ? `, ${String(visual.visibility).toLowerCase()} repository` : ', visibility unknown'}${visual.error ? `; ${clip(visual.error)}` : ''}`);
  }
  lines.push(...outsideLines(copy, outsideHead, open));
  lines.push(...quotaLines(copy));
  lines.push(...ruledLines(copy));
  lines.push(...carriedLines(copy));
  lines.push(...extensionLines(copy));
  lines.push(...waiverLines(copy));
  const overrides = [...(Array.isArray(copy.overrides) ? copy.overrides : []), ...(open ? [] : overruleLines(copy))];
  if (overrides.length) lines.push('', OVERRIDES_HEADING, ...overrides.map((each) => `- ${clip(each)}`));
  lines.push('', CITATION_LINE);
  return withRecord(lines, copy, withheld, post, state);
}

const OVERRIDES_HEADING = '**Overrides used:**';
const ENGINE_LINE = '- engine: ';
const CITATION_LINE = 'A citation shows the cited line exists, not that it proves the invariant; the independent reviewer challenges each one.';

// The overrulings of a copy that keeps no override line of theirs: the invariant, the head, and a judge's name.
function overruleLines(copy) {
  return (Array.isArray(copy.overrulings) ? copy.overrulings : []).filter(isObject)
    .map((each) => `${each.flow}/${each.invariant} overruled on \`${String(each.head).slice(0, 7)}\`${typeof each.by !== 'string' ? '' : each.by === JUDGE_RULING ? ' by a judge' : ` by ${each.by}`} (an audit entry, not proof)`);
}

// The one way a summary comment ends. Every visible line passes every text check, on every repository, or is left out
// and counted; the count shows as the withheld notice.
// Then the lines are escaped (publish.mjs escapeLines), with no line exempt, and only then does the engine add its own
// marker lines, in their fixed layout: the summary marker first, and last the record's marker, or, when that would pass
// BODY_LIMIT, the held line and the held marker with the record's revision. The budget measures the escaped body.
function withRecord(lines, copy, withheld, post, state) {
  const checker = post.checker ?? plainChecker();
  let hidden = withheld;
  // One element can hold a line break: the checks and the escaping read every line of the body as it will post.
  const shown = lines.flatMap((line) => String(line).split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u)).filter((line) => {
    if (checker.allows(line)) return true;
    hidden += 1;
    return false;
  });
  if (hidden) shown.push('', `_${WITHHELD}: ${hidden} ${hidden === 1 ? 'value' : 'values'} of the review record are not shown on the pull request._`);
  const escaped = [SUMMARY_MARKER, ...escapeLines(shown)];
  const holdWith = (line) => [...escaped, line, `<!-- aidrian-review-state-held:${state.revision ?? 0} -->`].join('\n');
  const held = holdWith(HELD_LINE);
  // A check the copy or its lines needed that could not run, or a copy that lost what makes it a record, holds the
  // record on this machine rather than post one another machine would read as the review starting over.
  if (checker.failed) return holdWith(CHECK_HELD_LINE);
  if (!wellFormed(copy, state.pr) || copy.revision !== state.revision) return held;
  const record = `<!-- aidrian-review-state-br:${brotliCompressSync(Buffer.from(JSON.stringify(copy))).toString('base64')} -->`;
  const body = [...escaped, record].join('\n');
  return body.length <= BODY_LIMIT ? body : held;
}

export const isSummary = (body) => typeof body === 'string' && body.startsWith(SUMMARY_MARKER);

// The last summary comment among `comments`, as GitHub's REST API returns them, by a member of the repository, or null.
export const summaryComment = (comments) => (comments ?? []).filter((comment) => isSummary(comment.body) && isTrustedCommenter(comment)).at(-1) ?? null;

// The summary comment a write edits, or null to post a new one. A non-member edits the last one they wrote, which still
// supplies no record, so their steps keep one comment; everyone else edits the one readers take (summaryComment).
// `viewer()` gives the current gh user's login, and is asked only when a non-member's summary comment is there. A login
// it cannot give matches nobody, so no non-member's comment is edited for it; a member's is still attempted.
export function summaryToEdit(comments, viewer) {
  const outside = (comments ?? []).filter((comment) => isSummary(comment.body) && !isTrustedCommenter(comment));
  const login = outside.length ? currentLogin(viewer) : null;
  return (login && outside.filter((comment) => comment.user?.login === login).at(-1)) || summaryComment(comments);
}

// Edits `summary`, or posts when there is none or GitHub refuses the edit: a non-member with no comment of their own can
// edit no member's, and only GitHub knows who is one. The post supplies no record, and their next step edits it.
export function writeSummary(summary, edit, post) {
  if (!summary) return post();
  try {
    return edit(summary.id);
  } catch (error) {
    // gh's error ends with the status; the start of the message can quote the body, which may name one.
    if (!/\(HTTP 403\)\s*$/u.test(error?.message ?? '')) throw error;
    return post();
  }
}

function currentLogin(viewer) {
  try {
    return viewer?.() ?? null;
  } catch {
    return null;
  }
}

// The invariants evidence outside the tool closed on `head`, apart from the reviewers' verdicts: each approval by a named
// approver's review on the forge, and each acceptance by the Human. The login is in code, so the edited comment never
// mentions the approver again.
function outsideLines(copy, head, open) {
  const outside = copy.outside;
  if (!isObject(outside) || !head || !sameCommit(outside.head, head)) return [];
  const list = (key) => (Array.isArray(outside[key]) ? outside[key] : []).filter(isObject);
  const at = String(head).slice(0, 7);
  // A person's name shows only on a private repository's comment.
  const approver = (each) => (open && typeof each.login === 'string' ? ` by \`@${clip(each.login)}\`` : '');
  const accepter = (each) => (typeof each.by !== 'string' ? '' : each.by === JUDGE_RULING ? ' by a judge' : ` by ${clip(each.by)}`);
  const lines = [
    ...list('approvals').map((each) => `- ${clip(`${each.flow}/${each.invariant}`)}: approved${approver(each)} on \`${at}\`: ${clip(each.url ?? 'no review link')}`),
    ...list('acceptances').map((each) => `- ${clip(`${each.flow}/${each.invariant}`)}: accepted${accepter(each)} on \`${at}\` on outside evidence: ${clip(each.evidence ?? 'unknown')}${typeof each.reason === 'string' ? `: ${clip(each.reason)}` : ''} (an audit entry, not proof)`),
  ];
  return lines.length ? ['', '**Outside evidence:**', ...lines] : [];
}

const EXTRA_HEADING = '**Extra rounds:**';
// The decisions after which the cap stands.
const STOPS = new Set(['stopped', 'denied']);

// Every check at the round cap, and who decided it: the signals, the judge, the Human, or the ceiling. A blank line,
// the heading, and one line per check; nothing when there is none. Its reasons and the Human's name show only where the
// copy holds them.
function extensionLines(copy) {
  const extensions = (Array.isArray(copy.extensions) ? copy.extensions : []).filter((entry) => isObject(entry) && entry.status !== 'new');
  if (!extensions.length) return [];
  const lines = ['', EXTRA_HEADING];
  for (const entry of extensions) {
    const who = entry.by === 'human' ? `the Human (${typeof entry.human?.by === 'string' ? `${entry.human.by}; ` : ''}an audit entry, not proof)` : entry.by ? `the ${entry.by === 'mechanical' ? 'signals' : entry.by}` : null;
    const reasons = (Array.isArray(entry.reasons) ? entry.reasons : []).slice(0, 3).map(clip);
    const at = entry.head ? ` on \`${String(entry.head).slice(0, 7)}\`` : '';
    const round = `${entry.source === 'bot' ? 'bot round' : 'round'} ${entry.round}`;
    // A decision over red flags names them, so a round granted past one says so on the pull request.
    const flags = entry.status !== 'judging' && entry.red_flags?.length ? ` (over red flags: ${[...new Set(entry.red_flags.map(flagName))].join(', ')})` : '';
    lines.push(`- ${round}${at}: ${entry.status}${who ? ` by ${who}` : ''}${reasons.length ? `: ${reasons.join('; ')}` : ''}${flags}`);
    // The cap stood on a fix no round reviewed: the Human sees it before merging. A plan round on that head since, after
    // a later grant, reviewed it.
    const reviewed = entry.source !== 'bot' && (copy.rounds ?? []).some((each) => sameCommit(each.head, entry.unreviewed?.head));
    if (entry.unreviewed?.head && STOPS.has(entry.status) && !reviewed) {
      lines.push(`- fix head \`${String(entry.unreviewed.head).slice(0, 7)}\`, pushed after ${round} on \`${String(entry.unreviewed.from).slice(0, 7)}\`, is reviewed by no pass: the cap stopped the review before it`);
    }
  }
  return lines;
}

export const WAIVER_HEADING = '**Merge guard waivers:**';

// Every judge verdict recorded for the merge guard (`waivers`, lib/review/waiver.mjs): a blank line, the heading, and
// one line per entry; nothing when there is none. The judge's word, so each line says it is no proof. A reason shows
// only where the copy holds it.
export function waiverLines(copy) {
  const waivers = (Array.isArray(copy?.waivers) ? copy.waivers : []).filter(isObject);
  if (!waivers.length) return [];
  return ['', WAIVER_HEADING, ...waivers.map((entry) =>
    `- ${clip(entry.kind ?? 'unknown')} on \`${String(entry.head).slice(0, 7)}\`: ${clip(entry.verdict ?? 'unknown')} by ${clip(entry.judge ?? 'a judge')}${typeof entry.reason === 'string' ? `: ${clip(entry.reason)}` : ''} (an audit entry, not proof)`)];
}

export const CARRIED_HEADING = '**Carried review:**';

// The outcome a clean merge from the base branch carried (`outcome.carried_from`, lib/review/run.mjs): a blank line, the
// heading, and one line naming the merge head, the base commit it merged in, and the reviewed head whose review it took;
// nothing while the outcome carries none. No reviewer ran on the merge head, so the line says so.
export function carriedLines(state) {
  const outcome = isObject(state?.outcome) ? state.outcome : null;
  if (typeof outcome?.carried_from !== 'string') return [];
  const short = (sha) => clip(String(sha).slice(0, 7));
  const merged = typeof outcome.carried_base === 'string' ? ` merges \`${short(outcome.carried_base)}\` from the base branch and` : ' is a clean merge from the base branch that';
  return ['', CARRIED_HEADING, `- head \`${short(outcome.head)}\`${merged} carries the review of \`${short(outcome.carried_from)}\`: no reviewer ran on it`];
}

// A summary comment's text with `state` in place of the record it carried. It keeps only the lines the step's plan
// feeds, which no other writer holds: the status, the plan line and its reasons, the engine, and the flows. Every block
// the record feeds is rendered again from the posted copy (assemble), the Outside evidence block while its head is the
// outcome's, so a string an earlier body showed does not survive this write.
export function refreshSummary(body, state, post = {}) {
  const lines = String(body).split('\n');
  const header = lines.find((line) => line.startsWith('### Review: ')) ?? '### Review: unknown';
  const planLines = [];
  const at = lines.findIndex((line) => line.startsWith('Head `'));
  if (at !== -1) {
    planLines.push(lines[at]);
    // The plan block is the head line, then its reasons after a blank line, ending with the engine line, or the
    // engine line alone. A run of bullets that ends with no engine line is another block, such as the quota stops.
    if (lines[at + 1]?.startsWith(ENGINE_LINE)) planLines.push(lines[at + 1]);
    else if (lines[at + 1] === '') {
      let end = at + 2;
      while (lines[end]?.startsWith('- ') && !lines[end].startsWith(ENGINE_LINE) && !lines[end].startsWith('- flow **')) end += 1;
      if (lines[end]?.startsWith(ENGINE_LINE) && end > at + 2) planLines.push('', ...lines.slice(at + 2, end + 1));
    }
  }
  const flowLines = lines.filter((line) => line.startsWith('- flow **'));
  const outcome = isObject(state.outcome) ? state.outcome : null;
  return assemble({ header, planLines, flowLines, outsideHead: outcome?.head ?? null }, state, post);
}

// Writes `state`, already written to the state folder, to the pull request's summary comment, as the review step does,
// so another machine reads the same record. `io` is { comments(), post(body), edit(id, body), viewer() }, and `post`
// the write's post context (lib/review/publish.mjs postContext). With no summary comment to edit (summaryToEdit), or
// none this user may edit, it posts one under `status`. Returns the error message, or null.
export function publishState(state, io, status, post = {}) {
  try {
    const summary = summaryToEdit(io.comments(), io.viewer);
    writeSummary(summary, (id) => io.edit(id, refreshSummary(summary.body, state, post)), () => io.post(summaryBody(state, null, status, post)));
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
    const reviewer = /^slice:(.+):[0-9a-f]{10}(?:\.[ab])*$/u.exec(id)?.[1];
    if (!reviewer || keep.has(id)) continue;
    if (!live.has(reviewer)) live.set(reviewer, new Map(splitPasses(reviewer, slices, { halved: state.halved ?? {} }).filter((pass) => pass.role === 'slice').map((pass) => [pass.id, JSON.stringify([...pass.files].sort())])));
    if (live.get(reviewer).get(id) !== JSON.stringify(result.files ?? null)) delete state.passes[id];
  }
  return state;
}
