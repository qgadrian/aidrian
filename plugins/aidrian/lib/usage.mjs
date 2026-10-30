// Usage text for `aidrian` and its commands (lib/cli.mjs and each command's module), wrapped to a width a terminal
// shows whole.

export const USAGE_WIDTH = 100;

// The lines of `aidrian <name> <usage>`: one for each alternative of `usage` (`new BRANCH | cleanup`), each wrapped to
// USAGE_WIDTH. The first line starts with `lead`, such as `usage: `, and every other with as many spaces; a wrapped
// line goes eight spaces deeper, below the text `aidrian --help` puts four deeper under each command.
export function usageLines(name, usage, lead = '') {
  const pad = ' '.repeat(lead.length);
  return alternatives(usage).flatMap((each, i) => wrap(`${i === 0 ? lead : pad}aidrian ${name} ${each}`.trimEnd(), `${pad}        `));
}

// `text` broken into lines of at most `width` characters, where possible, at the spaces outside brackets, so
// `[--status open|resolved|all]` stays on one line. Every line after the first starts with `indent`.
export function wrap(text, indent, width = USAGE_WIDTH) {
  const [lead] = /^ */u.exec(text);
  const lines = [];
  let line = lead;
  for (const word of topLevel(text.slice(lead.length), ' ')) {
    if (line.trim() && line.length + 1 + word.length > width) {
      lines.push(line);
      line = indent;
    }
    line += line.trim() ? ` ${word}` : word;
  }
  return [...lines, line];
}

// The alternatives of a usage, split at ` | ` outside brackets: `(--file PATH | --message TEXT)` stays whole.
function alternatives(usage) {
  return topLevel(usage, ' | ').map((each) => each.trim());
}

// `text` split at each `separator` that no (), [], or {} holds.
function topLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ('([{'.includes(text[i])) depth += 1;
    else if (')]}'.includes(text[i])) depth -= 1;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  return [...parts, text.slice(start)].filter((part) => part !== '');
}
