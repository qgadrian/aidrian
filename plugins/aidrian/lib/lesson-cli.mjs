// `aidrian lesson`: capture a lesson from stdin, then list, resolve, re-tier, or count the lessons in the inbox
// (lesson-inbox.mjs), print the session-start line, and move the plugin lessons of every project on the machine to the
// plugin's inbox. A lesson for the plugin lands in the plugin's inbox; an id is looked up in the project's own inbox,
// then in the plugin's. docs/lessons.md describes every subcommand.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { appendRow, readRows } from './jsonl.mjs';
import {
  addRow, days, firstLine, fold, inboxFor, inboxPath, KINDS, lessons, lessonStats, moveLessons, nudge, oldestText, origin, OUTCOMES, parseCapture,
  pluginInboxPath, projectInboxPath, similarLessons, TARGETS, TIERS, triageOrder,
} from './lesson-inbox.mjs';
import { pluginProjectId, projectAt, projectId, stateRoot } from './project.mjs';
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
  'dry-run': { type: 'boolean' },
};

const ACTIONS = { add, list, resolve, update, stats, nudge: printNudge, migrate };

export const commands = {
  lesson: {
    usage:
      `add [--tier ${TIERS.join('|')}] [--kind ${KINDS.join('|')}] [--target ${TARGETS.join('|')}] [--key KEY] [--same ID] ` +
      '| list [ID...] [--status open|resolved|all] [--tier T] [--kind K] [--target T] [--source auto|manual] [--limit N] [--json] ' +
      `| resolve ID --outcome ${OUTCOMES.join('|')} --link REF|- [--expect TEXT] | update ID [--tier T] [--kind K] [--target T] ` +
      '| stats [--since 30d] [--json] | nudge | migrate [--dry-run] [--json]',
    about: 'capture a lesson from stdin (leading "title:" and "evidence: <ref>" lines, then the note), list, resolve, re-tier, or count them',
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, ...ids] = positionals;
      if (!Object.hasOwn(ACTIONS, action ?? '')) return fail(usageLines('lesson', commands.lesson.usage, 'usage: ').join('\n'));
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      const file = inboxPath(project, config);
      return ACTIONS[action]({ values, ids, file, plugin: pluginInboxPath() ?? file, project, config });
    },
  },
};

// The lesson that holds `id`, from the project's own inbox, else the plugin's: { file, lesson, all, find }, or null.
function locate(id, { file, plugin }) {
  for (const inbox of new Set([file, plugin])) {
    const { lessons: all, find } = fold(readRows(inbox).rows);
    const lesson = find(id);
    if (lesson) return { file: inbox, lesson, all, find };
  }
  return null;
}

// The project id stamped on a row written to `inbox`: rows in the plugin's inbox name the project they came from.
const stampFor = (inbox, ctx) => (inbox === ctx.plugin ? { project: projectId(ctx.project) } : {});

function add({ values, ids, ...ctx }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const { note, evidence, title } = parseCapture(readFileSync(0, 'utf8'));
  if (values.same !== undefined) {
    if (['tier', 'kind', 'target', 'key'].some((name) => values[name] !== undefined)) {
      return fail('--same records the lesson again and takes no --tier, --kind, --target, or --key; change those with `aidrian lesson update`');
    }
    const found = locate(values.same, ctx);
    if (!found) return fail(`no lesson with id ${values.same}`);
    appendRow(found.file, { event: 'seen', id: found.lesson.id, at: new Date().toISOString(), note, evidence, ...origin(), ...stampFor(found.file, ctx) });
    return report(found.file, found.lesson.id, values.json);
  }
  if (!note) return fail('the lesson needs a note on stdin, after any "title:" or "evidence: <ref>" lines');
  const where = inboxFor(ctx.project, ctx.config, values.target);
  const row = addRow({
    note, evidence, title, tier: values.tier ?? 'P2', kind: values.kind ?? null, target: values.target ?? null, key: values.key ?? null, ...origin(),
    ...(where.project ? { project: where.project } : {}),
  });
  appendRow(where.file, row);
  return report(where.file, row.id, values.json);
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

function list({ values, ids, ...ctx }) {
  const status = values.all ? 'all' : values.status ?? (ids.length ? 'all' : 'open');
  if (!['open', 'resolved', 'all'].includes(status)) return fail('--status must be open, resolved, or all');
  const problem = badLabel(values) ?? (values.source !== undefined && !['auto', 'manual'].includes(values.source) ? '--source must be auto or manual' : null);
  if (problem) return fail(problem);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (limit !== Infinity && !(Number.isInteger(limit) && limit > 0)) return fail('--limit takes a whole number above 0');
  // Plugin lessons live in the plugin's inbox; every other list reads the project's own.
  const file = values.target === 'plugin' ? ctx.plugin : ctx.file;
  let chosen;
  const similar = new Map();
  if (ids.length) {
    const found = ids.map((id) => locate(id, ctx));
    const missing = ids.filter((id, index) => !found[index]);
    if (missing.length) return fail(`no lesson with id ${missing.join(', ')}`);
    chosen = [...new Set(found.map((item) => item.lesson))];
    for (const item of found) similar.set(item.lesson.id, similarLessons(item.all, [item.lesson]).get(item.lesson.id));
  } else {
    const { lessons: all } = fold(readRows(file).rows);
    chosen = all.filter((lesson) => !lesson.mergedInto && (status === 'all' || lesson.status === status))
      .filter((lesson) => ['tier', 'kind', 'target', 'source'].every((name) => values[name] === undefined || lesson[name] === values[name]))
      .sort(triageOrder)
      .slice(0, limit);
    for (const [id, list] of similarLessons(all, chosen)) similar.set(id, list);
  }
  if (values.json) {
    console.log(JSON.stringify(chosen.map((lesson) => ({ ...view(lesson), similar: similar.get(lesson.id) ?? [] }))));
  } else if (!chosen.length) {
    console.log(`no ${status === 'all' ? '' : `${status} `}lessons in ${file}`);
  } else {
    console.log(chosen.map((lesson) => (ids.length ? detail(lesson, similar.get(lesson.id)) : summary(lesson))).join('\n'));
  }
  return 0;
}

function resolve({ values, ids, ...ctx }) {
  if (ids.length !== 1) return fail(ids.length ? `unexpected argument: ${ids[1]}` : 'resolve needs the lesson id');
  const [id] = ids;
  if (!OUTCOMES.includes(values.outcome)) return fail(`resolve needs --outcome ${OUTCOMES.join('|')}`);
  const link = values.link === '-' ? readFileSync(0, 'utf8').trim() : values.link?.trim();
  if (values.link === '-' && !link) return fail('--link - read nothing from stdin; pipe the link in or pass --link <ref>');
  if (!link) return fail('resolve needs --link: the commit, pull request, issue, lesson id, or reason it ends in');
  const found = locate(id, ctx);
  const lesson = found?.all.find((each) => each.id === id && each.status === 'open');
  if (!lesson) return fail(`no open lesson with id ${id}`);
  const { file, find } = found;
  if (values.outcome === 'merged') {
    const target = find(link);
    if (!target) {
      const elsewhere = locate(link, ctx);
      return fail(elsewhere ? `${link} is in another inbox (${elsewhere.file}); a lesson merges only into one in its own inbox` : `merged needs --link to name a lesson; no lesson with id ${link}`);
    }
    if (target === lesson) return fail('a lesson cannot be merged into itself');
  }
  const row = { event: 'resolve', id, at: new Date().toISOString(), outcome: values.outcome, link, ...(values.expect ? { expect: values.expect } : {}), ...stampFor(file, ctx) };
  appendRow(file, row);
  if (values.json) console.log(JSON.stringify(view(fold(readRows(file).rows).find(id))));
  else console.log(`${id} -> ${values.outcome}`);
  return 0;
}

// A lesson whose target changes moves with it: to the plugin's inbox for `plugin`, and out of it, back to the project it
// came from, for `project`.
function update({ values, ids, ...ctx }) {
  if (ids.length !== 1) return fail(ids.length ? `unexpected argument: ${ids[1]}` : 'update needs the lesson id');
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const changes = Object.fromEntries(['tier', 'kind', 'target'].filter((name) => values[name] !== undefined).map((name) => [name, values[name]]));
  if (!Object.keys(changes).length) return fail('update needs --tier, --kind, or --target');
  const found = locate(ids[0], ctx);
  if (!found) return fail(`no lesson with id ${ids[0]}`);
  const { file, lesson } = found;
  appendRow(file, { event: 'update', id: lesson.id, at: new Date().toISOString(), ...changes, ...stampFor(file, ctx) });
  const target = changes.target ?? lesson.target;
  const home = lesson.project && lesson.project !== pluginProjectId() ? projectInboxPath(lesson.project) : file;
  const to = target === 'plugin' ? ctx.plugin : file === ctx.plugin ? home : file;
  const moved = to !== file && moveLessons(file, to, [lesson.id], { project: to === ctx.plugin ? lesson.project ?? projectId(ctx.project) : null }).length > 0;
  const now = fold(readRows(moved ? to : file).rows).find(lesson.id);
  if (values.json) console.log(JSON.stringify(view(now)));
  else console.log(`${summary(now)}${moved ? `\nMoved to ${to}` : ''}`);
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

// Moves every open or resolved plugin lesson out of each project inbox on this machine, the projects in the state root
// and this project's own wherever config.json puts it, into the plugin's inbox. Safe to run again: a moved lesson is
// gone from its project's inbox, and moveLessons never copies a row twice.
function migrate({ values, ids, file, plugin, project }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  if (plugin === file && !pluginProjectId()) return fail('the plugin\'s manifest names no repository, so there is no plugin inbox to move lessons to');
  const sources = new Map();
  const root = path.join(stateRoot(), 'projects');
  for (const id of existsSync(root) ? readdirSync(root).sort() : []) {
    const inbox = projectInboxPath(id);
    if (inbox !== plugin && existsSync(inbox)) sources.set(inbox, id);
  }
  if (file !== plugin && existsSync(file) && !sources.has(file)) sources.set(file, projectId(project));
  const keys = new Map(lessons(plugin).filter((lesson) => lesson.key && !lesson.mergedInto).map((lesson) => [lesson.key, lesson.id]));
  const moves = [];
  for (const [inbox, from] of sources) {
    const chosen = lessons(inbox).filter((lesson) => !lesson.mergedInto && lesson.target === 'plugin');
    if (!chosen.length) continue;
    const ids = values['dry-run'] ? chosen.map((lesson) => lesson.id) : moveLessons(inbox, plugin, chosen.map((lesson) => lesson.id), { project: from });
    const joins = Object.fromEntries(chosen.filter((lesson) => keys.has(lesson.key)).map((lesson) => [lesson.id, keys.get(lesson.key)]));
    for (const lesson of chosen) if (lesson.key && !keys.has(lesson.key)) keys.set(lesson.key, lesson.id);
    moves.push({ project: from, inbox, ids, joins });
  }
  const count = moves.reduce((sum, item) => sum + item.ids.length, 0);
  if (values.json) {
    console.log(JSON.stringify({ plugin, dry_run: Boolean(values['dry-run']), moved: count, projects: moves }));
    return 0;
  }
  const verb = values['dry-run'] ? 'Would move' : 'Moved';
  const lines = [`${verb} ${count} plugin ${count === 1 ? 'lesson' : 'lessons'} to ${plugin}`];
  for (const item of moves) {
    lines.push(`  ${item.project}: ${item.ids.join(', ')}`);
    for (const [id, holder] of Object.entries(item.joins)) lines.push(`    ${id} joins ${holder}, which holds its key there`);
  }
  console.log(lines.join('\n'));
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
  if (lesson.project && lesson.project !== pluginProjectId()) labels.push(`from ${lesson.project}`);
  return `${lesson.id}  ${String(lesson.at).slice(0, 10)}  [${labels.join(' ')}]  ${lesson.title}`;
}

function detail(lesson, similar = []) {
  const pad = (text) => text.split('\n').map((line) => `          ${line}`.trimEnd()).join('\n');
  const lines = [summary(lesson)];
  const where = [lesson.agent, lesson.branch].filter(Boolean).join(' @ ');
  if (where || lesson.session) lines.push(pad([where, lesson.session && `session ${lesson.session}`].filter(Boolean).join(', ')));
  if (lesson.project) lines.push(pad(`project: ${lesson.project}`));
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
