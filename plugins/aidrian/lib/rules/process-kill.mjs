// Bash rule, two parts.
//
// Kill by name: no `pkill`, `killall`, `pgrep --signal`, or `kill` fed by a process listing (`kill $(pgrep -f x)`,
// `pgrep -f x | xargs kill`). Sessions on one machine run the same tools, so a name matches other sessions' builds and
// git hooks too. Stopping what you own stays allowed: `kill <pid>`, `kill -- -<pgid>`, `pkill -P <ppid>` (never ppid 1),
// and the signal-0 probe `kill -0`. `kill -- -1`, every process the user owns, is denied.
//
// Command-line listings: no `pgrep -fl`, `pgrep -a`, or `ps` without an explicit format free of argument columns.
// On macOS a process that sets its own title shows its environment as arguments, so secrets would reach the transcript.
//
// Both look through wrappers, `case` arms, subshells, `sh -c`, `eval`, `env -S`, xargs, and the substitutions that run.
// A lexer cannot see into a script or an interpreter (`python -c`), so this guards against accidents, not intent.

import { isLongOption, lexCommand, lexSubstitutions } from '../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME';
export const LISTING_OVERRIDE = 'AIDRIAN_ALLOW_PROCESS_ARGS_LISTING';

const REASON =
  'Blocked: stopping processes by name (`pkill`, `killall`, `kill $(pgrep …)`, `… | xargs kill`) also stops ' +
  "other sessions' builds and git hooks that run the same programs. " +
  'Stop only what you own: `kill <pid>` for a pid your session started or recorded, or `kill -- -<pgid>` for a ' +
  `process group you created. To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell ` +
  "before starting the session (agents must never set it on the user's behalf).";

const LISTING_REASON =
  'Blocked: this process listing prints full command lines. On macOS a process that sets its own title shows its ' +
  'inherited environment as arguments, so secrets would land in the transcript. List pids and names only: ' +
  '`ps -o pid=,ppid=,pcpu=,rss=,etime=,comm=` (add `-p <pid>` or `-e`), `pgrep <pattern>`, `pgrep -f <pattern>` ' +
  `(pids only), or \`pgrep -l <pattern>\` without \`-f\`. To override for an explicit, user-confirmed reason, set ` +
  `${LISTING_OVERRIDE}=1 in your own shell before starting the session (agents must never set it on the user's behalf).`;

// The deny reason for `command`, or null: the kill rule first, then the listing rule. Each override opens its own rule.
export function check(command, { env = process.env } = {}) {
  if (env[OVERRIDE] !== '1' && killsByName(command)) return REASON;
  if (env[LISTING_OVERRIDE] !== '1' && printsProcessArguments(command)) return LISTING_REASON;
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

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

// The command line a `sh -c "<string>"` runs: the first operand after `-c` and any shell options, or null.
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O']);
function inlineShellCommand({ program, args }) {
  if (!SHELLS.has(program)) return null;
  const at = args.findIndex((token) => !token.dynamic && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(token.text));
  if (at === -1) return null;
  let i = at + 1;
  while (args[i] && !args[i].dynamic) {
    const { text } = args[i];
    if (text === '--') {
      i += 1;
      break;
    }
    if (SHELL_VALUE_OPTIONS.has(text)) i += 2;
    else if (/^[-+]\S/u.test(text)) i += 1;
    else break;
  }
  return args[i]?.text ?? null;
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
function killsByName(command, depth = 0, outerListsByName = false) {
  if (depth > MAX_DEPTH) return false;
  const listsByName = outerListsByName || listsProcessesByName(command, depth);
  return lexCommand(command).some((segment) => invocationDenied(readCommand(segment), listsByName, depth));
}

function invocationPrintsArguments(invocation, depth) {
  if (depth > MAX_DEPTH) return false;
  const { program, args, nested } = unwrapPrefixes(invocation);
  if (nested.some((text) => printsProcessArguments(text, depth + 1))) return true;
  const inline = inlineShellCommand({ program, args });
  if (inline !== null && printsProcessArguments(inline, depth + 1)) return true;
  if (program === 'eval' && args.length > 0 && printsProcessArguments(joined(args), depth + 1)) return true;
  if (program === 'xargs') {
    const child = xargsInvocation(args);
    return child ? invocationPrintsArguments(child, depth + 1) : false;
  }
  if (program === 'pgrep') return pgrepPrintsArguments(args);
  if (program === 'ps') return psPrintsArguments(args);
  return false;
}

// The listing rule.
function printsProcessArguments(command, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (lexCommand(command).some((segment) => invocationPrintsArguments(readCommand(segment), depth))) return true;
  return lexSubstitutions(command).some((body) => printsProcessArguments(body, depth + 1));
}

const joined = (args) => args.map((token) => token.text).join(' ');
