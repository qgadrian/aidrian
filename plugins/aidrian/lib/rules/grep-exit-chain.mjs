// Bash rule: no counting grep as a link of an `&&` chain. `grep -c` exits 1 when it counts zero, and zero is usually the
// answer the caller wanted; in `grep -c error log && npm test` that clean answer skips the tests and reports failure.
//
// Denied when `&&` follows the grep (it gates the rest), or precedes it with nothing after (its status is the line's).
// Allowed when `||` follows it, a `;` or newline separates a later command, a pipe takes its status (unless
// `set -o pipefail` is on: then the pipeline carries it), a `!` inverts it, or a trailing `&` backgrounds the list.

import { lexPipeline, readInvocation } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_GREP_EXIT_CHAIN';

const PIPES = new Set(['|', '|&']);
const GREP_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep']);
const COUNT_LONG_FLAGS = new Set(['--count', '--count-matches']);
// Options whose value is the next token, so `grep -e -c file` searches for "-c". `--color` is not one: GNU grep's value
// is optional and attached, and reading it as value-taking would hide the `-c` in `grep --color -c x f`.
const VALUE_FLAGS = new Set([
  '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context',
  '--before-context', '--context', '--directories', '--devices', '--include', '--exclude', '--exclude-dir', '--glob', '--type',
]);
// Short options that take the rest of their bundle as the value: the `c` in `-A3c` is part of `-A`'s value.
const SHORT_VALUE_FLAGS = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);

// The deny reason for `command`, or null.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  const { segments, separators } = lexPipeline(command);
  // `set -o pipefail` applies to what follows. A toggle behind `&&`/`||` may never run, and one in a pipeline or in the
  // background runs in a child shell, so such a toggle may turn pipefail on but never off.
  let pipefail = false;
  for (let i = 0; i < segments.length; i += 1) {
    const toggle = pipefailToggle(segments[i]);
    if (toggle !== null) {
      const conditional = separators[i - 1] === '&&' || separators[i - 1] === '||';
      const child = PIPES.has(separators[i]) || PIPES.has(separators[i - 1]) || separators[i] === '&';
      if (toggle) pipefail = true;
      else if (!conditional && !child) pipefail = false;
      continue;
    }
    const { program, args } = readInvocation(segments[i]);
    if (!GREP_PROGRAMS.has(program) || !asksForCount(args)) continue;
    // Without pipefail a pipe swallows the grep's status; with it, the whole pipeline is the unit.
    let first = i;
    let last = i;
    if (pipefail) {
      while (first > 0 && PIPES.has(separators[first - 1])) first -= 1;
      while (PIPES.has(separators[last])) last += 1;
    }
    if (readInvocation(segments[first]).negated) continue;
    const gatesWhatFollows = separators[last] === '&&';
    const isGatedLastLink = separators[first - 1] === '&&' && last === segments.length - 1 && separators[last] !== '&';
    if (gatesWhatFollows || isGatedLastLink) return reason(command);
  }
  return null;
}

// Whether grep's arguments ask for a count: `-c`, a bundle such as `-rc`, or `--count`.
export function asksForCount(args) {
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) continue;
    if (text === '--') return false;
    if (COUNT_LONG_FLAGS.has(text)) return true;
    if (text.startsWith('--')) {
      if (!text.includes('=') && VALUE_FLAGS.has(text)) i += 1;
      continue;
    }
    if (!text.startsWith('-') || text === '-') continue;
    if (VALUE_FLAGS.has(text)) {
      i += 1;
      continue;
    }
    for (const letter of text.slice(1)) {
      if (letter === 'c') return true;
      if (SHORT_VALUE_FLAGS.has(letter)) break;
    }
  }
  return false;
}

// true for `set -o pipefail` (also bundled, as in `set -euo pipefail`), false for `set +o pipefail`, null otherwise.
export function pipefailToggle(segment) {
  const { program, args } = readInvocation(segment);
  if (program !== 'set') return null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) continue;
    const on = /^-[a-z]*o$/u.test(token.text);
    const off = /^\+[a-z]*o$/u.test(token.text);
    const value = args[i + 1];
    if ((on || off) && value && !value.dynamic && value.text === 'pipefail') return on;
  }
  return null;
}

function reason(command) {
  const shown = command.length > 300 ? `${command.slice(0, 297)}...` : command;
  return [
    'Blocked: a counting grep is chained with `&&`, so a clean result reads as a failed check.',
    '',
    `  ${shown}`,
    '',
    '`grep -c` exits 1 when it counts zero matches. In an `&&` chain the commands after it never run,',
    'and the whole line reports failure for the result you wanted. Pick one:',
    '  - run the counting grep on its own line, and read the number;',
    '  - neutralize its status in place: `... | grep -c ... || true && ...`;',
    '  - to gate on presence rather than a count, use `grep -q`, which exits 0 on a match.',
    '',
    `Human-only override for the whole session, set before it starts: ${OVERRIDE}=1`,
  ].join('\n');
}
