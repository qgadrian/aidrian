// The `aidrian` command: `aidrian <group> <command> [args]`. Users run it through bin/aidrian.
// Each group is a module in this folder that exports `commands`: { name: { usage, about, run(args) → exit code } }.
// Only the module of the group that runs is imported.

const GROUPS = {
  config: './config.mjs',
};

const [group, command, ...args] = process.argv.slice(2);

if (!Object.hasOwn(GROUPS, group ?? '')) await fail(group && `unknown group: ${group}`);
const { commands } = await import(GROUPS[group]);
if (!Object.hasOwn(commands, command ?? '')) await fail(`unknown command: ${group} ${command ?? ''}`.trimEnd());
try {
  process.exitCode = await commands[command].run(args);
} catch (error) {
  // node:util parseArgs throws these for an unknown option or a missing value.
  if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
  await fail(error.message);
}

async function fail(problem) {
  const lines = ['usage: aidrian <group> <command> [args]', ''];
  for (const [name, file] of Object.entries(GROUPS)) {
    for (const [sub, { usage, about }] of Object.entries((await import(file)).commands)) {
      lines.push(`  aidrian ${name} ${sub} ${usage}`.trimEnd(), `      ${about}`);
    }
  }
  if (problem) lines.push('', problem);
  console.error(lines.join('\n'));
  process.exit(1);
}
