// Claude Code's answer to capabilities.pushPermission (docs/providers/claude-code.md#push-permission-in-auto-mode): whether
// its auto mode would let a session push to the repository `repository`, `host/owner/repo` in lower case. In the `auto`
// permission mode a classifier judges each action against `autoMode` in the user settings, whose `environment` lists
// the trusted repositories as prose; with no `environment`, or with "$defaults" in it, the defaults trust the working
// repository and its remotes (code.claude.com/docs/en/auto-mode-config, read on 2026-11-19 with Claude Code 2.1.328).
// The classifier ignores `autoMode` in project and local settings, so `autoMode` is read from the user file alone. First
// of all, a `permissions.deny` rule that matches the push the run makes refuses it, and a `permissions.ask` rule asks
// before it, with no one there to answer in a run no Human attends: either answers `denied`, naming the rule, whatever
// else the files say. A narrow `permissions.allow` rule that allows a `git push`, such as `Bash(git push:*)`, approves the push before the
// classifier runs (code.claude.com/docs/en/permission-modes, read on 2026-11-19), so the rules of the user file and of
// the project's `.claude/settings.json` and `.claude/settings.local.json` are read too: one that allows the push the run
// makes answers `allowed`, and one for a narrower push, which may be that push, leaves `unknown` where the answer would
// be `denied`. `denied` is a prediction of a prose classifier, given for one shape alone: a custom `environment` with no
// "$defaults" that names this repository in no entry, and no rule that may allow a push, or a deny or ask rule that
// matches the push. Every other shape it cannot read answers `unknown`, and nothing here throws on one. It reads no network, starts no process, and
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
// The remote the push preflight judges (docs/handoff.md#the-push-preflight), by the name a command gives it.
const REMOTE = 'origin';
// A character no command holds, which only a `*` of a glob matches (matchesAnyAfter).
const MARK = '\u0000';
// What may not touch a name on either side for it to be that name, and not part of a longer one.
const NAME_CHAR = String.raw`[\p{L}\p{N}_.-]`;
const NAME_TAIL = String.raw`[\p{L}\p{N}_-]`;
const PUSH_WORD = /(?<![\p{L}\p{N}_])push/iu;
// A host name, such as `git.example.com`: labels of letters, digits, and `-`, joined by dots, the last of two or more
// letters, with no name part on either side. An `environment` entry that holds none is prose no matcher reads.
const HOST_NAME = /(?<![\p{L}\p{N}_.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![\p{L}\p{N}_-])/iu;

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

// Whether the glob `glob`, where `*` is any text, matches all of `text`, compared by code point. It goes back only to
// the last `*` it passed, so it takes at most the product of the two lengths. A regex with a `[\s\S]*` for each star
// backtracks exponentially, and a project's checked-in settings file chooses the glob.
function matchesAll(glob, text) {
  const pattern = [...glob];
  const chars = [...text];
  let at = 0;
  let next = 0;
  let star = -1;
  let resume = 0;
  while (next < chars.length) {
    if (pattern[at] === '*') {
      star = at;
      at += 1;
      resume = next;
    } else if (at < pattern.length && pattern[at] === chars[next]) {
      at += 1;
      next += 1;
    } else if (star !== -1) {
      at = star + 1;
      resume += 1;
      next = resume;
    } else {
      return false;
    }
  }
  while (pattern[at] === '*') at += 1;
  return at === pattern.length;
}

// Whether the glob `glob` matches some command that starts with `prefix`: its text before the first `*`, or all of it
// when it has none, starts with `prefix`, or is itself the start of `prefix` and a `*` follows it.
function matchesSomeStart(glob, prefix) {
  const star = glob.indexOf('*');
  const literal = star === -1 ? glob : glob.slice(0, star);
  return literal.startsWith(prefix) || (star !== -1 && prefix.startsWith(literal));
}

// Whether the glob `glob` matches `prefix` followed by any text at all. It is tried on `prefix` and one character the
// glob does not hold: only a `*` can match that character, and only a `*` with nothing but `*` after it, which then
// matches any text in its place.
function matchesAnyAfter(glob, prefix) {
  const mark = [MARK, '\u0001'].find((each) => !glob.includes(each));
  return mark !== undefined && matchesAll(glob, `${prefix}${mark}`);
}

// The globs the permission rule `rule` matches a shell command by, from `Bash(<pattern>)`: the pattern, where a final
// `:*` is a trailing ` *`, and, for a trailing ` *`, the command before it too. None for any other rule or an empty
// pattern. Bare `Bash` matches every command; in `permissions.allow` (`allow`), auto mode drops it on entry, as it does
// `Bash(*)` and a pattern that starts with `*`, so none of those allows anything there.
function shellGlobs(rule, { allow }) {
  const trimmed = rule.trim();
  if (trimmed === 'Bash') return allow ? [] : ['*'];
  const shell = SHELL_RULE.exec(trimmed);
  if (!shell) return [];
  const pattern = shell[1].trim();
  if (pattern === '' || (allow && pattern.startsWith('*'))) return [];
  const glob = pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern;
  return glob.endsWith(' *') ? [glob, glob.slice(0, -2)] : [glob];
}

// Whether the globs `globs` match the push the run makes: a plain `git push`, for any remote, or `git push origin` with
// any branch after it. `Bash(git push:*)`, `Bash(git push)`, `Bash(git *)`, and `Bash(git push origin:*)` do;
// `Bash(git push origin main)`, `Bash(git push upstream:*)`, and `Bash(git push --force:*)` do not, since the run may
// make another push.
const coversPush = (globs) => globs.some((glob) => matchesAll(glob, PUSH) || matchesAnyAfter(glob, `${PUSH} ${REMOTE} `));

// Whether the globs `globs` could match some `git push`, alone or with arguments, a remote or branch it names included:
// `Bash(git push origin main)` does, and `Bash(git status)`, `Bash(git pushall)`, and `Bash(git:* push)` do not.
const mayPush = (globs) => globs.some((glob) => matchesAll(glob, PUSH) || matchesSomeStart(glob, `${PUSH} `));

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

// The rules in `permissions[key]` of `settings`: none for a file that is not there, or that sets no such rules, and null
// when `permissions` or its `key` has a shape this cannot read.
function permissionRules(settings, key) {
  if (settings === MISSING) return [];
  if (settings === null) return null;
  const { permissions } = settings;
  if (permissions === undefined) return [];
  if (!isObject(permissions)) return null;
  if (permissions[key] === undefined) return [];
  return isStrings(permissions[key]) ? permissions[key] : null;
}

// The longest rule a denial quotes; a longer one, or one with any character but printable ASCII, is named without it.
const MAX_QUOTED = 200;
const quoted = (rule) => (rule.trim().length <= MAX_QUOTED && /^[\x20-\x7e]+$/u.test(rule.trim()) ? `the rule \`${rule.trim()}\`` : 'a rule');

// The denial of the first `permissions.deny` rule, then the first `permissions.ask` rule, in `sources`, that matches the
// push the run makes, or null when none does. A deny rule refuses a matching command in every permission mode, and an
// ask rule asks before it, which a run no Human attends has no one to answer; both come before any allow rule and before
// auto mode's classifier (code.claude.com/docs/en/permissions, read on 2026-11-20). A file whose rules cannot be read
// holds no rule here.
function refusal(sources) {
  for (const [key, does] of [['deny', 'refuses that push'], ['ask', 'asks before that push, and a run no Human attends has no one to answer']]) {
    for (const { file, settings } of sources) {
      const rule = permissionRules(settings, key)?.find((each) => coversPush(shellGlobs(each, { allow: false })));
      if (rule === undefined) continue;
      return {
        answer: 'denied',
        setting: `permissions.${key}`,
        file,
        why: `holds ${quoted(rule)}, which ${does}`,
        fix: `removes that rule, or narrows it so that it matches no push to ${REMOTE}`,
      };
    }
  }
  return null;
}

// What auto mode's lists in the user settings `user` say of the repository `names` tests for: 'allowed', 'denied' when a
// custom `environment` with no "$defaults" names it in no entry and every entry names some host, or 'unknown' for any
// shape this cannot read.
function environmentTrust(user, names) {
  const autoMode = isObject(user) ? user.autoMode : undefined;
  if (!isObject(autoMode)) return 'unknown';
  const { environment, allow } = autoMode;
  if (!isStrings(environment) || environment.length === 0) return 'unknown';
  if (allow !== undefined && !isStrings(allow)) return 'unknown';
  if (environment.some((entry) => entry.trim() === DEFAULTS || names(entry))) return 'allowed';
  if ((allow ?? []).some((entry) => names(entry) && PUSH_WORD.test(entry))) return 'allowed';
  // An entry that names no host may trust the remote in words no matcher reads, such as "our GitHub organisation".
  return environment.every((entry) => HOST_NAME.test(entry)) ? 'denied' : 'unknown';
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
  const user = { file, settings: readSettings(file) };
  // The project's settings are found from the session's folder; one that is not absolute would be read from wherever
  // this process runs, and is not read.
  const project = typeof cwd === 'string' && path.isAbsolute(cwd)
    ? projectFolders(cwd).flatMap((folder) => PROJECT_FILES.map((name) => path.join(folder, '.claude', name)))
      .map((each) => ({ file: each, settings: readSettings(each) }))
    : null;
  const sources = [user, ...(project ?? [])];
  const refused = refusal(sources);
  if (refused) return refused;
  // A file whose deny or ask rules cannot be read may hold one that refuses the push.
  if (sources.some(({ settings }) => permissionRules(settings, 'deny') === null || permissionRules(settings, 'ask') === null)) return UNKNOWN;
  const allowRules = sources.map(({ settings }) => permissionRules(settings, 'allow'));
  const globs = (rules) => rules.flatMap((rule) => shellGlobs(rule, { allow: true }));
  const trust = environmentTrust(user.settings, names);
  if (trust === 'allowed' || allowRules.some((rules) => rules !== null && coversPush(globs(rules)))) return { answer: 'allowed' };
  if (trust !== 'denied' || project === null) return UNKNOWN;
  // A rule for a narrower push may be the very push the run makes, and one this cannot read may allow it.
  if (allowRules.some((rules) => rules === null || mayPush(globs(rules)))) return UNKNOWN;
  return {
    answer: 'denied',
    setting: 'autoMode.environment',
    file,
    why: `replaces the default trusted repositories, with no "${DEFAULTS}" in its list, and names this remote in no entry`,
    fix: `adds "${DEFAULTS}" to that list, or an entry such as "Trusted repo: ${repository.toLowerCase()}"`,
  };
}
