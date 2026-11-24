// Every path a Bash command writes, read from the shell text, for the main-checkout rule and the config guard.

import path from 'node:path';

import { checkDeadline } from '../../deadline.mjs';
import { isDirectory, joinSpelled } from '../../fs.mjs';
import { inlineShellCommand, isLongOption, lexSteps, readGit, readInvocation, SUBSTITUTION_DEPTH_LIMIT } from '../../shell-lex.mjs';
import { cdChange, directoryChange, subshells } from './directory-change.mjs';
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
// paths it can be, as spelled from each folder, with no `..` folded away (fs.mjs joinSpelled), and `unsure` when the shell may be in a folder no path names, as after `cd "$dir"`. `globs` keeps a
// target with a glob, which bashTargets drops, as { text, files: [], dirs, unsure, glob: true }, `dirs` the folders it
// is relative to; `restores` counts git
// checkout -- and git restore as writes; `expansions` keeps a target with a `$` or a backtick, which every other read
// drops, as { text, files: [], dirs, unsure, expansion: true, vars }, `vars` { set, ownOnly }: the shell's assignments
// before it, and whether it reads only those, as a shell the line starts does.
// Every record also has `program`, what writes it: the program's name, `>` or `>>` for a redirection, or `git <sub>`;
// `cds`, the directory changes before it on its line, inline shells' callers included, each
// { from, to, program, shown }: `from` the folders before the change, `to` its folder token (null for none, `-`, `+N`,
// or `popd`), and `shown` the change as a deny reason names it; and `via`, the folder tokens of each `env -C` or git
// `-C` that moved the target after the last of them, in order.
// By default a `cd` makes the shell's folder unknown, as bashTargets reads it. `followCd` follows each `cd` to a named
// folder, and, since a `cd` that fails leaves the shell where it was, keeps the folders before it as well. `shells` also
// reads the command line of each `sh -c` or `bash -c`, which, like a substitution, starts where its command runs.
export function bashWrites(command, cwd, { followCd = false, shells = false, restores = false, globs = false, expansions = false } = {}) {
  const targets = [];
  // The assignments a target that may expand is read with, copied only for such a target when `expansions` asks.
  const varsOf = (token, place) => {
    if (!expansions || !token.dynamic || !/[$`]/u.test(token.text)) return null;
    return { set: new Map(place.vars), ownOnly: place.ownOnly === true };
  };
  const visit = (line, place, depth) => {
    // The shell's place before each subshell the line opens, which its end gives back (directory-change.mjs subshells).
    const outer = [];
    let closing = 0;
    for (const { segment, substitutions } of lexSteps(line)) {
      // Under the agent gate hook's time budget (lib/deadline.mjs); a no-op elsewhere.
      checkDeadline();
      for (; closing > 0 && outer.length; closing -= 1) place = outer.pop();
      const { opens, closes } = subshells(segment);
      for (let n = 0; n < opens; n += 1) {
        outer.push(place);
        place = { ...place, vars: new Map(place.vars) };
      }
      closing = closes;
      // A substitution and an inline shell run in shells of their own: what they assign stays there.
      const child = () => ({ ...place, vars: new Map(place.vars) });
      if (depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of substitutions) visit(body, child(), depth + 1);
      segment.forEach((token, i) => {
        const next = segment[i + 1];
        if ((token.operator === '>' || token.operator === '>>') && next && !next.fdDup && !next.operator) targets.push({ token: next, place, program: token.operator, vars: varsOf(next, place) });
      });
      const invocation = readInvocation(segment);
      const { program, args, chdir } = invocation;
      // A wrapper's directory change moves the command's own paths, never the shell's redirections above.
      const own = chdir === null ? place : within(place, chdir);
      if (WRITERS.has(program)) for (const token of written(program, args, WRITERS.get(program), invocation)) targets.push({ token, place: own, program, vars: varsOf(token, place) });
      else if (program === 'git') targets.push(...gitWritten(segment, own, restores).map((each) => ({ ...each, vars: varsOf(each.token, place) })));
      if (!program) for (const { name, value } of invocation.environment ?? []) place.vars.set(name, typeof value?.text === 'string' ? { text: value.text, dynamic: value.dynamic === true } : { text: '', dynamic: true });
      if (program === 'export') {
        for (const { text, dynamic } of args) {
          const set = /^([A-Za-z_]\w*)=(.*)$/su.exec(text);
          if (set) place.vars.set(set[1], { text: set[2], dynamic: dynamic === true });
        }
      }
      const inner = shells && depth < SUBSTITUTION_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
      // A shell it starts gets an environment this reader does not follow (exports, the hook's own): only what its
      // invocation sets literally is read there (`ownOnly`), an `env -i` or `env -u` leaves a name unset, and a target
      // built from any other variable fails closed.
      if (inner !== null) visit(inner, { ...own, vars: childVars(invocation.environment), ownOnly: true }, depth + 1);
      const directory = directoryChange(invocation);
      if (directory) {
        const change = cdChange(directory, place.dirs);
        place = { ...(followCd ? moved(place, change.to, true) : UNKNOWN), cds: [...place.cds, change], via: [], vars: place.vars, ownOnly: place.ownOnly };
      }
    }
  };
  // `vars`: the variables a bare assignment or `export` set in the shell, by name, each { text, dynamic } as the lexer
  // reads its value, for `expansions`.
  visit(command, { dirs: [cwd], unsure: false, cds: [], via: [], vars: new Map() }, 0);
  return targets
    .filter(({ token }) => (!token.dynamic || (globs && !/[$`]/u.test(token.text)) || (expansions && /[$`]/u.test(token.text))) && token.text !== '')
    .filter(({ token, place }) => !token.joined || token.joined.certain || intoFolder(token.joined.into, place.dirs))
    .map(({ token, place: { dirs, unsure, cds, via }, program, vars: set }) => {
      const { dynamic } = token;
      const text = expandHome(token);
      if (dynamic && /[$`]/u.test(text)) return { text, files: [], dirs, unsure, expansion: true, vars: set, cds, via, program };
      if (dynamic) return { text, files: [], dirs, unsure, glob: true, cds, via, program };
      if (path.isAbsolute(text)) return { text, files: [text], unsure: false, cds, via, program };
      return { text, files: dirs.map((dir) => joinSpelled(dir, text)), unsure, cds, via, program };
    });
}

// The variables a shell the line starts gets from its invocation, its `environment` changes applied in order: a literal
// value is read; an unset, and a value that may expand, are read as unknown; and `env -i` drops every earlier one but
// the names it keeps, which keep a value the invocation gave them, and are unknown otherwise.
// PWD and OLDPWD are the shell's own at its start, whatever it is given (SHELL_OWN).
const SHELL_OWN = new Set(['PWD', 'OLDPWD']);
function childVars(environment = []) {
  const vars = new Map();
  const unknown = { text: '', dynamic: true };
  for (const change of environment) {
    if (change.clear) {
      const kept = (change.keep ?? []).map((name) => [name, vars.get(name) ?? unknown]);
      vars.clear();
      for (const [name, value] of kept) vars.set(name, value);
    } else if (typeof change.value?.text === 'string') vars.set(change.name, { text: change.value.text, dynamic: change.value.dynamic === true });
    else vars.set(change.name, unknown);
  }
  for (const name of SHELL_OWN) if (vars.has(name)) vars.set(name, unknown);
  return vars;
}

// Whether the destination token `into` of a joined name (writers.mjs joinedNames) is a folder on the disk, from the
// shell's folders `dirs`, so a rename onto a path that is no folder yields no joined name. One built at run time is none.
const intoFolder = (into, dirs) => !into.dynamic && isFolderIn(expandHome(into), dirs);

// Whether the path `text` is a folder on the disk, absolute or from one of the folders `dirs`: one stat each, under the
// guards' deadline. A relative path with no folder to read it from is none. unattended-shell.mjs shellWrites asks it of
// a destination it expanded.
export function isFolderIn(text, dirs) {
  checkDeadline();
  return path.isAbsolute(text) ? isDirectory(text) : dirs.some((dir) => isDirectory(path.resolve(dir, text)));
}

// The shell's folder once a `cd` may have moved it anywhere: no folder is certain.
const UNKNOWN = Object.freeze({ dirs: [], unsure: true });

// Where a command runs after a wrapper's `env -C` or git's `-C` to the token `to`: the shell's own directory changes
// stay, and `via` records the move after the last of them.
function within(place, to) {
  return { ...moved(place, to), cds: place.cds, via: [...place.via, to ?? { text: '', dynamic: true }], vars: place.vars, ownOnly: place.ownOnly };
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
  // git mv moves as mv does, into a folder by the name of each source too.
  const program = call.subcommand === 'mv' ? 'mv' : 'git';
  return written(program, rest, writers.get(call.subcommand)).map((token) => ({ token, place: at, program: `git ${call.subcommand}` }));
}
