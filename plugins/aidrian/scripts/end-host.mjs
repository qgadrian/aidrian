// Ends the host process of a session that handed its terminal to a background session (docs/handoff.md#replacing-the-terminal).
// The Stop hook starts it detached, as `end-host.mjs <host id> <pid> <shell pid> <delay ms>`; lib/terminal-replace.mjs
// endHost waits, checks the process is still the one that shell started, and sends the host's signal. It prints nothing.

import { endHost } from '../lib/terminal-replace.mjs';

const [host, pid, shell, delay] = process.argv.slice(2);
try {
  await endHost({ host, pid: Number(pid), shell: Number(shell), delay: Number(delay) });
} catch {
  // Nothing to report to: the session that started it has ended its turn.
}
