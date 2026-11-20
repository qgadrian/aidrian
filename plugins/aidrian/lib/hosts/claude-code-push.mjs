// Claude Code's answer to capabilities.pushPermission (docs/providers/claude-code.md#push-permission-in-auto-mode): whether
// its auto mode would let a session push to the repository `repository`, `host/owner/repo` in lower case. In the `auto`
// permission mode a classifier judges each action against `autoMode` in the user settings, whose `environment` lists
// the trusted repositories as prose; with no `environment`, or with "$defaults" in it, the defaults trust the working
// repository and its remotes (code.claude.com/docs/en/auto-mode-config, read on 2026-11-19 with Claude Code 2.1.328).
// The classifier ignores `autoMode` in project and local settings, so `autoMode` is read from the user file alone.
// A permission rule settles a command before the classifier does, and this file does not emulate how Claude Code
// matches one: a `permissions.deny` or `permissions.ask` rule that may reach a `git push`, or a `permissions.allow` rule
// that covers one, in the user file or the project's settings files, only makes the answer `unknown`.
// No rule answers `allowed` or `denied`. `denied` is a prediction of a prose classifier, given for one shape alone: a
// custom `environment` with no "$defaults" that names this repository in no entry, though each entry names one other
// source-control host or path, and no rule that may reach a push. Every other shape it cannot read answers `unknown`,
// and nothing here throws on one. It reads no network, starts no process, and reads no file when loaded.

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
// The project's settings files, in its `.claude` folder, whose permission rules the permission system reads.
const PROJECT_FILES = ['settings.json', 'settings.local.json'];
// The lists of permission rules a settings file may hold.
const RULE_LISTS = ['allow', 'deny', 'ask'];
// The command the run pushes with, which a rule that may reach a push mentions or starts.
const PUSH = 'git push';
// What may not touch a name on either side for it to be that name, and not part of a longer one.
const NAME_CHAR = String.raw`[\p{L}\p{N}_.-]`;
const NAME_TAIL = String.raw`[\p{L}\p{N}_-]`;
const PUSH_WORD = /(?<![\p{L}\p{N}_])push/iu;
// The last labels that make a name read as a file, not a host: `Node.js`, `README.md`, or `package-lock.json` names no
// source-control host. A name with a path, such as `tools.example.sh/acme`, or the remote's own host, still counts.
const FILE_EXTENSIONS = Object.freeze(['md', 'markdown', 'rst', 'txt', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'lock', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'css', 'html', 'xml', 'csv', 'log', 'env', 'cfg', 'conf']);
// A source-control name in an `environment` entry: an optional scheme and user, a host of dotted labels whose last is
// two or more letters, and the port and the path after it, such as `https://git.example.com/acme/widget` or
// `git@git.example.com:acme`. Group 1 is the host, group 2 what follows it. No part of it nests a quantifier in another
// that matches the same text, so it takes time linear in the entry.
const SOURCE_NAME = /(?<![\p{L}\p{N}_.\-/@:])(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[\p{L}\p{N}_.~%+-]+@)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\p{L}\p{N}_-])((?::\d+)?(?:[/:][\p{L}\p{N}_.~%+*-]+)*)/giu;
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
// whole name, which `.git` or a bracket may follow; its host and owner, such as `github.com/acme` or the scp-style
// `github.com:acme`, for the whole organisation, followed by no further name part, no `.` with one, and no `/` with one,
// so a full stop may end it and `github.com/acme/.github` names one repository, not the organisation; or its host alone,
// such as `github.com`, for every repository there, which a port may follow, but no further name part, no `.` with one,
// and no `/` or `:` with one, which would narrow it to some owner. null when `repository` is not `host/owner/repo`.
function namesRepository(repository) {
  if (typeof repository !== 'string') return null;
  const parts = repository.toLowerCase().split('/');
  if (parts.length < 3 || parts.some((part) => part === '')) return null;
  const repo = new RegExp(String.raw`(?<!${NAME_CHAR})${escape(parts.slice(1).join('/'))}(?!${NAME_TAIL})`, 'u');
  const owner = new RegExp(String.raw`(?<!${NAME_CHAR})${escape(parts[0])}[/:]${escape(parts[1])}(?!${NAME_TAIL}|\.${NAME_TAIL}|/${NAME_CHAR})`, 'u');
  const host = new RegExp(String.raw`(?<!${NAME_CHAR})${escape(parts[0])}(?::\d+)?(?!${NAME_TAIL}|\.${NAME_TAIL}|[/:]${NAME_CHAR})`, 'u');
  return (entry) => [repo, owner, host].some((each) => each.test(entry.toLowerCase()));
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

// Whether the permission rule `rule` may reach a `git push`, read in lower case with its spaces run together: it mentions
// `git push`; or its tool is the shell tool, `Bash` or a tool-name glob that matches it, such as `B*` or `*`, with no
// pattern, an empty one, or one whose text before its first `*`, less a final `:`, starts `git push`, such as
// `Bash(*)`, `Bash(git:*)`, or `Bash(git *)`. It reads no rule the way Claude Code matches one: it only finds the rules
// beside which this file gives no verdict.
function mayReachPush(rule) {
  const text = rule.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (text.includes(PUSH)) return true;
  const open = text.indexOf('(');
  if (!globMatches((open === -1 ? text : text.slice(0, open)).trim(), 'bash')) return false;
  if (open === -1) return true;
  const pattern = text.slice(open + 1).replace(/\)$/u, '').trim();
  const star = pattern.indexOf('*');
  return star === -1 ? pattern === '' : PUSH.startsWith(pattern.slice(0, star).replace(/:$/u, ''));
}

// Whether the allow rule `rule`, read as mayReachPush reads one, covers a push to `origin`, the remote the push preflight
// reads: `Bash(git push)`, `Bash(git push:*)`, `Bash(git push *)`, or `Bash(git push origin` with any rest after a word
// boundary. On entering auto mode Claude Code drops broad allow rules, such as `Bash(*)`
// (code.claude.com/docs/en/permission-modes, read on 2026-11-20), so a whole-tool allow, such as `Bash`, `*`, `B*`, or
// `Bash(git:*)`, does not stand a verdict aside. A deny or an ask rule still does whenever it may reach a push.
function allowsPush(rule) {
  const text = rule.trim().toLowerCase().replace(/\s+/gu, ' ');
  return /^bash ?\( ?git push(?::\*| \*| origin(?![\p{L}\p{N}_.-]).*)? ?\)$/u.test(text);
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

// Whether the settings `settings` leave no verdict to give: a file that is there and cannot be read, whose `permissions`
// is not an object, whose `allow`, `deny`, or `ask` is not a list of strings, or that holds an allow rule that covers a
// push (allowsPush), or a deny or ask rule that may reach one (mayReachPush). A file that is not there, or that sets no
// such rules, leaves one.
function standsAside(settings) {
  if (settings === MISSING) return false;
  if (settings === null) return true;
  const { permissions } = settings;
  if (permissions === undefined) return false;
  if (!isObject(permissions)) return true;
  return RULE_LISTS.some((key) => permissions[key] !== undefined
    && (!isStrings(permissions[key]) || permissions[key].some(key === 'allow' ? allowsPush : mayReachPush)));
}

// Whether the `environment` entry `entry` names exactly one source-control host or path, and nothing that could also
// cover the remote of `repository`: one SOURCE_NAME whose host is not a file name (FILE_EXTENSIONS), unless a path
// follows it or it is the remote's own host, and, outside that name, no word that is the remote host's label before its
// last, such as `github` for `github.com`, as in "our GitHub org". An entry that names none, or several, is prose no
// matcher reads.
function namesOneOther(entry, repository) {
  const own = repository.toLowerCase().split('/')[0];
  const names = [...entry.matchAll(SOURCE_NAME)].filter((match) => {
    const host = match[1].toLowerCase();
    return match[2].replace(/^:\d+/u, '') !== '' || host === own || !FILE_EXTENSIONS.includes(host.split('.').at(-1));
  });
  if (names.length !== 1) return false;
  const [name] = names;
  const rest = `${entry.slice(0, name.index)} ${entry.slice(name.index + name[0].length)}`;
  const label = own.split('.').at(-2);
  return !new RegExp(String.raw`(?<![\p{L}\p{N}_])${escape(label)}(?![\p{L}\p{N}_])`, 'iu').test(rest);
}

// What auto mode's lists in the user settings `user` say of the repository `names` tests for: 'allowed', 'denied' when a
// custom `environment` with no "$defaults" names it in no entry and every entry names one other source-control host or
// path (namesOneOther), or 'unknown' for any shape this cannot read.
function environmentTrust(user, repository, names) {
  const autoMode = isObject(user) ? user.autoMode : undefined;
  if (!isObject(autoMode)) return 'unknown';
  const { environment, allow } = autoMode;
  if (!isStrings(environment) || environment.length === 0) return 'unknown';
  if (allow !== undefined && !isStrings(allow)) return 'unknown';
  if (environment.some((entry) => entry.trim() === DEFAULTS || names(entry))) return 'allowed';
  if ((allow ?? []).some((entry) => names(entry) && PUSH_WORD.test(entry))) return 'allowed';
  // An entry that names no source-control host, or several, may trust the remote in words no matcher reads.
  return environment.every((entry) => namesOneOther(entry, repository)) ? 'denied' : 'unknown';
}

// { answer: 'allowed' | 'unknown' } or { answer: 'denied', setting, file, why, fix }, in the order of the steps of
// docs/providers/claude-code.md#push-permission-in-auto-mode. `readMode` reads the session's permission mode, which a
// test replaces; outside `auto` no classifier judges a push, and no settings file is read.
export function pushPermission({ repository, session, cwd, env = process.env, readMode = sessionMode }) {
  if (readMode({ session, cwd, env }) !== 'auto') return UNKNOWN;
  const names = namesRepository(repository);
  if (!names) return UNKNOWN;
  const file = path.join(configDir(env), 'settings.json');
  // A relative config folder would be read from wherever this process runs, and a denial could not name its file. The
  // project's settings are found from the session's folder, and one that is not absolute would be read from there too:
  // its rules unread, no answer stands.
  if (!path.isAbsolute(file) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return UNKNOWN;
  const user = readSettings(file);
  const project = projectFolders(cwd).flatMap((folder) => PROJECT_FILES.map((name) => readSettings(path.join(folder, '.claude', name))));
  if ([user, ...project].some(standsAside)) return UNKNOWN;
  const trust = environmentTrust(user, repository, names);
  if (trust !== 'denied') return trust === 'allowed' ? { answer: 'allowed' } : UNKNOWN;
  return {
    answer: 'denied',
    setting: 'autoMode.environment',
    file,
    why: `replaces the default trusted repositories, with no "${DEFAULTS}" in its list, and names this remote in no entry`,
    fix: `adds "${DEFAULTS}" to that list, or an entry such as "Trusted repo: ${repository.toLowerCase()}"`,
  };
}
