// Claude Code's answer to capabilities.pushPermission (docs/providers/claude-code.md#push-permission-in-auto-mode): whether
// its auto mode would let a session push to the repository `repository`, `host/owner/repo` in lower case. In the `auto`
// permission mode a classifier judges each action against `autoMode` in the user settings, whose `environment` lists
// the trusted repositories as prose; with no `environment`, or with "$defaults" in it, the defaults trust the working
// repository and its remotes (code.claude.com/docs/en/auto-mode-config, read on 2026-11-19 with Claude Code 2.1.328).
// The classifier ignores `autoMode` in project and local settings, so `autoMode` is read from the user file alone. A
// narrow `permissions.allow` rule that allows a `git push`, such as `Bash(git push:*)`, approves the push before the
// classifier runs (code.claude.com/docs/en/permission-modes, read on 2026-11-19), so before a denial the rules of the
// user file and of the project's `.claude/settings.json` and `.claude/settings.local.json` are read too, and any such
// rule answers `unknown`. `denied` is a prediction of a prose classifier, given for one shape alone: a custom
// `environment` with no "$defaults" that names this repository in no entry, and no rule that allows a push. Every other
// shape it cannot read answers `unknown`, and nothing here throws on one. It reads no network, starts no process, and
// reads no file when loaded.

import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { sessionMode } from './claude-code-background.mjs';
import { configDir } from './claude-code-config.mjs';

const MAX_SETTINGS = 1024 * 1024;
// A worktree's `.git` file and its `commondir` hold one path each.
const MAX_POINTER = 4096;
const UNKNOWN = Object.freeze({ answer: 'unknown' });
const DEFAULTS = '$defaults';
// A settings file that is not there, as opposed to one that is there and cannot be read.
const MISSING = Symbol('missing');
// The project's settings files, in its `.claude` folder, whose `permissions.allow` the permission system reads.
const PROJECT_FILES = ['settings.json', 'settings.local.json'];
// A permission rule for the shell tool with a pattern, `Bash(<pattern>)`. Bare `Bash` allows every command, and auto
// mode drops it on entry, as it does `Bash(*)` and a pattern that starts with `*`, so none of those approves a push.
const SHELL_RULE = /^Bash\((.*)\)$/su;
// The command a rule must not allow for a denial to stand: a plain push, alone or with arguments after a space.
const PUSH = 'git push';
// What may not touch a name on either side for it to be that name, and not part of a longer one.
const NAME_CHAR = String.raw`[\p{L}\p{N}_.-]`;
const NAME_TAIL = String.raw`[\p{L}\p{N}_-]`;
const PUSH_WORD = /(?<![\p{L}\p{N}_])push/iu;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((each) => typeof each === 'string');

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
function readSettings(file) {
  const text = readText(file, MAX_SETTINGS);
  if (typeof text !== 'string') return text;
  try {
    const settings = JSON.parse(text);
    return isObject(settings) ? settings : null;
  } catch {
    return null;
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

// Whether the glob `glob`, where `*` is any text, matches all of `text`.
function matchesAll(glob, text) {
  return new RegExp(`^${glob.split('*').map(escape).join('[\\s\\S]*')}$`, 'u').test(text);
}

// Whether the glob `glob` matches some command that starts with `prefix`: its text before the first `*`, or all of it
// when it has none, starts with `prefix`, or is itself the start of `prefix` and a `*` follows it.
function matchesSomeStart(glob, prefix) {
  const star = glob.indexOf('*');
  const literal = star === -1 ? glob : glob.slice(0, star);
  return literal.startsWith(prefix) || (star !== -1 && prefix.startsWith(literal));
}

// Whether the permission rule `rule` allows a plain `git push`, or one with arguments, in auto mode: `Bash(git push)`
// that command alone, `Bash(git push *)` and `Bash(git *)` the commands that match the glob, a trailing ` *` the
// command before it too, and a pattern ending in `:*`, as in `Bash(git push:*)`, the same as one ending in ` *`. Any
// pattern that could match such a push counts, a remote or branch it names included, since a remote's name in a command
// says nothing of the repository it points to. A pattern that is empty or starts with `*` is one auto mode drops.
function allowsPush(rule) {
  const shell = SHELL_RULE.exec(rule.trim());
  if (!shell) return false;
  const pattern = shell[1].trim();
  if (pattern === '' || pattern.startsWith('*')) return false;
  const globs = pattern.endsWith(':*') ? [`${pattern.slice(0, -2)} *`] : [pattern];
  return globs.some((glob) => matchesAll(glob, PUSH) || matchesSomeStart(glob, `${PUSH} `));
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

// The folders whose `.claude` settings may be the project's for a session in `cwd`. Claude Code reads
// `.claude/settings.json` in `cwd`, and `.claude/settings.local.json` at the root of the git repository, the main
// checkout's for a worktree (code.claude.com/docs/en/permissions, read on 2026-11-19). Both files are read in each of
// `cwd`, the nearest folder at or above it that holds `.git`, and that worktree's main checkout: reading a file the host
// does not can only turn a denial into `unknown`.
function projectFolders(cwd) {
  const folders = [cwd];
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    if (existsSync(path.join(folder, '.git'))) {
      folders.push(folder);
      const main = mainCheckout(folder);
      if (main) folders.push(main);
      return [...new Set(folders)];
    }
    if (path.dirname(folder) === folder) return folders;
  }
}

// Whether a `permissions.allow` rule in `settings` allows a push, or null when `permissions` or its `allow` has a shape
// this cannot read. A file that is not there holds no rule.
function allowRulesPush(settings) {
  if (settings === MISSING) return false;
  if (settings === null) return null;
  const { permissions } = settings;
  if (permissions === undefined) return false;
  if (!isObject(permissions)) return null;
  if (permissions.allow === undefined) return false;
  if (!isStrings(permissions.allow)) return null;
  return permissions.allow.some(allowsPush);
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
  const user = readSettings(file);
  const autoMode = isObject(user) ? user.autoMode : undefined;
  if (!isObject(autoMode)) return UNKNOWN;
  const { environment, allow } = autoMode;
  if (!isStrings(environment) || environment.length === 0) return UNKNOWN;
  if (allow !== undefined && !isStrings(allow)) return UNKNOWN;
  if (environment.some((entry) => entry.trim() === DEFAULTS || names(entry))) return { answer: 'allowed' };
  if ((allow ?? []).some((entry) => names(entry) && PUSH_WORD.test(entry))) return { answer: 'allowed' };
  // The project's settings are found from the session's folder; one that is not absolute would be read from wherever
  // this process runs.
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return UNKNOWN;
  const files = projectFolders(cwd).flatMap((folder) => PROJECT_FILES.map((name) => path.join(folder, '.claude', name)));
  if ([user, ...files.map(readSettings)].some((settings) => allowRulesPush(settings) !== false)) return UNKNOWN;
  return {
    answer: 'denied',
    setting: 'autoMode.environment',
    file,
    why: `replaces the default trusted repositories, with no "${DEFAULTS}" in its list, and names this remote in no entry`,
    fix: `adds "${DEFAULTS}" to that list, or an entry such as "Trusted repo: ${repository.toLowerCase()}"`,
  };
}
