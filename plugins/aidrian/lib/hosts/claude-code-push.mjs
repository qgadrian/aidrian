// Claude Code's answer to capabilities.pushPermission (docs/providers/claude-code.md#push-permission-in-auto-mode): whether
// its auto mode would let a session push to the repository `repository`, `host/owner/repo` in lower case. In the `auto`
// permission mode a classifier judges each action against `autoMode` in the user settings, whose `environment` lists
// the trusted repositories as prose; with no `environment`, or with "$defaults" in it, the defaults trust the working
// repository and its remotes (code.claude.com/docs/en/auto-mode-config, read on 2026-11-19 with Claude Code 2.1.328).
// The classifier ignores `autoMode` in project and local settings, so only the user file is read. `denied` is a
// prediction of a prose classifier, given for one shape alone: a custom `environment` with no "$defaults" that names
// this repository in no entry. Every other shape it cannot read answers `unknown`, and nothing here throws on one.
// It reads no network, starts no process, and reads no file when loaded.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { sessionMode } from './claude-code-background.mjs';
import { configDir } from './claude-code-config.mjs';

const MAX_SETTINGS = 1024 * 1024;
const UNKNOWN = Object.freeze({ answer: 'unknown' });
const DEFAULTS = '$defaults';
// What may not touch a name on either side for it to be that name, and not part of a longer one.
const NAME_CHAR = String.raw`[\p{L}\p{N}_.-]`;
const NAME_TAIL = String.raw`[\p{L}\p{N}_-]`;
const PUSH_WORD = /(?<![\p{L}\p{N}_])push/iu;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((each) => typeof each === 'string');

// The settings file as an object, or null: it follows a symlink, and takes a regular file of at most MAX_SETTINGS bytes.
// One open, whose descriptor is checked and read, so the file checked is the file read; a file that grew past the limit
// since its check reads as too large. The open does not block, so a named pipe at that path answers at once, as no file.
function readSettings(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS) return null;
    const buffer = Buffer.alloc(MAX_SETTINGS + 1);
    let size = 0;
    for (let read = 1; read > 0 && size < buffer.length; size += read) read = readSync(fd, buffer, size, buffer.length - size, size);
    if (size > MAX_SETTINGS) return null;
    const settings = JSON.parse(buffer.toString('utf8', 0, size));
    return isObject(settings) ? settings : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A test of whether an entry names the repository, in lower case: its path after the host, such as `acme/widget`, as a
// whole name, which `.git` or a bracket may follow; or its host and owner, such as `github.com/acme`, for the whole
// organisation, followed by no further name part, no `.` with one, and no `/` with one, so a full stop may end it and
// `github.com/acme/.github` names one repository, not the organisation. null when `repository` is not `host/owner/repo`.
function namesRepository(repository) {
  if (typeof repository !== 'string') return null;
  const parts = repository.toLowerCase().split('/');
  if (parts.length < 3 || parts.some((part) => part === '')) return null;
  const repo = new RegExp(String.raw`(?<!${NAME_CHAR})${escape(parts.slice(1).join('/'))}(?!${NAME_TAIL})`, 'u');
  const owner = new RegExp(String.raw`(?<!${NAME_CHAR})${escape(`${parts[0]}/${parts[1]}`)}(?!${NAME_TAIL}|\.${NAME_TAIL}|/${NAME_CHAR})`, 'u');
  return (entry) => repo.test(entry.toLowerCase()) || owner.test(entry.toLowerCase());
}

// { answer: 'allowed' | 'unknown' } or { answer: 'denied', setting, file, why, fix }, in the order of the steps of
// docs/providers/claude-code.md#push-permission-in-auto-mode. `readMode` reads the session's permission mode, which a
// test replaces; outside `auto` no classifier judges a push, and no settings file is read.
export function pushPermission({ repository, session, cwd, env = process.env, readMode = sessionMode }) {
  if (readMode({ session, cwd, env }) !== 'auto') return UNKNOWN;
  const names = namesRepository(repository);
  if (!names) return UNKNOWN;
  const file = path.join(configDir(env), 'settings.json');
  // A relative config folder would be read from wherever this process runs, and a denial could not name its file.
  if (!path.isAbsolute(file)) return UNKNOWN;
  const autoMode = readSettings(file)?.autoMode;
  if (!isObject(autoMode)) return UNKNOWN;
  const { environment, allow } = autoMode;
  if (!isStrings(environment) || environment.length === 0) return UNKNOWN;
  if (allow !== undefined && !isStrings(allow)) return UNKNOWN;
  if (environment.some((entry) => entry.trim() === DEFAULTS || names(entry))) return { answer: 'allowed' };
  if ((allow ?? []).some((entry) => names(entry) && PUSH_WORD.test(entry))) return { answer: 'allowed' };
  return {
    answer: 'denied',
    setting: 'autoMode.environment',
    file,
    why: `replaces the default trusted repositories, with no "${DEFAULTS}" in its list, and names this remote in no entry`,
    fix: `adds "${DEFAULTS}" to that list, or an entry such as "Trusted repo: ${repository.toLowerCase()}"`,
  };
}
