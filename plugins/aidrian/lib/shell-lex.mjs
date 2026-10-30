// The one shell lexer behind the Bash rules. It reads a command line the way bash splits it, without running anything:
// quotes, escapes, comments, operators, redirections, heredocs, and command substitutions.
//
// A token is { text, dynamic, operator?, fdDup? }: `text` without its quotes; `dynamic` when it holds `$`, a backtick,
// or a glob, so a rule never guesses at its value; `operator` for a redirection (`>`, `>>`, `<`); `fdDup` for the
// `&1` of `2>&1`. Everything a rule cannot read is meant to fail open: an unknown shape yields no match, never a deny.

import path from 'node:path';

const CONTINUATION = '\n';
// Command substitutions nest no deeper than this in what commandLines returns; a deeper body goes unread.
export const SUBSTITUTION_DEPTH_LIMIT = 6;

const indexOrLimit = (index, limit) => (index === -1 || index >= limit ? limit : index);

// Index of the `)` closing the `(` at `open`, or `limit` when none does before it. A `)` does not count inside quotes,
// after a backslash, in a comment, or in a heredoc body, so the `a)` of a commit message in `$(cat <<'EOF' … EOF)` does
// not end the substitution early and leave the rest of the message to read as commands.
function closingParen(command, open, limit) {
  let depth = 0;
  const heredocs = [];
  for (let j = open; j < limit; j += 1) {
    const ch = command[j];
    if (ch === '\\') j += 1;
    else if (ch === "'" || ch === '`') j = indexOrLimit(command.indexOf(ch, j + 1), limit);
    else if (ch === '"') j = closingDoubleQuote(command, j, limit);
    else if (ch === '#' && /[\s;&|(]/u.test(command[j - 1])) j = indexOrLimit(command.indexOf('\n', j), limit) - 1;
    else if (ch === '\n' && heredocs.length > 0) j = heredocBodiesEnd(command, j, heredocs.splice(0), limit);
    else if (ch === '<' && command[j + 1] === '<' && command[j + 2] === '<') j += 2; // a here-string; its word lexes as usual
    else if (ch === '<' && command[j + 1] === '<') {
      // The delimiter is the next word, read as the lexer reads it; its body starts after the next newline.
      let k = j + 2;
      if (command[k] === '-') k += 1;
      while (command[k] === ' ' || command[k] === '\t') k += 1;
      let delimiter = '';
      for (; k < limit && !/[\s;|&<>()]/u.test(command[k]); k += 1) {
        if (command[k] !== "'" && command[k] !== '"' && command[k] !== '\\') delimiter += command[k];
      }
      if (delimiter) heredocs.push(delimiter);
      j = k - 1;
    } else if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return j;
  }
  return limit;
}

// Index of the `"` closing the one at `open`, or `limit`. A substitution inside it holds its own quotes.
function closingDoubleQuote(command, open, limit) {
  for (let k = open + 1; k < limit; k += 1) {
    const ch = command[k];
    if (ch === '\\') k += 1;
    else if (ch === '"') return k;
    else if (ch === '`') k = indexOrLimit(command.indexOf('`', k + 1), limit);
    else if (ch === '$' && command[k + 1] === '(') k = closingParen(command, k + 1, limit);
  }
  return limit;
}

// Index of the newline that ends the last delimiter line of the heredoc bodies starting after `newline`, or `limit`
// when one never ends. A delimiter followed by `)`, as in `EOF)`, ends its body there and leaves the `)` to be read.
function heredocBodiesEnd(command, newline, delimiters, limit) {
  let at = newline;
  for (const delimiter of delimiters) {
    for (;;) {
      if (at + 1 >= limit) return limit;
      const end = indexOrLimit(command.indexOf('\n', at + 1), limit);
      const line = command.slice(at + 1, end).trim();
      if (line.startsWith(`${delimiter})`)) return command.indexOf(`${delimiter})`, at + 1) + delimiter.length - 1;
      at = end;
      if (line === delimiter) break;
      if (end >= limit) return limit;
    }
  }
  return at;
}

// Pushes the body of every `$(…)` and `` `…` `` in command[from, to) onto `into`: text that expands but is not lexed,
// such as a double-quoted string or an unquoted heredoc body. A body may run past `to`, up to `limit`.
function collectSubstitutions(command, from, to, limit, into) {
  for (let k = from; k < to; k += 1) {
    if (command[k] === '\\') {
      k += 1;
    } else if (command[k] === '`') {
      const end = command.indexOf('`', k + 1);
      if (end === -1 || end >= limit) return;
      into.push(command.slice(k + 1, end));
      k = end;
    } else if (command[k] === '$' && command[k + 1] === '(') {
      const end = closingParen(command, k + 1, limit);
      into.push(command.slice(k + 2, end));
      k = end;
    }
  }
}

// Splits a command line into segments of tokens. `separators[i]` is the operator that ended `segments[i]` (`&&`, `||`,
// `|`, `|&`, `;`, `&`, or a newline), null for the last one. `substitutions` holds the body of every command
// substitution that would run: unquoted, in double quotes, `<(…)` and `>(…)`, and in a heredoc whose delimiter is
// unquoted. Single-quoted text, comments, and quoted heredoc bodies hold none. A heredoc body is data, never commands.
// `ends[i]` counts the substitutions found up to the end of `segments[i]`: those of segment i run as part of it.
function lexSegments(command) {
  const segments = [];
  const separators = [];
  const substitutions = [];
  const ends = [];
  // Each heredoc body as { segment, body }: the index of the segment whose `<<` opened it, and its text.
  const heredocs = [];
  let tokens = [];
  let current = null;
  const pendingHeredocs = [];

  const start = () => {
    if (!current) current = { text: '', dynamic: false };
    return current;
  };
  const endToken = () => {
    if (current) tokens.push(current);
    current = null;
  };
  const endSegment = (separator = null) => {
    endToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      separators.push(separator);
      ends.push(substitutions.length);
    } else if (separator !== null && separators.length > 0 && separator !== CONTINUATION) {
      // An empty run between two operators: the later one replaces the earlier. A newline never does: after `&&`,
      // `||`, or `|` it continues the line, and after `&` or `;` the segment already ended the way it ended.
      separators[separators.length - 1] = separator;
    }
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (ch === '\n' && pendingHeredocs.length > 0) {
      // Skip the body lines up to the delimiter line, then lex on.
      const { delimiter, expands, segment } = pendingHeredocs.shift();
      const rest = command.slice(i + 1);
      let consumed = 0;
      let body = 0;
      let closed = false;
      for (const line of rest.split('\n')) {
        consumed += line.length + 1;
        if (line.trim() === delimiter) {
          closed = true;
          break;
        }
        body = consumed;
      }
      const bodyEnd = Math.min(i + 1 + body, command.length);
      heredocs.push({ segment, body: command.slice(i + 1, bodyEnd) });
      if (expands) collectSubstitutions(command, i + 1, bodyEnd, bodyEnd, substitutions);
      i += closed ? consumed : rest.length;
      endSegment();
      continue;
    }

    // An unquoted `#` at the start of a word opens a comment to the end of the line; mid-word it is a character.
    if (ch === '#' && current === null) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // Nothing escapes inside single quotes; inside double quotes `\"` does not close the string.
      let j = i + 1;
      let body = '';
      while (j < command.length && command[j] !== ch) {
        if (ch === '"' && command[j] === '\\' && j + 1 < command.length) {
          body += command[j + 1];
          j += 2;
          continue;
        }
        body += command[j];
        j += 1;
      }
      const token = start();
      token.text += body;
      if (ch === '"' && /[$`]/u.test(body)) {
        token.dynamic = true;
        collectSubstitutions(command, i + 1, j, command.length, substitutions);
      }
      i = j >= command.length ? command.length : j;
      continue;
    }

    if ((ch === '$' && command[i + 1] === '(') || ch === '`') {
      // A substitution is opaque: its value is never a path or a word a rule may read.
      const token = start();
      token.dynamic = true;
      if (ch === '`') {
        const closing = command.indexOf('`', i + 1);
        if (closing !== -1) substitutions.push(command.slice(i + 1, closing));
        i = closing === -1 ? command.length : closing;
        continue;
      }
      const j = closingParen(command, i + 1, command.length);
      substitutions.push(command.slice(i + 2, j));
      token.text += '$';
      i = j >= command.length ? command.length : j;
      continue;
    }

    if (ch === '\\') {
      if (i + 1 < command.length) {
        if (command[i + 1] !== '\n') start().text += command[i + 1];
        i += 1;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      // `&>word` and `&>>word` redirect both streams; they do not end the segment.
      if (ch === '&' && command[i + 1] === '>') {
        const append = command[i + 2] === '>';
        endToken();
        tokens.push({ text: append ? '&>>' : '&>', dynamic: false, operator: append ? '>>' : '>' });
        i += append ? 2 : 1;
        continue;
      }
      let separator = ch;
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) {
        separator += ch;
        i += 1;
      } else if (ch === '|' && command[i + 1] === '&') {
        separator = '|&'; // bash's `2>&1 |`: one pipeline operator
        i += 1;
      }
      endSegment(separator);
      continue;
    }

    if (ch === '>' || ch === '<') {
      if (command[i + 1] === '(') substitutions.push(command.slice(i + 2, closingParen(command, i + 1, command.length)));
      // A bare fd prefix (`2>`) belongs to the operator, not to a filename.
      if (current && !/^\d+$/u.test(current.text)) endToken();
      else current = null;
      let operator = ch;
      if (command[i + 1] === ch) {
        operator += ch;
        i += 1;
      }
      if (operator === '<<' && command[i + 1] === '<') {
        // `<<<word`: a here-string, one input redirect whose word lexes as usual.
        i += 1;
        tokens.push({ text: '<<<', dynamic: false, operator: '<' });
        continue;
      }
      if (operator === '<<') {
        // A heredoc: the delimiter is the next word, and any quote in it stops the body from expanding.
        let j = i + 1;
        if (command[j] === '-') j += 1;
        while (j < command.length && (command[j] === ' ' || command[j] === '\t')) j += 1;
        let delimiter = '';
        let quoted = false;
        while (j < command.length && !/[\s;|&]/u.test(command[j])) {
          if (command[j] !== "'" && command[j] !== '"' && command[j] !== '\\') delimiter += command[j];
          else quoted = true;
          j += 1;
        }
        pendingHeredocs.push({ delimiter, expands: !quoted, segment: segments.length });
        i = j - 1;
        continue;
      }
      tokens.push({ text: operator, dynamic: false, operator: operator === '<' ? '<' : operator });
      if (command[i + 1] === '&') {
        // `2>&1`: a descriptor, never a path.
        let j = i + 1;
        while (j < command.length && !/[\s;|]/u.test(command[j])) j += 1;
        tokens.push({ text: command.slice(i + 1, j), dynamic: false, fdDup: true });
        i = j - 1;
      }
      continue;
    }

    const token = start();
    token.text += ch;
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?') token.dynamic = true;
  }

  endSegment();
  return { segments, separators, substitutions, ends, heredocs };
}

// The segments and the operator that ended each one.
export function lexPipeline(command) {
  const { segments, separators } = lexSegments(command);
  return { segments, separators };
}

// The body of every command substitution that would run, each a command line of its own. A nested `$( … $(…) )` is
// returned once, as the outer body.
export function lexSubstitutions(command) {
  return lexSegments(command).substitutions;
}

// The segments alone.
export function lexCommand(command) {
  return lexSegments(command).segments;
}

// The segments, and what each one reads on its input from the command line itself: `inputs[i]` lists the body of every
// heredoc, then the word of every here-string, that segment i redirects to its input.
export function lexInputs(command) {
  const { segments, heredocs } = lexSegments(command);
  const inputs = segments.map((segment, i) => [
    ...heredocs.filter((each) => each.segment === i).map((each) => each.body),
    ...segment.flatMap((token, at) => (token.operator && token.text === '<<<' && segment[at + 1] ? [segment[at + 1].text] : [])),
  ]);
  return { segments, inputs };
}

// The segments in the order they run, as { segment, substitutions }: the body of every command substitution that runs
// as part of the segment, before it. Substitutions with no segment after them, as in a heredoc fed to no command, come
// last with an empty segment.
export function lexSteps(command) {
  const { segments, substitutions, ends } = lexSegments(command);
  const steps = segments.map((segment, i) => ({ segment, substitutions: substitutions.slice(ends[i - 1] ?? 0, ends[i]) }));
  const rest = substitutions.slice(ends.at(-1) ?? 0);
  return rest.length ? [...steps, { segment: [], substitutions: rest }] : steps;
}

// The command line, then the body of every command substitution in it that would run, nested ones included: each a
// command line of its own, for a rule to judge as it judges the outer one. `x=$(git commit --amend)` amends too.
export function commandLines(command) {
  const lines = [];
  const visit = (line, depth) => {
    lines.push(line);
    if (depth < SUBSTITUTION_DEPTH_LIMIT) for (const body of lexSubstitutions(line)) visit(body, depth + 1);
  };
  visit(command, 0);
  return lines;
}

// Programs that run the command after them and return its status, so the program that matters is the wrapped one.
// `builtin` is not one: it runs shell builtins only. `rtk` and `rtk proxy` run the command through a token-saving proxy.
const WRAPPERS = new Set(['sudo', 'command', 'env', 'nice', 'nohup', 'stdbuf', 'timeout', 'exec', 'time', 'rtk']);
// Wrapper options that take the next token as their value, per wrapper (`-i` takes one for stdbuf, not for env).
const WRAPPER_VALUE_FLAGS = new Map([
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-R', '--chroot', '-r', '--role', '-t', '--type', '-D', '--chdir', '-h', '--host'])],
  ['exec', new Set(['-a'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-i', '--input', '-o', '--output', '-e', '--error'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
]);
// Wrapper options that change directory before running the command.
const WRAPPER_CHDIR_FLAGS = new Map([
  ['env', new Set(['-C', '--chdir'])],
  ['sudo', new Set(['-D', '--chdir'])],
]);
// env's option whose value is a command line.
const SPLIT_STRING_FLAGS = new Set(['-S', '--split-string']);
const SPLIT_STRING_DEPTH_LIMIT = 4;
const WRAPPER_PEEL_LIMIT = 8;
const NO_OPTIONS = new Set();
// Reserved words and braces that open or close a compound command: in `if x; then git commit -n; fi` or `{ rm f; }`,
// the command is the word after them. `time` is peeled as a wrapper.
const SHELL_WORDS = new Set(['{', '}', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', 'case', 'esac']);

// `text` without the `)`s at its end that close no `(` of its own: `--amend)` is `--amend`, and `fix (x)` stays whole.
function withoutUnmatchedClose(text) {
  let unmatched = (text.match(/\)/gu)?.length ?? 0) - (text.match(/\(/gu)?.length ?? 0);
  let end = text.length;
  while (unmatched > 0 && text[end - 1] === ')') {
    end -= 1;
    unmatched -= 1;
  }
  return text.slice(0, end);
}

// Two directory changes compose: the inner one is relative to the outer one, unless it is absolute.
function composeChdir(outer, inner) {
  if (!inner) return outer;
  if (!outer || inner.dynamic || outer.dynamic || path.isAbsolute(inner.text)) return inner;
  return { text: path.join(outer.text, inner.text), dynamic: false };
}

// The invocation inside an `env -S` value, with the words after it as its arguments; null when it cannot be read.
function splitStringInvocation(value, depth, rest = []) {
  if (!value || value.dynamic || depth >= SPLIT_STRING_DEPTH_LIMIT) return null;
  const carried = lexSegments(value.text).segments[0];
  if (!carried || carried.length === 0) return null;
  return readInvocation([...carried, ...rest], depth + 1);
}

// Reads the program of a segment: { program, args, negated, chdir }. It skips the shell words above, a subshell's
// parentheses, a `!` (which runs the command and inverts its status: `negated`), leading `VAR=value` assignments, and
// the wrappers above with their options, so `(sudo env FOO=1 command grep -c x f)` reads as grep. `program` is the base
// name; `args` exclude redirections and their targets; `chdir` is the directory a wrapper moves to, or null.
export function readInvocation(segment, depth = 0) {
  const targets = new Set();
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i].operator && segment[i + 1] && !segment[i + 1].fdDup) targets.add(segment[i + 1]);
  }
  const usable = segment.filter((token) => !token.operator && !token.fdDup && !targets.has(token));
  let index = 0;
  let negated = false;
  let chdir = null;
  // The lexer leaves a subshell's parentheses glued to its words, as in `(git commit --amend)`. A word left empty goes.
  const retext = (at, text) => {
    if (text === usable[at].text) return;
    if (text) usable[at] = { ...usable[at], text };
    else usable.splice(at, 1);
  };
  const peelAssignments = () => {
    while (index < usable.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(usable[index].text)) index += 1;
  };
  if (usable.length > 0) retext(usable.length - 1, withoutUnmatchedClose(usable.at(-1).text));
  for (;;) {
    if (index < usable.length) retext(index, usable[index].text.replace(/^\(+/u, ''));
    const text = usable[index]?.text;
    if (text === '!') negated = true;
    else if (!SHELL_WORDS.has(text)) break;
    index += 1;
  }
  peelAssignments();
  for (let guard = 0; guard < WRAPPER_PEEL_LIMIT; guard += 1) {
    const spelled = usable[index]?.text ?? '';
    const wrapper = spelled.split('/').pop();
    if (!WRAPPERS.has(wrapper)) break;
    // `time` is a reserved word only when bare; /usr/bin/time is another program.
    if (wrapper === 'time' && spelled !== wrapper) break;
    index += 1;
    if (wrapper === 'rtk') {
      if (usable[index]?.text === 'proxy') index += 1;
      continue;
    }
    while (index < usable.length) {
      const token = usable[index];
      if (token.text === '--') {
        index += 1;
        break;
      }
      // `env -` is env's own switch; for any other wrapper a lone `-` is an operand.
      if (token.text === '-' && wrapper !== 'env') break;
      if (!token.text.startsWith('-')) break;
      index += 1;
      const option = wrapperOption(token, WRAPPER_VALUE_FLAGS.get(wrapper) ?? NO_OPTIONS);
      if (!option) continue;
      let { value } = option;
      if (value === null) {
        value = usable[index];
        index += 1;
      }
      if (WRAPPER_CHDIR_FLAGS.get(wrapper)?.has(option.name)) chdir = composeChdir(chdir, value);
      if (wrapper === 'env' && SPLIT_STRING_FLAGS.has(option.name)) {
        const carried = splitStringInvocation(value, depth, usable.slice(index));
        if (carried) return { ...carried, negated: negated || carried.negated, chdir: composeChdir(chdir, carried.chdir) };
      }
    }
    // timeout's duration comes before the command; take it by position, since strtod accepts too many spellings.
    if (wrapper === 'timeout' && index < usable.length) index += 1;
    peelAssignments();
  }
  const program = usable[index]?.text ?? '';
  return { program: program.split('/').pop() ?? '', args: usable.slice(index + 1), negated, chdir };
}

// The option of a wrapper's option word that takes a value, as { name, value }: the value is a token when the word
// carries it (`--chdir=src`, `-Csrc`, `-iCsrc`), and null when it is the next word (`-C src`, `-iC src`). Null for a word
// of switches only.
function wrapperOption({ text, dynamic }, valueFlags) {
  if (text.startsWith('--')) {
    const equals = text.indexOf('=');
    const name = equals === -1 ? text : text.slice(0, equals);
    if (!valueFlags.has(name)) return null;
    return { name, value: equals === -1 ? null : { text: text.slice(equals + 1), dynamic } };
  }
  const { value } = readShortOptions(text, valueFlags);
  if (!value) return null;
  return { name: value.option, value: value.attached === null ? null : { text: value.attached, dynamic } };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O']);

// The command line a `sh -c "<string>"` runs, from readInvocation's { program, args }: the first operand after `-c` and
// any shell options, or null when the program is not a shell given `-c`.
export function inlineShellCommand({ program, args }) {
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

// Git global options that take the next token as their value.
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// A segment's git subcommand, the tokens after it, and the git global options before it; null when the segment does
// not run git, or a dynamic token hides the subcommand.
export function readGit(segment) {
  const { program, args } = readInvocation(segment);
  if (program !== 'git') return null;
  const globals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.dynamic) return null;
    if (GIT_VALUE_GLOBALS.has(token.text)) {
      globals.push(token, ...(args[i + 1] ? [args[i + 1]] : []));
      i += 1;
      continue;
    }
    if (token.text.startsWith('-')) {
      globals.push(token);
      continue;
    }
    return { subcommand: token.text, rest: args.slice(i + 1), globals };
  }
  return null;
}

// The options in one short-option word (`-abc`, never `--abc`), read as getopt reads it: -a, -b, -c, up to the first
// option in `valueFlags`, which takes the rest of the word (`-uroot`) or, when none is left, the next word (`-nu root`),
// or the first in `restFlags`, which takes only the rest of the word (GNU `sed -i.bak`). Returns { options, value }:
// each option as `-x`, and the one that takes a value as { option, attached }, where `attached` is the rest of the word,
// or null when the value is the next word.
export function readShortOptions(text, valueFlags, restFlags = NO_OPTIONS) {
  const options = [];
  for (let i = 1; i < text.length; i += 1) {
    const option = `-${text[i]}`;
    const rest = text.slice(i + 1);
    options.push(option);
    if (restFlags.has(option)) return { options, value: { option, attached: rest } };
    if (valueFlags.has(option)) return { options, value: { option, attached: rest === '' ? null : rest } };
  }
  return { options, value: null };
}

// Whether `text` is the long option `option`, or a prefix of it no shorter than `shortest`, with or without `=value`.
// git and getopt_long take any unambiguous prefix, so `git commit --no-veri` is `--no-verify`.
export function isLongOption(text, option, shortest) {
  const name = text.split('=', 1)[0];
  return name.startsWith(shortest) && option.startsWith(name);
}
