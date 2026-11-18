// What a Bash command writes that the shared lexer's targets (config-guard.mjs writeTargets) leave out, for the write
// allowlist of a session no Human attends (lib/unattended-write.mjs): a target built from a variable, a link a command
// makes, a program that writes its own config, and a write to a review manifest's name. It only reads the command.

import path from 'node:path';

import { PROGRAM_KEYS } from './attempt-clone.mjs';
import { checkDeadline } from './deadline.mjs';
import { forgeConfigCommands } from './forges/index.mjs';
import { configForm } from './handoff-guard.mjs';
import { configCommands } from './hosts/index.mjs';
import { WRITERS, written } from './rules/main-checkout/writers.mjs';
import { readGit, walkCommands } from './shell-lex.mjs';

// The variables a target may use, expanded from the hook's environment.
const EXPANDED = Object.freeze(['HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'TMPDIR']);
// Programs, besides each host's own (hosts/index.mjs configCommands) and the forge CLI's (forges/index.mjs
// forgeConfigCommands), whose subcommands write the user's config, login, or jobs. `valueOptions` are the global options
// that take the next word, skipped before the subcommand.
const SHARED_COMMANDS = Object.freeze([
  { programs: ['npm', 'pnpm', 'yarn'], subcommands: [['config', 'set']], valueOptions: ['--prefix', '--userconfig', '--registry', '-w', '--workspace', '-C', '--dir'] },
  { programs: ['npm'], subcommands: [['set'], ['login'], ['adduser']], valueOptions: ['--prefix', '--userconfig', '--registry', '-w', '--workspace', '--scope'] },
  { programs: ['defaults'], subcommands: [['write'], ['delete'], ['import'], ['rename']], valueOptions: [] },
]);
// The launchctl subcommands that only read.
const LAUNCHCTL_READS = new Set(['list', 'print', 'print-disabled', 'print-cache', 'getenv', 'version', 'help', 'blame', 'managerpid', 'manageruid', 'managername', 'error']);
// The package runners that run another program, { words, options }: `words`, the runner's own words before the
// program, and `options`, its options that take the next word.
const RUNNERS = Object.freeze({
  npx: { words: [], options: ['-p', '--package', '-c', '--call'] },
  bunx: { words: [], options: ['-p', '--package'] },
  pnpm: { words: ['dlx'], options: ['--package', '-C', '--dir'] },
  yarn: { words: ['dlx'], options: ['-p', '--package'] },
});
// The options of `git clone`, `git init`, and `git worktree` that take the next word.
const CLONE_VALUES = ['-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--reference', '--reference-if-able', '--depth', '-c', '--config', '--template', '--separate-git-dir', '-j', '--jobs', '--filter', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--ref-format', '--server-option'];
const INIT_VALUES = ['--template', '--separate-git-dir', '-b', '--initial-branch', '--object-format', '--ref-format'];
const WORKTREE_VALUES = ['-b', '-B', '--reason'];
const LINK_VALUES = ['-t', '--target-directory', '-S', '--suffix'];

const absolute = (each) => typeof each === 'string' && path.isAbsolute(each);
// The non-option words of a command's plain arguments.
const plainWords = (args) => args.filter((token) => !token.dynamic).map((token) => token.text);
const operands = (words) => words.filter((text) => !text.startsWith('-'));

// The words of `words` that are no option and no value of one of `valueOptions`, as getopt reads them: `--opt=value`
// carries its value.
function namedWords(words, valueOptions = []) {
  const named = [];
  for (let i = 0; i < words.length; i += 1) {
    if (valueOptions.includes(words[i])) i += 1;
    else if (!words[i].startsWith('-')) named.push(words[i]);
  }
  return named;
}

// `text` with each of EXPANDED expanded from `env`, unless the command `command` sets that variable itself; a leading
// `~` is the home folder `env` names.
export function expand(text, env, command) {
  const sets = (name) => new RegExp(String.raw`(?<![\w$])${name}\+?=|\b(?:export|unset|declare|typeset|local|readonly|read)\b[^;&|\n]*\b${name}\b`, 'u').test(command);
  const value = (name) => (EXPANDED.includes(name) && absolute(env[name]) && !sets(name) ? env[name] : null);
  const out = text.replace(/\$\{(\w+)\}|\$(\w+)/gu, (whole, braced, bare) => value(braced ?? bare) ?? whole);
  return /^~(?=\/|$)/u.test(out) && value('HOME') ? path.join(value('HOME'), out.slice(1)) : out;
}

// What the Bash call `command`, run in `cwd`, writes that writeTargets leaves out, read once:
// { dynamic, links, programs, manifests, removed, text }.
//   - dynamic: each target built from a variable or a command, { text, folder }, `text` as expand gives it.
//   - links: each path a link the command makes points at, { from, to, folder }.
//   - programs: each write a program makes to its own config, { file, folder, text } or { what, text }.
//   - manifests: each target that may be a review manifest's name, { text, folder, how, sources }, with `mode` true for
//     a `mkdir` that sets the folder's mode.
//   - removed: each folder `rmdir` removes, { text, folder }, which no other reader names.
export function shellWrites(command, cwd, env) {
  const found = { dynamic: [], links: [], programs: [], manifests: [], removed: [], text: command };
  for (const { segment, invocation, folder } of walkCommands(command, cwd)) {
    checkDeadline();
    const { program, args } = invocation;
    segment.forEach((token, i) => {
      const next = segment[i + 1];
      if ((token.operator !== '>' && token.operator !== '>>') || !next || next.fdDup || next.operator) return;
      if (next.dynamic && /[$`]/u.test(next.text)) found.dynamic.push({ text: expand(next.text, env, command), folder });
      else found.manifests.push({ text: next.text, folder, how: 'redirect' });
    });
    if (WRITERS.has(program)) {
      const mode = program === 'mkdir' && setsMode(args);
      for (const token of written(program, args)) {
        if (token.dynamic && /[$`]/u.test(token.text)) found.dynamic.push({ text: expand(token.text, env, command), folder });
        else found.manifests.push({ text: token.text, folder, how: program, sources: copySources(program, args), ...(mode ? { mode } : {}) });
      }
    }
    if (program === 'rmdir') {
      for (const token of operandTokens(args)) {
        if (token.dynamic && /[$`]/u.test(token.text)) found.dynamic.push({ text: expand(token.text, env, command), folder });
        else found.removed.push({ text: expand(token.text, env, token.dynamic ? command : ''), folder });
      }
    }
    found.links.push(...linksOf(program, args, folder, env, command));
    for (const write of programWrites(segment, invocation, folder)) {
      found.programs.push(write.file ? { ...write, file: expand(write.file, env, command) } : write);
    }
  }
  return found;
}

// Whether a `mkdir` call's arguments set the mode of what it makes: -m, or --mode, alone or in a cluster such as -pm.
const setsMode = (args) => plainWords(args).some((text) => (/^-[A-Za-z]*m/u.test(text) && !text.startsWith('--')) || /^--mode(?:=|$)/u.test(text))
  || args.some((token) => token.dynamic && /^-/u.test(token.text));

// The operands of a call whose options take no value, as rmdir's: every word after `--`, and each one before it that is
// no option.
function operandTokens(args) {
  const at = args.findIndex((token) => !token.dynamic && token.text === '--');
  const before = (at < 0 ? args : args.slice(0, at)).filter((token) => token.dynamic || !token.text.startsWith('-'));
  return at < 0 ? before : [...before, ...args.slice(at + 1)];
}

// The operands `program`, mv or cp, moves or copies: all but its destination.
function copySources(program, args) {
  if (program !== 'mv' && program !== 'cp') return [];
  const words = plainWords(args);
  const named = namedWords(words, LINK_VALUES);
  const directory = words.some((text) => text === '-t' || text.startsWith('--target-directory'));
  return directory ? named : named.slice(0, -1);
}

// The paths each link `ln`, or `cp -s` or `cp -l`, makes points at: { from, to, folder }, `to` as the link's folder
// resolves a symbolic link's relative target, and the command's folder a hard link's.
function linksOf(program, args, folder, env, command) {
  if (program !== 'ln' && program !== 'cp') return [];
  const words = args.map((token) => expand(token.text, env, token.dynamic ? command : ''));
  const short = words.filter((text) => /^-[A-Za-z]+$/u.test(text)).join('');
  const symbolic = short.includes('s') || words.includes('--symbolic') || words.includes('--symbolic-link');
  if (program === 'cp' && !symbolic && !short.includes('l') && !words.includes('--link')) return [];
  const named = namedWords(words, LINK_VALUES);
  const at = words.indexOf('-t');
  const into = at >= 0 ? words[at + 1] : null;
  const sources = into || named.length === 1 ? named : named.slice(0, -1);
  const destination = into ?? (named.length === 1 ? '.' : named.at(-1));
  return sources.map((from) => {
    if (/[$`]/u.test(from) || path.isAbsolute(from) || folder === null) return { from, to: [from], folder };
    const base = path.resolve(folder, destination);
    const to = symbolic ? [path.resolve(base, from), path.resolve(path.dirname(base), from)] : [path.resolve(folder, from)];
    return { from, to, folder };
  });
}

// The program a call runs and its words, through a package runner (RUNNERS), as `npx codex login` runs codex.
function unwrapped(program, words) {
  const runner = RUNNERS[program];
  if (!runner || !runner.words.every((word, i) => operands(words)[i] === word)) return { program, words };
  const rest = [...words];
  for (const word of runner.words) rest.splice(rest.indexOf(word), 1);
  let at = 0;
  while (at < rest.length && rest[at].startsWith('-')) at += runner.options.includes(rest[at]) ? 2 : 1;
  return at < rest.length ? { program: path.basename(rest[at]).replace(/@[^@/]*$/u, ''), words: rest.slice(at + 1) } : { program, words };
}

// Whether the words of a call to `program` run one of the declared subcommands of `each`, { programs, subcommands,
// valueOptions }: its words, past the global options that take a value, start with one, or hold one of more than one
// word in a row.
function runsDeclared(each, program, words) {
  if (!each.programs.includes(program)) return false;
  const named = namedWords(words, each.valueOptions ?? []);
  const at = (sub, i) => sub.every((word, j) => named[i + j] === word);
  return each.subcommands.some((sub) => at(sub, 0) || (sub.length > 1 && named.some((_, i) => at(sub, i))));
}

// The config each program call in a command writes: `git config` by its scope (configForm), any key that makes git run
// a program (attempt-clone.mjs PROGRAM_KEYS) at any scope, the folders `git worktree add`, `git clone`, and `git init`
// make, the forge CLI's and each host's own config subcommands, SHARED_COMMANDS, crontab, and launchctl.
function programWrites(segment, invocation, folder) {
  const { program, words } = unwrapped(invocation.program, plainWords(invocation.args));
  const shown = [invocation.program, ...plainWords(invocation.args)].join(' ').slice(0, 120);
  if (program === 'git' && invocation.program === 'git') return gitWrites(readGit(segment), folder, shown);
  const refuse = (what) => [{ what, text: shown }];
  const forge = forgeConfigCommands().find((each) => runsDeclared(each, program, words));
  if (forge) return refuse(forge.what);
  if (configCommands().some((each) => runsDeclared(each, program, words))) return refuse('the host\'s own config');
  if (SHARED_COMMANDS.some((each) => runsDeclared(each, program, words))) return refuse(`the user's config of ${program}`);
  if (program === 'crontab' && !(words.length === 1 && words[0] === '-l')) return refuse('the user\'s scheduled jobs');
  const sub = operands(words)[0];
  if (program === 'launchctl' && sub !== undefined && !LAUNCHCTL_READS.has(sub)) return refuse('the user\'s launch jobs');
  return [];
}

// The writes of one git call (programWrites).
function gitWrites(git, folder, shown) {
  if (!git) return [];
  const words = git.rest.filter((token) => !token.dynamic).map((token) => token.text);
  const file = (spelled) => ({ file: spelled, folder, text: shown });
  if (git.subcommand === 'config') return configWrites(words, file, shown);
  const separate = words.flatMap((text, i) => {
    if (text === '--separate-git-dir') return words[i + 1] ? [words[i + 1]] : [];
    return text.startsWith('--separate-git-dir=') ? [text.slice('--separate-git-dir='.length)] : [];
  });
  if (git.subcommand === 'worktree') {
    const [action, place, then] = namedWords(words, WORKTREE_VALUES);
    if (action === 'add' && place) return [file(place)];
    return action === 'move' && then ? [file(then)] : [];
  }
  if (git.subcommand === 'clone') return [...cloneTarget(words).map(file), ...separate.map(file)];
  if (git.subcommand === 'init') {
    const [into = '.'] = namedWords(words, INIT_VALUES);
    return [file(words.includes('--bare') ? into : path.join(into, '.git')), ...separate.map(file)];
  }
  return [];
}

// What `git config` with the words `words` writes: a refusal for a key that makes git run a program or an edit of the
// whole file, else the file its scope names.
function configWrites(words, file, shown) {
  const form = configForm(words);
  if (!form.writes) return [];
  const programKey = form.named.some((key) => PROGRAM_KEYS.some(([pattern]) => pattern.test(key.toLowerCase())));
  if (form.any || programKey) return [{ what: 'a git config key that makes git run a program, or a config edit that may set one', text: shown }];
  if (form.scope.file !== null) return [file(form.scope.file)];
  if (form.scope.global) return [{ what: 'the user\'s git config', text: shown }];
  if (form.scope.system) return [{ what: 'the system\'s git config', text: shown }];
  if (form.scope.worktree) return [{ what: 'the worktree\'s git config', text: shown }];
  return [{ what: 'the repository\'s shared git config', text: shown }];
}

// The folder `git clone` with the words `words` makes: the one it names, or the repository's name, with `.git` for a
// bare or mirror clone.
function cloneTarget(words) {
  const [from, into] = namedWords(words, CLONE_VALUES);
  if (into) return [into];
  if (!from) return [];
  const bare = words.includes('--bare') || words.includes('--mirror');
  return [`${path.basename(from.replace(/\/+$/u, '')).replace(/\.git$/u, '')}${bare ? '.git' : ''}`];
}
