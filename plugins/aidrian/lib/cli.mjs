// The `aidrian` command: `aidrian <command> [args]`. Users run it through bin/aidrian.
// Each command maps to the module in this folder that exports it in `commands`: { name: { usage, about, run(args) → exit
// code } }. Only the module of the command that runs is imported.

const COMMANDS = {
  check: './check.mjs',
  init: './check.mjs',
  state: './check.mjs',
  'commit-msg': './commit-message.mjs',
  lint: './lint.mjs',
  lesson: './lesson-inbox.mjs',
  handoff: './handoff-brief.mjs',
  worktree: './worktree.mjs',
  pr: './pr.mjs',
};

const [command, ...args] = process.argv.slice(2);

if (!Object.hasOwn(COMMANDS, command ?? '')) await fail(command && `unknown command: ${command}`);
const { commands } = await import(COMMANDS[command]);
try {
  process.exitCode = await commands[command].run(args);
} catch (error) {
  // node:util parseArgs throws these for an unknown option or a missing value.
  if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
  await fail(error.message);
}

async function fail(problem) {
  const lines = ['usage: aidrian <command> [args]', ''];
  for (const [name, file] of Object.entries(COMMANDS)) {
    const { usage, about } = (await import(file)).commands[name];
    lines.push(`  aidrian ${name} ${usage}`.trimEnd(), `      ${about}`);
  }
  if (problem) lines.push('', problem);
  console.error(lines.join('\n'));
  process.exit(1);
}
