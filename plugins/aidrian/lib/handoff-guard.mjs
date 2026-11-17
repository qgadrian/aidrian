// The guard that keeps a subagent out of the handoff continuation (docs/handoff.md#continue), with or without gates:
// it may not run `aidrian handoff continue`, which arms a continuation of the main session, nor write in the
// continuation store, `<state>/handoffs/.continue/` (lib/handoff-markers.mjs). A main session the background route
// started (startedUnattended) is held as a subagent is to the store, and both may neither start a host session outside
// the gate (hostSessionStartDenial) nor run the gate with a variable of their own that moves its store, its session, or
// its host command (handoffEnvDenial). scripts/hook-agent-gates.mjs asks it before every tool call. A host's other
// tools that run a shell command, such as Claude Code's Monitor, reach it as Bash calls (lib/hosts/claude-code.mjs
// hookInput); a command in a shell the shared lexer cannot read (lib/hosts/index.mjs opaqueShellCommand) is read as
// opaque text, and refused when its words may run the gate, or name or reach the store.
// It reads a call's targets as lib/config-guard.mjs does, and, like that guard, it is for agents that cooperate: what
// the shared lexer cannot see, it cannot see either. The known limits of that lexer, which this guard accepts: brace
// expansion (`{a,b}`), ANSI-C quoting (`$'...'`), a link created and written through in one call, the outputs of
// `tar -C` and `curl -o`, a program that runs its arguments as a command (`xargs aidrian ...`, `find ... -exec
// aidrian ...`), and a path built from a variable. The gate's own checks (lib/handoff-markers.mjs) keep what gets past
// harmless: a stray marker of the wrong shape, time, or host process is never delivered.

import { homedir } from 'node:os';
import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { checkDeadline } from './deadline.mjs';
import { bashCall, globNamesFile, opaqueTexts, writeTargets } from './config-guard.mjs';
import { foldCase, globParts, isWithin, partsReach } from './fs.mjs';
import { globLinksTo, globStarts, linkWalk } from './glob-links.mjs';
import { baseBranchConfig } from './handoff-continue.mjs';
import { ARMING_FILE, openStore, SESSION_ID, startedInBackground, storePath } from './handoff-markers.mjs';
import { DETECT_VARS, HOSTS, IDENTITY_VARS, opaqueShellCommand } from './hosts/index.mjs';
import { stateDir, stateRoot } from './project.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { aidrianArgs, assignsVariable, walkCommands } from './shell-lex.mjs';

const isSubagent = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';
// How a denial names who may do what it refuses, for a subagent and for a session no Human attends.
const UNATTENDED = 'and the background handoff route started this session, with no Human';

// Whether the session `session` of `project`, whose loaded config is `config`, is one the background handoff route
// started, so no Human attends it: its chain floor, under its full id or a short one, has route `background`
// (handoff-markers.mjs startedInBackground). The floor is looked for in the store of the working copy's state.dir and in
// the store of the base branch's, so a session that moves state.dir in its working copy is still found. lib/config-guard.mjs
// machineSwitchWriteDenial refuses such a session the machine's switches, as it does a subagent. It reads git only when
// asked, which that guard does only for a call that sets a switch. A store it cannot read finds nothing.
export function startedUnattended(project, config, session) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  const found = (read) => {
    try {
      const state = read();
      return typeof state === 'string' && startedInBackground(openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain }), session);
    } catch {
      return false;
    }
  };
  const working = () => stateDir(project, { config });
  const base = () => {
    const committed = baseBranchConfig(project).config;
    return committed && committed.state.dir !== config.state.dir ? stateDir(project, { config: committed }) : null;
  };
  return found(working) || found(base);
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

// The variables the gate reads its store, its session, its agent, and the host command it runs from: the state root and
// the home folder (project.mjs stateDir), PATH, which finds the host's command, and every variable a host names a
// session or an agent by, or tells itself by (lib/hosts/index.mjs).
const GATE_ENV = Object.freeze([...new Set(['XDG_STATE_HOME', 'HOME', 'PATH', ...IDENTITY_VARS, ...DETECT_VARS])]);

// Why the call in `input` may not run because it runs `aidrian handoff continue` or `aidrian handoff route` with one of
// GATE_ENV set by the command line itself, or null: { match, reason }. It holds for a subagent and for a session
// `unattended()` says the background route started, asked only for such a command: a store the session moves, or a
// session id it chooses, reads no floor, so its next background start would be held to no count, and the hooks, which
// read the host's own store and session, would not know the session it starts. A variable is set when a prefix
// assignment, `env`, or a declaring builtin, such as `export`, gives it a value anywhere in the command
// (shell-lex.mjs assignsVariable); a command in a shell the lexer cannot read counts when its text names one. A
// variable set in an earlier call, or by a file the command sources, is not seen: the gate's own comparison of its store
// with the host's (handoff-continue.mjs backgroundGate) holds the store there.
export function handoffEnvDenial(input, { names: { human } }, { unattended = () => false } = {}) {
  const opaque = opaqueShellCommand(input);
  const command = opaque ?? (bashCall(input) ? input.tool_input?.command : null);
  if (typeof command !== 'string') return null;
  let named;
  if (opaque !== null) {
    const texts = opaqueTexts(opaque);
    if (!opaqueRuns(texts, ['continue', 'route'])) return null;
    named = GATE_ENV.find((name) => texts.some((text) => new RegExp(String.raw`(?<![\w])${name}(?![\w])`, 'iu').test(text)));
  } else {
    const commands = walkCommands(command, null);
    if (!commands.some(runsGate(['continue', 'route']))) return null;
    named = GATE_ENV.find((name) => commands.some(({ invocation }) => assignsVariable(invocation, name)));
  }
  const subagent = isSubagent(input);
  if (!named || (!subagent && !unattended())) return null;
  const who = subagent ? 'only the main session runs the gate, with the environment its host gave it' : `the gate runs only with the environment the host gave this session, ${UNATTENDED}`;
  const why = `it runs \`aidrian handoff\` with ${named} set by the command itself, which would move the continuation store, the session, or the host command the gate reads, and ${who}`;
  return { match: `sets ${named} for aidrian handoff`, reason: projectRuleReason(input, why, human, 'that the handoff runs with the environment the host gave the session') };
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

// A path part named as a file whose forgery would arm or deliver a continuation, in any case. A chain floor or a task
// record (`from-`, `tasks-`) is not one: their names are common words, and the path rules cover them.
const MARKER_NAME = new RegExp(ARMING_FILE.source, 'iu');
// An unsure glob's part whose plain start names such a file, as `armed-*`.
const MARKER_GLOB = /^(?:armed|ready|taken|gone|checked|started|continued)-/iu;
// A word of a command no lexer reads that names the store's folder by its own name.
const STORE_FOLDER = /^\.continue$/iu;
// A text that names the store's folder, or a marker in it.
const STORE_NAME = /(?<![\w.-])(?:handoffs\/\.continue(?![\w-])|\.continue\/(?:armed|ready|from|checked|gone|tasks|taken|started|continued)-)/iu;
// A path part a change of mode or owner reaches the store through: its folder, or the handoffs folder that holds it.
const STORE_PART = /^(?:handoffs|\.continue)$/iu;
// The programs that change a file's mode or owner. A store, handoffs, or state folder every user may write, or a marker
// no read can open, reads as no store (handoff-markers.mjs openStore, readMarker), which would hide a chain floor.
const MODE_PROGRAMS = new Set(['chmod', 'chown', 'chgrp']);

// The operands of each change of mode or owner the Bash call in `input` runs: { text, folder, recursive }, where `folder`
// is the folder it runs in, or null when it cannot be known. A mode such as `755` reads as one more operand, which names
// no file of the store. One with a word built from a variable is left out: a known limit, as for every path built so.
function modeTargets(input) {
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
const globPaths = (glob) => globStarts(glob).map(({ start, rest }) => ({ prefix: real(start), rest }));

// Whether a glob write reaches the store: each part it spells matches the store's part at that depth, so it names the
// store, a file in it, or a folder that holds it. A part that is only stars, such as zsh's `**`, matches any number of
// parts, none included (partsReach, which never recurses, so no glob of many parts can run the guard out of stack).
function globReaches({ prefix, rest }, store) {
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
// macOS's `/var`; a target in a folder no path names, or code an interpreter runs,
// counts when it names `handoffs/.continue`, a marker below `.continue/`, or a path part named as a file that arms or
// delivers (MARKER_NAME), or, for a glob, starts as one (MARKER_GLOB). A glob word of a command in a shell the lexer
// cannot read counts by those names, and when it names the store by its name, as `.con*`, `han*`, or `handoffs/*` do, from any folder
// (globNamesFile), since such a shell may change its folder first. Such a command may only read what it names, so its
// block says it may change the store. With `links` false it skips the link walk, which reads folders on disk, so the
// agent gate hook asks it so first, and again with the walk after the other guards' cheaper checks.
export function continueStoreWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true, unattended = () => false } = {}) {
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
  if (!dir && ![...files.map(real), ...known.map(({ prefix }) => prefix), ...placed.map(({ target }) => target)].some(near) && !linksTo(root)) return null;
  const folder = state();
  const store = real(storePath(folder));
  const shields = [real(folder), real(path.join(folder, 'handoffs'))];
  const roots = project.checkouts.map(real);
  const holds = (target) => target !== store && isWithin(target, store);
  const hit = files.map(real).some((target) => isWithin(store, target) || (holds(target) && !roots.some((each) => isWithin(target, each))))
    || known.some((glob) => globReaches(glob, store)) || linksTo(store)
    || placed.some(({ target, recursive }) => isWithin(store, target) || shields.includes(target) || (recursive && holds(target)));
  if (!hit || !held()) return null;
  const verb = opaque ? 'may change' : 'changes';
  return { match: `${verb} the continuation store`, reason: why(verb, store) };
}
