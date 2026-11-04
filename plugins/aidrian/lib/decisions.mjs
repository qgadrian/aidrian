// Who settles a product or design decision a session meets: the agent ("decide") or the Human ("ask").
// decisions.json is the only place the decision classes and the reversibility questions live; config.json `decisions`
// sets how far a project lets agents go (docs/config.md#decisions). resolveAuthority walks a fixed order and the first
// rule that matches wins, so no prompt weighs these by hand.
// A decision an agent made alone stays on record as a marker line in the doc that governs it (parseDecisions,
// docs/project-folder.md#decision-markers); decisions-cli.mjs scans the docs for them.
// config.mjs reads this file from every hook, so of the plugin's files it imports only markdown-sections.mjs, which imports nothing.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fencedIn, slug } from './markdown-sections.mjs';

export const VOCAB_PATH = path.join(import.meta.dirname, 'decisions.json');

// The authority modes, lowest first: "ask" leaves every decision to the Human; "decide-reversible" lets an agent
// settle one that every reversibility question answers no to.
export const DECISION_MODES = ['ask', 'decide-reversible'];

// The domains config.json `decisions.domains` sets one by one.
export const DECISION_DOMAINS = ['product', 'ux', 'architecture', 'backlog'];

let vocab;
// decisions.json, read once.
export const loadVocab = () => (vocab ??= JSON.parse(readFileSync(VOCAB_PATH, 'utf8')));

// Every class name, floor classes first, as decisions.json lists them.
export const decisionClasses = (table = loadVocab()) => table.classes.map((entry) => entry.class);

// The lower of two modes; a mode outside DECISION_MODES counts as "ask".
export const lowerMode = (a, b) => DECISION_MODES[Math.min(Math.max(DECISION_MODES.indexOf(a), 0), Math.max(DECISION_MODES.indexOf(b), 0))];

// The decision on one question. `config` is a loaded config, or its `decisions` block. The question:
// - `domain`: one of DECISION_DOMAINS; `class`: a class of decisions.json;
// - `reversible`: { storedData, external, pricingOrContract, reachesUsersUnreviewed }, each true (yes) or false (no);
//   an answer that is missing, or anything but false, asks;
// - `docs`: the doc paths the decision touches, from the project root, each with an optional `#section`, matched
//   against `escalateDocs`; one outside the project asks;
// - `pending`: the unreviewed decisions so far, as [{ domain, date }], for the domain pause.
// Returns { authority: "decide" | "ask", rule, reason }: `rule` names the rule that matched, `reason` says why.
export function resolveAuthority(config, { domain, class: kind, reversible, docs = [], pending = [] } = {}, { now = new Date(), table = loadVocab() } = {}) {
  const block = config.decisions ?? config;
  const ask = (rule, reason) => ({ authority: 'ask', rule, reason });
  const entry = table.classes.find((each) => each.class === kind);
  if (!entry) return ask('unknown-class', `${JSON.stringify(kind ?? null)} is no class of decisions.json, so it goes to the Human`);
  if (entry.floor) return ask('floor-class', `${kind} is a floor class: it always goes to the Human`);
  if (block.escalate.includes(kind)) return ask('escalate', `config.json decisions.escalate lists ${kind}`);
  const away = docs.find((each) => outsideProject(docParts(each)));
  if (away !== undefined) return ask('doc-outside-project', `${away} is outside the project, so no rule of the project covers it`);
  const doc = docs.find((each) => block.escalateDocs.some((listed) => docMatches(listed, each)));
  if (doc !== undefined) return ask('escalate-doc', `config.json decisions.escalateDocs covers ${doc}`);
  for (const key of Object.keys(table.reversibility)) {
    const answer = reversible?.[key];
    if (answer !== false) return ask('reversibility', `${key} is ${answer === true ? 'yes' : 'unanswered'}: ${table.reversibility[key]}`);
  }
  if (!DECISION_DOMAINS.includes(domain)) return ask('unknown-domain', `${JSON.stringify(domain ?? null)} is not one of ${DECISION_DOMAINS.join(', ')}`);
  const paused = pauseReason(block.unreviewed.pauseDomainAt, pending.filter((each) => each?.domain === domain), now);
  if (paused) return ask('domain-paused', `${domain} is paused: ${paused}`);
  const own = block.domains[domain];
  const [mode, rule] = own === 'inherit' ? [block.mode, 'mode'] : [own, `domains.${domain}`];
  const effective = lowerMode(mode, block.maxMode);
  if (effective !== mode) return ask('maxMode', `${rule} is ${mode}, above decisions.maxMode ${block.maxMode}`);
  if (effective === 'decide-reversible') return { authority: 'decide', rule, reason: `${rule} is decide-reversible and every reversibility answer is no` };
  return ask(rule, `${rule} is ask`);
}

// Why `pending`, one domain's unreviewed decisions, pauses that domain under `limits` ({ pending, oldestDays } or
// null), or null. A date that does not parse still counts toward `pending`.
function pauseReason(limits, pending, now) {
  if (!limits) return null;
  if (pending.length >= limits.pending) return `${pending.length} unreviewed decisions, the pause is at ${limits.pending}`;
  const ages = pending.map((each) => Math.floor((now - Date.parse(each.date)) / 86_400_000)).filter(Number.isFinite);
  const oldest = ages.length ? Math.max(...ages) : -1;
  if (oldest >= limits.oldestDays) return `the oldest unreviewed decision is ${oldest} days old, the pause is at ${limits.oldestDays}`;
  return null;
}

// One spelling of a doc path: { file, anchor }, with `file` normalised and no trailing slash, so `docs//a.md`,
// `./docs/a.md`, and `docs/x/../a.md` are one doc; the project root is ".". `anchor` is the section's slug, or empty,
// so `#Refund-Policy` and `#refund policy` name one section.
function docParts(value) {
  const text = String(value).trim().replaceAll('\\', '/');
  const at = text.indexOf('#');
  const [file, anchor] = at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
  return { file: path.posix.normalize(file || '.').replace(/(?<=.)\/+$/u, ''), anchor: slug(anchor) };
}

const outsideProject = ({ file }) => file === '..' || file.startsWith('../') || file.startsWith('/');

// Whether the folder or file `outer` is `inner` or holds it.
const holds = (outer, inner) => outer === '.' || inner === outer || inner.startsWith(`${outer}/`);

// Whether the `escalateDocs` entry `listed` covers the doc `doc`. A doc that is a folder holding the entry is covered:
// what it touches includes the entry. An entry with no section covers its file, whatever the doc's section, and every
// file of its folder. An entry `file#section` covers that section, and the file with no section named, which may
// include it; another section of the file is not covered. Paths compare in any case, so an entry asks alike on a disk
// that ignores case and on one that does not; two docs that differ only by case both ask, which fails closed.
function docMatches(listed, doc) {
  const entry = docParts(listed);
  const wanted = docParts(doc);
  const entryFile = entry.file.toLowerCase();
  const wantedFile = wanted.file.toLowerCase();
  if (wantedFile !== entryFile && holds(wantedFile, entryFile)) return true;
  if (!entry.anchor) return holds(entryFile, wantedFile);
  return wantedFile === entryFile && (!wanted.anchor || wanted.anchor === entry.anchor);
}

// What `aidrian check` warns about in a loaded config's `decisions`: a setting that lets unreviewed decisions pile up
// with nothing to say so or to stop them, and a `mode` or domain above `maxMode`, which the resolver holds to ask.
export function decisionWarnings(config) {
  const { mode, maxMode, domains, unreviewed: { remind, pauseDomainAt } } = config.decisions;
  const warnings = [];
  if (remind === 'off' && pauseDomainAt === null) {
    warnings.push('decisions.unreviewed: "remind" is "off" and "pauseDomainAt" is null, so unreviewed decisions pile up unseen; turn one back on');
  }
  const settings = [['decisions.mode', mode], ...Object.entries(domains).map(([domain, value]) => [`decisions.domains.${domain}`, value])];
  for (const [key, value] of settings) {
    if (value === 'inherit' || lowerMode(value, maxMode) === value) continue;
    warnings.push(`${key}: "${value}" is above decisions.maxMode "${maxMode}", so it has no effect; to turn it on, commit decisions.maxMode "${value}" in config.json`);
  }
  return warnings;
}

// What `aidrian check` warns about in `decisions.escalateDocs`: each entry whose file or folder no path of `tracked`,
// from the project root, matches exactly, case included. A typo escalates nothing. Another case still asks, since
// docMatches ignores case, but it names no doc as git does. Only a warning: a doc may be listed before it exists.
export function escalateDocWarnings(entries, tracked) {
  return entries
    .filter((entry) => {
      const { file: listed } = docParts(entry);
      return !tracked.some((file) => holds(listed, file));
    })
    .map((entry) => `decisions.escalateDocs: "${entry}" matches no tracked path, so it may escalate nothing; check its spelling and case`);
}

// What a decision on record can be. Only the Human moves it off "unconfirmed"; no time limit does.
export const DECISION_STATUSES = ['unconfirmed', 'confirmed', 'rejected'];

const MARKER_FIELDS = ['id', 'status', 'class', 'domain', 'date', 'pr'];
// Long enough for a slug, and short enough that the longest marker stays on one screen, at the default `docs.wrapLimit`.
const ID_MAX = 32;
// A comment that means to be a marker, whatever else is wrong with it.
const MENTION = /<!--\s*aidrian:decision(-old)?(?=\s|-->|$)/u;
const MARKER_LINE = /^<!--\s+aidrian:decision\s+(.*?)\s*-->$/u;
const OLD_LINE = /^<!--\s+aidrian:decision-old\s+id=(\S+)\s+text=("(?:[^"\\]|\\.)*")\s+-->$/u;
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gu;
const OWN_LINE = 'a decision marker is one HTML comment alone on its line';
const COMMENT_LINE = /^\s*<!--\s*aidrian:decision(?:-old)?\s.*-->\s*$/u;

// Whether a line is one whole decision comment. Wrapping one would break it, so the wrap check never reports it.
export const isDecisionLine = (line) => COMMENT_LINE.test(line);

// Every decision marker of one doc's text, and what is wrong with the rest: { decisions, problems }, where a decision
// is { id, status, class, domain, date, pr, line, hasOldWording, oldWording } and a problem { line, problem }, both by
// 1-based line. `pr` is a number, or null for `pr=none`. A marker quoted in a code fence or code span is no decision.
// A malformed marker is a problem, never a throw. A marker out of place is a problem too, and still a decision.
// `oldWording` joins the `decision-old` lines directly under the marker.
// When one cannot be read, `hasOldWording` is still true and `oldWording` null: the decision replaced a rule, so an undo
// must not read it as one that filled a gap.
export function parseDecisions(text) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedIn(lines);
  const decisions = [];
  const problems = [];
  // The decision whose marker and old wording end at the line `through`, 0-based.
  let open = null;
  lines.forEach((raw, i) => {
    const mention = fenced[i] ? null : MENTION.exec(raw.replace(CODE_SPAN, ''));
    if (!mention) return;
    const line = i + 1;
    if (!mention[1]) {
      const { problem, decision } = readMarker(raw.trim());
      if (problem) problems.push({ line, problem });
      else decisions.push({ ...decision, line });
      const away = problem ? null : misplaced(lines, fenced, i);
      if (away) problems.push({ line, problem: `"${decision.id}" sits ${away}` });
      open = problem ? null : { decision: decisions.at(-1), through: i, broken: false };
      return;
    }
    if (open?.through !== i - 1) {
      problems.push({ line, problem: 'old wording with no decision marker directly above it' });
      return;
    }
    const { problem, wording } = readOldWording(raw.trim(), open.decision.id);
    open.through = i;
    open.decision.hasOldWording = true;
    if (problem) {
      problems.push({ line, problem });
      open.broken = true;
      open.decision.oldWording = null;
    } else if (!open.broken) {
      open.decision.oldWording = (open.decision.oldWording ?? '') + wording;
    }
  });
  return { decisions, problems };
}

// What is wrong with where the marker on the 0-based line `i` sits, or null. It goes directly below the rule's last line,
// the one place undo looks for that rule; a table row's marker goes directly below the table, since a comment breaks a table.
function misplaced(lines, fenced, i) {
  const below = lines.slice(i + 1).find((line) => !isDecisionLine(line));
  const rule = "a marker goes directly below the rule's last line";
  if (i === 0) return `under nothing: ${rule}`;
  const above = lines[i - 1];
  if (above.trim() === '') return `under a blank line: ${rule}`;
  if (fenced[i - 1]) return `under a code fence: ${rule}`;
  if (/^ {0,3}#{1,6}(?:\s|$)/u.test(above)) return `under a heading: ${rule}`;
  if (isDecisionLine(above)) return `under another decision line: ${rule}`;
  if (above.trimStart().startsWith('|') && below?.trimStart().startsWith('|')) return 'inside a table: it goes directly below the table, with the row named in the old wording';
  return null;
}

// One marker line as { decision } or { problem }.
function readMarker(line) {
  const found = MARKER_LINE.exec(line);
  if (!found) return { problem: `${OWN_LINE}: <!-- aidrian:decision ${MARKER_FIELDS.map((key) => `${key}=...`).join(' ')} -->` };
  const fields = new Map();
  for (const word of found[1].split(/\s+/u).filter(Boolean)) {
    const at = word.indexOf('=');
    if (at === -1) return { problem: `${JSON.stringify(word)} has no value in a decision marker` };
    const key = word.slice(0, at);
    if (!MARKER_FIELDS.includes(key)) return { problem: `unknown field ${JSON.stringify(key)} in a decision marker` };
    if (fields.has(key)) return { problem: `${key} is given twice in a decision marker` };
    fields.set(key, word.slice(at + 1));
  }
  const missing = MARKER_FIELDS.filter((key) => !fields.has(key));
  if (missing.length) return { problem: `a decision marker is missing ${missing.join(', ')}` };
  const [id, status, kind, domain, date, pr] = MARKER_FIELDS.map((key) => fields.get(key));
  const quoted = (key, value) => `${key} ${JSON.stringify(value)}`;
  const entry = loadVocab().classes.find((each) => each.class === kind);
  const problem = !/^[a-z0-9][a-z0-9-]*$/u.test(id) ? `${quoted('id', id)} takes lowercase letters, digits, and "-"`
    : id.length > ID_MAX ? `${quoted('id', id)} takes at most ${ID_MAX} characters`
      : !DECISION_STATUSES.includes(status) ? `${quoted('status', status)} is not one of ${DECISION_STATUSES.join(', ')}`
        : !entry ? `${quoted('class', kind)} is no class of decisions.json`
          : entry.floor ? `${quoted('class', kind)} is a floor class: it always goes to the Human, so no agent decided it alone`
            : !DECISION_DOMAINS.includes(domain) ? `${quoted('domain', domain)} is not one of ${DECISION_DOMAINS.join(', ')}`
              : !isDate(date) ? `${quoted('date', date)} is not a real YYYY-MM-DD date`
                : !/^(?:[1-9]\d*|none)$/u.test(pr) ? `${quoted('pr', pr)} takes a pull request number, or none`
                  : null;
  if (problem) return { problem };
  return { decision: { id, status, class: kind, domain, date, pr: pr === 'none' ? null : Number(pr), hasOldWording: false, oldWording: null } };
}

const isDate = (text) => /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString().startsWith(text);

// One `decision-old` line under the marker of `id`, as { wording } or { problem }. `text` is a JSON string, so it holds a
// line break or a quote on one line; a raw `-->` would end the comment early, and a reader would see the rest.
function readOldWording(line, id) {
  const found = OLD_LINE.exec(line);
  if (!found) return { problem: 'old wording is one HTML comment alone on its line: <!-- aidrian:decision-old id=<id> text="<JSON string>" -->' };
  if (found[1] !== id) return { problem: `old wording with id ${JSON.stringify(found[1])} sits under the marker of ${JSON.stringify(id)}` };
  if (found[2].includes('-->')) return { problem: 'old wording holds "-->", which ends the comment: write it as -\\u002d>' };
  try {
    const wording = JSON.parse(found[2]);
    return wording === '' ? { problem: 'old wording is empty; a decision that fills a gap has no such line' } : { wording };
  } catch {
    return { problem: 'old wording: text is not a JSON string' };
  }
}

// `text` with `status` on the one marker of `id`, and every other byte as it was: { text, from, line }, or null when
// the doc does not hold exactly one such marker. A line ending stays with its line, since only `\n` splits.
export function setDecisionStatus(text, id, status) {
  const found = parseDecisions(text).decisions.filter((each) => each.id === id);
  if (found.length !== 1) return null;
  const [{ line, status: from }] = found;
  const lines = text.split('\n');
  lines[line - 1] = lines[line - 1].replace(/(\sstatus=)[a-z]+/u, `$1${status}`);
  return { text: lines.join('\n'), from, line };
}

// Whole days since a marker's `date`; a date ahead of the clock is zero.
export const ageDays = (date, now = new Date()) => Math.max(0, Math.floor((now - Date.parse(date)) / 86_400_000));
