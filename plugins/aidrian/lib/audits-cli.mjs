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
  allowedDecisions, liveReport, TRIAGE_UNREADABLE, decisionProblem, DECISIONS, DOC_FORMS, held, verdictCitation, verdictProblem, VERDICTS, itemWords, slugOf, PRIORITIES, priorityProblem, untriaged, taskNumbers, listAudits, OWNER_WORDS, pendingGroups, proseProblems, readTriage, recordDecision, reportName, reportTitle, searchLabels, sidecarName, sidecarProblems, today,
} from './audits.mjs';
import { commandConfig } from './config.mjs';
import { isObject } from './fs.mjs';
import { unfencedLines } from './markdown-sections.mjs';
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
  by: { type: 'string' },
  doc: { type: 'string' },
};

const ACTIONS = { list, check, import: importReport, pending, record, rank, verdict };

export const commands = {
  audits: {
    usage:
      'list [--json] | check REPORT | import REPORT [--not-rechecked IDS] [--carried-forward IDS] [--from FILE] [--write] [--json] ' +
      `| pending REPORT [--json] | record REPORT KEYS ${DECISIONS.join('|')} [--issue KEY] [--url URL] [--reason TEXT] [--doc PATH#SECTION] [--by WHO] ` +
      `| rank REPORT KEYS ${PRIORITIES.join('|')} --by WHO [--reason TEXT] | verdict REPORT KEYS ${VERDICTS.join('|')} --by ROLE --reason TEXT`,
    about: 'list the persona audits in the state folder and what is untriaged, check or import a sidecar, and record triage decisions',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, ...rest] = positionals;
      if (!Object.hasOwn(ACTIONS, action ?? '')) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      const dir = path.join(stateDir(project, { config }), 'audits');
      try {
        return ACTIONS[action]({ values, rest, dir, triage: config.audits.triage, root: project.root });
      } catch (error) {
        // A triage record a command cannot read stops it with that line, whatever the command was about to do.
        if (error.code === TRIAGE_UNREADABLE) return fail(error.message);
        throw error;
      }
    },
  },
};

function list({ values, dir }) {
  const reports = listAudits(dir);
  if (values.json) {
    console.log(JSON.stringify(reports.map(({ report, title, status, problems, findings, items, untriaged, awaiting_sort: awaitingSort = 0, supersedes, replaced_by: replacedBy }) => ({
      report, title, status, problems, findings: findings.length, items: items.length, untriaged, awaiting_sort: awaitingSort, supersedes, replaced_by: replacedBy,
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
  for (const each of reports) console.log(`- ${capital(each.title)}: ${statusText(each, titles, reports)}`);
  console.log('`aidrian audits list --json` gives the file name each other command takes.');
  return 0;
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function statusText(each, titles = new Map(), reports = []) {
  const counts = `${each.findings.length} finding${each.findings.length === 1 ? '' : 's'}`;
  const plural = (n) => `${n} finding${n === 1 ? '' : 's'}`;
  if (each.status === 'replaced') {
    const newer = titles.get(each.replaced_by) ?? each.replaced_by;
    // Never "replaced" alone: a replaced report's findings are triaged through the report that replaces it.
    if (each.awaiting_sort) return `replaced by ${newer}; its ${plural(each.awaiting_sort)} have no decision yet, and wait for that report's import to sort them`;
    const live = liveReport(reports, each);
    const open = (live?.items ?? []).filter((item) => item.kind === 'not_rechecked' && item.report === each.report && untriaged(item)).length;
    const through = live?.report === each.replaced_by ? ', which triages' : `; ${titles.get(live?.report) ?? live?.report} triages`;
    return open ? `replaced by ${newer}${through} the ${plural(open)} of it not re-checked` : `replaced by ${newer}; nothing of it is left to triage`;
  }
  const sort = each.awaiting_sort ? `, then sort the ${plural(each.awaiting_sort)} of the run it replaces` : '';
  if (each.status === 'no-sidecar') return `${counts}, no sidecar: import needed${sort}`;
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
  const older = reports.find((each) => each.report === (supersedes === undefined ? entry?.supersedes : supersedes)) ?? null;
  // What a replacing report sorts: the replaced run's findings, and what it still carries from runs before it.
  const replaced = older ? [...older.findings.map(({ id, title }) => ({ id, title })), ...older.unresolved.map(({ report: run, id, title }) => ({ id: `${run}#${id}`, title }))] : [];
  const replacedTitle = (id) => replaced.find((one) => one.id === id)?.title ?? null;
  const reportNamed = (file) => reports.find((each) => each.report === file) ?? null;
  return { entry, older, replaced, replacedTitle, reportNamed, title: entry?.title ?? reportTitle(report) };
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
  const { older, title, replacedTitle, reportNamed } = context(dir, report, value?.supersedes ?? null);
  const prose = readFileSync(path.join(dir, report), 'utf8');
  const problems = [...sidecarProblems(value, { dir, report, replacedTitle, replaced: older, reportNamed }), ...proseProblems(prose, value)];
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
    if (!isObject(draft)) return fail(`${values.from}: the sidecar must be a JSON object`);
    delete draft.warnings;
  } else {
    ({ warnings, ...draft } = parseReport(readFileSync(path.join(dir, report), 'utf8'), { report, dir, ownerWords: OWNER_WORDS }));
  }
  const { older, replaced, replacedTitle, reportNamed } = context(dir, report, draft.supersedes ?? null);
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
  const problems = sidecarProblems(draft, { dir, report, replacedTitle, replaced: older, reportNamed });
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
    // The exact command that records this item, through the report under triage, with the decision still to add.
    item.record = `aidrian audits record ${report} '${item.audit_key}'`;
    // A line of an older report that names a task by its number: the session says which task in words.
    const numbered = taskNumbers(item.title ?? item.text ?? '');
    if (numbered.length) item.numbered_task = numbered;
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
    for (const item of group.items) console.log(`- ${item.title ?? item.text}${notes(item)}`);
  }
  return 0;
}

// KEYS: one or more, comma-separated, each an item's `audit_key` as `pending --json` prints it, `<report file>#<id>`,
// or a bare id of REPORT's own items. A key names one finding even when the walk and the run it replaces both hold
// the same id; a bare id is always REPORT's own.
function record({ values, rest: [name, keys, decision], dir, root }) {
  if (!keys || !decision) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
  const entry = {
    decision, issue: values.issue ?? null, url: values.url ?? null, reason: values.reason ?? null, doc: values.doc ?? null, by: values.by ?? null, date: today(),
  };
  const bad = decisionProblem(entry);
  if (bad) return fail(bad);
  if (entry.doc) {
    const doc = docReference(root, entry.doc);
    if (doc.problem) return fail(doc.problem);
    entry.doc = doc.reference;
  }
  return write(dir, name, keys, entry, () => (decision === 'decided' ? `decided by ${byWords(entry.by)}` : decision));
}

// A `documented` outcome's doc: a file of the project and one of its headings, as written or as its slug, stored as
// `path#slug` so the Human can open the section it names.
function docReference(root, doc, label = '--doc') {
  const at = doc.indexOf('#');
  const [file, section] = [doc.slice(0, at), doc.slice(at + 1).trim()];
  const full = path.join(root, file);
  if (!existsSync(full)) return { problem: `${label} names no file in the project: ${full}. It takes ${DOC_FORMS}` };
  // Every heading, of any level, outside code fences: each is a section a link can name.
  const slugs = [...unfencedLines(readFileSync(full, 'utf8'))].map((line) => /^ {0,3}#{1,6}\s+(.+?)[\s#]*$/u.exec(line)?.[1]).filter(Boolean).map(slugOf);
  const slug = slugs.includes(section) ? section : slugOf(section);
  if (!slugs.includes(slug)) {
    return { problem: `${label} names no section "${section}" in ${file}; its sections are: ${slugs.join(', ') || 'none'}. It takes ${DOC_FORMS}` };
  }
  return { reference: `${file}#${slug}` };
}

// `rank`: a triage priority for an item, apart from the audit's severity, which stays as the run wrote it.
function rank({ values, rest: [name, keys, value], dir }) {
  if (!keys || !value) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
  const bad = priorityProblem({ value, by: values.by });
  if (bad) return fail(bad);
  const priority = { value, set_by: values.by, reason: values.reason ?? null, date: today() };
  return write(dir, name, keys, { priority }, () => `priority ${value}, set by ${byWords(values.by)}`);
}

// `verdict`: a product owner's verdict on an item, evidence for the Human's decision and no decision itself: the item's
// state does not change. A conforms or silent verdict holds back an issue or a fix until `decided --by human`.
function verdict({ values, rest: [name, keys, value], dir, root }) {
  if (!keys || !value) return fail(usageLines('audits', commands.audits.usage, 'usage: ').join('\n'));
  const entry = { value, by: values.by, reason: values.reason };
  const bad = verdictProblem(entry);
  if (bad) return fail(bad);
  // A verdict's citation names a real section: a rule nobody can open settles nothing.
  const citation = verdictCitation(entry);
  if (citation) {
    const cited = docReference(root, citation, 'the verdict');
    if (cited.problem) return fail(cited.problem);
  }
  return write(dir, name, keys, { verdict: { ...entry, date: today() } }, () => `verdict ${value}, from ${values.by}`);
}

// Who made a pick, in words: "the Human", or the agent's role.
const byWords = (by) => (by === 'human' ? 'the Human' : by);

// What a pending line adds to an item's title: a priority a reviewer set, a decision taken, or the covered proposal.
function notes(item) {
  const { priority, decision, reason, by, verdict: rule } = item.decision ?? {};
  const parts = [];
  if (rule) parts.push(`verdict ${rule.value}, from ${rule.by}`);
  if (priority) parts.push(`priority ${priority.value}, set by ${byWords(priority.set_by)}`);
  if (decision === 'decided') parts.push(`decided by ${byWords(by)}: ${reason}`);
  if (held(item.decision)) parts.push('the Human decides before any draft');
  if (item.proposed === 'covered') parts.push('covered by the findings above');
  if (taskNumbers(item.title ?? item.text ?? '').length) parts.push('as the report wrote it: say which task in words');
  return parts.length ? ` (${parts.join('; ')})` : '';
}

// Writes one change to the triage entry of every item KEYS names, once each is one a report offers: every key valid,
// or nothing is written.
function write(dir, name, keys, entry, said) {
  const { report, problem } = locate(dir, name);
  if (problem) return fail(problem);
  let triage;
  try {
    triage = readTriage(dir);
  } catch (error) {
    return fail(`${error.message}; nothing was recorded`);
  }
  const reports = listAudits(dir, { triage });
  const owner = reports.find((each) => each.report === report);
  if (owner.status === 'no-sidecar' || owner.status === 'invalid') return fail(`${capital(owner.title)}: ${statusText(owner)}`);
  // A key resolves only within the selected report: its own items and what it offers of the run it replaces. A replaced
  // report selects only its own findings, through the report that offers them now. No other report is ever reached.
  const live = liveReport(reports, owner);
  const holder = live?.status === 'ok' ? live : null;
  const open = (holder?.items ?? []).filter((item) => holder === owner || item.report === report);
  const targets = [];
  const missing = [];
  for (const key of keys.split(',').map((one) => one.trim()).filter(Boolean)) {
    const at = key.indexOf('#');
    const target = at === -1 ? { report, id: key } : { report: key.slice(0, at), id: key.slice(at + 1) };
    const item = open.find((one) => one.report === target.report && one.id === target.id);
    if (item) targets.push({ ...target, holder, item });
    else missing.push(key);
  }
  if (missing.length || !targets.length) {
    const which = !missing.length ? 'No key was given' : missing.length > 1 ? `${missing.length} keys name no item` : 'One key names no item';
    return fail(`${which} open to triage through ${owner.title}, so nothing was recorded; \`aidrian audits pending <report> --json\` gives each item's key and its record command`);
  }
  // The one rule `pending` prints as each item's allowed_decisions.
  const refused = entry.decision ? targets.filter(({ item }) => !allowedDecisions(item).includes(entry.decision)) : [];
  if (refused.length) {
    const lines = refused.map(({ item }) => {
      const verdictHeld = held(item.decision);
      const why = entry.decision === 'covered' ? 'it does not restate the findings not re-checked'
        : verdictHeld === 'conforms' ? 'the verdict is that the product conforms to the rule, so the Human decides first, with `record ... decided --by human`'
          : verdictHeld === 'silent' && entry.decision === 'documented' ? 'the verdict is that the docs do not settle it'
            : 'the verdict is that no rule settles it, so the Human decides first, with `record ... decided --by human`';
      return `- ${itemWords(item)}: ${why}`;
    });
    return fail([`Nothing was recorded. ${capital(entry.decision)} is not open for:`, ...lines].join('\n'));
  }
  recordDecision(dir, targets, entry);
  const after = listAudits(dir);
  for (const { item } of targets) console.log(`recorded ${itemWords(item)}: ${said(item)}`);
  for (const holder of [...new Set(targets.map((target) => target.holder.report))]) {
    const { untriaged: left, title } = after.find((each) => each.report === holder);
    console.log(left ? `${left} untriaged left in ${title}` : `${capital(title)} is fully triaged`);
  }
  return 0;
}

function fail(problem) {
  console.error(problem);
  return 1;
}
