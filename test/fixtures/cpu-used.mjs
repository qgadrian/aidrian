// A preload for a command a test runs as a program, `node --import <this file> <cli>`: when the process exits, it writes
// process.cpuUsage(), { user, system } in microseconds, as JSON to the file CPU_USED_LOG names. The processor time the
// command spent is the work it did, which a loaded machine stretches far less than its wall time, so a test can bound it.
// It counts this process alone, not the children it started.
// node --test also runs every file under test/ as a test file: with no CPU_USED_LOG it changes nothing, and it has no tests.

import { writeFileSync } from 'node:fs';

const log = process.env.CPU_USED_LOG;
if (log) process.on('exit', () => writeFileSync(log, JSON.stringify(process.cpuUsage())));
