// A preload for a hook a test runs as a program, `node --import <this file> <hook>`: performance.now stands still at
// FROZEN_PERFORMANCE_MS milliseconds, so a time budget the hook counts from its own start with performance.now, such as
// the guards' (lib/deadline.mjs), sees exactly that much time spent, however slowly a loaded machine starts the hook and
// runs its reads. 0 is a hook whose budget never runs out; a budget's length plus a little is one past it. The hook's
// code is the shipped one: only this test-owned preload changes the clock.
// node --test also runs every file under test/ as a test file: with no FROZEN_PERFORMANCE_MS it changes nothing, and it
// has no tests.

const frozen = process.env.FROZEN_PERFORMANCE_MS;
if (frozen !== undefined) {
  const at = Number(frozen);
  performance.now = () => at;
}
