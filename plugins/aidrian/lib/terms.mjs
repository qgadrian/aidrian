// The terms rule: banned terms and their replacements, per file scope, from the file config.json `terms.file` names.
// docs/config.md#terms describes the file. Off while `terms.file` is null.
//
// One checker, two surfaces: the file-write hook checks the lines an agent's write adds (scripts/hook-write.mjs), and
// `aidrian lint terms` checks tracked or staged files for commits and CI (lib/lint.mjs). `aidrian check` validates the
// file. No dependencies: this file runs from the installed plugin.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { globPattern, isObject } from './fs.mjs';

export const TERMS_VERSION = 1;
const SEVERITIES = ['block', 'warn'];
const RULE_KEYS = ['id', 'paths', 'exclude', 'locale', 'severity', 'message', 'terms'];
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
    else rules.push(compile(rule, raw.locales));
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
  if (rule.paths === undefined && !(rule.locale !== undefined && isText(locales))) problems.push('needs "paths", or "locale" with the file\'s "locales"');
  if (rule.severity !== undefined && !SEVERITIES.includes(rule.severity)) problems.push('"severity" must be "block" or "warn"');
  if (rule.message !== undefined && !isText(rule.message)) problems.push('"message" must be a non-empty string');
  if (!isObject(rule.terms) || !Object.keys(rule.terms).length || !Object.entries(rule.terms).every(([term, use]) => isText(term) && isText(use))) {
    problems.push('"terms" must map each banned term to its replacement, both non-empty strings');
  }
  return problems;
}

function compile(rule, locales) {
  const paths = rule.paths ?? [locales.replaceAll('{locale}', rule.locale)];
  const terms = Object.entries(rule.terms).map(([term, replacement]) => ({ term, replacement, pattern: termPattern(term) }));
  return {
    id: rule.id,
    severity: rule.severity ?? 'block',
    message: rule.message ?? null,
    // A locale rule reads translations: the string values of a JSON file, never its keys.
    valuesOnly: rule.locale !== undefined,
    include: paths.map(globPattern),
    exclude: (rule.exclude ?? []).map(globPattern),
    terms,
    // One pass over a line for every term of the rule; only a line it matches is read term by term.
    any: new RegExp(terms.map(({ pattern }) => `(?:${pattern.source})`).join('|'), 'iu'),
  };
}

// A term as a case-insensitive pattern: a whole word in spaced scripts, letters on both sides counting as part of the
// word (`\b` would split at "ó"); anywhere in unspaced ones. `*` stands for further letters of the same word.
export function termPattern(term) {
  const escaped = term.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll('\\*', '[\\p{L}\\p{N}]*');
  return new RegExp(UNSPACED.test(term) ? escaped : `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

// The rules that apply to a file, by its path relative to the project root.
export function rulesFor(rules, rel) {
  const file = rel.split(path.sep).join('/');
  return rules.filter((rule) => rule.include.some((glob) => glob.test(file)) && !rule.exclude.some((glob) => glob.test(file)));
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

// Every hit in `lines` (each { number, text }) of a file at `rel`, as { line, term, replacement, rule }.
export function scanLines(lines, rel, rules) {
  const applying = rulesFor(rules, rel);
  if (!applying.length) return [];
  const json = /\.json$/iu.test(rel);
  const hits = [];
  for (const { number, text } of lines) {
    for (const rule of applying) {
      const parts = (rule.valuesOnly && json ? jsonValues(text) : [text]).map(normalize);
      if (!parts.some((part) => rule.any.test(part))) continue;
      for (const { term, replacement, pattern } of rule.terms) {
        if (parts.some((part) => pattern.test(part))) hits.push({ line: number, text, term, replacement, rule });
      }
    }
  }
  return hits;
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
  const before = new Set(text?.split(/\r?\n/u) ?? []);
  for (const { old_string: old, new_string: next, replace_all: all } of edits) {
    if (text === null || typeof old !== 'string' || old === '' || typeof next !== 'string' || !text.includes(old)) {
      text = null;
      break;
    }
    text = all ? text.replaceAll(old, () => next) : text.replace(old, () => next);
  }
  if (text !== null) return numbered(text).filter((line) => !before.has(line.text));
  return edits.flatMap(({ old_string: old, new_string: next }) => {
    if (typeof next !== 'string') return [];
    const replaced = new Set(typeof old === 'string' ? old.split(/\r?\n/u) : []);
    return numbered(next).filter((line) => !replaced.has(line.text));
  });
}

// The lines an agent's write adds, per file, as { file, lines }: the whole lines an Edit writes (editedLines), a Write's
// content without the lines the file already has, and the `+` lines of an apply_patch.
export function addedLines(input, cwd) {
  const tool = input.tool_input ?? {};
  const name = input.tool_name;
  if (name === 'Write' && typeof tool.file_path === 'string' && typeof tool.content === 'string') {
    let before = new Set();
    try {
      before = new Set(readFileSync(path.resolve(cwd, tool.file_path), 'utf8').split(/\r?\n/u));
    } catch {
      // A new file: every line is added.
    }
    return [{ file: tool.file_path, lines: numbered(tool.content).filter(({ text }) => !before.has(text)) }];
  }
  if (name === 'Edit' && typeof tool.file_path === 'string') {
    return [{ file: tool.file_path, lines: editedLines(path.resolve(cwd, tool.file_path), Array.isArray(tool.edits) ? tool.edits : [tool]) }];
  }
  if (name === 'apply_patch') {
    const files = [];
    for (const line of String(tool.command ?? tool.input ?? '').split(/\r?\n/u)) {
      const header = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line);
      if (header) files.push({ file: header[1].trim(), lines: [] });
      else if (/^\*\*\* /u.test(line)) files.push({ file: null, lines: [] });
      else if (line.startsWith('+') && files.at(-1)?.file) files.at(-1).lines.push({ number: files.at(-1).lines.length + 1, text: line.slice(1) });
    }
    return files.filter(({ file }) => file);
  }
  return [];
}
