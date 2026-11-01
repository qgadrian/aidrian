// Critical flows at review time: the invariants a flow's reviewer answers, the check of each verdict's evidence, and
// whether a flow is signed off. docs/review.md#flows describes them.

import { isObject } from '../fs.mjs';
import { runGit } from '../git.mjs';

// The invariant a flow with none stated is held to. Lint and the summary mark such a flow "unspecified".
export const UNSPECIFIED = Object.freeze({
  id: 'unspecified',
  text: 'The change keeps this flow working as before: no entry point, user action, or guarantee of the flow is removed or weakened.',
});

const slug = (text) => text.toLowerCase().replace(/[`*_]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');

// The invariants of a flow. A list is used as written. A doc's invariants are its `##` and `###` headings, each with
// the paragraph under it; `read(path)` returns the doc's text or null. Returns { invariants, unspecified, problem }.
export function invariantsOf(flow, read) {
  if (Array.isArray(flow.invariants)) return { invariants: flow.invariants.map((invariant) => withSource(invariant, read)), unspecified: false, problem: null };
  if (typeof flow.invariants !== 'string') return { invariants: [UNSPECIFIED], unspecified: true, problem: null };
  const text = read(flow.invariants);
  if (text === null) return { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} is missing` };
  const invariants = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^#{2,3}\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      current = { id: slug(heading[1]), text: heading[1], cite: `${flow.invariants}#${slug(heading[1])}` };
      invariants.push(current);
    } else if (current && line.trim() && current.body === undefined) current.body = line.trim();
  }
  const list = invariants.map(({ body, ...rest }) => ({ ...rest, text: body ? `${rest.text}: ${body}` : rest.text }));
  return list.length ? { invariants: list, unspecified: false, problem: null } : { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} has no ## headings` };
}

// The most of a cited section a reviewer reads, and of the blocks a `focus` picks: the project chose those as the rule,
// so they get more room before a cut.
export const MAX_SOURCE = 4000;
export const MAX_FOCUSED = 8000;

// The section of a markdown doc under the heading whose slug is `anchor`: the heading and its body, up to the next
// heading of the same or a higher level. Null when the doc has no such heading.
export function sectionOf(text, anchor) {
  const lines = String(text ?? '').split('\n');
  let start = -1;
  let level = 0;
  for (const [i, line] of lines.entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    if (start === -1 && slug(heading[2]) === anchor) {
      start = i;
      level = heading[1].length;
    } else if (start !== -1 && heading[1].length <= level) return { heading: lines[start].replace(/^#+\s+/u, '').trim(), body: lines.slice(start + 1, i).join('\n').trim() };
  }
  return start === -1 ? null : { heading: lines[start].replace(/^#+\s+/u, '').trim(), body: lines.slice(start + 1).join('\n').trim() };
}

// The top-level blocks of a section body, in order: a sub-heading, a top-level list item with its indented lines, or a
// paragraph. A fenced code block stays inside the block it starts in. Blank lines are dropped from block edges.
export function blocksOf(body) {
  const blocks = [];
  let current = null;
  let fenced = false;
  let blank = true;
  for (const line of String(body ?? '').split('\n')) {
    const fence = /^\s*(?:```|~~~)/u.test(line);
    const starts = !fenced && (/^#{1,6}\s/u.test(line) || /^(?:[-*+]|\d+[.)])\s/u.test(line) || (blank && /^\S/u.test(line)));
    if (starts || (!current && line.trim())) {
      current = [];
      blocks.push(current);
    }
    if (current) current.push(line);
    if (fence) fenced = !fenced;
    blank = line.trim() === '';
  }
  return blocks.map((lines) => lines.join('\n').trim()).filter(Boolean);
}

// A block's first line in plain words, lowercase: the list marker, heading marks, and inline markup removed.
const plain = (text) => String(text).split('\n')[0].replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/u, '').replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

// The focus words of an invariant, as a list: `focus` is one string or a list of them.
export const focusesOf = (invariant) => (invariant.focus === undefined ? [] : [invariant.focus].flat());

// Whether a block starts with the focus words, whole words only: "Rule 1" starts "Rule 1: ..." but not "Rule 10".
const startsWith = (block, focus) => {
  const [text, words] = [plain(block), plain(focus)];
  return words !== '' && text.startsWith(words) && !/[\p{L}\p{N}]/u.test(text[words.length] ?? '');
};

// The blocks of `section` that each focus starts, in section order, and the focuses no block starts.
export function focusBlocks(section, focuses) {
  const blocks = blocksOf(section.body);
  const missing = focuses.filter((focus) => !blocks.some((block) => startsWith(block, focus)));
  return { blocks: blocks.filter((block) => focuses.some((focus) => startsWith(block, focus))), missing };
}

// What a reviewer reads of a cited section: the heading and its blocks (only the focused ones when the invariant has a
// `focus`), cut at a block boundary to the limit with a note naming every block it left out and where to read it. A
// first block longer than the limit is cut inside it. Returns { source, length, limit }, `length` before any cut.
export function sourceOf(section, invariant) {
  const focuses = focusesOf(invariant);
  const limit = focuses.length ? MAX_FOCUSED : MAX_SOURCE;
  const blocks = focuses.length ? focusBlocks(section, focuses).blocks : blocksOf(section.body);
  const full = [section.heading, ...blocks].join('\n\n');
  if (full.length <= limit) return { source: full, length: full.length, limit };
  let kept = section.heading;
  let shown = 0;
  while (shown < blocks.length && `${kept}\n\n${blocks[shown]}`.length <= limit) kept = `${kept}\n\n${blocks[shown++]}`;
  if (shown === 0) {
    kept = `${kept}\n\n${blocks[0]}`.slice(0, limit);
    shown = 1;
  }
  const left = blocks.slice(shown).map((block) => `"${block.split('\n')[0].replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '').slice(0, 80)}"`);
  const note = left.length ? `not shown: ${left.join(', ')}` : 'the rest of the block is not shown';
  return { source: `${kept}\n[cut at ${limit} characters; ${note}; read ${invariant.cite}]`, length: full.length, limit };
}

// An invariant of a list with the doc section it cites as `source`, which the reviewer judges against: the text is
// the question, the cited doc is the rule. With no text, the question comes from the cited heading and focus.
function withSource(invariant, read) {
  if (typeof invariant.cite !== 'string' || !invariant.cite.includes('#')) return invariant;
  const [file, anchor] = invariant.cite.split('#');
  const section = sectionOf(read(file), anchor);
  const focus = focusesOf(invariant);
  const named = section ? (focus.length ? `${section.heading}: ${focus.join('; ')}` : section.heading) : null;
  const text = invariant.text ?? (named ? `Does the change keep "${named}" as the cited section defines it?` : `Does the change keep ${invariant.cite} as it defines?`);
  if (!section) return { ...invariant, text };
  return { ...invariant, text, source: sourceOf(section, invariant).source };
}

// Whether a verdict's evidence names something real at `head`: `path:line` of a file that has that line, or
// `test:<name>` that appears in a file at head. A citation proves the place exists, not that it shows the invariant
// holds; the independent stage challenges that, and the summary says so.
// `capture:<key>` names an image the visual capture took of this head (lib/review/visual.mjs): `captures` holds this
// head's keys, so an image of another head, or a file an agent put there, is no evidence.
export function citationProblem(evidence, { root, head, captures = new Set() }) {
  if (typeof evidence !== 'string' || evidence.trim() === '') return 'no evidence';
  const capture = /^capture:(.+)$/u.exec(evidence.trim());
  if (capture) return captures.has(capture[1].trim()) ? null : `no capture "${capture[1].trim()}" of ${head.slice(0, 7)}`;
  const test = /^test:(.+)$/u.exec(evidence.trim());
  if (test) {
    const found = runGit(['grep', '-F', '-q', '-e', test[1].trim(), head], root, { timeout: 15_000 });
    return found.status === 0 ? null : `no file at ${head.slice(0, 7)} names the test "${test[1].trim()}"`;
  }
  const place = /^(.+?):(\d+)(?:-\d+)?$/u.exec(evidence.trim());
  if (!place) return `"${evidence}" is not path:line, test:<name>, or capture:<key>`;
  const shown = runGit(['show', `${head}:${place[1]}`], root, { timeout: 15_000 });
  if (shown.status !== 0) return `${place[1]} is not in ${head.slice(0, 7)}`;
  const lines = shown.stdout.split('\n').length;
  return Number(place[2]) >= 1 && Number(place[2]) <= lines ? null : `${place[1]} has no line ${place[2]}`;
}

// The sign-off state of one flow from its verdicts: { signed, open, unverified } where `open` lists the invariants a
// verdict says are violated, and `unverified` those with no valid holds or not_affected verdict. A verdict that fails
// its citation counts as cannot_verify.
export function flowState(invariants, verdicts, check) {
  const open = [];
  const unverified = [];
  for (const invariant of invariants) {
    const mine = verdicts.filter((verdict) => verdict.invariant === invariant.id);
    if (mine.some((verdict) => verdict.verdict === 'violated')) open.push(invariant.id);
    else if (!mine.some((verdict) => ['holds', 'not_affected'].includes(verdict.verdict) && check(verdict.evidence, verdict) === null)) unverified.push(invariant.id);
  }
  return { signed: open.length === 0 && unverified.length === 0, open, unverified };
}

// The verdicts in a file an agent pass recorded: [{ flow, invariant, verdict, evidence }]; throws on a bad file.
export function parseVerdicts(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('--verdicts must be a JSON file');
  }
  const list = Array.isArray(raw) ? raw : raw?.verdicts;
  if (!Array.isArray(list)) throw new Error('--verdicts must hold a list of { flow, invariant, verdict, evidence }');
  for (const [i, verdict] of list.entries()) {
    const ok = isObject(verdict) && typeof verdict.flow === 'string' && typeof verdict.invariant === 'string' &&
      ['holds', 'violated', 'not_affected', 'cannot_verify'].includes(verdict.verdict) && typeof verdict.evidence === 'string';
    if (!ok) throw new Error(`--verdicts[${i}] must be { flow, invariant, verdict: holds|violated|not_affected|cannot_verify, evidence }`);
  }
  return list;
}
