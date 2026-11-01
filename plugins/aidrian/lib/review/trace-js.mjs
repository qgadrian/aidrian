// The JavaScript and TypeScript reading behind a review flow's content trace (lib/review/content.mjs): which files
// import which, and which calls hand a variable on. It reads text with regular expressions, not a parser, so it
// stays dependency-free; what it cannot read it leaves out rather than guessing.
//
// The contract a language module keeps, so a second language is a second file with the same exports:
// - EXTENSIONS_RE: the source files the module reads.
// - RESOLVE_SUFFIXES: what an import specifier may leave off, tried in order.
// - parse(file, text, { tracked, aliases }): the file's imports and named re-exports, resolved to tracked files.
// - callsWith(text, names, vars, factory): the calls to imported names whose arguments hold a variable or a factory call.
// - acquiredVars(text, factorySource): the variables assigned from a factory call.
// - importWord(file): the word an importer names the file by, for one fixed-string grep over the repository.

import path from 'node:path';

export const EXTENSIONS_RE = /\.[cm]?[jt]sx?$/u;
export const RESOLVE_SUFFIXES = Object.freeze(['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']);

// A call head: a name or a member of one, optional type arguments, and the opening parenthesis.
const CALL = /\b((?:\w+\.)?\w+)\s*(?:<[^()]*?>)?\s*\(/gu;
// The longest argument list a call is read for; past it the arguments are cut, never the call missed.
const MAX_ARGUMENTS = 20000;
// What a call reports when its arguments hold no variable but an inline factory call.
const INLINE_FACTORY = 'an inline factory call';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// The tracked file an import specifier in `from` names, or null. A specifier that starts with an `aliases` prefix
// takes its replacement; a relative one resolves against `from`; any other is a package and is not followed.
function resolve(from, spec, tracked, aliases) {
  let base = null;
  const alias = Object.keys(aliases).filter((prefix) => spec.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  if (alias !== undefined) base = path.posix.normalize(aliases[alias] + spec.slice(alias.length));
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base === null) return null;
  for (const suffix of RESOLVE_SUFFIXES) if ((suffix || EXTENSIONS_RE.test(base)) && tracked.has(base + suffix)) return base + suffix;
  return null;
}

// The names of an import or export list: comments dropped, `type` markers dropped, and anything that is not a plain
// name or a `name as name` pair left out.
const nameList = (list) =>
  list
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '')
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).map((each) => each.trim()))
    .filter((names) => names.length <= 2 && names.every((name) => /^\w+$/u.test(name)));

// What `text` imports and re-exports by name, resolved to `tracked` files.
// `imports`: local name -> { target, imported }, with `default` for a default import and `*` for a namespace.
// `reExports`: [{ target, names }], names exported -> imported. `export *` is not followed.
export function parse(file, text, { tracked, aliases = {} }) {
  const imports = new Map();
  const importPattern = /\bimport\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/gu;
  for (const m of text.matchAll(importPattern)) {
    const target = resolve(file, m[4], tracked, aliases);
    if (!target) continue;
    if (m[1]) imports.set(m[1], { target, imported: 'default' });
    if (m[3]) imports.set(m[3], { target, imported: '*' });
    for (const [imported, local = imported] of nameList(m[2] ?? '')) imports.set(local, { target, imported });
  }
  const reExports = [];
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu)) {
    const target = resolve(file, m[2], tracked, aliases);
    if (!target) continue;
    reExports.push({ target, names: new Map(nameList(m[1]).map(([imported, exported = imported]) => [exported, imported])) });
  }
  return { imports, reExports };
}

// The argument text of the call whose opening parenthesis is at `open`, up to its balanced closing one. Parentheses
// inside a string, a template literal, or a comment do not count, so `load(")", client)` still reads to its end.
const argumentsAt = (text, open) => {
  let depth = 1;
  let at = open + 1;
  const end = Math.min(text.length, open + 1 + MAX_ARGUMENTS);
  for (; at < end && depth; at += 1) {
    const ch = text[at];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (at += 1; at < end && text[at] !== ch; at += 1) {
        if (text[at] === '\\') at += 1;
        else if (ch !== '`' && text[at] === '\n') break;
      }
    } else if (ch === '/' && text[at + 1] === '/') {
      while (at < end && text[at] !== '\n') at += 1;
    } else if (ch === '/' && text[at + 1] === '*') {
      const close = text.indexOf('*/', at + 2);
      at = close === -1 || close >= end ? end : close + 1;
    } else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return text.slice(open + 1, depth ? at : at - 1);
};

// The calls in `text` to a local name in `names`, or to a member of one, type arguments or not, whose arguments hold
// one of `vars` (a dotted name such as `ctx.client` too) or a match of `factory`: [{ name, variable, line }].
export function callsWith(text, names, vars, factory = null) {
  const patterns = [...vars].map((variable) => [variable, new RegExp(`\\b${escape(variable)}\\b`, 'u')]);
  const calls = [];
  for (const m of text.matchAll(CALL)) {
    if (!names.has(m[1].split('.')[0])) continue;
    // Quoted strings out, template literals kept: a name inside a string is not an argument.
    const args = argumentsAt(text, m.index + m[0].length - 1).replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/gu, '');
    const variable = patterns.find(([, pattern]) => pattern.test(args))?.[0] ?? (factory?.test(args) ? INLINE_FACTORY : null);
    if (variable) calls.push({ name: m[1], variable, line: text.slice(0, m.index).split('\n').length });
  }
  return calls;
}

// The variables `text` assigns from a call that `factorySource` (a regular expression source) matches:
// `const x = factory(...)`, with `let` or `var`, a type annotation, or `await` too.
export function acquiredVars(text, factorySource) {
  const vars = new Set();
  if (!factorySource) return vars;
  const acquire = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::\s*[\w.<>]+\s*)?=\s*(?:await\s+)?(?:${factorySource})`, 'gu');
  for (const m of text.matchAll(acquire)) vars.add(m[1]);
  return vars;
}

// The word an importer of `file` names it by: its base name, or its folder for an index file.
export const importWord = (file) => {
  const base = path.posix.basename(file).replace(EXTENSIONS_RE, '');
  return base === 'index' ? path.posix.basename(path.posix.dirname(file)) : base;
};
