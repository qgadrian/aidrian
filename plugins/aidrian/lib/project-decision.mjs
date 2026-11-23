// A decision the Human recorded on an issue before a project run: one section of the issue's description in the tracker,
// pinned by its heading and sha256 in the team's projectRun.recordedDecisions on the default branch (docs/config.md#recorded-decisions).
// The grant changes only what an issue's session is told: each start checks the pinned section against the text the run
// kept at init (lib/project-issue-text.mjs), and when it stands writes it to `<attempt>/decision.md`, read-only, which
// the first message names (lib/project-run-gate.mjs). Results, parks, stop actions, and merge trust are as without it.
// `aidrian project decision ISSUE --heading TEXT` prints the entry to pin, from this session's recorded tracker read of the
// issue, the same bytes init keeps; only an attended session runs it (lib/project-run-guard.mjs), and it writes nothing.

import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sessionIdentity } from './hosts/index.mjs';
import { fencedIn } from './markdown-sections.mjs';
import { fenceFor, recordedTexts, TEXT_CAPS } from './project-issue-text.mjs';
import { attendedProblem, ISSUE_KEY, runPlace } from './project-run.mjs';

// The file each attempt's session reads a recorded decision from, in its attempt folder, beside issue.md.
export const DECISION_FILE = 'decision.md';
// The longest heading an entry pins, as the config check holds it (config-types.mjs recordedDecisions).
export const HEADING_CAP = 200;
// What the grant settles and what it never does, in the first message and in decision.md alike.
export const DECISION_SCOPE = 'It is the Human\'s answer to the decision it names, under the autopilot skill\'s § Who decides rule 2, and settles that decision alone: ' +
  'it changes no step of the skills this run uses, waives no review, test, check, hook, or gate, and allows no merge or ready the first message does not. ' +
  'Do not park or ask that decision again. ' +
  'It settles only what its own words say: a reference to text outside it, such as an option\'s number or \'as above\', settles nothing, and a decision whose meaning needs that text parks as before. ' +
  'It covers only what it says, read narrowly. ' +
  'It never allows real or personal data, a secret, or access this session does not already have; it is no security-engineer verdict and no sign-off of a pull request; whatever it does not settle parks as before.';

// An ATX heading of any level: its hashes, then a space, a tab, or the line's end.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/u;
// The markup a tracker's view of the description hides or folds away: an HTML comment, a <details> block's tags, and a
// `+++` collapsible's lines.
const COMMENT = /<!--[\s\S]*?(?:-->|(?![\s\S]))/gu;
const DETAILS_TAG = /<(\/?)details/giu;
const COLLAPSIBLE = /^[ \t]*\+\+\+.*$/gmu;

// Why a section is void or cannot be pinned, as recordedDecision and `aidrian project decision` say it.
const WHY = Object.freeze({
  none: 'no section, or more than one, has that heading',
  cut: 'the kept description was cut off before the section ends',
  hidden: 'the section holds text the tracker\'s view hides',
});

const digest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

// The one section of `description` whose ATX heading, outside code fences, has the title `heading` once trimmed: the
// heading line through the line before the next heading of the same or a higher level, CRLF read as LF, each line's end
// trimmed, and blank lines at both ends dropped. { text, section, from, to, toEnd }: `text` the whole description so
// normalized, `from` and `to` the section's offsets in it, and `toEnd` whether no later heading ends it. Null when no
// heading has that title, or more than one does.
function sectionIn(description, heading) {
  if (typeof description !== 'string' || typeof heading !== 'string' || heading.trim() === '') return null;
  const wanted = heading.trim();
  const lines = description.replace(/\r\n/gu, '\n').split('\n').map((line) => line.trimEnd());
  const fenced = fencedIn(lines);
  const headings = lines.map((line, at) => {
    const found = fenced[at] ? null : ATX.exec(line);
    return found ? { level: found[1].length, title: (found[2] ?? '').trim() } : null;
  });
  const starts = headings.flatMap((found, at) => (found?.title === wanted ? [at] : []));
  if (starts.length !== 1) return null;
  const [start] = starts;
  const next = headings.findIndex((found, at) => at > start && found !== null && found.level <= headings[start].level);
  const kept = lines.slice(start, next === -1 ? lines.length : next);
  while (kept.length && kept.at(-1) === '') kept.pop();
  const section = kept.join('\n');
  const from = lines.slice(0, start).reduce((offset, line) => offset + line.length + 1, 0);
  return { text: lines.join('\n'), section, from, to: from + section.length, toEnd: next === -1 };
}

// sectionOf's section alone, or null.
export const sectionOf = (description, heading) => sectionIn(description, heading)?.section ?? null;

// The ranges of `text` a tracker's view hides, as [from, to) offsets: each HTML comment, to its close or the text's end;
// each outermost <details> block, from its first tag to the tag that closes it, or the text's end; and each `+++`
// collapsible, from its opening line through the next `+++` line, or the text's end.
export function hiddenRanges(text) {
  const ranges = [...text.matchAll(COMMENT)].map((found) => [found.index, found.index + found[0].length]);
  let depth = 0;
  let open = 0;
  for (const tag of text.matchAll(DETAILS_TAG)) {
    if (tag[1] === '') {
      if (depth === 0) open = tag.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) ranges.push([open, tag.index + tag[0].length + 1]);
    }
  }
  if (depth > 0) ranges.push([open, text.length]);
  const marks = [...text.matchAll(COLLAPSIBLE)];
  for (let at = 0; at < marks.length; at += 2) {
    const close = marks[at + 1];
    ranges.push([marks[at].index, close ? close.index + close[0].length : text.length]);
  }
  return ranges;
}

// The section of `description` under `heading` that may be pinned: { section }, or { why } when no single section has
// that heading, the description was cut off at its cap (`cut`, project-issue-text.mjs) with the section running to its
// end, or the section overlaps a range of the whole description the tracker's view hides (hiddenRanges).
function pinnable(description, heading, cut) {
  const found = sectionIn(description, heading);
  if (!found) return { why: WHY.none };
  if (cut && found.toEnd) return { why: WHY.cut };
  if (hiddenRanges(found.text).some(([from, to]) => from < found.to && to > found.from)) return { why: WHY.hidden };
  return { section: found.section };
}

// The entry `entry` ({ heading, sha256 }) checked against `text`, the issue's kept description, which `cut` says its cap
// cut off: { section, sha256 } when the section may be pinned (pinnable) and the sha256 of its UTF-8, the heading line
// included, is the entry's, else { void: why }.
export function recordedDecision(entry, text, { cut = false } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return { void: 'the run kept no description of the issue' };
  const checked = pinnable(text, entry?.heading, cut);
  if (checked.why) return { void: checked.why };
  const sha256 = digest(checked.section);
  if (sha256 !== entry.sha256) return { void: 'the section\'s sha256 differs, so it changed after it was pinned' };
  return { section: checked.section, sha256 };
}

// The text of decision.md for issue `key`: what the grant settles and never does, the sha256 the team pinned, and the
// section in one fence no line of it can close.
export function decisionMarkdown(key, entry, section) {
  const fence = fenceFor(section);
  return [
    `# Issue ${key}: a decision the Human recorded`,
    '',
    `The team's config on the default branch pins this section of the issue's description in the tracker by its heading and sha256. ${DECISION_SCOPE}`,
    '',
    `sha256: ${entry.sha256}`,
    '',
    `${fence}text`,
    section,
    fence,
    '',
  ].join('\n');
}

// Writes `<attemptFolder>/decision.md`, read-only, as writeIssueFile writes issue.md: its path. Throws what the write throws.
export function writeDecisionFile(attemptFolder, key, entry, section) {
  const file = path.join(attemptFolder, DECISION_FILE);
  writeFileSync(file, decisionMarkdown(key, entry, section), { mode: 0o444, flag: 'wx' });
  chmodSync(file, 0o444);
  return file;
}

// `aidrian project decision ISSUE --heading TEXT`, from an attended session (attendedProblem): the section of ISSUE's
// description headed `heading`, from this session's recorded tracker read (recordedTexts), fenced as it is hashed; how to
// write it; and, last, the entry to add to projectRun.recordedDecisions. Exit 1 with no recorded read of ISSUE, or a
// section that may not be pinned (pinnable). Writes nothing.
export function decisionCommand({ project, config, key, heading, env = process.env, home }) {
  const refuse = (why) => ({ exitCode: 1, out: [], err: [`aidrian project decision: ${why}`] });
  if (!ISSUE_KEY.test(key ?? '')) return refuse(`${JSON.stringify(key)} is not an issue key`);
  const title = typeof heading === 'string' ? heading.trim() : '';
  if (title === '' || title.length > HEADING_CAP || /[\r\n]/u.test(title)) return refuse(`--heading takes one line of 1 to ${HEADING_CAP} characters, the section's heading without its hashes`);
  const place = runPlace(project, config, { env, ...(home ? { home } : {}) });
  if (place.problem) return refuse(place.problem);
  const { session } = sessionIdentity(env);
  const attended = attendedProblem({ session, project, config, state: place.state, env, ...(home ? { home } : {}) });
  if (attended) return refuse(`a recorded decision is pinned from an attended session, and ${attended}`);
  const text = recordedTexts(session, [key], { env, ...(home ? { home } : {}) })[key];
  if (!text) return refuse(`this session recorded no tracker read of ${key}; read it with the tracker's own issue read, then run this again`);
  const checked = pinnable(text.description, title, text.descriptionCut === true);
  if (checked.why === WHY.none) return refuse(`no section of ${key}'s description, or more than one, has the heading ${JSON.stringify(title)}`);
  if (checked.why === WHY.cut) return refuse(`${WHY.cut}, at ${TEXT_CAPS.description} characters: end the section with a heading before the cap, or move it nearer the top`);
  if (checked.why === WHY.hidden) return refuse(`${WHY.hidden} (an HTML comment, a <details> block, or a +++ collapsible, in it or around it); write it as plain text, then read the issue again`);
  const { section } = checked;
  const fence = fenceFor(section);
  return {
    exitCode: 0,
    out: [
      `${fence}text`, section, fence,
      'Write the section so it stands alone: it names the question and the chosen path in full, since a reference to text outside it, such as an option\'s number, settles nothing.',
      `"${key}": { "heading": ${JSON.stringify(title)}, "sha256": "${digest(section)}" }`,
    ],
    err: [],
  };
}
