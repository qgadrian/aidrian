// Critical flows at review time: the invariants a flow's reviewer answers, the check of each verdict's evidence, and
// whether a flow is signed off. docs/review.md#flows describes them.

import { isObject } from '../fs.mjs';
import { runGit } from '../git.mjs';
import { closes, expandTabs, fencedIn, fenceOf, indentOf } from '../markdown-sections.mjs';

// The invariant a flow with none stated is held to. Lint and the summary mark such a flow "unspecified".
export const UNSPECIFIED = Object.freeze({
  id: 'unspecified',
  text: 'The change keeps this flow working as before: no entry point, user action, or guarantee of the flow is removed or weakened.',
});

// The key two anchors are compared by: GitHub's anchor with `_` dropped and runs of spaces and hyphens collapsed, so
// an anchor written by hand, copied from GitHub, or made by `anchor` finds its heading. Never shown as a link.
export const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/[\s-]+/gu, '-').replace(/^-|-$/gu, '');

// A heading's text as GitHub renders it: a link or image is its text, a code span its content as written, and
// emphasis outside code loses its `*` and `_` delimiters; `_` inside a word, or inside code, stays.
const EMPHASIS = /(^|[^\p{L}\p{N}])[*_]+|[*_]+(?=[^\p{L}\p{N}]|$)/gu;
// A code span opens with a run of backticks and closes at the next run of the same length; an unmatched run is text.
export const rendered = (text) => String(text).replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
  .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)|[^`]+|`+/gu, (part, ticks, code) => (ticks
    ? (/^ .*[^ ].* $/su.test(code) ? code.slice(1, -1) : code)
    : part.replace(EMPHASIS, '$1').replace(/\*/gu, '')));

// A heading's anchor exactly as GitHub makes it, for a link people follow: the rendered text, lowercased, with
// punctuation dropped, `_` kept, and each space a hyphen. `headingsOf` adds the `-1` suffix of a repeated heading.
export const anchor = (text) => rendered(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');

// An ATX heading: its `#` run and its text. A closing `#` run counts only after a space, so `## C#` keeps its `#`.
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;

// The headings of a markdown doc outside fenced code, in order: { line, level, text, anchor, slug, nth }. `anchor` is
// GitHub's, with `-1`, `-2` on a repeat as GitHub numbers them, across every level; `nth` counts earlier headings
// with the same slug, so `x-1` also finds the second `X` when GitHub's anchors would not.
export function headingsOf(lines) {
  const fenced = fencedIn(lines);
  const seen = new Map();
  const taken = new Set();
  const nths = new Map();
  const headings = [];
  for (const [i, line] of lines.entries()) {
    const match = fenced[i] ? null : HEADING.exec(line);
    if (!match || !match[2]) continue;
    const base = anchor(match[2]);
    let unique = base;
    let n = seen.get(base) ?? 0;
    while (taken.has(unique)) {
      n += 1;
      unique = `${base}-${n}`;
    }
    seen.set(base, n);
    taken.add(unique);
    const key = slug(match[2]);
    headings.push({ line: i, level: match[1].length, text: match[2], anchor: unique, slug: key, nth: nths.get(key) ?? 0 });
    nths.set(key, (nths.get(key) ?? 0) + 1);
  }
  return headings;
}

// The invariants of a flow. A list is used as written. A doc's invariants are its `##` and `###` headings, each with
// the paragraph under it; `read(path)` returns the doc's text or null. Returns { invariants, unspecified, problem }.
export function invariantsOf(flow, read) {
  if (Array.isArray(flow.invariants)) return { invariants: flow.invariants.map((invariant) => withSource(invariant, read)), unspecified: false, problem: null };
  if (typeof flow.invariants !== 'string') return { invariants: [UNSPECIFIED], unspecified: true, problem: null };
  const text = read(flow.invariants);
  if (text === null) return { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} is missing` };
  // A `##` line in a fenced code block is code, not an invariant. A repeated heading is its own invariant, with its own
  // id and anchor, `-1` on the second: one verdict never signs off two rules. `repeated` lists each with its ids.
  const lines = text.split(/\r?\n/u);
  const headings = headingsOf(lines);
  const fenced = fencedIn(lines);
  const ids = new Set();
  const byText = new Map();
  const invariants = [];
  for (const [h, heading] of headings.entries()) {
    if (heading.level < 2 || heading.level > 3) continue;
    let id = heading.nth ? `${heading.slug}-${heading.nth}` : heading.slug;
    for (let n = 1; ids.has(id); n += 1) id = `${heading.slug}-${heading.nth + n}`;
    ids.add(id);
    byText.set(heading.text, [...(byText.get(heading.text) ?? []), id]);
    const until = headings[h + 1]?.line ?? lines.length;
    const body = lines.slice(heading.line + 1, until).filter((_, j) => !fenced[heading.line + 1 + j]).map((line) => line.trim()).find(Boolean);
    invariants.push({ id, text: body ? `${heading.text}: ${body}` : heading.text, cite: `${flow.invariants}#${heading.anchor}` });
  }
  if (!invariants.length) return { invariants: [UNSPECIFIED], unspecified: true, problem: `${flow.invariants} has no ## headings` };
  return { invariants, unspecified: false, problem: null, repeated: [...byText].filter(([, each]) => each.length > 1).map(([heading, each]) => ({ heading, ids: each })) };
}

// The most of a cited section a reviewer reads, and of the blocks a `focus` picks: the project chose those as the rule,
// so they get more room before a cut.
export const MAX_SOURCE = 4000;
export const MAX_FOCUSED = 8000;

// The section of a markdown doc under the heading `anchor` names, compared by slug: the heading and its body, up to the next
// heading of the same or a higher level; `raw` is the body with its indentation kept, for blocksOf. Null when the doc
// has no such heading. A `#` line in a fenced code block, such as a shell comment, is code, not a heading: it neither
// ends a section nor matches the anchor.
export function sectionOf(text, anchor) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const range = sectionRange(text, anchor);
  if (!range) return null;
  const raw = lines.slice(range.start + 1, range.end).join('\n').replace(/^(?:[ \t]*\n)+/u, '').trimEnd();
  return { heading: range.heading, body: raw.trim(), raw };
}

// Where sectionOf's section sits: { heading, start, end }, 0-based, the heading line at `start` and `end` exclusive.
// Null when the doc has no such heading.
export function sectionRange(text, anchor) {
  const wanted = String(anchor ?? '');
  const key = slug(wanted);
  // CRLF or LF: a `\r` left on a line would hide its fence, and `raw` is rejoined with LF.
  const lines = String(text ?? '').split(/\r?\n/u);
  const headings = headingsOf(lines);
  // GitHub's exact anchor first, a repeat's `-1` included; then the first heading whose rendered or raw text slugs to
  // the anchor, which keeps anchors written by hand or before matching; then `x-1` as the second heading slugged `x`.
  const repeat = /^(.+)-(\d+)$/u.exec(key);
  const found = headings.find((heading) => heading.anchor === wanted.toLowerCase())
    ?? headings.find((heading) => slug(rendered(heading.text)) === key || heading.slug === key)
    ?? (repeat ? headings.find((heading) => heading.slug === repeat[1] && heading.nth === Number(repeat[2])) : undefined);
  if (!found) return null;
  const start = found.line;
  const end = headings.find((heading) => heading.line > start && heading.level <= found.level)?.line ?? lines.length;
  return { heading: found.text, start, end };
}

// A list item's marker and the content column after it, or null: blocksOf groups a line under the item whose content
// column it reaches, and ends a fence opened after a marker where that item ends. A thematic break such as `* * *` or
// `- - -` looks like an item but is not one (CommonMark), so it is a block of its own.
const THEMATIC_BREAK = /^ *([-*_])(?: *\1){2,} *$/u;
const itemOf = (line) => (THEMATIC_BREAK.test(line) ? null : /^( *)((?:[-*+]|\d+[.)]) +)\S/u.exec(line));

// The top-level blocks of a section body, in order: a sub-heading, a top-level list item with its nested lines, a
// fenced block, or a paragraph. As in CommonMark, a line belongs to the list item above it when it is indented to that
// item's content column or deeper; otherwise a line up to 3 spaces past the body's least indentation is top level. So
// bullets split whether the section indents them all, or indents them under a plain paragraph. A fence stays inside
// the block it starts in, and ends at a bare fence of its own character, at least as long, or, when it opened inside a
// list item, where that item ends. Indentation counts tabs to 4-column stops. Blank lines are dropped from block edges.
export function blocksOf(body) {
  const lines = String(body ?? '').split(/\r?\n/u).map(expandTabs);
  // The least indentation outside fences, from a first pass that matches delimiters only. Accepted residual: this pass
  // does not end an unclosed fence where its list item ends, so a section can get too high a base, and a deeper bullet
  // after such a fence becomes its own block.
  let least = null;
  let scan = null;
  for (const line of lines) {
    if (scan === null && line.trim()) least = Math.min(least ?? Infinity, indentOf(line));
    const fence = fenceOf(line);
    if (scan === null && fence) scan = fence;
    else if (scan && closes(fence, scan)) scan = null;
  }
  const base = least ?? 0;
  const blocks = [];
  let current = null;
  let column = null; // the content column of the list item the current block is, or null
  let open = null; // the fence open now: its delimiter, and the content column of the item it opened in, or null
  let closed = false; // the line before closed a fence
  let blank = true;
  for (const line of lines) {
    const indent = indentOf(line);
    if (open?.container != null && line.trim() && indent < open.container) open = null;
    const inside = open !== null;
    const fence = fenceOf(line);
    const text = line.slice(Math.min(base, indent));
    const item = itemOf(line);
    const top = !inside && line.trim() !== '' && indent - base <= 3 && (column === null || indent < column);
    // A thematic break is a block of its own: it starts one, and the line after it starts the next.
    const rule = top && THEMATIC_BREAK.test(line);
    const starts = top && (/^#{1,6}\s/u.test(text.trimStart()) || item !== null || blank || fence !== null || closed || rule);
    if (starts || (!current && line.trim())) {
      current = [];
      blocks.push(current);
      column = item ? item[1].length + item[2].length : null;
    }
    if (current) current.push(text);
    closed = rule;
    if (!inside && fence) open = { ...fence, container: fence.item ?? (column !== null && indent >= column ? column : null) };
    else if (inside && closes(fence, open)) {
      open = null;
      closed = true;
    }
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

// The sign-off state of one flow from its verdicts: { signed, open, unverified, disputed } where `open` lists the
// invariants a verdict says are violated, and `unverified` those with no valid holds or not_affected verdict. A verdict
// that fails its citation counts as cannot_verify. `disputed` lists the violated invariants another verdict answers
// holds or not_affected with valid evidence: reviewers disagree, and the Human may overrule the violated side on that
// head (`overruled`, a set of invariant ids). An overruled invariant then passes on the other side's evidence, never
// on the Human's word alone.
export function flowState(invariants, verdicts, check, overruled = new Set()) {
  const open = [];
  const unverified = [];
  const disputed = [];
  for (const invariant of invariants) {
    const mine = verdicts.filter((verdict) => verdict.invariant === invariant.id);
    const violated = mine.some((verdict) => verdict.verdict === 'violated');
    const backed = mine.some((verdict) => ['holds', 'not_affected'].includes(verdict.verdict) && check(verdict.evidence, verdict) === null);
    if (violated && backed) disputed.push(invariant.id);
    if (violated && !(backed && overruled.has(invariant.id))) open.push(invariant.id);
    else if (!backed) unverified.push(invariant.id);
  }
  return { signed: open.length === 0 && unverified.length === 0, open, unverified, disputed };
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
