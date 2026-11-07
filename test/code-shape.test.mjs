import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MAX_FILE_LINES, MAX_FUNCTION_LINES, scanSource } from '../scripts/code-shape.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/code-shape.mjs');
const kinds = (source, kind) => scanSource(source).filter((warning) => warning.kind === kind);
// `count` statement lines, each `x++;`.
const body = (count) => Array.from({ length: count }, () => '  x++;').join('\n');
// Each kind of function: `make(lines)` writes one of `lines` lines in total, from its first line to its closing brace,
// which the scan names `name` and places at `line`.
const fns = {
  declaration: { name: 'work', line: 1, make: (lines) => `function work() {\n${body(lines - 2)}\n}\n` },
  generator: { name: 'work', line: 1, make: (lines) => `function* work() {\n${body(lines - 2)}\n}\n` },
  expression: { name: 'work', line: 1, make: (lines) => `const work = function () {\n${body(lines - 2)}\n};\n` },
  arrow: { name: 'work', line: 1, make: (lines) => `const work = async (a,\n  b) => {\n${body(lines - 3)}\n};\n` },
  method: { name: 'run', line: 2, make: (lines) => `export const command = {\n  run(args) {\n${body(lines - 2)}\n  },\n};\n` },
  getter: { name: 'size', line: 2, make: (lines) => `class Box {\n  get size() {\n${body(lines - 2)}\n  }\n}\n` },
  'static async method': { name: 'load', line: 2, make: (lines) => `class Box {\n  static async load(id) {\n${body(lines - 2)}\n  }\n}\n` },
  'generator method': { name: 'items', line: 2, make: (lines) => `const box = {\n  *items() {\n${body(lines - 2)}\n  },\n};\n` },
};
// Each control head that takes a parenthesis and a block, after a statement, so the block is not a method's body.
const controls = {
  if: 'x++;\nif (ready) {',
  for: 'x++;\nfor (const item of items) {',
  while: 'x++;\nwhile (ready) {',
  switch: 'x++;\nswitch (kind) {',
  catch: 'x++;\ntry {\n  x++;\n} catch (error) {',
};

test('a file over the line limit warns once, and one at the limit does not', () => {
  const lines = (count) => `${Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;
  assert.deepEqual(kinds(lines(MAX_FILE_LINES + 1), 'file').map(({ line, what }) => [line, what]), [[1, `file is ${MAX_FILE_LINES + 1} lines (over ${MAX_FILE_LINES})`]]);
  assert.deepEqual(kinds(lines(MAX_FILE_LINES), 'file'), []);
});

test('every kind of function over the line limit warns with its name, line, and size', () => {
  for (const [kind, { name, line, make }] of Object.entries(fns)) {
    const found = kinds(make(MAX_FUNCTION_LINES + 1), 'function');
    assert.deepEqual(found.map(({ line: at, what }) => [at, what]), [[line, `function ${name} is ${MAX_FUNCTION_LINES + 1} lines (over ${MAX_FUNCTION_LINES})`]], kind);
  }
});

test('a function at the limit, a control block, and an arrow without a block body do not warn', () => {
  for (const [kind, { make }] of Object.entries(fns)) assert.deepEqual(kinds(make(MAX_FUNCTION_LINES), 'function'), [], kind);
  for (const [kind, head] of Object.entries(controls)) {
    assert.deepEqual(kinds(`${head}\n${body(MAX_FUNCTION_LINES + 5)}\n}\n`, 'function'), [], kind);
  }
  const concise = `const list = items.map((item) =>\n${Array.from({ length: MAX_FUNCTION_LINES + 5 }, () => '  item +').join('\n')}\n  1);\n`;
  assert.deepEqual(kinds(concise, 'function'), []);
});

test('a ternary in another ternary\'s branch or test warns at the inner one', () => {
  for (const [source, line] of [
    ['const a = x ? 1 : y ? 2 : 3;\n', 1],
    ['const a = x\n  ? (y ? 1 : 2)\n  : 3;\n', 2],
    ['const a = (x ? y : z) ? 1 : 2;\n', 1],
    ['const a = x ? `${y ? 1 : 2}` : 3;\n', 1],
    ['const a = x ? { b: y ? 1 : 2 } : null;\n', 1],
    ['const a = b ? c : x?.5:1;\n', 1],
  ]) assert.deepEqual(kinds(source, 'ternary').map((warning) => warning.line), [line], source);
});

test('flat ternaries side by side, optional chaining, and nullish coalescing do not warn', () => {
  for (const source of [
    'const a = x ? 1 : 2;\nconst b = y ? 3 : 4;\n',
    'call(x ? 1 : 2, y ? 3 : 4);\n',
    'const a = (x ? 1 : 2) + (y ? 3 : 4);\n',
    'const o = { a: x ? 1 : 2, b: y ? 3 : 4 };\n',
    'const a = x?.y ?? z?.[0];\nconst b = c ? d : e;\n',
    'function f() { return x ? 1 : 2; }\nconst b = y ? 3 : 4;\n',
    'switch (k) {\n  case 1: return x ? 1 : 2;\n  default: return y ? 3 : 4;\n}\n',
  ]) assert.deepEqual(kinds(source, 'ternary'), [], source);
});

test('a ?, :, or brace inside a string, template text, regular expression, or comment is not code', () => {
  const quiet = [
    "const s = 'a ? b : c ? d : e';\n",
    'const s = "a ? b : c ? d : e";\n',
    'const s = `a ? b : c ? d : e { }`;\n',
    '// a ? b : c ? d : e\n',
    '/* a ? b : c ? d : e { */\n',
    'const r = /[?:{]/u;\nconst q = /a?b:c?/u.test(s) ? 1 : 2;\n',
    'const r = /[/]a ? b : c ? d : e/u;\n',
    "const a = x ? '?' : 'y ? 1 : 2';\n",
    "const s = 'it\\'s a ? b : c ? d : e';\n",
  ];
  for (const source of quiet) assert.deepEqual(scanSource(source), [], source);
  // A brace in a string, a regular expression, or a comment neither ends the function early nor stretches it.
  const tricky = `function work() {\n  const s = '}';\n  const r = /}/u;\n  // }\n  const t = \`}\${'{'}\`;\n${body(MAX_FUNCTION_LINES - 5)}\n}\nfunction after() {\n  x++;\n}\n`;
  assert.deepEqual(kinds(tricky, 'function').map(({ line, what }) => [line, what]), [[1, `function work is ${MAX_FUNCTION_LINES + 1} lines (over ${MAX_FUNCTION_LINES})`]]);
});

test('the script prints each warning with its place and a summary on stderr, and exits 0', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-code-shape-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'lib/sub'), { recursive: true });
  writeFileSync(path.join(dir, 'lib/sub/a.mjs'), 'const a = 1;\nconst b = x ? 1 : y ? 2 : 3;\n');
  writeFileSync(path.join(dir, 'lib/b.mjs'), fns.declaration.make(MAX_FUNCTION_LINES + 2));
  writeFileSync(path.join(dir, 'lib/notes.md'), 'a ? b : c ? d : e\n');
  const run = spawnSync(process.execPath, [SCRIPT, 'lib'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, [
    `warning: lib/b.mjs:1: function work is ${MAX_FUNCTION_LINES + 2} lines (over ${MAX_FUNCTION_LINES})`,
    'warning: lib/sub/a.mjs:2: nested ternary',
    `code-shape: 0 files over ${MAX_FILE_LINES} lines, 1 functions over ${MAX_FUNCTION_LINES} lines, 1 nested ternaries (warnings only)`,
    '',
  ].join('\n'));
});

test('npm run check runs the scan', () => {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /node scripts\/code-shape\.mjs/u);
});
