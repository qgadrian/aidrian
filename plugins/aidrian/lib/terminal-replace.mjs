// Replacing the terminal after a background handoff (docs/handoff.md#replacing-the-terminal). A session that handed
// its work to a background session ends itself once its turn ends, and the shell that ran it opens the new session in
// the same terminal, with nothing typed. It needs the shell function `aidrian shell-init <shell>` prints, which the
// Human evals in the shell's startup file: the function runs the host's program with SHELL_VAR set to the shell's pid,
// and once the program exits it reads and deletes this shell's record, and opens the session the record names.
//   1. The gate (lib/handoff-continue.mjs), once the background session started, asks terminalOf whether the host
//      process was started by that function's shell and a Human attends it, and notes the request in the continuation
//      store (handoff-markers.mjs noteEnding), which no subagent or unattended session may write.
//   2. The Stop hook takes the request (endAfterTurn), checks it again against its own environment, writes the shell's
//      record, and starts a detached helper, scripts/end-host.mjs, which waits END_DELAY for the turn to settle and
//      sends the host's signal to the host process (endHost), when it is still the one that shell started.
//   3. The shell function reads `<state root>/handoff-terminals/<shell pid>`, `<id> <expiry in epoch seconds>`, deletes
//      it, and opens the session `id` when it is fresh and `id` is plain, again after that session's program exits.
// The next hops chain the same way. When a session ends itself, the Stop hook also notes in the store that the shell's
// terminal now follows the new session (handoff-markers.mjs noteFollow). That session runs in the background, so no
// Human attends it as the hooks know it, and it carries no SHELL_VAR; when it hands off in turn, the gate notes a
// request that names its own id instead of a host process, only when the store says a terminal follows it, and its Stop
// hook ends that session alone, through the host's own stop command (replaceTerminal.endOwn), never another process.
// Its `claude attach` in the shell then exits, and the shell function opens the next one. The chain floor and its cap
// bound the hops. This is a provisional decision of the harness: dropping the second way of ending, `own`, puts the
// later hops back on the plain line the Human acts on.
// Which host process, which signal, and which program and words open a session are the host adapter's
// `capabilities.handoffContinue.replaceTerminal`; this file names no host.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOSTS } from './hosts/index.mjs';
import { stateRoot } from './project.mjs';

export const TERMINAL_FOLDER = 'handoff-terminals';
// The variable the shell function sets for the host's program: the shell's own pid.
export const SHELL_VAR = 'AIDRIAN_SHELL_PID';
// How long a shell's record holds: the shell reads it the moment the host's program exits.
export const NEXT_WINDOW = 60 * 1000;
// How long the helper waits after the Stop hook, so the host finishes its other Stop hooks and shows the last message.
export const END_DELAY = 2000;
// An id the shell function opens; the shell function holds it to the same pattern.
export const OPEN_ID = /^[0-9A-Za-z][-_0-9A-Za-z]{3,127}$/u;
const WORD = /^[a-z][a-z0-9-]{0,31}$/u;
export const SHELLS = ['zsh', 'bash'];
const HELPER = path.resolve(import.meta.dirname, '../scripts/end-host.mjs');

const isPid = (value) => Number.isInteger(value) && value > 1 && value < 2 ** 31;
export const replacer = (host) => host.capabilities.handoffContinue?.replaceTerminal ?? null;

// The pid of the shell whose function started this session's host program, from `env`, or null.
export function shellPid(env) {
  const text = env[SHELL_VAR];
  return typeof text === 'string' && /^\d{1,10}$/u.test(text) && isPid(Number(text)) ? Number(text) : null;
}

// The terminal a session of `host` with the environment `env` can hand over: { hostPid, shell } when the host can
// replace a terminal, the shell function started its program, and a Human attends it; else null.
export function terminalOf(host, { env, run }) {
  const replace = replacer(host);
  const shell = shellPid(env);
  if (!replace || shell === null) return null;
  const hostPid = replace.hostProcess({ env, shell, run });
  return isPid(hostPid) ? { hostPid, shell } : null;
}

// The session start's line for an attended session the shell function did not start, on a host that can replace a
// terminal, while this machine's switch `background` is on and the working config's `handoff` resolves to the
// background route in `auto` mode: after a handoff its terminal would stay on the old session. Else null.
export function unwrappedLine({ host, background, handoff, env, human }) {
  const replace = replacer(host);
  if (!replace || background !== 'on' || handoff?.mode !== 'auto' || handoff?.continue !== 'background') return null;
  if (shellPid(env) !== null || !replace.attended(env)) return null;
  return `Handoff terminal: this machine's background handoff route is on, but the aidrian shell function did not start this session's \`${replace.program}\`, ` +
    `so after a background handoff this terminal stays on the old session beside the new one. For it to follow, ${human} runs ` +
    '`aidrian shell-init zsh --install` once, or `aidrian shell-init bash --install` for bash, and opens a new terminal. ' +
    'A copy of the plugin older than this one answers `unknown command: shell-init`: the plugin is updated first.';
}

// The folder shell records live in, under the state root `env` names.
export const terminalFolder = (env = process.env) => path.join(stateRoot(env), TERMINAL_FOLDER);

// Writes the record of the shell `shell`: open the session `id` before the end of NEXT_WINDOW. Owner-only, through a
// temporary file and a rename, in a folder that is the user's alone. Returns the file, or null. Never throws.
export function writeNext({ shell, id, env = process.env, now = Date.now() }) {
  if (!isPid(shell) || typeof id !== 'string' || !OPEN_ID.test(id)) return null;
  try {
    const folder = terminalFolder(env);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
    const file = path.join(folder, String(shell));
    const temporary = path.join(folder, `.${shell}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temporary, `${id} ${Math.floor((now + NEXT_WINDOW) / 1000)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return file;
  } catch {
    return null;
  }
}

// The Stop hook's step, in the session `session`: takes the request `take()` returns, as handoff-markers.mjs takeEnding,
// or null, and when this session's own facts confirm it, writes the shell's record, notes through `follow` that the
// shell's terminal follows the next session, and starts the helper. `unattended()` says no Human attends this session.
// An attended session's request names its host process, which its own environment must name as the shell's child; a
// background session's names its own id, which `session` must start with, on a host that can end its own session.
// Returns whether the session is ending.
export function endAfterTurn({ host, session, take, unattended, follow = () => null, env = process.env, now = Date.now(), run, start = startHelper }) {
  const replace = replacer(host);
  if (!replace) return false;
  const request = take();
  if (!request) return false;
  const ending = request.own === undefined ? ownProcess({ host, request, unattended, env, run }) : ownSession({ replace, request, session, unattended });
  if (!ending || !writeNext({ shell: request.shell, id: request.id, env, now })) return false;
  follow({ session: request.next ?? request.id, shell: request.shell });
  start({ host: host.id, ...ending, delay: END_DELAY });
  return true;
}

// The helper's arguments for an attended session whose own environment names the request's shell and host process.
function ownProcess({ host, request, unattended, env, run }) {
  if (unattended()) return null;
  const own = terminalOf(host, { env, run });
  return own && own.shell === request.shell && own.hostPid === request.hostPid ? { pid: own.hostPid, shell: own.shell } : null;
}

// The helper's arguments for a background session whose own id `session` is the request's, or starts with it.
function ownSession({ replace, request, session, unattended }) {
  if (typeof replace.endOwn !== 'function' || typeof session !== 'string' || !unattended()) return null;
  return session === request.own || session.startsWith(request.own) ? { own: request.own, session } : null;
}

// Starts scripts/end-host.mjs detached, so it outlives the hook and the session it ends: `pid <pid> <shell>` for a host
// process, `own <id> <session>` for a background session's own.
function startHelper({ host, pid, shell, own, session, delay }) {
  const way = own === undefined ? ['pid', String(pid), String(shell)] : ['own', own, session];
  const child = spawn(process.execPath, [HELPER, host, ...way, String(delay)], { detached: true, stdio: 'ignore' });
  child.unref();
}

// The helper's step, after `delay` milliseconds, for the host whose id is `host`. With `pid`, it sends the host's signal
// to `pid` when it is still a host process the shell `shell` started, which a pid the system gave to another process
// since is not. With `own`, it ends the background session `session`, listed under `own`, through the host
// (replaceTerminal.endOwn), which ends nothing the host does not list as that very session. Returns whether it ended it.
export async function endHost({ host, pid, shell, own, session, delay, env = process.env, hosts = HOSTS, kill = process.kill.bind(process), wait = sleep, run }) {
  const replace = replacer(hosts.find((each) => each.id === host) ?? { capabilities: {} });
  if (!replace) return false;
  const byId = own !== undefined;
  const named = byId ? canEndOwn(replace, own, session) : isPid(pid) && isPid(shell);
  if (!named) return false;
  if (Number.isInteger(delay) && delay > 0) await wait(delay);
  if (byId) return replace.endOwn({ id: own, session, env, run }) === true;
  if (!replace.isHost({ pid, shell, run })) return false;
  kill(pid, replace.signal);
  return true;
}

const canEndOwn = (replace, own, session) => typeof replace.endOwn === 'function' && typeof own === 'string' && OPEN_ID.test(own)
  && typeof session === 'string' && /^[\w-]{1,128}$/u.test(session);

// The shell function for `shell`, one of SHELLS, that wraps each host program `hosts` can replace a terminal for, or null
// for another shell.
export function shellInit(shell, hosts = HOSTS) {
  if (!SHELLS.includes(shell)) return null;
  const replacers = hosts.map(replacer).filter(Boolean);
  for (const { program, attach } of replacers) {
    if (!WORD.test(program) || !WORD.test(attach)) throw new Error(`a host's program or attach word is not a plain word: ${program} ${attach}`);
  }
  const lines = [
    `# aidrian shell-init ${shell}: once a session that handed off ends itself, open the new one in this terminal.`,
    '# docs/handoff.md#replacing-the-terminal',
  ];
  for (const { program, attach } of replacers) lines.push(...shellFunction(shell, program, attach));
  return `${lines.join('\n')}\n`;
}

// A function named `program` that runs it with SHELL_VAR set, then, while this shell's record is a regular file this
// user owns, deletes it and opens the session it names when its id is plain and its expiry has not passed. It keeps the
// exit code of the last program it ran, and runs nothing from the record but that id. zsh and bash read the same body;
// zsh first resets its options for the function, so a setting such as RE_MATCH_PCRE cannot change the patterns.
function shellFunction(shell, program, attach) {
  return [
    `${program}() {`,
    ...(shell === 'zsh' ? ['  emulate -L zsh'] : []),
    `  local rc id expires base=$HOME/.local/state pattern='${OPEN_ID.source}' digits='^[0-9]{1,12}$'`,
    '  [[ $XDG_STATE_HOME == /* ]] && base=$XDG_STATE_HOME',
    `  local next=$base/aidrian/${TERMINAL_FOLDER}/$$`,
    `  ${SHELL_VAR}=$$ command ${program} "$@"`,
    '  rc=$?',
    '  while [[ -f $next && ! -L $next && -O $next ]]; do',
    '    id= expires=',
    "    IFS=' ' read -r id expires < \"$next\"",
    '    command rm -f -- "$next"',
    '    [[ $id =~ $pattern && $expires =~ $digits ]] || break',
    '    (( expires >= $(command date +%s) )) || break',
    `    ${SHELL_VAR}=$$ command ${program} ${attach} "$id"`,
    '    rc=$?',
    '  done',
    '  return $rc',
    '}',
  ];
}
