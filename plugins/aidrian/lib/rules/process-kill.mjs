// Bash rule, two parts.
//
// Kill by name: no `pkill`, `killall`, `pgrep --signal`, or `kill` fed by a process listing (`kill $(pgrep -f x)`,
// `pgrep -f x | xargs kill`). Sessions on one machine run the same tools, so a name matches other sessions' builds and
// git hooks too. Stopping what you own stays allowed: `kill <pid>`, `kill -- -<pgid>`, `pkill -P <ppid>` (never ppid 1),
// and the signal-0 probe `kill -0`. `kill -- -1`, every process the user owns, is denied.
//
// Command-line listings: no `pgrep -fl`, `pgrep -a`, or `ps` without an explicit format free of argument columns.
// On macOS a process that sets its own title shows its environment as arguments, so secrets would reach the transcript.
// A listing whose output reaches only `/dev/null` or a counter (`wc`, `grep -c`, `grep -q`) prints none of it, so it runs.
//
// Each deny names the command to run instead, built from the one it saw: `pgrep -fl x` and `ps aux | grep x` become
// `pgrep -d, -f x | xargs -r ps -o pid=,…,comm= -p`, a `ps` format trades its argument columns for `comm`, and a
// `pkill` or `killall` the `pgrep` that lists what it would stop.
//
// Both look through wrappers, `case` arms, subshells, `sh -c`, `eval`, `env -S`, xargs, and the substitutions that run.
// A lexer cannot see into a script or an interpreter (`python -c`), so this guards against accidents, not intent.

import {
  excerpt, inlineShellCommand, isLongOption, lexCommand, lexPipeline, lexSubstitutions, readInvocation, shellRedirections, shellWord,
} from '../shell-lex.mjs';
import { asksForCount, asksForQuiet, GREP_PROGRAMS } from './grep-exit-chain.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME';
export const LISTING_OVERRIDE = 'AIDRIAN_ALLOW_PROCESS_ARGS_LISTING';

const REASON =
  'Blocked: stopping processes by name (`pkill`, `killall`, `kill $(pgrep …)`, `… | xargs kill`) also stops ' +
  "other sessions' builds and git hooks that run the same programs.\n" +
  'Stop only what you own: `kill <pid>` for a pid your session started or recorded, or `kill -- -<pgid>` for a ' +
  `process group you created. To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell ` +
  "before starting the session (agents must never set it on the user's behalf).";

const LISTING_LEAD = 'Blocked: this process listing prints full command lines.';
const LISTING_REASON =
  'On macOS a process that sets its own title shows its ' +
  'inherited environment as arguments, so secrets would land in the transcript. List pids and names only: ' +
  '`ps -o pid=,ppid=,pcpu=,rss=,etime=,comm=` (add `-p <pid>` or `-e`), `pgrep <pattern>`, `pgrep -f <pattern>` ' +
  `(pids only), or \`pgrep -l <pattern>\` without \`-f\`; a count (\`| wc -l\`, \`| grep -c\`) or \`>/dev/null\` runs as it is. ` +
  `To override for an explicit, user-confirmed reason, set ` +
  `${LISTING_OVERRIDE}=1 in your own shell before starting the session (agents must never set it on the user's behalf).`;

// The deny reason for `command`, or null: the kill rule first, then the listing rule. Each override opens its own rule.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] !== '1' && killsByName(command)) return killReason(command);
  if (env[LISTING_OVERRIDE] !== '1') {
    const found = findListing(command);
    if (found) return listingReason(command, found);
  }
  return null;
}

const BY_NAME_PROGRAMS = new Set(['pkill', 'killall']);
const LISTING_PROGRAMS = new Set(['pgrep', 'ps', 'pidof']);
const MAX_DEPTH = 6;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

// `ps -p <pid>` inspects a pid the caller holds: allowed beside a kill when every other token is a format or layout
// option. Anything that selects more (`-A`, `-e`, `aux`, `-C`) keeps it a listing by name.
const PS_PID_SELECTOR = /^(?:-[pq]|--pid|--quick-pid)(?:=.*|\d[\d,]*)?$/u;
const PS_VALUE_OPTIONS = new Set(['-o', '-O', '--format', '--cols', '--columns', '--width', '--lines', '--rows']);
const PS_LAYOUT_OPTION = /^(?:-[oO]\S+|--format=.*|--(?:cols|columns|width|lines|rows)=.*|--no-head(?:ers|ing)?|--headers|-[hHwfFljyc]+)$/u;
function psSelectsOwnPid(args) {
  let selectsPid = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) continue;
    if (PS_PID_SELECTOR.test(token.text)) {
      selectsPid = true;
      if (['-p', '-q', '--pid', '--quick-pid'].includes(token.text)) i += 1;
      continue;
    }
    if (PS_VALUE_OPTIONS.has(token.text)) {
      i += 1;
      continue;
    }
    if (!PS_LAYOUT_OPTION.test(token.text)) return false;
  }
  return selectsPid;
}

// procps `pgrep --signal <sig>`, or `--si…`, signals every match: pkill by another name.
const pgrepSignals = (args) => args.some((token) => !token.dynamic && isLongOption(token.text, '--signal', '--si'));

// `kill -0`, `-s 0`, `-n 0` send nothing; they test that a pid is alive. A later `-s…`, `-n…`, or `--s…` replaces the 0.
const LATER_SIGNAL_OPTION = /^(?:-[sn]|--s)/u;
function probesOnly(args) {
  const [first, second] = args;
  if (!first || first.dynamic) return false;
  const isProbe = first.text === '-0' || (['-s', '-n'].includes(first.text) && second !== undefined && !second.dynamic && second.text === '0');
  return isProbe && !args.slice(1).some((token) => LATER_SIGNAL_OPTION.test(token.text));
}

// `ps` prints the command line unless an explicit format leaves the argument columns out, and every other token is a
// known selector or layout option. `-f`, `-F`, `-l`, `-j`, `-v`, `-O`, `-E`, and BSD clusters such as `aux` print it.
const PS_ARGUMENT_KEYS = new Set(['args', 'command', 'cmd']);
const PS_SAFE_FLAG_LETTERS = new Set(['A', 'a', 'c', 'd', 'e', 'h', 'm', 'r', 'w', 'X', 'x']);
const PS_SAFE_VALUE_LETTERS = new Set(['p', 'q', 't', 'U']);
const PS_SAFE_LONG_FLAGS = new Set(['--no-headers', '--no-heading', '--headers']);
const PS_SAFE_LONG_VALUE_OPTIONS = new Set(['--pid', '--quick-pid', '--ppid', '--sort', '--cols', '--columns', '--width', '--lines', '--rows']);
// Format keys split on commas and spaces, without `=header` and `:width`. A `%` key is an AIX descriptor (`%a` is args),
// except the `%cpu` and `%mem` aliases.
const PS_PERCENT_KEYWORDS = new Set(['%cpu', '%mem']);
function psFormatIsSafe(token) {
  return token != null && !token.dynamic && token.text.split(/[,\s]+/u).every((key) => {
    const name = key.split('=')[0].split(':')[0];
    return !PS_ARGUMENT_KEYS.has(name) && (!name.includes('%') || PS_PERCENT_KEYWORDS.has(name));
  });
}
function psPrintsArguments(args) {
  let formats = 0;
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) return true;
    if (text === '--format' || text.startsWith('--format=')) {
      const value = text === '--format' ? args[(i += 1)] : { text: text.slice('--format='.length), dynamic: false };
      if (!psFormatIsSafe(value)) return true;
      formats += 1;
      continue;
    }
    if (PS_SAFE_LONG_FLAGS.has(text)) continue;
    const long = /^(--[a-z-]+)(=.*)?$/u.exec(text);
    if (long && PS_SAFE_LONG_VALUE_OPTIONS.has(long[1])) {
      if (long[2] === undefined) i += 1;
      continue;
    }
    if (!/^-[A-Za-z]/u.test(text)) return true;
    for (let j = 1; j < text.length; j += 1) {
      const letter = text[j];
      if (PS_SAFE_FLAG_LETTERS.has(letter)) continue;
      if (letter !== 'o' && !PS_SAFE_VALUE_LETTERS.has(letter)) return true;
      const attached = text.slice(j + 1);
      const value = attached === '' ? args[(i += 1)] : { text: attached, dynamic: false };
      if (letter === 'o') {
        if (!psFormatIsSafe(value)) return true;
        formats += 1;
      }
      break;
    }
  }
  return formats === 0;
}

// `pgrep -l` adds the name, which `-f` makes the full argument list; `-a`/`--list-full` prints it outright. A value
// option takes the rest of its cluster or the next token. Long options match by their unambiguous prefixes.
const PGREP_VALUE_LETTERS = new Set(['F', 'G', 'P', 'U', 'd', 'g', 's', 't', 'u']);
function pgrepPrintsArguments(args) {
  let full = false;
  let names = false;
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) continue;
    if (text === '--') break;
    if (text.startsWith('--')) {
      const name = text.slice(2).split('=')[0];
      if (name.length >= 6 && 'list-full'.startsWith(name)) return true;
      if (name.length >= 6 && 'list-name'.startsWith(name)) names = true;
      else if (name.length >= 1 && 'full'.startsWith(name)) full = true;
      continue;
    }
    if (!text.startsWith('-')) continue;
    for (let j = 1; j < text.length; j += 1) {
      const letter = text[j];
      if (PGREP_VALUE_LETTERS.has(letter)) {
        if (j === text.length - 1) i += 1;
        break;
      }
      if (letter === 'a') return true;
      if (letter === 'f') full = true;
      if (letter === 'l') names = true;
    }
  }
  return full && names;
}

// Prefixes that run a later word as the command, with the options that take the next token as their value.
// An option whose value is optional (`env --default-signal[=SIG]`) is absent: bare, the next token is the command.
const PREFIX_VALUE_OPTIONS = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-R', '--chroot', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
};
const ASSIGNMENT_PREFIXES = new Set(['env', 'sudo']);
const ENV_SPLIT_STRING = new Set(['-S', '--split-string']);
// Shell words before a command (`! pkill`, `{ pkill; }`, `then pkill`); a subshell's `(` arrives glued on.
const SHELL_CONTROL_WORDS = new Set(['!', '{', '(', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'coproc']);
// A later `case` arm arrives as a program `b|c)`.
const CASE_ARM_LABEL = /^[^()]*\)$/u;
// `command -v` and `-V` only describe a program.
const COMMAND_LOOKUP = /^-[pvV]*[vV][pvV]*$/u;
function commandLooksUp(args) {
  for (const token of args) {
    if (token.dynamic || !token.text.startsWith('-') || token.text === '--') return false;
    if (COMMAND_LOOKUP.test(token.text)) return true;
  }
  return false;
}

// Program and operands of a segment, with `sudo` left in place for unwrapPrefixes to read with its own grammar.
function readCommand(segment) {
  const targets = new Set();
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i].operator && segment[i + 1] && !segment[i + 1].fdDup) targets.add(segment[i + 1]);
  }
  const words = segment.filter((token) => !token.operator && !token.fdDup && !targets.has(token));
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index].text)) index += 1;
  return { program: (words[index]?.text ?? '').split('/').pop() ?? '', args: words.slice(index + 1) };
}

// Index of the first token after a prefix's own options; a command string an `env -S` carries goes to `nested`.
function afterPrefixOptions(prefix, args, nested) {
  const valueOptions = PREFIX_VALUE_OPTIONS[prefix];
  let i = 0;
  while (args[i]) {
    const token = args[i];
    if (token.dynamic) break;
    if (token.text === '--') return i + 1;
    // The env -S string is more env argv, options included, so it is judged as `env <string>`.
    if (prefix === 'env' && ENV_SPLIT_STRING.has(token.text)) {
      if (args[i + 1] && !args[i + 1].dynamic) nested.push(`env ${args[i + 1].text}`);
      i += 2;
      continue;
    }
    if (prefix === 'env' && token.text.startsWith('--split-string=')) {
      nested.push(`env ${token.text.slice('--split-string='.length)}`);
      i += 1;
      continue;
    }
    if (prefix === 'env' && token.text.startsWith('-S') && token.text.length > 2) {
      nested.push(`env ${token.text.slice(2)}`);
      i += 1;
      continue;
    }
    if (valueOptions.has(token.text)) {
      i += 2;
      continue;
    }
    if (token.text.startsWith('-') || (ASSIGNMENT_PREFIXES.has(prefix) && ASSIGNMENT.test(token.text))) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

// Peels every prefix: { program, args, nested }, where `nested` holds command strings to judge on their own.
function unwrapPrefixes({ program, args }) {
  const nested = [];
  if (/^[({]+./u.test(program)) {
    program = program.replace(/^[({]+/u, '');
    args = args.map((token) => (token.dynamic ? token : { ...token, text: token.text.replace(/[)}]+$/u, '') }));
  }
  for (;;) {
    let start = 0;
    if (SHELL_CONTROL_WORDS.has(program)) {
      if (program === 'time') {
        while (args[start] && !args[start].dynamic && (args[start].text === '-p' || args[start].text === '--')) start += 1;
      }
    } else if (program === 'case') {
      const label = args.findIndex((token) => token.text.endsWith(')'));
      if (label === -1) return { program: '', args: [], nested };
      start = label + 1;
    } else if (CASE_ARM_LABEL.test(program)) {
      // a later arm: the next word is the program
    } else if (program === 'command' && commandLooksUp(args)) {
      return { program: '', args: [], nested };
    } else if (program === 'rtk') {
      if (args[0]?.text === 'proxy') start = 1;
    } else if (program in PREFIX_VALUE_OPTIONS) {
      start = afterPrefixOptions(program, args, nested);
      if (program === 'timeout') start += 1;
    } else {
      return { program, args, nested };
    }
    const real = args[start];
    if (!real || real.dynamic) return { program: '', args: [], nested };
    program = real.text.split('/').pop() ?? '';
    args = args.slice(start + 1);
  }
}

// The invocation `xargs` runs, or null. Options whose value is optional are absent: bare, the next token is the command.
const XARGS_VALUE_FLAGS = new Set(['-n', '--max-args', '-I', '-P', '--max-procs', '-L', '-d', '--delimiter', '-s', '--max-chars', '-E', '-a', '--arg-file', '-J', '-R', '-S', '--process-slot-var']);
function xargsInvocation(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) return null;
    if (XARGS_VALUE_FLAGS.has(token.text)) {
      i += 1;
      continue;
    }
    if (token.text.startsWith('-')) continue;
    return { program: token.text.split('/').pop() ?? '', args: args.slice(i + 1) };
  }
  return null;
}

// `pkill -P <ppid>` is scoped to one parent's children, unless a parent is pid 0 or 1, which every orphan has. A
// dynamic parent counts only as the shell's own pid. pkill unions its `-P` selectors, so each must be a scope.
const OWN_PID_TOKENS = new Set(['$$', '"$$"', '${$}', '$BASHPID', '${BASHPID}', '"$BASHPID"', '"${BASHPID}"']);
function parentScoped(args) {
  let scoped = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) continue;
    let value = null;
    if (token.text === '-P' || token.text === '--parent') value = args[i + 1] ?? null;
    else if (/^-P\d+$/u.test(token.text)) value = { text: token.text.slice(2), dynamic: false };
    else if (token.text.startsWith('--parent=')) value = { text: token.text.slice('--parent='.length), dynamic: false };
    if (value === null) continue;
    const isScope = value.dynamic
      ? OWN_PID_TOKENS.has(value.text)
      : value.text.split(',').every((ppid) => /^\+?\d+$/u.test(ppid) && Number(ppid) >= 2);
    if (!isScope) return false;
    scoped = true;
  }
  return scoped;
}

// pgid -1 is every process the user owns. In the first position `-1` is the signal SIGHUP.
const broadcastsToAll = (args) => args.some((token, index) => index > 0 && !token.dynamic && /^-\d+$/u.test(token.text) && Number(token.text) === -1);

// Whether `command` runs a process listing anywhere: a segment, a nested command string, or a substitution that runs.
function listsProcessesByName(command, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  for (const segment of lexCommand(command)) {
    const { program, args, nested } = unwrapPrefixes(readCommand(segment));
    if (LISTING_PROGRAMS.has(program) && !(program === 'ps' && psSelectsOwnPid(args))) return true;
    if (nested.some((text) => listsProcessesByName(text, depth + 1))) return true;
    const inline = inlineShellCommand({ program, args });
    if (inline !== null && listsProcessesByName(inline, depth + 1)) return true;
    if (program === 'eval' && args.length > 0 && listsProcessesByName(joined(args), depth + 1)) return true;
  }
  return lexSubstitutions(command).some((body) => listsProcessesByName(body, depth + 1));
}

// Whether one invocation kills by name. A nested command line inherits `listsByName` from the line that carries it:
// `pgrep -f x | xargs sh -c 'kill $0'` lists in the outer line and kills in the inner one.
function invocationDenied(invocation, listsByName, depth) {
  if (depth > MAX_DEPTH) return false;
  const { program, args, nested } = unwrapPrefixes(invocation);
  if (nested.some((text) => killsByName(text, depth + 1, listsByName))) return true;
  const inline = inlineShellCommand({ program, args });
  if (inline !== null && killsByName(inline, depth + 1, listsByName)) return true;
  if (program === 'eval' && args.length > 0 && killsByName(joined(args), depth + 1, listsByName)) return true;
  if (program === 'xargs') {
    const child = xargsInvocation(args);
    const target = child ? unwrapPrefixes(child) : null;
    if (target && listsByName && target.program === 'kill' && !probesOnly(target.args)) return true;
    return child ? invocationDenied(child, listsByName, depth + 1) : false;
  }
  if (BY_NAME_PROGRAMS.has(program)) return !(program === 'pkill' && parentScoped(args));
  if (program === 'pgrep' && pgrepSignals(args)) return !parentScoped(args);
  if (program !== 'kill' || probesOnly(args)) return false;
  return broadcastsToAll(args) || (listsByName && args.some((token) => token.dynamic));
}

// The kill rule. "Lists by name" is judged over the whole line: `PIDS=$(pgrep -f x); kill $PIDS` spreads the sweep.
// A substitution that runs is judged too, inheriting it: `r=$(pkill -f x)` kills as `pkill -f x` does.
function killsByName(command, depth = 0, outerListsByName = false) {
  if (depth > MAX_DEPTH) return false;
  const listsByName = outerListsByName || listsProcessesByName(command, depth);
  if (lexCommand(command).some((segment) => invocationDenied(readCommand(segment), listsByName, depth))) return true;
  return lexSubstitutions(command).some((body) => killsByName(body, depth + 1, listsByName));
}

// The listing rule. A finding is { line, segments, separators, spans, index, exact }: the command line, its lexed
// pipeline, and the segment that lists; `exact` when `line` is the command itself or a substitution in it, so a
// replacement can be written back into the command. Through `sh -c`, `eval`, `env -S`, or xargs it is not.
function findListing(command, depth = 0, exact = true) {
  if (depth > MAX_DEPTH) return null;
  const { segments, separators, spans } = lexPipeline(command);
  for (let i = 0; i < segments.length; i += 1) {
    if (outputDiscarded(segments, separators, i)) continue;
    const found = invocationListing(readCommand(segments[i]), depth);
    if (found === 'direct' || found === 'indirect') {
      return { line: command, segments, separators, spans, index: i, exact: exact && found === 'direct' };
    }
    if (found) return found;
  }
  for (const body of lexSubstitutions(command)) {
    const found = findListing(body, depth + 1, exact);
    if (found) return found;
  }
  return null;
}

// 'direct' when this invocation is a listing that prints arguments, 'indirect' when xargs runs one, a finding from a
// command string it runs, or null.
function invocationListing(invocation, depth) {
  if (depth > MAX_DEPTH) return null;
  const { program, args, nested } = unwrapPrefixes(invocation);
  for (const text of nested) {
    const found = findListing(text, depth + 1, false);
    if (found) return found;
  }
  const inline = inlineShellCommand({ program, args });
  const inner = inline === null ? null : findListing(inline, depth + 1, false);
  if (inner) return inner;
  if (program === 'eval' && args.length > 0) {
    const found = findListing(joined(args), depth + 1, false);
    if (found) return found;
  }
  if (program === 'xargs') {
    const child = xargsInvocation(args);
    return child && invocationListing(child, depth + 1) ? 'indirect' : null;
  }
  if (program === 'pgrep') return pgrepPrintsArguments(args) ? 'direct' : null;
  if (program === 'ps') return psPrintsArguments(args) ? 'direct' : null;
  return null;
}

// Where a segment's standard output goes: 'null' for /dev/null, 'elsewhere' for a file or another descriptor, or
// 'inherited' when no redirection moves it. The last redirection of fd 1 wins; `&>` moves it too.
function stdoutTarget(segment) {
  let target = 'inherited';
  for (let i = 0; i < segment.length; i += 1) {
    const token = segment[i];
    if (!token.operator || token.operator === '<') continue;
    if (token.text !== '&>' && token.text !== '&>>' && token.fd !== undefined && token.fd !== '1') continue;
    const next = segment[i + 1];
    if (!next) continue;
    target = !next.fdDup && !next.dynamic && next.text === '/dev/null' ? 'null' : 'elsewhere';
  }
  return target;
}

// Programs that pass on only what they read, so a listing piped through them ends where they end.
const PASS_THROUGH = new Set([...GREP_PROGRAMS, 'head', 'tail', 'sort', 'uniq', 'cut', 'tr']);
const PIPES = new Set(['|', '|&']);

// Whether segment `i`'s output can reach no transcript: it goes to /dev/null, or down a pipe through pass-through
// programs into a counter that prints only a number (`wc`, `grep -c`) or nothing (`grep -q`).
function outputDiscarded(segments, separators, i) {
  for (let j = i; j < segments.length; j += 1) {
    if (j > i) {
      const { program, args } = readInvocation(segments[j]);
      if (program === 'wc') return true;
      if (GREP_PROGRAMS.has(program) && (asksForCount(args) || asksForQuiet(args))) return true;
      if (!PASS_THROUGH.has(program)) return false;
    }
    const target = stdoutTarget(segments[j]);
    if (target !== 'inherited') return target === 'null';
    if (!PIPES.has(separators[j])) return false;
  }
  return false;
}

// What a replacement prints for each process, by the form it replaces. `=` keeps a header off, as grep would.
const PGREP_FIELDS = 'pid=,ppid=,etime=,comm=';
const PS_DEFAULT_FIELDS = 'pid,ppid,pcpu,rss,etime,comm';
const pidsThrough = (fields) => `xargs -r ps -o ${fields} -p`;

// The words of `tokens`, or null when one cannot be written back.
function words(tokens) {
  const out = tokens.map(shellWord);
  return out.includes(null) ? null : out;
}

// `pgrep` without the options that print the command line: `-l`, `-a`, `--list-full`, and `--list-name`.
function pgrepWithoutListing(args) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const { text, dynamic } = token;
    if (dynamic || text === '--' || !text.startsWith('-')) {
      kept.push(token);
      continue;
    }
    if (text.startsWith('--')) {
      const name = text.slice(2).split('=')[0];
      if (name.length < 6 || !('list-full'.startsWith(name) || 'list-name'.startsWith(name))) kept.push(token);
      continue;
    }
    let letters = '';
    let takesNext = false;
    for (let j = 1; j < text.length; j += 1) {
      if (PGREP_VALUE_LETTERS.has(text[j])) {
        letters += text.slice(j);
        takesNext = j === text.length - 1;
        break;
      }
      if (text[j] !== 'l' && text[j] !== 'a') letters += text[j];
    }
    if (letters) kept.push({ text: `-${letters}`, dynamic: false });
    if (takesNext && args[i + 1]) {
      kept.push(args[i + 1]);
      i += 1;
    }
  }
  return kept;
}

// The replacement for a `pgrep` that prints command lines. Before `&&` or `||` it lists pids only, so its exit status,
// 1 when nothing matches, stays the one the chain reads.
function pgrepReplacement(args, separator) {
  const kept = words(pgrepWithoutListing(args));
  if (!kept) return null;
  const pgrep = `pgrep ${kept.join(' ')}`.trimEnd();
  if (separator === '&&' || separator === '||' || args.some((token) => /^-[a-zA-Z]*d/u.test(token.text))) return pgrep;
  return `pgrep -d, ${kept.join(' ')} | ${pidsThrough(PGREP_FIELDS)}`;
}

// `ps` format keys without the argument columns: `args`, `command`, and `cmd` become `comm`, and an AIX descriptor its
// keyword (`%a` is args, so `comm`). `=header` and `:width` stay with their key.
const AIX_KEYS = { '%a': 'comm', '%c': 'comm', '%p': 'pid', '%P': 'ppid', '%C': 'pcpu', '%z': 'vsz', '%t': 'etime', '%u': 'user', '%U': 'ruser', '%g': 'group', '%G': 'rgroup', '%n': 'nice', '%x': 'time', '%y': 'tty', '%r': 'pgid' };
function safeFields(format) {
  const keys = [];
  for (const key of format.split(/[,\s]+/u).filter(Boolean)) {
    const name = key.split('=')[0].split(':')[0];
    let safe = key;
    if (PS_ARGUMENT_KEYS.has(name)) safe = `comm${key.slice(name.length)}`;
    else if (name.includes('%') && !PS_PERCENT_KEYWORDS.has(name)) safe = AIX_KEYS[name] ?? null;
    if (safe !== null && !keys.includes(safe)) keys.push(safe);
  }
  return keys.join(',');
}

// Selection letters kept from a cluster: all processes, without a terminal, and the sort orders. `-e` is everyone in
// procps and on macOS; a bare `e` (BSD) adds the environment, so it goes.
const PS_KEPT_LETTERS = new Set(['A', 'a', 'x', 'r', 'm']);
const PS_VALUE_SELECTORS = new Set(['p', 'q', 't', 'U', 'G', 'g']);
const PS_KEPT_LONG = new Set(['--pid', '--quick-pid', '--ppid', '--sort']);

// The `ps` that prints what `args` asks for, minus the command lines: { flags, selectors, fields }, or null when an
// argument cannot be read. `flags` are the kept letters, `selectors` the options that pick processes by a value, and
// `fields` the format, null when `args` named none.
function psParts(args) {
  let flags = '';
  const selectors = [];
  let fields = null;
  const addFields = (format) => {
    const safe = safeFields(format);
    fields = fields ? `${fields},${safe}` : safe;
  };
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) return null;
    if (text === '--format' || text.startsWith('--format=')) {
      const value = text === '--format' ? args[(i += 1)] : { text: text.slice('--format='.length), dynamic: false };
      if (!value || value.dynamic) return null;
      addFields(value.text);
      continue;
    }
    const long = /^(--[a-z-]+)(=.*)?$/u.exec(text);
    if (long) {
      if (!PS_KEPT_LONG.has(long[1])) continue;
      const value = long[2] === undefined ? args[(i += 1)] : null;
      if (value?.dynamic === true && shellWord(value) === null) return null;
      selectors.push(value ? `${long[1]} ${shellWord(value)}` : text);
      continue;
    }
    const dashed = text.startsWith('-');
    let letters = '';
    for (let j = dashed ? 1 : 0; j < text.length; j += 1) {
      const letter = text[j];
      if (letter === 'o' || letter === 'O' || PS_VALUE_SELECTORS.has(letter)) {
        const attached = text.slice(j + 1);
        const value = attached === '' ? args[(i += 1)] : { text: attached, dynamic: false };
        if (!value) return null;
        if (letter === 'o') {
          if (value.dynamic) return null;
          addFields(value.text);
        } else if (letter === 'O') {
          if (value.dynamic) return null;
          addFields(`pid,${value.text},comm`);
        } else {
          const word = shellWord(value);
          if (word === null) return null;
          selectors.push(`-${letter} ${word}`);
        }
        break;
      }
      if (PS_KEPT_LETTERS.has(letter) || (dashed && letter === 'e')) letters += letter;
    }
    for (const letter of letters) if (!flags.includes(letter)) flags += letter;
  }
  return { flags, selectors: [...new Set(selectors)], fields };
}

function psReplacement(args) {
  const parts = psParts(args);
  if (!parts) return null;
  return ['ps', ...(parts.flags ? [`-${parts.flags}`] : []), ...parts.selectors, '-o', parts.fields || PS_DEFAULT_FIELDS].join(' ');
}

// A grep's pattern as an extended regular expression for `pgrep -f`, with `-i` when it ignores case; null for a grep
// that inverts, matches fixed strings or whole words or lines, or has no readable pattern.
function grepAsPgrep({ program, args }) {
  if (!GREP_PROGRAMS.has(program)) return null;
  let extended = program === 'egrep' || program === 'rg' || program === 'ripgrep';
  let ignoreCase = false;
  const patterns = [];
  let operands = 0;
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) return null;
    if (text === '-e' || text === '--regexp') {
      const value = args[(i += 1)];
      if (!value || value.dynamic) return null;
      patterns.push(value.text);
      continue;
    }
    if (text.startsWith('--regexp=')) {
      patterns.push(text.slice('--regexp='.length));
      continue;
    }
    if (text === '--extended-regexp') extended = true;
    else if (text === '--ignore-case') ignoreCase = true;
    else if (text.startsWith('--')) return null;
    else if (/^-[A-Za-z]+$/u.test(text)) {
      for (const letter of text.slice(1)) {
        if (letter === 'E') extended = true;
        else if (letter === 'i') ignoreCase = true;
        else if (letter !== 'n' && letter !== 's') return null;
      }
    } else {
      operands += 1;
      if (patterns.length === 0 && operands === 1) patterns.push(text);
      else return null;
    }
  }
  if (patterns.length === 0) return null;
  const regex = patterns.map((pattern) => (extended ? pattern : basicToExtended(pattern))).join('|');
  return { pattern: regex, ignoreCase };
}

// A basic regular expression rewritten as an extended one: `\|`, `\(`, `\)`, `\+`, `\?`, `\{`, `\}` lose the backslash,
// and the same characters bare gain one.
function basicToExtended(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      out += '|()+?{}'.includes(next) ? next : `\\${next}`;
      i += 1;
    } else out += '|()+?{}'.includes(ch) ? `\\${ch}` : ch;
  }
  return out;
}

// `grep -v grep` and its kin, which only hide the grep itself from a `ps` listing: pgrep never lists itself.
function hidesGrep({ program, args }) {
  if (!GREP_PROGRAMS.has(program)) return false;
  const operands = args.filter((token) => !token.text.startsWith('-'));
  return args.some((token) => /^-[A-Za-z]*v[A-Za-z]*$/u.test(token.text)) && operands.length === 1 && /grep/u.test(operands[0].text);
}

// The replacement for the listing segment of `found`: { first, last, text }, the segments it replaces and what to run
// in their place, or null when none can be built.
function listingReplacement({ segments, separators, index }) {
  const { program, args } = unwrapPrefixes(readCommand(segments[index]));
  if (program === 'pgrep') {
    const text = pgrepReplacement(args, separators[index]);
    return text && { first: index, last: index, text };
  }
  // `ps … | grep <pattern>` is `pgrep -f <pattern>`, which matches the same command lines without printing them.
  if (PIPES.has(separators[index]) && segments[index + 1]) {
    const grep = grepAsPgrep(readInvocation(segments[index + 1]));
    const parts = grep && psParts(args);
    if (grep && parts && parts.selectors.length === 0) {
      let last = index + 1;
      while (PIPES.has(separators[last]) && segments[last + 1] && hidesGrep(readInvocation(segments[last + 1]))) last += 1;
      const pattern = shellWord({ text: grep.pattern, dynamic: false });
      const pgrep = `pgrep${grep.ignoreCase ? ' -i' : ''}`;
      const chained = separators[last] === '&&' || separators[last] === '||';
      const fields = (parts.fields || PS_DEFAULT_FIELDS).split(',').map((key) => (key.includes('=') ? key : `${key}=`)).join(',');
      const text = chained ? `${pgrep} -f ${pattern}` : `${pgrep} -d, -f ${pattern} | ${pidsThrough(fields)}`;
      return { first: index, last, text };
    }
  }
  const text = psReplacement(args);
  return text && { first: index, last: index, text };
}

// The text to run in place of segments [first, last] of `line`: the wrappers and assignments before the listing, the
// replacement, and the redirections of the last segment.
function replacementSegment(segments, { first, last, text }) {
  const segment = segments[first];
  const all = segment.filter((token, i) => !token.operator && !token.fdDup && !(i > 0 && segment[i - 1].operator));
  const { args } = unwrapPrefixes(readCommand(segment));
  const at = args.length > 0 ? all.indexOf(args[0]) - 1 : all.length - 1;
  const prefix = at > 0 ? words(all.slice(0, at)) : [];
  return [...(prefix ?? []), text, ...shellRedirections(segments[last])].join(' ');
}

// The replacement for `found` in `command`: { text, original, fixed, from }, where `fixed` is `command` with it in place
// when it can be written back (`exact`) and null otherwise; null when no replacement can be built.
function listingFix(command, found) {
  const replacement = listingReplacement(found);
  if (!replacement) return null;
  const { line, segments, spans, exact } = found;
  const text = replacementSegment(segments, replacement);
  const from = spans[replacement.first][0];
  const to = spans[replacement.last][1];
  const at = line === command ? 0 : command.indexOf(line);
  const fixed = exact && at !== -1 ? `${command.slice(0, at + from)}${text}${command.slice(at + to)}` : null;
  return { text, original: line.slice(from, to), fixed, from: at + from };
}

// The listing reason, the command to run instead first: the whole line with every listing replaced when each one can
// be, or else the one replacement for the listing it saw.
const FIX_LIMIT = 20;
function listingReason(command, found) {
  const first = listingFix(command, found);
  if (!first) return `${LISTING_LEAD} ${LISTING_REASON}`;
  let fixed = first.fixed;
  for (let n = 0; fixed !== null && n < FIX_LIMIT; n += 1) {
    const next = findListing(fixed);
    if (!next) break;
    fixed = listingFix(fixed, next)?.fixed ?? null;
  }
  if (fixed === null || findListing(fixed)) return `${LISTING_LEAD} Run \`${first.text}\` in place of \`${first.original}\`.\n\n${LISTING_REASON}`;
  return `${LISTING_LEAD} Run this instead:\n\n  ${excerpt(fixed, first.from, first.from + first.text.length)}\n\n${LISTING_REASON}`;
}

// Signals as pkill and killall take them: `-9`, `-KILL`, `-SIGTERM`. A one-letter capital is an option, such as `-P`.
const SIGNAL_OPTION = /^-(?:\d+|(?:SIG)?[A-Z]{2,}\d*)$/u;

// The pgrep that lists what a pkill would signal, or null.
function pkillAsPgrep(args) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (!dynamic && SIGNAL_OPTION.test(text)) continue;
    if (!dynamic && isLongOption(text, '--signal', '--si')) {
      if (!text.includes('=')) i += 1;
      continue;
    }
    kept.push(args[i]);
  }
  const written = words(pgrepWithoutListing(kept));
  return written && written.length > 0 ? `pgrep ${written.join(' ')}` : null;
}

// The pgrep that lists what a killall of plain names would signal, or null for any other killall.
function killallAsPgrep(args) {
  const names = [];
  for (const token of args) {
    if (token.dynamic) return null;
    if (SIGNAL_OPTION.test(token.text)) continue;
    if (token.text.startsWith('-')) return null;
    names.push(token.text);
  }
  if (names.length === 0) return null;
  return `pgrep -x ${shellWord({ text: names.join('|'), dynamic: false })}`;
}

// The kill reason, with the listing to read first when the command is a plain pkill or killall.
function killReason(command) {
  for (const segment of lexCommand(command)) {
    const { program, args } = unwrapPrefixes(readCommand(segment));
    const listing = program === 'pkill' ? pkillAsPgrep(args) : program === 'killall' ? killallAsPgrep(args) : null;
    if (listing) return REASON.replace('\n', `\nList the pids first with \`${listing}\`, then \`kill <pid>\` only those this session started.\n`);
  }
  return REASON;
}

const joined = (args) => args.map((token) => token.text).join(' ');
