// `aidrian shell-init <shell> [--install | --uninstall]` (docs/handoff.md#replacing-the-terminal). Plain, it prints the
// shell function that lets a terminal follow a background handoff (lib/terminal-replace.mjs). `--install` writes that
// function itself into the shell's startup file, `~/.zshrc` or `~/.bashrc`, between two marker lines: no plugin code runs
// at shell start, and nothing is looked up on PATH. A run that finds the block replaces it, so a re-run after an update
// brings it to the current text; a file with a line of its own that runs `aidrian shell-init` is left as it is.
// `--uninstall` removes the block, from its start marker to its end marker, and nothing else. A host's plugins have no
// install step, and the startup file is the Human's: the Human runs either one, and lib/rules/shell-init-install.mjs
// refuses both to an agent. The session start says, in one line, when a block differs from the current text or the
// session's terminal will not follow a handoff (terminalLine).
// `--install --wrap <name>`, repeatable, also writes the same function under each name, for a launcher on PATH that ends
// in `exec` of the host's program. A name is untrusted text that becomes shell code, so wrapProblem checks it on every
// path to the block: 1 to 32 letters, digits, `_`, or `-`, starting with a letter; not a host's own program; not in
// WRAP_REFUSED, every reserved word and builtin of zsh and bash, the functions a shell runs as hooks, and core tools;
// not in SHELL_NAMES, a shell's own name, such as `zsh`; not starting with `TRAP` or `zle-`; at most MAX_WRAPS
// in one block. The block records its names on its third line,
// `# Wrapped launchers: <names>`, sorted and space-separated, so a re-install keeps them and a later `--wrap` adds to them.
// A shell function of a wrapped name that the shell already has when it reads the block, other than the block's own
// wrapper, stays: no fixed list knows the hooks a Human's setup defines, so the block checks (wrapGuard).
// The file holds four parts, the wrap names it accepts, the shell code, the install and uninstall of the startup file,
// and the session start's line, past the usual length: each writes, reads, or checks the one block format, so the
// format's contract stays in one file.

import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { HOSTS } from './hosts/index.mjs';
import { SHELL_NAMES } from './rules/shell-init-install.mjs';
import { FOLLOWS_PREFIX, NAME_BYTES, NEXT_MARGIN, NEXT_WINDOW, OPEN_ID, replacer, shellPid, SHELL_VAR, TERMINAL_FOLDER } from './terminal-replace.mjs';

export const SHELLS = ['zsh', 'bash'];
export const BEGIN = '# >>> aidrian shell-init >>>';
export const END = '# <<< aidrian shell-init <<<';
const WORD = /^[a-z][a-z0-9-]{0,31}$/u;
// How late an expiry the shell function takes, in whole seconds from the time it reads the record.
const LATEST = Math.ceil((NEXT_WINDOW + NEXT_MARGIN) / 1000);

// The startup file `shell` reads in an interactive session, under `env`.
export function rcFile(shell, env = process.env) {
  const home = path.isAbsolute(env.HOME ?? '') ? env.HOME : homedir();
  if (shell === 'zsh') return path.join(path.isAbsolute(env.ZDOTDIR ?? '') ? env.ZDOTDIR : home, '.zshrc');
  return path.join(home, '.bashrc');
}

const WRAP_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
export const MAX_WRAPS = 8;
const WRAP_LINE = '# Wrapped launchers:';
// The names no launcher may take, a fixed list so no shell runs at install. A function of such a name would change how
// the shell itself works, or what the Human's later commands run.
export const WRAP_REFUSED = Object.freeze([...new Set([
  // The reserved words of zsh and bash.
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'select', 'function',
  'time', 'coproc', 'repeat', 'foreach', 'end', 'nocorrect', 'noglob',
  // What the block runs with no `command` before it.
  'command', 'local', 'return', 'read', 'alias', 'unset', 'echo', 'emulate', 'set', 'umask', 'break', 'continue',
  // The builtins of bash 3.2 to 5, and of zsh with each of its modules loaded.
  'autoload', 'bg', 'bind', 'bindkey', 'builtin', 'bye', 'caller', 'cap', 'cd', 'chdir', 'chgrp', 'chown', 'clone',
  'compadd', 'comparguments', 'compcall', 'compctl', 'compdescribe', 'compfiles', 'compgen', 'complete', 'compopt',
  'compgroups', 'compquote', 'compset', 'comptags', 'comptry', 'compvalues', 'declare', 'dirs', 'disable', 'disown',
  'echotc', 'echoti', 'enable', 'eval', 'example', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'float', 'functions',
  'getcap', 'getln', 'getopts', 'hash', 'help', 'history', 'integer', 'jobs', 'kill', 'let', 'limit', 'ln', 'log',
  'logout', 'mapfile', 'mv', 'pcre_compile', 'pcre_match', 'pcre_study', 'popd', 'print', 'private', 'pushd', 'pushln',
  'pwd', 'r', 'readarray', 'readonly', 'rehash', 'rmdir', 'sched', 'setcap', 'setopt', 'shift', 'shopt', 'source',
  'stat', 'strftime', 'suspend', 'sync', 'syserror', 'sysopen', 'sysread', 'sysseek', 'syswrite', 'test', 'times',
  'trap', 'true', 'ttyctl', 'type', 'typeset', 'ulimit', 'unalias', 'unfunction', 'unhash', 'unlimit', 'unsetopt',
  'vared', 'wait', 'whence', 'where', 'which', 'zcompile', 'zcurses', 'zdelattr', 'zf_chgrp', 'zf_chmod', 'zf_chown',
  'zf_ln', 'zf_mkdir', 'zf_mv', 'zf_rm', 'zf_rmdir', 'zf_sync', 'zformat', 'zftp', 'zgdbmpath', 'zgetattr', 'zle',
  'zlistattr', 'zmodload', 'zparseopts', 'zprof', 'zpty', 'zregexparse', 'zselect', 'zsetattr', 'zsocket', 'zstat',
  'zstyle', 'zsystem', 'ztcp', 'ztie', 'zuntie',
  // The functions a shell runs by their name alone: zsh's hooks and both shells' handler of a command not found.
  'preexec', 'precmd', 'chpwd', 'periodic', 'zshaddhistory', 'zshexit', 'zsh_directory_name',
  'command_not_found_handler', 'command_not_found_handle',
  // Core tools the block runs, or whose shadowing would change the Human's later commands.
  'rm', 'date', 'printf', 'mkdir', 'chmod', 'od', 'tr',
])]);
// The prefixes of the names zsh runs as hooks too: a trap, `TRAPZERR`, and a widget of the line editor, `zle-line-init`.
export const WRAP_REFUSED_PREFIX = /^(?:TRAP|zle-)/u;

// Why `name` cannot be a wrapped launcher, or null when it can. The reason never repeats the name.
export function wrapProblem(name) {
  if (typeof name !== 'string' || !WRAP_SHAPE.test(name)) return 'is not 1 to 32 letters, digits, `_`, or `-` that start with a letter';
  if (HOSTS.map(replacer).some((replace) => replace?.program === name)) return 'is a host\'s own program, which the block already wraps';
  // A function of a shell's own name would run the host's attach flow each time that shell exits.
  if (SHELL_NAMES.includes(name)) return 'is a shell\'s own name, which the block would replace with a function that runs the host\'s attach flow after that shell exits';
  if (WRAP_REFUSED.includes(name) || WRAP_REFUSED_PREFIX.test(name)) return 'is a reserved word or builtin of zsh or bash, a function a shell runs as a hook, or a core tool the block runs or a function of that name would shadow';
  return null;
}

// The functions for `shell`, one of SHELLS, for each host program `hosts` can replace a terminal for, or null for another
// shell: the lines of the function, then the check for an alias that would bypass it. Each of `wraps` gets the same
// function under its own name after them, which needs exactly one such host.
export function functionLines(shell, hosts = HOSTS, wraps = []) {
  if (!SHELLS.includes(shell)) return null;
  const replacers = hosts.map(replacer).filter(Boolean);
  for (const { program, attach } of replacers) {
    if (!WORD.test(program) || !WORD.test(attach)) throw new Error(`a host's program or attach word is not a plain word: ${program} ${attach}`);
  }
  const own = replacers.flatMap(({ program, attach }) => [...shellFunction(shell, program, program, attach), ...aliasCheck(program, program)]);
  if (wraps.length === 0) return own;
  // SHORTCUT: a wrap runs the one host's program, as wrapNote names it, which is enough while one host declares
  // replaceTerminal. A second host would need a wrap record that names each launcher's host program.
  if (replacers.length !== 1) throw new Error(`a wrapped launcher needs exactly one host that replaces a terminal, not ${replacers.length}`);
  const refused = wraps.findIndex((name) => wrapProblem(name) !== null);
  if (refused !== -1) throw new Error(`--wrap name ${refused + 1} of ${wraps.length} ${wrapProblem(wraps[refused])}`);
  const [{ program, attach }] = replacers;
  return [...own, ...wraps.flatMap((name) => wrapGuard(shell, name, [...shellFunction(shell, name, program, attach), ...aliasCheck(name, program)]))];
}

// `lines`, the wrapper of the launcher `name` and its alias check, run only when the shell reading the block has no
// function of that name, or has this block's own wrapper, as when the startup file is read again in the same shell.
// The wrapper is told by its first run, which both shells print as written. A function of the Human's own, such as a
// hook a terminal's setup registered, stays, and one line on stderr says the launcher was not wrapped. A function
// defined after the block replaces the wrapper, as any later definition does.
function wrapGuard(shell, name, lines) {
  const exists = shell === 'zsh' ? `builtin functions ${name}` : `builtin declare -F ${name}`;
  const body = shell === 'zsh' ? `builtin functions ${name}` : `builtin declare -f ${name}`;
  return [
    `if ${exists} >/dev/null 2>&1 && [[ $(${body}) != *'${SHELL_VAR}=$$ command ${name} "$@"'* ]]; then`,
    `  echo "aidrian shell-init: a shell function ${name} already exists, so the launcher ${name} was not wrapped" >&2`,
    'else',
    ...lines,
    'fi',
  ];
}

// What `aidrian shell-init <shell>` prints, or null for another shell.
export function shellInit(shell, hosts = HOSTS) {
  const lines = functionLines(shell, hosts);
  if (lines === null) return null;
  return `${[`# aidrian shell-init ${shell}: once a session that handed off ends itself, open the new one in this terminal.`, '# docs/handoff.md#replacing-the-terminal', ...lines].join('\n')}\n`;
}

// A function named `name`, the host's `program` or a launcher that ends in `exec` of it, declared with `function` so
// neither shell expands an alias of that name in its definition. It runs `name` with SHELL_VAR set to the shell's pid,
// then, while this shell's record is a regular file
// this user owns, deletes it and opens the session it names, when its id is plain and its expiry is neither past nor
// later than LATEST seconds away, with `program` itself, never through the launcher. It keeps the exit code of the last
// program it ran, and runs nothing from the record
// but that id. Each exit is caught with `||`, and every variable is set before it is read, so a shell that runs with
// `set -e` or `set -u` goes on to the record. zsh and bash read the same body; zsh first resets its options for the
// function, so a setting such as RE_MATCH_PCRE cannot change the patterns.
// Each time it opens a session by a plain id, typed as `program attach <id>`, after any options an alias adds, each with at most one value, or from
// the record, it first writes `follows-<shell pid>` beside the record, `<id> <epoch seconds>`, owner-only, and deletes
// it once that program exits: the gate of that session, run in the background, reads it to know this terminal follows
// it (terminal-replace.mjs readFollows). A typed target that is no plain id, such as a session's name, it writes as
// `~<hex> <epoch seconds>`, its bytes in lowercase hexadecimal through `od`, when it is 1 to NAME_BYTES bytes, so no
// character of it reaches the record as typed; the gate asks the host which session that target opens. A write it
// cannot make is skipped.
function shellFunction(shell, name, program, attach) {
  return [
    `function ${name} {`,
    ...(shell === 'zsh' ? ['  emulate -L zsh'] : []),
    `  local rc=0 id='' expires='' now=0 base="\${HOME:-}/.local/state" pattern='${OPEN_ID.source}' digits='^[0-9]{1,12}$'`,
    `  local follow='' hex='' bytes='^([0-9a-f]{2}){1,${NAME_BYTES}}$'`,
    '  [[ ${XDG_STATE_HOME:-} == /* ]] && base=$XDG_STATE_HOME',
    `  local dir="$base/aidrian/${TERMINAL_FOLDER}"`,
    `  local next="$dir/$$" follows="$dir/${FOLLOWS_PREFIX}$$"`,
    '  command rm -f -- "$follows" 2>/dev/null || :',
    "  local arg='' want=0 value=0",
    '  for arg in "$@"; do',
    ...typedTarget('    '),
    `    [[ $arg == ${attach} ]] && { want=1; continue; }`,
    '    if [[ $arg == -* ]]; then [[ $arg == *=* ]] && value=0 || value=1; continue; fi',
    '    (( value )) || break',
    '    value=0',
    '  done',
    ...followsWrite('  '),
    `  ${SHELL_VAR}=$$ command ${name} "$@" || rc=$?`,
    '  command rm -f -- "$follows" 2>/dev/null || :',
    '  while [[ -f $next && ! -L $next && -O $next ]]; do',
    "    id='' expires=''",
    "    IFS=' ' read -r id expires < \"$next\" || :",
    '    command rm -f -- "$next"',
    '    [[ $id =~ $pattern && $expires =~ $digits ]] || break',
    '    now=$(command date +%s)',
    `    (( expires >= now && expires <= now + ${LATEST} )) || break`,
    '    rc=0 follow=$id',
    ...followsWrite('    '),
    `    ${SHELL_VAR}=$$ command ${program} ${attach} "$id" || rc=$?`,
    '    command rm -f -- "$follows" 2>/dev/null || :',
    '  done',
    '  return $rc',
    '}',
  ];
}

// The lines, at `indent`, that read the attach target `$arg` once the loop reached it, into `$follow`: the target itself
// when it is a plain id, else `~` and the hex of its bytes, when it is 1 to NAME_BYTES bytes; then they end the loop.
const typedTarget = (indent) => [
  `${indent}if (( want )); then`,
  `${indent}  if [[ $arg =~ $pattern ]]; then follow=$arg`,
  `${indent}  elif [[ -n $arg ]]; then hex=$(command printf '%s' "$arg" | command od -An -tx1 -v | command tr -d ' \\t\\n') || hex=''; [[ $hex =~ $bytes ]] && follow="~$hex" || :`,
  `${indent}  fi`,
  `${indent}  break`,
  `${indent}fi`,
];

// The lines that write this shell's `follows-` record for `$follow`, a plain id or `~<hex>`, at `indent`: in a subshell,
// so its umask and noclobber stay there, into a folder that is a real one this user owns, made owner-only first, never
// through a file left in its place. The function deletes its record before it runs anything, so one an earlier run left
// never counts.
const followsWrite = (indent) => [
  `${indent}[[ -n $follow ]] && { ( umask 077 && command mkdir -p -- "$dir" && [[ -d $dir && ! -L $dir && -O $dir ]] && command chmod 700 "$dir" && command rm -f -- "$follows" \\`,
  `${indent}  && set -C && command printf '%s %s\\n' "$follow" "$(command date +%s)" > "$follows" ) 2>/dev/null || :; }`,
];

// One line on stderr when an alias of the function `name` remains whose value does not start with `name`, or with the
// host's `program` for a wrapped launcher: typed, it runs past the function, so a handoff would not replace the
// terminal. An alias that starts with either, such as one that adds a flag, reaches a function.
function aliasCheck(name, program) {
  const starts = name === program ? `${name}|${name}\\ *` : `${name}|${name}\\ *|${program}|${program}\\ *`;
  return [
    `if alias ${name} >/dev/null 2>&1; then`,
    `  _aidrian_alias=$(alias ${name}); _aidrian_alias=\${_aidrian_alias#*=}; _aidrian_alias=\${_aidrian_alias#\\'}; _aidrian_alias=\${_aidrian_alias%\\'}`,
    `  case $_aidrian_alias in ${starts}) ;; *) echo "aidrian shell-init: the alias ${name} runs past the shell function, so a handoff will not replace this terminal" >&2 ;; esac`,
    '  unset _aidrian_alias',
    'fi',
  ];
}

// The block --install writes for `shell`, wrapping `wraps` too, deduplicated and sorted, named on its third line.
export function rcBlock(shell, hosts = HOSTS, wraps = []) {
  const names = [...new Set(wraps)].sort();
  const record = names.length > 0 ? [`${WRAP_LINE} ${names.join(' ')}`] : [];
  return [
    BEGIN,
    `# Written by \`aidrian shell-init ${shell} --install\`, which replaces it when run again; \`--uninstall\` removes it.`,
    ...record,
    ...functionLines(shell, hosts, names),
    END,
  ].join('\n');
}

// The launchers the block `text` records on its third line: { names, readable }. No such line records none; a line that
// is not one rcBlock writes, 1 to MAX_WRAPS names that each pass wrapProblem, sorted, none twice, is unreadable.
export function wrapsOf(text) {
  const line = text.split('\n')[2] ?? '';
  if (!line.startsWith(WRAP_LINE)) return { names: [], readable: true };
  const names = line.slice(WRAP_LINE.length + 1).split(' ');
  const written = `${WRAP_LINE} ${[...new Set(names)].sort().join(' ')}`;
  const valid = names.length <= MAX_WRAPS && names.every((name) => wrapProblem(name) === null);
  return valid && line === written ? { names, readable: true } : { names: [], readable: false };
}

// Whether `block`, one blocksOf reads, is the current block for `shell` with the launchers it records. Never throws.
function isCurrent(shell, block) {
  if (block.broken) return false;
  try {
    return block.text === rcBlock(shell, HOSTS, wrapsOf(block.text).names);
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The blocks of `lines`: { start, end, text } for each, 0-based line numbers of its markers, or { start, broken: true }
// for a start marker with no end marker after it.
function blocksOf(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== BEGIN) continue;
    const end = lines.indexOf(END, index + 1);
    if (end === -1) return [...blocks, { start: index, broken: true }];
    blocks.push({ start: index, end, text: lines.slice(index, end + 1).join('\n') });
    index = end;
  }
  return blocks;
}

// The 1-based number of a line of `lines`, outside a block, that is not a comment and runs `aidrian shell-init`, or 0.
function ownLine(lines) {
  let inside = false;
  for (const [index, line] of lines.entries()) {
    if (line === BEGIN) inside = true;
    if (!inside && !line.trim().startsWith('#') && /\baidrian shell-init\b/u.test(line)) return index + 1;
    if (line === END) inside = false;
  }
  return 0;
}

// Writes the block to the startup file of `shell`: appended once, or replacing the blocks it holds, keeping every
// other line: { exitCode, out }, or { exitCode: 2, problem } when it would wrap more than MAX_WRAPS launchers. `wraps`,
// names that passed wrapProblem, are added to those the first block records; none is dropped.
export function install(shell, { env = process.env, platform = process.platform, wraps = [] } = {}) {
  const file = rcFile(shell, env);
  const text = readText(file) ?? '';
  const lines = text.split('\n');
  const blocks = blocksOf(lines);
  const broken = blocks.find((each) => each.broken);
  if (broken) return brokenMarker(file, broken);
  const recorded = blocks.length > 0 ? wrapsOf(blocks[0].text) : { names: [], readable: true };
  const names = [...new Set([...recorded.names, ...wraps])].sort();
  if (names.length > MAX_WRAPS) return { exitCode: 2, problem: `aidrian shell-init: --wrap would make the block wrap ${names.length} launchers, and it wraps at most ${MAX_WRAPS}.` };
  const block = rcBlock(shell, HOSTS, names);
  const after = [`Open a new terminal, or run \`source ${file}\`, and \`claude\` started there follows a background handoff in the same terminal.`, `\`aidrian shell-init ${shell} --uninstall\` removes the block.`, ...loginWarning(shell, env, platform)];
  const notes = [...unreadableNote(recorded), ...wrapNote(names)];
  if (blocks.length > 0) {
    if (blocks.length === 1 && isCurrent(shell, blocks[0]) && names.length === recorded.names.length) return { exitCode: 0, out: [`${file} already holds the current aidrian shell-init block; nothing changed.`, ...notes] };
    replaceFile(file, withoutBlocks(lines, blocks, block).join('\n'));
    return { exitCode: 0, out: [`Replaced the aidrian shell-init block in ${file} with the current one; no other line changed.`, ...after, ...notes] };
  }
  const own = ownLine(lines);
  if (own && wraps.length > 0) return { exitCode: 1, out: [`${file} already runs aidrian shell-init on line ${own}, outside a block; no launcher was wrapped, since a wrapped function lives in the block. Remove that line and run this command again.`] };
  if (own) return { exitCode: 0, out: [`${file} already runs aidrian shell-init on line ${own}, outside a block; nothing changed.`] };
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${lead}${block}\n`);
  return { exitCode: 0, out: [`Added the aidrian shell-init block to the end of ${file}; no other line changed.`, ...after, ...notes] };
}

// The line about the launchers the block wraps, last, so the output ends with how to start the list again.
function wrapNote(names) {
  if (names.length === 0) return [];
  const [{ program }] = HOSTS.map(replacer).filter(Boolean);
  const listed = names.map((name) => `\`${name}\``).join(', ');
  return [`It also wraps ${listed}: each runs as before, and follows a handoff when it is a program on PATH that ends in \`exec\` of \`${program}\`. \`--wrap\` adds a name and never drops one; \`--uninstall\` then \`--install\` starts the list again.`];
}

const unreadableNote = (recorded) => (recorded.readable ? [] : ['The block\'s line of wrapped launchers was not one this command wrote, so it kept none of them: `--wrap` names each launcher to wrap again.']);

// On macOS a new terminal starts bash as a login shell, which reads ~/.bash_profile and not ~/.bashrc: a line that says
// so when ~/.bash_profile does not name ~/.bashrc.
function loginWarning(shell, env, platform) {
  if (shell !== 'bash' || platform !== 'darwin') return [];
  const home = path.isAbsolute(env.HOME ?? '') ? env.HOME : homedir();
  const profile = readText(path.join(home, '.bash_profile')) ?? '';
  if (/\.bashrc\b/u.test(profile)) return [];
  return ['On macOS a new terminal starts bash as a login shell, which reads ~/.bash_profile, and it does not source ~/.bashrc: add `[ -f ~/.bashrc ] && . ~/.bashrc` to ~/.bash_profile, or the function never loads.'];
}

const brokenMarker = (file, block) => ({ exitCode: 1, out: [`${file} has the aidrian shell-init start marker on line ${block.start + 1} but no end marker after it; nothing changed. Remove the block by hand.`] });

// `lines` without the lines of `blocks`, with `replacement` in place of the first when given.
function withoutBlocks(lines, blocks, replacement = null) {
  const kept = [];
  let next = 0;
  for (const [index, block] of blocks.entries()) {
    kept.push(...lines.slice(next, block.start));
    if (index === 0 && replacement !== null) kept.push(...replacement.split('\n'));
    next = block.end + 1;
  }
  return [...kept, ...lines.slice(next)];
}

// Removes every block from the startup file of `shell`, and nothing else: { exitCode, out }. A start marker with no end
// marker after it changes nothing and exits 1.
export function uninstall(shell, { env = process.env } = {}) {
  const file = rcFile(shell, env);
  const text = readText(file);
  const lines = text === null ? [] : text.split('\n');
  const blocks = blocksOf(lines);
  if (blocks.some((each) => each.broken)) return brokenMarker(file, blocks.find((each) => each.broken));
  const kept = withoutBlocks(lines, blocks);
  const own = ownLine(kept);
  const left = own ? [`Line ${own} of ${file} runs aidrian shell-init outside a block, and was left as it is.`] : [];
  if (blocks.length === 0) return { exitCode: 0, out: [`${file} holds no aidrian shell-init block; nothing changed.`, ...left] };
  replaceFile(file, kept.join('\n'));
  const removed = blocks.map(({ start, end }) => `${start + 1}-${end + 1}`).join(', ');
  return { exitCode: 0, out: [`Removed the aidrian shell-init block, lines ${removed}, from ${file}; no other line changed.`, 'Open a new terminal for `claude` to run without it.', ...left] };
}

// Writes `content` over the file `file` points to, through a temporary file beside it, keeping its mode, so a startup
// file that is a link stays one.
function replaceFile(file, content) {
  const real = realpathSync(file);
  const temporary = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(temporary, statSync(real).mode & 0o7777);
    renameSync(temporary, real);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// The command the session hands the Human for `shell`: `!` runs it in the session as the Human's own.
const handCommand = (shell, flag = '--install') => `\`! aidrian shell-init ${shell} ${flag}\``;

// The blocks of the startup file of `shell` under `env`, as blocksOf reads them, or [] when it cannot be read.
function rcBlocks(shell, env) {
  try {
    const text = readText(rcFile(shell, env));
    return text === null ? [] : blocksOf(text.split('\n'));
  } catch {
    return [];
  }
}

// The session start's one `Handoff terminal:` line, or null, on a host that can replace a terminal while this machine's
// switch `background` is on; `human` names the Human. The first that applies:
// 1. A startup file whose blocks are not one current block: the line that names every such file and the command that
//    replaces its block, for any session, since a session the function started runs the old text too. It never
//    rewrites a block itself.
// 2. An attended session the function did not start, while the working config's `handoff` resolves to the background
//    route in `auto` mode, so its terminal stays after a handoff: with the current block in a startup file, it was
//    started past it (pastLine); with none, the install line (installLine).
// It reads the two startup files and nothing else: no process, so a start costs no `ps`. A file it cannot read holds
// no block here, and the line never throws.
export function terminalLine({ host, background, handoff, env = process.env, human }) {
  const replace = replacer(host);
  if (!replace || background !== 'on') return null;
  const files = SHELLS.map((shell) => {
    const blocks = rcBlocks(shell, env);
    return { shell, file: rcFile(shell, env), blocks, current: blocks.length === 1 && isCurrent(shell, blocks[0]) };
  });
  const stale = files.filter(({ blocks, current }) => blocks.length > 0 && !current);
  if (stale.length > 0) return staleLine(stale, human);
  if (handoff?.mode !== 'auto' || handoff?.continue !== 'background') return null;
  if (shellPid(env) !== null || !replace.attended(env)) return null;
  const holder = files.find(({ current }) => current);
  return holder ? pastLine(replace, holder.shell, human) : installLine(replace, human);
}

// The line for the startup files `stale` names, { shell, file } each: one file keeps the singular wording.
function staleLine(stale, human) {
  if (stale.length === 1) {
    const [{ shell, file }] = stale;
    return `Handoff terminal: the aidrian shell function block in ${file} differs from this plugin's, so a handoff may not replace the terminal as this version does. ` +
      `This session hands ${human} the command ${handCommand(shell)}, which replaces the block, and never runs it or edits the file itself.`;
  }
  const files = stale.map(({ file }) => file).join(' and ');
  const commands = stale.map(({ shell }) => handCommand(shell)).join(' and ');
  return `Handoff terminal: the aidrian shell function blocks in ${files} differ from this plugin's, so a handoff may not replace the terminal as this version does. ` +
    `This session hands ${human} the commands ${commands}, which replace them, and never runs them or edits the files itself.`;
}

// The current block is installed, yet the function did not start the session: a launcher, an editor command, or a
// terminal opened before the install started it. A launcher on PATH opts in with `--wrap`; the session cannot tell
// which of the three it was without reading processes, so the line names all three. A copy of the plugin older than this
// one, first on PATH, refuses `--wrap`, so the line says to update it first.
function pastLine(replace, shell, human) {
  const { program } = replace;
  return `Handoff terminal: this session's \`${program}\` was started past the aidrian shell function, such as by a launcher, an editor command, or a terminal opened before the function was installed, so this terminal will not switch at a background handoff. ` +
    `A new terminal settles the last. For a launcher on PATH that ends in \`exec ${program}\`, this session hands ${human} ${handCommand(shell, '--install --wrap <launcher>')}, ` +
    `with the launcher's own name in place of \`<launcher>\`, and never runs it itself, since it writes ${human}'s shell startup file. ` +
    olderWrap(replace);
}

// The sentence for a copy of the plugin older than `--wrap`, with the update command of `replace`, the host's terminal
// replacer, when it declares one. The handoff's line for a terminal the function did not start ends on it too.
export const olderWrap = (replace) => `A copy of the plugin older than this one refuses \`--wrap\` as an unknown option: the plugin is updated first${updateWith(replace)}.`;

// No startup file holds a block: the install command for either shell, after an update when the copy is older.
function installLine(replace, human) {
  return `Handoff terminal: this machine's background handoff route is on, but the aidrian shell function did not start this session's \`${replace.program}\`, ` +
    `so after a background handoff this terminal stays on the old session beside the new one. For it to follow, this session hands ${human} ` +
    `${handCommand('zsh')}, or ${handCommand('bash')} for bash, to run once before opening a new terminal, and never runs it itself, since it writes ${human}'s shell startup file. ` +
    `A copy of the plugin older than this one answers \`unknown command: shell-init\`: the plugin is updated first${updateWith(replace)}.`;
}

// The host's update command, as the end of a sentence that says to update the plugin, or nothing when it declares none.
const updateWith = (replace) => (typeof replace.updateCommand === 'string' ? `, with \`${replace.updateCommand}\`` : '');

export const commands = {
  'shell-init': {
    usage: `(${SHELLS.join(' | ')}) [--install [--wrap NAME]... | --uninstall]`,
    about: 'print the shell function that opens the new session in the same terminal once a background handoff ends the old one; --install writes it into ~/.zshrc or ~/.bashrc, replacing an earlier one, --wrap also writes it under a launcher\'s name, and --uninstall removes it',
    run(args) {
      const options = { install: { type: 'boolean' }, uninstall: { type: 'boolean' }, wrap: { type: 'string', multiple: true } };
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
      const [shell, ...extra] = positionals;
      const wraps = values.wrap ?? [];
      if (!SHELLS.includes(shell) || extra.length > 0 || (values.install && values.uninstall) || (wraps.length > 0 && !values.install)) return refuse();
      const refused = wraps.findIndex((name) => wrapProblem(name) !== null);
      if (refused !== -1) return refuse(`aidrian shell-init: --wrap name ${refused + 1} of ${wraps.length} ${wrapProblem(wraps[refused])}.`);
      if (!values.install && !values.uninstall) {
        process.stdout.write(shellInit(shell));
        return 0;
      }
      const result = values.install ? install(shell, { wraps }) : uninstall(shell);
      if (result.problem) return refuse(result.problem);
      console.log(result.out.join('\n'));
      return result.exitCode;
    },
  },
};

// The usage line, and `problem` when given, on stderr: exit 2, with nothing written.
function refuse(problem = null) {
  console.error(`usage: aidrian shell-init ${commands['shell-init'].usage}`);
  if (problem) console.error(problem);
  return 2;
}
