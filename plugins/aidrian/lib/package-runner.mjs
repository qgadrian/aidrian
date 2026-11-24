// The program a package runner runs, as `npx codex login` runs codex: read by the guard of a session's own config writes
// (unattended-shell.mjs) and the guard of a host session's start (handoff-guard.mjs hostSessionStartDenial), so both
// read `npx @anthropic-ai/claude-code -p` as the program its package installs. It reads no file when loaded: hooks load it.

import path from 'node:path';

import { hostPrograms, packagePrograms } from './hosts/index.mjs';

// The package runners that run another program, each { forms, options }: `forms`, the runner's own words that run one,
// none for a runner that only runs one, and `options`, its options after that word that take the next word, which only
// the reading of a program no host owns uses.
const RUNNERS = Object.freeze({
  npx: { forms: [], options: ['-p', '--package', '-c', '--call'] },
  bunx: { forms: [], options: ['-p', '--package'] },
  npm: { forms: ['exec', 'x'], options: ['-p', '--package', '-c', '--call', '-w', '--workspace'] },
  pnpm: { forms: ['dlx', 'exec'], options: ['--package', '-C', '--dir', '-F', '--filter'] },
  yarn: { forms: ['dlx'], options: ['-p', '--package'] },
});
// A package whose program has another name than its last part, as `npx @changesets/cli publish` runs `changeset`, and
// each host's own packages (hosts/index.mjs packagePrograms), as `npx @anthropic-ai/claude-code` runs `claude`.
const PACKAGE_PROGRAMS = Object.freeze({ '@changesets/cli': 'changeset', ...packagePrograms() });
// The programs the callers guard, by any path, in any case, with `.exe` or `.cmd` or neither.
const HOST_PROGRAMS = new Set(hostPrograms());
// The entry of `table` a word of a command names, by its own keys only: a word such as `constructor` or `__proto__`
// names a property every object has, and a guard that read one would throw, which lets the whole call run.
const own = (table, word) => (Object.hasOwn(table, word) ? table[word] : undefined);
// A package's spelling without its trailing `@version`, as `@changesets/cli@2` is `@changesets/cli`.
const spelling = (word) => word.replace(/(?<=.)@[^@/]*$/u, '');
// Whether a word names a host's program: a package of one, or a program of one by its name. A package of another
// program, as `@changesets/cli`, is none, so `npx --package @changesets/cli npm publish` reads as npm.
const hostWord = (word) => typeof word === 'string' && !word.startsWith('-')
  && HOST_PROGRAMS.has(path.basename(own(PACKAGE_PROGRAMS, spelling(word)) ?? spelling(word)).replace(/\.(?:exe|cmd)$/iu, '').toLowerCase());

// The program a call to `program` with the arguments `args` runs and the arguments it gets, through a package runner:
// { program, args }, or the call as it is when `program` is no runner, or the program it runs is not plain text. `word`
// reads an argument's text, null for one built at run time, so a list of plain words and the lexer's tokens both read.
// A host's program counts wherever the runner's options stand, so no list of them can hide one: the runner's word is the
// first argument that is one of its `forms`, and the program the first word after it that names a host's program. When
// none does, the runner's word is its first word that is no option, and the program the first word after it that is no
// option, past the values of its `options`. The one false reading: a host's program named as a later argument of another
// program, as `npx prettier claude` or `npm install x claude`, reads as that host's program.
export function unwrapped(program, args, word = (each) => each) {
  const runner = own(RUNNERS, program);
  if (!runner) return { program, args };
  const words = args.map(word);
  // The index of the runner's word among `words` that `counts`, -1 for a runner with none.
  const formAt = (counts) => (runner.forms.length === 0 ? -1 : words.findIndex((each, i) => counts(each, i) && runner.forms.includes(each)));
  const form = formAt(() => true);
  let at = runner.forms.length > 0 && form < 0 ? -1 : words.findIndex((each, i) => i > form && hostWord(each));
  if (at < 0) {
    const first = words.findIndex((each) => each === null || !each.startsWith('-'));
    const plain = formAt((_, i) => i === first);
    if (runner.forms.length > 0 && plain < 0) return { program, args };
    at = plain + 1;
    while (at < words.length && words[at]?.startsWith('-')) at += runner.options.includes(words[at]) ? 2 : 1;
  }
  const named = at < words.length ? words[at] : null;
  if (named === null) return { program, args };
  const spec = spelling(named);
  return { program: own(PACKAGE_PROGRAMS, spec) ?? path.basename(spec), args: args.slice(at + 1) };
}
