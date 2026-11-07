// Persona audits in the state folder (`<state>/audits/`): each report `<name>.md`, the JSON sidecar `<name>.json` the
// persona-audit skill writes beside it, and `triage.json`, where the persona-audit-triage skill records one decision per
// item. An item is a finding (`F1`), a Not reached line (`N1`), or a doc gap (`D1`) of a report, or a finding of the
// report it replaces that the new run did not re-check (`not_rechecked`). A report is fully triaged when every item has
// a decision. docs/personas.md#triage describes the whole loop; audits-cli.mjs is the `aidrian audits` command, and
// audit-import.mjs reads a report that has no sidecar.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseReport } from './audit-import.mjs';
import { isFile, isObject } from './fs.mjs';
import { withLocks } from './jsonl.mjs';

export const SIDECAR_VERSION = 1;
export const SEVERITIES = ['blocker', 'friction', 'polish'];
export const LABELS = ['observed', 'opinion'];
export const LEVELS = ['walked', 'seen', 'read'];
// issue: filed in the tracker. fix-now: routed to its owner. duplicate: an issue already covers it. drop: not worth
// it, with a reason. defer: decided later, on purpose. covered: a Not reached line that restates the replaced run's
// findings this run did not re-check, which carry the decision themselves, with a reason. documented: the product works
// as a doc says, with the doc's `path#section`. decided: a product decision taken, with who took it, before an issue
// can exist; the one decision that is not final, so the item stays untriaged until it reaches one of the others.
export const DECISIONS = ['issue', 'fix-now', 'duplicate', 'drop', 'defer', 'covered', 'documented', 'decided'];
export const FINAL = DECISIONS.filter((decision) => decision !== 'decided');
// A triage priority, apart from the audit's severity, which is never rewritten: a reviewer re-ranks a finding with it.
// The words of the trackers' own priority fields.
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
// A doc reference: a project file, then a section, as a slug or as the heading is written.
const DOC = /^[^#\s][^#]*?\.[A-Za-z0-9]+#\s*\S.*$/u;
export const DOC_FORMS = 'a file of the project, then # and its section, as the heading is written ("docs/rules.md#Known gaps / Do not infer") or as its slug ("docs/rules.md#known-gaps--do-not-infer")';
// A heading's anchor, as GitHub writes it: lower case, punctuation dropped, each space a hyphen.
export const slugOf = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');

// Who made a pick: the Human, or the agent whose recommendation the Human adopted, by its role.
const BY = /^(?:human|[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
// A rule verdict is evidence, not a decision: an item's state does not change with one. breaks: the product breaks the
// rule. conforms: it follows the rule, so changing it is a product decision. silent: the docs do not settle it, also a
// product decision. Kept in the item's entry as `verdict`, through later decisions. docs/personas.md#rule-verdicts.
export const VERDICTS = ['breaks', 'conforms', 'silent'];
const CITATION = /[^\s"'`()]+\.[A-Za-z0-9]+#[^\s"'`()]+/u;
// The doc a verdict cites, `path#section`, or null. `breaks` and `conforms` quote a rule; `silent` has none to quote.
export const verdictCitation = ({ value, reason }) => (value !== 'silent' ? CITATION.exec(reason ?? '')?.[0] ?? null : null);
// Why a verdict cannot be recorded, or null.
export function verdictProblem({ value, by, reason }) {
  if (!VERDICTS.includes(value)) return `verdict must be ${VERDICTS.join(', ')}`;
  if (!by || by === 'human' || !BY.test(by)) return 'a verdict needs --by, the role of the agent that gave it, such as product-manager; the Human decides, with `record ... decided --by human`';
  if (!reason?.trim()) return `a ${value} verdict needs --reason: ${value === 'silent' ? 'what was searched' : 'the rule quoted, and its path#section'}`;
  if (value !== 'silent' && !verdictCitation({ value, reason })) return `a ${value} verdict quotes the rule in --reason and cites it as path#section, the section as its slug`;
  return null;
}
// The verdict that holds an item back: conforms or silent, with no `decided --by human` since (recordDecision).
export const held = (entry) => (['conforms', 'silent'].includes(entry?.verdict?.value) && !entry.verdict.settled ? entry.verdict.value : null);
// The decisions an item can take now, the one rule `pending` prints and `record` enforces. A held item takes the
// Human's product decision first, and no issue or fix before it; docs that are silent cannot make it `documented`.
// `covered` is only for a line that restates the findings not re-checked.
export function allowedDecisions(item) {
  const verdict = held(item.decision);
  return DECISIONS.filter((decision) => {
    if (decision === 'covered') return item.covered_by === 'not_rechecked';
    if (verdict && (decision === 'issue' || decision === 'fix-now')) return false;
    return !(verdict === 'silent' && decision === 'documented');
  });
}

// Whether an item still waits for a final outcome: no entry, a priority alone, or a decision that is not final.
export const untriaged = (item) => !FINAL.includes(item.decision?.decision);
export const TRIAGE_FILE = 'triage.json';

// The plugin's agents a finding names as its owner, in the words the Human reads. A project agent has no entry, and
// its finding carries its own `owner_description`.
export const OWNER_WORDS = {
  'ux-specialist': 'how the product flows and what its words say',
  designer: 'how the screens look',
  'frontend-developer': 'the screens and their code',
  'backend-developer': 'the server and the answers it gives',
  'product-manager': 'what the product should do, and its rules',
  'doc-updater': 'the docs',
  'harness-librarian': "the project's knowledge docs",
};

// A key a sidecar sorts: a finding of the report it replaces, or, for one that report still carried from an earlier
// run, `<that run's file>#<key>`.
const SORTED_KEY = /^(?:[^#\s,]+\.md#)?F[1-9]\d*$/u;
const ID = { findings: /^F[1-9]\d*$/u, not_reached: /^N[1-9]\d*$/u, doc_gaps: /^D[1-9]\d*$/u };
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A report file name: `<personas>-<YYYY-MM-DD>.md`, with `-2`, `-3` for a second and third run that day.
const REPORT = /^(.+)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/u;
// A pull request run's keys: the pull request, as `<owner/name>#<n>`, and its head at the walk's start.
const SIDECAR_PR = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#[1-9]\d*$/u;
const SIDECAR_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const pullRequestProblem = (value) => {
  const [, owner, name] = (typeof value === 'string' && SIDECAR_PR.exec(value)) || [];
  return owner && name && ![owner, name].some((part) => part === '.' || part === '..') ? null : 'must be <owner/name>#<number>, the repo and number aidrian pr resolve prints';
};
// Why a run, `pr` of a sidecar or undefined, may not replace `older`, or null. A run with a `pr` replaces only a report
// of the same pull request. A report naming a pull request can be replaced only by a run of it, or by a whole-product
// run with a valid sidecar (`validSidecar`), so a run with no sidecar, or a `pr` that is no string, never replaces it.
// Whole-product runs and the reports that name no pull request replace each other as they always did.
function replacementRefusal(pr, older, { validSidecar }) {
  if (!older) return null;
  const words = reportTitle(older.report, older.findings);
  if (older.pr !== undefined && pr !== undefined && typeof pr !== 'string') return `names ${words}, of pull request ${older.pr}, and a run with no readable pull request never replaces it`;
  if (typeof pr === 'string') {
    if (older.pr === undefined) return `names ${words}, which names no pull request, and this run is of ${pr}: a pull request run replaces only a report of the same pull request`;
    if (typeof older.pr !== 'string' || pr.toLowerCase() !== older.pr.toLowerCase()) return `names ${words}, of pull request ${older.pr}, and this run is of ${pr}: a run never replaces another pull request's report`;
    return null;
  }
  return older.pr !== undefined && !validSidecar ? `names ${words}, of pull request ${older.pr}: only a run of it, or a whole-product run with a valid sidecar, replaces it` : null;
}
// A backticked span that names a screenshot by its suffix alone, such as `-24.jpg`: the reader cannot open it.
const SHORTHAND = /`(-[^`/\s]*\.(?:png|jpe?g|gif|webp))`/giu;

// A report as a person reads it: its personas, its kind, and its date, such as "the front-desk walk on 2026-05-02" or
// "the front-desk read-only run on 2026-05-02". Ids and file names are keys for the commands, never words for a person:
// docs/personas.md#triage. listAudits tells apart two reports this gives the same words (ordinals).
export function reportTitle(report, findings = []) {
  const match = REPORT.exec(report ?? '');
  if (!match) return 'a persona audit';
  const [, personas, date] = match;
  const who = personas === 'all' ? 'all-persona' : personas.split('+').join(' and ');
  const kind = !findings.length ? 'audit' : findings.some((finding) => finding.evidence_level === 'walked') ? 'walk' : 'read-only run';
  return `the ${who} ${kind} on ${date}`;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
// Gives each report its `title`, and the second and later of several with the same words an ordinal: "the second
// front-desk walk on 2026-05-02". `reports` are in run order.
function nameReports(reports) {
  const seen = new Map();
  for (const each of reports) {
    const plain = reportTitle(each.report, each.findings);
    const count = (seen.get(plain) ?? 0) + 1;
    seen.set(plain, count);
    each.title = count === 1 ? plain : plain.replace(/^the /u, `the ${ORDINALS[count - 1] ?? `number ${count}`} `);
  }
}

// How a person reads one item: a finding by its title, a Not reached line or a doc gap by its text.
export const itemWords = (item) => `"${item?.title ?? item?.text ?? 'an untitled item'}"`;

export const sidecarName = (report) => report.replace(/\.md$/u, '.json');
export const reportName = (value) => (value.endsWith('.md') ? value : `${value}.md`);
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

// The problems of a sidecar, as strings; empty when it is valid. With `dir`, the audits folder, every evidence path
// must also name a file there.
// Every problem names a finding by its title, never by its id: the reader is a person fixing the file. `replacedTitle`
// gives the title of a finding of the replaced report from its key, when the caller can read that report.
// `replaced`, when the caller can read the folder, is the report `supersedes` names, or null when no such report exists.
export function sidecarProblems(value, { dir = null, report = null, replacedTitle = () => null, replaced: older, reportNamed = () => null } = {}) {
  if (!isObject(value)) return ['the sidecar must be a JSON object'];
  const problems = [];
  const at = (where, problem) => problems.push(`${where}: ${problem}`);
  if (value.version !== SIDECAR_VERSION) at('version', `must be ${SIDECAR_VERSION}`);
  if (typeof value.report !== 'string' || !REPORT.test(value.report) || value.report.includes('/')) {
    at('report', 'must be the report file name, such as floor-manager-2026-11-03.md');
  } else if (report && value.report !== report) at('report', `names ${value.report}, but the sidecar belongs to ${report}`);
  if (!nonEmptyStrings(value.personas)) at('personas', 'must be a non-empty list of persona ids');
  if (typeof value.date !== 'string' || !DATE.test(value.date)) at('date', 'must be YYYY-MM-DD');
  if (value.supersedes !== null && (typeof value.supersedes !== 'string' || !REPORT.test(value.supersedes) || value.supersedes.includes('/'))) {
    at('supersedes', 'must be null or the file name of the report this run replaces');
  } else if (value.supersedes && value.supersedes === value.report) at('supersedes', 'a report cannot replace itself');
  if (value.pr !== undefined && pullRequestProblem(value.pr)) at('pr', pullRequestProblem(value.pr));
  if (value.head !== undefined && (typeof value.head !== 'string' || !SIDECAR_HEAD.test(value.head))) at('head', 'must be the full commit hash of the pull request\'s head at the walk\'s start, from aidrian pr resolve');
  if ((value.pr === undefined) !== (value.head === undefined)) at(value.pr === undefined ? 'pr' : 'head', 'a pull request run names both pr and head; any other run names neither');

  // A finding of the replaced report has two spellings, `F1` and `<that report>#F1`: one finding, so one key here.
  const oneSpelling = (key) => (key.startsWith(`${value.supersedes}#`) ? key.slice(value.supersedes.length + 1) : key);
  const replaced = {};
  for (const key of ['carried_forward', 'not_rechecked']) {
    const list = value[key];
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !SORTED_KEY.test(id))) {
      at(key, 'must be a list of the keys the replaced report\'s sidecar gives its findings');
      continue;
    }
    if (list.length && !value.supersedes) at(key, 'needs supersedes: it lists findings of the report this run replaces');
    const keys = list.map(oneSpelling);
    if (new Set(keys).size !== keys.length) at(key, 'lists a finding twice');
    replaced[key] = keys;
  }
  const both = (replaced.carried_forward ?? []).filter((id) => (replaced.not_rechecked ?? []).includes(id));
  if (both.length) {
    const named = both.map(replacedTitle);
    const which = named.every(Boolean) ? named.map((title) => `"${title}"`).join(', ') : `${both.length} finding${both.length === 1 ? '' : 's'} of the replaced report`;
    at('not_rechecked', `${which} also in carried_forward: a finding is listed once`);
  }
  if (older !== undefined) problems.push(...replacedProblems(value, older, reportNamed));

  if (!Array.isArray(value.findings)) at('findings', 'must be a list');
  else value.findings.forEach((finding, index) => findingProblems(finding, nonEmptyString(finding?.title) ? `finding "${finding.title}"` : `findings[${index}]`, at, dir));
  for (const key of ['not_reached', 'doc_gaps']) {
    if (!Array.isArray(value[key])) {
      at(key, 'must be a list');
      continue;
    }
    value[key].forEach((item, index) => {
      if (!isObject(item)) return at(`${key}[${index}]`, 'must be an object');
      if (typeof item.id !== 'string' || !ID[key].test(item.id)) at(`${key}[${index}].id`, `must be ${key === 'not_reached' ? 'N' : 'D'} and the item's number in its section`);
      if (!nonEmptyString(item.text)) at(`${key}[${index}].text`, 'must say what it is');
      if (item.covered_by !== undefined && (key !== 'not_reached' || item.covered_by !== 'not_rechecked' || !value.supersedes)) {
        at(`${key}[${index}].covered_by`, 'is only "not_rechecked", on a Not reached line of a run that replaces a report');
      }
    });
  }
  for (const key of ['findings', 'not_reached', 'doc_gaps']) {
    const items = (Array.isArray(value[key]) ? value[key] : []).filter((item) => item?.id);
    const twice = items.filter((item) => items.filter((other) => other.id === item.id).length > 1);
    if (twice.length) at(key, `${twice.map(itemWords).join(', ')} share one key: each item has its own`);
  }
  return problems;
}

// What a sidecar says of the report it replaces, against that report (`older`, null when the folder holds none): the
// report exists, this run may replace it (replacementRefusal), and each key it sorts names a finding of it or, as
// `<file>#<key>`, of a run further back in the chain, which `reportNamed` finds by its file name.
export function replacedProblems({ supersedes, carried_forward: carried, not_rechecked: rechecks, pr }, older, reportNamed = () => null) {
  if (!supersedes) return [];
  if (!older) return [`supersedes: names ${reportTitle(supersedes)}, which is not in the audits folder: restore it, or write the sidecar with supersedes null and no findings to sort`];
  const refusal = replacementRefusal(pr, older, { validSidecar: true });
  if (refusal) return [`supersedes: ${refusal}, so write the sidecar with supersedes null and no findings to sort`];
  const known = new Set(older.findings.map((finding) => finding.id));
  const seen = new Set();
  for (let run = older; run && !seen.has(run); run = run.supersedes ? reportNamed(run.supersedes) : null) {
    seen.add(run);
    for (const finding of run.findings) known.add(`${run.report}#${finding.id}`);
  }
  const unknown = [...(Array.isArray(carried) ? carried : []), ...(Array.isArray(rechecks) ? rechecks : [])].filter((key) => !known.has(key));
  return unknown.length ? [`carried_forward and not_rechecked: ${unknown.length} key${unknown.length === 1 ? '' : 's'} name${unknown.length === 1 ? 's' : ''} no finding of ${reportTitle(older.report, older.findings)}`] : [];
}

function findingProblems(finding, name, at, dir) {
  if (!isObject(finding)) return at(name, 'must be an object');
  if (typeof finding.id !== 'string' || !ID.findings.test(finding.id)) at(name, 'id must be F and the finding\'s number in severity order');
  if (!nonEmptyString(finding.title)) at(name, 'title is missing');
  if (!SEVERITIES.includes(finding.severity)) at(name, `severity must be ${SEVERITIES.join(', ')}`);
  if (!LABELS.includes(finding.label)) at(name, `label must be ${LABELS.join(' or ')}`);
  if (!LEVELS.includes(finding.evidence_level)) at(name, `evidence_level must be ${LEVELS.join(', ')}`);
  if (!nonEmptyStrings(finding.personas)) at(name, 'personas must be a non-empty list');
  if (!nonEmptyStrings(finding.tasks)) at(name, 'tasks must be a non-empty list');
  if (typeof finding.owner !== 'string' || !ROLE.test(finding.owner)) at(name, 'owner must be an agent role, such as ux-specialist');
  if (!nonEmptyString(finding.owner_description)) at(name, 'owner_description must say in plain words what the owner looks after');
  if (finding.other_owners !== undefined && (!Array.isArray(finding.other_owners) || finding.other_owners.some((role) => typeof role !== 'string' || !ROLE.test(role)))) {
    at(name, 'other_owners must be a list of agent roles');
  }
  if (typeof finding.needs_trace !== 'boolean') at(name, 'needs_trace must be true or false');
  if (finding.likely_cause !== undefined && (!nonEmptyString(finding.likely_cause) || finding.needs_trace !== true)) {
    at(name, 'likely_cause is text, and only on a finding with needs_trace true');
  }
  if (!Array.isArray(finding.evidence)) at(name, 'evidence must be a list of paths');
  else for (const file of finding.evidence) {
    const problem = evidenceProblem(file, dir);
    if (problem) at(name, problem);
  }
  if (finding.cited !== undefined && !nonEmptyStrings(finding.cited)) at(name, 'cited must be a non-empty list when present');
  if (finding.label === 'observed' && !finding.evidence?.length && !finding.cited?.length) {
    at(name, 'an observed finding cites evidence or cited');
  }
  if (finding.severity === 'blocker' && (finding.label !== 'observed' || finding.evidence_level !== 'walked')) {
    at(name, 'a blocker is only a walked, observed finding');
  }
}

// Why `file` is not a usable evidence path, or null. Evidence is a path relative to the audits folder, in a report's
// screenshot folder: `<report name>/<file>`. Never a suffix such as `-24.jpg`, which names no file.
export function evidenceProblem(file, dir = null) {
  if (typeof file !== 'string' || !file.trim()) return 'evidence holds an empty path';
  if (file.startsWith('-')) return `evidence "${file}" is shorthand: write the full path, such as <report name>/screenshot-24.jpg`;
  if (path.isAbsolute(file) || file.split('/').includes('..')) return `evidence "${file}" must be relative to the audits folder, inside it`;
  if (!file.includes('/') || !path.extname(file)) return `evidence "${file}" must name a file in a report's folder: <report name>/<file>`;
  if (dir && !isFile(path.join(dir, file))) return `evidence "${file}" names no file in ${dir}`;
  return null;
}

// Shorthand evidence in a prose report, such as `-24.jpg`: each span found.
export const proseShorthand = (text) => [...text.matchAll(SHORTHAND)].map((match) => match[1]);

// A finding heading: `### blocker: <title>`, or, in a report written before sidecars, `### F3. blocker: <title>`.
export const FINDING_HEADING = /^### (?:(F[1-9]\d*)\.\s+)?(blocker|friction|polish):\s*(.+?)\s*$/u;

// What a prose report and its sidecar disagree on: the findings, by title in report order, and shorthand evidence.
export function proseProblems(text, sidecar) {
  const problems = [];
  const headings = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = FINDING_HEADING.exec(line);
    if (heading) headings.push((current = heading[3]));
    else if (/^##? /u.test(line)) current = null;
    for (const span of proseShorthand(line)) {
      problems.push(`${current ? `finding "${current}"` : 'the report'} cites a screenshot by its suffix alone, "${span}": write the full path`);
    }
  }
  const titles = Array.isArray(sidecar?.findings) ? sidecar.findings.map((finding) => finding?.title) : [];
  for (const title of headings.filter((one) => !titles.includes(one))) problems.push(`the report's finding "${title}" is not in the sidecar`);
  for (const title of titles.filter((one) => !headings.includes(one))) problems.push(`the sidecar's finding "${title}" is not in the report`);
  if (!problems.length && headings.join('\n') !== titles.join('\n')) problems.push('the report and the sidecar list the findings in another order');
  return problems;
}

// The `code` of the error readTriage throws: a command prints its message, and a hook's line is left out.
export const TRIAGE_UNREADABLE = 'ERR_AIDRIAN_TRIAGE';
const triageError = (message) => Object.assign(new Error(message), { code: TRIAGE_UNREADABLE });

// The triage record: { version, reports: { <report>: { <id>: { decision, issue, url, reason, date } } } }.
// A missing file is an empty record; an unreadable one throws, so a write never replaces decisions it could not read.
export function readTriage(dir) {
  const file = path.join(dir, TRIAGE_FILE);
  if (!existsSync(file)) return { version: 1, reports: {} };
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw triageError(`${file}: invalid JSON (${error.message})`);
  }
  if (!isObject(value) || !isObject(value.reports)) throw triageError(`${file}: not a triage record ({ "version": 1, "reports": {} })`);
  return value;
}

// Records one decision for every target, { report, id }, in one write: under the lock of triage.json, read to write,
// and the file replaced in one rename, so a bulk record lands whole or not at all. A decision keeps the item's priority
// and verdict; a priority or a verdict keeps its decision and each other: they are set apart. `decided --by human`
// settles a verdict, keeping the decision on it and its time, so it holds nothing back through later decisions.
export function recordDecision(dir, targets, entry) {
  const file = path.join(dir, TRIAGE_FILE);
  mkdirSync(dir, { recursive: true });
  return withLocks([file], () => {
    const triage = readTriage(dir);
    for (const { report, id } of targets) {
      const before = triage.reports[report]?.[id] ?? {};
      const settled = entry.decision === 'decided' && entry.by === 'human' && before.verdict ? { verdict: { ...before.verdict, settled: { reason: entry.reason, date: entry.date, at: entry.at ?? null } } } : {};
      const kept = { ...(before.priority ? { priority: before.priority } : {}), ...(before.verdict ? { verdict: before.verdict } : {}) };
      const next = entry.decision ? { ...entry, ...kept, ...settled } : { ...before, ...entry };
      triage.reports[report] = { ...triage.reports[report], [id]: next };
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(triage, null, 2)}\n`);
    renameSync(temporary, file);
    return triage;
  });
}

// The problem with a decision's fields, or null: an issue or a duplicate names the tracker issue; a drop gives a reason.
export function decisionProblem({ decision, issue, url, reason, doc, by }) {
  if (!DECISIONS.includes(decision)) return `decision must be ${DECISIONS.join(', ')}`;
  if (by != null && !BY.test(by)) return '--by names who made the pick: human, or the role of the agent whose pick it was, such as product-manager';
  if ((decision === 'issue' || decision === 'duplicate') && !issue && !url) return `${decision} needs --issue KEY or --url URL`;
  if ((decision === 'drop' || decision === 'covered' || decision === 'decided') && !reason) return `${decision} needs --reason${decision === 'decided' ? ', the decision itself' : ''}`;
  if (decision === 'decided' && !by) return 'decided needs --by, who made the decision';
  if (decision === 'documented' && !DOC.test(doc ?? '')) return `documented needs --doc <path#section>: ${DOC_FORMS}`;
  return null;
}

// The problem with a priority's fields, or null: one of PRIORITIES, set by someone.
export function priorityProblem({ value, by }) {
  if (!PRIORITIES.includes(value)) return `priority must be ${PRIORITIES.join(', ')}`;
  if (!by || !BY.test(by)) return 'a priority needs --by: human, or the role of the agent that set it, such as product-manager';
  return null;
}

// Every report in the audits folder `dir`, oldest run first, each as:
// { report, status, sidecar, problems, findings, items, untriaged, awaiting_sort, supersedes, replaced_by }.
// `awaiting_sort` counts the findings of the replaced report that wait for this report's import to sort them, on both.
// status: `ok` (a valid sidecar), `invalid` (a sidecar with problems), `no-sidecar` (a report to import), or `replaced`
// (another report replaces it; its findings that run did not re-check are that report's items).
// `items` lists each item with its `report` key and its decision, null while untriaged.
export function listAudits(dir, { triage = readTriage(dir) } = {}) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((name) => REPORT.test(name) && isFile(path.join(dir, name))).sort(byRun);
  const reports = names.map((report) => loadReport(dir, report));
  const byName = new Map(reports.map((each) => [each.report, each]));
  // A sidecar that is valid alone can still name a report the folder lacks, or a finding that report does not hold.
  reports.forEach((each, index) => {
    if (each.status !== 'ok') return;
    const problems = replacedProblems(each, byName.get(each.supersedes) ?? null, (name) => byName.get(name));
    if (!problems.length) return;
    reports[index] = fromProse(dir, each.report, problems, each);
    byName.set(each.report, reports[index]);
  });
  // Whatever its prose says, a run that may not replace a report leaves it live, with its own items.
  for (const each of reports) if (replacementRefusal(each.pr, byName.get(each.supersedes), { validSidecar: each.status === 'ok' })) each.supersedes = null;
  const sorted = new Set(reports.filter((each) => each.status === 'ok'));
  for (const each of reports) {
    const replaced = each.supersedes && byName.get(each.supersedes);
    // Never a loop of replacements: that would leave no live report to triage any of them.
    if (replaced && replaced !== each && liveReport(reports, each) !== replaced) replaced.replaced_by = each.report;
  }
  const decided = (report, id) => triage.reports?.[report]?.[id] ?? null;
  nameReports(reports);
  const olderOf = (each) => {
    const older = each.supersedes ? byName.get(each.supersedes) : null;
    return older && older !== each ? older : null;
  };
  const asItem = (run, finding) => ({ kind: 'not_rechecked', ...finding, report: run.report, report_title: run.title, decision: decided(run.report, finding.id) });
  const keyOf = (item) => `${item.report}#${item.id}`;
  // What each report takes over from the run it replaces: what its sidecar lists as not re-checked, and everything that
  // run still carried with no final decision, unless its sidecar carries it forward. A finding is never lost because a
  // later run did not name it.
  const offers = new Map();
  const offered = (each) => {
    if (offers.has(each)) return offers.get(each);
    offers.set(each, []);
    const older = olderOf(each);
    const listed = each.not_rechecked.map((key) => {
      const at = key.indexOf('#');
      const run = at === -1 ? older : byName.get(key.slice(0, at));
      return asItem(run, run.findings.find((finding) => finding.id === key.slice(at + 1)));
    }).filter((item) => item.id);
    const dropped = new Set([...listed.map(keyOf), ...each.carried_forward.filter((key) => key.includes('#'))]);
    const result = [...listed, ...unresolved(older).filter((item) => !dropped.has(keyOf(item)))];
    offers.set(each, result);
    return result;
  };
  // What a report replacing `each` must take over. A run with no sidecar sorted nothing, so all of what it replaced is open.
  const unresolved = (each) => {
    if (!each) return [];
    if (sorted.has(each)) return offered(each).filter(untriaged);
    const older = olderOf(each);
    return older ? [...older.findings.map((finding) => asItem(older, finding)).filter(untriaged), ...offered(each).filter(untriaged)] : [];
  };
  for (const each of reports) {
    if (each.replaced_by) each.status = 'replaced';
    const own = [...each.findings.map((finding) => ({ kind: 'finding', ...finding })), ...each.not_reached.map((item) => ({ kind: 'not_reached', ...item })), ...each.doc_gaps.map((item) => ({ kind: 'doc_gap', ...item }))]
      .map((item) => ({ ...item, report: each.report, report_title: each.title, decision: decided(each.report, item.id) }));
    const older = olderOf(each);
    each.items = [...own, ...offered(each)];
    each.unresolved = unresolved(each);
    // A report not imported yet that replaces another: that report's findings have no decision until the import sorts
    // them into carried forward and not re-checked, so they wait here, and count as untriaged.
    each.awaiting_sort = older && each.status !== 'ok' && !each.replaced_by ? older.findings.length : 0;
    if (older) older.awaiting_sort = each.awaiting_sort;
    each.untriaged = each.status === 'replaced' ? 0 : each.items.filter(untriaged).length + each.awaiting_sort;
  }
  return reports;
}

// The report that triages `entry` now: itself, or the end of its chain of replacements; null for a chain that loops.
export function liveReport(reports, entry) {
  const seen = new Set();
  let current = entry;
  while (current?.replaced_by) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = reports.find((each) => each.report === current.replaced_by);
  }
  return current ?? null;
}

// Oldest first: by personas and date, then the run of that day, so `x-2026-05-02.md` sorts before `x-2026-05-02-2.md`.
function byRun(a, b) {
  const key = (name) => {
    const [, stem, run = '1'] = /^(.+?\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/u.exec(name);
    return [stem, Number(run)];
  };
  const [[x, m], [y, n]] = [key(a), key(b)];
  return x < y ? -1 : x > y ? 1 : m - n;
}

function loadReport(dir, report) {
  const base = { report, sidecar: sidecarName(report), problems: [], replaced_by: null };
  const file = path.join(dir, base.sidecar);
  if (isFile(file)) {
    let value;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
      base.problems.push(...sidecarProblems(value, { report }));
    } catch (error) {
      base.problems.push(`invalid JSON (${error.message})`);
    }
    if (!base.problems.length) {
      return { ...base, status: 'ok', personas: value.personas, supersedes: value.supersedes, findings: value.findings, not_reached: value.not_reached, doc_gaps: value.doc_gaps, carried_forward: value.carried_forward, not_rechecked: value.not_rechecked, pr: value.pr, head: value.head };
    }
    return fromProse(dir, report, base.problems, isObject(value) ? value : {});
  }
  return fromProse(dir, report, base.problems);
}

// No sidecar, or one that is invalid: the prose gives the counts and the report it replaces, never a decision's key.
// `sidecar`, what an invalid one still says, gives the pull request it names, so another run cannot replace it.
function fromProse(dir, report, problems, { pr, head } = {}) {
  const parsed = parseReport(readFileSync(path.join(dir, report), 'utf8'), { report, dir });
  return {
    report, sidecar: sidecarName(report), problems, replaced_by: null, status: problems.length ? 'invalid' : 'no-sidecar', personas: parsed.personas, pr, head,
    supersedes: parsed.supersedes, findings: parsed.findings, not_reached: parsed.not_reached, doc_gaps: parsed.doc_gaps, carried_forward: [], not_rechecked: [],
  };
}

// The untriaged items of one report, in the order the Human answers them: each blocker alone, then the other findings
// grouped by owner and severity, then the replaced report's findings this run did not re-check, then Not reached
// lines, then doc gaps. Each group: { kind, title, items }, each item with the `labels` its issue would get.
export function pendingGroups(entry, { labels = [], personas = entry.personas ?? [] } = {}) {
  const open = (entry.items ?? []).filter(untriaged).map((item) => ({
    ...item, labels: issueLabels(labels, item, personas), verdict: item.decision?.verdict ?? null, held: held(item.decision), allowed_decisions: allowedDecisions(item),
  }))
    // Within a group, a priority a reviewer set comes first, highest first; the audit's own order after.
    .sort((a, b) => rank(a) - rank(b));
  const groups = [];
  const findings = open.filter((item) => item.kind === 'finding');
  // One heading shape for every group of findings: "<Severity>, for <owner in plain words>". A blocker is a group alone.
  const heading = ({ severity, owner, owner_description: words }) => `${capitalize(severity)}, for ${words || OWNER_WORDS[owner] || owner}`;
  for (const item of findings.filter((one) => one.severity === 'blocker')) groups.push({ kind: 'blocker', title: heading(item), items: [item] });
  const rest = findings.filter((one) => one.severity !== 'blocker');
  const keys = [...new Set(rest.map((item) => `${SEVERITIES.indexOf(item.severity)}\0${item.owner}`))].sort();
  for (const key of keys) {
    const items = rest.filter((item) => `${SEVERITIES.indexOf(item.severity)}\0${item.owner}` === key);
    groups.push({ kind: 'findings', title: heading(items[0]), items });
  }
  // A Not reached line that restates the not re-checked findings is offered with them, as `covered`, so the Human
  // decides those findings once.
  const covered = open.filter((item) => item.kind === 'not_reached' && item.covered_by === 'not_rechecked').map((item) => ({ ...item, proposed: 'covered' }));
  const rechecks = open.filter((item) => item.kind === 'not_rechecked');
  // One group per earlier run: a chain of replacements can carry findings from more than one.
  for (const run of [...new Set(rechecks.map((item) => item.report))]) {
    const items = rechecks.filter((item) => item.report === run);
    groups.push({ kind: 'not_rechecked', title: `Not re-checked from ${items[0].report_title ?? reportTitle(run)}`, items: [...items, ...(run === rechecks[0].report ? covered : [])] });
  }
  const reruns = [...open.filter((item) => item.kind === 'not_reached' && item.covered_by !== 'not_rechecked'), ...(rechecks.length ? [] : covered)];
  if (reruns.length) groups.push({ kind: 'not_reached', title: 'Not reached: follow-ups for a rerun', items: reruns });
  const gaps = open.filter((item) => item.kind === 'doc_gap');
  if (gaps.length) groups.push({ kind: 'doc_gap', title: 'Persona doc gaps', items: gaps });
  return groups;
}

// The labels an issue filed for `item` gets, from config.json `audits.triage.labels`: each plain label as it is, and
// each `{persona}` or `{severity}` label filled from the item, one label per persona. An item with no severity, such as
// a Not reached line, skips the severity labels; one with no personas takes the report's.
export function issueLabels(templates, item, personas = []) {
  const values = { persona: item.personas?.length ? item.personas : personas, severity: item.severity ? [item.severity] : [] };
  const labels = templates.flatMap((template) => {
    const fields = [...template.matchAll(/\{(\w+)\}/gu)].map(([, field]) => field);
    return fields.reduce((filled, field) => filled.flatMap((label) => values[field].map((value) => label.replaceAll(`{${field}}`, value))), [template]);
  });
  return [...new Set(labels)];
}

// The labels with no placeholder: the ones the duplicate search queries, since every audit issue carries them.
export const searchLabels = (templates) => templates.filter((label) => !label.includes('{'));

// The start line while the audits folder holds untriaged items, '' otherwise. A report to import counts its parsed
// items. Never throws: a broken folder, report, or triage record prints nothing rather than break the session.
export function auditNudge(dir) {
  try {
    const reports = listAudits(dir).filter((each) => each.untriaged > 0);
    if (!reports.length) return '';
    const items = reports.reduce((sum, each) => sum + each.untriaged, 0);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return `Audit inbox: ${plural(items, 'untriaged finding')} in ${plural(reports.length, 'report')}. The persona-audit-triage skill triages them.`;
  } catch {
    return '';
  }
}

const rank = (item) => {
  const at = PRIORITIES.indexOf(item.decision?.priority?.value);
  return at === -1 ? PRIORITIES.length : at;
};
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
// A task named by its number, such as "Task 2": the reader cannot place it, so a report names a task by its title.
const TASK_NUMBER = /\bTasks? \d+\b/gu;
export const taskNumbers = (text) => [...new Set([...text.matchAll(TASK_NUMBER)].map(([match]) => match))];
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
