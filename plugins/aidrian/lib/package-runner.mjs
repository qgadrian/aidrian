// The program a package runner runs, as `npx codex login` runs codex: read by the guard of a session's own config writes
// (unattended-shell.mjs) and the guard of a host session's start (handoff-guard.mjs hostSessionStartDenial), so both
// read `npx @anthropic-ai/claude-code -p` as the program its package installs. It reads no file when loaded: hooks load it.

import path from 'node:path';

import { packagePrograms } from './hosts/index.mjs';

// npm's options that take the next word, before or after its own words, as `npm --workspace web exec x` reads them:
// its workspace, its prefix, and the config file, registry, and log level, as npm 11's help and shorthands give them.
const NPM_GLOBALS = ['-w', '--workspace', '-C', '--prefix', '-L', '--location', '--userconfig', '--registry', '--loglevel'];
// The package runners that run another program, each { globals, forms }: `globals`, the runner's options that take the
// next word wherever they stand, and each program's forms { words, options }: `words`, the runner's own words before the
// program, and `options`, the options of that form that take the next word.
const RUNNERS = Object.freeze({
  npx: { globals: NPM_GLOBALS, forms: [{ words: [], options: ['-p', '--package', '-c', '--call'] }] },
  bunx: { globals: [], forms: [{ words: [], options: ['-p', '--package'] }] },
  npm: { globals: NPM_GLOBALS, forms: [{ words: ['exec'], options: ['-p', '--package', '-c', '--call'] }, { words: ['x'], options: ['-p', '--package', '-c', '--call'] }] },
  // pnpm's folder, its filters, and its registry and output options, as pnpm's help gives them.
  pnpm: { globals: ['-C', '--dir', '-F', '--filter', '--filter-prod', '--registry', '--reporter', '--loglevel'], forms: [{ words: ['dlx'], options: ['--package'] }, { words: ['exec'], options: [] }] },
  yarn: { globals: [], forms: [{ words: ['dlx'], options: ['-p', '--package'] }] },
});
// A package whose program has another name than its last part, as `npx @changesets/cli publish` runs `changeset`, and
// each host's own packages (hosts/index.mjs packagePrograms), as `npx @anthropic-ai/claude-code` runs `claude`.
const PACKAGE_PROGRAMS = Object.freeze({ '@changesets/cli': 'changeset', ...packagePrograms() });
// The entry of `table` a word of a command names, by its own keys only: a word such as `constructor` or `__proto__`
// names a property every object has, and a guard that read one would throw, which lets the whole call run.
const own = (table, word) => (Object.hasOwn(table, word) ? table[word] : undefined);

// The program a call to `program` with the arguments `args` runs and the arguments it gets, through a package runner:
// { program, args }, or the call as it is when `program` is no runner, or the program it runs is not plain text. `word`
// reads an argument's text, null for one built at run time, so a list of plain words and the lexer's tokens both read.
export function unwrapped(program, args, word = (each) => each) {
  const words = args.map(word);
  const { globals = [], forms = [] } = own(RUNNERS, program) ?? {};
  // The index of the first word from `at` that is no option, past each option and the value of those in `valued`, and
  // past a word built at run time when `dynamic`.
  const operand = (at, valued, dynamic) => {
    while (at < words.length && ((dynamic && words[at] === null) || words[at]?.startsWith('-'))) at += valued.includes(words[at]) ? 2 : 1;
    return at;
  };
  for (const form of forms) {
    let at = 0;
    const matched = form.words.every((runnerWord) => {
      const next = operand(at, globals, true);
      at = next + 1;
      return words[next] === runnerWord;
    });
    if (!matched) continue;
    at = operand(at, [...globals, ...form.options], false);
    const named = at < words.length ? words[at] : null;
    if (named === null) return { program, args };
    const spec = named.replace(/(?<=.)@[^@/]*$/u, '');
    return { program: own(PACKAGE_PROGRAMS, spec) ?? path.basename(spec), args: args.slice(at + 1) };
  }
  return { program, args };
}
