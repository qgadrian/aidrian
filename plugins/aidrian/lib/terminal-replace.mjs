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
const SHELLS = ['zsh'];
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

// The Stop hook's step: takes the request `take()` returns, { hostPid, shell, id } or null, and when this session's own
// environment confirms it, the shell's pid and the host process the shell started, writes the shell's record and starts
// the helper. `unattended()` says no Human attends this session. Returns whether the session is ending.
export function endAfterTurn({ host, take, unattended, env = process.env, now = Date.now(), run, start = startHelper }) {
  const replace = replacer(host);
  if (!replace) return false;
  const request = take();
  if (!request || unattended()) return false;
  const own = terminalOf(host, { env, run });
  if (!own || own.shell !== request.shell || own.hostPid !== request.hostPid) return false;
  if (!writeNext({ shell: own.shell, id: request.id, env, now })) return false;
  start({ host: host.id, pid: own.hostPid, shell: own.shell, delay: END_DELAY });
  return true;
}

// Starts scripts/end-host.mjs detached, so it outlives the hook and the host process it ends.
function startHelper({ host, pid, shell, delay }) {
  const child = spawn(process.execPath, [HELPER, host, String(pid), String(shell), String(delay)], { detached: true, stdio: 'ignore' });
  child.unref();
}

// The helper's step: after `delay` milliseconds, sends the signal of the host whose id is `host` to `pid`, when `pid`
// is still a host process the shell `shell` started, which a pid the system gave to another process since is not.
// Returns whether it sent it.
export async function endHost({ host, pid, shell, delay, hosts = HOSTS, kill = process.kill.bind(process), wait = sleep, run }) {
  const replace = replacer(hosts.find((each) => each.id === host) ?? { capabilities: {} });
  if (!replace || !isPid(pid) || !isPid(shell)) return false;
  if (Number.isInteger(delay) && delay > 0) await wait(delay);
  if (!replace.isHost({ pid, shell, run })) return false;
  kill(pid, replace.signal);
  return true;
}

// The shell function for `shell` that wraps each host program `hosts` can replace a terminal for, or null for a shell
// with none.
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
  for (const { program, attach } of replacers) lines.push(...zshFunction(program, attach));
  return `${lines.join('\n')}\n`;
}

// A zsh function named `program` that runs it with SHELL_VAR set, then, while this shell's record is a regular file
// this user owns, deletes it and opens the session it names when its id is plain and its expiry has not passed.
// It keeps the exit code of the last program it ran, and runs nothing from the record but that id.
function zshFunction(program, attach) {
  return [
    `${program}() {`,
    '  emulate -L zsh',
    `  local rc id expires base=$HOME/.local/state pattern='${OPEN_ID.source}'`,
    '  [[ $XDG_STATE_HOME == /* ]] && base=$XDG_STATE_HOME',
    `  local next=$base/aidrian/${TERMINAL_FOLDER}/$$`,
    `  ${SHELL_VAR}=$$ command ${program} "$@"`,
    '  rc=$?',
    '  while [[ -f $next && ! -L $next && -O $next ]]; do',
    '    id= expires=',
    '    IFS=\' \' read -r id expires < $next',
    '    command rm -f -- $next',
    '    [[ $id =~ $pattern && $expires =~ \'^[0-9]{1,12}$\' ]] || break',
    '    (( expires >= $(command date +%s) )) || break',
    `    ${SHELL_VAR}=$$ command ${program} ${attach} $id`,
    '    rc=$?',
    '  done',
    '  return $rc',
    '}',
  ];
}

export const commands = {
  'shell-init': {
    usage: 'zsh',
    about: 'print the shell function that opens the new session in the same terminal once a background handoff ends the old one; add `eval "$(aidrian shell-init zsh)"` to ~/.zshrc',
    run(args) {
      const text = args.length === 1 ? shellInit(args[0]) : null;
      if (text === null) {
        console.error(`usage: aidrian shell-init ${SHELLS.join(' | ')}`);
        return 2;
      }
      process.stdout.write(text);
      return 0;
    },
  },
};
