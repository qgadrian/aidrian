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
// Markup a tracker's view of the description hides or folds away, anywhere in it, fenced or not: an HTML comment's
// opening, a <details> tag, or a `+++` collapsible's line.
const HIDDEN_MARKUP = /<!--|<details|^[ \t]*\+\+\+(?:[ \t]|$)/imu;

// Why a section is void or cannot be pinned, as recordedDecision and `aidrian project decision` say it.
const WHY = Object.freeze({
  none: 'no section, or more than one, has that heading',
  cut: 'the kept description was cut off at its 20,000-character cap',
  hidden: 'the issue\'s description holds text the tracker\'s view hides',
});

const digest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
// `description` with CRLF read as LF and each line's end trimmed.
const normalized = (description) => description.replace(/\r\n/gu, '\n').split('\n').map((line) => line.trimEnd());

// The one section of `description` whose ATX heading, outside code fences, has the title `heading` once trimmed: the
// heading line through the line before the next heading of the same or a higher level, CRLF read as LF, each line's end
// trimmed, and blank lines at both ends dropped. Null when no heading has that title, or more than one does.
export function sectionOf(description, heading) {
  if (typeof description !== 'string' || typeof heading !== 'string' || heading.trim() === '') return null;
  const wanted = heading.trim();
  const lines = normalized(description);
  const fenced = fencedIn(lines);
  const headings = lines.map((line, at) => {
    const found = fenced[at] ? null : ATX.exec(line);
    return found ? { level: found[1].length, title: (found[2] ?? '').trim() } : null;
  });
  const starts = headings.flatMap((found, at) => (found?.title === wanted ? [at] : []));
  if (starts.length !== 1) return null;
  const [start] = starts;
  const next = headings.findIndex((found, at) => at > start && found !== null && found.level <= headings[start].level);
  const section = lines.slice(start, next === -1 ? lines.length : next);
  while (section.length && section.at(-1) === '') section.pop();
  return section.join('\n');
}

// Whether `description` holds markup the tracker's view hides anywhere, fenced or not (HIDDEN_MARKUP).
export const hidesText = (description) => HIDDEN_MARKUP.test(normalized(description).join('\n'));

// The section of `description` under `heading` that may be pinned: { section }, or { why } when the cap cut the
// description off (`cut`, project-issue-text.mjs), it holds hidden markup anywhere (hidesText), or no single section has
// that heading. Each voids every grant on the issue, wherever the section sits.
function pinnable(description, heading, cut) {
  if (cut) return { why: WHY.cut };
  if (hidesText(description)) return { why: WHY.hidden };
  const section = sectionOf(description, heading);
  return section === null ? { why: WHY.none } : { section };
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
  if (checked.why === WHY.cut) return refuse(`${WHY.cut}; keep a pinned issue's description under ${TEXT_CAPS.description} characters, then read the issue again`);
  if (checked.why === WHY.hidden) return refuse(`${WHY.hidden} (an HTML comment, a <details> tag, or a +++ line, anywhere, fenced or not); write it as plain text, then read the issue again`);
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
