// Bash rule: no counting grep as a link of an `&&` chain. `grep -c` exits 1 when it counts zero, and zero is usually the
// answer the caller wanted; in `grep -c error log && npm test` that clean answer skips the tests and reports failure.
//
// Denied when `&&` follows the grep (it gates the rest), or precedes it with nothing after (its status is the line's).
// Allowed when `||` follows it, a `;` or newline separates a later command, a pipe takes its status (unless
// `set -o pipefail` is on: then the pipeline carries it), a `!` inverts it, or a trailing `&` backgrounds the list.
// A command substitution that runs is a list of its own and is judged the same way.
//
// The deny hands back the line to run instead: the counting grep (its pipeline, under pipefail) wrapped as
// `{ … || true; }`, which keeps the count and the rest of the chain and drops only that status. It hands back none
// when a count sits behind a shell word (`if`, `then`, `!`), opens or closes a group, or is in a substitution whose
// text occurs twice: there the wrap could break the line or land on the wrong copy.

import { commandLines, excerpt, isLongOption, lexPipeline, readInvocation, readShortOptions } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_GREP_EXIT_CHAIN';

const PIPES = new Set(['|', '|&']);
export const GREP_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep']);
// grep takes `--cou` for `--count` (`--co` is ambiguous with `--color`); ripgrep takes no prefix of `--count-matches`.
const countsLong = (text) => text === '--count-matches' || isLongOption(text, '--count', '--cou');
// Options that take a value, so `grep -e -c file` searches for "-c". A short one takes the rest of its bundle when any
// is left: the `c` in `-A3c` is part of `-A`'s value. `--color` is not one: GNU grep's value is optional and attached,
// and reading it as value-taking would hide the `-c` in `grep --color -c x f`.
export const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context',
  '--before-context', '--context', '--directories', '--devices', '--include', '--exclude', '--exclude-dir', '--glob', '--type',
]);

const VALUE_FLAGS = GREP_VALUE_FLAGS;

// Shell words that open, close, or steer a command, and so cannot move inside a `{ … }` group.
const SHELL_GROUPING = new Set(['!', '{', '}', '(', ')', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'select', 'in', 'case', 'esac', 'function', 'time', 'coproc']);

// Whether a segment starts with such a word, or opens or closes a group or a `case` arm glued to a word, as in
// `(grep`, `f)`, or `a)`: a rewrite of it would unbalance the line.
export function startsOrEndsGroup(segment) {
  const words = segment.filter((token) => !token.operator && !token.fdDup);
  const [first] = words;
  if (!first) return false;
  if (SHELL_GROUPING.has(first.text) || /^[({]/u.test(first.text)) return true;
  return words.some((token) => /[)}]$/u.test(token.text));
}

// Whether a segment redirects a named descriptor, `{x}>file`. The lexer reads `{x}` after quotes are gone, so a quoted
// `'{x}'`, an argument to bash, reads as one too: a rule that cannot tell them apart fails closed on both.
export const hasNamedFd = (segment) => segment.some((token) => token.operator && token.fd !== undefined && !/^\d+$/u.test(token.fd));

// The deny reason for `command`, or null.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  const found = firstChain(command);
  return found ? reason(command, found) : null;
}

// The first command line of `command` that chains a count, with where the count sits in `command`: { from, to,
// wrappable }. A substitution's body is placed by its text, so a body that occurs twice is not wrappable.
function firstChain(command) {
  for (const line of commandLines(command)) {
    const chain = chainedCount(line);
    if (!chain) continue;
    const at = line === command ? 0 : command.indexOf(line);
    const placed = line === command || (at !== -1 && command.lastIndexOf(line) === at);
    return { from: Math.max(0, at) + chain.span[0], to: Math.max(0, at) + chain.span[1], wrappable: placed && chain.wrappable };
  }
  return null;
}

// Where one command line chains a counting grep's status into `&&`: { span, wrappable }, with `span` the [start, end)
// of the grep, or of its pipeline under pipefail, in `command`; null when it does not.
function chainedCount(command) {
  const { segments, separators, spans } = lexPipeline(command);
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
    // A named descriptor may be a quoted word the lexer took for one (`'{x}'>f`), so its grep counts until shown not to.
    if (!GREP_PROGRAMS.has(program) || !(asksForCount(args) || hasNamedFd(segments[i]))) continue;
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
    if (gatesWhatFollows || isGatedLastLink) {
      return { span: [spans[first][0], spans[last][1]], wrappable: !segments.slice(first, last + 1).some(startsOrEndsGroup) };
    }
  }
  return null;
}

// Whether grep's arguments ask for a count: `-c`, a bundle such as `-rc`, or `--count` and its prefixes.
export const asksForCount = (args) => asksFor(args, '-c', countsLong);

// Whether they ask for silence: `-q`, a bundle such as `-qE`, `--quiet`, or `--silent`, and their prefixes.
const quietLong = (text) => isLongOption(text, '--quiet', '--q') || isLongOption(text, '--silent', '--si');
export const asksForQuiet = (args) => asksFor(args, '-q', quietLong);

function asksFor(args, short, isLong) {
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) continue;
    if (text === '--') return false;
    if (isLong(text)) return true;
    if (text.startsWith('--')) {
      if (!text.includes('=') && VALUE_FLAGS.has(text)) i += 1;
      continue;
    }
    if (!text.startsWith('-') || text === '-') continue;
    const { options, value } = readShortOptions(text, VALUE_FLAGS);
    if (options.includes(short)) return true;
    if (value?.attached === null) i += 1;
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

// `command` with every chained count wrapped as `{ … || true; }`, and where the first one landed: { text, from, to };
// null when one of them cannot be wrapped.
const WRAP_LIMIT = 20;
function rewritten(command) {
  let text = command;
  let first = null;
  for (let n = 0; n < WRAP_LIMIT; n += 1) {
    const found = firstChain(text);
    if (!found) return { text, ...first };
    if (!found.wrappable) return null;
    const wrapped = `{ ${text.slice(found.from, found.to)} || true; }`;
    text = `${text.slice(0, found.from)}${wrapped}${text.slice(found.to)}`;
    first ??= { from: found.from, to: found.from + wrapped.length };
  }
  return null;
}

function reason(command, found) {
  const fix = rewritten(command);
  if (!fix) return manualReason(command);
  return [
    'Blocked: a counting grep is chained with `&&`, so a clean result reads as a failed check. Run this instead:',
    '',
    `  ${excerpt(fix.text, fix.from, fix.to)}`,
    '',
    'in place of:',
    '',
    `  ${excerpt(command, found.from, found.to)}`,
    '',
    '`grep -c` exits 1 when it counts zero matches, so the `&&` after it skips the rest and the line reports failure',
    'for the result you wanted. The braces keep the count and the chain, and drop only that status.',
    'If no match should stop the chain, gate on presence with `grep -q` there, which exits 0 on a match.',
    '',
    `Human-only override for the whole session, set before it starts: ${OVERRIDE}=1`,
  ].join('\n');
}

function manualReason(command) {
  const shown = command.length > 300 ? `${command.slice(0, 297)}...` : command;
  return [
    'Blocked: a counting grep is chained with `&&`, so a clean result reads as a failed check.',
    '',
    `  ${shown}`,
    '',
    '`grep -c` exits 1 when it counts zero matches. In an `&&` chain the commands after it never run,',
    'and the whole line reports failure for the result you wanted. Pick one:',
    '  - wrap the count so only its status is dropped: `{ grep -c … || true; }`;',
    '  - run the counting grep on its own line, and read the number;',
    '  - to gate on presence rather than a count, use `grep -q`, which exits 0 on a match.',
    '',
    `Human-only override for the whole session, set before it starts: ${OVERRIDE}=1`,
  ].join('\n');
}
