// `aidrian shell-init <shell> [--install | --uninstall]` (docs/handoff.md#replacing-the-terminal). Plain, it prints
// the shell function of lib/terminal-replace.mjs shellInit, for the shell's startup file to eval. `--install` appends a
// block that evals it to that file, `~/.zshrc` or `~/.bashrc`, once: a file that already holds the block, or a line of
// its own that runs `aidrian shell-init`, is left as it is. `--uninstall` removes the block, from its start marker to its
// end marker, and nothing else. A host's plugins have no install step, so the Human runs this once.
// The block finds `aidrian` at each shell start, so a plugin update that moves the installed copy changes nothing: the
// `aidrian` on PATH, a function included, else the highest version beside this copy in the folder the host keeps
// versions in, else, for a copy that is not one of those versions, such as a checkout, this copy's own command.

import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { shellInit, SHELLS } from './terminal-replace.mjs';

export const BEGIN = '# >>> aidrian shell-init >>>';
export const END = '# <<< aidrian shell-init <<<';
const COPY_ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = /^\d+\.\d+\.\d+$/u;
// A path the block may hold in single quotes.
const QUOTABLE = /^\/[^'\u0000-\u001f\u007f]*$/u;

// The startup file `shell` reads in an interactive session, under `env`.
export function rcFile(shell, env = process.env) {
  const home = path.isAbsolute(env.HOME ?? '') ? env.HOME : homedir();
  if (shell === 'zsh') return path.join(path.isAbsolute(env.ZDOTDIR ?? '') ? env.ZDOTDIR : home, '.zshrc');
  return path.join(home, '.bashrc');
}

// The lines that find `aidrian` when it is not on PATH, for the copy at `root`: the highest version in its parent
// folder when `root` is named as a version, else `root`'s own command. None for a path the block cannot quote.
function fallbackLines(shell, root) {
  const versions = path.dirname(root);
  if (VERSION.test(path.basename(root)) && QUOTABLE.test(versions)) {
    return [
      `  _aidrian_v=$(command ls '${versions}' 2>/dev/null | command grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$' | command sort -t. -k1,1n -k2,2n -k3,3n | command tail -n 1)`,
      `  [ -n "$_aidrian_v" ] && [ -x '${versions}'/"$_aidrian_v"/bin/aidrian ] && eval "$('${versions}'/"$_aidrian_v"/bin/aidrian shell-init ${shell} 2>/dev/null)"`,
      '  unset _aidrian_v',
    ];
  }
  const bin = path.join(root, 'bin', 'aidrian');
  return QUOTABLE.test(bin) ? [`  [ -x '${bin}' ] && eval "$('${bin}' shell-init ${shell} 2>/dev/null)"`] : ['  :'];
}

// The block --install appends for `shell`, from the copy at `root`.
export function rcBlock(shell, root = COPY_ROOT) {
  return [
    BEGIN,
    `# Added by \`aidrian shell-init ${shell} --install\`; \`aidrian shell-init ${shell} --uninstall\` removes this block.`,
    'if command -v aidrian >/dev/null 2>&1; then',
    `  eval "$(aidrian shell-init ${shell} 2>/dev/null)"`,
    'else',
    ...fallbackLines(shell, root),
    'fi',
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

// The 1-based number of a line of `lines`, outside the block, that is not a comment and runs `aidrian shell-init`, or 0.
function ownLine(lines) {
  let inside = false;
  for (const [index, line] of lines.entries()) {
    if (line === BEGIN) inside = true;
    if (!inside && !line.trim().startsWith('#') && /\baidrian shell-init\b/u.test(line)) return index + 1;
    if (line === END) inside = false;
  }
  return 0;
}

// Appends the block to the startup file of `shell`, once: { exitCode, out }.
export function install(shell, { env = process.env, root = COPY_ROOT } = {}) {
  const file = rcFile(shell, env);
  const text = readText(file) ?? '';
  const lines = text.split('\n');
  if (lines.includes(BEGIN)) return { exitCode: 0, out: [`${file} already holds the aidrian shell-init block; nothing changed.`] };
  const own = ownLine(lines);
  if (own) return { exitCode: 0, out: [`${file} already runs aidrian shell-init on line ${own}, outside a block; nothing changed.`] };
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${lead}${rcBlock(shell, root)}\n`);
  return {
    exitCode: 0,
    out: [
      `Added the aidrian shell-init block to the end of ${file}; no other line changed.`,
      `Open a new terminal, or run \`source ${file}\`, and \`claude\` started there follows a background handoff in the same terminal.`,
      `\`aidrian shell-init ${shell} --uninstall\` removes the block.`,
    ],
  };
}

// Removes every block from the startup file of `shell`, and nothing else: { exitCode, out }. A start marker with no end
// marker after it changes nothing and exits 1.
export function uninstall(shell, { env = process.env } = {}) {
  const file = rcFile(shell, env);
  const text = readText(file);
  const lines = text === null ? [] : text.split('\n');
  const kept = [];
  const removed = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== BEGIN) {
      kept.push(lines[index]);
      continue;
    }
    const end = lines.indexOf(END, index + 1);
    if (end === -1) return { exitCode: 1, out: [`${file} has the aidrian shell-init start marker on line ${index + 1} but no end marker after it; nothing changed. Remove the block by hand.`] };
    removed.push(`${index + 1}-${end + 1}`);
    index = end;
  }
  const own = ownLine(kept);
  const left = own ? [`Line ${own} of ${file} runs aidrian shell-init outside a block, and was left as it is.`] : [];
  if (removed.length === 0) return { exitCode: 0, out: [`${file} holds no aidrian shell-init block; nothing changed.`, ...left] };
  replaceFile(file, kept.join('\n'));
  return { exitCode: 0, out: [`Removed the aidrian shell-init block, lines ${removed.join(', ')}, from ${file}; no other line changed.`, 'Open a new terminal for `claude` to run without it.', ...left] };
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

export const commands = {
  'shell-init': {
    usage: `(${SHELLS.join(' | ')}) [--install | --uninstall]`,
    about: 'print the shell function that opens the new session in the same terminal once a background handoff ends the old one; --install adds the block that evals it to ~/.zshrc or ~/.bashrc once, --uninstall removes it',
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
