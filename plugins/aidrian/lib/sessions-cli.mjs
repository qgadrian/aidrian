// `aidrian sessions idle [--json]`: the background sessions the harness started, handoff continuations and project run
// attempts, that a host still holds while idle, their turn ended or waiting on a response, each with its age and the
// host's line that says how to stop it (docs/handoff.md#idle-sessions). A session counts as the harness's when an
// unattended mark names it (unattended-mark.mjs listMarks), and as idle only when its host's listing says so
// (hosts/index.mjs backgroundList).
// It is read-only: it calls no stop, writes no file, and sweeps no mark.

import { parseArgs } from 'node:util';

import { PLAIN_NAME, SESSION_ID } from './handoff-markers.mjs';
import { plainLine } from './hidden-text.mjs';
import { backgroundList, hostName, HOSTS } from './hosts/index.mjs';
import { listMarks, markNames } from './unattended-mark.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'idle [--json]';
const MINUTE = 60 * 1000;

export const commands = {
  sessions: {
    usage: USAGE,
    about: 'list the background sessions the harness started that a host still holds while idle, their turn ended or waiting on a response, with the line that stops each; it stops nothing',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (positionals.length !== 1 || positionals[0] !== 'idle') {
        console.error(usageLines('sessions', USAGE, 'usage: ').join('\n'));
        return 1;
      }
      const read = idleSessions();
      console.log(values.json ? JSON.stringify(read) : plainLines(read).join('\n'));
      return 0;
    },
  },
};

// The idle background sessions each of `hosts` holds that a mark names, oldest first, and a note for each host whose
// listing gave none: { idle: [{ host, id, session, name, cwd, startedAt, ageMs, waiting, kind, run, issue, root, stop }],
// notes: [{ host, problem, byDesign }] }. `host` is the host's name; `startedAt` the host's start time, else the mark's;
// `kind` 'continuation' or 'attempt', with `run` and `issue` the attempt's; `stop` the host's stop line, or null when
// the id is not safe to print (SESSION_ID) or the host gives none. A name that is not plain words, a folder that is not
// printable (printableFolder), and a stop line that holds a hidden character, read null.
// It asks each host's `list` and `stopLine` and nothing else. `home` is a test's, as in unattended-mark.mjs markFolders.
export function idleSessions({ hosts = HOSTS, env = process.env, home, now = Date.now(), run } = {}) {
  const marks = listMarks({ env, home, now });
  const idle = [];
  const notes = [];
  for (const host of hosts) {
    const name = hostName(host);
    const read = backgroundList(host, { env, run });
    if (!Array.isArray(read.sessions)) {
      notes.push({ host: name, problem: read.problem ?? read.unsupported, byDesign: read.byDesign === true });
      continue;
    }
    for (const row of read.sessions.filter((each) => each.idle)) {
      const mark = markNaming(marks, row.session);
      if (mark) idle.push(idleRow({ host, name, row, mark, now }));
    }
  }
  return { idle: idle.sort((a, b) => b.ageMs - a.ageMs), notes };
}

// The mark filed under the full id `session`, else under a short id it starts with (unattended-mark.mjs markNames),
// or null.
function markNaming(marks, session) {
  if (typeof session !== 'string') return null;
  return marks.find((mark) => mark.session === session) ?? marks.find((mark) => markNames(mark.session, session)) ?? null;
}

// One idle session, from `row` as backgroundList cleaned it and the mark that names it, whose fields no wrapper read.
function idleRow({ host, name, row, mark, now }) {
  const startedAt = row.startedAt ?? mark.at;
  const attempt = typeof mark.issue === 'string';
  return {
    host: name,
    id: row.id,
    session: row.session,
    name: plainName(row.name),
    cwd: printableFolder(row.cwd) ?? printableFolder(plainLine(mark.cwd)),
    startedAt,
    ageMs: Math.max(0, now - startedAt),
    waiting: row.waiting,
    kind: attempt ? 'attempt' : 'continuation',
    run: attempt ? mark.project : null,
    issue: attempt ? mark.issue : null,
    root: plainLine(mark.root),
    stop: SESSION_ID.test(row.id) ? stopLineOf(host, row.id) : null,
  };
}

// The host's stop line for `id`, read through a guard, or null when it throws or gives no line of plain text.
function stopLineOf(host, id) {
  try {
    return plainLine(host.capabilities.backgroundSessions.stopLine({ id }));
  } catch {
    return null;
  }
}

// A session's name as the line quotes it: only plain words (handoff-markers.mjs PLAIN_NAME), as every other line that
// quotes a session's name holds it, so no quote or backtick in it can read as a second stop line.
const plainName = (name) => (typeof name === 'string' && PLAIN_NAME.test(name) ? name : null);

// A folder the line prints after `in`, given as one line of plain text (backgroundList's, or the mark's through
// plainLine): only one with no backtick and no colon and space, so no part of it can read as a second stop line.
const printableFolder = (folder) => (typeof folder === 'string' && !folder.includes('`') && !folder.includes(': ') ? folder : null);

// The lines a person reads (docs/handoff.md#idle-sessions): `none` when no session is idle and no host
// failed, one `idle` line for each session, and one `note` line for each host whose listing failed. A host that holds
// none by design is left out; --json carries it.
export function plainLines({ idle, notes }) {
  const failed = notes.filter((note) => !note.byDesign);
  const lines = idle.map(idleLine);
  if (!lines.length && !failed.length) lines.push('none');
  return [...lines, ...failed.map((note) => `note ${note.host}: ${note.problem}`)];
}

// One `idle` line. An id unsafe to print gives way to the full session id, when that one is safe.
function idleLine(each) {
  const safe = [each.id, each.session].find((id) => typeof id === 'string' && SESSION_ID.test(id));
  const id = safe ?? 'unnamed';
  const what = [each.kind === 'attempt' ? `attempt of ${each.issue} in run ${each.run}` : 'handoff continuation'];
  if (each.name) what.push(`'${each.name}'`);
  if (each.cwd) what.push(`in ${each.cwd}`);
  if (each.waiting) what.push('(waiting on a response)');
  const stop = each.stop ?? `${each.host} gave no stop line it is safe to print`;
  return `idle ${id} ${ageText(each.ageMs)} ${what.join(' ')}: ${stop}`;
}

// An age for a person: `<m>m` under an hour, `<h>h<mm>m` under a day, else `<d>d<h>h`.
export function ageText(ms) {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
