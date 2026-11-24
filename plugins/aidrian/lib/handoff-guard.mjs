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

import { opendirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { checkDeadline, PastDeadline, remainingMs } from './deadline.mjs';
import { loadConfig } from './config.mjs';
import { bashCall, globNamesFile, opaqueTexts, unquoted, writeTargets } from './config-guard.mjs';
import { foldCase, globParts, isEntry, isWithin, partsReach } from './fs.mjs';
import { GIT_TIMEOUT_MS, runGit, withGitFacts } from './git.mjs';
import { changesGitTarget } from './git-push.mjs';
import { globLinksTo, globStarts, linkWalk } from './glob-links.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { ARMING_FILE, madeWorktrees, openStore, SESSION_ID, startedFolders, startedInBackground, storePath } from './handoff-markers.mjs';
import { DETECT_VARS, HOSTS, IDENTITY_VARS, localServices, mainCheckoutPaths, opaqueShellCommand } from './hosts/index.mjs';
import { unwrapped } from './package-runner.mjs';
import { defaultStateDir, findProject, projectCheckouts, stateDir, stateRoot } from './project.mjs';
import { GIT_VARS } from './review/env.mjs';
import { SIGNOFF_FOLDER, signoffFolders } from './review/signoff-store.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { SESSION_FILES } from './session-folder.mjs';
import { ORIGIN_FOLDER, originFolders, readOrigins } from './session-origins.mjs';
import { aidrianArgs, changedVariables, changesVariable, readGit, walkCommands } from './shell-lex.mjs';
import { TERMINAL_FOLDER, terminalFolders } from './terminal-replace.mjs';
import { isAttended, issueHeld, MARK_FOLDER, markFolders, marksNaming } from './unattended-mark.mjs';

const isSubagent = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';
// How a denial names who may do what it refuses, for a subagent and for a session no Human attends.
const UNATTENDED = 'and the background handoff route started this session, with no Human';
// The same for a project run's driver, which its driver mark holds from the run's stores from its first call, with no
// unattended mark of its own (scripts/hook-agent-gates.mjs): DRIVES while it drives the run, DROVE for the marks and the
// sign-off store, which hold it after the run's end too (run-driver.mjs droveRun).
const DRIVES = 'and this session drives a project run, which no Human attends';
const DROVE = 'and this session has driven a project run, whose driver mark holds it as one no Human attends';
// Why a main session a guard holds is held: `unattended()` says the background route started it, else `other` holds it.
const heldAs = (unattended, other) => (unattended() ? UNATTENDED : other);

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
  // A session the Human has typed into is attended from then on, its floor kept for the chain count (liftAttended).
  if (isAttended(session, home ? { home } : {})) return false;
  const found = (state) => {
    try {
      // The project's own checkouts, not projectCheckouts as projectStore uses for a writer: that is null when git
      // cannot list the worktrees, the store would refuse, and a floor never found would lift every refusal here.
      // A floor found only adds refusals, so a store in another worktree of the repository may give one.
      return startedInBackground(openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain }), session);
    } catch {
      return false;
    }
  };
  // Lazily, so the working copy's folders are read first, and git only when they hold no floor.
  for (const state of stateFolders(project, config, { home, lazy: true, ...(base ? { base } : {}) })) if (found(state)) return true;
  return false;
}

// The folder the background start of `session` started it in, as the start record of the gate that started it says
// (handoff-markers.mjs startedFolders): its `cwd`, in the continuation stores of `project`'s state folders, read as
// startedUnattended reads them, but each store held to every checkout of the repository, as the handoff writer holds it
// (handoff-continue.mjs projectStore, project.mjs projectCheckouts): a record grants a worktree, so one in a store inside
// a sibling worktree, which the writer would refuse, grants none. lib/unattended-write.mjs asks it for a mark a gate
// filed before the mark recorded that folder. Null when git cannot list the checkouts, no store holds such a record, or
// the records name two folders: a session that cannot tell where it started has no worktree.
export function startedFolder(project, config, session, { home, base } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  checkDeadline();
  const checkouts = projectCheckouts(project, () => (Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : undefined));
  if (!checkouts) return null;
  const folders = new Set();
  for (const state of stateFolders(project, config, { home, lazy: true, ...(base ? { base } : {}) })) {
    checkDeadline();
    let found;
    try {
      found = startedFolders(openStore(state, { checkouts, maxChain: config.session.handoff.maxChain }), session);
    } catch (error) {
      if (error instanceof PastDeadline) throw error;
      found = [];
    }
    for (const each of found) folders.add(each);
  }
  return folders.size === 1 ? [...folders][0] : null;
}

// The task worktrees `aidrian worktree new` made in the session `session` (handoff-markers.mjs madeWorktrees), in the
// continuation stores of the state folders `states` (stateFolders), each path once: a record grants a worktree, as a
// start record does, so it is read only from a store outside every checkout of `checkouts`, the repository's, and [] when
// git could not list them or the session id has the wrong shape. It runs no git; each store's file reads check the
// guards' deadline. `maxChain` is session.handoff.maxChain, as openStore takes it.
export function sessionWorktrees(states, session, checkouts, maxChain) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || !Array.isArray(checkouts)) return [];
  const found = new Set();
  for (const state of states) {
    checkDeadline();
    for (const each of madeWorktrees(openStore(state, { checkouts, maxChain }), session)) found.add(each);
  }
  return [...found];
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
// baseReader to share; `home` is for a test. Without `lazy`, one call reads each folder's roots, prefix, and remote URLs
// once (lib/git.mjs withGitFacts), or as the open call does; the iterator reads them as its caller's loop does.
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
  return lazy ? each() : withGitFacts(() => [...each()]);
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
export const PROJECT_SUBCOMMANDS = Object.freeze(['init', 'next', 'start', 'wait', 'result', 'handoff', 'resume', 'summary', 'report', 'recorded', 'preflight', 'stop-action', 'end', 'confine', 'decision']);
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
// (lib/solo.mjs), and every variable a host names a session, its agent, or its host process by, says whether a Human
// attends the session with, or tells itself by (lib/hosts/index.mjs).
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

// Why the call in `input` may not run because it runs an `aidrian pr` command with a GATE_ENV variable set or unset by the
// command line itself, or null: { match, reason }. `aidrian pr auto-merge` and `aidrian pr signoff` read the sign-off
// store and the review records under the state root some of those variables move, so a session `unattended()` says no
// Human attends could point them at a folder it writes; the others name the session, or say a Human attends it. Every other variable runs, as the Human's own words, such as an
// approved round grant, ride on the command line. A command in a shell the lexer cannot read counts when its text
// names `aidrian`, `pr`, and one of GATE_ENV.
export function prEnvDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  let named = null;
  if (opaque !== null) {
    const texts = opaqueTexts(opaque);
    const word = (name) => new RegExp(String.raw`(?<![\w-])${name}(?![\w-])`, 'iu');
    if (!texts.some((text) => word('aidrian').test(text) && word('pr').test(text))) return null;
    named = GATE_ENV.find((name) => texts.some((text) => word(name).test(text))) ?? null;
  } else {
    const commands = walkCommands(command, null).filter(({ invocation }) => {
      const words = invocation ? aidrianArgs(invocation) : null;
      return Boolean(words) && (words[0]?.dynamic || words[0]?.text === 'pr');
    });
    named = GATE_ENV.find((name) => commands.some(({ invocation }) => changesVariable(invocation, name))) ?? null;
  }
  if (!named || !unattended()) return null;
  const why = `it runs \`aidrian pr\` with ${named} set or unset by the command itself, which would move the state root its review records and the sign-off store are read from, or change the session it takes itself to run in or whether a Human attends it, and ${UNATTENDED}`;
  return { match: `changes ${named} for aidrian pr`, reason: projectRuleReason(input, why, human) };
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
// program as a word. A package runner, as `npx`, `pnpm dlx`, or `bunx`, is read as the program it runs, by a host's own
// package name too (an adapter's `packages`). A known limit of the shared lexer, as in handoffContinueDenial: another
// program that runs its arguments as a command, such as `xargs claude`, a runner's command-string option, as `npx -c`
// or `--call` and `npm exec -c`, the runner forms `bun x` and `pnpx`, and a command word built from a variable, are not read.
export function hostSessionStartDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  const hosts = starters();
  // The host whose program `text`, which no lexer read, names as a word.
  const namedIn = (text) => hosts.find((each) => programWord(each.sessionStart.programs).test(text));
  // Through a package runner, the program its package installs (package-runner.mjs), as `npx @anthropic-ai/claude-code -p` runs claude.
  const starts = (invocation) => {
    const { program, args } = unwrapped(programName(invocation.program), invocation.args, (token) => (token.dynamic ? null : token.text));
    return hosts.find((each) => each.sessionStart.programs.includes(programName(program)) && each.sessionStart.starts(args));
  };
  const read = ({ invocation, unread }) => (unread !== undefined ? namedIn(unread) : null) ?? (invocation.dynamic ? null : starts(invocation));
  const host = opaque !== null ? opaqueTexts(opaque).map(namedIn).find(Boolean) : walkCommands(command, null).map(read).find(Boolean);
  const subagent = isSubagent(input);
  if (!host || (!subagent && !unattended())) return null;
  const who = subagent ? 'only the main session hands off, through `aidrian handoff continue`' : `a session starts another only through \`aidrian handoff continue\`, ${UNATTENDED}`;
  const why = `it starts or resumes a session of ${host.name} outside the handoff gate, which holds every session it starts to a chain floor, and ${who}`;
  return { match: `starts a session of ${host.name}`, reason: projectRuleReason(input, why, human, 'to start or resume that session') };
}

// Why the call in `input` may not run because it reaches a host's local service that starts a session no guard holds,
// as an adapter's `localService` declares one, or null: { match, reason }. It holds for a session `unattended()` says no
// Human attends, asked only for a shell command whose text, unquoted, with each `$NAME` and `${NAME}` that `env` gives
// an absolute path and each leading `~` expanded, names one of the service's credential stores, which hold its
// password, or one of its ports after a host, as `127.0.0.1:<port>` (hosts/index.mjs localServices). Read as text, so
// a command in any shell or interpreter counts; a path or port the command builds at run time does not (the residuals
// in docs/hooks.md, Agent gates).
export function hostServiceDenial(input, { names: { human } }, { unattended = () => false, env = process.env, home = env.HOME || homedir() } = {}) {
  const command = opaqueShellCommand(input) ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string' || !unattended()) return null;
  const text = unquoted(command)
    .replace(/\$\{(\w+)\}|\$(\w+)/gu, (whole, braced, bare) => (path.isAbsolute(env[braced ?? bare] ?? '') ? env[braced ?? bare] : whole))
    .replace(/(^|[\s=:(])~(?=\/|\s|$)/gu, (_, before) => `${before}${home}`);
  const escape = (each) => each.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const service of localServices({ env, home })) {
    const store = service.stores.find((each) => new RegExp(`(?<![\\w.-])${escape(each)}(?![\\w.-])`, 'iu').test(text));
    const port = service.ports.find((each) => new RegExp(String.raw`[\w\]]:${each}(?!\d)`, 'u').test(text));
    if (store === undefined && port === undefined) continue;
    const named = store === undefined ? `its port ${port}` : `its credential store ${store}`;
    const why = `it names ${named}: ${service.name}'s local service starts a session no guard holds for any caller with the password its state folder keeps, ${UNATTENDED}`;
    return { match: `reaches the local service of ${service.name}`, reason: projectRuleReason(input, why, human, 'to reach that service') };
  }
  return null;
}

// The `git remote` actions that point a remote at another repository, or move the ref of its default branch.
const REMOTE_ACTIONS = new Set(['add', 'set-url', 'rename', 'set-head']);
// A remote-tracking ref: a project run cuts and checks each issue's worktree against origin's default branch. `remotes`
// in any case, since on a disk that folds case `refs/REMOTES/x` is the same loose ref file.
const TRACKING_REF = /^refs\/[rR][eE][mM][oO][tT][eE][sS]\//u;
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
  [/\b(?:fetch|pull|push)\b/iu, /(?::\+?|--refmap[= ]\+?[^:\s]*:)(?:refs\/)?remotes\//iu],
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

// Whether git's global options set, for the one command, a key that decides which repository a remote names or what git
// runs (POLICY_KEY): a remote's URL, push URL, or fetch refspec, a URL rewrite (`url.<base>.insteadOf` or
// `pushInsteadOf`), an included file, or an alias, by `-c <key>=...`, attached or not, or `--config-env <key>=<variable>`.
// A value built at run time may name any key.
const policyGlobal = (globals) => globals.some((token, i) => {
  const valued = ['-c', '--config-env'].includes(token.text);
  const value = valued ? globals[i + 1] : /^(?:-c|--config-env=)(.*)$/su.exec(token.text)?.[1];
  if (valued && value?.dynamic) return true;
  const text = typeof value === 'string' ? value : value?.text;
  return typeof text === 'string' && POLICY_KEY.test(text.split('=')[0]);
});

// The options of a fetch, pull, or push that take the next word as their value, skipped before its repository is read.
const TRANSFER_VALUES = Object.freeze({
  fetch: new Set(['--upload-pack', '-o', '--server-option', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--negotiation-tip']),
  pull: new Set(['--upload-pack', '-o', '--server-option', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--negotiation-tip', '-s', '--strategy', '-X', '--strategy-option']),
  push: new Set(['--receive-pack', '--exec', '-o', '--push-option', '--repo']),
});
// The git subcommands a variable that moves git's repository or config (git-push.mjs GIT_VARIABLES, or any GIT_CONFIG_*)
// on the same line may point at another repository, or have write a remote-tracking ref.
const REMOTE_READERS = new Set(['fetch', 'pull', 'push', 'remote']);

// Whether one command the walk read changes a remote, gh's default repository, or how git reads either: `git remote
// add`, `set-url`, or `rename`; a `git config` write of a remote, include, URL, or alias key (configWrites), or an edit,
// rename, or removal of a section; such a key given by `-c` or `--config-env` (policyGlobal); a fetch, pull, push, or
// remote on a line that moves git's repository or config (`reconfigured`); `git update-ref` of a remote-tracking ref,
// or with `--stdin`, whose refs it cannot see; `git symbolic-ref` that writes or deletes one, past its `-m` reason, or
// points a ref at one;
// `git remote set-head` but with `--auto`, which reads the remote's own; `git branch` deleting remote-tracking
// branches; a fetch, pull, or push refspec or `--refmap` that writes a remote-tracking ref (movesTracking);
// `gh repo set-default` without `--view`;
// or `gh alias set` or `import`. A command whose program is a variable or a substitution, and a git or gh call whose
// words the lexer cannot all read, count when their plain words name such an action.
function changesRemote({ segment, invocation, unread, folder }, { reconfigured = false, remotes = () => new Set() } = {}) {
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
  if (policyGlobal(git.globals)) return true;
  if (reconfigured && REMOTE_READERS.has(git.subcommand)) return true;
  const words = git.rest.filter((token) => !token.dynamic).map((token) => token.text);
  if (git.subcommand === 'remote') {
    const action = words.find((text) => !text.startsWith('-'));
    return REMOTE_ACTIONS.has(action) && !(action === 'set-head' && autoHead(words.slice(words.indexOf(action) + 1)));
  }
  if (git.subcommand === 'config') return configWrites(words);
  if (git.subcommand === 'update-ref') return words.includes('--stdin') || words.some((text) => TRACKING_REF.test(text));
  // `git branch -d -r origin/main`: a deletion of remote-tracking branches, in any spelling of the flags.
  if (git.subcommand === 'branch') {
    const short = words.filter((text) => /^-[A-Za-z]+$/u.test(text)).join('');
    const remotes = words.includes('--remotes') || short.includes('r');
    return remotes && (words.includes('--delete') || /[dD]/u.test(short));
  }
  if (['fetch', 'pull', 'push'].includes(git.subcommand)) return movesTracking(git.subcommand, git.rest, () => remotes(folder));
  // symbolic-ref writes with a second operand, or deletes; with one, it reads. Pointing a ref, such as HEAD, at a
  // remote-tracking ref makes every later commit move that ref.
  if (git.subcommand === 'symbolic-ref') {
    const { operands, deletes } = symbolicRef(words);
    return (TRACKING_REF.test(operands[0] ?? '') && (operands.length > 1 || deletes)) || (operands.length > 1 && TRACKING_REF.test(fetchDestination(operands[1])));
  }
  return false;
}

// Whether the words after `git remote set-head` only ask the remote for its own default branch: one remote and `-a` or
// `--auto`, which is how a checkout whose origin/HEAD is gone sets it again from the forge.
function autoHead(words) {
  const options = words.filter((text) => text.startsWith('-'));
  return words.length - options.length === 1 && options.length > 0 && options.every((text) => text === '-a' || text === '--auto');
}

// A fetch refspec's destination as git expands it (remote.c get_local_ref): a full ref as written, `heads/`, `tags/`, and
// `remotes/` under refs/, anything else a branch.
const fetchDestination = (dst) => {
  if (dst.startsWith('refs/')) return dst;
  return /^(?:heads|tags|remotes)\//u.test(dst) ? `refs/${dst}` : `refs/heads/${dst}`;
};

// Whether a fetch, pull, or push (`subcommand`, its tokens `tokens`) writes a remote-tracking ref through a refspec or a
// `--refmap` value: a fetch or pull destination as git expands it, as `git fetch . +HEAD:remotes/origin/main`, or one
// whose wildcard may expand to one (wildTracking); a push
// destination under refs/remotes/, or, to a repository that is no remote `remotes()` names (a Set of the checkout's
// configured remote names), such as `.`, `.git`, `~/x`, or a path built at run time, any destination that is not a full
// branch or tag, which git matches against that repository's own refs, as `git push . HEAD:origin/main` does. The
// options of TRANSFER_VALUES take their next word, and push's `--repo` names the repository when no operand does. A
// refspec built at run time or expanded by the shell counts when it holds a `:` and names `remote`, or its destination
// starts with what the shell expands.
function movesTracking(subcommand, tokens, remotes) {
  const specs = [];
  const operands = [];
  const values = TRANSFER_VALUES[subcommand];
  let repo = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const { text } = token;
    if (text === '--refmap') specs.push(tokens[(i += 1)] ?? { text: '' });
    else if (text.startsWith('--refmap=')) specs.push({ ...token, text: text.slice('--refmap='.length) });
    else if (subcommand === 'push' && text.startsWith('--repo=')) repo = { ...token, text: text.slice('--repo='.length) };
    else if (values.has(text)) {
      if (subcommand === 'push' && text === '--repo') repo = tokens[i + 1] ?? null;
      i += 1;
    } else if (token.dynamic || !text.startsWith('-')) operands.push(token);
  }
  specs.push(...operands.slice(1));
  if (specs.some((spec) => (spec.dynamic || spec.expands) && builtTracking(spec.text))) return true;
  const destinations = specs.filter((spec) => !spec.dynamic && spec.text.includes(':')).map((spec) => spec.text.slice(spec.text.lastIndexOf(':') + 1)).filter(Boolean);
  if (subcommand !== 'push') return destinations.some((dst) => TRACKING_REF.test(fetchDestination(dst)) || wildTracking(dst));
  if (destinations.some((dst) => TRACKING_REF.test(dst))) return true;
  const short = destinations.filter((dst) => !/^refs\/(?:heads|tags)\//u.test(dst));
  if (short.length === 0) return false;
  const repository = operands[0] ?? repo;
  return !repository || localRepository(repository, remotes);
}

// Whether a fetch or pull destination holding git's wildcard, quoted or not, may expand to a remote-tracking ref: its
// literal part before the first `*`, case-folded, is a prefix of `refs/remotes/`, as `refs/*`, `refs/*/origin/main`,
// or `*` are. git puts what the source's `*` matched in its place, so `git fetch . 'refs/heads/*:refs/*'` writes
// refs/remotes/origin/main from a branch named remotes/origin/main.
const wildTracking = (dst) => dst.includes('*') && 'refs/remotes/'.startsWith(dst.slice(0, dst.indexOf('*')).toLowerCase());

// Whether a refspec built at run time or expanded by the shell may name a remote-tracking ref: it holds a `:`, and
// names `remote` in any case, or its destination starts, past `+` and `refs/`, with a part the shell builds.
const builtTracking = (text) => text.includes(':') && (/remote/iu.test(text) || /^\+?(?:refs\/)?[$`*?[{]/u.test(text.slice(text.lastIndexOf(':') + 1)));

// Whether a push's repository word names a repository on this disk, or may: built at run time, a path (`.`, `..`,
// `.git`, `~`, or one with a slash), a `file:` URL, or any word that is no remote the checkout configures (`remotes()`).
function localRepository(token, remotes) {
  if (token.dynamic || token.expands) return true;
  const { text } = token;
  if (/^(?:\.{1,2}|\.git|~.*|\.{0,2}\/.*|file:.*)$/u.test(text)) return true;
  if (/^[\w.+-]+@[^:]+:|^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return false;
  return !remotes().has(text);
}

// The operands of `git symbolic-ref`'s words, past its options, and whether it deletes: `-m` takes the next word as the
// reflog's reason, alone or at the end of a cluster as `-qm`, or the rest of its word as `-mreason`.
function symbolicRef(words) {
  const operands = [];
  let deletes = false;
  let ended = false;
  for (let i = 0; i < words.length; i += 1) {
    const text = words[i];
    if (ended || !text.startsWith('-') || text === '-') operands.push(text);
    else if (text === '--') ended = true;
    else if (text === '--delete') deletes = true;
    else if (!text.startsWith('--')) {
      const at = text.indexOf('m');
      const flags = at === -1 ? text.slice(1) : text.slice(1, at);
      if (flags.includes('d')) deletes = true;
      if (at === text.length - 1) i += 1;
    }
  }
  return { operands, deletes };
}

// Why the call in `input` may not run because it changes which repository the checkout's remotes or gh's default
// name, or null: { match, reason }. The plugin reads the team's policy from that repository on the forge, such as
// `solo` (lib/solo.mjs) and the auto-merge and waiver ceilings, so a session that repoints origin could read its own.
// It holds for a subagent and for a session `unattended()` says the background route started, asked only for such a
// command. A command in a shell the lexer cannot read counts when its text names such an action. Known limits, as for
// the other guards here: a write by its path to `.git/config`, a file it includes, or gh's own config folder; a program
// that runs its arguments as a command, such as `xargs git ...`; a git subcommand held in a variable, as in
// `git $ACTION ...`, whose later words name no such action; and HOME or XDG_CONFIG_HOME moved on the line. `mark`, the
// session's unattended mark, names an issue session of a project run as that in the reason.
export function remoteChangeDenial(input, { names: { human } }, { unattended = () => false, mark = null } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  // Every form it refuses names one of these words, however quoted, so a call with none of them is not walked.
  if (typeof command !== 'string' || !/remote|config|repo|alias|update-ref|symbolic-ref|branch|fetch|pull|push/iu.test(unquoted(command))) return null;
  const hit = opaque !== null
    ? REMOTE_TEXTS.some((words) => words.every((word) => opaqueTexts(opaque).some((text) => word.test(text))))
    : walkedRemoteChange(command, input.cwd);
  const subagent = isSubagent(input);
  if (!hit || (!subagent && !unattended())) return null;
  const held = issueHeld(mark) ? 'and this session works an issue of a project run, which no Human attends' : UNATTENDED;
  const who = subagent ? 'only the main session changes them' : `only a session the Human attends changes them, ${held}`;
  const why = `it changes which repository the checkout's git remotes or gh's default name, or how git reads them, where the plugin reads the team's policy on the forge, such as solo, or a remote-tracking ref, which names the commit a project run cuts each issue from, and ${who}`;
  return { match: 'changes a git remote', reason: projectRuleReason(input, why, human, 'to change the remote', { mark }) };
}

// Whether a command the walk reads changes a remote (changesRemote), with what the whole line shares: whether a command
// on it changes a variable that moves git's repository or config (git-push.mjs changesGitTarget, or any GIT_CONFIG_*),
// and the remotes of each folder a push runs in, which `git remote` names, read once a push needs them; none when git
// fails, so every repository word counts as local.
function walkedRemoteChange(command, cwd) {
  const entries = [...walkCommands(command, typeof cwd === 'string' ? cwd : null)];
  const reconfigured = entries.some(({ invocation }) => changesGitTarget(invocation) || changedVariables(invocation).some((name) => /^GIT_CONFIG/u.test(name)));
  const read = new Map();
  const remotes = (folder) => {
    if (typeof folder !== 'string') return new Set();
    if (!read.has(folder)) {
      checkDeadline();
      const listed = runGit(['remote'], folder, Number.isFinite(remainingMs()) ? { timeout: Math.max(1, Math.floor(remainingMs())) } : { timeout: GIT_TIMEOUT_MS });
      read.set(folder, new Set(listed.status === 0 ? listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []));
    }
    return read.get(folder);
  };
  return entries.some((entry) => changesRemote(entry, { reconfigured, remotes }));
}

// A path part named as a file whose forgery would arm or deliver a continuation, in any case. A chain floor or a task
// record (`from-`, `tasks-`) is not one: their names are common words, and the path rules cover them.
const MARKER_NAME = new RegExp(ARMING_FILE.source, 'iu');
// An unsure glob's part whose plain start names such a file, as `armed-*`.
const MARKER_GLOB = /^(?:armed|ready|taken|gone|checked|started|claim|continued|worktree)-/iu;
// A request to end a session or a record that a terminal follows one (lib/terminal-replace.mjs), whose forgery would end
// an attended session or move a terminal: named by the id shape a host gives a session, 8 hex digits or a whole UUID, as
// the store writes them. `ending-` and `follow-` are common words, so a name such as `follow-up.json` stays out of it.
const RECORD_NAME = /^(?:ending|follow)-[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.json$/iu;
// An unsure glob's part whose plain start may still grow into such a name, as `ending-*` or `follow-ab12*`.
const RECORD_GLOB = /^(?:ending|follow)-[0-9a-f-]*$/iu;
// A word of a command no lexer reads that names the store's folder by its own name.
const STORE_FOLDER = /^\.continue$/iu;
// A text that names the store's folder, or a marker in it.
const STORE_NAME = /(?<![\w.-])(?:handoffs\/\.continue(?![\w-])|\.continue\/(?:armed|ready|from|checked|gone|tasks|taken|started|claim|continued|ending|follow|worktree)-)/iu;
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
// The real paths of a call's file targets, the list writeTargets gave, read once for every guard that asks.
const reals = new WeakMap();
const realFiles = (files) => {
  if (!reals.has(files)) reals.set(files, files.map(real));
  return reals.get(files);
};

// Whether a text from a folder no path gives names the store or one of its files.
const namesStore = (text) => STORE_NAME.test(text) || text.split('/').some((part) => MARKER_NAME.test(part) || RECORD_NAME.test(part));
// Whether a glob from a folder no path gives may name one of those files.
const globNamesStore = (text) => namesStore(text) || text.split('/').some((part) => {
  const start = part.split(/[*?[]/u)[0];
  return (MARKER_GLOB.test(start) || RECORD_GLOB.test(start)) && GLOB.test(part);
});

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
// agent gate hook asks it so first, and again with the walk after the other guards' cheaper checks. `drives()` holds a
// main session as `unattended()` does, as the hook asks it for a project run's driver, and its denial says so.
export function continueStoreWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false, drives = () => false, base = baseReader(project), home } = {}) {
  const subagent = isSubagent(input);
  const opaque = opaqueShellCommand(input) !== null;
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const writer = () => (subagent ? 'only the main session\'s `aidrian handoff` commands write' : `only \`aidrian handoff\` commands write, ${heldAs(unattended, DRIVES)}`);
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the handoff continuation store, where ${writer()}`, human);
  // Asked last, once a call reaches the store: it reads the store, and git for the base branch's config.
  const held = () => subagent || unattended() || drives();
  // A command no lexer reads may join `.continue` to a path it builds, as a path joiner does.
  const joined = opaque && names.some((name) => name.split('/').some((part) => STORE_FOLDER.test(part)));
  const unsure = (glob) => ((glob.unsure || glob.opaque) && globNamesStore(glob.text)) || (glob.opaque && globNamesFile(glob.text, STORE_TAIL));
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const namedMode = unplaced.some(({ text }) => namesStore(text) || text.split('/').some((part) => STORE_PART.test(part)));
  if (joined || names.some(namesStore) || globs.some(unsure) || namedMode) {
    return held() ? { match: 'may change the continuation store', reason: why('may change', 'handoffs/.continue') } : null;
  }
  // Every state folder `state` gives (stateFolders) holds a store, each guarded.
  const stores = () => folders(state).map((folder) => ({ folder: real(storePath(folder)), shields: [real(folder), real(path.join(folder, 'handoffs'))] }));
  const hit = reachesStateFolder(input, { files, globs, modes }, { dir, links, folders: stores, roots: () => project.checkouts.map(real), inside: true, moved: () => movesState(base) });
  if (hit === false) return null;
  if (hit) {
    if (!held()) return null;
    const verb = opaque ? 'may change' : 'changes';
    return { match: `${verb} the continuation store`, reason: why(verb, hit.folder) };
  }
  return base().failed && held() && holdsState(project, state, home) ? unreadableBase(input, human) : null;
}

// Of `folders()`, each { folder, shields } as reaches takes them, the first the write targets of the call in `input`
// reach, else false or null as below: continueStoreWriteDenial and sessionFoldersWriteDenial both ask it. It reads the targets' real paths
// once (placedTargets), and asks `folders()` only past a cheap check: always with `dir`, a state folder the config moves;
// else only when a target, or a link a glob may pass (globLinksTo, skipped with `links` false), lies near the state root
// or one of `anchors`, real paths of other state folders the caller guards. `roots()` gives the checkouts a target that
// holds a folder may also hold, real and case-folded. With `inside`, a call whose every target lies in one of `roots()`
// and holds no state root reaches none, since a state folder is never kept inside a checkout (inCheckouts); `moved()`
// says the folders may lie away from the state root, as when the base branch's config moves state.dir (movesState). It
// gives false when the cheap checks rule every folder out, and null when it asked `folders()` and none is reached.
function reachesStateFolder(input, { files, globs, modes }, { dir, links, folders, roots, anchors = [], inside = false, moved = () => false }) {
  const { targets, known, placed, sure } = placedTargets({ files, globs, modes });
  if (targets.length === 0 && known.length === 0 && placed.length === 0) return false;
  const root = real(stateRoot());
  const near = (target) => [root, ...anchors].some((each) => isWithin(each, target) || isWithin(target, each));
  // A glob anywhere may pass a link into the state root; the walk reads each folder once a call (linkWalk).
  const seen = linkWalk(input);
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
  const spelled = [...targets, ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)];
  if (inside && inCheckouts(spelled, roots(), root) && !linksTo(root)) return false;
  if (!dir && !spelled.some(near) && ![root, ...anchors].some(linksTo) && !moved()) return false;
  const checkouts = roots();
  return folders().find(({ folder, shields }) => reaches({ files: targets, known, placed, linksTo }, folder, shields, checkouts)) ?? null;
}

// A text that names a session file (lib/session-folder.mjs SESSION_FILES) below a sessions folder, in any case, with `/`
// or `\` between its parts, one or more, as a string in interpreter code may double a `\`: `sessions/<a part>/<a file>`;
// or, by its name alone, a session file but `usage.json`, a name other tools use, since a `cd` the guard cannot follow
// may have put the call in a session folder. Each is read as a path part: any character but a word character, `.`, or
// `-` may stand before or after it, such as the closing quote that follows a path in interpreter code. The word
// `sessions` alone never counts, since a project may hold a folder of that name.
const escapedNames = (names) => names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
const BARE_SESSION_FILES = SESSION_FILES.filter((name) => name !== 'usage.json');
export const SESSION_FILE_NAME = new RegExp(String.raw`(?<![\w.-])sessions[\\/]+[^\\/]+[\\/]+(?:${escapedNames(SESSION_FILES)})(?![\w.-])|(?<![\w.-])(?:${escapedNames(BARE_SESSION_FILES)})(?![\w.-])`, 'iu');

// The sessions folders of every project's default state folder under the state root, `<root>/projects/<id>/sessions`,
// that are there, read once a call (by `input`) for both passes of the agent gate hook, with the guards' deadline
// checked at each one, so a large state root cannot run the guard past it. `read` and `entry` are readdirSync and isEntry,
// which a test may count.
const defaultScans = new WeakMap();
export function defaultSessionsFolders(input, { read = folderNames, entry = isEntry } = {}) {
  if (!defaultScans.has(input)) {
    const found = [];
    try {
      const projects = path.join(stateRoot(), 'projects');
      for (const name of read(projects)) {
        checkDeadline();
        const sessions = path.join(projects, name, 'sessions');
        if (entry(sessions)) found.push(sessions);
      }
    } catch (error) {
      if (error instanceof PastDeadline) throw error;
      // No state root, or no project in it: the other folders alone.
    }
    defaultScans.set(input, found);
  }
  return defaultScans.get(input);
}

// The names in the folder `dir`, one entry read at a time, so a caller that checks the deadline between them never
// waits on a whole listing first.
function* folderNames(dir) {
  const opened = opendirSync(dir);
  try {
    for (let each = opened.readSync(); each !== null; each = opened.readSync()) yield each.name;
  } finally {
    opened.closeSync();
  }
}

// The real sessions folders a call may not reach, each { folder, shields }, its state folder the one shield: those of
// `states`, the state folders the caller names, whether or not they are there yet, then defaultSessionsFolders. So a
// subagent that works in another project, or in none, still meets the session folders its session started with. A
// sessions folder one of `roots`, the checkouts the session folder's writer keeps it out of, holds is left out: the
// writer never writes there, as with a `state.dir` of `..` in a checkout named `sessions`, or of `.` in a project below
// the repository root, which would otherwise make every file of a checkout a session file. Each folder's real path is
// read under the guards' deadline (real), and the answer is kept for the call, by `input`, for both passes of the agent
// gate hook.
function sessionsFolders(input, states, roots) {
  return readOnce(input, `sessions:${JSON.stringify([states, roots])}`, () => scanSessions(input, states, roots));
}

function scanSessions(input, states, roots) {
  const seen = new Set();
  const found = [...states.map((state) => path.join(state, 'sessions')), ...defaultSessionsFolders(input)].map(real).filter((folder) => {
    if (seen.has(folder) || roots.some((root) => isWithin(root, folder))) return false;
    seen.add(folder);
    return true;
  }).map((folder) => ({ folder, shields: [path.dirname(folder)] }));
  return found;
}

// The session's origins (readOrigins) and the writer's checkouts of `project` (projectCheckouts, its git read stopped at
// what is left of the guards' deadline, by SIGKILL), each read once a call, by `input`, for both passes.
const callReads = new WeakMap();
function readOnce(input, key, read) {
  if (!callReads.has(input)) callReads.set(input, new Map());
  const reads = callReads.get(input);
  if (!reads.has(key)) reads.set(key, read());
  return reads.get(key);
}
const deadlineGit = () => {
  const left = remainingMs();
  return Number.isFinite(left) ? { timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, Math.floor(left))), killSignal: 'SIGKILL' } : {};
};

// Why the call in `input` may not run because it writes in the session folders, or null: { match, reason }. The folders
// are those sessionsFolders gives for the state folder `state` gives, none with no `project`, as the agent gate hook asks
// outside a project, and the state folders the session started with (lib/session-origins.mjs readOrigins), which its
// SessionStart hook records. It holds for a subagent, and for a main session `unattended()` says the background route
// started, asked once a call reaches the folders, read as continueStoreWriteDenial reads the store (reachesStateFolder):
// a target that lies in them, a folder that holds them and no checkout, a glob that may reach them by the path it spells
// or through a link on disk, and a change of mode or owner of them or of a folder that holds them. A target no path
// places, interpreter code, and a word of a command in a shell the lexer cannot read count when they name
// SESSION_FILE_NAME. The checkouts a folder must lie outside are the session folder writer's (project.mjs
// projectCheckouts), the project's own when git cannot list them. The hooks and the aidrian commands write there through
// their own code, which no guard reads. With `links` false it skips the link walk.
export function sessionFoldersWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false, origins = readOrigins } = {}) {
  const subagent = isSubagent(input);
  const opaque = opaqueShellCommand(input) !== null;
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const writer = subagent ? 'only the hooks and the `aidrian` commands write' : `only the hooks and the \`aidrian\` commands write, ${UNATTENDED}`;
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the session folders, where ${writer}`, human);
  const held = () => subagent || unattended();
  const named = (text) => SESSION_FILE_NAME.test(text);
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  if (names.some(named) || unplaced.some(({ text }) => named(text)) || globs.some((glob) => (glob.unsure || glob.opaque) && named(glob.text))) {
    return held() ? { match: 'may change the session folders', reason: why('may change', 'sessions/<id>') } : null;
  }
  const started = readOnce(input, 'origins', () => origins(input.session_id));
  const roots = () => readOnce(input, `roots:${project?.root ?? ''}`, () => (project === null ? [] : projectCheckouts(project, deadlineGit) ?? project.checkouts).map(real));
  // Every state folder `state` gives (stateFolders), then those the session started with.
  const sessions = () => sessionsFolders(input, [...(project === null ? [] : folders(state)), ...started], roots());
  const anchors = started.map(real);
  const hit = reachesStateFolder(input, { files, globs, modes }, { dir: project !== null && Boolean(dir), links, folders: sessions, roots, anchors });
  if (!hit || !held()) return null;
  const verb = opaque ? 'may change' : 'changes';
  return { match: `${verb} the session folders`, reason: why(verb, hit.folder) };
}

// Whether a real, case-folded path lies in the work, git, drop, or cache folder of the attempt folder `own()` gives, the real
// path of the attempt a confined host's session works in (project-run-guard.mjs ownAttemptFolder), read only when a
// write reaches the runs folder: the folders that session writes (lib/project-start.mjs). None when `own` is null or
// gives none.
function ownAttempt(own) {
  let folder;
  const named = () => (folder ??= (typeof own === 'function' ? own() : null) ?? false);
  return (target) => {
    if (typeof target !== 'string' || !named()) return false;
    const base = fold(named());
    return ['work', 'git', 'drop', 'cache'].some((part) => isWithin(path.join(base, part), target));
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
// Why the call in `input` may not run because it changes the unattended marks (lib/unattended-mark.mjs), or null:
// { match, reason }. It holds for a subagent, and for a main session `unattended()` says no Human attends, asked last,
// once a call reaches the marks: a session that deletes its own mark would lift what the mark holds it to wherever it
// runs. It holds with or without a project; `project`, when there is one, keeps a write to a folder that holds both
// the marks and its checkouts, such as the home folder, its own, as the store guard does. A call reaches the marks when
// a target lies in one of `folders` (markFolders), or holds it, or a glob may reach it by its path or through a link
// already on disk; a change of mode or owner counts there too, and on the state root that holds the folder. A target
// in a folder no path gives, and a word of a command in a shell the lexer cannot read, count when a part of it is named
// `unattended`, or, for a glob, may name it (globNamesFile). With `links` false it skips the link walk.
export function unattendedMarkWriteDenial(input, config, { project = null, links = true, unattended = () => false, folders = markFolders() } = {}) {
  return stateFoldersWriteDenial(input, config, { project, links, unattended, marks: folders, terminals: [], origins: [], signoffs: [] });
}

// Why the call in `input` may not run because it changes the shell records of lib/terminal-replace.mjs, or null, read
// as unattendedMarkWriteDenial reads the marks, in `folders` (terminalFolders), by the folder name `handoff-terminals`:
// a record names the session a shell opens in its terminal next, which only a session's own Stop hook writes.
export function terminalRecordWriteDenial(input, config, { project = null, links = true, unattended = () => false, folders = terminalFolders() } = {}) {
  return stateFoldersWriteDenial(input, config, { project, links, unattended, marks: [], terminals: folders, origins: [], signoffs: [] });
}

// Why the call in `input` may not run because it writes in the sign-off store (lib/review/merge-trust.mjs), or null:
// { match, reason }. A merge no Human asks for reads the Human's flow sign-offs there, never in the review record a
// confined session can write, so only `aidrian pr signoff` in a main session the Human attends writes it. It holds for a
// subagent, and for a main session `unattended()` says no Human attends, and reads a call's targets as
// unattendedMarkWriteDenial does, with `folders` (signoffFolders) and the part name `signoffs`.
export function signoffWriteDenial(input, config, { project = null, links = true, unattended = () => false, folders = signoffFolders() } = {}) {
  return stateFoldersWriteDenial(input, config, { project, links, unattended, signoffsHeld: unattended, marks: [], terminals: [], origins: [], signoffs: folders });
}

// The guards above in one pass, which the agent gates hook runs, with the session origins of lib/session-origins.mjs,
// which name the session folders the session-folder guard holds: the call's write targets, and its link walk, are read
// once for the four folders. `marks`, `terminals`, `origins`, and `signoffs` are the folders of each. `unattended()`
// holds a main session to the terminals and the origins; `marksHeld()` and `signoffsHeld()`, `unattended()` by default,
// to the marks and the sign-off store, so a project run's driver, which a Human may not attend for hours, is held to them
// too (scripts/hook-agent-gates.mjs).
export function stateFoldersWriteDenial(input, { names: { human } }, {
  project = null, links = true, unattended = () => false, marksHeld = unattended, signoffsHeld = unattended,
  marks = markFolders(), terminals = terminalFolders(), origins = originFolders(), signoffs = signoffFolders(),
} = {}) {
  const { files, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  if (files.length === 0 && names.length === 0 && globs.length === 0 && modes.length === 0) return null;
  let seen;
  const walk = () => {
    seen ??= links ? linkWalk(input) : null;
    return seen;
  };
  // Each target's real path, read once for every folder: a call may write a thousand.
  let placedOnce;
  const placed = () => {
    placedOnce ??= placedTargets({ files, globs, modes });
    return placedOnce;
  };
  const read = { input, names, globs, modes, project, links, walk, placed, unattended };
  const specs = [
    { name: MARK_FOLDER, folders: marks, held: marksHeld, what: 'the unattended marks', tells: 'which tell the hooks a session no Human attends wherever it runs', writer: 'the handoff gate' },
    { name: TERMINAL_FOLDER, folders: terminals, held: unattended, what: 'the shell records', tells: 'which name the session a shell opens in its terminal next', writer: 'a session\'s own Stop hook' },
    { name: ORIGIN_FOLDER, folders: origins, held: unattended, what: 'the session origins', tells: 'which name the session folders a session started with', writer: 'a session\'s own SessionStart hook' },
    {
      name: SIGNOFF_FOLDER, folders: signoffs, held: signoffsHeld, what: 'the sign-off store', tells: 'which holds the Human\'s flow sign-offs a merge no Human asks for reads',
      writer: '`aidrian pr signoff` in a session the Human attends', subagentWriter: '`aidrian pr signoff` in a main session the Human attends',
    },
  ];
  for (const spec of specs) {
    const denied = spec.folders.length > 0 ? stateFolderWriteDenial(read, human, spec) : null;
    if (denied) return denied;
  }
  return null;
}

// The guard of a folder `name` under the state root, found in `folders`, which only `writer` writes (`subagentWriter`
// as a subagent is told) and which `tells`: { match, reason } for a subagent's call, and for a call of a session `held()`
// holds, that reaches it, else null. `read` is the call's write targets, read once.
function stateFolderWriteDenial({ input, names, globs, modes, project, links, walk, placed, unattended }, human, { name, folders, held, what, tells, writer, subagentWriter = writer }) {
  const subagent = isSubagent(input);
  const part = new RegExp(String.raw`^${name}$`, 'iu');
  // The folder as a glob from any folder may name it: by its own name, or with the state root's above it.
  const tail = path.join('aidrian', name);
  const named = (text) => text.split(/[\\/]/u).some((each) => part.test(each));
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const byName = names.some(named) || unplaced.some(({ text }) => named(text))
    || globs.some((glob) => (glob.unsure || glob.opaque) && (named(glob.text) || globNamesFile(glob.text, tail, { folderParts: 0 })));
  const hit = byName || reachesFolders({ ...placed(), folders, project, links, walk });
  if (!hit || !(subagent || held())) return null;
  const opaque = opaqueShellCommand(input) !== null;
  const verb = opaque || byName ? 'may change' : 'changes';
  // A main session `held()` holds that `unattended()` does not is a run's driver (marksHeld, signoffsHeld).
  const writes = subagent ? `which only ${subagentWriter} writes` : `which only ${writer} writes, ${heldAs(unattended, DROVE)}`;
  const why = `it ${verb} ${what}, ${tail}, ${tells}, and ${writes}`;
  return { match: `${verb} ${what}`, reason: projectRuleReason(input, why, human) };
}

// The write targets of a call whose folder is known, by their real paths: { targets, known, placed, sure }, as reaches
// reads them, with `sure` the globs whose path is certain.
function placedTargets({ files, globs, modes }) {
  const unplaced = modes.filter(({ text, folder }) => folder === null && !path.isAbsolute(text));
  const placed = modes.filter((each) => !unplaced.includes(each)).map(({ text, folder, recursive }) => ({ target: real(path.resolve(folder ?? '/', text)), recursive }));
  const sure = globs.filter((glob) => !glob.unsure);
  return { targets: realFiles(files), known: sure.flatMap(globPaths), placed, sure };
}

// Whether the placed write targets of a call reach one of `folders`, as reaches reads them.
function reachesFolders({ targets, known, placed, sure, folders, project, links, walk }) {
  const guarded = folders.map((folder) => ({ mark: real(folder), root: real(path.dirname(folder)) }));
  const near = (target) => guarded.some(({ root }) => isWithin(root, target) || isWithin(target, root));
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, walk(), { below: true }));
  if (![...targets, ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)].some(near) && !guarded.some(({ root }) => linksTo(root))) return false;
  const roots = (project?.checkouts ?? []).map(real);
  return guarded.some(({ mark, root }) => reaches({ files: targets, known, placed, linksTo }, mark, [root], roots));
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
// the attempt folder of a confined session (ownAttempt), whose work, git, and drop folders it may write. `drives()`
// holds a main session as `unattended()` does, as the hook asks it for a project run's driver, and its denial says so.
export function projectRunWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false, drives = () => false, base = baseReader(project), home, own = null } = {}) {
  const subagent = isSubagent(input);
  const opaque = opaqueShellCommand(input) !== null;
  const { files: written, names, globs } = writeTargets(input);
  const modes = modeTargets(input);
  const writer = () => (subagent ? 'only the main session\'s `aidrian project` commands write' : `only \`aidrian project\` commands write, ${heldAs(unattended, DRIVES)}`);
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the folder of the project runs, whose ledger names the session that drives each run and the session that works each issue, where ${writer()}`, human);
  const held = () => subagent || unattended() || drives();
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
// .claude/settings.local.json and its skills, agents, and commands folders, under the main checkout of `project`. Every
// worktree session of the project loads them, so a session `unattended()` says no Human attends, and any subagent while
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
