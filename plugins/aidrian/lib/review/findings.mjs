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

// Every finding a record holds, as the objects themselves: each pass's `list`, `ruled`, and `carried`, then each
// round's `findings`.
export function recordedFindings(state) {
  const passes = Object.values(isObject(state?.passes) ? state.passes : {}).filter(isObject)
    .flatMap((result) => GROUPS.flatMap((key) => (Array.isArray(result[key]) ? result[key] : [])));
  const rounds = (Array.isArray(state?.rounds) ? state.rounds : []).filter(isObject).flatMap((round) => (Array.isArray(round.findings) ? round.findings : []));
  return [...passes, ...rounds].filter(isObject);
}

// Stores the security mark on every finding `state` holds that is marked, critical or high, or a twin of one, in every
// list that holds it (K1). The mark only widens. Every write of the record runs it (state.mjs writeLocalState), so a
// twin this machine ties, after it adopts another machine's copy too, stays tied in the copy it posts.
export function tieTwins(state) {
  for (const finding of twinClosure(recordedFindings(state), securitySeed)) finding.security = true;
  return state;
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
const placeKey = (finding) => JSON.stringify([trimmed(finding.title), trimmed(finding.file)]);

// The one writer of finding ids (A1): records `result` as pass `passId`'s result on `state`, and returns it. Both writers
// of a pass's findings call it, `aidrian pr attest` (lib/review/record.mjs recordPass) and the step's write of an exec
// reviewer's findings (lib/review/stages.mjs), and the step calls it again for a pass whose findings attest stored
// without ids. Each finding of the result's `list`, `ruled`, and `carried`:
//   - keeps its id when the record already holds that finding, its id and mint mark together (a stored entry, such as an
//     ended waiver the step copies), else takes the id, mint mark, aliases, and security mark of a finding of the pass's
//     prior result with the same title and file, each prior finding once, else takes a new id when `mint` allows it,
//     else is stored without one. An id or a mark a reviewer printed is never read.
//   - is a security finding (R5) when it is critical or high, its reviewer flagged it, `securityPass` says the head's
//     plan requires the security reviewer and the pass is in its local or independent stage, or the prior finding it
//     carries its id from had the mark.
//   - keeps its `file` only as a path of at most MAX_PATH characters that `paths.tracked` says git tracks at the reviewed
//     head, and its `line` only as a positive integer at most `paths.lines` of that file (H3). Otherwise neither is
//     recorded, and the result's `dropped` notes name the finding's id, never the value. With no `paths`, the check
//     cannot run, and neither is recorded. `kept: true` skips it, for findings the record already holds as checked:
//     the step's call that gives ids to findings attest stored without one.
//   - when it is a ruling, names the finding it repeats by `ruled_id`: a raised finding the record holds by that title
//     and file (a pass's listing, then a round's entry, never another ruling), else the one its prior ruling named.
// Then every twin of a marked finding the record holds takes the mark (tieTwins).
export function recordFindings(state, passId, result, { mint = false, securityPass = false, paths = null, kept: checked = false } = {}) {
  const before = isObject(state.passes?.[passId]) ? state.passes[passId] : null;
  const prior = before ? GROUPS.flatMap((key) => (Array.isArray(before[key]) ? before[key] : [])).filter((each) => isObject(each) && isFindingId(each.id)) : [];
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
    const { id, mint: mark, aliases, ruled_id: _named, security, ...finding } = raw;
    const kept = isFindingId(id) && isMint(mark) && held.get(id)?.mint === mark ? held.get(id) : null;
    // A ruling carries a prior ruling's id, and a finding a prior finding's: a ruling never takes the id of the finding
    // it repeats, whose title it shares.
    const ruling = Boolean(trimmed(finding.already_ruled));
    const match = kept ?? prior.find((each) => !taken.has(each) && Boolean(trimmed(each.already_ruled)) === ruling && placeKey(each) === placeKey(finding));
    if (match) taken.add(match);
    const identity = match ? { id: match.id, mint: match.mint, ...(Array.isArray(match.aliases) && match.aliases.length ? { aliases: match.aliases.filter(isFindingId) } : {}) } : mint ? fresh() : null;
    const marked = flagged(security) || match?.security === true || securitySeverity(finding.severity) || securityPass;
    const out = { ...(identity ?? {}), ...finding, ...(marked ? { security: true } : {}) };
    if (checked) return out;
    const name = identity?.id ?? 'a finding with no id';
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
  // The new findings take the mark of a twin in the record as it stood before this write, the result it replaces
  // included, so a marked finding that lives only in that result still ties its reworded repeat.
  const recordedNow = new Set(Object.values(groups).flat());
  for (const finding of twinClosure([...recordedFindings(state), ...recordedNow], securitySeed)) if (recordedNow.has(finding)) finding.security = true;
  state.passes[passId] = recorded;
  tieTwins(state);
  return recorded;
}
