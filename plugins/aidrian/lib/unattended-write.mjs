// The write allowlist of a session no Human attends: a session an unattended or pending mark holds
// (lib/unattended-mark.mjs readUnattendedMark), and its subagents, which the agent gate hook asks on every call
// (scripts/hook-agent-gates.mjs). docs/hooks.md#agent-gates says what passes and what refuses.
//   - Its own mark: it writes only its own worktree (the checkout of the folder its mark says it started in), the task
//     worktrees `aidrian worktree new` made in it (madePlaces), its attempt's work, drop, and cache folders, the state folders it writes by hand (HAND_FOLDERS), a review manifest or capture,
//     and the temporary folder. Wherever it lies, it never writes a git folder, the user's or the system's git config, a
//     shell startup file, another dot entry of the home folder, a review or attest record, or the dispatch records.
//   - A pending mark, held while a gate starts a session, or a mark that cannot be read: only the entries refused
//     wherever they lie hold (the shared git config and hooks, the user's and the system's git config, the startup files,
//     and the home folder's dot entries), since the session may be one a Human opened in another repository.
// It reads what the shared lexer reads (config-guard.mjs writeTargets), plus what the other guards leave out
// (lib/unattended-shell.mjs shellWrites): a target built from a variable, a link a command makes, and a program that
// writes its own config.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { ATTEMPT_KEEP, KEPT_FOLDERS } from './attempt-clone.mjs';
import { bashCall, writeTargets } from './config-guard.mjs';
import { checkDeadline, PastDeadline, remainingMs } from './deadline.mjs';
import { isManifestPath } from './finding-disposition.mjs';
import { forgeWorkflowFolders } from './forges/index.mjs';
import { foldCase, isWithin } from './fs.mjs';
import { gitConfigFiles, gitFolders, repositoryCheckouts, runGit, underGit, withGitFacts } from './git.mjs';
import { GLOB_WORD, globStarts, sameFile } from './glob-links.mjs';
import { globReaches, modeTargets, sessionWorktrees, startedFolder, stateFolders } from './handoff-guard.mjs';
import { fileEditOf, nestedProtected, opaqueShellCommand, protectedPaths } from './hosts/index.mjs';
import { issueForgeDenial } from './issue-forge-guard.mjs';
import { ownIssue } from './project-run-guard.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { issueHeld } from './unattended-mark.mjs';
import { shellWrites } from './unattended-shell.mjs';

// The state folders a confined host is granted besides its attempt's (lib/project-start.mjs): the plans, reviews, and
// dispatch records an issue's work leaves, and its temporary files. Its programs, such as the review engine, write the
// records there; the hook holds what the session writes by hand to HAND_FOLDERS.
export const WORK_FOLDERS = Object.freeze(['plans', 'reviews', 'tmp', 'dispatch']);
// The state folders a session no Human attends writes by hand: its plans, temporary files, handoff briefs (the
// continuation store inside stays held by its own guard), and the quorum folder, where decisions.md's product quorum
// runs under auto decisions. In `reviews`, only a manifest or a capture (reviewAllows).
const HAND_FOLDERS = Object.freeze(['plans', 'tmp', 'handoffs', 'quorum']);
// The state folders a project run's issue session writes by hand (unattended-mark.mjs issueHeld), and in each only the
// entries named for its own issue (issueNamed): it asks for no handoff, so it writes no brief a driver's check would
// resolve as its prior, and runs no quorum, whose ledger a later session reuses (lib/quorum/route.mjs).
const ISSUE_FOLDERS = Object.freeze(['plans', 'tmp']);
// The shell startup files in the home folder, and in ZDOTDIR for zsh, which every later shell of the user runs.
const STARTUP = Object.freeze(['.profile', '.login', '.logout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.kshrc', '.cshrc', '.tcshrc', '.inputrc']);
const ZSH_STARTUP = Object.freeze(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout']);
// A text from a folder no path gives that names a file always refused: a startup file, the user's git config, or a
// repository's git config or hooks.
const REFUSED_NAME = new RegExp(String.raw`(?<![\w.-])(?:${[...STARTUP, ...ZSH_STARTUP, '.gitconfig'].map((name) => name.replace('.', '\\.')).join('|')}|\.git/(?:config|hooks)|\.config/git|git/config)(?![\w.-])`, 'iu');
// A text that names a dot entry of the home folder.
const HOME_DOT = /(?:^|[^\w$])(?:~|\$HOME\b|\$\{HOME\})\/\./u;
// A path in a text, such as code an interpreter runs: absolute, or from the home folder.
const PATH_IN_TEXT = /(?<![\w.$-])(?:~(?=\/|$)|\/)[^\s'"`;|&()<>,=]*/gu;
// The devices a write may always name, by their spelled path, before any is resolved.
const DEVICE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/u;
// A text a manifest write must not hold: the key that makes the review gate read a file as an attest record
// (lib/review-gate.mjs readRecordFile), whose old name, pr-<n>.json, is the manifest's; and, in a text that does not
// parse, a quoted key with an escape in it, which may spell that key.
const ATTEST_KEY = /["']reviewer["']\s*:/u;
const ESCAPED_KEY = /["'][^"'\n]*\\[^"'\n]*["']\s*:/u;
// A text that names a git folder through git itself, as `$(git rev-parse --git-common-dir)` does.
const GIT_FOLDER_WORD = /--(?:git-common-dir|git-dir|absolute-git-dir|git-path)\b|\$\{?GIT_(?:DIR|COMMON_DIR)\b/u;
// A text that names a git folder or pointer by its own name, `.git`, as a word or a path's part.
const GIT_WORD = /(?<![\w.-])\.git(?![\w.-])/u;
// A file a subagent writes by hand in the dispatch folder: its handoff, `<branch>-<slice>-<agent>.json`.
const HANDOFF = /^[^/]+\.json$/u;
const MANIFEST = /^pr-\d+\.json$/u;
// The longest file a manifest rename is read from.
const SOURCE_CAP = 4 * 1024 * 1024;
const real = (file) => {
  checkDeadline();
  return foldCase(canonical(file));
};
// Whether the first part of `target`, below `folder`, is named for the issue `issue` ({ key }): the key itself, or the
// key and then a dash or a dot, in any case, as `<key>-implementation.md` or `tmp/<key>/`.
const issueNamed = (issue) => (target, folder) => {
  if (!issue) return false;
  const [first = ''] = path.relative(folder, target).split(path.sep);
  const name = first.toLowerCase();
  const key = issue.key.toLowerCase();
  return name === key || name.startsWith(`${key}-`) || name.startsWith(`${key}.`);
};
// Whether `target`, inside the dispatch folder `folder`, is a handoff file named for the branch of the issue `issue`
// ({ branch }): `<branch>-<slice>-<agent>.json`, each `/` of the branch a `-`.
const issueHandoff = (issue) => (target, folder) => {
  const name = path.relative(folder, target);
  return Boolean(issue) && HANDOFF.test(name) && name.toLowerCase().startsWith(`${issue.branch.replaceAll('/', '-').toLowerCase()}-`);
};
const absolute = (each) => typeof each === 'string' && path.isAbsolute(each);
// The time a git call may take: what the guards' budget leaves, or git's own default outside one.
const gitBudget = () => (Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : undefined);
// A function that adds a refused entry to `list`: { path, spelled, what, folder, allows, always }, `allows(target, folder)`
// the paths inside a refused folder that pass, and `always` an entry a write to a folder that holds it meets even when
// that folder is a place itself, as a checkout nested in the session's worktree is met by `rm -rf` of the worktree.
const refuser = (list) => (file, what, folder = false, allows = null, always = false) => list.push({ path: real(file), spelled: file, what, folder, allows, always });

// The places a session no Human attends may write, for the session whose mark is `mark`, or null when they cannot be
// told: { limited, pending, specific, reviews, worktree, temp, refused, later, home }, each path real and case-folded.
// `reviews` holds each state's reviews and dispatch folders, refused but for the files reviewAllows and dispatchAllows
// pass.
//   - limited: a pending mark or one with no main checkout; only `refused`, `later`, and the home folder's dot entries
//     hold, with `specific` the state folders of `project` that pass among those.
//   - specific: its attempt's work, drop, and cache folders (`own()`, project-run-guard.mjs ownAttemptFolder), and HAND_FOLDERS of
//     every state folder of `project`, the project the mark names, that is no link; `reviews`, each state's reviews folder.
//   - worktree: the checkout of the folder its mark says it started in (startFolder), when it shares its git folder with
//     the mark's main checkout, and `worktreeCommon` its git common folder; never the call's folder. Every other checkout
//     of the repository nested in it keeps its `.git` pointer and host files refused (nestedRefused). `nested` holds the attempt's
//     clone, { root, work, common, links }, `common` the git folder the start cloned it with. `temp`: the temporary
//     folders, this process's and /tmp by default. `states`: every state folder of `project`, where only `specific`
//     and `reviews` pass, even inside a temporary folder, as a state folder under /tmp is. `checkouts`: every checkout of
//     the mark's repository, where a temporary folder passes nothing either, so a checkout under /tmp keeps its own rules;
//     with checkouts git cannot list, no temporary folder passes. A main checkout that is no git repository has none.
//   - made: the task worktrees `aidrian worktree new` made in the session (madePlaces), each kept as `worktree` is.
//   - refused, each refused wherever it lies, and `later()`, the user's and the system's git config as git names them
//     (git.mjs gitConfigFiles), read only for a target that would pass.
// Null when the mark names a main checkout but no project can be read there, or a read fails. `env` is the hook's, and
// `session` the hook payload's session id, which finds the start record of a mark that names no start folder.
// One call reads each folder's roots, prefix, and remote URLs once (lib/git.mjs withGitFacts), or as the open call does;
// `later()` runs after it, outside it.
export function unattendedPlaces(options = {}) {
  return withGitFacts(() => placesOf(options));
}

function placesOf({ cwd, mark, project, config, base, own = null, env = process.env, home, temp, session = null }) {
  if (!mark) return null;
  const limited = mark.pending === true || typeof mark.root !== 'string';
  if (!limited && !project) return null;
  try {
    const user = home ?? userInfo().homedir;
    const places = { limited, pending: mark.pending === true, specific: [], reviews: [], worktree: null, worktreeCommon: null, made: [], temp: [], states: [], refused: [], nested: [], home: real(user), issue: null, issueHeld: issueHeld(mark) };
    const refuse = refuser(places.refused);
    userRefused(refuse, user, env);
    let named;
    places.later = () => (named ??= laterRefused(env));
    if (limited) limitedPlaces(places, { cwd, mark, project, config, base, home }, refuse);
    else ownPlaces(places, { mark, project, config, base, own, home, temp, session }, refuse);
    return places;
  } catch (error) {
    if (error instanceof PastDeadline) throw error;
    return null;
  }
}

// The user's git config, startup files, and macOS launch agents, which no path git or the environment gives moves.
function userRefused(refuse, user, env) {
  refuse(path.join(user, '.gitconfig'), 'the user\'s git config');
  refuse(path.join(user, '.config', 'git'), 'the user\'s git config', true);
  if (absolute(env.XDG_CONFIG_HOME)) refuse(path.join(env.XDG_CONFIG_HOME, 'git'), 'the user\'s git config', true);
  for (const name of [...STARTUP, ...ZSH_STARTUP]) refuse(path.join(user, name), 'a shell startup file');
  if (absolute(env.ZDOTDIR)) for (const name of ZSH_STARTUP) refuse(path.join(env.ZDOTDIR, name), 'a shell startup file');
  refuse(path.join(user, 'Library', 'LaunchAgents'), 'the user\'s launch agents, which macOS runs at every login', true);
}

// The user's and the system's git config files git names under `env`: a git call each, so read only when needed.
function laterRefused(env) {
  const list = [];
  const refuse = refuser(list);
  checkDeadline();
  const named = gitConfigFiles({ env, ...gitBudget() });
  for (const file of named.user) refuse(file, 'the user\'s git config');
  for (const file of named.system) refuse(file, 'the system\'s git config');
  return list;
}

// A repository's shared git config and hooks, refused for every hold.
function sharedRefused(refuse, common) {
  refuse(path.join(common, 'config'), 'the repository\'s shared git config');
  refuse(path.join(common, 'config.worktree'), 'the repository\'s shared git config');
  refuse(path.join(common, 'hooks'), 'the repository\'s shared git hooks', true);
}

// A checkout's git folders, refused whole for a session's own mark: only git writes there, and git running is no write
// this guard sees. Its config and hooks come first, so a refusal names them.
function gitRefused(refuse, { common, gitDir, top }) {
  sharedRefused(refuse, common);
  refuse(common, 'the repository\'s shared git folder, which only git writes', true);
  if (real(gitDir) !== real(common)) refuse(gitDir, 'the worktree\'s own git folder, which only git writes', true);
  if (real(path.join(top, '.git')) !== real(gitDir)) refuse(path.join(top, '.git'), 'the checkout\'s pointer to its git folder');
}

// The options stateFolders takes: the call's base-branch reader and home folder, when given.
const stateOptions = (base, home) => ({ ...(base ? { base } : {}), ...(home ? { home } : {}) });

// The folder a session its own mark holds started in, whose checkout is its worktree: the mark's `cwd`. A mark a gate
// filed before it recorded the start folder names none, and its `root` is the main checkout even for a session started
// in a linked worktree, so it never stands in: the folder is the one the gate's start record names (`recorded()`,
// handoff-guard.mjs startedFolder), or none. A project run's issue session works in its attempt's clone, which its mark
// names: one whose mark names none, or cannot be read, gets no worktree. Accepted residual: a folder is told by its path
// alone, so a worktree path the repository reused for another worktree since the start grants that other worktree.
function startFolder(mark, issueHeld, recorded) {
  if (absolute(mark.cwd)) return mark.cwd;
  return issueHeld ? null : recorded();
}

// The places of a session its own mark holds (unattendedPlaces).
function ownPlaces(places, { mark, project, config, base, own, home, temp, session }, refuse) {
  checkDeadline();
  const repo = gitFolders(mark.root, gitBudget());
  if (repo) gitRefused(refuse, repo);
  checkDeadline();
  const checkouts = repo ? repositoryCheckouts(mark.root, gitBudget) : null;
  places.checkouts = repo ? [...(checkouts ?? []), repo.top].map(real) : [];
  // A main checkout git cannot read, with a `.git` at or above it on disk, is a repository whose checkouts cannot be
  // told, not a folder outside git: it grants no checkout and the temporary folder passes nothing.
  const unknown = !repo && underGit(mark.root);
  const from = repo ? startFolder(mark, places.issueHeld, () => startedFolder(project, config, session, stateOptions(base, home))) : null;
  const start = from ? gitFolders(from, gitBudget()) : null;
  if (places.issueHeld) places.issue = ownIssue(project, config, mark, stateOptions(base, home));
  if (start && real(start.common) === real(repo.common) && startTop(start, from) && nestedRefused(refuse, checkouts, start.top)) {
    places.worktree = real(start.top);
    places.worktreeCommon = real(start.common);
    gitRefused(refuse, start);
    hostRefused(refuse, start.top);
    if (places.issueHeld) workflowRefused(refuse, start.top);
  }
  const attempt = typeof own === 'function' ? own() : null;
  if (attempt) {
    // Each folder of the attempt it writes is its place only while it is a plain folder: one a session replaced with a
    // link, as `cache -> ~/.claude`, would lead its writes wherever the link goes, so it is refused there instead.
    for (const name of ['work', 'drop', 'cache']) {
      const folder = path.join(attempt, name);
      if (canonical(folder) === folder) places.specific.push(real(folder));
      else refuse(folder, `the attempt's ${name} folder, which is no plain folder but a link, and leads anywhere`, true);
    }
    for (const name of KEPT_FOLDERS) refuse(path.join(attempt, name, ATTEMPT_KEEP), 'the keep file of an attempt\'s folder, which holds the folder in place');
    hostRefused(refuse, path.join(attempt, 'work'));
    if (places.issueHeld) workflowRefused(refuse, path.join(attempt, 'work'));
    places.nested.push({ root: real(path.join(attempt, 'work')), work: path.join(attempt, 'work'), common: real(path.join(attempt, 'git')), links: null });
    refuse(path.join(attempt, 'git', 'config'), 'the attempt clone\'s git config');
    refuse(path.join(attempt, 'git', 'hooks'), 'the attempt clone\'s git hooks', true);
    refuse(path.join(attempt, 'git'), 'the attempt clone\'s git folder, which only git writes', true);
    refuse(path.join(attempt, 'work', '.git'), 'the attempt clone\'s pointer to its git folder');
  }
  const states = stateWork(places, { project, config, base, home }, refuse);
  if (repo) madePlaces(places, { repo, checkouts, recorded: () => sessionWorktrees(states, session, [...project.checkouts, ...(checkouts ?? [])], config.session.handoff.maxChain) }, refuse);
  places.temp = unknown || (repo && !checkouts) ? [] : (temp ?? [tmpdir(), '/tmp']).filter(absolute).map(real);
}

// The task worktrees `aidrian worktree new` made in the session (`recorded()`, handoff-guard.mjs sessionWorktrees), each
// a place of the session's, as `made`, as its start worktree is: one git lists among the checkouts of the mark's
// repository (`repo`, `checkouts`), at that path, but its main checkout, while the path is no link, and with its nested
// checkouts, `.git` pointer, and host files refused as the start worktree's are. A project run's issue session stays
// confined to its attempt and gets none. None lies in a state folder, in a host folder of a checkout of the repository,
// as a worktrees folder set to `.claude/skills` would place it, or in a dot entry of the home folder outside the main
// checkout, since config.json, which the session may edit, names the folder the command makes it in. Accepted residual:
// a record is told by its path alone, so one a session forged by running the plugin's code, which no guard sees, or a
// worktree path the repository reused since, grants another linked worktree of the same repository.
function madePlaces(places, { repo, checkouts, recorded }, refuse) {
  if (places.issueHeld || !checkouts) return;
  const main = real(repo.top);
  const listed = new Set(checkouts.map(real));
  const hosts = places.checkouts.flatMap((top) => protectedPaths().map((each) => real(path.join(top, each))));
  const dotted = (top) => isWithin(places.home, top) && !isWithin(main, top) && path.relative(places.home, top).split(path.sep)[0].startsWith('.');
  for (const each of recorded()) {
    checkDeadline();
    const top = real(each);
    if (top === main || top === places.worktree || places.made.includes(top) || !listed.has(top) || canonical(each) !== each) continue;
    if (places.states.some((state) => isWithin(state, top)) || hosts.some((host) => isWithin(host, top)) || dotted(top)) continue;
    if (!nestedRefused(refuse, checkouts, each)) continue;
    places.made.push(top);
    refuse(path.join(each, '.git'), 'the checkout\'s pointer to its git folder');
    hostRefused(refuse, each);
  }
}

// Whether the checkout `start` (gitFolders) of the start folder `from` is the session's worktree: a linked worktree,
// from any folder inside it, as a session started in a package of a monorepo is; the main checkout only from its own top.
// A removed worktree's folder left as a plain one inside the main checkout resolves to the main checkout, and grants none.
const startTop = (start, from) => real(start.gitDir) !== real(start.common) || real(start.top) === real(from);

// The other checkouts of the repository, `checkouts` (git.mjs repositoryCheckouts), that lie inside the session's worktree `top`, as
// task worktrees under the main checkout's `.claude/worktrees/` do for a session started there: each one's `.git`
// pointer is refused, whole folders that hold it included (`always`), and so are its host files, which a later session
// there loads (hostRefused). Whether git could list the checkouts: a worktree whose nested checkouts cannot be told is
// none of the session's.
const NESTED_POINTER = 'a nested checkout\'s pointer to its git folder, which only git writes';
function nestedRefused(refuse, checkouts, top) {
  if (!checkouts) return false;
  const own = real(top);
  for (const each of checkouts) {
    const at = real(each);
    if (at === own || !isWithin(own, at)) continue;
    refuse(path.join(each, '.git'), NESTED_POINTER, false, null, true);
    hostRefused(refuse, each);
  }
  return true;
}

// The forge's workflow folders of the checkout at `top` (forges/index.mjs forgeWorkflowFolders), refused to a project
// run's issue session: the forge runs their files with the repository's secrets on a push of any branch, so one the
// session wrote would run before any review. An issue that needs such a change is parked for the Human.
function workflowRefused(refuse, top) {
  for (const each of forgeWorkflowFolders()) refuse(path.join(top, ...each.split('/')), 'the forge\'s workflow files, which the forge runs with the repository\'s secrets on a push of any branch, before any review', true);
}

// The host files of the checkout at `top` every host protects (hosts/index.mjs protectedPaths): the settings, skills,
// agents, commands, hooks, scheduled work, and MCP servers a later session there loads. A `.json` name is a file; any
// other is a folder, refused with all it holds.
function hostRefused(refuse, top) {
  for (const each of protectedPaths()) refuse(path.join(top, each), 'a host file a later session in that checkout loads, such as its settings, skills, agents, hooks, or MCP servers', !each.endsWith('.json'));
}

// What a confined session never writes at any depth of its clone (hosts/index.mjs nestedProtected): a host file it
// loads from a nested folder, such as a `.claude` folder's skills or settings, or any SKILL.md.
const NESTED = { what: 'a host file a later session in that clone loads from any depth, such as a nested .claude folder\'s skills, agents, commands, hooks, or settings, or a SKILL.md' };

// The NESTED entry a write to the real, case-folded path `target`, spelled `spelled`, meets in one of the clones
// `nested` ({ root, work, links }, root real and case-folded), or null: by the target's parts from the clone's root; by
// the spelled path's parts past each of its leading parts that resolves into a clone, so a write through a link named as
// a host file, as `pkg/.claude/commands/x.md` where `pkg/.claude` links to `shared`, is judged as spelled; and, for a
// target such a link leads to, by its parts past that link (nestedLinkHit).
function nestedHit(target, nested, spelled = null) {
  const roots = nested.map((each) => each.root);
  for (const root of roots) {
    if (target !== root && isWithin(root, target) && nestedProtected(path.relative(root, target).split(path.sep))) return NESTED;
  }
  if (typeof spelled === 'string' && path.isAbsolute(spelled) && roots.length) {
    const parts = path.normalize(spelled).split(path.sep).filter(Boolean);
    for (let count = 1; count < parts.length; count += 1) {
      const at = real(path.join(path.sep, ...parts.slice(0, count)));
      const root = roots.find((each) => isWithin(each, at));
      if (root && nestedProtected([...path.relative(root, at).split(path.sep), ...parts.slice(count)])) return NESTED;
    }
  }
  return nestedLinkHit(target, nested);
}

// The NESTED entry the real, case-folded path `target` meets through a link of a clone's git index whose own path is a
// host file some host loads from any depth (nestedProtected), as a `.claude` that links to a plain folder: a write to
// that folder is a write to the host file. git lists the links once a call, in the clone the target lies in; a clone
// whose links git cannot list in time refuses, and a folder with no `.git` holds none.
function nestedLinkHit(target, nested) {
  for (const clone of nested) {
    if (!isWithin(clone.root, target)) continue;
    clone.links ??= indexLinks(clone.work);
    if (clone.links === null) return { what: `${NESTED.what}, as git could not list the clone's links to tell whether one leads there` };
    for (const { at, parts } of clone.links) {
      if (isWithin(at, target) && nestedProtected([...parts, ...path.relative(at, target).split(path.sep).filter(Boolean)])) return NESTED;
    }
  }
  return null;
}

// The pathspecs of the index entries that can be a host file a host loads from any depth: a `.claude` entry, anything
// below one, and a SKILL.md, in any case.
const INDEX_LINKS = Object.freeze([':(glob,icase)**/.claude', ':(glob,icase)**/.claude/**', ':(glob,icase)**/SKILL.md']);
// The most output that listing may print.
const INDEX_BUFFER = 64 * 1024 * 1024;

// The links of the git index of the clone `work` whose path is a host file (nestedProtected): { at, parts }, the real,
// case-folded folder each leads to and its own parts; none when `work` holds no `.git`; null when git fails. git lists
// only the entries that can be such a link (INDEX_LINKS), which its glob magic matches at the root too, and its answer
// may run to INDEX_BUFFER bytes, so a clone that tracks many host files still answers.
function indexLinks(work) {
  try {
    lstatSync(path.join(work, '.git'));
  } catch {
    return [];
  }
  const listed = runGit(['ls-files', '--stage', '-z', '--', ...INDEX_LINKS], work, { ...gitBudget(), maxBuffer: INDEX_BUFFER });
  if (listed.status !== 0) return null;
  const links = [];
  for (const entry of listed.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || !entry.startsWith('120000 ')) continue;
    const parts = entry.slice(tab + 1).split('/');
    if (nestedProtected(parts)) links.push({ at: real(path.join(work, ...parts)), parts });
  }
  return links;
}

// A glob part as a regular expression over one name, any case: `*`, `?`, a bracket class, and braces. One it cannot
// build matches every name.
function partPattern(part) {
  let text = '';
  let depth = 0;
  for (let i = 0; i < part.length; i += 1) {
    const char = part[i];
    if (char === '*') text += '[^/]*';
    else if (char === '?') text += '[^/]';
    else if (char === '[') {
      const end = part.indexOf(']', i + 1);
      if (end < 0) text += '\\[';
      else {
        text += `[${part.slice(i + 1, end).replace(/^!/u, '^').replace(/\\/gu, '\\\\')}]`;
        i = end;
      }
    } else if (char === '{') {
      depth += 1;
      text += '(?:';
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      text += ')';
    } else if (char === ',' && depth > 0) text += '|';
    else text += char.replace(/[.*+?^${}()|[\]\\]/u, '\\$&');
  }
  try {
    return new RegExp(`^${text}$`, 'iu');
  } catch {
    return /^/u;
  }
}

// Whether a glob, by its folder `prefix` and its later parts `rest`, may reach a NESTED entry of one of the clones
// `nested`: it lies in one and a later part may name a `.claude` folder, a glob whose own text starts with a dot or is a
// class or a brace, since a shell's `*` skips dot names, or its last part may name a SKILL.md.
function nestedGlob(prefix, rest, nested) {
  if (!nested.some(({ root }) => isWithin(root, prefix) || isWithin(prefix, root))) return false;
  if (nestedHit(prefix, nested)) return true;
  const may = (part, name) => (GLOB_WORD.test(part) ? /^[.[{]/u.test(part) && partPattern(part).test(name) : part.toLowerCase() === name);
  const last = rest.at(-1) ?? '';
  return rest.some((part) => may(part, '.claude')) || (GLOB_WORD.test(last) ? partPattern(last).test('skill.md') : last.toLowerCase() === 'skill.md');
}

// The places of a session a pending mark, or a mark that cannot be read, holds (unattendedPlaces): the shared git
// config and hooks of the mark's main checkout and of the call's folder, and, as places among the home folder's dot
// entries, the state folders of the project the mark names.
function limitedPlaces(places, { cwd, mark, project, config, base, home }, refuse) {
  for (const dir of [mark.root, cwd].filter(absolute)) {
    checkDeadline();
    const repo = gitFolders(dir, gitBudget());
    if (repo) sharedRefused(refuse, repo.common);
  }
  if (!project) return;
  for (const state of stateFolders(project, config, stateOptions(base, home))) places.specific.push(real(state));
}

// Each state folder's HAND_FOLDERS that is no link, as `specific`; its reviews folder, refused but for a manifest or
// a capture (reviewAllows); its dispatch folder, refused but for a handoff file in it (dispatchAllows); and the dispatch
// log beside them, refused. Returns the state folders, as stateFolders gives them.
function stateWork(places, { project, config, base, home }, refuse) {
  const states = [...stateFolders(project, config, stateOptions(base, home))];
  for (const state of states) {
    const root = canonical(state);
    places.states.push(foldCase(root));
    // A folder that is a link, as `tmp -> ~`, could lead anywhere: it is no place of the session's.
    const plain = (name) => canonical(path.join(root, name)) === path.join(root, name);
    if (places.issueHeld) issueWork(places, root, plain, refuse);
    else {
      for (const name of HAND_FOLDERS.filter(plain)) places.specific.push(foldCase(path.join(root, name)));
      refuse(path.join(root, 'dispatch'), 'the dispatch records, where a session writes only its handoff file', true, dispatchAllows);
    }
    refuse(path.join(root, 'reviews'), 'the review and attest records, which only the review commands write', true, reviewAllows);
    if (plain('reviews')) places.reviews.push(foldCase(path.join(root, 'reviews')));
    if (plain('dispatch')) places.reviews.push(foldCase(path.join(root, 'dispatch')));
    refuse(path.join(root, 'dispatch-log.jsonl'), 'the dispatch log, which only the plugin writes');
  }
  return states;
}

// The state work of a project run's issue session in the state folder `root` (stateWork): it shares the plans, tmp, and
// dispatch folders with every other session of the project, so it writes there only what is named for its own issue
// (`places.issue`, project-run-guard.mjs ownIssue) and never rewrites another's plan, scratch files, or handoff. With
// no running start of its issue to name them, it writes none of them.
function issueWork(places, root, plain, refuse) {
  const { issue } = places;
  for (const name of ISSUE_FOLDERS) {
    const what = issue
      ? `a file of the shared ${name} folder not named for this session's issue ${issue.key}, which another session may work from; an issue session writes only ${name}/${issue.key.toLowerCase()}-... there`
      : `the shared ${name} folder, where an issue session whose running start cannot be read writes nothing`;
    refuse(path.join(root, name), what, true, issueNamed(issue));
    if (plain(name)) places.reviews.push(foldCase(path.join(root, name)));
  }
  const handoff = issue ? `, ${issue.branch.replaceAll('/', '-')}-<slice>-<agent>.json` : '';
  refuse(path.join(root, 'dispatch'), `the dispatch records, where an issue session writes only a handoff file named for its own branch${handoff}`, true, issueHandoff(issue));
}

// Whether `target` inside the reviews folder `folder` is one a session writes by hand: a review manifest, or a temporary
// copy of one, in the folder itself (finding-disposition.mjs isManifestPath), or a file in a capture folder,
// pr-<n>/captures/.
function reviewAllows(target, folder) {
  const parts = path.relative(folder, target).split(path.sep).filter(Boolean);
  if (parts.length === 1) return isManifestPath(target);
  return parts.length >= 2 && /^pr-\d+$/u.test(parts[0]) && parts[1] === 'captures';
}

// Whether `target` inside the dispatch folder `folder` is a handoff file a subagent writes by hand: a `.json` file in
// the folder itself.
function dispatchAllows(target, folder) {
  return HANDOFF.test(path.relative(folder, target));
}

// The refused entry of `entries` a write to `target`, spelled `spelled`, meets, or null: the entry, a path in a refused
// folder it does not allow, or, with `holds`, an entry the target holds, as `rm -rf` of a folder above one does, unless
// the target is a place itself (`own`); a file entry is also met through a hard link to it.
function refusedHit(target, spelled, entries, { own, holds }) {
  for (const entry of entries) {
    checkDeadline();
    const inside = (entry.path === target || (entry.folder && isWithin(entry.path, target))) && !entry.allows?.(target, entry.path);
    if (inside || (holds && (!own || entry.always) && target !== entry.path && isWithin(target, entry.path)) || (!entry.folder && sameFile(entry.spelled, spelled))) return entry;
  }
  return null;
}

// What a write to the real, case-folded path `target`, spelled `spelled`, meets among `places`: { refused } naming the
// entry, { outside: true } when it lies in no place the session may write, or null when it passes. The refused entries
// come first, then the session's places, its own worktree before the home folder's dot entries, so a repository there
// still writes itself; a target that would pass meets the git config files git names (`later`) too. A temporary folder
// passes nothing inside a state folder (`states`), whose own places alone pass there, so a state folder under /tmp keeps
// its handoff briefs, quorum ledgers, and other sessions' files from the session.
function placeOf(target, spelled, places, { holds = true } = {}) {
  const own = [...places.specific, places.worktree, ...(places.made ?? []), ...places.temp].includes(target);
  const hit = refusedHit(target, spelled, places.refused, { own, holds }) ?? nestedHit(target, places.nested ?? [], spelled);
  if (hit) return { refused: hit };
  const passes = () => {
    const late = refusedHit(target, spelled, places.later(), { own, holds });
    return late ? { refused: late } : null;
  };
  const holder = [...places.specific, ...places.reviews, places.worktree, ...(places.made ?? [])].find((dir) => dir && isWithin(dir, target));
  if (holder) return gitEntry(holder, target, spelled) ?? passes();
  const below = isWithin(places.home, target) ? path.relative(places.home, target).split(path.sep)[0] : '';
  if (below.startsWith('.')) return { refused: { what: 'a dot file or folder of the user\'s home folder', spelled } };
  if (places.limited) return passes();
  // Accepted residual: a checkout here only keeps the temporary folder from passing a path inside it; it is no refused
  // entry, so a removal of a temporary folder above it, such as `rm -rf /tmp/work` over a sibling worktree in it, passes.
  const held = [...(places.states ?? []), ...(places.checkouts ?? [])].some((dir) => isWithin(dir, target));
  if (!held && places.temp.some((dir) => isWithin(dir, target))) return passes();
  return { outside: true };
}

// A `.git` entry at any depth of the place `top` the real, case-folded path `target` lies in, the session's worktree,
// an attempt folder, or a state folder it writes, below the entries gitRefused names: a checkout nested in it, as a task
// worktree under the main checkout's `.claude/worktrees/` is, and that checkout's pointer to its git folder. Only git
// writes there. It is told by the real path's parts from `top`, and by the parts of the path as spelled, so a `.git`
// that is a link, which the real path no longer names, still counts: { refused }, or null. Accepted residual: a write
// that names no `.git`, such as `rm -rf vendor` or `mv vendor x` over a standalone repository nested there that no git
// listing names, takes its `.git` along unrefused; a nested worktree's pointer is a refused entry (nestedRefused).
const GIT_ENTRY = 'a nested checkout\'s git folder or pointer to one, which only git writes';
const isGitPart = (part) => part.toLowerCase() === '.git';
function gitEntry(top, target, spelled) {
  const spelledParts = typeof spelled === 'string' ? path.normalize(spelled).split(path.sep) : [];
  return [...path.relative(top, target).split(path.sep), ...spelledParts].some(isGitPart) ? { refused: { what: GIT_ENTRY, spelled } } : null;
}

// Whether a glob, by its folder `prefix` and its later parts `rest`, may reach a `.git` entry in one of the places
// `places` (gitEntry): it lies in one, or above one, and a later part may name `.git`, as a glob whose own text starts
// with a dot or is a class or a brace may, since a shell's `*` skips dot names.
function gitGlob(prefix, rest, places) {
  const roots = [...places.specific, ...places.reviews, places.worktree, ...(places.made ?? [])].filter(Boolean);
  if (!roots.some((root) => isWithin(root, prefix) || isWithin(prefix, root))) return false;
  return rest.some((part) => (GLOB_WORD.test(part) ? /^[.[{]/u.test(part) && partPattern(part).test('.git') : isGitPart(part)));
}

// A spelled path as placeOf meets it: a device always passes, before any path is resolved.
function placed(spelled, places, options) {
  if (DEVICE.test(path.normalize(spelled))) return null;
  return placeOf(real(spelled), spelled, places, options);
}

// The text a file edit tool writes to each file it names, { file, texts }, for the manifest check.
function editedTexts(input) {
  const edit = fileEditOf(input);
  if (!edit) return [];
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (edit.shape === 'patch') return (edit.files ?? []).map(({ file, added }) => ({ file: path.resolve(cwd, file), texts: [String(added ?? '')] }));
  const texts = [edit.content, edit.newText, ...(Array.isArray(edit.edits) ? edit.edits.flatMap((each) => Object.values(each ?? {})) : [])];
  return [{ file: path.resolve(cwd, edit.file ?? ''), texts: texts.filter((each) => typeof each === 'string') }];
}

// The text of the regular file `file`, read without following a link, or null.
function fileText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SOURCE_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Whether a manifest's text may make it an attest record: parsed as JSON, an object with a top-level `reviewer` key,
// as the review gate reads it; a text that does not parse, such as an edit's fragment, holds such a key (ATTEST_KEY) or
// a quoted key with an escape in it (ESCAPED_KEY).
function attestShaped(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'reviewer');
  } catch {
    return ATTEST_KEY.test(text) || ESCAPED_KEY.test(text);
  }
}

// Why a write to a review manifest name may make it an attest record, or null. A file edit tool's text must not be
// attest-shaped (attestShaped). A shell write to a temporary copy must not name a `reviewer` either; one to the manifest
// itself, pr-<n>.json, is only a delete, or a rename or copy of a file whose text is not attest-shaped and that the same
// call does not write, read before the call runs.
function manifestProblem(input, shell, places) {
  const isManifest = (file) => isManifestPath(file) && places.reviews.some((dir) => isWithin(dir, real(file)));
  for (const { file, texts } of editedTexts(input)) {
    if (isManifest(file) && texts.some(attestShaped)) return file;
  }
  if (!shell) return null;
  const files = writeTargets(input).files.map((each) => path.resolve(each));
  for (const write of shell.manifests) {
    if (write.folder === null && !path.isAbsolute(write.text)) continue;
    const file = path.resolve(write.folder ?? '/', write.text);
    if (!isManifest(file)) continue;
    if (!MANIFEST.test(path.basename(file))) {
      if (/reviewer/iu.test(shell.text)) return file;
      continue;
    }
    if (renameProblem(write, file, files)) return file;
  }
  return null;
}

// Whether the shell write `write` to the manifest `file` itself may forge it (manifestProblem). `files` are every path
// the call writes.
function renameProblem(write, file, files) {
  const from = (each) => path.resolve(write.folder ?? '/', each);
  const sources = (write.sources ?? []).map(from);
  if (['rm', 'unlink'].includes(write.how) || (write.how === 'mv' && sources.includes(file))) return false;
  if (!['mv', 'cp'].includes(write.how) || sources.length === 0) return true;
  const ownWrites = write.how === 'mv' ? 1 : 0;
  return sources.some((source) => {
    const text = fileText(source);
    return text === null || attestShaped(text) || files.filter((each) => each === source).length > ownWrites;
  });
}

// Why the call in `input` may not run because a session no Human attends, one `mark` names (lib/unattended-mark.mjs
// readUnattendedMark, read through the hook payload's session id), writes outside the places it may write
// (unattendedPlaces, which `places()` gives, or null when they cannot be told), or null: { match, reason }. It holds only
// for such a session and its subagents; an attended session, and its subagents, are never asked. `env` is the hook's
// environment, from which a target's variables are expanded. Like the other guards, it sees only what the shared lexer
// sees, plus what shellWrites reads.
export function unattendedWriteDenial(input, { names: { human } }, { mark = null, places = () => null, env = process.env } = {}) {
  if (!mark) return null;
  // Accepted residual, tracked in #513: each write target is judged folded as text (writeTargets resolves it with
  // path.resolve), so a `..` after a link counts where the spelling folds, not where the system lands.
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const command = bashCall(input) && typeof input.tool_input?.command === 'string' ? input.tool_input.command : null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  // A project run's issue session pushes only its own branch, and asks the forge for nothing else it never asks, a
  // call with no file write included (lib/issue-forge-guard.mjs).
  const forge = issueForgeDenial(input, { names: { human } }, { mark, cwd, fold: real, issue: () => places()?.issue ?? null, roots: () => pushRoots(places()) });
  if (forge) return forge;
  const shell = command === null ? null : shellWrites(command, cwd, env);
  const any = [files, names, globs, modes, shell?.dynamic ?? [], shell?.links ?? [], shell?.programs ?? [], shell?.removed ?? []].some((list) => list.length > 0);
  if (!any) return null;
  const say = sayer(input, human, opaqueShellCommand(input) !== null, mark);
  const found = places();
  if (!found) return say.unknown();
  say.hold(found);
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const placedModes = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder }) => path.resolve(folder ?? '/', text));
  const removed = (shell?.removed ?? []).filter(({ text, folder }) => folder !== null || path.isAbsolute(text));
  const texts = [...names, ...unplaced.map(({ text }) => text), ...globs.filter((each) => each.unsure || each.opaque).map(({ text }) => text),
    ...(shell?.removed ?? []).filter((each) => !removed.includes(each)).map(({ text }) => text)];
  const made = madeFolders(files, shell);
  return pathDenial([...files.filter((each) => !madeOnly(each, made, found)), ...placedModes, ...removed.map(({ text, folder }) => path.resolve(folder ?? '/', text))], found, say)
    ?? shellDenial(shell, found, say, texts)
    ?? globDenial(globs.filter((each) => !each.unsure), found, say)
    ?? manifestDenial(input, shell, found, say)
    ?? nameDenial(texts, found, say);
}

// The folders a project run's issue session pushes from, as `places` (unattendedPlaces) give them, each { root, common },
// with the git common folder its own repository keeps: its own worktree and its attempt's clone.
function pushRoots(places) {
  if (!places) return [];
  const worktree = places.worktree ? [{ root: places.worktree, common: places.worktreeCommon }] : [];
  return [...worktree, ...(places.nested ?? []).map(({ root, common }) => ({ root, common }))].filter((each) => each.root && each.common);
}

// The denials of unattendedWriteDenial, which say what the call does, to whom (`mark` names an issue session), and why.
function sayer(input, human, opaque, mark) {
  const verb = opaque ? 'may change' : 'writes';
  let suffix = '';
  let list = 'its own worktree or its attempt\'s folders, a task worktree `aidrian worktree new` made in it, the state folders it writes by hand (plans, tmp, handoffs, quorum, and a review manifest or capture), and the temporary folder';
  const deny = (match, why) => ({ match, reason: projectRuleReason(input, `${why}${suffix}`, human, 'to make that change, or where the work should go instead', { mark }) });
  return {
    verb,
    hold(found) {
      if (found.pending) suffix = '; a project start is in progress, and until the gate files the new session\'s own mark, every session it did not list before the start is held this way';
      else if (found.limited) suffix = '; its unattended mark cannot be read, so it is held this way';
      if (found.limited) list = 'anywhere but the entries refused wherever they lie';
      else if (found.issueHeld) list = 'its own worktree or its attempt\'s folders but the forge\'s workflow files, the files of the plans and tmp state folders named for its own issue, a dispatch handoff named for its own branch, a review manifest or capture, and the temporary folder';
    },
    unknown: () => deny('unattended write with no known places', `it ${verb} a file, and the places this session may write cannot be told: its unattended mark names no main checkout or project that can be read, and no Human attends this session, so it writes nothing until they can`),
    refused: (entry, shown) => deny(`unattended write to ${entry.what}`, `it ${verb} ${shown}, ${entry.what}, which a session no Human attends never changes; only ${human} does`),
    outside: (shown) => deny('unattended write outside its places', `it ${verb} ${shown}, outside the places a session no Human attends may write: ${list}`),
    meets(met, shown) {
      if (met?.refused) return deny(`unattended write to ${met.refused.what}`, `it ${verb} ${shown}, ${met.refused.what}, which a session no Human attends never changes; only ${human} does`);
      if (met?.outside) return deny('unattended write outside its places', `it ${verb} ${shown}, outside the places a session no Human attends may write: ${list}`);
      return null;
    },
    deny,
  };
}

// The paths of `files`, as the call spells them, that only a `mkdir` with no mode writes: each one that shellWrites read
// as written by such a `mkdir` as often as the lexer read it written at all, by any program.
function madeFolders(files, shell) {
  if (!shell) return new Set();
  const resolved = (each) => path.resolve(each.folder ?? '/', each.text);
  const plain = shell.manifests.filter((each) => each.how === 'mkdir' && each.mode !== true && (each.folder !== null || path.isAbsolute(each.text)));
  const other = new Set(shell.manifests.filter((each) => !plain.includes(each)).map(resolved));
  const count = (list, file) => list.filter((each) => each === file).length;
  const writes = files.map((each) => path.resolve(each));
  const made = plain.map(resolved);
  return new Set(made.filter((file) => !other.has(file) && count(made, file) >= count(writes, file)));
}

// Whether a write to `spelled` is only a `mkdir` of a reviews or dispatch folder itself (`made`), which passes: the
// review commands and a subagent's handoff write there, and the folder may not be there yet. Below it, and any other
// write of it, such as rm, rmdir, or mv, the folder's own rule judges.
const madeOnly = (spelled, made, found) => made.has(path.resolve(spelled)) && found.reviews.includes(real(spelled));

function pathDenial(spelled, found, say) {
  for (const each of spelled) {
    const denial = say.meets(placed(each, found), each);
    if (denial) return denial;
  }
  return null;
}

// The shell's own writes (shellWrites): a target from a variable, a link, and a program's config.
function shellDenial(shell, found, say, texts) {
  if (!shell) return null;
  return dynamicDenial(shell, found, say, texts) ?? linkDenial(shell, found, say, texts) ?? programDenial(shell, found, say);
}

// Each target built from a variable or a command, once expand has read it: a literal path is placed, and one it could
// not expand is judged by unexpandedDenial, after the whole command is judged once (builtDenial).
function dynamicDenial(shell, found, say, texts) {
  const built = shell.dynamic.find(({ text }) => /[$`]/u.test(text));
  const whole = built ? builtDenial(shell.text, built.text, found, say) : null;
  if (whole) return whole;
  for (const { text, folder } of shell.dynamic) {
    let denial = null;
    if (/[$`]/u.test(text)) denial = unexpandedDenial(text, folder, found, say, texts);
    else if (folder === null && !path.isAbsolute(text)) texts.push(text);
    else if (GLOB_WORD.test(text)) denial = globDenial([{ text: path.resolve(folder ?? '/', text), dirs: [], unsure: false }], found, say);
    else denial = pathDenial([path.resolve(folder ?? '/', text)], found, say);
    if (denial) return denial;
  }
  return null;
}

// The whole text of a command that writes a target still built at run time, `target`, judged once, for a session its
// own mark holds: where such a target lands cannot be told, so a command that names a literal path that meets a refused
// entry, a startup file or a git config (REFUSED_NAME), a dot entry of the home folder (HOME_DOT), or a git folder
// through git (GIT_FOLDER_WORD) or by its name (GIT_WORD), anywhere in its text, refuses. A loop over plain words or
// a target from mktemp names none of them, and passes.
function builtDenial(text, target, found, say) {
  if (found.limited) return null;
  const deny = (what) => say.deny('unattended write to a path built at run time', `it ${say.verb} \`${target.slice(0, 80)}\`, a path built at run time, in a command that names ${what}, and no Human attends this session; write to a literal path instead`);
  for (const [word] of text.matchAll(PATH_IN_TEXT)) {
    const spelled = word.startsWith('~') ? path.join(found.home, word.slice(1)) : word;
    const met = placed(spelled, found, { holds: false });
    if (met?.refused) return deny(`${spelled.slice(0, 120)}, ${met.refused.what}`);
  }
  if (REFUSED_NAME.test(text) || HOME_DOT.test(text)) return deny('a shell startup file, a git config, or a dot entry of the home folder');
  if (GIT_FOLDER_WORD.test(text) || GIT_WORD.test(text)) return deny('a git folder git names for it, or a git folder by its name');
  return null;
}

// A target that still holds a variable or a command: judged by its names (nameDenial, from `texts`), by a git folder
// it asks git for, and, for a session its own mark holds, by its literal path before the first `$` or backtick, which
// must not meet a refused entry or lie outside the places. One with no such prefix, as `"$out"`, passes on its names.
function unexpandedDenial(text, folder, found, say, texts) {
  texts.push(text);
  if (GIT_FOLDER_WORD.test(text)) return say.deny('unattended write to a git folder', `it ${say.verb} \`${text.slice(0, 80)}\`, a path in a git folder git names for it, which only git writes, and no Human attends this session`);
  const prefix = text.slice(0, text.search(/[$`]/u));
  if (found.limited || prefix === '' || (folder === null && !path.isAbsolute(prefix))) return null;
  return say.meets(placed(path.resolve(folder ?? '/', prefix), found, { holds: false }), `\`${text.slice(0, 80)}\``);
}

// Each path a link the command makes points at: refused when that path is refused or outside the places.
function linkDenial(shell, found, say, texts) {
  for (const { from, to } of shell.links) {
    for (const each of to) {
      if (/[$`]/u.test(each) || !path.isAbsolute(each)) {
        if (!found.limited) return say.deny('unattended link to a path built at run time', `it makes a link to \`${from.slice(0, 80)}\`, which cannot be told before it runs, and no Human attends this session; link a literal path instead`);
        texts.push(each);
        continue;
      }
      const met = placed(each, found);
      if (!met) continue;
      const where = met.refused ? `is ${met.refused.what}` : 'lies outside the places a session no Human attends may write';
      return say.deny('unattended link outside its places', `it makes a link to ${each}, which ${where}, so a write through the link would change it, and no Human attends this session`);
    }
  }
  return null;
}

// Each write a program makes to its own config: refused by what it changes, or placed by the file it names.
function programDenial(shell, found, say) {
  for (const write of shell.programs) {
    if (write.what) return say.refused(write, `\`${write.text}\``);
    if (write.folder === null && !path.isAbsolute(write.file)) {
      if (!found.limited) return say.deny('unattended write to a path built at run time', `it runs \`${write.text}\` in a folder that cannot be told, and no Human attends this session`);
      continue;
    }
    const file = path.resolve(write.folder ?? '/', write.file);
    const denial = say.meets(placed(file, found), `${file} (\`${write.text}\`)`);
    if (denial) return denial;
  }
  return null;
}

// Each glob from a known folder, by its spelled folder and what it may reach among the refused entries. Accepted residual:
// a glob that reaches a `.git` by expanding to a folder that holds it, such as `rm -rf vendor/*` over a standalone
// repository nested there that no git listing names, is not refused; only a registered entry (nestedRefused) or a part
// that may name `.git` itself (gitGlob) is.
function globDenial(globs, found, say) {
  for (const glob of globs) {
    for (const { start, rest } of globStarts(glob)) {
      const spelling = { prefix: real(start), rest };
      if (spelling.rest.includes('..')) return say.deny('unattended write outside its places', `it ${say.verb} ${glob.text}, a glob that climbs with \`..\`, so where it writes cannot be told, and no Human attends this session`);
      const denial = say.meets(placeOf(spelling.prefix, start, found, { holds: false }), glob.text);
      if (denial) return denial;
      // A refused folder the glob's folder already lies in, and allows, is no entry it reaches.
      const reached = found.refused.filter((entry) => !isWithin(entry.path, spelling.prefix)).find((entry) => globReaches(spelling, entry.path));
      if (reached) return say.refused(reached, glob.text);
      if (nestedGlob(spelling.prefix, spelling.rest, found.nested ?? [])) return say.refused(NESTED, glob.text);
      if (!found.limited && gitGlob(spelling.prefix, spelling.rest, found)) return say.refused({ what: GIT_ENTRY }, glob.text);
    }
  }
  return null;
}

function manifestDenial(input, shell, found, say) {
  if (found.limited) return null;
  const file = manifestProblem(input, shell, found);
  if (!file) return null;
  return say.deny('unattended write that may forge an attest record', `it ${say.verb} ${file}, a review manifest, in a way that may give it a \`reviewer\` key, which the review gate reads as an attest record under the manifest's own name, pr-<n>.json; write a temporary copy with the file tool, with no such key, then rename it`);
}

// What no path places, judged by name: a startup file or a git config (REFUSED_NAME), a home dot entry (HOME_DOT), a
// `.git` entry for a session its own mark holds (GIT_WORD), or a path in the text that meets a refused entry.
function nameDenial(texts, found, say) {
  for (const text of texts) {
    checkDeadline();
    if (REFUSED_NAME.test(text) || HOME_DOT.test(text)) return say.deny('unattended write to a refused name', `it ${say.verb} a file named in \`${text.slice(0, 80)}\`, which names a shell startup file, a git config, or a dot entry of the home folder, and no Human attends this session`);
    if (!found.limited && GIT_WORD.test(text)) return say.deny('unattended write to a refused name', `it ${say.verb} a file named in \`${text.slice(0, 80)}\`, which names a \`.git\` entry, ${GIT_ENTRY}, and no Human attends this session`);
    for (const [word] of text.matchAll(PATH_IN_TEXT)) {
      const spelled = word.startsWith('~') ? path.join(found.home, word.slice(1)) : word;
      const met = placed(spelled, found, { holds: false });
      if (met?.refused) return say.refused(met.refused, spelled);
    }
  }
  return null;
}
