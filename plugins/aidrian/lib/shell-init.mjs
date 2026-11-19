// `aidrian shell-init <shell> [--install | --uninstall]` (docs/handoff.md#replacing-the-terminal). Plain, it prints the
// shell function that lets a terminal follow a background handoff (lib/terminal-replace.mjs). `--install` writes that
// function itself into the shell's startup file, `~/.zshrc` or `~/.bashrc`, between two marker lines: no plugin code runs
// at shell start, and nothing is looked up on PATH. A run that finds the block replaces it, so a re-run after an update
// brings it to the current text; a file with a line of its own that runs `aidrian shell-init` is left as it is.
// `--uninstall` removes the block, from its start marker to its end marker, and nothing else. A host's plugins have no
// install step, and the startup file is the Human's: the Human runs either one, and lib/rules/shell-init-install.mjs
// refuses both to an agent. The session start says when a block differs from the current text (staleBlockLines).

import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { HOSTS } from './hosts/index.mjs';
import { FOLLOWS_PREFIX, NEXT_MARGIN, NEXT_WINDOW, OPEN_ID, replacer, shellPid, SHELL_VAR, TERMINAL_FOLDER } from './terminal-replace.mjs';

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

// The functions for `shell`, one of SHELLS, for each host program `hosts` can replace a terminal for, or null for another
// shell: the lines of the function, then the check for an alias that would bypass it.
export function functionLines(shell, hosts = HOSTS) {
  if (!SHELLS.includes(shell)) return null;
  const replacers = hosts.map(replacer).filter(Boolean);
  for (const { program, attach } of replacers) {
    if (!WORD.test(program) || !WORD.test(attach)) throw new Error(`a host's program or attach word is not a plain word: ${program} ${attach}`);
  }
  return replacers.flatMap(({ program, attach }) => [...shellFunction(shell, program, attach), ...aliasCheck(program)]);
}

// What `aidrian shell-init <shell>` prints, or null for another shell.
export function shellInit(shell, hosts = HOSTS) {
  const lines = functionLines(shell, hosts);
  if (lines === null) return null;
  return `${[`# aidrian shell-init ${shell}: once a session that handed off ends itself, open the new one in this terminal.`, '# docs/handoff.md#replacing-the-terminal', ...lines].join('\n')}\n`;
}

// A function named `program`, declared with `function` so neither shell expands an alias of that name in its
// definition. It runs `program` with SHELL_VAR set to the shell's pid, then, while this shell's record is a regular file
// this user owns, deletes it and opens the session it names, when its id is plain and its expiry is neither past nor
// later than LATEST seconds away. It keeps the exit code of the last program it ran, and runs nothing from the record
// but that id. Each exit is caught with `||`, and every variable is set before it is read, so a shell that runs with
// `set -e` or `set -u` goes on to the record. zsh and bash read the same body; zsh first resets its options for the
// function, so a setting such as RE_MATCH_PCRE cannot change the patterns.
// Each time it opens a session by a plain id, typed as `program attach <id>` or from the record, it first writes
// `follows-<shell pid>` beside the record, `<id> <epoch seconds>`, owner-only, and deletes it once that program exits:
// the gate of that session, run in the background, reads it to know this terminal follows it (terminal-replace.mjs
// readFollows). A write it cannot make is skipped.
function shellFunction(shell, program, attach) {
  return [
    `function ${program} {`,
    ...(shell === 'zsh' ? ['  emulate -L zsh'] : []),
    `  local rc=0 id='' expires='' now=0 base="\${HOME:-}/.local/state" pattern='${OPEN_ID.source}' digits='^[0-9]{1,12}$'`,
    '  [[ ${XDG_STATE_HOME:-} == /* ]] && base=$XDG_STATE_HOME',
    `  local dir="$base/aidrian/${TERMINAL_FOLDER}"`,
    `  local next="$dir/$$" follows="$dir/${FOLLOWS_PREFIX}$$"`,
    '  command rm -f -- "$follows" 2>/dev/null || :',
    `  [[ \${1:-} == ${attach} && \${2:-} =~ $pattern ]] && id=$2`,
    ...followsWrite('  '),
    `  ${SHELL_VAR}=$$ command ${program} "$@" || rc=$?`,
    '  command rm -f -- "$follows" 2>/dev/null || :',
    '  while [[ -f $next && ! -L $next && -O $next ]]; do',
    "    id='' expires=''",
    "    IFS=' ' read -r id expires < \"$next\" || :",
    '    command rm -f -- "$next"',
    '    [[ $id =~ $pattern && $expires =~ $digits ]] || break',
    '    now=$(command date +%s)',
    `    (( expires >= now && expires <= now + ${LATEST} )) || break`,
    '    rc=0',
    ...followsWrite('    '),
    `    ${SHELL_VAR}=$$ command ${program} ${attach} "$id" || rc=$?`,
    '    command rm -f -- "$follows" 2>/dev/null || :',
    '  done',
    '  return $rc',
    '}',
  ];
}

// The lines that write this shell's `follows-` record for a plain `$id`, at `indent`: in a subshell, so its umask and
// noclobber stay there, into a folder that is a real one this user owns, made owner-only first, never through a file
// left in its place. The function deletes its record before it runs anything, so one an earlier run left never counts.
const followsWrite = (indent) => [
  `${indent}[[ -n $id ]] && { ( umask 077 && command mkdir -p -- "$dir" && [[ -d $dir && ! -L $dir && -O $dir ]] && command chmod 700 "$dir" && command rm -f -- "$follows" \\`,
  `${indent}  && set -C && command printf '%s %s\\n' "$id" "$(command date +%s)" > "$follows" ) 2>/dev/null || :; }`,
];

// One line on stderr when an alias of `program` remains whose value does not start with `program`: typed, it runs past
// the function, so a handoff would not replace the terminal. An alias that starts with it, such as one that adds a flag,
// reaches the function.
function aliasCheck(program) {
  return [
    `if alias ${program} >/dev/null 2>&1; then`,
    `  _aidrian_alias=$(alias ${program}); _aidrian_alias=\${_aidrian_alias#*=}; _aidrian_alias=\${_aidrian_alias#\\'}; _aidrian_alias=\${_aidrian_alias%\\'}`,
    `  case $_aidrian_alias in ${program}|${program}\\ *) ;; *) echo "aidrian shell-init: the alias ${program} runs past the shell function, so a handoff will not replace this terminal" >&2 ;; esac`,
    '  unset _aidrian_alias',
    'fi',
  ];
}

// The block --install writes for `shell`.
export function rcBlock(shell, hosts = HOSTS) {
  return [
    BEGIN,
    `# Written by \`aidrian shell-init ${shell} --install\`, which replaces it when run again; \`--uninstall\` removes it.`,
    ...functionLines(shell, hosts),
    END,
  ].join('\n');
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
// other line: { exitCode, out }.
export function install(shell, { env = process.env, platform = process.platform } = {}) {
  const file = rcFile(shell, env);
  const text = readText(file) ?? '';
  const lines = text.split('\n');
  const blocks = blocksOf(lines);
  const block = rcBlock(shell);
  const after = [`Open a new terminal, or run \`source ${file}\`, and \`claude\` started there follows a background handoff in the same terminal.`, `\`aidrian shell-init ${shell} --uninstall\` removes the block.`, ...loginWarning(shell, env, platform)];
  if (blocks.some((each) => each.broken)) return brokenMarker(file, blocks.find((each) => each.broken));
  if (blocks.length > 0) {
    if (blocks.length === 1 && blocks[0].text === block) return { exitCode: 0, out: [`${file} already holds the current aidrian shell-init block; nothing changed.`] };
    const kept = withoutBlocks(lines, blocks, block);
    replaceFile(file, kept.join('\n'));
    return { exitCode: 0, out: [`Replaced the aidrian shell-init block in ${file} with the current one; no other line changed.`, ...after] };
  }
  const own = ownLine(lines);
  if (own) return { exitCode: 0, out: [`${file} already runs aidrian shell-init on line ${own}, outside a block; nothing changed.`] };
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${lead}${block}\n`);
  return { exitCode: 0, out: [`Added the aidrian shell-init block to the end of ${file}; no other line changed.`, ...after] };
}

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

// Whether a startup file holds the current block, alone.
const holdsCurrent = (env) => SHELLS.some((shell) => {
  const blocks = rcBlocks(shell, env);
  return blocks.length === 1 && blocks[0].text === rcBlock(shell);
});

// The session start's lines about the startup files, on a host that can replace a terminal while this machine's switch
// `background` is on: one for each startup file whose blocks differ from the current text, which a re-install replaces;
// it never rewrites one itself. `human` names the Human.
export function staleBlockLines({ host, background, env = process.env, human }) {
  if (!replacer(host) || background !== 'on') return [];
  return SHELLS.flatMap((shell) => {
    const file = rcFile(shell, env);
    const blocks = rcBlocks(shell, env);
    if (blocks.length === 0 || (blocks.length === 1 && blocks[0].text === rcBlock(shell))) return [];
    return [`Handoff terminal: the aidrian shell function block in ${file} differs from this plugin's, so a handoff may not replace the terminal as this version does. ` +
      `This session hands ${human} the command ${handCommand(shell)}, which replaces the block, and never runs it or edits the file itself.`];
  });
}

// The session start's line for an attended session the shell function did not start, on a host that can replace a
// terminal, while this machine's switch `background` is on and the working config's `handoff` resolves to the
// background route in `auto` mode: after a handoff its terminal would stay on the old session. Else null, and null too
// when a startup file already holds the current block: the session then runs where that file did not start it, such as
// an editor's terminal, and an install would change nothing.
export function unwrappedLine({ host, background, handoff, env, human }) {
  const replace = replacer(host);
  if (!replace || background !== 'on' || handoff?.mode !== 'auto' || handoff?.continue !== 'background') return null;
  if (shellPid(env) !== null || !replace.attended(env) || holdsCurrent(env)) return null;
  const update = typeof replace.updateCommand === 'string' ? `, with \`${replace.updateCommand}\`` : '';
  return `Handoff terminal: this machine's background handoff route is on, but the aidrian shell function did not start this session's \`${replace.program}\`, ` +
    `so after a background handoff this terminal stays on the old session beside the new one. For it to follow, this session hands ${human} ` +
    `${handCommand('zsh')}, or ${handCommand('bash')} for bash, to run once before opening a new terminal, and never runs it itself, since it writes ${human}'s shell startup file. ` +
    `A copy of the plugin older than this one answers \`unknown command: shell-init\`: the plugin is updated first${update}.`;
}

export const commands = {
  'shell-init': {
    usage: `(${SHELLS.join(' | ')}) [--install | --uninstall]`,
    about: 'print the shell function that opens the new session in the same terminal once a background handoff ends the old one; --install writes it into ~/.zshrc or ~/.bashrc, replacing an earlier one, and --uninstall removes it',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { install: { type: 'boolean' }, uninstall: { type: 'boolean' } } });
      const [shell, ...extra] = positionals;
      if (!SHELLS.includes(shell) || extra.length > 0 || (values.install && values.uninstall)) {
        console.error(`usage: aidrian shell-init ${commands['shell-init'].usage}`);
        return 2;
      }
      if (!values.install && !values.uninstall) {
        process.stdout.write(shellInit(shell));
        return 0;
      }
      const result = values.install ? install(shell) : uninstall(shell);
      console.log(result.out.join('\n'));
      return result.exitCode;
    },
  },
};
