// `aidrian lesson`: capture a lesson from stdin, then list, resolve, re-tier, or count the lessons in the inbox
// (lesson-inbox.mjs), and print the session-start line. docs/lessons.md describes every subcommand.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { appendRow, readRows } from './jsonl.mjs';
import {
  addRow, days, firstLine, fold, inboxPath, KINDS, lessons, lessonStats, nudge, oldestText, origin, OUTCOMES, parseCapture, similarLessons,
  TARGETS, TIERS, triageOrder,
} from './lesson-inbox.mjs';
import { projectAt } from './project.mjs';
import { usageLines } from './usage.mjs';

const SHOWN_OCCURRENCES = 5;

const OPTIONS = {
  project: { type: 'string' },
  tier: { type: 'string' },
  kind: { type: 'string' },
  target: { type: 'string' },
  key: { type: 'string' },
  same: { type: 'string' },
  status: { type: 'string' },
  all: { type: 'boolean' },
  source: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  outcome: { type: 'string' },
  link: { type: 'string' },
  expect: { type: 'string' },
  since: { type: 'string' },
};

const ACTIONS = { add, list, resolve, update, stats, nudge: printNudge };

export const commands = {
  lesson: {
    usage:
      `add [--tier ${TIERS.join('|')}] [--kind ${KINDS.join('|')}] [--target ${TARGETS.join('|')}] [--key KEY] [--same ID] ` +
      '| list [ID...] [--status open|resolved|all] [--tier T] [--kind K] [--target T] [--source auto|manual] [--limit N] [--json] ' +
      `| resolve ID --outcome ${OUTCOMES.join('|')} --link REF|- [--expect TEXT] | update ID [--tier T] [--kind K] [--target T] ` +
      '| stats [--since 30d] [--json] | nudge',
    about: 'capture a lesson from stdin (leading "evidence: <ref>" lines, then the note), list, resolve, re-tier, or count them',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, ...ids] = positionals;
      if (!Object.hasOwn(ACTIONS, action ?? '')) return fail(usageLines('lesson', commands.lesson.usage, 'usage: ').join('\n'));
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      return ACTIONS[action]({ values, ids, file: inboxPath(project, config), config });
    },
  },
};

function add({ values, ids, file }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const { note, evidence } = parseCapture(readFileSync(0, 'utf8'));
  if (values.same !== undefined) {
    if (['tier', 'kind', 'target', 'key'].some((name) => values[name] !== undefined)) {
      return fail('--same records the lesson again and takes no --tier, --kind, --target, or --key; change those with `aidrian lesson update`');
    }
    const lesson = fold(readRows(file).rows).find(values.same);
    if (!lesson) return fail(`no lesson with id ${values.same}`);
    appendRow(file, { event: 'seen', id: lesson.id, at: new Date().toISOString(), note, evidence, ...origin() });
    return report(file, lesson.id, values.json);
  }
  if (!note) return fail('the lesson needs a note on stdin, after any "evidence: <ref>" lines');
  const row = addRow({ note, evidence, tier: values.tier ?? 'P2', kind: values.kind ?? null, target: values.target ?? null, key: values.key ?? null, ...origin() });
  appendRow(file, row);
  return report(file, row.id, values.json);
}

// Prints where a captured row landed: its lesson's id first, then how often it was seen and what it resembles.
function report(file, id, json) {
  const { lessons: all, find } = fold(readRows(file).rows);
  const lesson = find(id);
  const similar = (similarLessons(all, [lesson]).get(lesson.id) ?? []).map(find);
  if (json) {
    console.log(JSON.stringify({ ...view(lesson), similar: similar.map((other) => other.id) }));
    return 0;
  }
  const lines = [lesson.id];
  if (lesson.seen > 1) lines.push(`Seen ${lesson.seen} times${lesson.reopened && lesson.status === 'open' ? '; it was reopened: the fix did not hold' : ''}.`);
  if (lesson.seen === 1 && similar.length) {
    lines.push(`Similar lessons. If one is the same problem, merge this one into it: aidrian lesson resolve ${lesson.id} --outcome merged --link <id>`);
    for (const other of similar) lines.push(`  ${summary(other)}`);
  }
  console.log(lines.join('\n'));
  return 0;
}

function list({ values, ids, file }) {
  const status = values.all ? 'all' : values.status ?? (ids.length ? 'all' : 'open');
  if (!['open', 'resolved', 'all'].includes(status)) return fail('--status must be open, resolved, or all');
  const problem = badLabel(values) ?? (values.source !== undefined && !['auto', 'manual'].includes(values.source) ? '--source must be auto or manual' : null);
  if (problem) return fail(problem);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (limit !== Infinity && !(Number.isInteger(limit) && limit > 0)) return fail('--limit takes a whole number above 0');
  const { lessons: all, find } = fold(readRows(file).rows);
  let chosen;
  if (ids.length) {
    const missing = ids.filter((id) => !find(id));
    if (missing.length) return fail(`no lesson with id ${missing.join(', ')}`);
    chosen = [...new Set(ids.map(find))];
  } else {
    chosen = all.filter((lesson) => !lesson.mergedInto && (status === 'all' || lesson.status === status))
      .filter((lesson) => ['tier', 'kind', 'target', 'source'].every((name) => values[name] === undefined || lesson[name] === values[name]))
      .sort(triageOrder)
      .slice(0, limit);
  }
  const similar = similarLessons(all, chosen);
  if (values.json) {
    console.log(JSON.stringify(chosen.map((lesson) => ({ ...view(lesson), similar: similar.get(lesson.id) ?? [] }))));
  } else if (!chosen.length) {
    console.log(`no ${status === 'all' ? '' : `${status} `}lessons in ${file}`);
  } else {
    console.log(chosen.map((lesson) => (ids.length ? detail(lesson, similar.get(lesson.id)) : summary(lesson))).join('\n'));
  }
  return 0;
}

function resolve({ values, ids, file }) {
  if (ids.length !== 1) return fail(ids.length ? `unexpected argument: ${ids[1]}` : 'resolve needs the lesson id');
  const [id] = ids;
  if (!OUTCOMES.includes(values.outcome)) return fail(`resolve needs --outcome ${OUTCOMES.join('|')}`);
  const link = values.link === '-' ? readFileSync(0, 'utf8').trim() : values.link?.trim();
  if (!link) return fail('resolve needs --link: the commit, pull request, issue, lesson id, or reason it ends in');
  const { lessons: all, find } = fold(readRows(file).rows);
  const lesson = all.find((each) => each.id === id && each.status === 'open');
  if (!lesson) return fail(`no open lesson with id ${id}`);
  if (values.outcome === 'merged') {
    const target = find(link);
    if (!target) return fail(`merged needs --link to name a lesson; no lesson with id ${link}`);
    if (target === lesson) return fail('a lesson cannot be merged into itself');
  }
  const row = { event: 'resolve', id, at: new Date().toISOString(), outcome: values.outcome, link, ...(values.expect ? { expect: values.expect } : {}) };
  appendRow(file, row);
  if (values.json) console.log(JSON.stringify(view(fold(readRows(file).rows).find(id))));
  else console.log(`${id} -> ${values.outcome}`);
  return 0;
}

function update({ values, ids, file }) {
  if (ids.length !== 1) return fail(ids.length ? `unexpected argument: ${ids[1]}` : 'update needs the lesson id');
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const changes = Object.fromEntries(['tier', 'kind', 'target'].filter((name) => values[name] !== undefined).map((name) => [name, values[name]]));
  if (!Object.keys(changes).length) return fail('update needs --tier, --kind, or --target');
  const lesson = fold(readRows(file).rows).find(ids[0]);
  if (!lesson) return fail(`no lesson with id ${ids[0]}`);
  appendRow(file, { event: 'update', id: lesson.id, at: new Date().toISOString(), ...changes });
  console.log(values.json ? JSON.stringify(view(fold(readRows(file).rows).find(lesson.id))) : summary({ ...lesson, ...changes }));
  return 0;
}

async function stats({ values, ids, file }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  const since = values.since ?? '30d';
  const { parseSince } = await import('./report.mjs');
  let sinceMs;
  try {
    sinceMs = parseSince(since);
  } catch (error) {
    return fail(error.message);
  }
  const summary = lessonStats(lessons(file), { sinceMs });
  if (values.json) console.log(JSON.stringify({ file, since, ...summary }));
  else console.log(formatStats(summary, { file, since }));
  return 0;
}

export function formatStats(summary, { file, since }) {
  const { open, window, fixes } = summary;
  const lines = [`Lesson inbox ${file}`];
  if (open.count) {
    const extra = [open.auto && `${open.auto} automatic`, open.reopened && `${open.reopened} reopened`].filter(Boolean);
    lines.push(
      `Open: ${open.count} (${TIERS.map((tier) => `${tier} ${open.tiers[tier]}`).join(', ')}); ` +
        `plugin ${open.targets.plugin}, project ${open.targets.project}, no target ${open.targets.none}` +
        `${extra.length ? `; ${extra.join(', ')}` : ''}; ${oldestText(open.oldest_days)}.`,
    );
  } else {
    lines.push('Open: none.');
  }
  const outcomes = OUTCOMES.filter((outcome) => window.outcomes[outcome]).map((outcome) => `${outcome} ${window.outcomes[outcome]}`);
  const speed = window.median_days_to_resolve === null ? '' : `, median ${Math.round(window.median_days_to_resolve * 10) / 10} days to resolve`;
  lines.push(`Since ${since}: ${window.added} added, ${window.seen_again} seen again, ${window.resolved} resolved${outcomes.length ? ` (${outcomes.join(', ')})` : ''}${speed}.`);
  const held = fixes.filter((fix) => !fix.recurred).length;
  lines.push(`Fixes since ${since}: ${fixes.length}${fixes.length ? `; ${held} held, ${fixes.length - held} recurred` : ''}.`);
  for (const fix of fixes) {
    const verdict = fix.recurred ? `recurred ${fix.recurred === 1 ? 'once' : `${fix.recurred} times`}` : `held ${days(fix.held_days)}`;
    lines.push(`  ${fix.id}  ${fix.outcome}  ${String(fix.at).slice(0, 10)}  ${verdict}  ${fix.title}`);
    if (fix.expect) lines.push(`            expect: ${fix.expect}`);
  }
  return lines.join('\n');
}

function printNudge({ file, config }) {
  const line = nudge(file, { config });
  if (line) console.log(line);
  return 0;
}

function badLabel(values) {
  if (values.tier !== undefined && !TIERS.includes(values.tier)) return `--tier must be one of ${TIERS.join(', ')}`;
  if (values.kind !== undefined && !KINDS.includes(values.kind)) return `--kind must be one of ${KINDS.join(', ')}`;
  if (values.target !== undefined && !TARGETS.includes(values.target)) return `--target must be one of ${TARGETS.join(', ')}`;
  return null;
}

// The lesson as `--json` prints it: the latest occurrences only; `seen` counts them all.
function view(lesson) {
  return { ...lesson, occurrences: lesson.occurrences.slice(-SHOWN_OCCURRENCES) };
}

function summary(lesson) {
  const labels = [lesson.tier, lesson.status === 'open' ? (lesson.reopened ? 'reopened' : 'open') : `resolved: ${lesson.outcome}`];
  if (lesson.seen > 1) labels.push(`x${lesson.seen}`);
  if (lesson.target || lesson.kind) labels.push([lesson.target ?? '-', lesson.kind ?? '-'].join('/'));
  if (lesson.source === 'auto') labels.push('auto');
  return `${lesson.id}  ${String(lesson.at).slice(0, 10)}  [${labels.join(' ')}]  ${lesson.title}`;
}

function detail(lesson, similar = []) {
  const pad = (text) => text.split('\n').map((line) => `          ${line}`.trimEnd()).join('\n');
  const lines = [summary(lesson)];
  const where = [lesson.agent, lesson.branch].filter(Boolean).join(' @ ');
  if (where || lesson.session) lines.push(pad([where, lesson.session && `session ${lesson.session}`].filter(Boolean).join(', ')));
  if (lesson.key) lines.push(pad(`key: ${lesson.key}`));
  lines.push(pad(lesson.note));
  for (const item of lesson.evidence) lines.push(pad(`evidence: ${item}`));
  for (const item of lesson.occurrences.slice(-SHOWN_OCCURRENCES)) {
    const head = `seen ${String(item.at).slice(0, 10)}${item.session ? `, session ${item.session}` : ''}${item.note ? `: ${firstLine(item.note)}` : ''}`;
    lines.push(pad(head), ...item.evidence.map((ref) => pad(`  evidence: ${ref}`)));
  }
  for (const item of lesson.resolutions) {
    lines.push(pad(`${item.outcome} ${String(item.at).slice(0, 10)}: ${item.link}${item.recurred ? `; seen ${item.recurred} more since` : ''}`));
    if (item.expect) lines.push(pad(`  expect: ${item.expect}`));
  }
  if (similar.length) lines.push(pad(`similar: ${similar.join(', ')}`));
  return lines.join('\n');
}

function fail(message) {
  console.error(message);
  return 1;
}
