// Sets the switch lib/cli.mjs reads (IN_PROCESS) before anything imports it, so importing it exposes runCli without
// running a command. test/cli-call.mjs imports this file first; only test code ever sets the switch.
globalThis[Symbol.for('aidrian.test.cliInProcess')] = true;
