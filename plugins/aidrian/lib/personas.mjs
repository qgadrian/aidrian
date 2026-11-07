// Personas: the people who use a project's product, one knowledge doc each, tagged `personas`. The persona-audit skill
// walks the product as one of them. A persona doc needs the sections below, and every `### <task>` under `## Tasks`
// needs a `Success:` line a run can check, in the persona's words: a `Success:` paragraph that quotes the product's
// text warns. Two tasks with one title fail, since a run names a task by its title. The doc named `product-access`,
// which says how a session reaches the product, shares the tag and is exempt, but for a warning on a Preview line that
// names no usable host. The contract is in docs/personas.md.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fencedLines, headingOf, LIST_ITEM, unfencedLines } from './markdown-sections.mjs';

export const TAG = 'personas';
export const ACCESS_DOC = 'product-access';
export const REQUIRED = ['Who', 'Goals', 'Tasks', 'Cares about', 'Does not care about', 'Context'];

const TASK = /^ {0,3}###(?!#)\s+(.+?)\s*$/u;
// `Success: ...`, also as a list item or in bold, with something after the colon.
const SUCCESS = /^\s*(?:[-*+]\s+)?(?:\*\*Success:\*\*|\*\*Success\*\*:|Success:)\s*\S/u;
const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*Success:\*\*|\*\*Success\*\*:|Success:)\s*/u;
// Any ATX heading, which ends a Success: paragraph.
const ANY_HEADING = /^ {0,3}#{1,6}(?:\s|$)/u;
// A span of the product's own text: straight or typographic double quotes, or backticks. Single quotes are apostrophes too often.
const QUOTED = /"[^"]+"|“[^”]+”|`[^`]+`/u;
// A line of product-access `## Environments` that means to be a Preview line, usable or not: any case, emphasis, or no list.
const PREVIEW_LABEL = /^\s*(?:[-*+]\s+)?[*_`]*preview[*_`]*\s*:/iu;
// `- Preview: <host>` or `- Preview: *.<host>`, the value in backticks or not, with words after it.
const PREVIEW_LINE = /^\s*[-*+]\s+Preview:\s*`?([^\s`,]+)`?(?:[\s,]|$)/u;
// An exact host, or a star for one label over at least two more, so no star stands for a whole top-level domain.
const PREVIEW_PATTERN = /^(?:\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+|[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/u;

// { sections: { title: body }, tasks: [{ title, success, outcome }] }. Headings inside code fences are text. `outcome`
// is the Success: paragraph after its label, its lines joined by one space up to a blank line, a heading, a list item,
// a fence, or another Success: line; a later Success: line of the same task adds its paragraph after one space; null for
// a task without one.
export function parsePersona(text) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedLines(text);
  const sections = {};
  const tasks = [];
  let section = null;
  let task = null;
  let paragraph = false;
  lines.forEach((line, index) => {
    const ends = fenced[index] || line.trim() === '' || ANY_HEADING.test(line) || LIST_ITEM.test(line) || SUCCESS.test(line);
    if (paragraph && !ends) task.outcome += ` ${line.trim()}`;
    else paragraph = false;
    const title = fenced[index] ? null : headingOf(line);
    if (title !== null) {
      section = title;
      sections[section] ??= '';
      task = null;
      return;
    }
    if (section === null) return;
    sections[section] += `${line}\n`;
    if (section !== 'Tasks') return;
    const own = fenced[index] ? null : TASK.exec(line)?.[1];
    if (own) tasks.push((task = { title: own, success: false, outcome: null }));
    else if (task && !fenced[index] && SUCCESS.test(line)) {
      const outcome = line.replace(LABEL, '').trim();
      task.success = true;
      task.outcome = task.outcome === null ? outcome : `${task.outcome} ${outcome}`;
      paragraph = true;
    }
  });
  return { sections, tasks };
}

// The problems of one persona doc, each without the file name.
export function personaProblems(text) {
  const { sections, tasks } = parsePersona(text);
  const problems = [];
  for (const title of REQUIRED) {
    if (!Object.hasOwn(sections, title)) problems.push(`no "## ${title}" section`);
    else if (sections[title].trim() === '') problems.push(`"## ${title}" is empty`);
  }
  if (Object.hasOwn(sections, 'Tasks') && sections.Tasks.trim() !== '' && !tasks.length) problems.push('"## Tasks" has no "### <task>"');
  for (const task of tasks) if (!task.success) problems.push(`task "${task.title}" has no "Success:" line`);
  const titles = new Map();
  for (const { title } of tasks) titles.set(title, (titles.get(title) ?? 0) + 1);
  for (const [title, count] of titles) if (count > 1) problems.push(`${count} tasks are titled "${title}": --task and the report key on the title`);
  return problems;
}

// The warnings of one persona doc, each without the file name: a Success: paragraph that quotes the product's text.
export function personaWarnings(text) {
  const warnings = [];
  for (const { title, outcome } of parsePersona(text).tasks) {
    const quote = outcome === null ? null : QUOTED.exec(outcome)?.[0];
    if (quote) warnings.push(`task "${title}": Success: quotes ${quote}; write the outcome in the persona's words, not the product's text`);
  }
  return warnings;
}

const previewLines = (text) => [...unfencedLines(parsePersona(text).sections.Environments ?? '')].filter((line) => PREVIEW_LABEL.test(line));
const previewPattern = (line) => {
  const pattern = PREVIEW_LINE.exec(line)?.[1].toLowerCase();
  return pattern && PREVIEW_PATTERN.test(pattern) ? pattern : null;
};

// The hosts and host patterns the Preview lines of a product-access doc's `## Environments` name, lowercased.
export const previewPatterns = (text) => previewLines(text).map(previewPattern).filter(Boolean);

// The warnings of a product-access doc, each without the file name: a Preview line a run could not use.
const accessWarnings = (text) => previewLines(text).filter((line) => !previewPattern(line))
  .map((line) => `a Preview line under ## Environments names no usable host: ${line.trim()}; write "- Preview: <host>" or "- Preview: *.<domain>.<tld>", with no scheme, path, or bold`);

// The persona ids, file names without .md, of the docs tagged `personas`: each doc's path as its bucket shows it
// (relative to the project, absolute for a local source), and the file to read. A doc in two buckets counts once.
export function personaDocs(root, buckets) {
  const shown = new Set();
  for (const bucket of buckets) for (const doc of bucket.tags[TAG] ?? []) shown.add(doc);
  return [...shown].map((doc) => ({ id: path.basename(doc, '.md'), shown: doc, file: path.resolve(root, doc) }));
}

// `aidrian lint personas`: every persona doc keeps the contract, and every id names one doc. A project with no personas
// passes. A warning, such as a quoted Success: line, prints but fails nothing.
export function lintPersonas(project, buckets) {
  const problems = [];
  const warnings = [];
  const seen = new Map();
  let personas = 0;
  let tasks = 0;
  for (const { id, shown, file } of personaDocs(project.root, buckets)) {
    if (seen.has(id)) problems.push(`persona id "${id}" is used by ${seen.get(id)} and ${shown}`);
    else seen.set(id, shown);
    if (id === 'all') problems.push(`${shown}: the persona id "all" is reserved: persona-audit all runs every persona`);
    if (id === ACCESS_DOC) {
      try {
        warnings.push(...accessWarnings(readFileSync(file, 'utf8')).map((warning) => `${shown}: ${warning}`));
      } catch {
        // The doc is exempt, and optional: only a run needs to read it.
      }
      continue;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      problems.push(`${shown}: cannot be read`);
      continue;
    }
    personas += 1;
    tasks += parsePersona(text).tasks.length;
    problems.push(...personaProblems(text).map((problem) => `${shown}: ${problem}`));
    warnings.push(...personaWarnings(text).map((warning) => `${shown}: ${warning}`));
  }
  return { problems, warnings, summary: personas ? `${personas} personas, ${tasks} tasks, each with a Success: line` : `no docs tagged ${TAG}` };
}
