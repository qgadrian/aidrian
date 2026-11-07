#!/usr/bin/env node
// Warns about code shape in the plugin's own lib/, by the plugin's default code style
// (plugins/aidrian/skills/knowledge/references/code-style.md): files over 300 lines, functions over 40, and nested
// ternaries. It only warns: `npm run check` prints the list and a summary line on stderr and still passes.
//
//   node scripts/code-shape.mjs [dir]   scan every .mjs file under dir, plugins/aidrian/lib by default
//
// The scan runs on the tokens of scripts/code-shape-lex.mjs, which skips strings, template text, regular expressions,
// and comments, and matches brackets, with no dependency. It reads the code of this repository, which ends statements with
// semicolons. A function is a function declaration or expression, generators included, a method named by a plain
// word, or an arrow function with a block body, measured from its first line to its closing brace; a private (`#name`)
// or computed (`[key]`) method is not measured. A ternary is nested when it sits in another one's test or branch.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLOSERS, OPENERS, lex, matchBrackets } from './code-shape-lex.mjs';

export const MAX_FILE_LINES = 300;
export const MAX_FUNCTION_LINES = 40;

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'plugins/aidrian/lib');

// The functions longer than MAX_FUNCTION_LINES: { line, name, lines }.
function longFunctions(tokens) {
  const match = matchBrackets(tokens);
  const found = [];
  tokens.forEach((_, index) => {
    const fn = functionAt(tokens, match, index);
    if (!fn) return;
    const line = tokens[fn.start].line;
    const lines = tokens[fn.end].line - line + 1;
    if (lines > MAX_FUNCTION_LINES) found.push({ line, name: fn.name, lines });
  });
  return found;
}

// The function whose defining token is at `index`, as { start, end, name } token indexes, or null.
function functionAt(tokens, match, index) {
  const token = tokens[index];
  if (token.type === 'word' && token.value === 'function') return declared(tokens, match, index);
  if (token.type !== 'punct') return null;
  if (token.value === '=>') return arrow(tokens, match, index);
  if (token.value === '(') return method(tokens, match, index);
  return null;
}

function declared(tokens, match, index) {
  let k = index + 1;
  if (tokens[k]?.value === '*') k++;
  const named = tokens[k]?.type === 'word';
  const name = named ? tokens[k].value : bindingName(tokens, index);
  if (named) k++;
  const end = bodyEnd(tokens, match, k);
  if (end === null) return null;
  return { start: index, end, name };
}

function arrow(tokens, match, index) {
  if (tokens[index + 1]?.value !== '{') return null;
  const end = match.get(index + 1);
  const params = index - 1;
  let start = tokens[params]?.value === ')' ? match.get(params) : params;
  if (start === undefined || end === undefined) return null;
  if (tokens[start - 1]?.value === 'async') start--;
  return { start, end, name: bindingName(tokens, start) };
}

// The words that take a parenthesis and a block but are not methods.
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function']);
// What can come right before a method's name: its object or class body, or a modifier.
const METHOD_AFTER = new Set(['{', ',', ';', '}', 'async', 'static', 'get', 'set', '*']);

// A method such as `run(args) { ... }`, by the `(` after its name. `function* name(` is a declaration, not a method.
function method(tokens, match, index) {
  const name = tokens[index - 1];
  if (name?.type !== 'word' || CONTROL.has(name.value)) return null;
  const before = tokens[index - 2]?.value;
  if (!METHOD_AFTER.has(before)) return null;
  if (before === '*' && tokens[index - 3]?.value === 'function') return null;
  const end = bodyEnd(tokens, match, index);
  if (end === null) return null;
  return { start: index - 1, end, name: name.value };
}

// The closing brace of the block that follows the parameters opening at `open`, or null when no block follows.
function bodyEnd(tokens, match, open) {
  if (tokens[open]?.value !== '(') return null;
  const close = match.get(open);
  if (close === undefined || tokens[close + 1]?.value !== '{') return null;
  return match.get(close + 1) ?? null;
}

// The name a function expression is bound to, as in `const name = ...` or `name: ...`.
function bindingName(tokens, start) {
  let k = start - 1;
  if (tokens[k]?.value === 'async') k--;
  const sign = tokens[k]?.value;
  const before = tokens[k - 1];
  if ((sign === '=' || sign === ':') && before?.type === 'word') return before.value;
  return '(anonymous)';
}

// What ends an expression segment: a ternary on either side of one is not nested in the other.
const BOUNDARIES = new Set([',', ';', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const STATEMENT_WORDS = new Set(['return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'throw', 'break', 'continue', 'try', 'yield']);

// The `?` tokens of ternaries nested in another ternary's test or branch: { line }.
// Each bracket level keeps, for its current segment: `open`, the ternaries begun at this level, whose branches run to
// the segment's end; `seen`, those plus the bracketed groups that held one, which a later `?` would take as its test;
// and `colons`, the `:` still owed to a `?`. A group opened inside an open ternary is inside its branch.
// SHORTCUT: a segment ends only at a semicolon, a comma, an assignment, an object key's or case label's `:`, or a
// statement keyword; a closed block does not end one, nor does a line break. That is enough for code that ends
// statements with semicolons; a parser would also end a segment after a block and where automatic semicolon insertion does.
function nestedTernaries(tokens) {
  const found = [];
  const frames = [frame(false)];
  tokens.forEach((token, index) => {
    if (startsStatement(tokens, index)) resetSegment(frames.at(-1));
    if (token.type === 'punct') visitPunct(token, frames, found);
  });
  return found;
}

// A statement word, unless it names a property, as in `obj.default` or `obj?.return`, which stays inside the expression.
function startsStatement(tokens, index) {
  const token = tokens[index];
  if (token.type !== 'word' || !STATEMENT_WORDS.has(token.value)) return false;
  const before = tokens[index - 1];
  return before?.type !== 'punct' || (before.value !== '.' && before.value !== '?.');
}

function frame(inBranch) {
  return { inBranch, open: 0, seen: 0, colons: 0, held: false };
}

function resetSegment(level) {
  level.open = 0;
  level.seen = 0;
  level.colons = 0;
}

function visitPunct(token, frames, found) {
  const level = frames.at(-1);
  const { value } = token;
  if (OPENERS.has(value)) return void frames.push(frame(level.open > 0 || level.inBranch));
  if (CLOSERS.has(value)) return closeLevel(frames, value);
  if (value === '?') return question(token, level, found);
  if (value === ':' && level.colons > 0) return void level.colons--;
  if (value === ':' || BOUNDARIES.has(value)) resetSegment(level);
}

function question(token, level, found) {
  if (level.seen > 0 || level.inBranch) found.push({ line: token.line });
  level.open++;
  level.seen++;
  level.colons++;
  level.held = true;
}

// A parenthesis or bracket group that held a ternary may be the test of the next `?`; a block never is.
function closeLevel(frames, value) {
  if (frames.length === 1) return;
  const child = frames.pop();
  const parent = frames.at(-1);
  if (value === '}' || !child.held) return;
  parent.seen++;
  parent.held = true;
}

function lineCount(source) {
  const lines = source.split('\n').length;
  if (source.endsWith('\n')) return lines - 1;
  return lines;
}

// The warnings for one source file: { line, kind: 'file' | 'function' | 'ternary', what }, in line order.
export function scanSource(source) {
  const tokens = lex(source);
  const warnings = [];
  const lines = lineCount(source);
  if (lines > MAX_FILE_LINES) warnings.push({ line: 1, kind: 'file', what: `file is ${lines} lines (over ${MAX_FILE_LINES})` });
  for (const fn of longFunctions(tokens)) {
    warnings.push({ line: fn.line, kind: 'function', what: `function ${fn.name} is ${fn.lines} lines (over ${MAX_FUNCTION_LINES})` });
  }
  for (const { line } of nestedTernaries(tokens)) warnings.push({ line, kind: 'ternary', what: 'nested ternary' });
  return warnings.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

// Prints every warning and the summary on stderr, and always exits 0: these are warnings, never failures.
function main([dir = DEFAULT_DIR] = []) {
  const counts = { file: 0, function: 0, ternary: 0 };
  for (const file of sourceFiles(dir)) {
    const shown = path.relative(process.cwd(), file);
    for (const warning of scanSource(readFileSync(file, 'utf8'))) {
      counts[warning.kind]++;
      process.stderr.write(`warning: ${shown}:${warning.line}: ${warning.what}\n`);
    }
  }
  process.stderr.write(`code-shape: ${counts.file} files over ${MAX_FILE_LINES} lines, ${counts.function} functions over ${MAX_FUNCTION_LINES} lines, `
    + `${counts.ternary} nested ternaries (warnings only)\n`);
  return 0;
}

// Run only as the entry script. process.argv[1] is unset under `node -e` and need not be a file under `node -p`.
// import.meta.url has symlinks resolved, so resolve the entry path too, or a symlinked run scans nothing.
const entry = process.argv[1];
if (entry && existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href) process.exitCode = main(process.argv.slice(2));
