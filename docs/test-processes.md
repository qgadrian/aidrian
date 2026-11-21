# Test processes

How many child processes a test file may start, and how a test runs a command in its own process instead of starting one.
The rest of how the suite runs is in [contributing.md](contributing.md#build-and-check).

## Child-process budget

`test/child-process-budget.json` caps the child processes each test file may start, its `git` calls and its other
processes together, as the table after a run counts them: `{ "default": 300, "files": { "<name>.test.mjs": <count> } }`.
A file with no entry is held to the default. After a run whose tests passed, `scripts/run-tests.mjs` exits 1 when a file
that ran is over its budget, and names the file, its count, and its budget; a file that did not run is not judged.
A budget file that cannot be read or has another shape fails a run whose tests passed too, and names the budget file.
There is no budget on seconds, since one commit's time varies by more than half between runners.

Each entry is 1.5 times the largest count seen for the file, rounded up to the next 50, and only a file above 300 has one.
The counts come from one local run of the branch merged with main, since CI checks that merge, and from the pull
request's `Tests (Node N, S/2)` jobs with the budget on. A file's count is in its over-budget line, or in the table of
`npm test -- test/<name>.test.mjs`. The margin covers polling loops, such as the `ps` calls of `project-start-codex`,
and a machine with `claude` and `codex` on PATH, which runs more of `test/hosts.test.mjs`.

A file over its budget has two ways out. Run its commands and hooks in the test's process
([Commands](#commands-in-the-tests-process), [Hooks](contributing.md#hooks-in-the-tests-process)), or add or raise its entry, by the
same rule, in the same pull request, and say why in the pull request's description. A lowered count may lower its entry the same way.

## Commands in the test's process

`bin/aidrian` starts `lib/cli.mjs`, which sets the process's exit code to `await runCli(argv)`, its export that holds
the command table, the usage, and the error handling. It runs the command unless a switch that only test code sets is
on: `test/cli-in-process.mjs` sets `Symbol.for('aidrian.test.cliInProcess')` on `globalThis` before `lib/cli.mjs` loads,
so importing it exposes `runCli` without running a command. The switch is never read from the arguments or from how the
module was started, so a run that misses the check still runs the command. A test runs a command with
`await cliCall(args, { cwd, env })` (`test/cli-call.mjs`), which calls `runCli` in the test's own process and returns
spawnSync's `{ status, stdout, stderr }`, without starting a node process for each call. It swaps in the call's folder and
environment, keeps what the command writes to `process.stdout` and `process.stderr`, and starts and ends the call with no
stopped git call and no clone anchor, as `hookCall` ([Hooks in the test's process](contributing.md#hooks-in-the-tests-process)) does; afterwards the folder, the environment, both writes, and
`process.exitCode` are as they were, whether the command returned or threw. Calls run one at a time, and a second call
while one runs throws. An error `runCli` does not handle reaches the test, where a process prints it and exits 1, and a
command that calls `process.exit` throws to the test instead of ending the test run. A write from outside the call,
such as the test runner reporting an earlier test, goes to the stream as before. A command that reads stdin, with
`readFileSync(0)` or `readFileSync('/dev/stdin')`, throws to the test too: the test runner's stdin never closes, so the
read would hang the file until CI stops it. `cliCall` swaps `fs.readFileSync` for the call and back, with
`syncBuiltinESMExports` so a module's own `import { readFileSync } from 'node:fs'` sees both swaps.

Each command's module is imported once per test file, so a cache it keeps lasts across calls, where each process run
started fresh: `codexAvailable` (`lib/review/reviewers.mjs`) asks once whether Codex runs here, `guardedMain`
(`lib/rules/main-checkout/checkout.mjs`) reads each folder's guarded main checkout once, and `rootsOf`
(`lib/rules/main-checkout/directory-change.mjs`) each folder's checkout roots once. A test that changes what one of
them reads between two calls keeps a process run.

A test still runs `bin/aidrian` as a process where only a process shows the behaviour: a command that reads stdin
(`cliCall` throws when given `input`, or when the command reads it), exit timing, a signal or `timeout` it relies on, a deadline it measures, what
the test preload records about the processes a file starts, or output a child writes straight to the terminal's
descriptors. Keep at least one process run for each command a file tests, so the command's own entry stays tested;
a command the file only touches in passing, such as a row in a table of config errors, needs none.
