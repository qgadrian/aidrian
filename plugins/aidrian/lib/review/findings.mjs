// A pass's findings one by one, for `aidrian pr attest --pass <id> --findings-file <file>`: each finding carries its
// axes (severity, likelihood, affects, cost) and its state (open, fixed, accepted), and finding-disposition.json
// decides which still block. Counts alone let a reviewer call anything accepted; per-finding axes let the table
// decide. A finding whose `already_ruled` names an entry of the settled list its caller passes (settledMatch), and
// whose own disposition can be accepted, repeats a ruling, so it never blocks and counts as accepted.
// docs/review.md#findings describes the file.

import { randomBytes } from 'node:crypto';

import { isObject } from '../fs.mjs';
import { decideDisposition, loadTable } from '../finding-disposition.mjs';

export const FINDING_STATES = Object.freeze(['open', 'fixed', 'accepted']);
// The dispositions an accepted finding may close with. fix_now never closes until it is fixed, and a finding with
// no axes, or words the table does not know, stays open until it is classified.
const ACCEPTABLE = new Set(['accepted_residual', 'acceptable_as_is', 'drop_unless_cited']);
export const ACCEPTABLE_DISPOSITIONS = Object.freeze([...ACCEPTABLE]);
export const MAX_FINDINGS = 200;

const { severities: SEVERITIES, severitySynonyms: SYNONYMS = {} } = loadTable();

// A severity word as the disposition table names it, synonyms resolved, or null for a word the table does not know.
export function severityOf(value) {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const known = SYNONYMS[word] ?? word;
  return SEVERITIES.includes(known) ? known : null;
}

// Whether severity `a` is no higher than `b`: the table lists them most severe first. An unknown word never is.
export function noHigher(a, b) {
  const [rankA, rankB] = [a, b].map((value) => SEVERITIES.indexOf(severityOf(value)));
  return rankA >= 0 && rankB >= 0 && rankA >= rankB;
}

// The highest severity an accepted residual settles when it names no raised finding: it is then the pull request author's
// word alone, not a ruling on the record, so it waives only a low repeat. One that names a raised finding
// (settled.mjs anchoredResiduals) is held as a prior finding instead.
export const RESIDUAL_CAP = 'low';
// The highest severity a prior finding settles, whatever its own: an accepted high or critical finding is a judgment
// one round made, and a repeat that severe is weighed again instead of waived.
export const PRIOR_CAP = 'medium';

// { entry, note } for a finding's `already_ruled`: the settled entry it names, or null with why, a note the caller
// reports (null when the value is absent or empty). `settled` holds { title, file, severity } for a prior finding, or a
// residual that names a raised finding, which only a finding in the same file, no more severe, and of PRIOR_CAP at most
// can repeat, and { title } for any other residual, matched by its text alone and settling a finding of RESIDUAL_CAP
// only. A prior finding of the name takes precedence: no residual of the same text can lift its file or its severity cap.
export function settledMatch(finding, value, settled) {
  if (typeof value !== 'string') return { entry: null, note: value === undefined ? null : 'is not a string' };
  const name = value.trim();
  if (!name) return { entry: null, note: null };
  const quoted = `("${name.slice(0, 60)}")`;
  const named = settled.filter((entry) => entry.title === name);
  const priors = named.filter((entry) => 'file' in entry);
  if (priors.length) {
    const here = priors.filter((entry) => entry.file === finding.file);
    const within = here.filter((each) => noHigher(finding.severity, each.severity));
    if (within.length && noHigher(finding.severity, PRIOR_CAP)) return { entry: within[0], note: null };
    if (within.length) return { entry: null, note: `names a settled finding, which settles a finding of ${PRIOR_CAP} severity at most ${quoted}` };
    return { entry: null, note: here.length ? `names a settled finding less severe than it ${quoted}` : `names a settled finding in another file ${quoted}` };
  }
  const residual = named[0];
  if (!residual) return { entry: null, note: `names no settled finding ${quoted}` };
  if (noHigher(finding.severity, RESIDUAL_CAP)) return { entry: residual, note: null };
  return { entry: null, note: `names an accepted residual, which settles only a ${RESIDUAL_CAP} finding ${quoted}` };
}

// Whether one classified finding still blocks its pass: open and not acceptable as-is, or accepted with a disposition
// that cannot be accepted. One that repeats a settled finding never does: `already_ruled` survives parseFindings only
// when it names an entry of the settled list and the finding's own disposition can be accepted (ruling).
export function blocks(finding) {
  if (typeof finding.already_ruled === 'string' && finding.already_ruled.trim() !== '') return false;
  if (finding.state === 'fixed') return false;
  if (!ACCEPTABLE.has(finding.disposition)) return true;
  return finding.state === 'open' && finding.disposition !== 'acceptable_as_is';
}

// { entry, note } for one --findings-file finding's `already_ruled`: settledMatch's answer, unless the finding's own
// `disposition` cannot be accepted, such as fix_now: a repeat the table says to fix blocks, whatever it repeats.
function ruling(finding, disposition, settled) {
  const match = settledMatch(finding, finding.already_ruled, settled);
  if (!match.entry || ACCEPTABLE.has(disposition)) return match;
  return { entry: null, note: `names a settled finding, but its own disposition, ${disposition}, cannot be accepted` };
}

const text = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

// { list, findings, fixed, accepted, open, notes } from the file's text, or throws on a malformed file. The list keeps
// each finding with its disposition, so `fix_required` shows the reviewer's words and the table's decision together.
// An `already_ruled` that is not a string, names nothing in `settled`, or fails settledMatch's file or severity test is
// left out, and noted: the finding is read as it stands. So is one on a finding whose own disposition cannot be accepted
// (ruling).
// A finding's `id` is the id of the priorFindings entry it reports again, kept as `returned_id` for recordFindings to
// check; a mint mark is never read.
// SHORTCUT: `aidrian pr attest` (lib/review/record.mjs recordPass) passes no `settled` list yet, so on that path every
// `already_ruled` is left out and the finding read as it stands: safe, since nothing is waived, and enough while only
// exec reviewers return repeats. Wiring recordSettled and residualTexts into recordPass would replace it.
export function parseFindings(raw, settled = []) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--findings-file must be a JSON file');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) throw new Error('--findings-file must hold a list of findings, or { "findings": [...] }');
  if (list.length > MAX_FINDINGS) throw new Error(`--findings-file holds ${list.length} findings, past ${MAX_FINDINGS}`);
  const notes = [];
  const out = list.map((finding, i) => {
    const at = `--findings-file[${i}]`;
    if (!isObject(finding)) throw new Error(`${at} must be an object`);
    const title = text(finding.title, 200);
    if (!title) throw new Error(`${at} needs a title`);
    if (!FINDING_STATES.includes(finding.state)) throw new Error(`${at}.state must be ${FINDING_STATES.join(', ')}`);
    if (finding.line !== undefined && !(Number.isInteger(finding.line) && finding.line >= 1)) throw new Error(`${at}.line must be a line number`);
    const axes = { severity: finding.severity, likelihood: finding.likelihood, affects: finding.affects, cost: finding.cost };
    const decided = decideDisposition(Object.fromEntries(Object.entries(axes).filter(([, value]) => value !== undefined)));
    if (decided.disposition === 'invalid') throw new Error(`${at}: ${decided.reason} (\`aidrian pr disposition --vocab\` lists the words)`);
    const { entry: ruled, note } = ruling({ file: text(finding.file, 300), severity: finding.severity, already_ruled: finding.already_ruled }, decided.disposition, settled);
    if (note) notes.push(`${at}.already_ruled ${note}: read as it stands`);
    return {
      title,
      ...(text(finding.file, 300) ? { file: text(finding.file, 300) } : {}),
      ...(finding.line ? { line: finding.line } : {}),
      ...(text(finding.body, 2000) ? { body: text(finding.body, 2000) } : {}),
      ...Object.fromEntries(Object.entries(axes).filter(([, value]) => typeof value === 'string')),
      ...(text(finding.evidence, 300) ? { evidence: text(finding.evidence, 300) } : {}),
      ...(ruled ? { already_ruled: ruled.title } : {}),
      ...(flagged(finding.security) ? { security: true } : {}),
      // The id of a priorFindings entry the reviewer reports again: recordFindings checks it, and never stores it.
      ...(finding.id !== undefined && finding.id !== '' ? { returned_id: finding.id } : {}),
      state: finding.state,
      disposition: decided.disposition,
    };
  });
  const fixed = out.filter((finding) => finding.state === 'fixed').length;
  const open = out.filter(blocks).length;
  return { list: out, findings: out.length, fixed, accepted: out.length - fixed - open, open, notes };
}

// A reviewer's `security` flag (--findings-file, and an exec reviewer's key): absent or false is no flag, and any other
// value, one that is not a boolean included, is one.
export const flagged = (value) => value !== undefined && value !== false;

// Finding identity (docs/review.md#the-record). Every finding a pass records gets an id, `R<round>-<n>`: the round it was
// first recorded in and the record's one counter (`idCounter`), which is never reset and never reused, so an id is
// unique in the pull request. With each id it mints, recordFindings sets a mint mark, 8 hex digits from the engine's
// random source: two machines that mint one id for different findings tell them apart by it. Neither is ever read from a
// reviewer's output or a findings file. The digit limits are the ones a marker reader holds to.
export const FINDING_ID = /^R(\d{1,3})-(\d{1,6})$/u;
const MINT = /^[0-9a-f]{8}$/u;
const MAX_ROUND = 999;
export const MAX_COUNTER = 999_999;
export const isFindingId = (value) => typeof value === 'string' && FINDING_ID.test(value);
export const isMint = (value) => typeof value === 'string' && MINT.test(value);
// The longest file path a finding keeps.
export const MAX_PATH = 300;
// The severities that make a finding a security finding by themselves.
const SECURITY_SEVERITIES = new Set(['critical', 'high']);
// Whether a severity makes a finding a security finding by itself: critical or high.
export const securitySeverity = (severity) => SECURITY_SEVERITIES.has(severityOf(severity));
// A finding that seeds the stored mark: marked already, or critical or high.
const securitySeed = (finding) => finding.security === true || securitySeverity(finding.severity);

// Two findings this many lines apart in one file are at the same place, as split reviews dedupe them.
export const NEAR_LINES = 3;

// A finding's title as words: no markup, badges, links, or case, words of four letters or more, sorted. Two titles that
// differ only in wording order or markup are the same title.
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  const plain = title
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ');
  return [...new Set(plain.split(/\s+/u).filter((word) => word.length > 3))].sort().join(' ');
}

const samePlace = (a, b) => typeof a.file === 'string' && a.file === b.file && Number.isInteger(a.line) && Number.isInteger(b.line) && Math.abs(a.line - b.line) <= NEAR_LINES;
// The same title, only where both titles are held: a finding without its text matches no title.
const sameTitle = (a, b) => {
  const title = normalizeTitle(a.title);
  return title !== '' && title === normalizeTitle(b.title);
};
// A finding's id links: its id, its aliases, and for a ruling the id of the finding it repeats (`ruled_id`), so a
// reworded ruling is its finding's twin, both ways.
const idsOf = (finding) => [finding.id, finding.ruled_id, ...(Array.isArray(finding.aliases) ? finding.aliases : [])].filter(isFindingId);

// How two findings are twins, or null: `id` when they share an id, an alias, or the id a ruling names, `place` at the same file and lines within
// NEAR_LINES, `title` under the same normalized title where both titles are held. The looping signal
// (lib/review/extension.mjs) and the security mark's reach (twinClosure) both read this one match.
export function twinMatch(a, b) {
  const theirs = new Set(idsOf(b));
  if (idsOf(a).some((id) => theirs.has(id))) return 'id';
  if (samePlace(a, b)) return 'place';
  if (sameTitle(a, b)) return 'title';
  return null;
}

// Every finding of `findings` that `seed` picks, and every twin of one (twinMatch), to a fixed point: a twin of a twin
// counts too.
export function twinClosure(findings, seed) {
  const out = new Set(findings.filter(seed));
  const index = { id: new Map(), file: new Map(), title: new Map() };
  const add = (map, key, finding) => map.set(key, [...(map.get(key) ?? []), finding]);
  for (const finding of findings) {
    for (const id of idsOf(finding)) add(index.id, id, finding);
    if (typeof finding.file === 'string' && Number.isInteger(finding.line)) add(index.file, finding.file, finding);
    const title = normalizeTitle(finding.title);
    if (title) add(index.title, title, finding);
  }
  const queue = [...out];
  while (queue.length) {
    const finding = queue.pop();
    const near = [
      ...idsOf(finding).flatMap((id) => index.id.get(id) ?? []),
      ...(typeof finding.file === 'string' && Number.isInteger(finding.line) ? (index.file.get(finding.file) ?? []).filter((each) => Math.abs(each.line - finding.line) <= NEAR_LINES) : []),
      ...(normalizeTitle(finding.title) ? index.title.get(normalizeTitle(finding.title)) ?? [] : []),
    ];
    for (const each of near) {
      if (out.has(each)) continue;
      out.add(each);
      queue.push(each);
    }
  }
  return out;
}

const GROUPS = ['list', 'ruled', 'carried'];
const listOf = (value) => (Array.isArray(value) ? value : []);

// Every finding a record holds, as the objects themselves: each pass's `list`, `ruled`, and `carried`, each round's
// `findings`, then each entry of the finding index (`index`), closed entries included, so the twin match reads them too.
export function recordedFindings(state) {
  const passes = Object.values(isObject(state?.passes) ? state.passes : {}).filter(isObject)
    .flatMap((result) => GROUPS.flatMap((key) => listOf(result[key])));
  const rounds = listOf(state?.rounds).filter(isObject).flatMap((round) => listOf(round.findings));
  const index = Object.values(isObject(state?.index) ? state.index : {});
  return [...passes, ...rounds, ...index].filter(isObject);
}

// Stores the security mark on every finding `state` holds that is marked, critical or high, or a twin of one, in every
// list that holds it and in the index (K1). The mark only widens. Every write of the record runs it (state.mjs
// writeLocalState, through recordFindings), so a twin this machine ties, after it adopts another machine's copy too,
// stays tied in the copy it posts.
export function tieTwins(state) {
  for (const finding of twinClosure(recordedFindings(state), securitySeed)) finding.security = true;
  return state;
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
const placeKey = (finding) => JSON.stringify([trimmed(finding.title), trimmed(finding.file)]);
const FULL_SHA = /^[0-9a-f]{40}$/u;

// ---- The finding index (docs/review.md#finding-ids) ----

// The states an index entry closes in. Both are final: an id closed as fixed or not reported again is never reopened,
// and a finding reported after it is a new finding with a new id (B4).
export const CLOSED_STATES = Object.freeze(['fixed', 'not_reported']);
export const isClosed = (entry) => CLOSED_STATES.includes(entry?.state);
// What an index entry keeps of its finding: the title is its only text. `reviewer`, the recording pass's, stays local.
const ENTRY_KEYS = ['title', 'file', 'line', 'severity', 'likelihood', 'affects', 'cost', 'disposition', 'accepted_by'];

const indexOf = (state) => {
  if (!isObject(state.index)) state.index = {};
  return state.index;
};

// The state an index entry takes from a finding recorded in a pass result's `group`: a listing as fixed closes it, a
// ruling or a carried ruling is accepted, and a listing is accepted only when it reads as accepted and no longer blocks.
function entryState(finding, group) {
  if (group !== 'list') return 'accepted';
  if (finding.state === 'fixed') return 'fixed';
  return finding.state === 'accepted' && !blocks(finding) ? 'accepted' : 'open';
}

// Closes `entry` as `outcome` on head `to`, with `closed_in`, the range the closing pass reviewed, from `range(seen, to)`
// (A4): two full SHAs, or none when the range cannot be read.
function closeEntry(entry, outcome, to, range) {
  entry.state = outcome;
  const span = typeof range === 'function' && FULL_SHA.test(String(to ?? '')) ? range(entry.seen, to) : null;
  if (FULL_SHA.test(String(span?.from ?? '')) && FULL_SHA.test(String(span?.to ?? ''))) entry.closed_in = { from: span.from, to: span.to };
}

// Writes one recorded finding into the index, under its id: its title, place, and axes, its state, the pass, stage,
// and reviewer that recorded it, the head that last held it open (`seen`), and a security mark that never clears. A
// closed entry is final and takes nothing more.
function enter(index, finding, group, at) {
  const before = isObject(index[finding.id]) ? index[finding.id] : null;
  if (isClosed(before)) return;
  const entry = { ...(before ?? {}), id: finding.id };
  for (const key of ['mint', 'aliases']) if (finding[key] !== undefined) entry[key] = Array.isArray(finding[key]) ? [...finding[key]] : finding[key];
  for (const key of ENTRY_KEYS) {
    if (finding[key] !== undefined && finding[key] !== null) entry[key] = finding[key];
    else if (key !== 'title') delete entry[key];
  }
  const state = entryState(finding, group);
  Object.assign(entry, { state, pass: at.pass });
  if (at.stage) entry.stage = at.stage;
  if (at.reviewer) entry.reviewer = at.reviewer;
  if (finding.security === true || before?.security === true) entry.security = true;
  if (state === 'open' && FULL_SHA.test(String(at.head ?? ''))) entry.seen = at.head;
  if (state === 'fixed') closeEntry(entry, 'fixed', at.head, at.range);
  index[finding.id] = entry;
}

// The pass's stage and reviewer as the record notes them: the plan note's word, else the dispatch note's stage and the
// result's reviewer.
const stageOf = (state, passId) => state.planNote?.passes?.[passId]?.stage ?? state.dispatched?.[passId]?.stage ?? null;
const reviewerOf = (state, passId, result) => state.planNote?.passes?.[passId]?.reviewer ?? result?.reviewer ?? null;

// Gives an index entry to each id the record holds that has none, as on the first write over a record an earlier
// release wrote (A3): each pass's findings, then each round's.
function indexHeld(state, range) {
  const index = indexOf(state);
  for (const [passId, result] of Object.entries(isObject(state.passes) ? state.passes : {})) {
    if (!isObject(result)) continue;
    const at = { pass: passId, stage: stageOf(state, passId), reviewer: reviewerOf(state, passId, result), head: result.head, range };
    for (const group of GROUPS) for (const finding of listOf(result[group])) if (isObject(finding) && isFindingId(finding.id) && !index[finding.id]) enter(index, finding, group, at);
  }
  for (const round of listOf(state.rounds).filter(isObject)) {
    for (const finding of listOf(round.findings)) {
      if (!isObject(finding) || !isFindingId(finding.id) || index[finding.id]) continue;
      enter(index, finding, 'list', { pass: finding.pass ?? null, stage: stageOf(state, finding.pass), reviewer: reviewerOf(state, finding.pass, null), head: round.head, range });
    }
  }
}

// Whether a pass with `files` (null: every file) holds `file`.
const holds = (pass, file) => !Array.isArray(pass.files) || (typeof file === 'string' && pass.files.includes(file));

// Whether a pass result lists the finding `id` in its `list`.
const lists = (result, id) => isObject(result) && listOf(result.list).some((each) => each?.id === id);

// The one pass of `plan`, the head's plan as [{ id, reviewer, stage, files }], that each open entry of the index is
// listed to (Q2-A3), as a Map from the entry's id to that pass's id, or to null. An entry stays with the pass that
// recorded it while that pass is in the plan and holds its file, has no file list, or lists the entry's id in its latest
// result; an entry with no file stays with it too. Any other entry goes to the first pass of the same reviewer and stage
// that holds its file, so only a cut that moves or a slice that runs as two halves hands an entry on, with its id. No
// entry is listed to two passes.
export function listing(state, plan) {
  const out = new Map();
  const byId = new Map(listOf(plan).map((pass) => [pass.id, pass]));
  for (const [id, entry] of Object.entries(isObject(state?.index) ? state.index : {})) {
    if (!isObject(entry) || entry.state !== 'open') continue;
    const own = byId.get(entry.pass);
    const stays = own && (holds(own, entry.file) || typeof entry.file !== 'string' || lists(state.passes?.[own.id], id));
    const to = stays ? own : listOf(plan).find((pass) => pass.reviewer === entry.reviewer && pass.stage === entry.stage && holds(pass, entry.file));
    out.set(id, to?.id ?? null);
  }
  return out;
}

// The ids listed to pass `passId` of `plan`.
export const listedTo = (state, plan, passId) => [...listing(state, plan)].filter(([, to]) => to === passId).map(([id]) => id);

// The head's plan as the record notes it (`planNote.current`, with each pass's stage and reviewer, and its files as its
// dispatch note or its result has them), for a write that plans nothing, such as `aidrian pr attest`; null without a note.
export function notedPlan(state) {
  const note = isObject(state?.planNote) ? state.planNote : null;
  if (!note || !Array.isArray(note.current)) return null;
  return note.current.filter((id) => typeof id === 'string').map((id) => ({
    id, reviewer: note.passes?.[id]?.reviewer ?? null, stage: note.passes?.[id]?.stage ?? null,
    files: state.dispatched?.[id]?.files ?? state.passes?.[id]?.files ?? null,
  }));
}

// How a pass result holds index entry `id`: 'list' when it lists it, 'ruled' when a ruling or a carried ruling has its
// id or names it, else null.
function heldBy(result, id) {
  if (!isObject(result)) return null;
  if (listOf(result.list).some((each) => each?.id === id)) return 'list';
  return ['ruled', 'carried'].some((key) => listOf(result[key]).some((each) => each?.id === id || each?.ruled_id === id)) ? 'ruled' : null;
}

// Closes, as not reported again, every open entry this machine holds the text of whose stage is `complete` (every
// pass of it has a result for the head), and, for an entry whose stage the plan no longer has, once every stage is: an
// entry listed to a pass whose result for `head` lists findings one by one and does not hold it, and an entry listed to
// no pass that no pass of the plan holds. An entry any pass of the plan lists in its result for `head` is held, whichever
// pass it is listed to. One a pass holds as a ruling is accepted, never omitted. Nothing here closes an entry as fixed:
// nobody confirmed a fix (A1, B4, Q2-A3).
function closeOmitted(state, plan, { head, complete, range }) {
  const stages = new Set(plan.map((pass) => pass.stage));
  const everyStage = [...stages].every((name) => complete.has(name));
  const atHead = plan.map((pass) => state.passes?.[pass.id]).filter((result) => isObject(result) && result.head === head);
  for (const [id, to] of listing(state, plan)) {
    const entry = state.index[id];
    if (trimmed(entry.title) === '' || entry.adopted === true) continue;
    if (!(stages.has(entry.stage) ? complete.has(entry.stage) : everyStage)) continue;
    if (atHead.some((result) => lists(result, id))) continue;
    const holders = to === null ? plan.map((pass) => state.passes?.[pass.id]) : [state.passes?.[to]];
    const held = holders.map((result) => heldBy(result, id)).find(Boolean) ?? null;
    if (held === 'ruled') entry.state = 'accepted';
    if (held) continue;
    if (to !== null && !(holders[0]?.head === head && Array.isArray(holders[0].list))) continue;
    closeEntry(entry, 'not_reported', head, range);
  }
}

// The one writer of finding ids (A1): records `result` as pass `passId`'s result on `state`, returns it, and keeps the
// finding index. Both writers of a pass's findings call it, `aidrian pr attest` (lib/review/record.mjs recordPass) and
// the step's write of an exec reviewer's findings (lib/review/stages.mjs); the step calls it again for a pass whose
// findings attest stored without ids, and with no result at each stage's judgment, where it closes what the stage's
// passes left out; every write of the record calls it with neither, which keeps the index (state.mjs writeLocalState).
// Each finding of the result's `list`, `ruled`, and `carried`:
//   - keeps its id when the record already holds that finding, its id and mint mark together (a stored entry, such as an
//     ended waiver the step copies). Else a finding that is no ruling takes the id it returned (`returned_id`) when that
//     is exactly R<digits>-<digits>, one of `listed`, the ids the pass's input listed, and still open in the index (R4);
//     any other returned value is read as no id and named in the result's `dropped` notes, never by its value. Else it
//     takes the id of an entry `listed` holds with its title and file, then of a finding of the pass's prior result with
//     its title and file whose id is neither closed nor listed to another pass, then, with `plan`, of an open entry listed
//     to no pass whose pass left the plan, so the first pass to claim it keeps it. Each id once. Else it takes a new id
//     when `mint` allows it, else is stored without one. An id or a mark a reviewer printed is never read.
//   - is a security finding (R5) when it is critical or high, its reviewer flagged it, `securityPass` says the head's
//     plan requires the security reviewer and the pass is in its local or independent stage, or the finding or entry it
//     takes its id from had the mark.
//   - keeps its `file` only as a path of at most MAX_PATH characters that `paths.tracked` says git tracks at the reviewed
//     head, and its `line` only as a positive integer at most `paths.lines` of that file (H3). Otherwise neither is
//     recorded, and the result's `dropped` notes name the finding's id, never the value. With no `paths`, the check
//     cannot run, and neither is recorded. `kept: true` skips it, for findings the record already holds as checked:
//     the step's call that gives ids to findings attest stored without one.
//   - when it is a ruling, names the finding it repeats by `ruled_id`: a raised finding the record holds by that title
//     and file (a pass's listing, then a round's entry, never another ruling), else the one its prior ruling named.
//   - goes into the index under its id (A3): open, accepted, or closed as fixed with `closed_in` from `range(seen, to)`.
// With `plan` and `complete` (the names of the stages whose every pass has a result for `head`), the open entries the
// passes left out close as not reported again (closeOmitted). Then every twin of a marked finding takes the mark (tieTwins).
export function recordFindings(state, passId, result, options = {}) {
  indexHeld(state, options.range ?? null);
  const recorded = typeof passId === 'string' && isObject(result) ? recordResult(state, passId, result, options) : null;
  if (Array.isArray(options.plan) && options.complete instanceof Set) closeOmitted(state, options.plan, options);
  tieTwins(state);
  return recorded;
}

function recordResult(state, passId, result, { mint = false, securityPass = false, paths = null, kept: checked = false, listed = null, plan = null, stage = null, reviewer = null, range = null } = {}) {
  const index = indexOf(state);
  const before = isObject(state.passes?.[passId]) ? state.passes[passId] : null;
  const where = Array.isArray(plan) ? listing(state, plan) : null;
  const planIds = new Set(listOf(plan).map((pass) => pass.id));
  // A prior finding keeps its id only while that id is neither closed nor listed to another pass.
  const free = (id) => !isClosed(index[id]) && !(where?.get(id) && where.get(id) !== passId);
  const prior = before ? GROUPS.flatMap((key) => listOf(before[key])).filter((each) => isObject(each) && isFindingId(each.id) && free(each.id)) : [];
  const listedIds = new Set(listOf(listed).filter(isFindingId));
  const open = (id) => isObject(index[id]) && index[id].state === 'open' && isMint(index[id].mint);
  const shown = [...listedIds].filter(open).map((id) => index[id]);
  const orphans = where ? [...where].filter(([id, to]) => to === null && !planIds.has(index[id].pass) && open(id)).map(([id]) => index[id]) : [];
  // The raised findings a ruling may name: the record's before this write, which still holds the pass's prior result.
  const raisedBefore = recordedFindings(state).filter((each) => isFindingId(each.id) && !trimmed(each.already_ruled));
  const ruledBefore = new Map(recordedFindings(state).filter((each) => trimmed(each.already_ruled) && isFindingId(each.ruled_id))
    .map((each) => [placeKey({ title: each.already_ruled, file: each.file }), each.ruled_id]));
  const held = new Map(recordedFindings(state).filter((each) => isFindingId(each.id) && isMint(each.mint)).map((each) => [each.id, each]));
  const taken = new Set();
  const dropped = [];
  const round = Math.max(1, Array.isArray(state.rounds) ? state.rounds.length : 0);
  const fresh = () => {
    const next = (Number.isSafeInteger(state.idCounter) && state.idCounter > 0 ? state.idCounter : 0) + 1;
    if (next > MAX_COUNTER || round > MAX_ROUND) return null;
    state.idCounter = next;
    return { id: `R${round}-${next}`, mint: randomBytes(4).toString('hex') };
  };
  const one = (raw) => {
    const { id, mint: mark, aliases, ruled_id: _named, security, returned_id: returned, ...finding } = raw;
    const kept = isFindingId(id) && isMint(mark) && held.get(id)?.mint === mark ? held.get(id) : null;
    // A ruling carries a prior ruling's id, and a finding a prior finding's: a ruling never takes the id of the finding
    // it repeats, whose title it shares, nor an id it returned.
    const ruling = Boolean(trimmed(finding.already_ruled));
    const unclaimed = (each) => !taken.has(each.id) && placeKey(each) === placeKey(finding);
    const asked = !kept && !ruling && returned !== undefined && returned !== null && returned !== '';
    const named = asked && isFindingId(returned) && listedIds.has(returned) && open(returned) && !taken.has(returned) ? index[returned] : null;
    const match = kept ?? named
      ?? (ruling ? null : shown.find(unclaimed))
      ?? prior.find((each) => unclaimed(each) && Boolean(trimmed(each.already_ruled)) === ruling)
      ?? (ruling ? null : orphans.find(unclaimed))
      ?? null;
    if (match) taken.add(match.id);
    const identity = match ? { id: match.id, mint: match.mint, ...(Array.isArray(match.aliases) && match.aliases.length ? { aliases: match.aliases.filter(isFindingId) } : {}) } : mint ? fresh() : null;
    const marked = flagged(security) || match?.security === true || securitySeverity(finding.severity) || securityPass;
    const out = { ...(identity ?? {}), ...finding, ...(marked ? { security: true } : {}) };
    const name = identity?.id ?? 'a finding with no id';
    if (asked && !named) dropped.push(`${name}: its returned id is not an open finding its input listed, so it was read as no id`);
    if (checked) return out;
    const file = typeof out.file === 'string' && out.file.length <= MAX_PATH && out.file.trim() !== '' && paths?.tracked(out.file) === true ? out.file : null;
    if (out.file !== undefined && out.file !== null && file === null) dropped.push(`${name}: its file was not recorded`);
    const count = file === null ? null : paths.lines(file);
    const line = file !== null && Number.isInteger(out.line) && out.line >= 1 && Number.isInteger(count) && out.line <= count ? out.line : null;
    if (out.line !== undefined && out.line !== null && line === null) dropped.push(`${name}: its line was not recorded`);
    delete out.file;
    delete out.line;
    return { ...out, ...(file !== null ? { file } : {}), ...(line !== null ? { line } : {}) };
  };
  const groups = Object.fromEntries(GROUPS.filter((key) => Array.isArray(result[key])).map((key) => [key, result[key].filter(isObject).map(one)]));
  const recorded = { ...result, ...groups, ...(dropped.length ? { dropped: [...(Array.isArray(result.dropped) ? result.dropped : []), ...dropped] } : {}) };
  const raised = [...(groups.list ?? []).filter((each) => isFindingId(each.id)), ...raisedBefore];
  for (const ruling of [...(groups.ruled ?? []), ...(groups.carried ?? [])]) {
    if (!trimmed(ruling.already_ruled)) continue;
    const key = placeKey({ title: ruling.already_ruled, file: ruling.file });
    const target = raised.find((each) => placeKey(each) === key)?.id ?? ruledBefore.get(key);
    if (target) ruling.ruled_id = target;
  }
  // The new findings take the mark of a twin in the record as it stood before this write, the result it replaces and
  // the index included, so a marked finding that lives only in that result or in a closed entry still ties its repeat.
  const recordedNow = new Set(Object.values(groups).flat());
  for (const finding of twinClosure([...recordedFindings(state), ...recordedNow], securitySeed)) if (recordedNow.has(finding)) finding.security = true;
  state.passes[passId] = recorded;
  const at = { pass: passId, stage: stage ?? stageOf(state, passId), reviewer: reviewer ?? reviewerOf(state, passId, result), head: result.head, range };
  for (const group of GROUPS) for (const finding of listOf(groups[group])) if (isFindingId(finding.id)) enter(index, finding, group, at);
  return recorded;
}
