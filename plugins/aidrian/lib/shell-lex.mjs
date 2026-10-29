// The one shell lexer behind the Bash rules. It reads a command line the way bash splits it, without running anything:
// quotes, escapes, comments, operators, redirections, heredocs, and command substitutions.
//
// A token is { text, dynamic, operator?, fdDup? }: `text` without its quotes; `dynamic` when it holds `$`, a backtick,
// or a glob, so a rule never guesses at its value; `operator` for a redirection (`>`, `>>`, `<`); `fdDup` for the
// `&1` of `2>&1`. Everything a rule cannot read is meant to fail open: an unknown shape yields no match, never a deny.

import path from 'node:path';

const CONTINUATION = '\n';

// Index of the `)` closing the `(` at `open`, or `limit` when none does before it. Quotes are not read here.
function closingParen(command, open, limit) {
  let depth = 0;
  let j = open;
  for (; j < limit; j += 1) {
    if (command[j] === '(') depth += 1;
    else if (command[j] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return j;
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
function lexSegments(command) {
  const segments = [];
  const separators = [];
  const substitutions = [];
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
      const { delimiter, expands } = pendingHeredocs.shift();
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
        pendingHeredocs.push({ delimiter, expands: !quoted });
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
  return { segments, separators, substitutions };
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

// Reads the program of a segment: { program, args, negated, chdir }. It skips leading `VAR=value` assignments, a `!`
// (which runs the command and inverts its status: `negated`), and the wrappers above with their options, so
// `sudo env FOO=1 command grep -c x f` reads as grep. `program` is the base name; `args` exclude redirections and their
// targets; `chdir` is the directory a wrapper moves to, or null.
export function readInvocation(segment, depth = 0) {
  const targets = new Set();
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i].operator && segment[i + 1] && !segment[i + 1].fdDup) targets.add(segment[i + 1]);
  }
  const usable = segment.filter((token) => !token.operator && !token.fdDup && !targets.has(token));
  let index = 0;
  let negated = false;
  let chdir = null;
  const peelAssignments = () => {
    while (index < usable.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(usable[index].text)) index += 1;
  };
  if (usable[index]?.text === '!') {
    negated = true;
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
      const chdirFlags = WRAPPER_CHDIR_FLAGS.get(wrapper);
      const equals = token.text.indexOf('=');
      const longName = equals === -1 ? token.text : token.text.slice(0, equals);
      if (WRAPPER_VALUE_FLAGS.get(wrapper)?.has(token.text)) {
        if (chdirFlags?.has(token.text)) chdir = composeChdir(chdir, usable[index]);
        if (wrapper === 'env' && SPLIT_STRING_FLAGS.has(token.text)) {
          const carried = splitStringInvocation(usable[index], depth, usable.slice(index + 1));
          if (carried) return { ...carried, negated: negated || carried.negated, chdir: composeChdir(chdir, carried.chdir) };
        }
        index += 1;
      } else if (wrapper === 'env' && equals !== -1 && SPLIT_STRING_FLAGS.has(longName)) {
        const value = { text: token.text.slice(equals + 1), dynamic: token.dynamic };
        const carried = splitStringInvocation(value, depth, usable.slice(index));
        if (carried) return { ...carried, negated: negated || carried.negated, chdir: composeChdir(chdir, carried.chdir) };
      } else if (equals !== -1 && chdirFlags?.has(longName)) {
        chdir = composeChdir(chdir, { text: token.text.slice(equals + 1), dynamic: token.dynamic });
      } else if (token.text.length > 2 && !token.text.startsWith('--') && chdirFlags?.has(token.text.slice(0, 2))) {
        chdir = composeChdir(chdir, { text: token.text.slice(2), dynamic: token.dynamic });
      }
    }
    // timeout's duration comes before the command; take it by position, since strtod accepts too many spellings.
    if (wrapper === 'timeout' && index < usable.length) index += 1;
    peelAssignments();
  }
  const program = usable[index]?.text ?? '';
  return { program: program.split('/').pop() ?? '', args: usable.slice(index + 1), negated, chdir };
}

// Git global options that take the next token as their value.
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

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
