// A subagent's long commands on Claude Code: how long one may run in the foreground, and the output of a background
// shell, for `aidrian wait` (lib/wait-cli.mjs). docs/providers/claude-code.md#long-commands has what was checked.
// The host keeps a background shell's output in `<temp>/claude-<uid>/<project>/<session>/tasks/<id>.output`, and ends it
// with a line of its own once the shell ended: `[exited with code N]`, or `[killed]`. Nothing else records the exit code.

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { processUid, tailText } from '../fs.mjs';

// In seconds: when the host moves a subagent's foreground command to the background, the longest one wait call may
// last, and the tool timeout that call asks for, each under the one before it in time: wait, toolTimeout, limit.
export const FOREGROUND = Object.freeze({ limit: 180, wait: 150, toolTimeout: 170 });

// How much of an output file's end is read: more than the last lines a wait prints, and never a whole large log.
export const TAIL = 16 * 1024;
const SESSION = /^[\w-]+$/u;
// The host's own last line, which it writes after a line end. An exit code is a 32-bit number.
const TRAILER = /\n\[(?:exited with code (?<code>-?\d{1,10}|unknown)|killed)\]\n$/u;

// The host's temp folder of this user, by its real path, or null when it is a link or no folder of this user's own.
// A folder above it may be a link, as /tmp is on macOS. CLAUDE_CODE_TMPDIR moves it, and in a sandboxed shell already
// names it whole.
function tempFolder(env, uid) {
  const base = path.resolve(env.CLAUDE_CODE_TMPDIR || '/tmp');
  const name = `claude-${uid}`;
  const folder = path.basename(base) === name ? base : path.join(base, name);
  const stat = lstatSync(folder);
  return stat.isDirectory() && stat.uid === uid ? realpathSync(folder) : null;
}

// Whether `file` is a regular file reached through no link: a background agent's entry is a link to its transcript.
function plainFile(file) {
  try {
    return realpathSync(file) === file && lstatSync(file).isFile();
  } catch {
    return false;
  }
}

// The output file of the background shell `id` of the session the command runs in, or null. Only that session's own
// `tasks` folder is searched, whichever project folder of the host's temp folder holds it: the host names the project
// folder after the folder the session started in, which a command started elsewhere cannot tell.
export function findTask({ id, env = process.env, uid = processUid() }) {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (typeof session !== 'string' || !SESSION.test(session) || !SESSION.test(id)) return null;
  try {
    const temp = tempFolder(env, uid);
    if (temp === null) return null;
    const found = readdirSync(temp).map((project) => path.join(temp, project, session, 'tasks', `${id}.output`)).filter(plainFile);
    return found.length === 1 ? found[0] : null;
  } catch {
    return null;
  }
}

// What the output file `file` (findTask) says now: { ended, killed, exitCode, output }, `exitCode` null when the host
// wrote none, and `output` the end of the output without the host's own last line; or null when it cannot be read.
// A command can print that line itself, so it counts only as the file's last: one still running whose latest output is
// that line reads as ended, and one that printed more after it was killed reads as running, known limits.
export function readTask(file, uid = processUid()) {
  // A race with another process of the same user is accepted here.
  const text = plainFile(file) ? tailText(file, TAIL, uid) : null;
  if (text === null) return null;
  const trailer = TRAILER.exec(text);
  if (!trailer) return { ended: false, killed: false, exitCode: null, output: text };
  const { code } = trailer.groups;
  return {
    ended: true,
    killed: code === undefined,
    exitCode: code === undefined || code === 'unknown' ? null : Number(code),
    output: text.slice(0, trailer.index),
  };
}
