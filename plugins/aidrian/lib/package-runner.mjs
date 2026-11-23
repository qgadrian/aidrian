// The program a package runner runs, as `npx codex login` runs codex: read by the guard of a session's own config writes
// (unattended-shell.mjs) and the guard of a host session's start (handoff-guard.mjs hostSessionStartDenial), so both
// read `npx @anthropic-ai/claude-code -p` as the program its package installs. It reads no file when loaded: hooks load it.

import path from 'node:path';

import { packagePrograms } from './hosts/index.mjs';

// The package runners that run another program, each program's forms { words, options }: `words`, the runner's own
// words before the program, and `options`, its options that take the next word.
const RUNNERS = Object.freeze({
  npx: [{ words: [], options: ['-p', '--package', '-c', '--call'] }],
  bunx: [{ words: [], options: ['-p', '--package'] }],
  npm: [{ words: ['exec'], options: ['-p', '--package', '-c', '--call', '-w', '--workspace'] }, { words: ['x'], options: ['-p', '--package', '-c', '--call'] }],
  pnpm: [{ words: ['dlx'], options: ['--package', '-C', '--dir'] }, { words: ['exec'], options: ['-C', '--dir', '--filter', '-F'] }],
  yarn: [{ words: ['dlx'], options: ['-p', '--package'] }],
});
// A package whose program has another name than its last part, as `npx @changesets/cli publish` runs `changeset`, and
// each host's own packages (hosts/index.mjs packagePrograms), as `npx @anthropic-ai/claude-code` runs `claude`.
const PACKAGE_PROGRAMS = Object.freeze({ '@changesets/cli': 'changeset', ...packagePrograms() });

// The program a call to `program` with the arguments `args` runs and the arguments it gets, through a package runner:
// { program, args }, or the call as it is when `program` is no runner, or the program it runs is not plain text. `word`
// reads an argument's text, null for one built at run time, so a list of plain words and the lexer's tokens both read.
export function unwrapped(program, args, word = (each) => each) {
  const words = args.map(word);
  const operands = words.filter((text) => text !== null && !text.startsWith('-'));
  const runner = (RUNNERS[program] ?? []).find((each) => each.words.every((runnerWord, i) => operands[i] === runnerWord));
  if (!runner) return { program, args };
  const rest = [...args];
  for (const runnerWord of runner.words) rest.splice(rest.findIndex((each) => word(each) === runnerWord), 1);
  let at = 0;
  while (at < rest.length && word(rest[at])?.startsWith('-')) at += runner.options.includes(word(rest[at])) ? 2 : 1;
  const named = at < rest.length ? word(rest[at]) : null;
  if (named === null) return { program, args };
  const spec = named.replace(/(?<=.)@[^@/]*$/u, '');
  return { program: PACKAGE_PROGRAMS[spec] ?? path.basename(spec), args: rest.slice(at + 1) };
}
