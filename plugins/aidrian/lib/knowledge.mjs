// Reads and checks a project's knowledge buckets. The format is described in docs/knowledge.md.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG, isFile, linksOutside, loadConfig, readJson } from './config.mjs';

const BUCKET_FILE = 'bucket.json';
const BUCKET_ID = /^[a-z0-9][a-z0-9-]*$/;
const TAG = /^[a-z][a-z0-9_]*$/;

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
  checkKeys(raw, ['id', 'description', 'always', 'tags'], file, errors);

  if (typeof raw.id !== 'string' || !BUCKET_ID.test(raw.id)) {
    errors.push(`${file}: "id" must be lowercase letters, digits and "-"`);
  }
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    errors.push(`${file}: "description" must say what the bucket covers`);
  }

  const always = docList(root, dir, raw.always ?? [], `${file}: "always"`, errors);
  const tags = {};
  if (raw.tags !== undefined && (typeof raw.tags !== 'object' || raw.tags === null || Array.isArray(raw.tags))) {
    errors.push(`${file}: "tags" must map each tag to a list of docs`);
  } else {
    for (const [tag, docs] of Object.entries(raw.tags ?? {})) {
      if (!TAG.test(tag) || tag === 'always') {
        errors.push(`${file}: tag "${tag}" must be snake_case and not "always"`);
        continue;
      }
      tags[tag] = docList(root, dir, docs, `${file}: tag "${tag}"`, errors);
      if (tags[tag].length === 0) errors.push(`${file}: tag "${tag}" lists no docs`);
    }
  }

  const routed = new Set([...always, ...Object.values(tags).flat()]);
  if (routed.size === 0) errors.push(`${file}: lists no docs in "always" or "tags"`);
  for (const doc of markdownFiles(root, dir)) {
    if (doc !== `${dir}/README.md` && !routed.has(doc)) {
      errors.push(`${doc}: no tag loads this doc; add it to "always" or a tag in ${file}, or delete it`);
    }
  }

  return { id: raw.id, dir, description: raw.description, always, tags };
}

function docList(root, dir, docs, where, errors) {
  if (!Array.isArray(docs)) {
    errors.push(`${where} must be a list of doc paths`);
    return [];
  }
  const out = [];
  for (const doc of docs) {
    const rel = insidePath(root, dir, doc);
    if (!rel || !rel.endsWith('.md')) {
      errors.push(`${where}: ${JSON.stringify(doc)} must be a relative .md path inside the bucket`);
    } else if (!isFile(path.join(root, rel))) {
      errors.push(`${where}: ${rel} does not exist`);
    } else if (out.includes(rel)) {
      errors.push(`${where}: ${rel} is listed twice`);
    } else {
      out.push(rel);
    }
  }
  return out;
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
