// The guard that keeps a subagent out of the handoff continuation (docs/handoff.md#continue), with or without gates:
// it may not run `aidrian handoff continue`, which arms a continuation of the main session, nor write in the
// continuation store, `<state>/handoffs/.continue/` (lib/handoff-markers.mjs). A main session the background route
// started (startedUnattended, or its mark in lib/unattended-mark.mjs) is held as a subagent is to the store, and both
// may neither change the unattended marks (unattendedMarkWriteDenial), nor start a host session outside the gate
// (hostSessionStartDenial), nor run the gate with a variable of their own that moves its store, its session, or its
// host command (handoffEnvDenial), nor repoint a remote the plugin reads the team's policy through (remoteChangeDenial),
// nor write in the folder of the project runs, `<state>/runs/` (projectRunWriteDenial), whose ledger says which session
// drives a run and which works each issue. scripts/hook-agent-gates.mjs asks it before every tool call. A host's other
// tools that run a shell command, such as Claude Code's Monitor, reach it as Bash calls (lib/hosts/claude-code.mjs
// hookInput); a command in a shell the shared lexer cannot read (lib/hosts/index.mjs opaqueShellCommand) is read as
// opaque text, and refused when its words may run the gate, or name or reach the store.
// It reads a call's targets as lib/config-guard.mjs does, and, like that guard, it is for agents that cooperate: what
// the shared lexer cannot see, it cannot see either. The known limits of that lexer, which this guard accepts: brace
// expansion (`{a,b}`), ANSI-C quoting (`$'...'`), a link created and written through in one call, the outputs of
// `tar -C` and `curl -o`, a program that runs its arguments as a command (`xargs aidrian ...`, `find ... -exec
// aidrian ...`), and a path built from a variable. The gate's own checks (lib/handoff-markers.mjs) keep what gets past
// harmless: a stray marker of the wrong shape, time, or host process is never delivered.

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { checkDeadline, PastDeadline, remainingMs } from './deadline.mjs';
import { loadConfig } from './config.mjs';
import { runGit } from './git.mjs';
import { bashCall, globNamesFile, opaqueTexts, unquoted, writeTargets } from './config-guard.mjs';
import { foldCase, globParts, isWithin, partsReach } from './fs.mjs';
import { globLinksTo, globStarts, linkWalk } from './glob-links.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { ARMING_FILE, openStore, SESSION_ID, startedInBackground, storePath } from './handoff-markers.mjs';
import { DETECT_VARS, HOSTS, IDENTITY_VARS, mainCheckoutPaths, opaqueShellCommand } from './hosts/index.mjs';
import { defaultStateDir, findProject, stateDir, stateRoot } from './project.mjs';
import { GIT_VARS } from './review/env.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { aidrianArgs, changedVariables, changesVariable, readGit, walkCommands } from './shell-lex.mjs';
import { MARK_FOLDER, markFolders, marksNaming } from './unattended-mark.mjs';

const isSubagent = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';
// How a denial names who may do what it refuses, for a subagent and for a session no Human attends.
const UNATTENDED = 'and the background handoff route started this session, with no Human';

// Whether the session `session` of `project`, whose loaded config is `config`, is one the background handoff route
// started, so no Human attends it: its chain floor, under its full id or a short one, has route `background`
// (handoff-markers.mjs startedInBackground). The floor is looked for in the store of the working copy's state.dir and in
// the store of the base branch's, each where the hook's environment puts it (project.mjs stateDir) and where the user's
// own does (defaultStateDir), which is where the gate keeps it (handoff-continue.mjs backgroundGate). So a session that
// moves state.dir in its working copy is still found, and so is one whose gate ran with an environment other than the
// hook's, as with `XDG_STATE_HOME` unset. lib/config-guard.mjs machineSwitchWriteDenial refuses such a session the
// machine's switches, as it does a subagent. It reads git only when the working copy's stores hold no such floor, and is
// asked only for a call a guard would refuse. A store it cannot read finds nothing. `base` is a baseReader the caller
// shares, so a hook call reads the base branch's config once. `home` is for a test, as in defaultStateDir;
// lib/unattended-mark.mjs keeps the mark that finds such a session outside its project.
export function startedUnattended(project, config, session, { home, base } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  const found = (state) => {
    try {
      return startedInBackground(openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain }), session);
    } catch {
      return false;
    }
  };
  // Lazily, so the working copy's folders are read first, and git only when they hold no floor.
  for (const state of stateFolders(project, config, { home, lazy: true, ...(base ? { base } : {}) })) if (found(state)) return true;
  return false;
}

// The base branch's config of `project`, read once however often it is asked: a function that gives { config },
// { why, failed }, where `failed` is true when the read failed in a repository with a remote, as when a remote-tracking
// ref was deleted or git ran out of time, and false when no base exists to read, as outside git. The agent gate hook
// makes one per call and hands it to every guard and pass. Inside a guard's budget (lib/deadline.mjs) it checks the
// deadline before it reads, and gives each git read the time left as its timeout.
export function baseReader(project) {
  let read;
  return () => (read ??= readBase(project));
}

function readBase(project) {
  checkDeadline();
  const git = () => (Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : undefined);
  const base = baseBranchConfig(project, 'state.dir', git);
  if (!base.why) return { config: base.config };
  const remotes = runGit(['remote'], project.root, git() ?? {});
  return { why: base.why, failed: remotes.status !== 0 ? remotes.status === null : remotes.stdout.trim() !== '' };
}

// The config of the project folder at the main checkout of `project`, where the agent gate hook keeps worktree sessions
// from writing, or null: no main checkout apart from the project's own, or none there.
function mainConfig(project) {
  const main = project.checkouts?.at(-1);
  const current = project.checkouts?.[0];
  if (typeof main !== 'string' || typeof current !== 'string' || main === current) return null;
  const found = findProject(path.join(main, path.relative(current, project.root)));
  return found ? loadConfig(found).config : null;
}

// Every state folder of `project`, whose loaded config is `config`, that a session's handoff store or project runs may
// be kept in: the working copy's state.dir, the main checkout's, and the base branch's, each where the hook's environment
// puts it (project.mjs stateDir) and where the user's own does (defaultStateDir), each once. A working copy that moves
// state.dir still leaves the other folders guarded. A folder that cannot be resolved is left out. With `lazy`, an
// iterator that reads the base branch's config, which runs git, only once the other folders are taken. `base` is a
// baseReader to share; `home` is for a test.
export function stateFolders(project, config, { home, lazy = false, base = baseReader(project) } = {}) {
  const own = (settings) => defaultStateDir(project, { config: settings, ...(home ? { home } : {}) });
  let main;
  const atMain = () => (main ??= mainConfig(project) ?? false);
  const committed = () => base().config ?? null;
  const reads = [
    () => stateDir(project, { config }), () => own(config),
    () => atMain() && stateDir(project, { config: atMain() }), () => atMain() && own(atMain()),
    () => committed() && stateDir(project, { config: committed() }), () => committed() && own(committed()),
  ];
  function* each() {
    const seen = new Set();
    for (const read of reads) {
      let state;
      try {
        state = read();
      } catch (error) {
        if (error instanceof PastDeadline) throw error;
        state = null;
      }
      if (typeof state !== 'string' || seen.has(state)) continue;
      seen.add(state);
      yield state;
    }
  }
  return lazy ? each() : [...each()];
}

// Why the subagent's Bash call in `input` may not run because it runs `aidrian handoff continue`, or null:
// { match, reason }. The gate cannot tell a subagent by itself, since a subagent's shell carries the main session's id.
// It reads the command as lib/rules/decisions-set.mjs does, wherever it runs, refuses a shell fed text it cannot read
// as commands when that text names the action, and refuses a command word it cannot read, as in `aidrian $CMD x.md`,
// unless a later plain word is `check` or `snapshot`, the actions any agent may run. A command word built from a variable
// or a substitution, as in `$AIDRIAN handoff continue x.md`, is refused when its later plain words read `handoff`, then
// `continue`: it may be aidrian, and no other program takes those words. A known limit of the shared lexer:
// a program that runs its arguments as a command, such as `xargs aidrian ...` or `find ... -exec aidrian ...`, is not
// read as aidrian. A command in a shell the lexer cannot read is refused when it holds the words `handoff` and
// `continue`, in any case and order, as given or with that shell's joins undone (opaqueTexts), as in `hand`off`: such a
// shell may build the call from them, and the guard cannot tell.
export function handoffContinueDenial(input, { names: { human } }) {
  if (!isSubagent(input)) return null;
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  const texts = opaque === null ? [] : opaqueTexts(opaque);
  if (opaque !== null ? !opaqueRuns(texts, ['continue']) : !walkCommands(command, null).some(runsGate(['continue']))) return null;
  const why = 'it runs `aidrian handoff continue`, which arms a continuation of the main session, and only the main session may run it';
  return { match: 'runs aidrian handoff continue', reason: projectRuleReason(input, why, human, 'that the brief is checked; the main session runs the gate') };
}

// Whether the texts of a command no lexer reads hold `handoff` and one of `actions`, in any case and order.
const opaqueRuns = (texts, actions) => [/\bhandoff\b/iu, new RegExp(String.raw`\b(?:${actions.join('|')})\b`, 'iu')].every((word) => texts.some((text) => word.test(text)));

// Whether a command walkCommands read runs `aidrian handoff <action>` for one of `actions`, read as handoffContinueDenial
// says: a command word or action it cannot read counts, unless a later plain word is `check` or `snapshot`.
const runsGate = (actions) => ({ invocation, unread }) => {
  const names = actions.join('|');
  if (unread !== undefined && new RegExp(String.raw`\bhandoff\b[^\n;|&]*\b(?:${names})\b`, 'u').test(unread)) return true;
  if (invocation.dynamic) {
    const words = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
    const at = words.indexOf('handoff');
    if (at !== -1 && actions.some((action) => words.includes(action, at + 1))) return true;
  }
  const [first, ...rest] = aidrianArgs(invocation) ?? [];
  if (!first) return false;
  if (first.dynamic) return !rest.some((token) => !token.dynamic && ['check', 'snapshot'].includes(token.text));
  if (first.text !== 'handoff') return false;
  const action = rest.find((token) => !token.text.startsWith('-'));
  return action?.dynamic === true || rest.some((token) => actions.includes(token.text));
};

// Every `aidrian project` subcommand, today's and those a later step adds (lib/project-run-guard.mjs).
export const PROJECT_SUBCOMMANDS = Object.freeze(['init', 'next', 'start', 'wait', 'result', 'handoff', 'resume', 'summary', 'report', 'recorded', 'stop-action']);
// A subcommand word, and the word `project`, in any case, as a text no lexer reads names them; lib/project-run-guard.mjs
// reads them too.
export const PROJECT_SUB = new RegExp(String.raw`(?<![\w-])(?:${PROJECT_SUBCOMMANDS.join('|')})(?![\w-])`, 'iu');
export const PROJECT_WORD = /(?<![\w-])project(?![\w-])/iu;

// Whether a command walkCommands read runs `aidrian project`, with any subcommand: as aidrian, or as a command word
// built from a variable, or a shell fed text the lexer cannot read, whose plain words name `project` and a subcommand.
const runsProject = ({ invocation, unread }) => {
  if (unread !== undefined && PROJECT_WORD.test(unread) && PROJECT_SUB.test(unread)) return true;
  const plain = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
  if (invocation.dynamic && plain.includes('project') && plain.some((word) => PROJECT_SUB.test(word))) return true;
  const [first] = aidrianArgs(invocation) ?? [];
  return first !== undefined && !first.dynamic && first.text === 'project';
};

// The variables the gate reads its store, its session, its agent, the host command it runs, and the team's policy from:
// the state root and the home folder (project.mjs stateDir), PATH, which finds the host's command, every variable that
// moves the repository git reads (review/env.mjs GIT_VARS) or gh's config (GH_CONFIG_DIR), where `solo` is read from
// (lib/solo.mjs), and every variable a host names a session or an agent by, or tells itself by (lib/hosts/index.mjs).
// How a shell no lexer reads sets or removes a variable: `$env:NAME`, `NAME=`, or a command that does.
const OPAQUE_SETS = /\$env:|(?<![\w$.-])[A-Za-z_]\w*\s*=|\b(?:set|setx|export|unset|env|remove-item\s+env:)\b/iu;
const GATE_ENV = Object.freeze([...new Set(['XDG_STATE_HOME', 'HOME', 'PATH', 'GH_CONFIG_DIR', ...GIT_VARS, ...IDENTITY_VARS, ...DETECT_VARS])]);

// Why the call in `input` may not run because it runs `aidrian handoff continue`, `aidrian handoff route`, or any
// `aidrian project` subcommand, with any variable set, exported, or unset by the command line itself, or null:
// { match, reason }. A project run's commands read the session id from the environment, as the gate does, and the run's
// driver and issue sessions are known by it (lib/project-run-guard.mjs). GATE_ENV names the ones that
// move what the gate reads, for the reason's wording; every other one is refused too, as the gate needs none. It holds for a subagent and for a session
// `unattended()` says the background route started, asked only for such a command: a store the session moves, or a
// session id it chooses, reads no floor, so its next background start would be held to no count, and the hooks, which
// read the host's own store and session, would not know the session it starts. A variable is changed when a prefix
// assignment, `env`, or a declaring builtin, such as `export`, gives it a value anywhere in the command, or `env -u`,
// `env -i`, `sudo`, or `unset` removes it (shell-lex.mjs changesVariable): with `XDG_STATE_HOME` unset, the store moves
// to the user's own, which the hooks may not read. A command in a shell the lexer cannot read counts when its text names one. A
// variable set in an earlier call, or by a file the command sources, is not seen: the gate's own comparison of its store
// with the host's (handoff-continue.mjs backgroundGate) holds the store there.
export function handoffEnvDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  let named;
  if (opaque !== null) {
    const texts = opaqueTexts(opaque);
    const project = texts.some((text) => PROJECT_WORD.test(text) && PROJECT_SUB.test(text));
    if (!opaqueRuns(texts, ['continue', 'route']) && !project) return null;
    named = GATE_ENV.find((name) => texts.some((text) => new RegExp(String.raw`(?<![\w])${name}(?![\w])`, 'iu').test(text)))
      ?? (texts.some((text) => OPAQUE_SETS.test(text)) ? 'a variable' : null);
  } else {
    const commands = walkCommands(command, null);
    if (!commands.some(runsGate(['continue', 'route'])) && !commands.some(runsProject)) return null;
    // Any variable: the gate runs only with the environment the host gave the session. GATE_ENV names the one it moves.
    const changed = commands.flatMap(({ invocation }) => changedVariables(invocation));
    named = GATE_ENV.find((name) => commands.some(({ invocation }) => changesVariable(invocation, name)))
      ?? changed.find((name) => name !== '*') ?? (changed.length ? 'a variable' : null);
  }
  const subagent = isSubagent(input);
  if (!named || (!subagent && !unattended())) return null;
  const who = subagent ? 'only the main session runs the gate, with the environment its host gave it' : `the gate runs only with the environment the host gave this session, ${UNATTENDED}`;
  const moves = GATE_ENV.includes(named) ? 'which would move the continuation store, the session, or the host command the gate reads, or the policy it reads' : 'and the gate runs with no variable a command sets';
  const why = `it runs \`aidrian handoff\` or \`aidrian project\` with ${named} set or unset by the command itself, ${moves}, and ${who}`;
  return { match: `changes ${named} for aidrian handoff or project`, reason: projectRuleReason(input, why, human, 'that the handoff runs with the environment the host gave the session') };
}

// The hosts that declare their command that starts a session (docs/providers/adding-a-host.md `sessionStart`).
const starters = () => HOSTS.filter((host) => Array.isArray(host.sessionStart?.programs) && typeof host.sessionStart.starts === 'function');
// A program's name as a host declares it: no `.exe` or `.cmd`, in any case.
const programName = (program) => program.replace(/\.(?:exe|cmd)$/iu, '').toLowerCase();
// One of `programs` as a word of a text, by any path, in any case, with `.exe` or `.cmd` or neither.
const programWord = (programs) => new RegExp(String.raw`(?<![\w.-])(?:${programs.map((each) => each.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?:\.exe|\.cmd)?(?![\w.-])`, 'iu');

// Why the call in `input` may not run because it starts or resumes a host's session outside the handoff gate, such as
// `claude -p`, `claude --bg`, or `claude --resume`, or null: { match, reason }. It holds for a subagent and for a session
// `unattended()` says the background route started, asked only for such a command: a session started by hand is held
// to no chain floor, so the hooks would not know it as unattended, and it would start with whatever the command gives it.
// Each host adapter declares its own command (`sessionStart`), and every host's counts whatever host runs the session.
// A command a shell runs that the lexer cannot read, or a command in a shell it cannot read, counts when it names such a
// program as a word. A known limit of the shared lexer, as in handoffContinueDenial: a program that runs its arguments
// as a command, such as `xargs claude` or `npx`, and a command word built from a variable, are not read.
export function hostSessionStartDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  const hosts = starters();
  // The host whose program `text`, which no lexer read, names as a word.
  const namedIn = (text) => hosts.find((each) => programWord(each.sessionStart.programs).test(text));
  const read = ({ invocation, unread }) => (unread !== undefined ? namedIn(unread) : null)
    ?? (invocation.dynamic ? null : hosts.find((each) => each.sessionStart.programs.includes(programName(invocation.program)) && each.sessionStart.starts(invocation.args)));
  const host = opaque !== null ? opaqueTexts(opaque).map(namedIn).find(Boolean) : walkCommands(command, null).map(read).find(Boolean);
  const subagent = isSubagent(input);
  if (!host || (!subagent && !unattended())) return null;
  const who = subagent ? 'only the main session hands off, through `aidrian handoff continue`' : `a session starts another only through \`aidrian handoff continue\`, ${UNATTENDED}`;
  const why = `it starts or resumes a ${host.name} session outside the handoff gate, which holds every session it starts to a chain floor, and ${who}`;
  return { match: `starts a ${host.name} session`, reason: projectRuleReason(input, why, human, 'to start or resume that session') };
}

// The `git remote` actions that point a remote at another repository, or move the ref of its default branch.
const REMOTE_ACTIONS = new Set(['add', 'set-url', 'rename', 'set-head']);
// A remote-tracking ref: a project run cuts and checks each issue's worktree against origin's default branch.
const TRACKING_REF = /^refs\/remotes\//u;
// The git config keys that decide which repository a remote names, or what a git command runs, in any case: every key of
// a remote (its URLs, and `gh-resolved`, gh's default repository), an included file, a URL rewrite, and an alias.
const POLICY_KEY = /^(?:remote\..+|include\.path|includeif\..+|url\..+|alias\..+)$/iu;
// The `git config` forms that only read: the options of the older form, and the actions of the newer one.
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', 'get', 'list']);
// The forms that write a key they name.
const CONFIG_WRITES = new Set(['--unset', '--unset-all', '--add', '--replace-all', 'set', 'unset']);
// The forms that write keys they do not name: an editor, and a whole section renamed or removed.
const CONFIG_ANY = new Set(['-e', '--edit', '--rename-section', '--remove-section', 'edit', 'rename-section', 'remove-section']);
// The `git config` options that take the next word as their value.
const CONFIG_VALUES = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
// The text of a command no lexer reads that may change a remote: the words of such a git or gh call, in any order.
const REMOTE_TEXTS = [
  [/\bremote\b/iu, /(?<![\w-])(?:add|set-url|rename|set-head)(?![\w-])/iu],
  [/\b(?:update-ref|symbolic-ref)\b/iu, /refs\/remotes\/|--stdin/iu],
  [/\b(?:fetch|push)\b/iu, /:refs\/remotes\//iu],
  [/\bbranch\b/iu, /(?<![\w-])(?:-[a-z]*r[a-z]*|--remotes)(?![\w-])/iu, /(?<![\w-])(?:-[a-z]*[dD][a-z]*|--delete)(?![\w-])/u],
  [/\bconfig\b/iu, /\b(?:remote\.\S+|include\.path|includeif\.\S+|url\.\S+|alias\.\S+)/iu],
  [/\bconfig\b/iu, /(?<![\w-])(?:--edit|--rename-section|--remove-section|rename-section|remove-section)(?![\w-])/iu],
  [/\brepo\b/iu, /\bset-default\b/iu],
  [/\balias\b/iu, /(?<![\w-])(?:set|import)(?![\w-])/iu],
];

// What the words after `git config` do: { any, explicit, reads, named, scope }. `any` when they write keys they do not
// name (CONFIG_ANY), `explicit` when they name a form that writes (CONFIG_WRITES), `reads` when they name one that only
// reads, `named` the words that are no option, and `scope` the config file they choose: { global, system, worktree,
// file }, with `file` the word after `-f` or `--file`, or null. `writes` is any of the first two, or a key with a value
// and no read form: everything but a read, a list, or a key alone.
export function configForm(words) {
  const named = [];
  const scope = { global: false, system: false, worktree: false, file: null };
  let reads = false;
  for (let i = 0; i < words.length; i += 1) {
    const text = words[i];
    // git config stops reading options at its first word that is none: a later `--get` or `-l` is a value pattern, and
    // `get` or `list` is an action only as that first word.
    if (named.length === 0 && text.startsWith('-') && CONFIG_READS.has(text)) reads = true;
    if (['--global', '--system', '--worktree'].includes(text)) scope[text.slice(2)] = true;
    if (text.startsWith('--file=')) scope.file = text.slice('--file='.length);
    if (CONFIG_VALUES.has(text)) {
      if (text === '-f' || text === '--file') scope.file = words[i + 1] ?? '';
      i += 1;
    } else if (!text.startsWith('-')) {
      if (named.length === 0 && (text === 'get' || text === 'list')) reads = true;
      named.push(text);
    }
  }
  const any = words.some((text) => CONFIG_ANY.has(text));
  const explicit = words.some((text) => CONFIG_WRITES.has(text));
  return { any, explicit, reads, named, scope, writes: any || explicit || (!reads && named.length >= 2) };
}

// Whether the words after `git config` write: any form in CONFIG_ANY; else, when they name a POLICY_KEY, a form in
// CONFIG_WRITES, or no read form and a value after the key (configForm).
function configWrites(words) {
  const form = configForm(words);
  if (form.any) return true;
  if (!form.named.some((text) => POLICY_KEY.test(text))) return false;
  return form.writes;
}

// Whether git's global options set an alias for the one command: `-c alias.<name>=...`, attached or not, or
// `--config-env alias.<name>=<variable>`.
const aliasGlobal = (globals) => globals.some((token, i) => {
  const value = ['-c', '--config-env'].includes(token.text) ? globals[i + 1]?.text : /^(?:-c|--config-env=)(.*)$/su.exec(token.text)?.[1];
  return typeof value === 'string' && /^alias\./iu.test(value);
});

// Whether one command the walk read changes a remote, gh's default repository, or how git reads either: `git remote
// add`, `set-url`, or `rename`; a `git config` write of a remote, include, URL, or alias key (configWrites), or an edit,
// rename, or removal of a section; an alias given by `-c` or `--config-env`; `git update-ref` of a remote-tracking ref,
// or with `--stdin`, whose refs it cannot see; `git symbolic-ref` that writes or deletes one; `git remote set-head`;
// `git branch` deleting remote-tracking branches; a fetch or push refspec whose destination is under refs/remotes/;
// `gh repo set-default` without `--view`;
// or `gh alias set` or `import`. A command whose program is a variable or a substitution, and a git or gh call whose
// words the lexer cannot all read, count when their plain words name such an action.
function changesRemote({ segment, invocation, unread }) {
  if (unread !== undefined && REMOTE_TEXTS.some((words) => words.every((word) => word.test(unread)))) return true;
  const plain = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
  const ours = invocation.dynamic || invocation.program === 'git' || invocation.program === 'gh';
  if (ours && (invocation.dynamic || invocation.args.some((token) => token.dynamic))) {
    if (REMOTE_TEXTS.some((words) => words.every((word) => plain.some((text) => word.test(text))))) return true;
  }
  if (invocation.program === 'gh') {
    const after = (first, then) => {
      const at = plain.indexOf(first);
      return at !== -1 && plain.slice(at + 1).some((text) => then.includes(text));
    };
    if (after('alias', ['set', 'import'])) return true;
    return after('repo', ['set-default']) && !plain.some((text) => text === '--view' || text === '-v');
  }
  const git = invocation.program === 'git' ? readGit(segment) : null;
  if (!git) return false;
  if (aliasGlobal(git.globals)) return true;
  const words = git.rest.filter((token) => !token.dynamic).map((token) => token.text);
  if (git.subcommand === 'remote') return REMOTE_ACTIONS.has(words.find((text) => !text.startsWith('-')));
  if (git.subcommand === 'config') return configWrites(words);
  if (git.subcommand === 'update-ref') return words.includes('--stdin') || words.some((text) => TRACKING_REF.test(text));
  // `git branch -d -r origin/main`: a deletion of remote-tracking branches, in any spelling of the flags.
  if (git.subcommand === 'branch') {
    const short = words.filter((text) => /^-[A-Za-z]+$/u.test(text)).join('');
    const remotes = words.includes('--remotes') || short.includes('r');
    return remotes && (words.includes('--delete') || /[dD]/u.test(short));
  }
  // A refspec whose destination is a remote-tracking ref, as `git fetch . +HEAD:refs/remotes/origin/main` or
  // `git push . :refs/remotes/origin/main` writes.
  if (git.subcommand === 'fetch' || git.subcommand === 'push') return words.some((text) => !text.startsWith('-') && text.includes(':') && TRACKING_REF.test(text.slice(text.lastIndexOf(':') + 1)));
  // symbolic-ref writes with a second operand, or deletes; with one, it reads.
  if (git.subcommand === 'symbolic-ref') {
    const operands = words.filter((text) => !text.startsWith('-'));
    return TRACKING_REF.test(operands[0] ?? '') && (operands.length > 1 || words.some((text) => ['-d', '--delete'].includes(text)));
  }
  return false;
}

// Why the call in `input` may not run because it changes which repository the checkout's remotes or gh's default
// name, or null: { match, reason }. The plugin reads the team's policy from that repository on the forge, such as
// `solo` (lib/solo.mjs) and the auto-merge and waiver ceilings, so a session that repoints origin could read its own.
// It holds for a subagent and for a session `unattended()` says the background route started, asked only for such a
// command. A command in a shell the lexer cannot read counts when its text names such an action. Known limits, as for
// the other guards here: a write by its path to `.git/config`, a file it includes, or gh's own config folder; a program
// that runs its arguments as a command, such as `xargs git ...`; and a git subcommand held in a variable, as in
// `git $ACTION ...`, whose later words name no such action.
export function remoteChangeDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  // Every form it refuses names one of these words, however quoted, so a call with none of them is not walked.
  if (typeof command !== 'string' || !/remote|config|repo|alias|update-ref|symbolic-ref|branch/iu.test(unquoted(command))) return null;
  const hit = opaque !== null
    ? REMOTE_TEXTS.some((words) => words.every((word) => opaqueTexts(opaque).some((text) => word.test(text))))
    : walkCommands(command, null).some(changesRemote);
  const subagent = isSubagent(input);
  if (!hit || (!subagent && !unattended())) return null;
  const who = subagent ? 'only the main session changes them' : `only a session the Human attends changes them, ${UNATTENDED}`;
  const why = `it changes which repository the checkout's git remotes or gh's default name, or how git reads them, where the plugin reads the team's policy on the forge, such as solo, or a remote-tracking ref, which names the commit a project run cuts each issue from, and ${who}`;
  return { match: 'changes a git remote', reason: projectRuleReason(input, why, human, 'to change the remote') };
}

// A path part named as a file whose forgery would arm or deliver a continuation, in any case. A chain floor or a task
// record (`from-`, `tasks-`) is not one: their names are common words, and the path rules cover them.
const MARKER_NAME = new RegExp(ARMING_FILE.source, 'iu');
// An unsure glob's part whose plain start names such a file, as `armed-*`.
const MARKER_GLOB = /^(?:armed|ready|taken|gone|checked|started|claim|continued)-/iu;
// A word of a command no lexer reads that names the store's folder by its own name.
const STORE_FOLDER = /^\.continue$/iu;
// A text that names the store's folder, or a marker in it.
const STORE_NAME = /(?<![\w.-])(?:handoffs\/\.continue(?![\w-])|\.continue\/(?:armed|ready|from|checked|gone|tasks|taken|started|claim|continued)-)/iu;
// A path part a change of mode or owner reaches the store through: its folder, or the handoffs folder that holds it.
const STORE_PART = /^(?:handoffs|\.continue)$/iu;
// The programs that change a file's mode or owner. A store, handoffs, or state folder every user may write, or a marker
// no read can open, reads as no store (handoff-markers.mjs openStore, readMarker), which would hide a chain floor.
const MODE_PROGRAMS = new Set(['chmod', 'chown', 'chgrp']);

// The operands of each change of mode or owner the Bash call in `input` runs: { text, folder, recursive }, where `folder`
// is the folder it runs in, or null when it cannot be known. A mode such as `755` reads as one more operand, which names
// no file of the store. One with a word built from a variable is left out: a known limit, as for every path built so.
export function modeTargets(input) {
  if (!bashCall(input) || typeof input.tool_input?.command !== 'string') return [];
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  return walkCommands(input.tool_input.command, cwd).filter(({ invocation }) => MODE_PROGRAMS.has(invocation.program)).flatMap(({ invocation, folder }) => {
    const recursive = invocation.args.some(({ text }) => /^-[A-Za-z]*R/u.test(text) || text === '--recursive');
    return invocation.args.filter((token) => !token.dynamic && token.text !== '' && token.text !== '--')
      .map(({ text }) => ({ text: /^~(?=$|\/)/u.test(text) ? path.join(homedir(), text.slice(1)) : text, folder, recursive }));
  });
}
// A disk that folds case reaches the store by any spelling of its path.
const fold = foldCase;
const FOLD_FLAG = foldCase('A') === 'a' ? 'i' : '';
const real = (file) => {
  checkDeadline();
  return fold(canonical(file));
};

// Whether a text from a folder no path gives names the store or one of its files.
const namesStore = (text) => STORE_NAME.test(text) || text.split('/').some((part) => MARKER_NAME.test(part));
// Whether a glob from a folder no path gives may name one of those files.
const globNamesStore = (text) => namesStore(text) || text.split('/').some((part) => MARKER_GLOB.test(part.split(/[*?[]/u)[0]) && GLOB.test(part));

const GLOB = /[*?[]/u;
// The store's folder and the one that holds it, as a glob from any folder may name them.
const STORE_TAIL = path.join('handoffs', '.continue');

// Each spelling of a glob write from a known folder, as { prefix, rest }: `prefix` is the real, case-folded path of its
// parts before the first glob, and `rest` the parts from there on, a glob or a plain name each (globStarts).
export const globPaths = (glob) => globStarts(glob).map(({ start, rest }) => ({ prefix: real(start), rest }));

// Whether a glob write reaches the store: each part it spells matches the store's part at that depth, so it names the
// store, a file in it, or a folder that holds it. A part that is only stars, such as zsh's `**`, matches any number of
// parts, none included (partsReach, which never recurses, so no glob of many parts can run the guard out of stack).
export function globReaches({ prefix, rest }, store) {
  // The root splits to two empty parts: only the first stands for it.
  const split = (file) => file.split(path.sep).filter((part, i) => i === 0 || part !== '');
  checkDeadline();
  const matches = (part, name) => (GLOB.test(part) ? globParts(part, [], FOLD_FLAG).pattern.test(name) : fold(part) === name);
  return partsReach([...split(prefix), ...rest], split(store), matches, true);
}

// Why the call in `input` may not run because it writes in the continuation store of the state folder `state`
// gives, or null: { match, reason }. It holds for a subagent, and for a main session `unattended()` says the background
// route started, asked only once a call reaches the store, and before it runs: a delete of the session's own floor is
// judged while the floor is there. A change of mode or owner (MODE_PROGRAMS) of the store, a file in it, its handoffs
// folder, or the state folder, or a recursive one of a folder that holds the store, counts as a write, as does one of a
// path in a folder no path gives whose parts name `handoffs` or `.continue`. `state` is called only when a target may
// lie in the store, so a call that writes nowhere near the state root runs no git. It writes there when a target lies in the store, or is a folder that holds
// it and no checkout, or a glob may reach the store, by the path it spells or through a link already on disk in any part
// it expands (globLinksTo), as `tee /tmp/alias*` does when `/tmp/alias` links to a marker, and `/va*/...` through
// macOS's `/var`; `state` may give one folder or a list (stateFolders), each guarded; a target in a folder no path names, or code an interpreter runs,
// counts when it names `handoffs/.continue`, a marker below `.continue/`, or a path part named as a file that arms or
// delivers (MARKER_NAME), or, for a glob, starts as one (MARKER_GLOB). A glob word of a command in a shell the lexer
// cannot read counts by those names, and when it names the store by its name, as `.con*`, `han*`, or `handoffs/*` do, from any folder
// (globNamesFile), since such a shell may change its folder first. Such a command may only read what it names, so its
// block says it may change the store. With `links` false it skips the link walk, which reads folders on disk, so the
// agent gate hook asks it so first, and again with the walk after the other guards' cheaper checks.
export function continueStoreWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false, base = baseReader(project), home } = {}) {
  const subagent = isSubagent(input);
  const opaque = opaqueShellCommand(input) !== null;
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const writer = subagent ? 'only the main session\'s `aidrian handoff` commands write' : `only \`aidrian handoff\` commands write, ${UNATTENDED}`;
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the handoff continuation store, where ${writer}`, human);
  // Asked last, once a call reaches the store: it reads the store, and git for the base branch's config.
  const held = () => subagent || unattended();
  // A command no lexer reads may join `.continue` to a path it builds, as a path joiner does.
  const joined = opaque && names.some((name) => name.split('/').some((part) => STORE_FOLDER.test(part)));
  const unsure = (glob) => ((glob.unsure || glob.opaque) && globNamesStore(glob.text)) || (glob.opaque && globNamesFile(glob.text, STORE_TAIL));
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const placed = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder, recursive }) => ({ target: real(path.resolve(folder ?? '/', text)), recursive }));
  const namedMode = unplaced.some(({ text }) => namesStore(text) || text.split('/').some((part) => STORE_PART.test(part)));
  if (joined || names.some(namesStore) || globs.some(unsure) || namedMode) {
    return held() ? { match: 'may change the continuation store', reason: why('may change', 'handoffs/.continue') } : null;
  }
  const sure = globs.filter((glob) => !glob.unsure);
  const known = sure.flatMap(globPaths);
  if (files.length === 0 && known.length === 0 && placed.length === 0) return null;
  const root = real(stateRoot());
  const near = (target) => isWithin(root, target) || isWithin(target, root);
  // A glob anywhere may pass a link into the state root; the walk reads each folder once a call (linkWalk).
  const seen = linkWalk(input);
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
  const roots = project.checkouts.map(real);
  const targets = [...files.map(real), ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)];
  if (inCheckouts(targets, roots, root) && !linksTo(root)) return null;
  if (!dir && !targets.some(near) && !linksTo(root) && !movesState(base)) return null;
  for (const folder of folders(state)) {
    const store = real(storePath(folder));
    const shields = [real(folder), real(path.join(folder, 'handoffs'))];
    if (!reaches({ files: files.map(real), known, placed, linksTo }, store, shields, roots)) continue;
    if (!held()) return null;
    const verb = opaque ? 'may change' : 'changes';
    return { match: `${verb} the continuation store`, reason: why(verb, store) };
  }
  return base().failed && held() && holdsState(project, state, home) ? unreadableBase(input, human) : null;
}

// Whether a real, case-folded path lies in the work, git, or drop folder of the attempt folder `own()` gives, the real
// path of the attempt a confined host's session works in (project-run-guard.mjs ownAttemptFolder), read only when a
// write reaches the runs folder: the folders that session writes (lib/project-start.mjs). None when `own` is null or
// gives none.
function ownAttempt(own) {
  let folder;
  const named = () => (folder ??= (typeof own === 'function' ? own() : null) ?? false);
  return (target) => {
    if (typeof target !== 'string' || !named()) return false;
    const base = fold(named());
    return ['work', 'git', 'drop'].some((part) => isWithin(path.join(base, part), target));
  };
}

// The state folders `state` gives: one folder, or a list (stateFolders).
const folders = (state) => [].concat(state() ?? []).filter((each) => typeof each === 'string');

// Whether the folder `dir` holds any entry: false when it is not there, true when it cannot be read.
function hasEntries(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch (error) {
    return !['ENOENT', 'ENOTDIR'].includes(error.code);
  }
}

// Whether `project` keeps a project run or a held session where a guard can look while the base branch's config cannot
// be read: a run or a continuation store entry in a state folder `state` gives, or an unattended mark, or a pending one,
// that names one of its checkouts (unattended-mark.mjs marksNaming). A project with neither has nothing such a write
// could change, so its subagents write outside the checkout as they did before project runs, as in a repository whose
// origin was added and never fetched.
const holdsState = (project, state, home) => folders(state).some((folder) => hasEntries(path.join(folder, RUNS_FOLDER)) || hasEntries(storePath(folder)))
  || marksNaming(project.checkouts ?? [], home ? { home } : {});

// The refusal of a held write outside every checkout of a project that keeps a run or a held session, while the base
// branch's config, which says where it keeps them, cannot be read.
const unreadableBase = (input, human) => ({
  match: 'writes outside the checkouts while the base config cannot be read',
  reason: projectRuleReason(input, 'it writes outside every checkout of this project, which keeps a project run or a session no Human attends, and the base branch\'s config.json, which says where the project keeps their state, cannot be read, so whether the write changes that state cannot be told; fetch the default branch, then try again', human),
});

// Whether every target lies inside one of the project's checkouts and none holds the state root `root`: a state folder
// is never kept inside a checkout (project-run.mjs runPlace, handoff-markers.mjs openStore), so such a write reaches none.
const inCheckouts = (targets, roots, root) => targets.length > 0 && targets.every((target) => roots.some((each) => isWithin(each, target)) && !isWithin(target, root));

// Whether the base branch's config may keep the state folder elsewhere than the working copy says: it commits a
// state.dir, or cannot be read. `base` is the hook call's baseReader, read only for a write outside every checkout.
const movesState = (base) => base().config?.state?.dir != null || Boolean(base().why);

// Whether the write targets of a call reach `folder`, a real, case-folded path: a file target lies in it, or holds it
// and none of `roots`, the project's checkouts; a glob may reach it by the path it spells (globReaches) or through a
// link (`linksTo`); or a change of mode or owner lies in it, is one of `shields`, the folders whose mode hides it, or is
// recursive and holds it. `files` are real paths, `known` globPaths' spellings, `placed` modeTargets' placed ones.
function reaches({ files, known, placed, linksTo }, folder, shields, roots) {
  const holds = (target) => target !== folder && isWithin(target, folder);
  return files.some((target) => isWithin(folder, target) || (holds(target) && !roots.some((each) => isWithin(target, each))))
    || known.some((glob) => globReaches(glob, folder)) || linksTo(folder)
    || placed.some(({ target, recursive }) => isWithin(folder, target) || shields.includes(target) || (recursive && holds(target)));
}

// A path part that names the unattended marks' folder, in any case.
const MARK_PART = new RegExp(String.raw`^${MARK_FOLDER}$`, 'iu');
// The folder as a glob from any folder may name it: by its own name, or with the state root's above it.
const MARK_TAIL = path.join('aidrian', MARK_FOLDER);

// Why the call in `input` may not run because it changes the unattended marks (lib/unattended-mark.mjs), or null:
// { match, reason }. It holds for a subagent, and for a main session `unattended()` says no Human attends, asked last,
// once a call reaches the marks: a session that deletes its own mark would lift what the mark holds it to wherever it
// runs. It holds with or without a project; `project`, when there is one, keeps a write to a folder that holds both
// the marks and its checkouts, such as the home folder, its own, as the store guard does. A call reaches the marks when
// a target lies in one of `folders` (markFolders), or holds it, or a glob may reach it by its path or through a link
// already on disk; a change of mode or owner counts there too, and on the state root that holds the folder. A target
// in a folder no path gives, and a word of a command in a shell the lexer cannot read, count when a part of it is named
// `unattended`, or, for a glob, may name it (globNamesFile). With `links` false it skips the link walk.
export function unattendedMarkWriteDenial(input, { names: { human } }, { project = null, links = true, unattended = () => false, folders = markFolders() } = {}) {
  const subagent = isSubagent(input);
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0 && modes.length === 0) return null;
  const named = (text) => text.split(/[\\/]/u).some((part) => MARK_PART.test(part));
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const byName = names.some(named) || unplaced.some(({ text }) => named(text))
    || globs.some((glob) => (glob.unsure || glob.opaque) && (named(glob.text) || globNamesFile(glob.text, MARK_TAIL, { folderParts: 0 })));
  let hit = byName;
  if (!hit) {
    const placed = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder, recursive }) => ({ target: real(path.resolve(folder ?? '/', text)), recursive }));
    const sure = globs.filter((glob) => !glob.unsure);
    const known = sure.flatMap(globPaths);
    const targets = files.map(real);
    const marks = folders.map((folder) => ({ mark: real(folder), root: real(path.dirname(folder)) }));
    const near = (target) => marks.some(({ root }) => isWithin(root, target) || isWithin(target, root));
    const seen = links ? linkWalk(input) : null;
    const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
    if (![...targets, ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)].some(near) && !marks.some(({ root }) => linksTo(root))) return null;
    const roots = (project?.checkouts ?? []).map(real);
    hit = marks.some(({ mark, root }) => reaches({ files: targets, known, placed, linksTo }, mark, [root], roots));
  }
  if (!hit || !(subagent || unattended())) return null;
  const opaque = opaqueShellCommand(input) !== null;
  const verb = opaque || byName ? 'may change' : 'changes';
  const writer = subagent ? 'which only the handoff gate writes' : `which only the handoff gate writes, ${UNATTENDED}`;
  const why = `it ${verb} the unattended marks, ${MARK_TAIL}, which tell the hooks a session no Human attends wherever it runs, and ${writer}`;
  return { match: `${verb} the unattended marks`, reason: projectRuleReason(input, why, human) };
}

// The folder of every project run under a state folder, as lib/project-run.mjs runsFolder names it; that file imports
// this one, so the name is kept here too, and test/project-start-guard.test.mjs holds the two equal.
export const RUNS_FOLDER = 'runs';
// A text from a folder no path gives that names a run's folder or its ledger: `runs/<run id>`, or `ledger.jsonl`.
const RUN_NAME = /(?:^|\/)runs\/[a-z0-9*?[][a-z0-9*?[\]-]{0,63}(?:\/|$)|(?:^|\/)ledger\.jsonl$/iu;

// Why the call in `input` may not run because it writes in the folder of the project runs, `<state>/runs/`, of the state
// folder `state` gives, or null: { match, reason }. A run's ledger says which session drives the run and which works each
// issue, its snapshot which issues there are, and its results what each issue's session recorded, and only `aidrian
// project` writes them. It holds for a subagent, and for a main session `unattended()` says no Human attends, such as an
// issue's own session, asked once a call reaches the folder. A call reaches it as continueStoreWriteDenial's reaches the
// continuation store: a target in it, or a folder that holds it and no checkout, a glob that may reach it by its path or
// through a link (with `links`), or a change of mode or owner of it, a file in it, or the state folder. A target in a
// folder no path gives, and a word of a command in a shell the lexer cannot read, count when they name `runs/<run id>`
// or a `ledger.jsonl` (RUN_NAME). `state` gives one folder or a list (stateFolders): the base branch's state.dir is
// guarded whatever the working copy's config says. When the base branch's config cannot be read in a repository with a
// remote (`base`, a baseReader), a held session's write outside every checkout is refused when the project keeps a run
// or a held session (holdsState): the folder is unknown. The store guard asks the same first. `own`, when given, names
// the attempt folder of a confined session (ownAttempt), whose work, git, and drop folders it may write.
export function projectRunWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false, base = baseReader(project), home, own = null } = {}) {
  const subagent = isSubagent(input);
  const opaque = opaqueShellCommand(input) !== null;
  const { files: written, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const writer = subagent ? 'only the main session\'s `aidrian project` commands write' : `only \`aidrian project\` commands write, ${UNATTENDED}`;
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the folder of the project runs, whose ledger names the session that drives each run and the session that works each issue, where ${writer}`, human);
  const held = () => subagent || unattended();
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  if (names.some((name) => RUN_NAME.test(name)) || globs.some((glob) => (glob.unsure || glob.opaque) && RUN_NAME.test(glob.text)) || unplaced.some(({ text }) => RUN_NAME.test(text))) {
    return held() ? { match: 'may change the project runs', reason: why('may change', `${RUNS_FOLDER}/`) } : null;
  }
  const mine = ownAttempt(own);
  const placed = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder, recursive }) => ({ target: real(path.resolve(folder ?? '/', text)), recursive }))
    .filter(({ target }) => !mine(target));
  const sure = globs.filter((glob) => !glob.unsure);
  const known = sure.flatMap(globPaths).filter(({ prefix }) => !mine(prefix));
  const files = written.filter((file) => !mine(real(file)));
  if (files.length === 0 && known.length === 0 && placed.length === 0) return null;
  const root = real(stateRoot());
  const near = (target) => isWithin(root, target) || isWithin(target, root);
  const seen = linkWalk(input);
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
  const roots = project.checkouts.map(real);
  const targets = [...files.map(real), ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)];
  if (inCheckouts(targets, roots, root) && !linksTo(root)) return null;
  if (!dir && !targets.some(near) && !linksTo(root) && !movesState(base)) return null;
  for (const folder of folders(state)) {
    const runs = real(path.join(folder, RUNS_FOLDER));
    if (!reaches({ files: files.map(real), known, placed, linksTo }, runs, [real(folder)], roots)) continue;
    if (!held()) return null;
    const verb = opaque ? 'may change' : 'changes';
    return { match: `${verb} the project runs`, reason: why(verb, runs) };
  }
  return base().failed && held() && holdsState(project, state, home) ? unreadableBase(input, human) : null;
}

// Why the call in `input` may not run because it writes a main-checkout path a session in a linked worktree reads, or
// null: { match, reason }. Each host declares those paths (lib/hosts/index.mjs mainCheckoutPaths), such as Claude Code's
// .claude/settings.local.json and its skills, agents, and commands folders, under the main checkout of `project`. A
// project run starts an issue's session only under files there a review saw or a settings file its host's check takes
// (lib/project-trust.mjs mainCheckoutProblem), so a session `unattended()` says no Human attends, and any subagent while
// `runSession()` says the project has a run under way (project-run-guard.mjs projectRunActive), may not write them:
// entries there come from a session the Human attends. In a project with no run, a subagent may. A call reaches them as the store guard's reaches
// the store: a target in one or a folder that holds one, a glob that may reach one, or a change of mode or owner. A
// target in a folder no path gives, and a word of a shell the lexer cannot read, count when they name such a path from
// the checkout's root. With `links` false it skips the link walk.
export function mainCheckoutWriteDenial(input, project, { names: { human } }, { links = true, unattended = () => false, runSession = () => false } = {}) {
  const main = project?.checkouts?.at(-1);
  if (typeof main !== 'string') return null;
  const { folders, settings } = mainCheckoutPaths();
  const declared = [...folders, ...settings.map((each) => each.file)];
  if (declared.length === 0) return null;
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0 && modes.length === 0) return null;
  const subagent = isSubagent(input);
  const held = () => unattended() || (subagent && runSession());
  const writer = subagent ? 'which no subagent writes while a project run is under way, or under a session no Human attends' : `which only a session the Human attends writes, ${UNATTENDED}`;
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, which the host reads from the main checkout in every worktree session, ${writer}`, human);
  const spelled = (text) => declared.some((each) => text === each || text.startsWith(`${each}/`) || text.endsWith(`/${each}`) || text.includes(`/${each}/`));
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  if (names.some(spelled) || globs.some((glob) => (glob.unsure || glob.opaque) && spelled(glob.text)) || unplaced.some(({ text }) => spelled(text))) {
    return held() ? { match: 'may change the main checkout\'s host files', reason: why('may change', declared.join(', ')) } : null;
  }
  const placed = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder, recursive }) => ({ target: real(path.resolve(folder ?? '/', text)), recursive }));
  const sure = globs.filter((glob) => !glob.unsure);
  const known = sure.flatMap(globPaths);
  const seen = links ? linkWalk(input) : null;
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
  const roots = project.checkouts.map(real);
  const root = real(main);
  for (const each of declared) {
    const target = real(path.join(main, each));
    if (!reaches({ files: files.map(real), known, placed, linksTo }, target, [], roots.filter((one) => one !== root))) continue;
    if (!held()) return null;
    const verb = opaqueShellCommand(input) !== null ? 'may change' : 'changes';
    return { match: `${verb} the main checkout's host files`, reason: why(verb, target) };
  }
  return null;
}
