// Ends the host process of a session that handed its terminal to a background session (docs/handoff.md#replacing-the-terminal).
// The Stop hook starts it detached; lib/terminal-replace.mjs endHost waits, checks the process or session is still the
// one it names, and ends it. It prints nothing.

import { endHost } from '../lib/terminal-replace.mjs';

// `end-host.mjs <host id> pid <pid> <shell pid> <delay ms>` ends a host process; `end-host.mjs <host id> own <id>
// <session> <delay ms>` ends the background session the helper's own session is.
const [host, way, first, second, delay] = process.argv.slice(2);
const target = way === 'own' ? { own: first, session: second } : { pid: Number(first), shell: Number(second) };
try {
  await endHost({ host, ...target, delay: Number(delay) });
} catch {
  // Nothing to report to: the session that started it has ended its turn.
}
