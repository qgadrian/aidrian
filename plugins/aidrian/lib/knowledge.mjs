// Reads and checks a project's knowledge buckets: one index file per bucket in the project folder's knowledge/.
// The format is described in docs/knowledge.md. No dependencies: this file runs from the installed plugin.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { insidePath, isDirectory, isFile, isObject, loadConfig, readJson } from './config.mjs';

const BUCKET_ID = /^[a-z0-9][a-z0-9-]*$/;
const TAG = /^[a-z][a-z0-9_]*$/;
// Every summary is read in search results and in the index, so it stays one short line.
const SUMMARY_MAX = 160;

// Returns { config, buckets, errors } for a project from lib/project.mjs. `errors` also holds the problems of the root
// files and of config.json, so one call checks everything an agent reads. Doc paths are relative to the project root.
export function loadKnowledge(project) {
  const { config, errors: configErrors, current } = loadConfig(project);
  const errors = [...project.errors, ...configErrors];
  const buckets = [];
  // A folder of another version may hold indexes of another shape; config.json already reports it.
  if (!current) return { config, buckets, errors };
  for (const source of project.sources) {
    for (const name of indexFiles(source)) {
      const bucket = loadBucket(source, name, errors);
      if (bucket) buckets.push(bucket);
    }
  }
  return { config, buckets, errors };
}

// The .json files in a source's knowledge folder, in file-name order: the bucket load order.
function indexFiles(source) {
  const dir = path.join(source.base, source.index);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

function loadBucket(source, name, errors) {
  const root = source.base;
  const file = `${source.index}/${name}`;
  const id = name.slice(0, -'.json'.length);
  if (!BUCKET_ID.test(id)) {
    errors.push(`${file}: the file name is the bucket id: use lowercase letters, digits, and "-"`);
    return null;
  }
  const raw = readJson(root, file, errors);
  if (!raw) return null;
  checkKeys(raw, ['dir', 'description', 'always', 'docs'], file, errors);

  const dir = insidePath(root, '', raw.dir);
  if (!dir || !isDirectory(path.join(root, dir))) {
    errors.push(`${file}: "dir" must be a folder inside the project`);
    return null;
  }
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    errors.push(`${file}: "description" must say what the bucket covers`);
  }

  const docs = [];
  if (!isObject(raw.docs)) {
    errors.push(`${file}: "docs" must map each doc to its summary and tags`);
  } else {
    for (const [doc, entry] of Object.entries(raw.docs)) {
      const rel = docPath(root, dir, doc, `${file}: "docs"`, docs.map((known) => known.path), errors);
      if (rel) docs.push({ path: rel, ...docEntry(entry, `${file}: "docs": ${rel}`, errors) });
    }
    if (Object.keys(raw.docs).length === 0) errors.push(`${file}: "docs" lists no docs`);
  }

  const always = [];
  if (!Array.isArray(raw.always ?? [])) {
    errors.push(`${file}: "always" must be a list of doc paths`);
  } else {
    for (const doc of raw.always ?? []) {
      const rel = docPath(root, dir, doc, `${file}: "always"`, always, errors);
      if (!rel) continue;
      always.push(rel);
      if (!docs.some((known) => known.path === rel)) errors.push(`${file}: "always": ${rel} has no entry in "docs"`);
    }
  }

  for (const doc of markdownFiles(root, dir)) {
    if (doc !== `${dir}/README.md` && !docs.some((known) => known.path === doc)) {
      errors.push(`${doc}: has no entry in ${file}; add it to "docs" with a summary, or delete it`);
    }
  }

  // The docs of each tag, in "docs" order.
  const tags = {};
  for (const doc of docs) {
    for (const tag of doc.tags) {
      if (!Object.hasOwn(tags, tag)) tags[tag] = [];
      tags[tag].push(doc.path);
    }
  }
  return { id, dir, description: raw.description, always, docs, tags };
}

// Returns the path relative to the project, or null after adding the reason to `errors`.
function docPath(root, dir, doc, where, seen, errors) {
  const rel = insidePath(root, dir, doc);
  if (!rel || !rel.endsWith('.md')) {
    errors.push(`${where}: ${JSON.stringify(doc)} must be a relative .md path inside the bucket`);
  } else if (!isFile(path.join(root, rel))) {
    errors.push(`${where}: ${rel} does not exist`);
  } else if (seen.includes(rel)) {
    errors.push(`${where}: ${rel} is listed twice`);
  } else {
    return rel;
  }
  return null;
}

// Returns { summary, tags }, with only the valid parts, after adding any problem to `errors`.
function docEntry(entry, where, errors) {
  if (!isObject(entry)) {
    errors.push(`${where} must be an object with "summary" and "tags"`);
    return { summary: '', tags: [] };
  }
  checkKeys(entry, ['summary', 'tags'], where, errors);
  let summary = entry.summary;
  if (typeof summary !== 'string' || summary.trim() === '' || /[\t\n\r]/.test(summary)) {
    errors.push(`${where} needs a one-line "summary" of what the doc covers`);
    summary = '';
  } else if (summary.length > SUMMARY_MAX) {
    errors.push(`${where}: "summary" is ${summary.length} characters; keep it to ${SUMMARY_MAX}`);
  }
  if (!Array.isArray(entry.tags ?? [])) {
    errors.push(`${where}: "tags" must be a list of tags`);
    return { summary, tags: [] };
  }
  const tags = [];
  for (const tag of entry.tags ?? []) {
    if (typeof tag !== 'string' || !TAG.test(tag) || tag === 'always') {
      errors.push(`${where}: tag ${JSON.stringify(tag)} must be snake_case and not "always"`);
    } else if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return { summary, tags };
}

// The docs to read for `tags`, in bucket order: each bucket's "always" docs, then its docs per tag.
// Object.hasOwn: a tag named like an inherited property, such as `constructor`, must not read Object.prototype.
export function routeKnowledge(buckets, tags) {
  const out = [];
  for (const bucket of buckets) {
    for (const doc of [...bucket.always, ...tags.flatMap((tag) => (Object.hasOwn(bucket.tags, tag) ? bucket.tags[tag] : []))]) {
      if (!out.includes(doc)) out.push(doc);
    }
  }
  return out;
}

export function listTags(buckets) {
  const counts = new Map();
  for (const bucket of buckets) {
    for (const [tag, docs] of Object.entries(bucket.tags)) counts.set(tag, (counts.get(tag) ?? 0) + docs.length);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

// Every doc of every bucket, in bucket order: { path, summary, tags }.
export function indexRows(buckets) {
  return buckets.flatMap((bucket) => bucket.docs);
}

// The docs that match `words`, best first. Each word scores 2 when it is part of a tag, 1 when it is part of the path,
// and 1 when it is part of the summary; ties keep bucket order.
export function searchKnowledge(buckets, words, limit = 8) {
  const terms = words.flatMap((word) => word.toLowerCase().split(/\s+/)).filter(Boolean);
  const hits = [];
  for (const doc of indexRows(buckets)) {
    let score = 0;
    for (const term of terms) {
      if (doc.tags.some((tag) => tag.includes(term))) score += 2;
      if (doc.path.toLowerCase().includes(term)) score += 1;
      if (doc.summary.toLowerCase().includes(term)) score += 1;
    }
    if (score > 0) hits.push({ ...doc, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Drafts a knowledge index for `folder`, a folder of docs: every .md file, a summary drafted from its first heading and
// first sentence, and no tags. The bucket id is the folder name. Returns { file, dir, docs }; throws when the folder is
// not usable or the index file exists.
export function initBucket(project, folder) {
  const { root } = project;
  const rel = insidePath(root, '', folder);
  if (!rel || !isDirectory(path.join(root, rel))) throw new Error(`${folder}: must be a folder inside the project`);
  const id = path.basename(rel).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'docs';
  const file = `${project.paths.knowledge}/${id}.json`;
  if (existsSync(path.join(root, file))) throw new Error(`${file} already exists; edit it instead`);
  const docs = {};
  for (const doc of markdownFiles(root, rel)) {
    const summary = draftSummary(readFileSync(path.join(root, doc), 'utf8')) || path.basename(doc, '.md');
    docs[doc.slice(rel.length + 1)] = { summary, tags: [] };
  }
  if (Object.keys(docs).length === 0) throw new Error(`${rel}: has no .md files`);

  mkdirSync(path.join(root, project.paths.knowledge), { recursive: true });
  writeJson(path.join(root, file), { dir: rel, description: `Docs in ${rel}.`, always: [], docs });
  return { file, dir: rel, docs: Object.keys(docs).length };
}

// "Heading: first sentence.", one line, cut to SUMMARY_MAX. A draft for a person to correct.
function draftSummary(text) {
  let heading = '';
  let sentence = '';
  let fenced = false;
  for (const line of text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').map((each) => each.trim())) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || line === '' || /^(```|~~~|[|<!])/.test(line)) continue;
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title) {
      heading ||= title[1];
      continue;
    }
    const prose = line.replace(/^([-*+>]|\d+[.)])\s+/, '');
    sentence = /^.*?[.!?](?=\s|$)/.exec(prose)?.[0] ?? prose;
    break;
  }
  const summary = [heading, sentence].filter(Boolean).join(': ').replace(/\s+/g, ' ');
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

// The tags the plugin's agents and skills ask for. The list in the knowledge skill is the single source for them.
export function pluginTags() {
  const skill = readFileSync(path.join(import.meta.dirname, '../skills/knowledge/SKILL.md'), 'utf8');
  return [...(skill.split('\n## Tags\n')[1] ?? '').matchAll(/^- `([a-z][a-z0-9_]*)`: /gm)].map((match) => match[1]);
}

function checkKeys(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
  }
}

function markdownFiles(root, dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}
