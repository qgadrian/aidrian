// The `aidrian` command: `aidrian <command> [args]`. Users run it through bin/aidrian.
// Each command maps to the module in this folder that exports it in `commands`: { name: { usage, about, run(args) → exit
// code } }. Only the module of the command that runs is imported.

import { CONFIG_ERROR } from './config.mjs';
import { usageLines, wrap } from './usage.mjs';

const COMMANDS = {
  check: './check.mjs',
  init: './check.mjs',
  state: './check.mjs',
  'commit-msg': './commit-message.mjs',
  lint: './lint.mjs',
  lesson: './lesson-cli.mjs',
  handoff: './handoff-brief.mjs',
  worktree: './worktree.mjs',
  pr: './pr.mjs',
  review: './review/bench.mjs',
  quorum: './quorum.mjs',
  report: './report.mjs',
};

const [command, ...args] = process.argv.slice(2);

if (['--help', '-h', 'help'].includes(command)) {
  console.log(await usage());
  process.exit(0);
}
if (!Object.hasOwn(COMMANDS, command ?? '')) await fail(command && `unknown command: ${command}`);
const { commands } = await import(COMMANDS[command]);
try {
  process.exitCode = await commands[command].run(args);
} catch (error) {
  if (error.code === CONFIG_ERROR) {
    // config.json has errors, so the command stopped before it acted (config.mjs commandConfig).
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else if (error.code?.startsWith('ERR_PARSE_ARGS')) {
    // node:util parseArgs throws these for an unknown option or a missing value.
    await fail(error.message);
  } else {
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
  process.exit(1);
}
