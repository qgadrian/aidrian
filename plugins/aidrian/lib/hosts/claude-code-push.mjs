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

import path from 'node:path';

import { sessionMode } from './claude-code-background.mjs';
import { configDir } from './claude-code-config.mjs';
import { DEFAULTS, isObject, isStrings, mayReach, MISSING, projectFiles, readSettings, RULE_LISTS } from './claude-code-settings.mjs';

const UNKNOWN = Object.freeze({ answer: 'unknown' });
// The command the run pushes with, which a rule that may reach a push mentions or starts.
const PUSH = 'git push';
// A pattern that names a push to `origin`, or to no remote: `git push`, its flags, then nothing, `:*`, ` *`, or `origin`.
const PUSH_FORM = /^git push(?: --?[\p{L}\p{N}][\p{L}\p{N}_-]*(?:=[^ ]*)?)*(?::\*| \*| origin(?![\p{L}\p{N}_.-]).*)?$/u;
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

// Whether the allow rule `rule`, read as mayReach reads one, may cover a push to `origin`, the remote the push
// preflight reads: a `Bash` pattern whose text before its first `*`, less a final `:`, starts `git push`, such as
// `git:*`, `git *`, or `git p*`; or `git push`, then any flags, then nothing, `:*`, ` *`, or `origin` with any rest after
// a word boundary, such as `git push -u origin:*`. On entering auto mode Claude Code drops broad allow rules, such as
// `Bash(*)`, and keeps narrow ones (code.claude.com/docs/en/permission-modes, read on 2026-11-20), so `Bash`, `Bash(*)`,
// `*`, `B*`, and a pattern that starts with `*` do not stand a verdict aside. A deny or an ask rule still does whenever
// it may reach a push.
function allowsPush(rule) {
  const call = /^bash ?\( ?(.*?) ?\)$/u.exec(rule.trim().toLowerCase().replace(/\s+/gu, ' '));
  if (!call) return false;
  const star = call[1].indexOf('*');
  return (star > 0 && PUSH.startsWith(call[1].slice(0, star).replace(/:$/u, ''))) || PUSH_FORM.test(call[1]);
}

// Whether the settings `settings` leave no verdict to give: a file that is there and cannot be read, whose `permissions`
// is not an object, whose `allow`, `deny`, or `ask` is not a list of strings, or that holds an allow rule that covers a
// push (allowsPush), or a deny or ask rule that may reach one (mayReach). A file that is not there, or that sets no
// such rules, leaves one.
function standsAside(settings) {
  if (settings === MISSING) return false;
  if (settings === null) return true;
  const { permissions } = settings;
  if (permissions === undefined) return false;
  if (!isObject(permissions)) return true;
  return RULE_LISTS.some((key) => permissions[key] !== undefined
    && (!isStrings(permissions[key]) || permissions[key].some(key === 'allow' ? allowsPush : (rule) => mayReach(rule, PUSH))));
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
  const project = projectFiles(cwd).map(readSettings);
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
