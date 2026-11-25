// The `aidrian` command: `aidrian <command> [args]`. Users run it through bin/aidrian.
// Each command maps to the module in this folder that exports it in `commands`: { name: { usage, about, run(args) → exit
// code } }. Only the module of the command that runs is imported.

import { CONFIG_ERROR } from './config.mjs';
import { LOCKED } from './jsonl.mjs';
import { usageLines, wrap } from './usage.mjs';

const COMMANDS = {
  check: './check.mjs',
  init: './check.mjs',
  state: './check.mjs',
  'commit-msg': './commit-message.mjs',
  'pre-commit': './main-commits.mjs',
  lint: './lint.mjs',
  lesson: './lesson-cli.mjs',
  audits: './audits-cli.mjs',
  handoff: './handoff-brief.mjs',
  'push-preflight': './push-preflight.mjs',
  session: './session-snapshot.mjs',
  sessions: './sessions-cli.mjs',
  worktree: './worktree.mjs',
  pr: './pr.mjs',
  review: './review/bench.mjs',
  quorum: './quorum.mjs',
  decisions: './decisions-cli.mjs',
  plan: './plan-cli.mjs',
  report: './report.mjs',
  project: './project-run-cli.mjs',
  'shell-init': './shell-init.mjs',
  test: './test-changed.mjs',
  wait: './wait-cli.mjs',
};

// The switch only test code sets (test/cli-in-process.mjs), before it imports this module, to call runCli in its own
// process (test/cli-call.mjs). Unset, as it always is when bin/aidrian starts this file, the command runs.
export const IN_PROCESS = Symbol.for('aidrian.test.cliInProcess');

// The exit code of `aidrian <argv>`: the usage with 0, or with 1 on an unknown command or option, or what the command
// returns. An error no case below names is thrown, as the process prints it and exits 1.
export async function runCli(argv) {
  const [command, ...args] = argv;
  if (['--help', '-h', 'help'].includes(command)) {
    console.log(await usage());
    return 0;
  }
  if (!Object.hasOwn(COMMANDS, command ?? '')) return fail(command && `unknown command: ${command}`);
  const { commands } = await import(COMMANDS[command]);
  try {
    return await commands[command].run(args);
  } catch (error) {
    if (error.code === CONFIG_ERROR) {
      // config.json has errors, so the command stopped before it acted (config.mjs commandConfig).
      console.error(error.message);
      return error.exitCode;
    }
    if (error.code === LOCKED) {
      // Another process held a file's lock past the wait (jsonl.mjs withLocks): nothing was written.
      console.error(error.message);
      return 1;
    }
    // node:util parseArgs throws these for an unknown option or a missing value.
    if (error.code?.startsWith('ERR_PARSE_ARGS')) return fail(error.message);
    throw error;
  }
}

// Every command with its arguments, one line for each form, and what it does.
async function usage() {
  const lines = ['usage: aidrian <command> [args]', ''];
  for (const [name, file] of Object.entries(COMMANDS)) {
    const { usage: args, about } = (await import(file)).commands[name];
    lines.push(...usageLines(name, args, '  '), ...wrap(`      ${about}`, '      '));
  }
  return lines.join('\n');
}

async function fail(problem) {
  console.error(problem ? `${await usage()}\n\n${problem}` : await usage());
  return 1;
}

if (globalThis[IN_PROCESS] !== true) process.exitCode = await runCli(process.argv.slice(2));
