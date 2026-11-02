// `aidrian lesson`: capture a lesson from stdin, then list, resolve, re-tier, or count the lessons in the inbox
// (lesson-inbox.mjs), print the session-start line, and move the plugin lessons of every project on the machine to the
// plugin's inbox. A lesson for the plugin lands in the plugin's inbox; an id is looked up in the project's own inbox,
// then in the plugin's. docs/lessons.md describes every subcommand.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { appendRow, readRows, realFile, withLocks } from './jsonl.mjs';
import {
  addRow, days, firstLine, fold, homeInbox, inboxPath, KINDS, lessons, lessonStats, moveLessons, nudge, oldestText, origin, OUTCOMES, parseCapture,
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
      // Real paths, as homeInbox returns, so one inbox is one string here whatever symlinks its folder goes through.
      const file = realFile(inboxPath(project, config));
      const plugin = pluginInboxPath();
      return ACTIONS[action]({ values, ids, file, plugin: plugin ? realFile(plugin) : file, project, config });
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

// The inbox whose live lesson holds `key`, or null: the project's own first, then the plugin's, which holds a key for
// this lesson only when it is a plugin lesson, by `--target plugin` or, with no target, by the holder's own target.
// A project lesson never joins a lesson in the plugin's inbox: in the plugin's own checkout that inbox holds its project
// lessons too.
function keyHolder(key, target, { file, plugin }) {
  const holder = (inbox) => lessons(inbox).find((lesson) => lesson.key === key && !lesson.mergedInto);
  if (holder(file)) return file;
  if (plugin === file || (target ?? 'plugin') !== 'plugin') return null;
  const there = holder(plugin);
  return there && (target === 'plugin' || there.target === 'plugin') ? plugin : null;
}

function add({ values, ids, ...ctx }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const { note, evidence, title } = parseCapture(readFileSync(0, 'utf8'));
  if (values.same !== undefined) {
    if (['tier', 'kind', 'target', 'key'].some((name) => values[name] !== undefined)) {
      return fail('--same records the lesson again and takes no --tier, --kind, --target, or --key; change those with `aidrian lesson update`');
    }
    const where = origin();
    const found = writing(ctx, () => {
      const lesson = locate(values.same, ctx);
      if (lesson) appendRow(lesson.file, { event: 'seen', id: lesson.lesson.id, at: new Date().toISOString(), note, evidence, ...where, ...stampFor(lesson.file, ctx) });
      return lesson;
    });
    if (!found) return fail(`no lesson with id ${values.same}`);
    return report(found.file, found.lesson.id, values.json, found.file === ctx.plugin);
  }
  if (!note) return fail('the lesson needs a note on stdin, after any "title:" or "evidence: <ref>" lines');
  const from = origin();
  // A known key lands where its lesson is, as --same does; anything else where its target belongs.
  const { where, row } = writing(ctx, () => {
    const held = values.key === undefined ? null : keyHolder(values.key, values.target, ctx);
    const home = held ? { file: held, project: stampFor(held, ctx).project ?? null } : homeInbox(ctx.project, ctx.config, { target: values.target });
    const added = addRow({
      note, evidence, title, tier: values.tier ?? 'P2', kind: values.kind ?? null, target: values.target ?? null, key: values.key ?? null, ...from,
      ...(home.project ? { project: home.project } : {}),
    });
    appendRow(home.file, added);
    return { where: home, row: added };
  });
  return report(where.file, row.id, values.json, where.file === ctx.plugin);
}

// Runs `write` holding the lock of the project's own inbox and the plugin's, the two that locate and keyHolder read, so
// no lesson move between them runs while it reads and appends (moveLessons).
const writing = (ctx, write) => withLocks([ctx.file, ctx.plugin], write);

// Prints where a captured row landed: its lesson's id first, then how often it was seen and what it resembles.
function report(file, id, json, fromPlugin) {
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
    for (const other of similar) lines.push(`  ${summary(other, fromPlugin)}`);
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
  // The lessons read from the plugin's inbox, which show the project each came from.
  const fromPlugin = new Set();
  if (ids.length) {
    const found = ids.map((id) => locate(id, ctx));
    const missing = ids.filter((id, index) => !found[index]);
    if (missing.length) return fail(`no lesson with id ${missing.join(', ')}`);
    // Each lookup folds its inbox afresh, so two ids of one lesson are the same file and id, not the same object.
    const unique = [...new Map(found.map((item) => [`${item.file}\n${item.lesson.id}`, item])).values()];
    chosen = unique.map((item) => item.lesson);
    for (const item of unique) {
      similar.set(item.lesson.id, similarLessons(item.all, [item.lesson]).get(item.lesson.id));
      if (item.file === ctx.plugin) fromPlugin.add(item.lesson);
    }
  } else {
    const { lessons: all } = fold(readRows(file).rows);
    chosen = all.filter((lesson) => !lesson.mergedInto && (status === 'all' || lesson.status === status))
      .filter((lesson) => ['tier', 'kind', 'target', 'source'].every((name) => values[name] === undefined || lesson[name] === values[name]))
      .sort(triageOrder)
      .slice(0, limit);
    for (const [id, list] of similarLessons(all, chosen)) similar.set(id, list);
    if (file === ctx.plugin) for (const lesson of chosen) fromPlugin.add(lesson);
  }
  if (values.json) {
    console.log(JSON.stringify(chosen.map((lesson) => ({ ...view(lesson), similar: similar.get(lesson.id) ?? [] }))));
  } else if (!chosen.length) {
    console.log(`no ${status === 'all' ? '' : `${status} `}lessons in ${file}`);
  } else {
    console.log(chosen.map((lesson) => (ids.length ? detail(lesson, similar.get(lesson.id), fromPlugin.has(lesson)) : summary(lesson, fromPlugin.has(lesson)))).join('\n'));
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
  const { problem, file } = writing(ctx, () => {
    const found = locate(id, ctx);
    const lesson = found?.all.find((each) => each.id === id && each.status === 'open');
    if (!lesson) return { problem: `no open lesson with id ${id}` };
    const { find } = found;
    if (values.outcome === 'merged') {
      const target = find(link);
      if (!target) {
        const elsewhere = locate(link, ctx);
        return { problem: elsewhere ? `${link} is in another inbox (${elsewhere.file}); a lesson merges only into one in its own inbox` : `merged needs --link to name a lesson; no lesson with id ${link}` };
      }
      if (target === lesson) return { problem: 'a lesson cannot be merged into itself' };
    }
    appendRow(found.file, { event: 'resolve', id, at: new Date().toISOString(), outcome: values.outcome, link, ...(values.expect ? { expect: values.expect } : {}), ...stampFor(found.file, ctx) });
    return { file: found.file };
  });
  if (problem) return fail(problem);
  if (values.json) console.log(JSON.stringify(view(fold(readRows(file).rows).find(id))));
  else console.log(`${id} -> ${values.outcome}`);
  return 0;
}

// A lesson whose target changes moves to the inbox homeInbox names for it: the plugin's for `plugin`, and for `project`
// the inbox of the project it came from, which respects that project's `state.dir` when the command runs from there.
// A tier or kind alone moves nothing.
function update({ values, ids, ...ctx }) {
  if (ids.length !== 1) return fail(ids.length ? `unexpected argument: ${ids[1]}` : 'update needs the lesson id');
  const problem = badLabel(values);
  if (problem) return fail(problem);
  const changes = Object.fromEntries(['tier', 'kind', 'target'].filter((name) => values[name] !== undefined).map((name) => [name, values[name]]));
  if (!Object.keys(changes).length) return fail('update needs --tier, --kind, or --target');
  // The inbox a target change moves the lesson `held` to, as homeInbox names it, or null when it stays.
  // A lesson in this project's own inbox came from this project, whatever its rows say; one in the plugin's inbox that
  // names no project is the plugin repository's own.
  const destination = (held) => {
    if (!held || !changes.target) return null;
    const from = held.file === ctx.plugin ? held.lesson.project ?? pluginProjectId() : null;
    const home = homeInbox(ctx.project, ctx.config, { target: changes.target, from });
    return home.file === held.file ? null : home;
  };
  // The update row and the move are one write: it holds the locks of the inboxes it reads and of the destination from
  // its read to the move's last row, so a destination it cannot lock leaves nothing written. The destination depends on
  // what the read finds, so a first read names the locks to take in order; should the read under them name another,
  // that lock is taken too before anything is written.
  const guess = destination(locate(ids[0], ctx));
  const result = withLocks([ctx.file, ctx.plugin, guess?.file], () => {
    const held = locate(ids[0], ctx);
    if (!held) return { held };
    const home = destination(held);
    return withLocks([home?.file], () => {
      appendRow(held.file, { event: 'update', id: held.lesson.id, at: new Date().toISOString(), ...changes, ...stampFor(held.file, ctx) });
      const moved = home ? moveLessons(held.file, home.file, [held.lesson.id], { project: home.project }).length > 0 : false;
      return { held, moved, to: moved ? home.file : held.file };
    });
  });
  if (!result.held) return fail(`no lesson with id ${ids[0]}`);
  const { held: { lesson }, moved, to } = result;
  const now = fold(readRows(to).rows).find(lesson.id);
  if (values.json) console.log(JSON.stringify(view(now)));
  else console.log(`${summary(now, to === ctx.plugin)}${moved ? `\nMoved to ${to}` : ''}`);
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
function migrate({ values, ids, file, plugin, project, config }) {
  if (ids.length) return fail(`unexpected argument: ${ids[0]}`);
  if (plugin === file && !pluginProjectId()) return fail('the plugin\'s manifest names no repository, so there is no plugin inbox to move lessons to');
  const sources = new Map();
  const root = path.join(stateRoot(), 'projects');
  for (const id of existsSync(root) ? readdirSync(root).sort() : []) {
    const inbox = realFile(projectInboxPath(id));
    if (inbox !== plugin && existsSync(inbox)) sources.set(inbox, id);
  }
  if (file !== plugin && existsSync(file) && !sources.has(file)) sources.set(file, projectId(project));
  const keys = new Map(lessons(plugin).filter((lesson) => lesson.key && !lesson.mergedInto).map((lesson) => [lesson.key, lesson.id]));
  const moves = [];
  for (const [inbox, from] of sources) {
    const { lessons: all, find } = fold(readRows(inbox).rows);
    const chosen = all.filter((lesson) => !lesson.mergedInto && lesson.target === 'plugin');
    if (!chosen.length) continue;
    // A lesson whose key holder there is itself, its rows copied by a move cut short, joins nothing (moveLessons).
    const joins = Object.fromEntries(chosen.filter((lesson) => keys.has(lesson.key) && find(keys.get(lesson.key))?.id !== lesson.id).map((lesson) => [lesson.id, keys.get(lesson.key)]));
    const home = homeInbox(project, config, { target: 'plugin', from });
    const ids = values['dry-run'] ? chosen.map((lesson) => lesson.id) : moveLessons(inbox, home.file, chosen.map((lesson) => lesson.id), { project: home.project });
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

// `fromPlugin`: the lesson was read from the plugin's inbox, so it names the project it came from.
function summary(lesson, fromPlugin = false) {
  const labels = [lesson.tier, lesson.status === 'open' ? (lesson.reopened ? 'reopened' : 'open') : `resolved: ${lesson.outcome}`];
  if (lesson.seen > 1) labels.push(`x${lesson.seen}`);
  if (lesson.target || lesson.kind) labels.push([lesson.target ?? '-', lesson.kind ?? '-'].join('/'));
  if (lesson.source === 'auto') labels.push('auto');
  if (fromPlugin && lesson.project && lesson.project !== pluginProjectId()) labels.push(`from ${lesson.project}`);
  return `${lesson.id}  ${String(lesson.at).slice(0, 10)}  [${labels.join(' ')}]  ${lesson.title}`;
}

function detail(lesson, similar = [], fromPlugin = false) {
  const pad = (text) => text.split('\n').map((line) => `          ${line}`.trimEnd()).join('\n');
  const lines = [summary(lesson, fromPlugin)];
  const where = [lesson.agent, lesson.branch].filter(Boolean).join(' @ ');
  if (where || lesson.session) lines.push(pad([where, lesson.session && `session ${lesson.session}`].filter(Boolean).join(', ')));
  if (fromPlugin && lesson.project) lines.push(pad(`project: ${lesson.project}`));
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
