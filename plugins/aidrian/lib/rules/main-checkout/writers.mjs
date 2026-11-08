// The programs that write their operands, and which operands each one writes, for the main-checkout rule's Bash
// targets (bash-writes.mjs).

import { homedir } from 'node:os';
import path from 'node:path';

import { isLongOption, readShortOptions } from '../../shell-lex.mjs';

// Programs whose every operand is written, and the options of each that take a value: the rest of a short option's
// word (`-e's/a/b/'`), or else the next word. A long one also matches by a prefix, as getopt_long reads it:
// `sed --fi script.sed` takes `--file`'s value.
export const WRITERS = new Map([
  ['tee', new Set()],
  ['rm', new Set()],
  ['unlink', new Set()],
  ['touch', new Set(['-t', '-r', '-d', '--reference', '--date'])],
  ['mkdir', new Set(['-m', '--mode'])],
  // -l takes a value in GNU sed and none in BSD sed, so it is left out and its value reads as one more operand.
  ['sed', new Set(['-e', '-f', '--expression', '--file', '--line-length'])],
  ['cp', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['mv', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['ln', new Set(['-S', '--suffix', '-t', '--target-directory'])],
  ['install', new Set(['-S', '--suffix', '-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group'])],
  ['truncate', new Set(['-s', '--size', '-r', '--reference', '-o'])],
  ['dd', new Set()],
  // Options that take the rest of their word or the next one (perlrun, ruby -h). The rest-only ones are in REST_VALUES:
  // listed here, they would take the next word, which can be the file written.
  ['perl', new Set(['-e', '-E', '-I'])],
  [
    'ruby',
    new Set([
      '-e', '-I', '-C', '-r', '-E', '--encoding', '--external-encoding', '--internal-encoding', '--enable', '--disable',
      '--backtrace-limit', '--parser', '--crash-report', '--dump',
    ]),
  ],
  // A value option whose name extends a switch (`--partial-dir`, `--backup-dir`) is left out, so the switch never
  // swallows an operand. An unlisted option's value reads as one more path: blocked by mistake, never missed.
  [
    'rsync',
    new Set([
      '-e', '--rsh', '--rsync-path', '-f', '--filter', '--exclude', '--exclude-from', '--include', '--include-from',
      '--files-from', '-T', '--temp-dir', '--compare-dest', '--copy-dest', '--link-dest', '--chmod', '--chown',
      '--suffix', '--log-file', '--info', '--debug', '--timeout', '--bwlimit', '--max-size', '--min-size', '-B',
      '--block-size', '-M', '--remote-option', '--out-format', '--password-file', '--port',
    ]),
  ],
]);
// Options that take only the rest of their word: sed's in-place suffix, `-i.bak`, so `-ie` is -i with the suffix "e".
// BSD sed's -I edits in place too.
// perl and ruby take `-i[suffix]` the same way, and their other rest-only options (`-Mstrict`, `-rjson`) never take the
// next word: `perl -M strict` is an error.
const REST_VALUES = new Map([
  ['sed', new Set(['-i', '-I'])],
  ['perl', new Set(['-i', '-M', '-m', '-C', '-x', '-D', '-F'])],
  ['ruby', new Set(['-i', '-F', '-x'])],
]);
// Options whose value has a fixed shape (perl -h, ruby -h), so the switches after it still count: `-0777pi`, `-lpi`,
// `-dpi`, `-W0pi`, `-Kupi`. Each pattern matches the option letter and its value.
const SHORT_VALUES = new Map([
  ['perl', /0(?:x[0-9a-f]+|[0-7]+)?|l[0-7]*|dt?(?::[\w:=,]+)?/giu],
  ['ruby', /0[0-7]*|W(?:[0-2]|:\w+)?|K[a-zA-Z]?|T[0-9]*/gu],
]);
// The option that gives a script on the command line, so every operand is a file; without it the first is the script.
const SCRIPT_OPTIONS = new Map([['perl', ['-e', '-E']], ['ruby', ['-e']]]);
// The options that change the folder the interpreter runs in.
const CHANGES_FOLDER = new Map([['perl', ['-x']], ['ruby', ['-C', '-x']]]);

// The cp-like writers: they write their last operand, or the -t directory.
const COPIERS = new Set(['cp', 'ln', 'install']);
// An rsync operand naming another host: `host:path`, `user@host:path`, `host::module`, or `rsync://host/module`.
const REMOTE = /^[^/]*:/u;

// A write target as the shell reads a leading `~`: `~` and `~/x` are in the home folder, not in the shell's folder.
// `~user` stays as written, and so does a token marked `literal`, cut from inside a word or built by this rule: the shell
// expands `~` only at a word's start, so `-t~/x` and `of=~/x` name a folder called `~`. Accepted residual: the lexer drops quotes, so a quoted "~/x", a literal folder named `~`, reads the same.
const isHomeWord = ({ text, literal = false }) => !literal && (text === '~' || text.startsWith('~/'));
export const expandHome = (token) => (isHomeWord(token) ? path.join(homedir(), token.text.slice(1)) : token.text);

// The operands a writer writes: all of them, every path of mv, the destination of cp and rsync (and rsync's sources
// under --remove-source-files), and the files of sed -i, never its script.
export function written(program, args, valueFlags = WRITERS.get(program)) {
  const flags = [];
  const operands = [];
  let folder = null;
  let suffix = null;
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text } = args[i];
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('--')) {
      flags.push(text);
      if (valueFlags.has(text) || (/^--[^=]+$/u.test(text) && [...valueFlags].some((option) => option.startsWith(text)))) i += 1;
    } else if (!ended && text.startsWith('-') && text.length > 1) {
      // Drop the values of fixed-shape options, up to the first option that takes the rest of the word.
      const cluster = SHORT_VALUES.has(program) ? withoutShortValues(text, program) : text;
      const { options, value } = readShortOptions(cluster, valueFlags, REST_VALUES.get(program));
      flags.push(...options);
      if (SCRIPT_OPTIONS.has(program) && value?.option === '-i') suffix = { text: value.attached ?? '', dynamic: args[i].dynamic };
      if (CHANGES_FOLDER.get(program)?.includes(value?.option)) {
        // ruby changes folder at each option, so `ruby -C one -C two` runs in one/two; perl keeps only its last -x.
        const next = value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic: args[i].dynamic, literal: true };
        const compose = program === 'ruby' && folder !== null && next && !path.isAbsolute(next.text) && !isHomeWord(next);
        // A bare perl -x keeps the folder an earlier -x chose.
        if (next && next.text !== '') folder = compose ? { text: path.join(folder.text, next.text), dynamic: folder.dynamic || next.dynamic, literal: folder.literal } : next;
      }
      if (value?.attached === null) i += 1;
    } else if (text !== '') {
      operands.push(args[i]); // an empty operand is BSD sed's `-i ''` suffix
      // perl and ruby read their own options only up to the first operand; what follows is the script's.
      if (SCRIPT_OPTIONS.has(program)) ended = true;
    }
  }
  if (program === 'dd') return operands.filter(({ text }) => text.startsWith('of=')).map((token) => ({ ...token, text: token.text.slice(3), literal: true }));
  if (program === 'install' && flags.some((flag) => flag === '-d' || isLongOption(flag, '--directory', '--d'))) return operands;
  if (COPIERS.has(program) || program === 'mv') {
    const directory = targetDirectory(args);
    if (program === 'mv') return directory ? [...operands, directory] : operands;
    if (directory) return [directory];
    return operands.length >= 2 ? operands.slice(-1) : [];
  }
  if (program === 'rsync') {
    if (operands.length < 2) return [];
    const removesSources = flags.some((flag) => isLongOption(flag, '--remove-source-files', '--remov') || isLongOption(flag, '--remove-sent-files', '--remov'));
    return (removesSources ? operands : operands.slice(-1)).filter((token) => !REMOTE.test(token.text));
  }
  if (SCRIPT_OPTIONS.has(program)) {
    // perl -i and ruby -i edit their files in place; without -i they only read them, and -c only checks syntax.
    if (!flags.includes('-i') || flags.includes('-c')) return [];
    const edited = flags.some((flag) => SCRIPT_OPTIONS.get(program).includes(flag)) ? operands : operands.slice(1);
    // A suffix also writes a backup: `-i.bak` beside each file, `-i'old/*'` with `*` for the file's name.
    const backups = suffix?.text ? edited.map((token) => ({ ...token, dynamic: token.dynamic || suffix.dynamic, text: backupOf(program, expandHome(token), suffix.text), literal: true })) : [];
    const files = [...edited, ...backups];
    // ruby -C and -x, and perl -x, run in the folder they name: a relative file is read from there.
    if (folder === null || folder.text === '') return files;
    return files.map((token) => (path.isAbsolute(token.text) || isHomeWord(token) ? token : { ...token, text: path.join(folder.text, token.text), dynamic: token.dynamic || folder.dynamic, literal: folder.literal }));
  }
  if (program !== 'sed') return operands;
  // GNU sed takes a prefix of a long option: `--i` is `--in-place`, `--e` is `--expression`, `--fi` is `--file`.
  const inPlace = flags.some((flag) => REST_VALUES.get('sed').has(flag) || isLongOption(flag, '--in-place', '--i'));
  if (!inPlace) return [];
  const scripted = flags.some((flag) => flag === '-e' || flag === '-f' || isLongOption(flag, '--expression', '--e') || isLongOption(flag, '--file', '--fi'));
  return scripted ? operands : operands.slice(1);
}

// The backup an in-place edit with `suffix` writes for `file`, as each interpreter does it (checked by running both):
// perl puts the file, as written, in place of each `*` (`-i'old/*'` on `src/f` writes `old/src/f`) and otherwise
// appends the suffix; ruby always appends it, `*` included.
function backupOf(program, file, suffix) {
  return program === 'perl' && suffix.includes('*') ? suffix.replaceAll('*', file) : `${file}${suffix}`;
}

// A perl or ruby option cluster without the values of its fixed-shape options: `-0777pi` reads as `-0pi`. What follows
// an option that takes the rest of the word (`-i.bak0`, `-Mfoo0`) belongs to it and stays.
function withoutShortValues(text, program) {
  const rest = REST_VALUES.get(program);
  const values = WRITERS.get(program);
  let out = '-';
  for (let i = 1; i < text.length; i += 1) {
    const option = `-${text[i]}`;
    if (rest.has(option) || values.has(option)) return out + text.slice(i);
    out += text[i];
    const pattern = SHORT_VALUES.get(program);
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (match?.index === i) i += match[0].length - 1;
  }
  return out;
}

// The directory cp or mv writes into with GNU -t, in any spelling: `-t DIR`, `-tDIR`, `-ft DIR`, `--target-directory=DIR`,
// or a prefix of it. Null without one.
function targetDirectory(args) {
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (text === '--') return null;
    if (text.startsWith('--')) {
      if (!isLongOption(text, '--target-directory', '--t')) continue;
      const equals = text.indexOf('=');
      return equals === -1 ? args[i + 1] ?? null : { text: text.slice(equals + 1), dynamic, literal: true };
    }
    if (!/^-./u.test(text)) continue;
    // In a cluster, -S takes the rest as its suffix, and -t takes the rest, or the next word, as the directory.
    const { value } = readShortOptions(text, WRITERS.get('cp'));
    if (value?.option === '-t') return value.attached === null ? args[i + 1] ?? null : { text: value.attached, dynamic, literal: true };
  }
  return null;
}
