// The guard that keeps a subagent out of the handoff continuation (docs/handoff.md#continue), with or without gates:
// it may not run `aidrian handoff continue`, which arms a continuation of the main session, nor write in the
// continuation store, `<state>/handoffs/.continue/` (lib/handoff-markers.mjs). scripts/hook-agent-gates.mjs asks it
// before every tool call. A host's other tools that run a shell command, such as Claude Code's Monitor, reach it as Bash
// calls (lib/hosts/claude-code.mjs hookInput); a command in a shell the shared lexer cannot read (lib/hosts/index.mjs
// opaqueShellCommand) is read as opaque text, and refused when its words may run the gate, or name or reach the store.
// It reads a call's targets as lib/config-guard.mjs does, and, like that guard, it is for agents that cooperate: what
// the shared lexer cannot see, it cannot see either. The known limits of that lexer, which this guard accepts: brace
// expansion (`{a,b}`), ANSI-C quoting (`$'...'`), a link created and written through in one call, the outputs of
// `tar -C` and `curl -o`, a program that runs its arguments as a command (`xargs aidrian ...`, `find ... -exec
// aidrian ...`), and a path built from a variable. The gate's own checks (lib/handoff-markers.mjs) keep what gets past
// harmless: a stray marker of the wrong shape, time, or host process is never delivered.

import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { checkDeadline } from './deadline.mjs';
import { bashCall, globNamesFile, opaqueTexts, writeTargets } from './config-guard.mjs';
import { foldCase, globParts, isWithin, partsReach } from './fs.mjs';
import { globLinksTo, globStarts, linkWalk } from './glob-links.mjs';
import { ARMING_FILE, storePath } from './handoff-markers.mjs';
import { opaqueShellCommand } from './hosts/index.mjs';
import { stateRoot } from './project.mjs';
import { canonical } from './rules/main-checkout.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';

const isSubagent = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';

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
  if (opaque !== null ? !OPAQUE_CONTINUE.every((word) => texts.some((text) => word.test(text))) : !walkCommands(command, null).some(runsContinue)) return null;
  const why = 'it runs `aidrian handoff continue`, which arms a continuation of the main session, and only the main session may run it';
  return { match: 'runs aidrian handoff continue', reason: projectRuleReason(input, why, human, 'that the brief is checked; the main session runs the gate') };
}

const OPAQUE_CONTINUE = [/\bhandoff\b/iu, /\bcontinue\b/iu];

function runsContinue({ invocation, unread }) {
  if (unread !== undefined && /\bhandoff\b[^\n;|&]*\bcontinue\b/u.test(unread)) return true;
  if (invocation.dynamic) {
    const words = invocation.args.filter((token) => !token.dynamic).map((token) => token.text);
    const at = words.indexOf('handoff');
    if (at !== -1 && words.includes('continue', at + 1)) return true;
  }
  const [first, ...rest] = aidrianArgs(invocation) ?? [];
  if (!first) return false;
  if (first.dynamic) return !rest.some((token) => !token.dynamic && ['check', 'snapshot'].includes(token.text));
  if (first.text !== 'handoff') return false;
  const action = rest.find((token) => !token.text.startsWith('-'));
  return action?.dynamic === true || rest.some((token) => token.text === 'continue');
}

// A path part named as a file whose forgery would arm or deliver a continuation, in any case. A chain floor or a task
// record (`from-`, `tasks-`) is not one: their names are common words, and the path rules cover them.
const MARKER_NAME = new RegExp(ARMING_FILE.source, 'iu');
// An unsure glob's part whose plain start names such a file, as `armed-*`.
const MARKER_GLOB = /^(?:armed|ready|taken|gone|checked)-/iu;
// A word of a command no lexer reads that names the store's folder by its own name.
const STORE_FOLDER = /^\.continue$/iu;
// A text that names the store's folder, or a marker in it.
const STORE_NAME = /(?<![\w.-])(?:handoffs\/\.continue(?![\w-])|\.continue\/(?:armed|ready|from|checked|gone|tasks|taken)-)/iu;
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

// Why the subagent call in `input` may not run because it writes in the continuation store of the state folder `state`
// gives, or null: { match, reason }. `state` is called only when a target may lie in the store, so a call that writes
// nowhere near the state root runs no git. It writes there when a target lies in the store, or is a folder that holds
// it and no checkout, or a glob may reach the store, by the path it spells or through a link already on disk in any part
// it expands (globLinksTo), as `tee /tmp/alias*` does when `/tmp/alias` links to a marker, and `/va*/...` through
// macOS's `/var`; a target in a folder no path names, or code an interpreter runs,
// counts when it names `handoffs/.continue`, a marker below `.continue/`, or a path part named as a file that arms or
// delivers (MARKER_NAME), or, for a glob, starts as one (MARKER_GLOB). A glob word of a command in a shell the lexer
// cannot read counts by those names, and when it names the store by its name, as `.con*`, `han*`, or `handoffs/*` do, from any folder
// (globNamesFile), since such a shell may change its folder first. Such a command may only read what it names, so its
// block says it may change the store. With `links` false it skips the link walk, which reads folders on disk, so the
// agent gate hook asks it so first, and again with the walk after the other guards' cheaper checks.
export function continueStoreWriteDenial(input, project, { names: { human }, state: { dir } }, state, { links = true } = {}) {
  if (!isSubagent(input)) return null;
  const opaque = opaqueShellCommand(input) !== null;
  const { files, names, globs } = writeTargets(input);
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the handoff continuation store, where only the main session's \`aidrian handoff\` commands write`, human);
  // A command no lexer reads may join `.continue` to a path it builds, as a path joiner does.
  const joined = opaque && names.some((name) => name.split('/').some((part) => STORE_FOLDER.test(part)));
  const unsure = (glob) => ((glob.unsure || glob.opaque) && globNamesStore(glob.text)) || (glob.opaque && globNamesFile(glob.text, STORE_TAIL));
  if (joined || names.some(namesStore) || globs.some(unsure)) {
    return { match: 'may change the continuation store', reason: why('may change', 'handoffs/.continue') };
  }
  const sure = globs.filter((glob) => !glob.unsure);
  const known = sure.flatMap(globPaths);
  if (files.length === 0 && known.length === 0) return null;
  const root = real(stateRoot());
  const near = (target) => isWithin(root, target) || isWithin(target, root);
  // A glob anywhere may pass a link into the state root; the walk reads each folder once a call (linkWalk).
  const seen = linkWalk(input);
  const linksTo = (target) => links && sure.some((glob) => globLinksTo(glob, target, seen, { below: true }));
  if (!dir && ![...files.map(real), ...known.map(({ prefix }) => prefix)].some(near) && !linksTo(root)) return null;
  const store = real(storePath(state()));
  const roots = project.checkouts.map(real);
  const holds = (target) => target !== store && isWithin(target, store);
  const hit = files.map(real).some((target) => isWithin(store, target) || (holds(target) && !roots.some((each) => isWithin(target, each))))
    || known.some((glob) => globReaches(glob, store)) || linksTo(store);
  if (!hit) return null;
  const verb = opaque ? 'may change' : 'changes';
  return { match: `${verb} the continuation store`, reason: why(verb, store) };
}
