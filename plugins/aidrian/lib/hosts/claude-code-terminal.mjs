// Claude Code's side of replacing the terminal after a background handoff (docs/providers/claude-code.md#replacing-the-terminal).
// The shell function `aidrian shell-init` prints runs `claude` with AIDRIAN_SHELL_PID set to the shell's own pid, so the
// session's `claude` process is a child of that shell. On 2.1.326 the Bash tool's shell and every hook carry
// CLAUDE_PID, the session's `claude` process, and CLAUDE_CODE_SESSION_ATTENDED, `1` in an interactive session and `0` in
// a background one. A process is read with `ps -o pid=,ppid=,comm=` alone, never its arguments: on macOS a process that
// sets its own title shows its environment there. Every call goes through `run`, spawnSync's shape, which a test replaces.
//
// Probed on 2.1.326 in a pseudo-terminal, idle and in the middle of a turn: SIGTERM, SIGHUP, and SIGINT each end an
// interactive session within about 2 seconds, with its transcript saved through the last answer, the terminal restored,
// the resume line printed, and its SessionEnd hooks run within the short time it gives them, about 1.5 seconds, where a
// slower one is cancelled. SIGTERM is the signal whose meaning is to end; the session exits 143.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const PROGRAM = 'claude';
export const END_SIGNAL = 'SIGTERM';
const PS = '/bin/ps';
const PS_TIMEOUT = 5_000;
const LINE = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/u;

const isPid = (value) => Number.isInteger(value) && value > 1 && value < 2 ** 31;
export const runPs = (command, args, { timeout }) => spawnSync(command, args, { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The process `pid`: { pid, ppid, comm }, or null when `ps` cannot read it.
export function processOf(pid, run = runPs) {
  if (!isPid(pid)) return null;
  const result = run(PS, ['-o', 'pid=,ppid=,comm=', '-p', String(pid)], { timeout: PS_TIMEOUT });
  if (result.error || result.status !== 0) return null;
  const match = LINE.exec(String(result.stdout ?? '').split('\n')[0]);
  return match ? { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] } : null;
}

// Whether `pid` is a `claude` process the shell `shell` started itself. A background session's process is the
// supervisor's child, and its title is `claude bg-…`, so it never is one.
export function isWrappedHost({ pid, shell, run = runPs }) {
  if (!isPid(shell)) return false;
  const found = processOf(pid, run);
  return found !== null && found.pid === pid && found.ppid === shell && path.basename(found.comm) === PROGRAM;
}

// The `claude` process of the session whose environment is `env`, when a Human attends it and the shell `shell` started
// it: its pid, or null.
export function hostProcess({ env, shell, run = runPs }) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED !== '1' || !/^\d{1,10}$/u.test(env.CLAUDE_PID ?? '')) return null;
  const pid = Number(env.CLAUDE_PID);
  return isWrappedHost({ pid, shell, run }) ? pid : null;
}
