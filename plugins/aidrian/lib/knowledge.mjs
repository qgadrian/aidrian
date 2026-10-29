// Reads and checks a project's knowledge buckets. The format is described in docs/knowledge.md.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG, isFile, isObject, linksOutside, loadConfig, readJson } from './config.mjs';

const BUCKET_FILE = 'bucket.json';
const BUCKET_ID = /^[a-z0-9][a-z0-9-]*$/;
const TAG = /^[a-z][a-z0-9_]*$/;
// Every summary is read in search results and in the index, so it stays one short line.
const SUMMARY_MAX = 160;

// Returns { buckets, errors }. Each bucket path and doc path is relative to the project root.
export function loadKnowledge(root) {
  const { config, errors } = loadConfig(root);
  const buckets = [];
  const ids = new Set();
  for (const dir of config.buckets) {
    const bucketDir = insidePath(root, '', dir);
    if (!bucketDir) {
      errors.push(`${CONFIG}: bucket ${JSON.stringify(dir)} must be a relative folder inside the project`);
      continue;
    }
    const bucket = loadBucket(root, bucketDir, errors);
    if (!bucket) continue;
    if (ids.has(bucket.id)) errors.push(`${bucketDir}/${BUCKET_FILE}: id "${bucket.id}" is used by another bucket`);
    ids.add(bucket.id);
    buckets.push(bucket);
  }
  return { buckets, errors };
}

function loadBucket(root, dir, errors) {
  const file = `${dir}/${BUCKET_FILE}`;
  const raw = readJson(root, file, errors);
  if (!raw) return null;
  checkKeys(raw, ['id', 'description', 'always', 'docs'], file, errors);

  if (typeof raw.id !== 'string' || !BUCKET_ID.test(raw.id)) {
    errors.push(`${file}: "id" must be lowercase letters, digits and "-"`);
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
  return { id: raw.id, dir, description: raw.description, always, docs, tags };
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

// Drafts `dir`/bucket.json for a folder of docs that has none: every .md file, a summary drafted from its first heading
// and first sentence, and no tags. Creates the project config, listing this bucket, when the project has none.
// Returns { dir, docs, createdConfig }; throws when the folder is not usable or already has a bucket.json.
export function initBucket(root, dir) {
  const rel = insidePath(root, '', dir);
  if (!rel || !isDirectory(path.join(root, rel))) throw new Error(`${dir}: must be a folder inside the project`);
  if (existsSync(path.join(root, rel, BUCKET_FILE))) throw new Error(`${rel}/${BUCKET_FILE} already exists; edit it instead`);
  const docs = {};
  for (const doc of markdownFiles(root, rel)) {
    const summary = draftSummary(readFileSync(path.join(root, doc), 'utf8')) || path.basename(doc, '.md');
    docs[doc.slice(rel.length + 1)] = { summary, tags: [] };
  }
  if (Object.keys(docs).length === 0) throw new Error(`${rel}: has no .md files`);

  const id = path.basename(rel).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'docs';
  writeJson(path.join(root, rel, BUCKET_FILE), { id, description: `Docs in ${rel}.`, always: [], docs });
  const createdConfig = !existsSync(path.join(root, CONFIG));
  if (createdConfig) {
    mkdirSync(path.join(root, path.dirname(CONFIG)), { recursive: true });
    writeJson(path.join(root, CONFIG), { buckets: [rel] });
  }
  return { dir: rel, docs: Object.keys(docs).length, createdConfig };
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

// `base` and `rel` are POSIX-style paths relative to `root`; returns the joined relative path, or null if it escapes,
// either as text or through a symlink.
function insidePath(root, base, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\\')) return null;
  const joined = path.posix.normalize(path.posix.join(base || '.', rel)).replace(/\/$/, '');
  if (joined === '.' || joined.startsWith('../') || joined === '..') return null;
  if (base && !joined.startsWith(`${base}/`)) return null;
  // path.relative uses the platform separator, "\" on Windows; `rel` cannot hold one, so mapping it back is safe.
  if (path.relative(root, path.join(root, joined)).replaceAll('\\', '/') !== joined) return null;
  return linksOutside(root, joined, base) ? null : joined;
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

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
