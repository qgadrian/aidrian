// A preload for a hook a test runs as a program, `node --import <this file> <hook>`: Date.now stands still at the moment
// the process started (performance.timeOrigin), so every deadline the hook measures with Date.now from its own start,
// such as the ready hold's (deadlineForge, from `startedAt`), sees no time pass however slowly a loaded machine starts
// the hook and its gh. The hook's code is the shipped one: only this test-owned preload changes the clock.
// node --test also runs every file under test/ as a test file: here that only freezes its own worker's clock, and it has
// no tests.

const started = performance.timeOrigin;
Date.now = () => started;
