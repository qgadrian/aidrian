// Claude Code's settings files as the adapter's permission answers read them (claude-code-push.mjs, claude-code-merge.mjs):
// each file as an object, the project files a session loads, and the permission rules that may reach a shell command.
// It writes nothing, reads no network, starts no process, and reads no file when loaded.

import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

const MAX_SETTINGS = 1024 * 1024;
// A worktree's `.git` file and its `commondir` hold one path each.
const MAX_POINTER = 4096;
// The entry of an auto mode list that keeps the built-in ones.
export const DEFAULTS = '$defaults';
// A settings file that is not there, as opposed to one that is there and cannot be read.
export const MISSING = Symbol('missing');
// The lists of permission rules a settings file may hold.
export const RULE_LISTS = Object.freeze(['allow', 'deny', 'ask']);
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isStrings = (value) => Array.isArray(value) && value.every((each) => typeof each === 'string');

// The text of the file, MISSING when no file is at that path, or null when one is there and cannot be read: it follows
// a symlink, and takes a regular file of at most `max` bytes. One open, whose descriptor is checked and read, so the
// file checked is the file read; a file that grew past the limit since its check reads as too large. The open does not
// block, so a named pipe at that path answers at once, as a file it cannot read.
function readText(file, max) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    for (let read = 1; read > 0 && size < buffer.length; size += read) read = readSync(fd, buffer, size, buffer.length - size, size);
    return size > max ? null : buffer.toString('utf8', 0, size);
  } catch (error) {
    return fd === undefined && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') ? MISSING : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The settings file as an object, MISSING when no file is at that path, or null when one is there and cannot be read
// as a JSON object of at most MAX_SETTINGS bytes.
export function readSettings(file) {
  const text = readText(file, MAX_SETTINGS);
  if (typeof text !== 'string') return text;
  try {
    const settings = JSON.parse(text);
    return isObject(settings) ? settings : null;
  } catch {
    return null;
  }
}

// Whether the tool-name glob `glob`, where `*` is any text, matches all of `text`. Each run between stars is found in
// order, the first at the start and the last at the end, so it never backtracks: a project's checked-in settings file
// chooses the glob.
function globMatches(glob, text) {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === text;
  const last = parts.at(-1);
  if (!text.startsWith(parts[0]) || !text.endsWith(last)) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return at <= text.length - last.length;
}

// Whether the permission rule `rule` may reach the shell command `command`, such as `git push`, in lower case; the rule is
// read in lower case with its spaces run together: it mentions the command; or its tool is the shell tool, `Bash` or a
// tool-name glob that matches it, such as `B*` or `*`, with no pattern, an empty one, or one whose text before its first
// `*`, less a final `:`, starts the command, such as `Bash(*)`, `Bash(git:*)`, or `Bash(git *)` for `git push`. It reads
// no rule the way Claude Code matches one: it only finds the rules beside which a reader gives no verdict.
export function mayReach(rule, command) {
  const text = rule.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (text.includes(command)) return true;
  const open = text.indexOf('(');
  if (!globMatches((open === -1 ? text : text.slice(0, open)).trim(), 'bash')) return false;
  if (open === -1) return true;
  const pattern = text.slice(open + 1).replace(/\)$/u, '').trim();
  const star = pattern.indexOf('*');
  return star === -1 ? pattern === '' : command.startsWith(pattern.slice(0, star).replace(/:$/u, ''));
}

// The main checkout of the worktree at `root`, whose `.git` is a file naming its git folder, from that folder's
// `commondir`: null for a checkout whose `.git` is a folder, or any pointer this cannot read.
function mainCheckout(root) {
  const pointer = readText(path.join(root, '.git'), MAX_POINTER);
  const gitdir = typeof pointer === 'string' ? /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(pointer)?.[1] : null;
  if (!gitdir) return null;
  const common = readText(path.join(path.resolve(root, gitdir), 'commondir'), MAX_POINTER);
  if (typeof common !== 'string' || common.trim() === '') return null;
  const shared = path.resolve(root, gitdir, common.trim());
  return path.basename(shared) === '.git' ? path.dirname(shared) : null;
}

// The project settings files Claude Code loads for a session in `cwd`, each from its own folder
// (code.claude.com/docs/en/settings, read on 2026-11-20): `.claude/settings.json` from `cwd` alone, the session's
// primary working directory, never from the repository root above it; `.claude/settings.local.json` from the root of
// the git repository, the nearest folder at or above `cwd` that holds `.git`, or its main checkout for a worktree, and
// from `cwd` too, where versions before 2.1.211 kept it and Claude Code still reads it, and where it stays outside a
// repository.
export function projectFiles(cwd) {
  const local = (folder) => path.join(folder, '.claude', 'settings.local.json');
  const files = [path.join(cwd, '.claude', 'settings.json'), local(cwd)];
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    if (existsSync(path.join(folder, '.git'))) return [...new Set([...files, local(mainCheckout(folder) ?? folder)])];
    if (path.dirname(folder) === folder) return files;
  }
}
