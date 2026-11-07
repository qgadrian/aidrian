// Checking one citation against the repository and the plan, and the text helpers every quorum check prints with.
// `check` runs no command but `git ls-files`, and never executes what a citation names.

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { insidePath, isFile, linksOutside } from '../fs.mjs';
import { runGit } from '../git.mjs';
import { anchor as anchorOf, sectionOf, slug } from '../review/flows.mjs';
import { CITATION_KINDS, MAX_QUOTE } from './plan-schema.mjs';

// The variables that change how git reads a pathspec. `check` passes --literal-pathspecs, which git refuses beside any
// of the others, so its one `git ls-files` call runs without them.
const PATHSPEC_VARS = Object.freeze(['GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS']);

// Whitespace runs as one space, ends trimmed: a quote matches across line breaks and indentation.
export const collapse = (text) => String(text).replace(/\s+/gu, ' ').trim();

// A control character, which no ref path holds; `shown` prints one as \uXXXX, so a NUL in a ref never reaches the output.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const shown = (text) => String(text).replace(new RegExp(CONTROL.source, 'gu'), (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// A citation's ref path that leaves the repository root: `..`, an absolute path, or a symlink out. checkLedger counts
// it as one failed citation and warns: the outside file is never read, so failing the whole ledger would protect nothing.
class Escape extends Error {}

// Why one citation fails, or null when it passes. Throws Escape when its ref path leaves `root`.
// `ctx` is { root, plan (the plan text), env (for git), read(file) → text or null }.
export function citationProblem(citation, ctx) {
  const quote = collapse(citation.quote);
  if (!quote) return 'the quote is empty';
  if (quote.length > MAX_QUOTE) return `the quote is ${quote.length} characters, more than ${MAX_QUOTE}`;
  const { kind, ref } = citation;
  if (!CITATION_KINDS.includes(kind)) return `"${kind}" is not a citation kind`;
  const place = refParts(citation);
  if (place.problem) return place.problem;
  if (kind === 'plan') return inSection(ctx.plan, place.anchor, quote, 'the plan');
  const file = inside(ctx.root, place.path, ref, kind === 'absence');
  if (file.problem) return file.problem;
  if (kind === 'doc' || kind === 'adr') {
    const text = ctx.read(file.path);
    return text === null ? `${file.path} is missing` : inSection(text, place.anchor, quote, file.path);
  }
  if (kind === 'code') {
    const text = ctx.read(file.path);
    if (text === null) return `${file.path} is missing`;
    // The line is advisory: lines drift, so the quote may be anywhere in the file.
    return collapse(text).includes(quote) ? null : `${file.path} does not contain the quote`;
  }
  // absence: tracked files only, so a needle in an ignored or untracked file is not in the project.
  const env = { ...ctx.env };
  for (const key of PATHSPEC_VARS) delete env[key];
  const listed = runGit(['--literal-pathspecs', 'ls-files', '-z', '--', file.path], ctx.root, { timeout: 30_000, env, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) {
    // git's exit code (or why it never ran) and its last stderr line, so a sandbox or a broken git is named, not guessed.
    const exit = listed.status ?? listed.error?.code ?? listed.signal;
    const last = shown(String(listed.stderr ?? '').trim().split('\n').at(-1).trim()).slice(0, MAX_QUOTE);
    return `git ls-files failed on ${file.path} (exit ${exit}${last ? `: ${last}` : ''})`;
  }
  const files = listed.stdout.split('\0').filter(Boolean);
  if (!files.length) return `git tracks no file under ${file.path}`;
  const hit = files.find((each) => {
    const text = readRegular(ctx.root, each);
    return text !== null && collapse(text).includes(quote);
  });
  return hit ? `${hit} contains the quote` : null;
}

// The parts of a citation's ref by its kind: { path, anchor } (anchor slugged; path as written), or { problem }.
function refParts({ kind, ref }) {
  if (kind === 'plan') {
    if (!ref.startsWith('#')) return { problem: `"${ref}" is not #anchor` };
    return ref.length > 1 ? { path: null, anchor: ref.slice(1) } : { problem: 'the plan: the anchor is empty' };
  }
  if (kind === 'doc' || kind === 'adr') {
    const at = ref.indexOf('#');
    if (at === -1) return { problem: `"${ref}" is not path#anchor` };
    if (at === ref.length - 1) return { problem: `"${ref}": the anchor is empty` };
    return { path: ref.slice(0, at), anchor: ref.slice(at + 1) };
  }
  if (kind === 'code') {
    const place = /^(.*?):(\d+)(?:-\d+)?$/u.exec(ref);
    return place ? { path: place[1], anchor: null } : { problem: `"${ref}" is not path:line` };
  }
  return { path: ref, anchor: null };
}

// `rel`, a path relative to the root, as { path } inside it, or { problem } when it is not a relative path: empty, with
// an empty part (`a//b`), a backslash, or a control character (a NUL would crash the git and file calls). Throws Escape
// when it leaves the root, as text (`..`, an absolute path) or through a symlink. `folder` allows `.`, the whole repository.
function inside(root, rel, ref, folder = false) {
  const notRelative = { problem: `"${shown(ref)}" is not a relative path` };
  if (CONTROL.test(rel)) return notRelative;
  if (path.isAbsolute(rel)) throw new Escape(`${rel} is outside the repository root`);
  if (rel.includes('\\') || rel.replace(/\/+$/u, '').split('/').includes('')) return notRelative;
  const normal = path.posix.normalize(rel).replace(/\/+$/u, '');
  if (normal === '..' || normal.startsWith('../')) throw new Escape(`${rel} is outside the repository root`);
  if (normal === '.') return folder ? { path: '.' } : notRelative;
  const joined = insidePath(root, '', normal);
  if (joined === null) throw new Escape(`${rel} is outside the repository root`);
  return { path: joined };
}

// A tracked file's text, when it is a regular file inside the root; null for a symlink, a folder (a submodule), or
// anything else, so a link cannot bring an outside file's text into the check.
function readRegular(root, file) {
  try {
    if (!lstatSync(path.join(root, file)).isFile() || linksOutside(root, file)) return null;
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

// Why `quote` is not in the section of `text` under `anchor`, matched by heading text or slug; null when it is.
function inSection(text, anchor, quote, name) {
  const section = sectionOf(text, anchor);
  if (!section) return `${name} has no heading #${anchor}`;
  return collapse(`${section.heading}\n${section.body}`).includes(quote) ? null : `${name}#${anchorOf(section.heading)} does not contain the quote`;
}

// The identity of a citation, for telling whether a rebuttal cites anything new: kind, the normalized path, the
// slugged anchor, and the collapsed quote. The line of a `code` ref is not part of it, since lines drift.
function citationKey(citation) {
  const place = refParts(citation);
  if (place.problem) return `${citation.kind}\0${citation.ref}\0${collapse(citation.quote)}`;
  const file = place.path === null ? '' : path.posix.normalize(place.path).replace(/\/+$/u, '').replace(/^\.\//u, '');
  return [citation.kind, file, place.anchor === null ? '' : slug(place.anchor), collapse(citation.quote)].join('\0');
}

// The citations of `list` that pass, naming each that fails in `problems`, and each ref path outside the root in
// `escapes` as well.
function passing(list, where, ctx, problems, escapes) {
  return list.filter((citation, i) => {
    try {
      const problem = citationProblem(citation, ctx);
      // The whole line goes through `shown`: a problem built from a malformed ref (`is not path:line`) quotes it raw.
      if (problem) problems.push(shown(`${where}.citations[${i}] (${citation.kind} ${citation.ref}): ${problem}`));
      return problem === null;
    } catch (error) {
      if (!(error instanceof Escape)) throw error;
      problems.push(shown(`${where}.citations[${i}] (${citation.kind} ${citation.ref}): ${error.message}`));
      escapes.push(`${where}.citations[${i}]: ${error.message}, not read`);
      return false;
    }
  });
}

// Reads a file under the root, or null when it is missing or not a regular file: a FIFO or a device would hang the read.
const reader = (root) => (file) => {
  try {
    if (!isFile(path.join(root, file))) return null;
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
};

export { citationKey, passing, reader, refParts, shown };
