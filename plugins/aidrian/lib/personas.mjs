// Personas: the people who use a project's product, one knowledge doc each, tagged `personas`. The persona-audit skill
// walks the product as one of them. A persona doc needs the sections below, and every `### <task>` under `## Tasks`
// needs a `Success:` line a run can check. The doc named `product-access`, which says how a session reaches the
// product, shares the tag and is exempt. The contract is in docs/personas.md.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fencedLines, headingOf } from './markdown-sections.mjs';

export const TAG = 'personas';
export const ACCESS_DOC = 'product-access';
export const REQUIRED = ['Who', 'Goals', 'Tasks', 'Cares about', 'Does not care about', 'Context'];

const TASK = /^ {0,3}###(?!#)\s+(.+?)\s*$/u;
// `Success: ...`, also as a list item or in bold, with something after the colon.
const SUCCESS = /^\s*(?:[-*+]\s+)?(?:\*\*Success:\*\*|\*\*Success\*\*:|Success:)\s*\S/u;

// { sections: { title: body }, tasks: [{ title, success }] }. Headings inside code fences are text.
export function parsePersona(text) {
  const lines = String(text).split(/\r?\n/u);
  const fenced = fencedLines(text);
  const sections = {};
  const tasks = [];
  let section = null;
  let task = null;
  lines.forEach((line, index) => {
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
    if (own) tasks.push((task = { title: own, success: false }));
    else if (task && !fenced[index] && SUCCESS.test(line)) task.success = true;
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
  return problems;
}

// The persona ids, file names without .md, of the docs tagged `personas`: each doc's path as its bucket shows it
// (relative to the project, absolute for a local source), and the file to read. A doc in two buckets counts once.
export function personaDocs(root, buckets) {
  const shown = new Set();
  for (const bucket of buckets) for (const doc of bucket.tags[TAG] ?? []) shown.add(doc);
  return [...shown].map((doc) => ({ id: path.basename(doc, '.md'), shown: doc, file: path.resolve(root, doc) }));
}

// `aidrian lint personas`: every persona doc keeps the contract, and every id names one doc. A project with no personas passes.
export function lintPersonas(project, buckets) {
  const problems = [];
  const seen = new Map();
  let personas = 0;
  let tasks = 0;
  for (const { id, shown, file } of personaDocs(project.root, buckets)) {
    if (seen.has(id)) problems.push(`persona id "${id}" is used by ${seen.get(id)} and ${shown}`);
    else seen.set(id, shown);
    if (id === 'all') problems.push(`${shown}: the persona id "all" is reserved: persona-audit all runs every persona`);
    if (id === ACCESS_DOC) continue;
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
  }
  return { problems, summary: personas ? `${personas} personas, ${tasks} tasks, each with a Success: line` : `no docs tagged ${TAG}` };
}
