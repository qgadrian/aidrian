// Who settles a product or design decision a session meets: the agent ("decide") or the Human ("ask").
// decisions.json is the only place the built-in decision classes and the reversibility questions live; config.json
// `decisions.classes` adds a project's classes, and `decisions` sets how far a project lets agents go (docs/config.md#decisions). resolveAuthority walks a fixed order and the first
// rule that matches wins, so no prompt weighs these by hand.
// A decision an agent made alone stays on record as a marker line in the doc that governs it (parseDecisions,
// docs/project-folder.md#decision-markers); decisions-cli.mjs scans the docs for them.
// config.mjs reads this file from every hook, so of the plugin's files it imports only markdown-sections.mjs, which imports nothing.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fencedIn, slug } from './markdown-sections.mjs';

export const VOCAB_PATH = path.join(import.meta.dirname, 'decisions.json');

// The authority modes, lowest first: "ask" leaves every decision to the Human; "decide-reversible" lets an agent
// settle one that every reversibility question answers no to, or yes where the team accepted it (ACCEPTED_QUESTION).
export const DECISION_MODES = ['ask', 'decide-reversible'];

// The domains config.json `decisions.domains` sets one by one.
export const DECISION_DOMAINS = ['product', 'ux', 'architecture', 'backlog'];

let vocab;
// decisions.json, read once.
export const loadVocab = () => (vocab ??= JSON.parse(readFileSync(VOCAB_PATH, 'utf8')));

// What config.json `decisions.unattended.safeDefaults` may be: what an unattended run may settle with a safe default.
export const SAFE_DEFAULTS = ['outside-escalated', 'all'];

// The longest class a project adds: with the longest id, domain, and pull request, its marker just fits the default
// `docs.wrapLimit`, as the test measures.
export const CLASS_MAX = 23;

// Whether `name` can be a class a project adds: it goes in a marker's `class=` field, so it is one short word.
export const isClassName = (name) => /^[a-z0-9][a-z0-9-]*$/u.test(name) && name.length <= CLASS_MAX;

// The entry of `kind`: a built-in of decisions.json, which no project can change, else a class of `classes`, config.json
// `decisions.classes`, which is never a floor class.
function classEntry(kind, classes, table = loadVocab()) {
  const entry = table.classes.find((each) => each.class === kind);
  if (entry || !classes || !Object.hasOwn(classes, kind)) return entry;
  return { class: kind, floor: false, definition: classes[kind] };
}

// The domain a built-in class of decisions.json is always judged in, whatever the caller's `--domain`, or null when it follows its owner.
export const classDomain = (kind) => loadVocab().classes.find((entry) => entry.class === kind)?.domain ?? null;

// Every built-in class name, floor classes first, as decisions.json lists them.
export const decisionClasses = (table = loadVocab()) => table.classes.map((entry) => entry.class);

// The lower of two modes; a mode outside DECISION_MODES counts as "ask".
export const lowerMode = (a, b) => DECISION_MODES[Math.min(Math.max(DECISION_MODES.indexOf(a), 0), Math.max(DECISION_MODES.indexOf(b), 0))];

// The reversibility question whose yes a team can accept: the one about reaching users with no person looking. A team that
// allows auto-merge and runs at decide-reversible has accepted that, so a yes there does not ask.
const ACCEPTED_QUESTION = 'reachesUsersUnreviewed';

// The decision on one question. `config` is a loaded config, or its `decisions` block; its `github.autoMerge.allow` counts
// only as the caller passes it, so `aidrian decisions resolve` passes the base branch's. The question:
// - `domain`: one of DECISION_DOMAINS; `class`: a class of decisions.json, or of the block's `classes`;
// - `reversible`: { storedData, external, pricingOrContract, reachesUsersUnreviewed }, each true (yes) or false (no);
//   an answer that is missing, or anything but false, asks, but for a yes on ACCEPTED_QUESTION that the team accepted;
// - `docs`: the doc paths the decision touches, from the project root, each with an optional `#section`, matched
//   against `escalateDocs`; one outside the project asks;
// - `pending`: the unreviewed decisions so far, as [{ domain, date, doc? }], for the domain pause.
// Returns { authority: "decide" | "ask", rule, reason }: `rule` names the rule that matched, `reason` says why.
export function resolveAuthority(config, { domain, class: kind, reversible, docs = [], pending = [] } = {}, { now = new Date(), table = loadVocab() } = {}) {
  const block = config.decisions ?? config;
  const ask = (rule, reason) => ({ authority: 'ask', rule, reason });
  const entry = classEntry(kind, block.classes, table);
  if (!entry) return ask('unknown-class', `${JSON.stringify(kind ?? null)} is no class of decisions.json or decisions.classes, so it goes to the Human`);
  if (entry.floor) return ask('floor-class', `${kind} is a floor class: it always goes to the Human`);
  if (block.escalate.includes(kind)) return ask('escalate', `config.json decisions.escalate lists ${kind}`);
  const away = docs.find((each) => outsideProject(docParts(each)));
  if (away !== undefined) return ask('doc-outside-project', `${away} is outside the project, so no rule of the project covers it`);
  const doc = docs.find((each) => block.escalateDocs.some((listed) => docMatches(listed, each)));
  if (doc !== undefined) return ask('escalate-doc', `config.json decisions.escalateDocs covers ${doc}`);
  const own = block.domains[domain];
  const [mode, rule] = own === 'inherit' ? [block.mode, 'mode'] : [own, `domains.${domain}`];
  const effective = lowerMode(mode, block.maxMode);
  const accepts = config.github?.autoMerge?.allow === true && effective === 'decide-reversible';
  let accepted = false;
  for (const key of Object.keys(table.reversibility)) {
    const answer = reversible?.[key];
    if (key === ACCEPTED_QUESTION && answer === true && accepts) {
      accepted = true;
      continue;
    }
    if (answer !== false) return ask('reversibility', `${key} is ${answer === true ? 'yes' : 'unanswered'}: ${table.reversibility[key]}`);
  }
  if (!DECISION_DOMAINS.includes(domain)) return ask('unknown-domain', `${JSON.stringify(domain ?? null)} is not one of ${DECISION_DOMAINS.join(', ')}`);
  const domainPending = pending.filter((each) => (classDomain(each?.class) ?? each?.domain) === domain);
  const paused = pauseReason(block.unreviewed.pauseDomainAt, domainPending, now);
  if (paused) return ask('domain-paused', `${domain} is paused: ${paused}${docsClause(domainPending)}`);
  if (effective !== mode) return ask('maxMode', `${rule} is ${mode}, above decisions.maxMode ${block.maxMode}`);
  if (accepted) return { authority: 'decide', rule, reason: `${rule} is decide-reversible, every other reversibility answer is no, and ${ACCEPTED_QUESTION} is yes, which github.autoMerge.allow accepts at the base branch` };
  if (effective === 'decide-reversible') return { authority: 'decide', rule, reason: `${rule} is decide-reversible and every reversibility answer is no` };
  return ask(rule, `${rule} is ask`);
}

// What an unattended run does with a question resolveAuthority answered `ask`: "park" it, or "safe-default", take a safe
// default that can be undone. `block` is the `decisions` block in force. What the project listed always parks, so this asks
// the lists itself: the rule that matched first may hide them, as a floor class or a doc outside the project does.
// A `safeDefaults` outside SAFE_DEFAULTS is a block no one could read (committedDecisions), so it parks too.
export function unattendedAnswer(block, { class: kind, docs = [] } = {}, { table = loadVocab() } = {}) {
  const { safeDefaults } = block.unattended;
  const listed = block.escalate.includes(kind) || docs.some((doc) => block.escalateDocs.some((entry) => docMatches(entry, doc)));
  if (listed || !SAFE_DEFAULTS.includes(safeDefaults)) return 'park';
  if (safeDefaults === 'all') return 'safe-default';
  const entry = classEntry(kind, block.classes, table);
  return entry && !entry.floor ? 'safe-default' : 'park';
}

// Where the markers of a pause are, so the Human can reach them; nothing when `pending` names no doc.
function docsClause(pending) {
  const docs = [...new Set(pending.map((each) => each.doc).filter(Boolean))];
  return docs.length ? `; the markers are in ${docs.join(', ')}` : '';
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
// A comment that means to be a marker or a line of its wording, whatever else is wrong with it.
const MENTION = /<!--\s*aidrian:decision(?:-(old|new))?(?=\s|-->|$)/u;
const MARKER_LINE = /^<!--\s+aidrian:decision\s+(.*?)\s*-->$/u;
const WORDING_LINE = /^<!--\s+aidrian:decision-(old|new)\s+id=(\S+)\s+text=("(?:[^"\\]|\\.)*")\s+-->$/u;
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/u;
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gu;
const OWN_LINE = 'a decision marker is one HTML comment alone on its line';
const COMMENT_LINE = /^\s*<!--\s*aidrian:decision(?:-old|-new)?\s.*-->\s*$/u;

// Whether a line is one whole decision comment. Wrapping one would break it, so the wrap check never reports it.
export const isDecisionLine = (line) => COMMENT_LINE.test(line);

// What a line means to be, by the words of its comment outside code spans: the MENTION match, or null. It says nothing on
// whether the line is well formed, or fenced.
const mentionIn = (line) => MENTION.exec(line.replace(CODE_SPAN, ''));

// Every decision marker of one doc's text, and what is wrong with the rest: { decisions, problems, unlisted }, where a decision
// is { id, status, class, domain, date, pr, line, through, hasOldWording, oldWording, hasNewWording, newWording } and a
// problem { line, problem }, both by 1-based line, with `through` the decision's last line. `pr` is a number, or null for
// `pr=none`. A marker quoted in a code fence or code span is no decision. A malformed marker is a problem, never a throw.
// A marker out of place is a problem too, and still a decision. `classes` is config.json `decisions.classes`, whose
// names a marker may hold too. `unlisted` holds each marker whose only problem is a class in neither list, shaped as a
// decision: it is still a decision on record, so a commit that removes a class cannot lift the domain pause.
// `oldWording` joins the `decision-old` lines directly under the marker, and `newWording` the `decision-new` lines below
// those. When one cannot be read, its `has...` is still true and the wording null: a decision whose old wording is
// unreadable replaced a rule, so an undo must not read it as one that filled a gap.
export function parseDecisions(text, { classes } = {}) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedIn(lines);
  const decisions = [];
  const problems = [];
  const unlisted = [];
  // The decision whose marker and wording run down to the line before this one.
  let open = null;
  const close = () => {
    if (open && !open.decision.hasNewWording) problems.push({ line: open.decision.line, problem: `"${open.decision.id}" records no wording it wrote: add a decision-new line` });
    open = null;
  };
  lines.forEach((raw, i) => {
    const mention = fenced[i] ? null : mentionIn(raw);
    const kind = mention?.[1];
    if (open && !(kind && open.decision.through === i)) close();
    if (!mention) return;
    const line = i + 1;
    if (!kind) {
      const { problem, decision, unlisted: outOfList } = readMarker(raw.trim(), classes);
      if (problem) {
        problems.push({ line, problem });
        if (outOfList) unlisted.push({ ...outOfList, line, through: line });
        return;
      }
      decisions.push({ ...decision, line, through: line });
      const away = misplaced(lines, fenced, i);
      if (away) problems.push({ line, problem: `"${decision.id}" sits ${away}` });
      open = { decision: decisions.at(-1), broken: new Set() };
      return;
    }
    if (!open) {
      problems.push({ line, problem: `${kind} wording with no decision marker directly above it` });
      return;
    }
    const { decision, broken } = open;
    decision.through = line;
    const [has, words] = kind === 'old' ? ['hasOldWording', 'oldWording'] : ['hasNewWording', 'newWording'];
    decision[has] = true;
    const { problem, wording } = kind === 'old' && decision.hasNewWording
      ? { problem: 'old wording comes after the new wording: the old lines go first' }
      : readWording(raw.trim(), decision.id, kind);
    if (problem) {
      problems.push({ line, problem });
      broken.add(kind);
      decision[words] = null;
    } else if (!broken.has(kind)) {
      decision[words] = (decision[words] ?? '') + wording;
    }
  });
  close();
  return { decisions, problems: problems.sort((a, b) => a.line - b.line), unlisted };
}

// What is wrong with where the marker on the 0-based line `i` sits, or null. It goes directly below the rule's last line,
// or below the decision lines of a stack on that rule, the one place undo looks for that rule; a table row's marker goes
// directly below the table, since a comment breaks a table.
function misplaced(lines, fenced, i) {
  const rule = "a marker goes directly below the rule's last line";
  let at = i - 1;
  while (at >= 0 && !fenced[at] && isDecisionLine(lines[at])) at -= 1;
  if (at < 0) return `under nothing: ${rule}`;
  const above = lines[at];
  if (above.trim() === '') return `under a blank line: ${rule}`;
  if (fenced[at]) return null;
  if (HEADING_LINE.test(above)) return `under a heading: ${rule}`;
  const below = lines.slice(i + 1).find((line) => !isDecisionLine(line));
  if (above.trimStart().startsWith('|') && below?.trimStart().startsWith('|')) return 'inside a table: it goes directly below the table, with the row named in the wording';
  return null;
}

// One marker line as { decision } or { problem }, with `unlisted` the decision it would be when its only problem is its class.
function readMarker(line, classes) {
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
  const entry = classEntry(kind, classes);
  const wrong = [
    !/^[a-z0-9][a-z0-9-]*$/u.test(id) && `${quoted('id', id)} takes lowercase letters, digits, and "-"`,
    id.length > ID_MAX && `${quoted('id', id)} takes at most ${ID_MAX} characters`,
    !DECISION_STATUSES.includes(status) && `${quoted('status', status)} is not one of ${DECISION_STATUSES.join(', ')}`,
    !entry && `${quoted('class', kind)} is no class of decisions.json or config.json decisions.classes`,
    entry?.floor && `${quoted('class', kind)} is a floor class: it always goes to the Human, so no agent decided it alone`,
    !DECISION_DOMAINS.includes(domain) && `${quoted('domain', domain)} is not one of ${DECISION_DOMAINS.join(', ')}`,
    !isDate(date) && `${quoted('date', date)} is not a real YYYY-MM-DD date`,
    !/^(?:[1-9]\d*|none)$/u.test(pr) && `${quoted('pr', pr)} takes a pull request number, or none`,
  ].filter(Boolean);
  const decision = { id, status, class: kind, domain, date, pr: pr === 'none' ? null : Number(pr), hasOldWording: false, oldWording: null, hasNewWording: false, newWording: null };
  if (!wrong.length) return { decision };
  return { problem: wrong[0], ...(!entry && wrong.length === 1 ? { unlisted: decision } : {}) };
}

const isDate = (text) => /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString().startsWith(text);

// One wording line of `kind`, "old" or "new", under the marker of `id`, as { wording } or { problem }. `text` is a JSON
// string, so it holds a line break or a quote on one line; a raw `-->` would end the comment early, and a reader would
// see the rest.
function readWording(line, id, kind) {
  const found = WORDING_LINE.exec(line);
  if (!found || found[1] !== kind) return { problem: `${kind} wording is one HTML comment alone on its line: <!-- aidrian:decision-${kind} id=<id> text="<JSON string>" -->` };
  if (found[2] !== id) return { problem: `${kind} wording with id ${JSON.stringify(found[2])} sits under the marker of ${JSON.stringify(id)}` };
  if (found[3].includes('-->')) return { problem: `${kind} wording holds "-->", which ends the comment: write it as -\\u002d>` };
  try {
    const wording = JSON.parse(found[3]);
    if (wording !== '') return { wording };
    return { problem: `${kind} wording is empty; ${kind === 'old' ? 'a decision that fills a gap has no such line' : 'it holds the lines the decision wrote'}` };
  } catch {
    return { problem: `${kind} wording: text is not a JSON string` };
  }
}

// `text` with `status` on the one marker of `id`, and every other byte as it was: { text, from, line }, or null when
// the doc does not hold exactly one such marker. A line ending stays with its line, since only `\n` splits.
export function setDecisionStatus(text, id, status, { classes } = {}) {
  const found = parseDecisions(text, { classes }).decisions.filter((each) => each.id === id);
  if (found.length !== 1) return null;
  const [{ line, status: from }] = found;
  const lines = text.split('\n');
  lines[line - 1] = lines[line - 1].replace(/(\sstatus=)[a-z]+/u, `$1${status}`);
  return { text: lines.join('\n'), from, line };
}

// The rule a marker on the 0-based line `i` sits under, as the 0-based range { from, to }, `to` exclusive: from the line
// above it, past the decision lines of its stack, up to a blank line outside a fence, a heading, another decision line,
// or the doc's start. Fenced lines are content, whatever they look like. It never says which lines are the rule:
// findWording matches the recorded text inside it.
export function blockAbove(lines, fenced, i) {
  const isDecision = (at) => !fenced[at] && isDecisionLine(lines[at]);
  let to = i;
  while (to > 0 && isDecision(to - 1)) to -= 1;
  let from = to;
  while (from > 0 && (fenced[from - 1] || !(lines[from - 1].trim() === '' || HEADING_LINE.test(lines[from - 1]) || isDecision(from - 1)))) from -= 1;
  return { from, to };
}

const wordingLines = (wording) => wording.split('\n').map((line) => line.trimEnd());

// Whether `below`, a marker directly under the marker `above`, has as its old wording the wording `above` wrote.
const chained = (above, below) => above.newWording !== null && below.oldWording !== null && wordingLines(above.newWording).join('\n') === wordingLines(below.oldWording).join('\n');

// Each 0-based line of `block` where `wording` starts, comparing lines with trailing whitespace trimmed and nothing else.
export function findWording(lines, { from, to }, wording) {
  const wanted = wordingLines(wording);
  const found = [];
  for (let at = from; at + wanted.length <= to; at += 1) {
    if (wanted.every((line, k) => lines[at + k].trimEnd() === line)) found.push(at);
  }
  return found;
}

// The markers directly above and below `decision`, each record's lines touching the next, it included, in doc order.
function stackAround(decisions, decision) {
  let first = decisions.indexOf(decision);
  let last = first;
  while (first > 0 && decisions[first - 1].through + 1 === decisions[first].line) first -= 1;
  while (last + 1 < decisions.length && decisions[last].through + 1 === decisions[last + 1].line) last += 1;
  return decisions.slice(first, last + 1);
}

// Whether `stack` holds independent records, as decisions on different rows of one table do, and not a broken chain. A
// marker continues the chain of the one above it when `chained` says so. Independent means two chains or more, whose last
// markers' new wordings each stand exactly once in the block, on lines no other takes, with every line of the stack
// readable and no decision line it cannot read beside it. Its first and last lines bound what `problems` may name.
function independentRecords(stack, lines, fenced, problems) {
  const [first] = stack;
  const last = stack.at(-1);
  const isDecision = (at) => at >= 0 && at < lines.length && !fenced[at] && Boolean(mentionIn(lines[at]));
  if (isDecision(first.line - 2) || isDecision(last.through)) return false;
  if (problems.some(({ line }) => line >= first.line && line <= last.through)) return false;
  if (stack.some(({ newWording, hasOldWording, oldWording }) => newWording === null || (hasOldWording && oldWording === null))) return false;
  const tips = stack.filter((each, i) => !(stack[i + 1] && chained(each, stack[i + 1])));
  if (tips.length < 2) return false;
  const block = blockAbove(lines, fenced, first.line - 1);
  const taken = new Set();
  for (const { newWording } of tips) {
    const starts = findWording(lines, block, newWording);
    if (starts.length !== 1) return false;
    for (let k = 0; k < wordingLines(newWording).length; k += 1) {
      if (taken.has(starts[0] + k)) return false;
      taken.add(starts[0] + k);
    }
  }
  return true;
}

// What is wrong between the wording a doc's markers recorded and the doc: { line, problem } for each unconfirmed marker at
// the bottom of its stack whose new wording is not in its block exactly once, and for each stack that is not independent
// (independentRecords) where a marker's old wording is not the wording of the marker above it. Unreadable wording is
// parseDecisions' problem already.
export function wordingProblems(text, { decisions, problems: parsed = [] } = parseDecisions(text)) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedIn(lines);
  const problems = [];
  decisions.forEach((decision, index) => {
    const next = decisions[index + 1];
    if (next?.line === decision.through + 1) {
      const unreadable = decision.newWording === null && decision.hasNewWording || next.oldWording === null && next.hasOldWording;
      if (!unreadable && !chained(decision, next) && !independentRecords(stackAround(decisions, decision), lines, fenced, parsed)) problems.push({ line: next.line, problem: `"${next.id}" sits below "${decision.id}", but its old wording is not the wording "${decision.id}" wrote` });
      return;
    }
    if (decision.status !== 'unconfirmed' || decision.newWording === null) return;
    const count = findWording(lines, blockAbove(lines, fenced, decision.line - 1), decision.newWording).length;
    if (count !== 1) problems.push({ line: decision.line, problem: `"${decision.id}" wrote wording found ${count} times in the block above it, and undo needs it exactly once: put it back, or fix the decision-new line` });
  });
  return problems;
}

// The lines of the block above the marker of `decision`, for a person to compare with its wording.
export function blockOf(text, { line }) {
  const lines = String(text).split(/\r?\n/u);
  const { from, to } = blockAbove(lines, fencedIn(lines), line - 1);
  return lines.slice(from, to);
}

// What can still be read of a marker that did not parse, on the 1-based `line`: { wording, block }, with `wording` the raw
// wording lines from there down, the named line first when it is one, and `block` as blockOf gives it.
export function recordAt(text, line) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedIn(lines);
  const isWording = (at) => at < lines.length && !fenced[at] && Boolean(mentionIn(lines[at])?.[1]);
  const wording = [];
  for (let at = isWording(line - 1) ? line - 1 : line; isWording(at); at += 1) wording.push(lines[at].trim());
  return { wording, block: blockOf(text, { line }) };
}

// `text` with the decision of `id` taken back: its new wording replaced by its old wording, or deleted when it has none,
// and its lines removed, every other byte as it was. Returns { text, line, wrote, restored }, with `line` the first line
// that changed and `wrote` and `restored` as lines, or, when it cannot be done safely, { refused, decision, block }, with
// `decision` null when no marker of `id` reads. Only `\n` splits, so a line ending stays with its line. Status is no gate.
// A marker with another below it goes back only when the two do not chain and the stack is independent (independentRecords).
export function undoDecision(text, id, { classes } = {}) {
  const source = String(text);
  const raw = source.split('\n');
  const lines = source.split(/\r?\n/u);
  const fenced = fencedIn(lines);
  const { decisions, problems } = parseDecisions(source, { classes });
  const found = decisions.filter((each) => each.id === id);
  if (found.length === 0) {
    const named = problems.find(({ line }) => lines[line - 1].trim().split(/\s+/u).includes(`id=${id}`));
    return { refused: named ? named.problem : `no decision marker with id "${id}"`, decision: null, block: [] };
  }
  const refuse = (refused, decision = found[0]) => ({ refused, decision, block: blockOf(source, decision) });
  if (found.length > 1) return refuse(`id "${id}" is on ${found.length} markers: lines ${found.map(({ line }) => line).join(', ')}`);
  const [decision] = found;
  const { line, through, oldWording, newWording } = decision;
  const parseProblem = problems.find((each) => each.line >= line && each.line <= through);
  if (parseProblem) return refuse(parseProblem.problem);
  const independent = independentRecords(stackAround(decisions, decision), lines, fenced, problems);
  if (!fenced[through] && mentionIn(lines[through] ?? '')) {
    const later = decisions.find((each) => each.line === through + 1);
    if (!later) return refuse('a later decision line it cannot read sits below this one; fix that line first');
    if (chained(decision, later) || !independent) return refuse(`a later decision ${later.id} replaced this wording; undo that one first`);
  }
  if (line > 1 && !fenced[line - 2] && mentionIn(lines[line - 2])) {
    const above = decisions.find((each) => each.through + 1 === line);
    if (!above || above.newWording === null) return refuse('the decision line above it has no wording it can read, so undo would not put that rule back; fix that line first');
    if (!chained(above, decision) && !independent) return refuse(`its old wording is not the wording "${above.id}" wrote, so undo would not put that rule back; fix the decision-old line first`);
  }
  const block = blockAbove(lines, fenced, line - 1);
  const starts = findWording(lines, block, newWording);
  if (starts.length === 0) return refuse('its new wording is not found in the block above it');
  if (starts.length > 1) return refuse(`its new wording is found ${starts.length} times in the block above it`);
  const [start] = starts;
  const wrote = newWording.split('\n').length;
  const ending = raw[start].endsWith('\r') ? '\r' : '';
  const restored = oldWording === null ? [] : oldWording.split('\n').map((each) => each.replace(/\r$/u, ''));
  const out = [...raw];
  // Below the wording first, so `start` still counts from the top.
  out.splice(line - 1, through - line + 1);
  out.splice(start, wrote, ...restored.map((each) => each + ending));
  if (!restored.length) closeGap(out, start);
  // The marker was the doc's last line, with no line ending: what is now last has none either.
  if (through === raw.length && out.length) out[out.length - 1] = out.at(-1).replace(/\r$/u, '');
  return { text: out.join('\n'), line: start + 1, wrote: lines.slice(start, start + wrote), restored };
}

// One blank line where a removal at `at` left two.
function closeGap(lines, at) {
  if (at > 0 && at < lines.length && lines[at - 1].trim() === '' && lines[at].trim() === '') lines.splice(at, 1);
}

// Whole days since a marker's `date`; a date ahead of the clock is zero.
export const ageDays = (date, now = new Date()) => Math.max(0, Math.floor((now - Date.parse(date)) / 86_400_000));
