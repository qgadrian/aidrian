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
// heading of the same or a higher level; `raw` is the body with its indentation kept, for blocksOf. Null when the doc
// has no such heading.
export function sectionOf(text, anchor) {
  const lines = String(text ?? '').split('\n');
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (const [i, line] of lines.entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    if (start === -1 && slug(heading[2]) === anchor) {
      start = i;
      level = heading[1].length;
    } else if (start !== -1 && heading[1].length <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  const raw = lines.slice(start + 1, end).join('\n').replace(/^(?:[ \t]*\n)+/u, '').trimEnd();
  return { heading: lines[start].replace(/^#+\s+/u, '').trim(), body: raw.trim(), raw };
}

// A fence line: its delimiter, and whether the line is the delimiter alone, which only a closing fence may be. An
// opening fence may follow list markers, as in "- ```js"; such a line is never bare, so it never closes one.
// CommonMark: https://spec.commonmark.org/0.31.2/#fenced-code-blocks
// `column` is where the delimiter starts: a line indented less ends the list item, and with it the fence.
const fenceOf = (line) => {
  const found = /^(\s*)((?:(?:[-*+]|\d+[.)])\s+)*)(`{3,}|~{3,})(.*)$/u.exec(line);
  // A backtick fence's info string has no backtick, so "```code``` stays literal" is inline code, not a fence.
  if (!found || (found[3][0] === '`' && found[4].includes('`'))) return null;
  return { char: found[3][0], length: found[3].length, bare: found[2] === '' && found[4].trim() === '', column: found[1].length + found[2].length };
};

// A line with the tabs of its indentation and list markers expanded to 4-column stops, so indentation is measured in
// columns: a tab-indented nested bullet stays nested.
const expandTabs = (line) => {
  const prefix = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*/u.exec(line)[0];
  let out = '';
  for (const char of prefix) out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char;
  return out + line.slice(prefix.length);
};

// The top-level blocks of a section body, in order: a sub-heading, a top-level list item with its nested lines, a
// fenced block, or a paragraph. As in CommonMark, a line belongs to the list item above it when it is indented to that
// item's content column or deeper; otherwise a line up to 3 spaces past the body's least indentation (outside fences)
// is top level. So bullets split whether the section indents them all, or indents them under a plain paragraph. A
// fenced code block stays inside the block it starts in, and closes on a bare fence of its own character, at least as
// long, or where its list item ends. Indentation counts tabs to 4-column stops. Blank lines are dropped from block edges.
export function blocksOf(body) {
  const lines = String(body ?? '').split('\n').map(expandTabs);
  // Per line: inside a fence (its closing line included), opening one, or the first line after one closes.
  const inFence = [];
  const opens = [];
  const afterFence = [];
  let open = null;
  let closed = false;
  for (const line of lines) {
    const fence = fenceOf(line);
    // A fence left open inside a list item ends with the item, at a line indented less than the fence.
    if (open && line.trim() && /^ */u.exec(line)[0].length < open.column) open = null;
    inFence.push(open !== null);
    opens.push(open === null && fence !== null);
    afterFence.push(closed);
    closed = false;
    if (open === null && fence) open = fence;
    else if (open && fence?.bare && fence.char === open.char && fence.length >= open.length) {
      open = null;
      closed = true;
    }
  }
  const indentOf = (line) => /^[ \t]*/u.exec(line)[0].length;
  const indents = lines.filter((line, i) => !inFence[i] && line.trim()).map(indentOf);
  const base = indents.length ? Math.min(...indents) : 0;
  const blocks = [];
  let current = null;
  // The content column of the list item the current block is, or null when it is not one.
  let column = null;
  let blank = true;
  for (const [i, line] of lines.entries()) {
    const indent = indentOf(line);
    const text = line.slice(Math.min(base, indent));
    const item = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)\S/u.exec(line);
    const top = !inFence[i] && line.trim() !== '' && indent - base <= 3 && (column === null || indent < column);
    const starts = top && (/^#{1,6}\s/u.test(text.trimStart()) || item !== null || blank || opens[i] || afterFence[i]);
    if (starts || (!current && line.trim())) {
      current = [];
      blocks.push(current);
      column = item ? item[1].length + item[2].length : null;
    }
    if (current) current.push(text);
    blank = line.trim() === '';
  }
  return blocks.map((each) => each.join('\n').replace(/^(?:[ \t]*\n)+/u, '').trimEnd()).filter((each) => each.trim());
}

// A block's first line in plain words, lowercase: the list marker, heading marks, and inline markup removed, and a
// link, inline `[label](url)` or reference `[label][ref]`, reduced to its label.
const plain = (text) => String(text).split('\n')[0].replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/u, '').replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/gu, '$1').replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

// The focus words of an invariant, as a list: `focus` is one string or a list of them.
export const focusesOf = (invariant) => (invariant.focus === undefined ? [] : [invariant.focus].flat());

// Whether a block starts with the focus words, whole words only: "Rule 1" starts "Rule 1: ..." but not "Rule 10".
const startsWith = (block, focus) => {
  const [text, words] = [plain(block), plain(focus)];
  return words !== '' && text.startsWith(words) && !/[\p{L}\p{N}]/u.test(text[words.length] ?? '');
};

// The blocks of `section` that each focus starts, in section order, and the focuses no block starts.
export function focusBlocks(section, focuses) {
  const blocks = blocksOf(section.raw ?? section.body);
  const missing = focuses.filter((focus) => !blocks.some((block) => startsWith(block, focus)));
  return { blocks: blocks.filter((block) => focuses.some((focus) => startsWith(block, focus))), missing };
}

// What a reviewer reads of a cited section: the heading and its blocks (only the focused ones when the invariant has a
// `focus` when every one matches), cut at a block boundary to the limit with a note naming every block it left out and where to read it. A
// first block longer than the limit is cut inside it. Returns { source, length, limit }, `length` before any cut.
export function sourceOf(section, invariant) {
  // When any focus starts no block, such as after an edit of the doc, the reviewer reads the whole section: more than
  // it needs, instead of part of the rule silently gone. `aidrian lint review` reports the focus.
  const chosen = focusesOf(invariant).length ? focusBlocks(section, focusesOf(invariant)) : null;
  const picked = chosen && !chosen.missing.length ? chosen.blocks : [];
  const focuses = picked.length ? focusesOf(invariant) : [];
  const limit = focuses.length ? MAX_FOCUSED : MAX_SOURCE;
  const blocks = focuses.length ? picked : blocksOf(section.raw ?? section.body);
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
