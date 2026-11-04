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
// it, with a reason. defer: decided later, on purpose.
export const DECISIONS = ['issue', 'fix-now', 'duplicate', 'drop', 'defer'];
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

const ID = { findings: /^F[1-9]\d*$/u, not_reached: /^N[1-9]\d*$/u, doc_gaps: /^D[1-9]\d*$/u };
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A report file name: `<personas>-<YYYY-MM-DD>.md`, with `-2`, `-3` for a second and third run that day.
const REPORT = /^(.+)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/u;
// A backticked span that names a screenshot by its suffix alone, such as `-24.jpg`: the reader cannot open it.
const SHORTHAND = /`(-[^`/\s]*\.(?:png|jpe?g|gif|webp))`/giu;

export const sidecarName = (report) => report.replace(/\.md$/u, '.json');
export const reportName = (value) => (value.endsWith('.md') ? value : `${value}.md`);
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

// The problems of a sidecar, as strings; empty when it is valid. With `dir`, the audits folder, every evidence path
// must also name a file there.
export function sidecarProblems(value, { dir = null, report = null } = {}) {
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

  const replaced = {};
  for (const key of ['carried_forward', 'not_rechecked']) {
    const list = value[key];
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !ID.findings.test(id))) {
      at(key, 'must be a list of finding ids of the replaced report, such as F3');
      continue;
    }
    if (list.length && !value.supersedes) at(key, 'needs supersedes: it lists findings of the report this run replaces');
    if (new Set(list).size !== list.length) at(key, 'lists an id twice');
    replaced[key] = list;
  }
  const both = (replaced.carried_forward ?? []).filter((id) => (replaced.not_rechecked ?? []).includes(id));
  if (both.length) at('not_rechecked', `${both.join(', ')} also in carried_forward: a finding is listed once`);

  if (!Array.isArray(value.findings)) at('findings', 'must be a list');
  else value.findings.forEach((finding, index) => findingProblems(finding, `findings[${index}]`, at, dir));
  for (const key of ['not_reached', 'doc_gaps']) {
    if (!Array.isArray(value[key])) {
      at(key, 'must be a list');
      continue;
    }
    value[key].forEach((item, index) => {
      if (!isObject(item)) return at(`${key}[${index}]`, 'must be an object');
      if (typeof item.id !== 'string' || !ID[key].test(item.id)) at(`${key}[${index}].id`, `must be ${key === 'not_reached' ? 'N1, N2' : 'D1, D2'}, ...`);
      if (!nonEmptyString(item.text)) at(`${key}[${index}].text`, 'must say what it is');
    });
  }
  for (const key of ['findings', 'not_reached', 'doc_gaps']) {
    const ids = (Array.isArray(value[key]) ? value[key] : []).map((item) => item?.id).filter(Boolean);
    const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (twice.length) at(key, `${[...new Set(twice)].join(', ')} used twice`);
  }
  return problems;
}

function findingProblems(finding, where, at, dir) {
  if (!isObject(finding)) return at(where, 'must be an object');
  const id = typeof finding.id === 'string' ? finding.id : null;
  const name = id ? `${where} ${id}` : where;
  if (!id || !ID.findings.test(id)) at(name, 'id must be F1, F2, ...');
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

// What a prose report and its sidecar disagree on: the finding ids under `### F<n>.` headings, and shorthand evidence.
export function proseProblems(text, sidecar) {
  const problems = proseShorthand(text).map((span) => `the report cites "${span}": write the full path`);
  const headings = [...text.matchAll(/^### (F[1-9]\d*)\./gmu)].map((match) => match[1]);
  const ids = Array.isArray(sidecar?.findings) ? sidecar.findings.map((finding) => finding?.id) : [];
  if (headings.join(',') !== ids.join(',')) problems.push(`the report's findings are ${headings.join(', ') || 'none'}, the sidecar's ${ids.join(', ') || 'none'}`);
  return problems;
}

// The triage record: { version, reports: { <report>: { <id>: { decision, issue, url, reason, date } } } }.
// A missing file is an empty record; an unreadable one throws, so a write never replaces decisions it could not read.
export function readTriage(dir) {
  const file = path.join(dir, TRIAGE_FILE);
  if (!existsSync(file)) return { version: 1, reports: {} };
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(value) || !isObject(value.reports)) throw new Error(`${file}: not a triage record ({ "version": 1, "reports": {} })`);
  return value;
}

// Records one decision, under the lock of triage.json, read to write, and replaces the file in one rename.
export function recordDecision(dir, report, id, entry) {
  const file = path.join(dir, TRIAGE_FILE);
  mkdirSync(dir, { recursive: true });
  return withLocks([file], () => {
    const triage = readTriage(dir);
    triage.reports[report] = { ...triage.reports[report], [id]: entry };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(triage, null, 2)}\n`);
    renameSync(temporary, file);
    return triage;
  });
}

// The problem with a decision's fields, or null: an issue or a duplicate names the tracker issue; a drop gives a reason.
export function decisionProblem({ decision, issue, url, reason }) {
  if (!DECISIONS.includes(decision)) return `decision must be ${DECISIONS.join(', ')}`;
  if ((decision === 'issue' || decision === 'duplicate') && !issue && !url) return `${decision} needs --issue KEY or --url URL`;
  if (decision === 'drop' && !reason) return 'drop needs --reason';
  return null;
}

// Every report in the audits folder `dir`, oldest run first, each as:
// { report, status, sidecar, problems, findings, items, untriaged, supersedes, replaced_by }.
// status: `ok` (a valid sidecar), `invalid` (a sidecar with problems), `no-sidecar` (a report to import), or `replaced`
// (another report replaces it; its findings that run did not re-check are that report's items).
// `items` lists each item with its `report` key and its decision, null while untriaged.
export function listAudits(dir, { triage = readTriage(dir) } = {}) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((name) => REPORT.test(name) && isFile(path.join(dir, name))).sort(byRun);
  const reports = names.map((report) => loadReport(dir, report));
  const byName = new Map(reports.map((each) => [each.report, each]));
  for (const each of reports) {
    const replaced = each.supersedes && byName.get(each.supersedes);
    if (replaced && replaced !== each) replaced.replaced_by = each.report;
  }
  const decided = (report, id) => triage.reports?.[report]?.[id] ?? null;
  for (const each of reports) {
    if (each.replaced_by) each.status = 'replaced';
    const own = [...each.findings.map((finding) => ({ kind: 'finding', ...finding })), ...each.not_reached.map((item) => ({ kind: 'not_reached', ...item })), ...each.doc_gaps.map((item) => ({ kind: 'doc_gap', ...item }))]
      .map((item) => ({ ...item, report: each.report, decision: decided(each.report, item.id) }));
    const older = each.supersedes ? byName.get(each.supersedes) : null;
    const offered = each.not_rechecked.map((id) => {
      const finding = older?.findings.find((one) => one.id === id) ?? { id, title: `${id} of ${each.supersedes}` };
      return { kind: 'not_rechecked', ...finding, report: each.supersedes, decision: decided(each.supersedes, id) };
    });
    each.items = [...own, ...offered];
    each.untriaged = each.status === 'replaced' ? 0 : each.items.filter((item) => !item.decision).length;
  }
  return reports;
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
    let value = null;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      base.problems.push(`invalid JSON (${error.message})`);
    }
    if (value) base.problems.push(...sidecarProblems(value, { report }));
    if (!base.problems.length) {
      return { ...base, status: 'ok', supersedes: value.supersedes, findings: value.findings, not_reached: value.not_reached, doc_gaps: value.doc_gaps, not_rechecked: value.not_rechecked };
    }
  }
  // No sidecar, or one that is invalid: the prose gives the counts and the report it replaces, never a decision's key.
  const parsed = parseReport(readFileSync(path.join(dir, report), 'utf8'), { report, dir });
  return { ...base, status: base.problems.length ? 'invalid' : 'no-sidecar', supersedes: parsed.supersedes, findings: parsed.findings, not_reached: parsed.not_reached, doc_gaps: parsed.doc_gaps, not_rechecked: [] };
}

// The untriaged items of one report, in the order the Human answers them: each blocker alone, then the other findings
// grouped by owner and severity, then the replaced report's findings this run did not re-check, then Not reached
// lines, then doc gaps. Each group: { kind, title, items }.
export function pendingGroups(entry) {
  const open = (entry.items ?? []).filter((item) => !item.decision);
  const groups = [];
  const findings = open.filter((item) => item.kind === 'finding');
  for (const item of findings.filter((one) => one.severity === 'blocker')) groups.push({ kind: 'blocker', title: `Blocker ${item.id}: ${item.title}`, items: [item] });
  const rest = findings.filter((one) => one.severity !== 'blocker');
  const keys = [...new Set(rest.map((item) => `${SEVERITIES.indexOf(item.severity)}\0${item.owner}`))].sort();
  for (const key of keys) {
    const items = rest.filter((item) => `${SEVERITIES.indexOf(item.severity)}\0${item.owner}` === key);
    const [{ severity, owner, owner_description: words }] = items;
    groups.push({ kind: 'findings', title: `${severity}, for ${words || OWNER_WORDS[owner] || owner}`, items });
  }
  const rechecks = open.filter((item) => item.kind === 'not_rechecked');
  if (rechecks.length) groups.push({ kind: 'not_rechecked', title: `Not re-checked from ${rechecks[0].report}`, items: rechecks });
  const reruns = open.filter((item) => item.kind === 'not_reached');
  if (reruns.length) groups.push({ kind: 'not_reached', title: 'Not reached: follow-ups for a rerun', items: reruns });
  const gaps = open.filter((item) => item.kind === 'doc_gap');
  if (gaps.length) groups.push({ kind: 'doc_gap', title: 'Persona doc gaps', items: gaps });
  return groups;
}

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

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
