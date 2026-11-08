// A pass's findings one by one, for `aidrian pr attest --pass <id> --findings-file <file>`: each finding carries its
// axes (severity, likelihood, affects, cost) and its state (open, fixed, accepted), and finding-disposition.json
// decides which still block. Counts alone let a reviewer call anything accepted; per-finding axes let the table
// decide. A finding whose `already_ruled` names an entry of the settled list its caller passes (settledMatch), and
// whose own disposition can be accepted, repeats a ruling, so it never blocks and counts as accepted.
// docs/review.md#findings describes the file.

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
function noHigher(a, b) {
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
      state: finding.state,
      disposition: decided.disposition,
    };
  });
  const fixed = out.filter((finding) => finding.state === 'fixed').length;
  const open = out.filter(blocks).length;
  return { list: out, findings: out.length, fixed, accepted: out.length - fixed - open, open, notes };
}
