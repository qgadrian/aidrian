// `aidrian audits`: the persona audits in the state folder and their triage (audits.mjs). `list` shows each report and
// how much of it is untriaged; `check` validates a sidecar against its report; `import` drafts, then writes, the sidecar
// of a report written without one; `pending` prints one report's untriaged items in the order the Human answers them;
// `record` keeps one decision in triage.json. docs/personas.md#triage describes each subcommand.
//
// What a person reads, the text output and every warning and problem, names a report by its personas, kind, and date
// and an item by its title, never by its id or file name; `--json` carries the ids and file names the commands take.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseReport } from './audit-import.mjs';
import {
  decisionProblem, DECISIONS, itemWords, taskNumbers, listAudits, OWNER_WORDS, pendingGroups, proseProblems, readTriage, recordDecision, reportName, reportTitle, searchLabels, sidecarName, sidecarProblems, today,
} from './audits.mjs';
import { commandConfig } from './config.mjs';
import { projectAt, stateDir } from './project.mjs';
import { usageLines } from './usage.mjs';

const OPTIONS = {
  project: { type: 'string' },
  json: { type: 'boolean' },
  write: { type: 'boolean' },
  from: { type: 'string' },
  'not-rechecked': { type: 'string' },
  'carried-forward': { type: 'string' },
  issue: { type: 'string' },
  url: { type: 'string' },
  reason: { type: 'string' },
};

const ACTIONS = { list, check, import: importReport, pending, record };

export const commands = {
  audits: {
    usage:
      'list [--json] | check REPORT | import REPORT [--not-rechecked IDS] [--carried-forward IDS] [--from FILE] [--write] [--json] ' +
      `| pending REPORT [--json] | record REPORT ID ${DECISIONS.join('|')} [--issue KEY] [--url URL] [--reason TEXT]`,
    about: 'list the persona audits in the state folder and what is untriaged, check or import a sidecar, and record triage decisions',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, ...rest] = positionals;
      if (!Object.hasOwn(ACTIONS, action ?? '')) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      const dir = path.join(stateDir(project, { config }), 'audits');
      return ACTIONS[action]({ values, rest, dir, triage: config.audits.triage });
    },
  },
};

function list({ values, dir }) {
  const reports = listAudits(dir);
  if (values.json) {
    console.log(JSON.stringify(reports.map(({ report, title, status, problems, findings, items, untriaged, supersedes, replaced_by: replacedBy }) => ({
      report, title, status, problems, findings: findings.length, items: items.length, untriaged, supersedes, replaced_by: replacedBy,
    }))));
    return 0;
  }
  if (!reports.length) {
    console.log(`No persona audits in ${dir}.`);
    return 0;
  }
  // Words for a person: each report by its title, never its file name; --json gives the names the commands take.
  console.log(`Persona audits in ${dir}`);
  const titles = new Map(reports.map((each) => [each.report, each.title]));
  for (const each of reports) console.log(`- ${capital(each.title)}: ${statusText(each, titles)}`);
  console.log('`aidrian audits list --json` gives the file name each other command takes.');
  return 0;
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function statusText(each, titles = new Map()) {
  const counts = `${each.findings.length} finding${each.findings.length === 1 ? '' : 's'}`;
  if (each.status === 'replaced') return `replaced by ${titles.get(each.replaced_by) ?? each.replaced_by}`;
  if (each.status === 'no-sidecar') return `${counts}, no sidecar: import needed`;
  if (each.status === 'invalid') return `${counts}, invalid sidecar: ${each.problems[0]}`;
  return each.untriaged ? `${counts}, ${each.untriaged} of ${each.items.length} items untriaged` : `${counts}, fully triaged`;
}

// The report `name` in the audits folder, or a problem.
function locate(dir, name) {
  if (!name) return { problem: 'name the report by its file name, as `aidrian audits list --json` gives it' };
  const report = reportName(path.basename(name));
  if (!existsSync(path.join(dir, report))) return { problem: `no such report: ${path.join(dir, report)}` };
  return { report };
}

// The report's entry in the folder, and how to name a finding of the report it replaces: { entry, replacedTitle, older }.
function context(dir, report, supersedes) {
  const reports = listAudits(dir);
  const entry = reports.find((each) => each.report === report);
  const older = reports.find((each) => each.report === (supersedes ?? entry?.supersedes)) ?? null;
  const replacedTitle = (id) => older?.findings.find((finding) => finding.id === id)?.title ?? null;
  return { entry, older, replacedTitle, title: entry?.title ?? reportTitle(report) };
}

function check({ rest: [name], dir }) {
  const { report, problem } = locate(dir, name);
  if (problem) return fail(problem);
  const file = path.join(dir, sidecarName(report));
  if (!existsSync(file)) return fail(`${capital(reportTitle(report))} has no sidecar yet: ${file}`);
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`${file}: invalid JSON (${error.message})`);
  }
  const { title, replacedTitle } = context(dir, report, value?.supersedes);
  const prose = readFileSync(path.join(dir, report), 'utf8');
  const problems = [...sidecarProblems(value, { dir, report, replacedTitle }), ...proseProblems(prose, value)];
  if (problems.length) return fail([`The sidecar of ${title} (${file}):`, ...problems.map((each) => `- ${each}`)].join('\n'));
  // A warning, not a problem: a report written before this rule keeps its text, and the reader still gets it.
  for (const task of taskNumbers(prose)) console.error(`warning: the report says "${task}", which no reader can place: name the task by its title`);
  console.log(`ok: the sidecar of ${title}: ${value.findings.length} findings, ${value.not_reached.length} not reached, ${value.doc_gaps.length} doc gaps`);
  return 0;
}

// Without --write, prints the draft sidecar on stdout, and on stderr the warnings for the Human, each finding by its
// title; with --json, one object instead: { draft, replaced: [{ id, title }], warnings, problems }, so a session maps the
// titles the Human sorts back to the keys the flags take. With --write, validates and writes it, never over a sidecar.
function importReport({ values, rest: [name], dir }) {
  const { report, problem } = locate(dir, name);
  if (problem) return fail(problem);
  const target = path.join(dir, sidecarName(report));
  let draft;
  let warnings = [];
  if (values.from) {
    try {
      draft = JSON.parse(readFileSync(path.resolve(values.from), 'utf8'));
    } catch (error) {
      return fail(`${values.from}: ${error.message}`);
    }
    delete draft.warnings;
  } else {
    ({ warnings, ...draft } = parseReport(readFileSync(path.join(dir, report), 'utf8'), { report, dir, ownerWords: OWNER_WORDS }));
  }
  const { older, replacedTitle } = context(dir, report, draft.supersedes);
  const replaced = (older?.findings ?? []).map(({ id, title }) => ({ id, title }));
  if (draft.supersedes && !values.from) {
    const what = older ? older.title : reportTitle(draft.supersedes);
    const sort = 'Sort each of its findings: carried forward, when a finding of this run covers it, or not re-checked, when this run did not look at it';
    // The plain output's next step lists the findings, with their keys; --json lists them here, and in `replaced`.
    warnings.push(!replaced.length ? `This run replaces ${what}, which holds no findings to sort.`
      : values.json ? `This run replaces ${what}. ${sort}:\n${replaced.map((one) => `  - "${one.title}"`).join('\n')}` : `This run replaces ${what}. ${sort}.`);
  }
  for (const [option, key] of [['not-rechecked', 'not_rechecked'], ['carried-forward', 'carried_forward']]) {
    if (values[option] !== undefined) draft[key] = values[option].split(',').map((id) => id.trim()).filter(Boolean);
  }
  const problems = sidecarProblems(draft, { dir, report, replacedTitle });
  if (!values.write) {
    if (values.json) console.log(JSON.stringify({ draft, replaced, warnings, problems }));
    else {
      console.log(JSON.stringify(draft, null, 2));
      for (const each of warnings) console.error(`warning: ${each}`);
      for (const each of problems) console.error(`problem: ${each}`);
      console.error(nextStep(report, replaced));
    }
    return problems.length ? 1 : 0;
  }
  if (existsSync(target)) return fail(`The sidecar exists already, and a sidecar is never overwritten: ${target}`);
  if (problems.length) return fail(problems.map((each) => `problem: ${each}`).join('\n'));
  writeFileSync(target, `${JSON.stringify(draft, null, 2)}\n`);
  console.log(`wrote ${target}`);
  return 0;
}

// The end of a plain import: the command that writes the sidecar, ready to edit. With a replaced report, its findings
// first, each led by its title, then the key the flags take: a key appears here only because the command needs it.
function nextStep(report, replaced) {
  if (!replaced.length) return `Next: once the Human approves the draft, write it:\n  aidrian audits import ${report} --write`;
  return [
    'Next: sort the earlier run\'s findings with the Human, then write the sidecar. Each finding, with the key the flags take:',
    ...replaced.map(({ id, title }) => `  - "${title}": key ${id}`),
    'Move the key of each finding a finding of this run covers to --carried-forward, and keep the rest in --not-rechecked:',
    `  aidrian audits import ${report} --not-rechecked ${replaced.map(({ id }) => id).join(',')} --carried-forward '' --write`,
  ].join('\n');
}

// With --json: { issue_creation, search_labels, groups }, so the skill reads the mode and every issue's labels from
// config.json in one call. Each item also carries `source`, the line its issue body cites it by, in words and the
// report's path, and `audit_key`, the machine key a body keeps out of sight, for the duplicate search.
function pending({ values, rest: [name], dir, triage }) {
  const { report, problem } = locate(dir, name);
  if (problem) return fail(problem);
  const entry = listAudits(dir).find((each) => each.report === report);
  if (entry.status === 'no-sidecar' || entry.status === 'invalid') return fail(`${capital(entry.title)}: ${statusText(entry)}`);
  if (entry.status === 'replaced') return fail(`${capital(entry.title)} is replaced by ${listAudits(dir).find((each) => each.report === entry.replaced_by)?.title}: triage that report`);
  const groups = pendingGroups(entry, { labels: triage.labels });
  for (const item of groups.flatMap((group) => group.items)) {
    const what = item.kind === 'not_reached' ? 'not reached' : item.kind === 'doc_gap' ? 'persona doc gap' : 'finding';
    item.source = `Source: ${item.report_title ?? reportTitle(item.report)}, ${what} ${itemWords(item)} (${path.join(dir, item.report)})`;
    item.audit_key = `${item.report}#${item.id}`;
  }
  if (values.json) {
    console.log(JSON.stringify({ issue_creation: triage.issueCreation, search_labels: searchLabels(triage.labels), groups }));
    return 0;
  }
  if (!groups.length) {
    console.log(`${capital(entry.title)}: fully triaged`);
    return 0;
  }
  const labelled = searchLabels(triage.labels).join(' or ');
  console.log(triage.issueCreation === 'auto' ? 'Issues: created without asking, and listed at the end.' : 'Issues: each draft is shown to the Human before it is created.');
  console.log(`Duplicates: open issues labelled ${labelled} are searched first.`);
  for (const group of groups) {
    console.log(`## ${group.title}`);
    for (const item of group.items) console.log(`- ${item.title ?? item.text}${item.proposed === 'covered' ? ' (covered by the findings above)' : ''}`);
  }
  return 0;
}

function record({ values, rest: [name, id, decision], dir }) {
  const { report, problem } = locate(dir, name);
  if (problem) return fail(problem);
  if (!id || !decision) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
  const entry = { decision, issue: values.issue ?? null, url: values.url ?? null, reason: values.reason ?? null, date: today() };
  const bad = decisionProblem(entry);
  if (bad) return fail(bad);
  let triage;
  try {
    triage = readTriage(dir);
  } catch (error) {
    return fail(`${error.message}; nothing was recorded`);
  }
  const reports = listAudits(dir, { triage });
  const owner = reports.find((each) => each.report === report);
  // The item is the report's own, or a finding of it that the report replacing it offers as not re-checked.
  const holder = reports.find((each) => each.status === 'ok' && each.items.some((item) => item.report === report && item.id === id));
  if (!holder) {
    if (owner.status === 'no-sidecar' || owner.status === 'invalid') return fail(`${capital(owner.title)}: ${statusText(owner)}`);
    return fail(`${capital(owner.title)} offers no item with that key to triage; \`aidrian audits pending <report> --json\` lists the keys`);
  }
  recordDecision(dir, report, id, entry);
  const left = listAudits(dir).find((each) => each.report === holder.report).untriaged;
  const item = holder.items.find((one) => one.report === report && one.id === id);
  const where = holder.title;
  console.log(`recorded ${itemWords(item)}: ${decision}; ${left ? `${left} untriaged left in ${where}` : `${capital(where)} is fully triaged`}`);
  return 0;
}

function fail(problem) {
  console.error(problem);
  return 1;
}
