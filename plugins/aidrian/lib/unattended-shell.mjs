// What a Bash command writes that the shared lexer's targets (config-guard.mjs writeTargets) leave out, for the write
// allowlist of a session no Human attends (lib/unattended-write.mjs): a target built from a variable, a link a command
// makes, a program that writes its own config, and a write to a review manifest's name. It only reads the command.

import path from 'node:path';

import { PROGRAM_KEYS } from './attempt-clone.mjs';
import { checkDeadline } from './deadline.mjs';
import { forgeConfigCommands } from './forges/index.mjs';
import { configForm } from './handoff-guard.mjs';
import { configCommands } from './hosts/index.mjs';
import { unwrapped } from './package-runner.mjs';
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
// The package registry commands that publish, withdraw, or change who owns a package, or log in to do so, which a
// session no Human attends never runs: with a token the session was handed, as by an issue's text, they would publish the
// project's code as the token's owner (docs/providers/claude-code.md#dependency-installs). A script or a raw HTTP call
// that does the same is the accepted residual. `valueOptions` as SHARED_COMMANDS, whose `--opt=value` form is one word;
// `reads`, the forms that only read, which pass; `toolchain`, a leading `+<toolchain>` word read as an option, as
// cargo's; `workspace`, a leading `workspace <name>` skipped, as yarn's.
const NPM_VALUES = ['--prefix', '--userconfig', '--registry', '-w', '--workspace', '-C', '--dir', '--otp', '--tag', '--access', '--scope', '--cwd', '--filter', '-F', '--loglevel'];
const NPM_READS = [['owner', 'ls'], ['owner', 'list'], ['dist-tag', 'ls'], ['dist-tag', 'list'], ['dist-tags', 'ls'], ['dist-tags', 'list'], ['access', 'list'], ['access', 'get']];
const PUBLISH_COMMANDS = Object.freeze([
  { programs: ['npm', 'pnpm', 'yarn', 'bun'], subcommands: [['publish'], ['unpublish'], ['dist-tag'], ['dist-tags'], ['deprecate'], ['owner'], ['access'], ['token']], valueOptions: NPM_VALUES, reads: NPM_READS, workspace: true },
  { programs: ['yarn'], subcommands: [['npm', 'publish'], ['npm', 'tag'], ['npm', 'login'], ['tag'], ['login']], valueOptions: NPM_VALUES, workspace: true },
  { programs: ['bun'], subcommands: [['pm', 'publish']], valueOptions: NPM_VALUES },
  { programs: ['lerna', 'changeset'], subcommands: [['publish']], valueOptions: NPM_VALUES },
  { programs: ['gem'], subcommands: [['push'], ['yank'], ['owner'], ['signin']], valueOptions: ['--host', '-k', '--key', '--otp'] },
  { programs: ['bundle'], subcommands: [['exec', 'rake', 'release']], valueOptions: ['--gemfile'] },
  { programs: ['rake'], subcommands: [['release']], valueOptions: ['-f', '--rakefile', '-C', '--directory'] },
  { programs: ['cargo'], subcommands: [['publish'], ['yank'], ['owner'], ['login']], valueOptions: ['--registry', '--index', '--token', '--manifest-path', '-p', '--package', '-Z', '--config', '-C'], toolchain: true },
  { programs: ['twine'], subcommands: [['upload']], valueOptions: ['-r', '--repository', '--repository-url', '-u', '--username', '-p', '--password'] },
  { programs: ['python', 'python3', 'pipx', 'uvx'], subcommands: [['twine', 'upload']], valueOptions: [] },
  { programs: ['uv'], subcommands: [['publish']], valueOptions: ['--directory', '--project', '--index', '--publish-url', '--token', '-t', '--username', '-u', '--password', '-p'] },
  { programs: ['poetry'], subcommands: [['publish']], valueOptions: ['-C', '--directory', '-P', '--project', '-r', '--repository', '-u', '--username', '-p', '--password'] },
]);
// The launchctl subcommands that only read.
const LAUNCHCTL_READS = new Set(['list', 'print', 'print-disabled', 'print-cache', 'getenv', 'version', 'help', 'blame', 'managerpid', 'manageruid', 'managername', 'error']);
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

// Whether the words of a call to `program` run one of the declared subcommands of `each`, { programs, subcommands,
// valueOptions, reads, toolchain, workspace }: its words, past the global options that take a value, start with one, or
// hold one of more than one word in a row, and start with none of its reads.
export function runsDeclared(each, program, words) {
  if (!each.programs.includes(program)) return false;
  let named = namedWords(words, each.valueOptions ?? []);
  if (each.toolchain && named[0]?.startsWith('+')) named = named.slice(1);
  if (each.workspace && named[0] === 'workspace') named = named.slice(2);
  const at = (sub, i) => sub.every((word, j) => named[i + j] === word);
  if ((each.reads ?? []).some((sub) => at(sub, 0))) return false;
  return each.subcommands.some((sub) => at(sub, 0) || (sub.length > 1 && named.some((_, i) => at(sub, i))));
}

// The config each program call in a command writes: `git config` by its scope (configForm), any key that makes git run
// a program (attempt-clone.mjs PROGRAM_KEYS) at any scope, the folders `git worktree add`, `git clone`, and `git init`
// make, the forge CLI's and each host's own config subcommands, SHARED_COMMANDS, PUBLISH_COMMANDS, crontab, and launchctl.
function programWrites(segment, invocation, folder) {
  // Through a package runner, the program its package installs (package-runner.mjs), as `npx codex login` runs codex.
  const { program, args: words } = unwrapped(invocation.program, plainWords(invocation.args));
  const shown = [invocation.program, ...plainWords(invocation.args)].join(' ').slice(0, 120);
  if (program === 'git' && invocation.program === 'git') return gitWrites(readGit(segment), folder, shown);
  const refuse = (what) => [{ what, text: shown }];
  const forge = forgeConfigCommands().find((each) => runsDeclared(each, program, words));
  if (forge) return refuse(forge.what);
  if (configCommands().some((each) => runsDeclared(each, program, words))) return refuse('the host\'s own config');
  if (SHARED_COMMANDS.some((each) => runsDeclared(each, program, words))) return refuse(`the user's config of ${program}`);
  if (PUBLISH_COMMANDS.some((each) => runsDeclared(each, program, words))) return refuse('a package on a registry, or its owners');
  if (program === 'crontab' && !(words.length === 1 && words[0] === '-l')) return refuse('the user\'s scheduled jobs');
  const sub = operands(words)[0];
  if (program === 'launchctl' && sub !== undefined && !LAUNCHCTL_READS.has(sub)) return refuse('the user\'s launch jobs');
  return [];
}

// The writes of one git call (programWrites): what its subcommand makes (subcommandWrites), each file a diff
// option, `git format-patch`, or `git archive` writes its output to (outputTargets), and the file `git bundle create`
// writes (bundleTarget).
function gitWrites(git, folder, shown) {
  if (!git) return [];
  return [...subcommandWrites(git, folder, shown), ...outputTargets(git, folder, shown), ...bundleTarget(git, folder, shown)];
}

// The file `git bundle create` writes: its first word past `create` that is no option, as none of its options
// (-q, --progress, --version=<n>) takes the next word. `-` writes to standard output. A name built at run time, or a
// call that names none, is refused, since where it writes cannot be told.
function bundleTarget(git, folder, shown) {
  if (git.subcommand !== 'bundle' || git.rest[0]?.dynamic || git.rest[0]?.text !== 'create') return [];
  const value = git.rest.slice(1).find((token) => token.dynamic || token.text === '-' || !token.text.startsWith('-'));
  if (value?.text === '-' && !value.dynamic) return [];
  if (!value || value.dynamic) return [{ what: 'a bundle file git writes, whose name is missing or built at run time, so where it writes cannot be told', text: shown }];
  return [{ file: value.text, folder, text: shown }];
}

// The subcommands whose short `-o` names the file or folder they write: format-patch's output folder, archive's file.
const OUTPUT_SHORT = new Set(['format-patch', 'archive']);
// The long options that name where a git call writes its output: `--output`, which every command that takes diff
// options (log, show, diff, diff-tree, range-diff, format-patch) and archive take, and format-patch's folder.
const OUTPUT_LONG = new Set(['--output', '--output-directory']);

// Each file or folder a git call writes its output to, in any spelling: `--output=<file>`, `--output <file>`,
// format-patch's `--output-directory` and `-o`, archive's `-o`, alone, attached (`-o<dir>`), or last in a cluster
// (`-ko <dir>`). A name built at run time is refused, since where it writes cannot be told. A relative name lies in
// `folder`, which walkCommands already resolved through every leading `-C`, so no `-C` is applied again here.
function outputTargets(git, folder, shown) {
  const found = [];
  const rest = git.rest;
  for (let i = 0; i < rest.length; i += 1) {
    const { text } = rest[i];
    if (text === '--') break;
    let value;
    const long = text.startsWith('--') ? text.split('=')[0] : null;
    if (long !== null && OUTPUT_LONG.has(long) && (long === '--output' || git.subcommand === 'format-patch')) {
      value = text.includes('=') ? { text: text.slice(text.indexOf('=') + 1), dynamic: rest[i].dynamic } : rest[i + 1];
    } else if (long === null && OUTPUT_SHORT.has(git.subcommand) && /^-[A-Za-z]*o/u.test(text)) {
      const attached = text.slice(text.indexOf('o') + 1);
      value = attached !== '' ? { text: attached, dynamic: rest[i].dynamic } : rest[i + 1];
    } else continue;
    if (!value || value.dynamic) {
      found.push({ what: 'a file git writes its output to, whose name is missing or built at run time, so where it writes cannot be told', text: shown });
    } else found.push({ file: value.text, folder, text: shown });
  }
  return found;
}

// What one git call's subcommand makes: a config write, a worktree, a clone, or a new repository (gitWrites).
function subcommandWrites(git, folder, shown) {
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
