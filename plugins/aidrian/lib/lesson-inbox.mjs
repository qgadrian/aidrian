// `aidrian lesson`: the lesson inbox, a JSON Lines queue in the state folder (lessons/inbox.jsonl), shared by every
// worktree and clone of the repository. Capturing a lesson is one command, cheap enough to run the moment something
// goes wrong; deciding what it becomes (a hook, a rule, an issue, nothing) is the lesson-triage skill's job, later.
// The file is only ever appended to: a resolution is a row of its own, so no session's write can drop another's.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runGit } from './git.mjs';
import { appendRow, readRows } from './jsonl.mjs';
import { projectAt, stateDir } from './project.mjs';

export const KINDS = ['harness', 'product', 'process'];
export const OUTCOMES = ['mechanism', 'rule', 'issue', 'duplicate', 'dropped'];

const OPTIONS = {
  project: { type: 'string' },
  kind: { type: 'string' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  outcome: { type: 'string' },
  link: { type: 'string' },
};

export const commands = {
  lesson: {
    usage: `add [--kind ${KINDS.join('|')}] | list [--all] [--json] | resolve ID --outcome ${OUTCOMES.join('|')} [--link REF|-] | nudge`,
    about: 'capture a lesson from stdin (leading "evidence: <ref>" lines, then the note), list them, or resolve one',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS });
      const [action, id, ...extra] = positionals;
      const file = inboxPath(projectAt(path.resolve(values.project ?? '.')));
      const fail = (message) => {
        console.error(message);
        return 1;
      };
      if (extra.length || (action !== 'resolve' && id !== undefined)) return fail(`unexpected argument: ${[id, ...extra].filter(Boolean).at(-1)}`);
      if (action === 'nudge') {
        const line = nudge(file);
        if (line) console.log(line);
        return 0;
      }
      if (action === 'list') {
        const entries = lessons(file).filter((row) => values.all || row.status === 'open');
        if (values.json) console.log(JSON.stringify(entries));
        else console.log(entries.length ? entries.map(format).join('\n') : `no ${values.all ? '' : 'open '}lessons in ${file}`);
        return 0;
      }
      if (action === 'add') {
        if (values.kind !== undefined && !KINDS.includes(values.kind)) return fail(`--kind must be one of ${KINDS.join(', ')}`);
        const { note, evidence } = parseCapture(readFileSync(0, 'utf8'));
        if (!note) return fail('the lesson needs a note on stdin, after any "evidence: <ref>" lines');
        const entry = makeEntry({ note, evidence, kind: values.kind ?? null });
        appendRow(file, entry);
        console.log(values.json ? JSON.stringify(entry) : entry.id);
        return 0;
      }
      if (action === 'resolve') {
        if (!id) return fail('resolve needs the lesson id');
        if (!OUTCOMES.includes(values.outcome)) return fail(`resolve needs --outcome ${OUTCOMES.join('|')}`);
        const link = values.link === '-' ? readFileSync(0, 'utf8').trim() : values.link ?? null;
        const entry = resolveEntry(file, { id, outcome: values.outcome, link: link || null });
        if (!entry) return fail(`no open lesson with id ${id}`);
        console.log(values.json ? JSON.stringify(entry) : `${entry.id} -> ${entry.outcome}`);
        return 0;
      }
      return fail(`usage: aidrian lesson ${commands.lesson.usage}`);
    },
  },
};

export function inboxPath(project) {
  return path.join(stateDir(project), 'lessons', 'inbox.jsonl');
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

// One open lesson, with where it was captured: the worktree, the branch, and the agent, so triage can find the context.
export function makeEntry({ note, evidence = [], kind = null, cwd = process.cwd(), env = process.env, now = new Date() }) {
  const git = (args) => {
    const { status, stdout } = runGit(args, cwd);
    return status === 0 ? stdout.trim() || null : null;
  };
  return {
    id: randomBytes(4).toString('hex'),
    at: now.toISOString(),
    note,
    kind,
    evidence,
    worktree: git(['rev-parse', '--show-toplevel']),
    branch: git(['branch', '--show-current']),
    agent: env.CLAUDE_CODE_AGENT ?? null,
    status: 'open',
  };
}

// Every lesson in capture order, each with its latest resolution applied. A row whose `id` an earlier row already used
// updates that lesson; any other row is a new one.
export function lessons(file) {
  const byId = new Map();
  for (const row of readRows(file).rows) byId.set(row.id, byId.has(row.id) ? { ...byId.get(row.id), ...row } : row);
  return [...byId.values()];
}

// Resolves the open lesson `id` by appending its resolution, and returns the lesson as resolved; null when no lesson
// with that id is open. Two resolves at once both land, and the later row wins.
export function resolveEntry(file, { id, outcome, link = null, now = new Date() }) {
  const lesson = lessons(file).find((row) => row.id === id && row.status === 'open');
  if (!lesson) return null;
  const resolution = { id, status: 'resolved', resolvedAt: now.toISOString(), outcome, link };
  appendRow(file, resolution);
  return { ...lesson, ...resolution };
}

// The SessionStart line, or '' when no lesson is open. `command` is how the agent runs the aidrian command.
export function nudge(file, command = 'aidrian') {
  const open = lessons(file).filter((row) => row.status === 'open');
  if (!open.length) return '';
  const oldest = String(open[0].at ?? '').slice(0, 10);
  return `Lesson inbox: ${open.length} open lesson${open.length === 1 ? '' : 's'} (oldest ${oldest}). ` +
    `Run the lesson-triage skill in a session opened for it; \`${command} lesson list\` shows them.`;
}

function format(entry) {
  const lines = [`${entry.id}  ${String(entry.at).slice(0, 10)}  [${entry.status}${entry.outcome ? `: ${entry.outcome}` : ''}]  ${entry.note}`];
  const where = [entry.agent, entry.branch].filter(Boolean).join(' @ ');
  if (where) lines.push(`          ${where}`);
  for (const item of entry.evidence ?? []) lines.push(`          evidence: ${item}`);
  if (entry.link) lines.push(`          link: ${entry.link}`);
  return lines.join('\n');
}
