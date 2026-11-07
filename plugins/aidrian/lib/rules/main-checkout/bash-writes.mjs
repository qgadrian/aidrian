// Every path a Bash command writes, read from the shell text, for the main-checkout rule and the config guard.

import path from 'node:path';

import { inlineShellCommand, isLongOption, lexSteps, readGit, readInvocation, SUBSTITUTION_DEPTH_LIMIT } from '../../shell-lex.mjs';
import { cdChange, directoryChange } from './directory-change.mjs';
import { expandHome, WRITERS, written } from './writers.mjs';

// git subcommands whose every path is written: git mv removes its sources, git rm its paths.
const GIT_WRITERS = new Map([
  ['mv', new Set()],
  ['rm', new Set(['--pathspec-from-file'])],
]);
// git subcommands that put back a path's content, which bashWrites counts only when asked (`restores`): the main-checkout
// rule lets them discard changes, while the config guard must see a gate file restored to an older version.
const GIT_RESTORERS = new Map([
  ['checkout', new Set(['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'])],
  ['restore', new Set(['-s', '--source', '--conflict', '--pathspec-from-file'])],
]);

// Every path a Bash command writes with certainty, resolved against `cwd`. Commands are read in the order they run: a
// relative target after a `cd` is dropped, and one before it stays. A command substitution runs in a shell of its own,
// which starts where its command runs; a `cd` inside it moves nothing outside it.
export function bashTargets(command, cwd) {
  return bashWrites(command, cwd).flatMap(({ files }) => files);
}

// Most folders bashWrites follows the shell through; past it, the shell's folder counts as unknown.
const FOLDERS_LIMIT = 16;

// Every target a Bash command writes, as { text, files, unsure }: `text` as the command names it, `files` the absolute
// paths it can be, and `unsure` when the shell may be in a folder no path names, as after `cd "$dir"`. `globs` keeps a
// target with a glob, which bashTargets drops, as { text, files: [], dirs, unsure, glob: true }, `dirs` the folders it
// is relative to; `restores` counts git
// checkout -- and git restore as writes.
// Every record also has `cds`, the directory changes before it on its line, inline shells' callers included, each
// { from, to, program, shown }: `from` the folders before the change, `to` its folder token (null for none, `-`, `+N`,
// or `popd`), and `shown` the change as a deny reason names it; and `via`, the folder tokens of each `env -C` or git
// `-C` that moved the target after the last of them, in order.
// By default a `cd` makes the shell's folder unknown, as bashTargets reads it. `followCd` follows each `cd` to a named
// folder, and, since a `cd` that fails leaves the shell where it was, keeps the folders before it as well. `shells` also
// reads the command line of each `sh -c` or `bash -c`, which, like a substitution, starts where its command runs.
export function bashWrites(command, cwd, { followCd = false, shells = false, restores = false, globs = false } = {}) {
  const targets = [];
  const visit = (line, place, depth) => {
    for (const { segment, substitutions } of lexSteps(line)) {
      if (depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of substitutions) visit(body, place, depth + 1);
      segment.forEach((token, i) => {
        const next = segment[i + 1];
        if ((token.operator === '>' || token.operator === '>>') && next && !next.fdDup && !next.operator) targets.push({ token: next, place });
      });
      const invocation = readInvocation(segment);
      const { program, args, chdir } = invocation;
      // A wrapper's directory change moves the command's own paths, never the shell's redirections above.
      const own = chdir === null ? place : within(place, chdir);
      if (WRITERS.has(program)) for (const token of written(program, args)) targets.push({ token, place: own });
      else if (program === 'git') targets.push(...gitWritten(segment, own, restores));
      const inner = shells && depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
      if (inner !== null) visit(inner, own, depth + 1);
      const directory = directoryChange(invocation);
      if (directory) {
        const change = cdChange(directory, place.dirs);
        place = { ...(followCd ? moved(place, change.to, true) : UNKNOWN), cds: [...place.cds, change], via: [] };
      }
    }
  };
  visit(command, { dirs: [cwd], unsure: false, cds: [], via: [] }, 0);
  return targets
    .filter(({ token }) => (!token.dynamic || (globs && !/[$`]/u.test(token.text))) && token.text !== '')
    .map(({ token, place: { dirs, unsure, cds, via } }) => {
      const { dynamic } = token;
      const text = expandHome(token);
      if (dynamic) return { text, files: [], dirs, unsure, glob: true, cds, via };
      if (path.isAbsolute(text)) return { text, files: [text], unsure: false, cds, via };
      return { text, files: dirs.map((dir) => path.resolve(dir, text)), unsure, cds, via };
    });
}

// The shell's folder once a `cd` may have moved it anywhere: no folder is certain.
const UNKNOWN = Object.freeze({ dirs: [], unsure: true });

// Where a command runs after a wrapper's `env -C` or git's `-C` to the token `to`: the shell's own directory changes
// stay, and `via` records the move after the last of them.
function within(place, to) {
  return { ...moved(place, to), cds: place.cds, via: [...place.via, to ?? { text: '', dynamic: true }] };
}

// Where the shell can be after a directory change to the token `to` from `place`: { dirs, unsure }. A missing or
// dynamic `to` reaches an unknown folder. `mayFail` keeps the folders before the change too.
function moved(place, to, mayFail = false) {
  const kept = mayFail ? place.dirs : [];
  let reached;
  if (!to || to.dynamic) reached = UNKNOWN;
  else if (path.isAbsolute(to.text)) reached = { dirs: [to.text], unsure: false };
  else reached = { dirs: place.dirs.map((dir) => path.resolve(dir, to.text)), unsure: place.unsure };
  const dirs = [...new Set([...kept, ...reached.dirs])];
  const unsure = reached.unsure || (mayFail && place.unsure) || dirs.length > FOLDERS_LIMIT;
  return { dirs: dirs.slice(0, FOLDERS_LIMIT), unsure };
}

// git mv and git rm, and with `restores` git checkout and git restore: every path they name, resolved from `git -C`, which moves them as a wrapper's directory change does.
function gitWritten(segment, place, restores) {
  const call = readGit(segment);
  const writers = restores ? new Map([...GIT_WRITERS, ...GIT_RESTORERS]) : GIT_WRITERS;
  if (!call || !writers.has(call.subcommand)) return [];
  let at = place;
  call.globals.forEach((token, i) => {
    const value = call.globals[i + 1];
    if (token.text === '-C' && value) at = within(at, value);
  });
  let { rest } = call;
  // git checkout writes paths only after `--`; before it a word may be a branch. git restore --staged alone writes the index.
  const dashes = rest.findIndex((token) => token.text === '--');
  if (call.subcommand === 'checkout') rest = dashes === -1 ? [] : rest.slice(dashes);
  const has = (letter, long, shortest) => rest.some(({ text }) => isLongOption(text, long, shortest) || (/^-[A-Za-z]+$/u.test(text) && text.includes(letter)));
  if (call.subcommand === 'restore' && has('S', '--staged', '--st') && !has('W', '--worktree', '--w')) return [];
  return written('git', rest, writers.get(call.subcommand)).map((token) => ({ token, place: at }));
}
