// `aidrian lesson`: the lesson inbox, a JSON Lines log in the state folder (lessons/inbox.jsonl), shared by every
// worktree and clone of the repository. Capturing a lesson is one command, cheap enough to run the moment something goes
// wrong; deciding what it becomes is the lesson-triage skill's job, later. docs/lessons.md describes the whole loop.
//
// The file is only ever appended to, so no session's write can drop another's. Each row is one event on one lesson:
// `add` starts it, `seen` records it again, `update` changes its tier, kind, or target, and `resolve` closes it.
// fold() replays the rows into the current state of every lesson. An `add` whose `key` an earlier lesson holds is that
// lesson seen again, so automatic signals dedupe without reading the file first. One that also repeats an earlier row's
// `once` is the same event observed again, and adds nothing.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { runGit } from './git.mjs';
import { appendRow, readRows } from './jsonl.mjs';
import { projectAt, stateDir } from './project.mjs';

// P1 blocks or loses work, P2 costs time or tokens, P3 is polish.
export const TIERS = ['P1', 'P2', 'P3'];
// bug: something in place misbehaves. gap: nothing covers the case. improvement: it works and could cost less.
// rule: a judgment worth writing down.
export const KINDS = ['bug', 'gap', 'improvement', 'rule'];
// Who fixes it: this plugin (its agents, skills, hooks, commands) or the project (its knowledge, config, code).
export const TARGETS = ['plugin', 'project'];
// mechanism and rule are fixes; issue hands the work to the tracker; merged names the lesson it repeats.
export const OUTCOMES = ['mechanism', 'rule', 'issue', 'merged', 'rejected'];
// An occurrence after one of these reopens the lesson: the fix did not hold, or the rejection was wrong.
// An issue keeps counting without reopening: the tracker owns that work.
const REOPENS = new Set(['mechanism', 'rule', 'rejected']);
// The first version's outcome names.
const RENAMED_OUTCOMES = { duplicate: 'merged', dropped: 'rejected' };
const TITLE_CHARS = 120;
// Lessons whose words match this much are named as similar: cosine of word weights, each word's count damped by a log and
// weighted by how rare it is in the inbox. On 73 real lessons, it put a true duplicate among the top three for 19 of the
// 20 lessons that had one.
const SIMILAR = 0.18;
const SHOWN_OCCURRENCES = 5;
const DAY_MS = 86_400_000;

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
      if (!Object.hasOwn(ACTIONS, action ?? '')) return fail(`usage: aidrian lesson ${commands.lesson.usage}`);
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      return ACTIONS[action]({ values, ids, file: inboxPath(project, config), config });
    },
  },
};

// `config` is the project's config when the caller has it; stateDir reads it otherwise.
export function inboxPath(project, config) {
  return path.join(stateDir(project, { config }), 'lessons', 'inbox.jsonl');
}

// Leading `evidence: <ref>` lines (blank lines between them allowed), then the note, verbatim.
export function parseCapture(raw) {
  const lines = raw.split('\n');
  const evidence = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const match = /^evidence:\s*(.*\S)\s*$/u.exec(lines[index]);
    if (match) evidence.push(match[1]);
    else if (lines[index].trim() !== '' || evidence.length === 0) break;
  }
  return { note: lines.slice(index).join('\n').trim(), evidence };
}

// Where a row was written from: the session, the agent, the branch, and the worktree, so triage can find the context.
export function origin({ cwd = process.cwd(), env = process.env } = {}) {
  const git = (args) => {
    const { status, stdout } = runGit(args, cwd);
    return status === 0 ? stdout.trim() || null : null;
  };
  return {
    session: env.CLAUDE_CODE_SESSION_ID || null,
    agent: env.CLAUDE_CODE_AGENT || null,
    branch: git(['branch', '--show-current']),
    worktree: git(['rev-parse', '--show-toplevel']),
  };
}

// A new lesson's `add` row. `title` is for a lesson whose note does not start with one, such as an automatic signal.
// `once` names the event a keyed row reports, so the same event recorded twice is one occurrence.
export function addRow({ note, evidence = [], tier = 'P2', kind = null, target = null, key = null, once = null, title, source = 'manual', now = new Date(), ...where }) {
  return { event: 'add', id: newId(), at: now.toISOString(), tier, kind, target, key, ...(key && once ? { once } : {}), source, ...(title ? { title } : {}), note, evidence, ...where };
}

export const newId = () => randomBytes(4).toString('hex');

// Every lesson in capture order, as fold() leaves it.
export function lessons(file) {
  return fold(readRows(file).rows).lessons;
}

// Replays the rows into { lessons, find }. find(id) follows merges and keyed occurrences to the lesson that holds the id.
// Rows from the first version have no `event`: the first row of an id adds the lesson, and one with `status: resolved`
// resolves it, whether it is the same row or a later one.
export function fold(rows) {
  const byId = new Map();
  const alias = new Map();
  const byKey = new Map();
  // Every `key` and `once` pair already recorded: a later row with the same pair is the same event.
  const events = new Set();
  const find = (id) => {
    let current = id;
    for (let hops = 0; alias.has(current) && hops < 100; hops += 1) current = alias.get(current);
    return byId.get(current) ?? null;
  };
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue;
    const event = row.event ?? (byId.has(row.id) || alias.has(row.id) ? null : 'add');
    if (event === 'add' && !byId.has(row.id) && !alias.has(row.id)) {
      const owner = typeof row.key === 'string' && byKey.has(row.key) ? find(byKey.get(row.key)) : null;
      const once = typeof row.key === 'string' && typeof row.once === 'string' && row.once ? `${row.key}\n${row.once}` : null;
      if (owner) {
        alias.set(row.id, owner.id);
        if (!events.has(once)) addOccurrence(owner, occurrence(row));
        if (once) events.add(once);
      } else if (typeof row.note === 'string') {
        const lesson = newLesson(row);
        byId.set(lesson.id, lesson);
        if (lesson.key) byKey.set(lesson.key, lesson.id);
        if (once) events.add(once);
      }
    } else if (event === 'seen') {
      const lesson = find(row.id);
      if (lesson) addOccurrence(lesson, occurrence(row));
    } else if (event === 'update') {
      const lesson = find(row.id);
      if (lesson) Object.assign(lesson, labels(row, lesson));
    }
    if (event === 'resolve' || (row.event === undefined && row.status === 'resolved')) {
      const lesson = byId.get(row.id);
      if (lesson && !lesson.mergedInto) applyResolution(lesson, row, find, alias);
    }
  }
  return { lessons: [...byId.values()], find };
}

function newLesson(row) {
  const note = row.note.trim();
  return {
    id: row.id,
    at: row.at ?? null,
    title: cut(typeof row.title === 'string' && row.title.trim() ? row.title : firstLine(note)),
    note,
    ...labels(row, { tier: 'P2', kind: null, target: null }),
    key: typeof row.key === 'string' && row.key ? row.key : null,
    source: row.source === 'auto' ? 'auto' : 'manual',
    evidence: texts(row.evidence),
    session: row.session ?? null,
    agent: row.agent ?? row.role ?? null,
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    status: 'open',
    seen: 1,
    lastAt: row.at ?? null,
    occurrences: [],
    merged: [],
    mergedInto: null,
    outcome: null,
    link: null,
    expect: null,
    resolvedAt: null,
    reopened: 0,
    resolutions: [],
  };
}

// The tier, kind, and target a row sets, each only when valid; `base` keeps the rest.
function labels(row, base) {
  return {
    tier: TIERS.includes(row.tier) ? row.tier : base.tier,
    kind: KINDS.includes(row.kind) ? row.kind : base.kind,
    target: TARGETS.includes(row.target) ? row.target : base.target,
  };
}

function occurrence(row) {
  const note = typeof row.note === 'string' ? row.note.trim() : '';
  return { id: row.id, at: row.at ?? null, note: note || null, evidence: texts(row.evidence), session: row.session ?? null, agent: row.agent ?? null };
}

// One more occurrence. Every occurrence after the latest resolution counts against it, including those after it reopened
// the lesson; the first one after a fix or a rejection reopens it. Occurrences merged in from an older lesson keep their
// own time, so an old duplicate never reopens a fix.
function addOccurrence(lesson, item) {
  lesson.occurrences.push(item);
  lesson.seen += item.seen ?? 1;
  if (item.at && (!lesson.lastAt || item.at > lesson.lastAt)) lesson.lastAt = item.at;
  const last = lesson.resolutions.at(-1);
  if (!last || !item.at || item.at <= last.at) return;
  last.recurred += 1;
  if (lesson.status !== 'resolved' || !REOPENS.has(last.outcome)) return;
  Object.assign(lesson, { status: 'open', outcome: null, link: null, expect: null, resolvedAt: null, reopened: lesson.reopened + 1 });
}

function applyResolution(lesson, row, find, alias) {
  const outcome = RENAMED_OUTCOMES[row.outcome] ?? row.outcome;
  if (!OUTCOMES.includes(outcome)) return;
  const at = row.resolvedAt ?? row.at ?? null;
  const link = typeof row.link === 'string' && row.link ? row.link : null;
  if (outcome === 'merged') {
    const target = link ? find(link) : null;
    if (target && target !== lesson) {
      alias.set(lesson.id, target.id);
      lesson.mergedInto = target.id;
      target.merged.push(lesson.id);
      addOccurrence(target, { id: lesson.id, at: lesson.at, note: lesson.note, evidence: lesson.evidence, session: lesson.session, agent: lesson.agent, seen: 1 });
      // Moved, not copied: each occurrence lives on one lesson, so totals over every lesson count it once.
      for (const item of lesson.occurrences.splice(0)) addOccurrence(target, item);
    }
  }
  const expect = typeof row.expect === 'string' && row.expect ? row.expect : null;
  lesson.resolutions.push({ at, outcome, link, expect, recurred: 0 });
  Object.assign(lesson, { status: 'resolved', outcome, link, expect, resolvedAt: at });
}

// For each lesson in `targets`, the ids of up to three others among `all` whose words match it, best first.
export function similarLessons(all, targets = all) {
  const pool = all.filter((lesson) => !lesson.mergedInto);
  const docs = new Map(pool.map((lesson) => [lesson.id, words(lesson.source === 'auto' ? `${lesson.title}\n${lesson.note}` : lesson.note)]));
  const df = new Map();
  for (const terms of docs.values()) for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const vectors = new Map();
  for (const [id, terms] of docs) {
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    const vector = new Map([...tf].map(([term, n]) => [term, (1 + Math.log(n)) * Math.log(1 + docs.size / df.get(term))]));
    vectors.set(id, { vector, norm: Math.hypot(...vector.values()) });
  }
  const cosine = (a, b) => {
    let dot = 0;
    for (const [term, weight] of a.vector) dot += weight * (b.vector.get(term) ?? 0);
    return a.norm && b.norm ? dot / (a.norm * b.norm) : 0;
  };
  const out = new Map();
  for (const lesson of targets) {
    const mine = vectors.get(lesson.id);
    const scored = mine ? pool.filter((other) => other.id !== lesson.id).map((other) => [other.id, cosine(mine, vectors.get(other.id))]) : [];
    out.set(lesson.id, scored.filter(([, score]) => score >= SIMILAR).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id));
  }
  return out;
}

const STOP_WORDS = new Set(
  ('the and that this with for from was were are but not its into when what which then than have has had also only each any all ' +
    'one two three four five six they them their there here after before while would could should because about over under same ' +
    'other more most less very been being does did done just like can will must never always still even yet such per via onto ' +
    'upon our your').split(' '),
);
const words = (text) => (String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word));

// Open lessons first, then by tier, then oldest first.
export function triageOrder(a, b) {
  return (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || String(a.at).localeCompare(String(b.at));
}

// The SessionStart line, or '' when no lesson is open. It escalates, naming why, when a P1 is open, when more than
// `lessons.maxOpen` are open, or when the oldest is older than `lessons.maxAgeDays`; 0 turns either limit off.
export function nudge(file, { command = 'aidrian', config, now = Date.now() } = {}) {
  const open = lessons(file).filter((lesson) => lesson.status === 'open');
  if (!open.length) return '';
  const { maxOpen, maxAgeDays } = config.lessons;
  const oldest = Math.max(0, ...open.map((lesson) => ageDays(lesson.at, now)).filter(Number.isFinite));
  const p1 = open.filter((lesson) => lesson.tier === 'P1').length;
  const reasons = [];
  if (p1) reasons.push(`${p1} P1 open`);
  if (maxOpen && open.length > maxOpen) reasons.push(`${open.length} open, over ${maxOpen}`);
  if (maxAgeDays && oldest > maxAgeDays) reasons.push(`the oldest is ${days(oldest)} old, over ${maxAgeDays}`);
  if (!reasons.length) {
    return `Lesson inbox: ${open.length} open (${tierCounts(open)}), ${oldestText(oldest)}. The lesson-triage skill drains it in a session opened for it.`;
  }
  return `Lesson inbox needs triage: ${reasons.join('; ')}. Tell ${config.names.human} once, then go on with the task: ` +
    `the lesson-triage skill drains it in a session opened for it, and \`${command} lesson list\` shows the order.`;
}

const ageDays = (at, now) => Math.floor((now - Date.parse(at)) / DAY_MS);
const days = (n) => (n === 1 ? '1 day' : `${n} days`);
const oldestText = (n) => (n ? `the oldest ${days(n)} old` : 'the oldest from today');
const tierCounts = (list) => TIERS.map((tier) => [tier, list.filter((lesson) => lesson.tier === tier).length]).filter(([, n]) => n).map(([tier, n]) => `${tier} ${n}`).join(', ');

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
  const { parseSince } = await import('./dispatch-log.mjs');
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

// Counts for `aidrian lesson stats`: what is open, what moved since `sinceMs`, and whether the fixes since then held.
export function lessonStats(all, { sinceMs = 0, now = Date.now() } = {}) {
  const live = all.filter((lesson) => !lesson.mergedInto);
  const open = live.filter((lesson) => lesson.status === 'open');
  const after = (at) => Date.parse(at) >= sinceMs;
  const resolutions = all.flatMap((lesson) => lesson.resolutions.map((resolution) => ({ lesson, ...resolution }))).filter((item) => after(item.at));
  const toResolve = resolutions.map((item) => (Date.parse(item.at) - Date.parse(item.lesson.at)) / DAY_MS).filter(Number.isFinite);
  const fixes = resolutions.filter((item) => item.outcome === 'mechanism' || item.outcome === 'rule');
  return {
    open: {
      count: open.length,
      tiers: Object.fromEntries(TIERS.map((tier) => [tier, open.filter((lesson) => lesson.tier === tier).length])),
      targets: { plugin: open.filter((l) => l.target === 'plugin').length, project: open.filter((l) => l.target === 'project').length, none: open.filter((l) => !l.target).length },
      auto: open.filter((lesson) => lesson.source === 'auto').length,
      reopened: open.filter((lesson) => lesson.reopened).length,
      oldest_days: open.length ? Math.max(...open.map((lesson) => ageDays(lesson.at, now)).filter(Number.isFinite), 0) : null,
    },
    window: {
      added: live.filter((lesson) => after(lesson.at)).length,
      seen_again: live.flatMap((lesson) => lesson.occurrences).filter((item) => after(item.at)).length,
      resolved: resolutions.length,
      outcomes: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, resolutions.filter((item) => item.outcome === outcome).length])),
      median_days_to_resolve: median(toResolve),
    },
    fixes: fixes.map((item) => ({
      id: item.lesson.id,
      title: item.lesson.title,
      outcome: item.outcome,
      at: item.at,
      link: item.link,
      expect: item.expect,
      recurred: item.recurred,
      held_days: item.recurred ? null : ageDays(item.at, now),
    })),
  };
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

const firstLine = (text) => String(text).split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
const cut = (text) => (text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text);
const texts = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fail(message) {
  console.error(message);
  return 1;
}
