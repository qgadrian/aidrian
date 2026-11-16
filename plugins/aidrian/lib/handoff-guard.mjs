// The guard that keeps a subagent out of the handoff continuation (docs/handoff.md#continue), with or without gates:
// it may not run `aidrian handoff continue`, which arms a continuation of the main session, nor write in the
// continuation store, `<state>/handoffs/.continue/` (lib/handoff-markers.mjs). scripts/hook-agent-gates.mjs asks it
// before every tool call. A host's other tools that run a shell command, such as Claude Code's Monitor, reach it as Bash
// calls (lib/hosts/claude-code.mjs hookInput). It reads a call's targets as lib/config-guard.mjs does, and, like that guard, it is for
// agents that cooperate: what the shared lexer cannot see, it cannot see either. The known limits of that lexer, which
// this guard accepts: brace expansion (`{a,b}`), ANSI-C quoting (`$'...'`), a link created and written through in one
// call, the outputs of `tar -C` and `curl -o`, a program that runs its arguments as a command (`xargs aidrian ...`,
// `find ... -exec aidrian ...`), and a path built from a variable. The gate's own checks (lib/handoff-markers.mjs)
// keep what gets past harmless: a stray marker of the wrong shape, time, or host process is never delivered.

import path from 'node:path';

import { projectRuleReason } from './agent-gates.mjs';
import { bashCall, writeTargets } from './config-guard.mjs';
import { globParts, isWithin } from './fs.mjs';
import { ARMING_FILE, foldCase, storePath } from './handoff-markers.mjs';
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
// read as aidrian.
export function handoffContinueDenial(input, { names: { human } }) {
  const command = input.tool_input?.command;
  if (!isSubagent(input) || !bashCall(input) || typeof command !== 'string') return null;
  if (!walkCommands(command, null).some(runsContinue)) return null;
  const why = 'it runs `aidrian handoff continue`, which arms a continuation of the main session, and only the main session may run it';
  return { match: 'runs aidrian handoff continue', reason: projectRuleReason(input, why, human, 'that the brief is checked; the main session runs the gate') };
}

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
// A text that names the store's folder, or a marker in it.
const STORE_NAME = /(?<![\w.-])(?:handoffs\/\.continue(?![\w-])|\.continue\/(?:armed|ready|from|checked|gone|tasks|taken)-)/iu;
// A disk that folds case reaches the store by any spelling of its path.
const fold = foldCase;
const FOLD_FLAG = foldCase('A') === 'a' ? 'i' : '';
const real = (file) => fold(canonical(file));

// Whether a text from a folder no path gives names the store or one of its files.
const namesStore = (text) => STORE_NAME.test(text) || text.split('/').some((part) => MARKER_NAME.test(part));
// Whether a glob from a folder no path gives may name one of those files.
const globNamesStore = (text) => namesStore(text) || text.split('/').some((part) => MARKER_GLOB.test(part.split(/[*?[]/u)[0]) && GLOB.test(part));

const GLOB = /[*?[]/u;

// Each spelling of a glob write from a known folder, as { prefix, rest }: `prefix` is the real, case-folded path of its
// parts before the first glob, and `rest` the parts from there on, a glob or a plain name each.
function globPaths({ text, dirs = [] }) {
  const spelled = path.isAbsolute(text) ? [text] : dirs.map((dir) => path.join(dir, text));
  return spelled.map((each) => {
    const parts = path.resolve(each).split(path.sep);
    const at = parts.findIndex((part) => GLOB.test(part));
    return { prefix: real(parts.slice(0, at).join(path.sep) || path.sep), rest: parts.slice(at) };
  });
}

// Whether a glob write reaches the store: each part it spells matches the store's part at that depth, so it names the
// store, a file in it, or a folder that holds it. A part that is only stars, such as zsh's `**`, matches any number of
// parts, none included.
function globReaches({ prefix, rest }, store) {
  // The root splits to two empty parts: only the first stands for it.
  const split = (file) => file.split(path.sep).filter((part, i) => i === 0 || part !== '');
  const target = [...split(prefix), ...rest];
  const parts = split(store);
  const matches = (part, name) => (GLOB.test(part) ? globParts(part, [], FOLD_FLAG).pattern.test(name) : fold(part) === name);
  const reach = (t, s) => {
    if (t === target.length || s === parts.length) return true;
    if (/^\*{2,}$/u.test(target[t])) return reach(t + 1, s) || reach(t, s + 1);
    return matches(target[t], parts[s]) && reach(t + 1, s + 1);
  };
  return reach(0, 0);
}

// Why the subagent call in `input` may not run because it writes in the continuation store of the state folder `state`
// gives, or null: { match, reason }. `state` is called only when a target may lie in the store, so a call that writes
// nowhere near the state root runs no git. It writes there when a target lies in the store, or is a folder that holds
// it and no checkout, or a glob may reach the store; a target in a folder no path names, or code an interpreter runs,
// counts when it names `handoffs/.continue`, a marker below `.continue/`, or a path part named as a file that arms or
// delivers (MARKER_NAME), or, for a glob, starts as one (MARKER_GLOB).
export function continueStoreWriteDenial(input, project, { names: { human }, state: { dir } }, state) {
  if (!isSubagent(input)) return null;
  const { files, names, globs: written } = writeTargets(input);
  // The lexer reads `[.]continue` as a plain word; the shell expands it as a glob.
  const globs = [...written, ...files.filter((file) => /\[[^/]*\]/u.test(file)).map((file) => ({ text: file, dirs: [], unsure: false }))];
  const why = (verb, shown) => projectRuleReason(input, `it ${verb} ${shown}, the handoff continuation store, where only the main session's \`aidrian handoff\` commands write`, human);
  if (names.some(namesStore) || globs.some((glob) => glob.unsure && globNamesStore(glob.text))) {
    return { match: 'may change the continuation store', reason: why('may change', 'handoffs/.continue') };
  }
  const known = globs.filter((glob) => !glob.unsure).flatMap(globPaths);
  if (files.length === 0 && known.length === 0) return null;
  const root = real(stateRoot());
  const near = (target) => isWithin(root, target) || isWithin(target, root);
  if (!dir && ![...files.map(real), ...known.map(({ prefix }) => prefix)].some(near)) return null;
  const spelled = storePath(state());
  const store = real(spelled);
  const roots = project.checkouts.map(real);
  const holds = (target) => target !== store && isWithin(target, store);
  // A glob in a part the real path renames, as `/va*` for macOS's `/var`, reaches the store as the path spells it.
  const stores = [...new Set([store, fold(path.resolve(spelled))])];
  const hit = files.map(real).some((target) => isWithin(store, target) || (holds(target) && !roots.some((each) => isWithin(target, each))))
    || known.some((glob) => stores.some((each) => globReaches(glob, each)));
  return hit ? { match: 'changes the continuation store', reason: why('changes', store) } : null;
}
