// File and JSON helpers for every module that reads the project: config.mjs, project.mjs, knowledge.mjs, and the
// commands. Paths are relative to `root` where a function takes one. No dependencies: this file runs from the installed
// plugin, which has no node_modules.

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

// The largest JSON file readJson reads.
const JSON_CAP = 16 * 1024 * 1024;

// The parsed JSON object at `rel`, or null with the reason added to `errors`. `scope` names `root` in that reason. The
// file is read from one open that never waits, as on a FIFO, checked as a regular file through that open (readOnce): a
// session may swap the file between a check by path and a read by path.
export function readJson(root, rel, errors, scope = 'the project') {
  const file = path.join(root, rel);
  if (linksOutside(root, rel)) {
    errors.push(isFile(file) ? `${rel}: links outside ${scope}` : `${rel}: not found`);
    return null;
  }
  const read = readOnce(file, JSON_CAP);
  if (read.text === undefined) {
    errors.push(read.missing ? `${rel}: not found` : `${rel}: ${read.problem}`);
    return null;
  }
  try {
    const value = JSON.parse(read.text);
    if (isObject(value)) return value;
    errors.push(`${rel}: must be a JSON object`);
  } catch (error) {
    errors.push(`${rel}: invalid JSON (${error.message})`);
  }
  return null;
}

// The text of `file`, following a link as a plain read does, from one open that never waits, checked as a regular file
// of at most `cap` bytes through that open: { text }, { missing: true } when nothing, or no regular file, is there, or
// { problem }. Every hook read of a file under a folder a session may write goes through it or readSmallJson.
export function readOnce(file, cap = JSON_CAP) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { missing: true } : { problem: `cannot be read (${error.code ?? 'no code'})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { missing: true };
    if (stat.size > cap) return { problem: `is larger than ${cap} bytes` };
    // A file that reports no size, as one of /proc, is read to its end, up to the cap.
    const buffer = Buffer.alloc(stat.size > 0 ? stat.size : Math.min(cap, 64 * 1024));
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, null);
      if (got === 0) break;
      read += got;
    }
    return { text: buffer.subarray(0, read).toString('utf8') };
  } catch (error) {
    return { problem: `cannot be read (${error.code ?? 'no code'})` };
  } finally {
    closeSync(fd);
  }
}

// True when `rel`, with symlinks resolved, lies outside the folder `within` (both relative to `root`; `within` is the
// project when empty). A path that does not exist yet is judged where a write would create it: below its nearest
// existing folder, with that folder's symlinks resolved. A broken symlink on the way counts as outside.
export function linksOutside(root, rel, within = '') {
  const real = resolvedPath(path.join(root, rel));
  const realWithin = resolvedPath(path.join(root, within));
  return real === null || realWithin === null || !isWithin(realWithin, real);
}

// A path as a disk that folds case compares it: in lower case on macOS and Windows, as it is elsewhere. A real path keeps
// the letter case it was spelled in, so two spellings of one file compare equal only folded.
const FOLDS = process.platform === 'darwin' || process.platform === 'win32';
export const foldCase = (file) => (FOLDS ? file.toLowerCase() : file);

// Whether `file` is the folder `dir` or lies below it, by the paths as given: neither is resolved through symlinks.
export function isWithin(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// `file` with every symlink resolved: the real path of its nearest existing part, then the parts that do not exist yet.
// Null when that part is a broken symlink, whose target a write would create.
export function resolvedPath(file) {
  const tail = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      if (isEntry(current) || path.dirname(current) === current) return null;
      tail.unshift(path.basename(current));
    }
  }
}

// `base` and `rel` joined as POSIX-style relative paths, or null when the text escapes `base`. It reads no disk, so it
// also checks a path in a tree that is not checked out, such as a base branch read through GitHub.
export function joinedInside(base, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\\')) return null;
  const joined = path.posix.normalize(path.posix.join(base || '.', rel)).replace(/\/$/, '');
  if (joined === '.' || joined.startsWith('../') || joined === '..') return null;
  if (base && !joined.startsWith(`${base}/`)) return null;
  return joined;
}

// `base` and `rel` are POSIX-style paths relative to `root`; returns the joined relative path, or null if it escapes,
// either as text or through a symlink.
export function insidePath(root, base, rel) {
  const joined = joinedInside(base, rel);
  if (joined === null) return null;
  // path.relative uses the platform separator, "\" on Windows; `rel` cannot hold one, so mapping it back is safe.
  if (path.relative(root, path.join(root, joined)).replaceAll('\\', '/') !== joined) return null;
  return linksOutside(root, joined, base) ? null : joined;
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The size of `file` in bytes, or null when it is not a file.
export function fileBytes(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Whether `file` is there at all, a broken symlink included.
export function isEntry(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// Blocks this thread for `ms` milliseconds, at least 0: a pause between reads in code that runs synchronously, such as a
// lock's poll, a host listing's retry, or a project run's wait.
export const pauseSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
};

// The JSON objects of the last `bytes` of the regular file `file`, one a whole line, in order, read without following a
// link: a line cut at the start of the read, or that is no JSON object, is left out. null when it cannot be read.
export function tailObjects(file, bytes) {
  let fd;
  let text;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(stat.size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return text.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return isObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A glob as a regular expression over a `/`-separated relative path: `*` matches within one path segment, `**` across
// segments, and `**/` also matches no folder at all.
export function globPattern(glob) {
  let body = '';
  for (const part of glob.split(/(\*\*\/|\*\*|\*)/u)) {
    if (part === '**/') body += '(?:.*/)?';
    else if (part === '**') body += '.*';
    else if (part === '*') body += '[^/]*';
    else body += part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${body}$`, 'u');
}

// A glob target's parts: { head, pattern, folders }. `head` is its folder as written, `pattern` matches the path part
// right below it, and `folders` are `head` from each of `dirs`. `flags` adds to the pattern's, such as `i` on a disk
// that folds case. The pattern reads `*`, `?`, and a `[...]` class, `[!...]` or `[^...]` negated, with a `]` right after
// the opening as a member, as the shell does. A class it does not model, such as `[[:alpha:]]`, or cannot compile, such
// as the reversed range `[z-a]`, matches any one character: a guard that reads a glob, such as lib/config-guard.mjs
// and lib/handoff-guard.mjs, fails closed. It never throws. A command gives the glob, so `pattern` is no regular
// expression, which may take time exponential in its stars (globMatcher).
export function globParts(text, dirs = [], flags = '') {
  const parts = text.replace(/\/+$/u, '').split('/');
  const last = parts.pop();
  const head = parts.join('/') || (text.startsWith('/') ? '/' : '.');
  return { head, pattern: globMatcher(last, flags), folders: path.isAbsolute(head) ? [head] : dirs.map((dir) => path.resolve(dir, head)) };
}

// Whether glob path parts reach the path parts `reached`, from the same folder: each glob part matches the one at its
// depth (`matches`), and a part that is only stars, as zsh's `**`, matches any number of parts, none included. A glob that
// ends first names a folder that holds the path; `below` says whether one that goes on past the path's last part reaches
// it too, as a write into a folder does. It fills a table row by row and never recurses, so a glob of any number of parts
// costs its parts times the path's, and no command can run it out of stack.
export function partsReach(glob, reached, matches, below) {
  const many = glob.map((part) => /^\*{2,}$/u.test(part));
  let next = new Array(reached.length + 1).fill(true);
  for (let g = glob.length - 1; g >= 0; g -= 1) {
    const row = new Array(reached.length + 1);
    row[reached.length] = below || (many[g] && next[reached.length]);
    for (let r = reached.length - 1; r >= 0; r -= 1) row[r] = many[g] ? next[r] || row[r + 1] : next[r + 1] && matches(glob[g], reached[r]);
    next = row;
  }
  return next[0];
}

const STAR = Symbol('star');

// One glob path part as { test(name) }: `*` matches any run of characters, `?` and a class one each, and the rest itself.
// A run of `*` folds into one, and a failed match goes back only to the last `*` it passed, so a test takes at most the
// part's length times the name's in steps, whatever the part holds. A name shorter than the characters the part needs
// fails at once, so a test takes at most about twice the name's length squared in steps, however long the part.
// Each token keeps what it answered for each character, so its regular expression runs once a character.
// `flags` holds `i` to fold case.
function globMatcher(part, flags) {
  const tokens = [];
  const one = (source) => {
    let pattern;
    const known = new Map();
    return (char) => {
      if (!known.has(char)) {
        pattern ??= new RegExp(`^${source}$`, `u${flags}`);
        known.set(char, pattern.test(char));
      }
      return known.get(char);
    };
  };
  for (let i = 0; i < part.length; i += 1) {
    const close = part[i] === '[' ? classEnd(part, i) : -1;
    if (part[i] === '*') {
      if (tokens.at(-1) !== STAR) tokens.push(STAR);
    } else if (part[i] === '?') tokens.push(one('.'));
    else if (close !== -1) {
      tokens.push(one(classSource(part.slice(i + 1, close))));
      i = close;
    } else {
      const char = String.fromCodePoint(part.codePointAt(i));
      tokens.push(flags.includes('i') ? one(char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')) : (each) => each === char);
      i += char.length - 1;
    }
  }
  const needs = tokens.filter((token) => token !== STAR).length;
  const tail = tokens.includes(STAR) ? tokens.length - 1 - tokens.lastIndexOf(STAR) : 0;
  return {
    test: (name) => {
      const chars = Array.from(String(name));
      if (chars.length < needs) return false;
      // The tokens after the last `*` match the name's end one for one, and the ones before the first its start, which
      // matchTokens tries first: most names that fail, fail at one end at once.
      for (let i = 1; i <= tail; i += 1) if (!tokens[tokens.length - i](chars[chars.length - i])) return false;
      return matchTokens(tokens, chars);
    },
  };
}

// Whether `chars` match `tokens` whole: at a mismatch, the last `*` passed takes one more character, and none before it
// needs to change, since a `*` matches any run.
function matchTokens(tokens, chars) {
  let t = 0;
  let c = 0;
  let star = -1;
  let taken = 0;
  while (c < chars.length) {
    if (tokens[t] === STAR) {
      star = t;
      taken = c;
      t += 1;
    } else if (t < tokens.length && tokens[t](chars[c])) {
      t += 1;
      c += 1;
    } else if (star !== -1) {
      t = star + 1;
      taken += 1;
      c = taken;
    } else return false;
  }
  while (tokens[t] === STAR) t += 1;
  return t === tokens.length;
}

// The index of the `]` that closes the class opened at `start`, or -1 when none does and the `[` is a plain character.
// A `[:name:]`, `[.x.]`, or `[=x=]` inside the class holds a `]` that does not close it.
function classEnd(part, start) {
  let i = start + 1;
  if (part[i] === '!' || part[i] === '^') i += 1;
  if (part[i] === ']') i += 1;
  for (; i < part.length; i += 1) {
    if (part[i] === ']') return i;
    const inner = part[i] === '[' && ':.='.includes(part[i + 1] ?? 'x') ? part.indexOf(`${part[i + 1]}]`, i + 2) : -1;
    if (inner !== -1) i = inner + 1;
  }
  return -1;
}

// A class's body as a regular expression class, or `.` for a body it does not model or cannot compile.
function classSource(body) {
  if (/\[[:.=]/u.test(body)) return '.';
  const negated = body[0] === '!' || body[0] === '^';
  const members = (negated ? body.slice(1) : body).replace(/[\\\][^]/gu, '\\$&');
  const source = `[${negated ? '^' : ''}${members}]`;
  try {
    new RegExp(source, 'u');
    return source;
  } catch {
    return '.';
  }
}

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const OWN_FLAGS = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Makes `dir` and every folder above it that is missing, owner-only, and returns whether `dir` is then a plain folder of
// this process's user, not a link. Never throws.
export function ownFolderSync(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    const uid = processUid();
    return stat.isDirectory() && !stat.isSymbolicLink() && (!Number.isInteger(uid) || stat.uid === uid);
  } catch {
    return false;
  }
}

// Opens `file` with `flags` (and O_CREAT's `mode`), never following a link and never waiting, as on a FIFO: the file
// descriptor when it is then a regular file of this process's user with a single link, else null, with the file closed.
// A hook's counter opens its file this way, so a planted FIFO, link, or hard link neither stalls the hook nor leads its
// write elsewhere. Never throws.
export function openOwnFile(file, flags, mode = 0o600) {
  let fd;
  try {
    fd = openSync(file, flags | OWN_FLAGS, mode);
    const stat = fstatSync(fd);
    const uid = processUid();
    if (stat.isFile() && stat.nlink === 1 && (!Number.isInteger(uid) || stat.uid === uid)) return fd;
  } catch {
    // Not there, not plain, or not ours.
  }
  if (fd !== undefined) closeSync(fd);
  return null;
}

// The JSON object in the regular file `file`, of one link and at most `cap` bytes, read without following a link and
// without waiting on a FIFO, or null.
export function readSmallJson(file, cap = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | OWN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap) return null;
    const buffer = Buffer.alloc(stat.size);
    const value = JSON.parse(buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The text of this user's own regular file `file` of one link, at most `cap` bytes, read without following a link or
// waiting (openOwnFile), or null: a hook's marker in its counts folder.
export function readOwnText(file, cap = 64 * 1024) {
  const fd = openOwnFile(file, constants.O_RDONLY);
  if (fd === null) return null;
  try {
    const size = Math.min(fstatSync(fd).size, cap);
    const buffer = Buffer.alloc(size);
    return buffer.subarray(0, readSync(fd, buffer, 0, size, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Writes `text` to `file` in an owner-only folder of this user, a new file when `exclusive`, else replacing the text of
// this user's own regular file there, never following a link or waiting (ownFolderSync, openOwnFile): whether it did.
export function writeOwnText(file, text, { exclusive = false } = {}) {
  if (!ownFolderSync(path.dirname(file))) return false;
  const fd = openOwnFile(file, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : 0));
  if (fd === null) return false;
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
