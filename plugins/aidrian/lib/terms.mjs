// The terms rule: banned terms and their replacements, per file scope, from the file config.json `terms.file` names.
// docs/config.md#terms describes the file. Off while `terms.file` is null.
//
// One checker, two surfaces: the file-write hook checks the lines an agent's write adds (scripts/hook-write.mjs), and
// `aidrian lint terms` checks tracked or staged files for commits and CI (lib/lint.mjs). `aidrian check` validates the
// file. No dependencies: this file runs from the installed plugin.
//
// A rule reads in one of three modes: text (any line, the default), `prose` (a Markdown file's own prose,
// lib/markdown-prose.mjs), or `code` (whole identifiers in any case style, lib/code-words.mjs). A `code` rule runs on
// agent writes only: the project's own linter is the commit and CI gate for code names.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { codeName, identifiers, maskCode } from './code-words.mjs';
import { globPattern, isObject } from './fs.mjs';
import { proseLines } from './markdown-prose.mjs';

export const TERMS_VERSION = 1;
// Files no rule reads, on any surface: binaries, lockfiles, and minified bundles. A file holding a NUL byte is binary too.
export const NOT_TEXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|otf|pdf|zip|gz|tar|tgz|mp[34]|wav|ogg)$|\.min\.[a-z]+$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock)$/i;
const SEVERITIES = ['block', 'warn'];
const RULE_KEYS = ['id', 'paths', 'exclude', 'locale', 'severity', 'message', 'prose', 'compounds', 'code', 'terms'];
// Scripts written without spaces between words: their terms match anywhere, not as whole words.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A JSON string literal, and the colon after it when it is a key.
const JSON_STRING = /"(?:[^"\\]|\\.)*"(\s*:)?/gu;

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isTexts = (value) => Array.isArray(value) && value.every(isText);

// { rules, errors, file } for the project, or null when `terms.file` is null. `rules` holds every rule that is valid;
// a bad rule is an error and is left out, so the rest still apply.
export function loadTerms(project, config) {
  const rel = config.terms.file;
  if (rel === null) return null;
  const errors = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.resolve(project.root, rel), 'utf8'));
  } catch (error) {
    return { rules: [], errors: [`${rel}: ${error.code === 'ENOENT' ? 'not found (config.json `terms.file`)' : `not valid JSON: ${error.message}`}`], file: rel };
  }
  if (!isObject(raw)) return { rules: [], errors: [`${rel}: must be a JSON object`], file: rel };
  if (raw.version !== TERMS_VERSION) errors.push(`${rel}: "version" must be ${TERMS_VERSION}`);
  for (const key of Object.keys(raw)) if (!['version', 'locales', 'rules'].includes(key)) errors.push(`${rel}: unknown key "${key}"`);
  if (raw.locales !== undefined && !(isText(raw.locales) && raw.locales.includes('{locale}'))) {
    errors.push(`${rel}: "locales" must be a glob with {locale} in it, such as "locales/{locale}/*.json"`);
  }
  if (!Array.isArray(raw.rules)) return { rules: [], errors: [...errors, `${rel}: "rules" must be a list`], file: rel };
  const ids = new Set();
  const rules = [];
  raw.rules.forEach((rule, index) => {
    const problems = ruleProblems(rule, raw.locales);
    const id = isObject(rule) && isText(rule.id) ? rule.id : `#${index + 1}`;
    if (ids.has(id)) problems.push('another rule has this id');
    ids.add(id);
    if (problems.length) errors.push(...problems.map((problem) => `${rel}: rule "${id}": ${problem}`));
    else rules.push(compile(rule, raw.locales, rel));
  });
  return { rules, errors, file: rel };
}

function ruleProblems(rule, locales) {
  if (!isObject(rule)) return ['must be an object'];
  const problems = Object.keys(rule).filter((key) => !RULE_KEYS.includes(key)).map((key) => `unknown key "${key}"`);
  if (!isText(rule.id)) problems.push('"id" must be a non-empty string');
  if (rule.paths !== undefined && !(isTexts(rule.paths) && rule.paths.length)) problems.push('"paths" must be a list of globs');
  if (rule.exclude !== undefined && !isTexts(rule.exclude)) problems.push('"exclude" must be a list of globs');
  if (rule.locale !== undefined && !isText(rule.locale)) problems.push('"locale" must be a non-empty string');
  if (rule.locale !== undefined && rule.paths === undefined && !isText(locales)) problems.push('"locale" needs the file\'s "locales"');
  for (const key of ['prose', 'compounds', 'code']) if (rule[key] !== undefined && typeof rule[key] !== 'boolean') problems.push(`"${key}" must be true or false`);
  if (rule.prose === true && rule.code === true) problems.push('"prose" and "code" cannot both be true');
  if ((rule.prose === true || rule.code === true) && rule.locale !== undefined) problems.push(`"${rule.prose === true ? 'prose' : 'code'}" does not go with "locale"`);
  if (rule.compounds !== undefined && rule.prose !== true) problems.push('"compounds" goes only with "prose"');
  if (rule.code === true && rule.paths === undefined) problems.push('a "code" rule needs "paths": code names and prose words differ');
  if (rule.code === true && isObject(rule.terms)) {
    const seen = new Map();
    for (const term of Object.keys(rule.terms)) {
      if (term.includes('*')) problems.push(`"${term}": a "code" term has no "*"`);
      const name = codeName(term);
      if (seen.has(name)) problems.push(`"${seen.get(name)}" and "${term}" name the same identifier`);
      seen.set(name, term);
    }
  }
  if (rule.severity !== undefined && !SEVERITIES.includes(rule.severity)) problems.push('"severity" must be "block" or "warn"');
  if (rule.message !== undefined && !isText(rule.message)) problems.push('"message" must be a non-empty string');
  if (!isObject(rule.terms) || !Object.keys(rule.terms).length || !Object.entries(rule.terms).every(([term, use]) => isText(term) && isText(use))) {
    problems.push('"terms" must map each banned term to its replacement, both non-empty strings');
  }
  return problems;
}

function compile(rule, locales, termsFile) {
  const everywhere = rule.paths === undefined && rule.locale === undefined;
  const paths = rule.paths ?? (rule.locale !== undefined ? [locales.replaceAll('{locale}', rule.locale)] : ['**']);
  const mode = rule.code === true ? 'code' : rule.prose === true ? 'prose' : 'text';
  const terms = Object.entries(rule.terms).map(([term, replacement]) => ({ term, replacement, pattern: termPattern(term, { compound: mode === 'prose' && rule.compounds !== true }) }));
  return {
    id: rule.id,
    severity: rule.severity ?? 'block',
    message: rule.message ?? null,
    mode,
    // A rule with neither `paths` nor `locale` reads every file, except those git ignores.
    everywhere,
    // A locale rule reads translations: the string values of a JSON file, never its keys.
    valuesOnly: rule.locale !== undefined,
    include: paths.map(globPattern),
    exclude: (rule.exclude ?? []).map(globPattern),
    // The terms file itself names every banned term: no rule reads it.
    self: termsFile ? path.posix.normalize(termsFile.split(path.sep).join('/')) : null,
    terms,
    // A code rule looks identifiers up by name; the others make one pass over a line for every term of the rule, and
    // only a line it matches is read term by term.
    names: mode === 'code' ? new Map(terms.map((term) => [codeName(term.term), term])) : null,
    any: new RegExp(terms.map(({ pattern }) => `(?:${pattern.source})`).join('|'), 'iu'),
  };
}

// A term as a case-insensitive pattern: a whole word in spaced scripts, letters on both sides counting as part of the
// word (`\b` would split at "ó"); anywhere in unspaced ones. `*` stands for further letters of the same word. With
// `compound`, a word joined by `-` is part of a compound and no match: "you" in "show-your-work". A `prose` rule passes
// it unless the rule sets `compounds`, as one banning a name must catch "acme-approved".
export function termPattern(term, { compound = false } = {}) {
  const escaped = term.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll('\\*', '[\\p{L}\\p{N}]*');
  const edge = compound ? '\\p{L}\\p{N}_-' : '\\p{L}\\p{N}_';
  return new RegExp(UNSPACED.test(term) ? escaped : `(?<![${edge}])${escaped}(?![${edge}])`, 'iu');
}

// The rules that apply to a file, by its path relative to the project root. `ignored`, when true, leaves out the rules
// that read every file: they read what git keeps, as `aidrian lint terms` does.
export function rulesFor(rules, rel, { ignored = false } = {}) {
  const file = rel.split(path.sep).join('/');
  if (NOT_TEXT.test(file)) return [];
  return rules.filter((rule) => file !== rule.self && !(ignored && rule.everywhere)
    && rule.include.some((glob) => glob.test(file)) && !rule.exclude.some((glob) => glob.test(file)));
}

const normalize = (text) => text.normalize('NFC').replace(/[  ]/gu, ' ').replace(/‑/gu, '-');

// The JSON string values on one line, decoded: every string literal that is not a key.
export function jsonValues(line) {
  return [...line.matchAll(JSON_STRING)].filter(([, key]) => key === undefined).map(([literal]) => {
    try {
      return JSON.parse(literal);
    } catch {
      return literal;
    }
  });
}

// Every hit in `lines` (each { number, text }) of a file at `rel`, as { line, text, term, replacement, rule, severity }.
// `context` describes where the lines come from:
//   text      the whole file as it is (lint) or as the write leaves it (hook), so a `prose` rule knows its fences
//   before    the file before the write: a `prose` line counts as added when its masked text is new
//   reliable  false when `text` could not be built (an `apply_patch`, an Edit whose old text is gone): a `prose` rule
//             then reads `lines` alone and only warns, since a fence above them is unknown
//   ignored   git ignores the file (see rulesFor)
//   code      false leaves out `code` rules (lint)
export function scanLines(lines, rel, rules, { text = null, before = null, reliable = true, ignored = false, code = true } = {}) {
  const applying = rulesFor(rules, rel, { ignored }).filter((rule) => code || rule.mode !== 'code');
  if (!applying.length || (text ?? '').includes('\0') || lines.some((line) => line.text.includes('\0'))) return [];
  const json = /\.json$/iu.test(rel);
  const hits = [];
  let prose = null;
  let maskedCode = null;
  for (const rule of applying) {
    const severity = rule.mode === 'prose' && !(reliable && text !== null) ? 'warn' : rule.severity;
    const hit = (line, term) => hits.push({ line: line.number, text: line.text, term: term.term, replacement: term.replacement, rule, severity });
    if (rule.mode === 'code') {
      // With the whole file, a block comment or template literal that opens above a line still masks it.
      const masked = reliable && text !== null ? (maskedCode ??= maskCode(String(text)).split(/\r?\n/u)) : null;
      for (const line of lines) {
        for (const name of masked ? identifiers(masked[line.number - 1] ?? '', true) : identifiers(line.text)) {
          const term = rule.names.get(codeName(name));
          if (term) hit(line, term);
        }
      }
      continue;
    }
    const read = rule.mode === 'prose' ? (prose ??= proseRead(lines, { text, before, reliable })) : lines.map((line) => ({ line, part: line.text }));
    for (const { line, part } of read) {
      const parts = (rule.valuesOnly && json ? jsonValues(part) : [part]).map(normalize);
      if (!parts.some((each) => rule.any.test(each))) continue;
      for (const term of rule.terms) if (parts.some((each) => term.pattern.test(each))) hit(line, term);
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

// The prose a `prose` rule reads, as { line, part }: with the whole file, the masked lines that are new, by masked text,
// so a line moved out of a fence or a quote counts and a reordered one does not; without it, `lines` read on their own.
function proseRead(lines, { text, before, reliable }) {
  if (!reliable || text === null) {
    const masked = proseLines(lines.map((line) => line.text).join('\n'));
    return lines.map((line, i) => ({ line, part: masked[i] })).filter(({ part }) => part !== null);
  }
  // Compared with blanks collapsed: a code span, URL, or quotation that only changes length leaves the prose as it was.
  const key = (part) => part.replace(/\s+/gu, ' ').trim();
  const old = new Set(before === null ? [] : proseLines(before).filter((part) => part !== null).map(key));
  const all = String(text).split(/\r?\n/u);
  return proseLines(text)
    .map((part, i) => ({ line: { number: i + 1, text: all[i] }, part }))
    .filter(({ part }) => part !== null && part.trim() !== '' && !old.has(key(part)));
}

export const numbered = (text) => text.split(/\r?\n/u).map((line, i) => ({ number: i + 1, text: line }));

// One hit as a line of output.
export const formatHit = (file, hit) =>
  `${file}:${hit.line}: "${hit.term}" -> use "${hit.replacement}" [${hit.rule.id}]${hit.rule.message ? ` ${hit.rule.message}` : ''}`;

// The lines of the file once an Edit's edits apply, in order, that the file did not have, with their line numbers: an
// edit inside one JSON value is read as the whole line it lands on, so a locale rule sees the value. Without the file,
// or when an edit's old text is not in it, each edit's new text is read alone.
function editedLines(file, edits) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  const before = text;
  const old = new Set(text?.split(/\r?\n/u) ?? []);
  for (const { old_string: from, new_string: next, replace_all: all } of edits) {
    if (text === null || typeof from !== 'string' || from === '' || typeof next !== 'string' || !text.includes(from)) {
      text = null;
      break;
    }
    text = all ? text.replaceAll(from, () => next) : text.replace(from, () => next);
  }
  if (text !== null) return { lines: numbered(text).filter((line) => !old.has(line.text)), text, before, reliable: true };
  const lines = edits.flatMap(({ old_string: from, new_string: next }) => {
    if (typeof next !== 'string') return [];
    const replaced = new Set(typeof from === 'string' ? from.split(/\r?\n/u) : []);
    return numbered(next).filter((line) => !replaced.has(line.text));
  });
  return { lines, text: null, before: null, reliable: false };
}

// The lines an agent's write adds, per file, as { file, lines, text, before, reliable } (see scanLines): the whole lines
// an Edit writes (editedLines), a Write's content without the lines the file already has, and the `+` lines of an
// apply_patch, whose numbers count within the patch, so its file text is never known.
export function addedLines(input, cwd) {
  const tool = input.tool_input ?? {};
  const name = input.tool_name;
  if (name === 'Write' && typeof tool.file_path === 'string' && typeof tool.content === 'string') {
    let before = null;
    try {
      before = readFileSync(path.resolve(cwd, tool.file_path), 'utf8');
    } catch {
      // A new file: every line is added.
    }
    const old = new Set(before?.split(/\r?\n/u) ?? []);
    return [{ file: tool.file_path, lines: numbered(tool.content).filter(({ text }) => !old.has(text)), text: tool.content, before, reliable: true }];
  }
  if (name === 'Edit' && typeof tool.file_path === 'string') {
    return [{ file: tool.file_path, ...editedLines(path.resolve(cwd, tool.file_path), Array.isArray(tool.edits) ? tool.edits : [tool]) }];
  }
  if (name === 'apply_patch') {
    const files = [];
    for (const line of String(tool.command ?? tool.input ?? '').split(/\r?\n/u)) {
      const header = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line);
      const move = /^\*\*\* Move to: (.+)$/u.exec(line);
      if (header) files.push({ file: header[1].trim(), lines: [], text: null, before: null, reliable: false });
      else if (move && files.at(-1)?.file) files.at(-1).file = move[1].trim();
      else if (/^\*\*\* /u.test(line)) files.push({ file: null, lines: [], text: null, before: null, reliable: false });
      else if (line.startsWith('+') && files.at(-1)?.file) files.at(-1).lines.push({ number: files.at(-1).lines.length + 1, text: line.slice(1) });
    }
    return files.filter(({ file }) => file);
  }
  return [];
}
