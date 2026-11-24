// How a `cd`, `pushd`, or `popd` moves the shell, for the main-checkout rule (lib/rules/main-checkout.mjs).
//
// A `cd` can fail and still return 0, as a shell alias or function for cd can: the shell then stays where it was. From
// a guarded main checkout, a `cd`, `pushd`, or `popd` is trusted only when it names folders that exist, each in a
// checkout of the same repository. Into a linked worktree, what follows is judged there; inside the main checkout, the
// shell is there whether it works or not, so what follows is judged at the folders before and after it. Any other `cd`
// is untrusted: what follows is judged where the shell was and at each folder it names literally, or, for one that names
// none, at every folder the shell has been in on the line, for the rest of the line (moveShell). So is
// one the shell may never run, which the lexer marks `uncertain`, as behind `repeat 0`, zsh's `noglob` in bash, or a
// case arm or function body spaced from its parentheses. So is one through `command` (`viaCommand`): zsh's `command` runs
// no builtin, only a `cd` program, and the shell stays where it was.

import { statSync } from 'node:fs';
import path from 'node:path';

import { checkoutRoots } from '../../git.mjs';
import { canonical, guardedMain } from './checkout.mjs';

const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

// Whether `dir` is a folder, through links.
const isDirectory = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// checkoutRoots, read once per folder per hook run.
const rootsCache = new Map();
function rootsOf(dir) {
  if (!rootsCache.has(dir)) rootsCache.set(dir, checkoutRoots(dir));
  return rootsCache.get(dir);
}

// The guarded main checkouts the folders `dirs` are in, by their canonical root.
export function mainsOf(dirs) {
  const mains = new Set();
  for (const dir of dirs) {
    const main = guardedMain(dir);
    if (main) mains.add(canonical(main.roots.main));
  }
  return mains;
}

// How the directory change `change` ({ program, to, uncertain, viaCommand }) moves a shell that may be in any of `from`, when one of them is
// a guarded main checkout in `mains`: { kind: 'worktree', dests }, { kind: 'main', dests }, or { kind: 'untrusted', dests },
// `dests` the folders it names when it names them literally, which an untrusted change may never reach.
export function trustOf(change, from, mains) {
  const { program, to, uncertain = false, viaCommand = false } = change;
  const named = program === 'popd' || !to || to.dynamic || to.text.startsWith('~') ? [] : path.isAbsolute(to.text) ? [to.text] : from.map((dir) => path.resolve(dir, to.text));
  if (uncertain || viaCommand || !named.length) return { kind: 'untrusted', dests: named };
  let inMain = false;
  for (const dest of named) {
    const roots = isDirectory(dest) ? rootsOf(dest) : null;
    if (!roots || !mains.has(canonical(roots.main))) return { kind: 'untrusted', dests: named };
    if (canonical(roots.current) === canonical(roots.main)) inMain = true;
  }
  return { kind: inMain ? 'main' : 'worktree', dests: named };
}

// The folders a shell may be in after the directory change `change` from `state`, { at, seen, mains, untrusted }, for
// both readers of a line, the writes' (afterChanges) and the git calls' (git-state.mjs): `at` where it is if every
// trusted change worked, `seen` every folder it may have been in on the line, the start among them, `mains` the guarded
// main checkouts of the start, and `untrusted` the first change it cannot trust, as shown. A change into a linked worktree
// moves it there, and what follows is judged there, so a later `cd` back into the main checkout is judged as one; one
// inside the main checkout keeps the folders before it too, as a failed `cd` stays. Once a change is untrusted, the
// shell is where it was or where that change and each later one names literally, as `cd ../x` from inside the git folder
// leads back; a change that names no folder, as `cd -`, `popd`, or `cd "$S"`, may take it to any folder it has been in
// on the line.
export function moveShell(state, change) {
  const trust = trustOf(change, state.at, state.mains);
  const union = (...lists) => [...new Set(lists.flat())];
  let at;
  if (trust.kind === 'untrusted' || state.untrusted) at = trust.dests.length ? union(state.at, trust.dests) : union(state.seen, state.at);
  else at = trust.kind === 'worktree' ? trust.dests : union(trust.dests, state.at);
  const untrusted = state.untrusted ?? (trust.kind === 'untrusted' ? change.shown : null);
  return { at, seen: union(state.seen, at), mains: state.mains, untrusted, kind: trust.kind, dests: trust.dests };
}

// The state of a shell that starts in `from`, for moveShell, or null when no folder of it is in a guarded main checkout,
// where nothing is judged.
export function shellAt(from) {
  const mains = mainsOf(from);
  return mains.size ? { at: from, seen: from, mains, untrusted: null } : null;
}

// How many subshells the segment `segment` opens at its start and closes, by the lexer's unquoted parentheses (`paren`,
// `closes`): `(cd x` opens one, and `ls)` closes one; a case arm's pattern, the first of a segment's several words,
// closes none. A
// directory change inside a subshell moves nothing after it, so the readers keep the shell where it was before it.
export function subshells(segment) {
  const first = segment[0];
  const opens = first?.paren && !first.operator ? /^\(*/u.exec(first.text)[0].length : 0;
  const closes = segment.filter((token, at) => token.closes && (at > 0 || segment.length === 1)).reduce((sum, token) => sum + /\)*$/u.exec(token.text)[0].length, 0);
  return { opens, closes };
}

// The directory change an invocation makes, as { program, args }, or null: a `cd`, `pushd`, or `popd`, also behind
// `builtin`, which skips a shell function or alias of that name.
export function directoryChange(invocation) {
  if (CHANGES_DIRECTORY.has(invocation.program)) return invocation;
  const [first, ...args] = invocation.args ?? [];
  if (invocation.program !== 'builtin' || !first || first.dynamic || !CHANGES_DIRECTORY.has(first.text)) return null;
  return { ...invocation, program: first.text, args, builtin: true };
}

// The directory change `{ program, args }` (from directoryChange), as bashWrites records it: { from, to, program,
// shown, uncertain, viaCommand }, `shown` the change as the deny reason names it, `uncertain` the lexer's mark that the
// shell may never run it, and `viaCommand` whether it runs through `command`, which in zsh runs no builtin.
export function cdChange({ program, args, builtin = false, uncertain = false, viaCommand = false }, from) {
  const to = program === 'popd' ? null : operand(args);
  const word = to ?? args.find((token) => !token.dynamic && /^(?:-|[+-]\d+)$/u.test(token.text));
  const name = builtin ? `builtin ${program}` : program;
  if (!word || word.text === '') return { from, to, program, shown: name, uncertain, viaCommand };
  // The lexer drops quotes: a quoted expansion, or a literal word with a shell metacharacter in it, is shown quoted again.
  let text = word.text;
  if (word.dynamic && !word.splits && /[$`]/u.test(text)) text = `"${text}"`;
  else if (!word.dynamic && /[\s$`'"\\]/u.test(text)) text = text.includes("'") ? `"${text.replace(/["$`\\]/gu, '\\$&')}"` : `'${text}'`;
  return { from, to, program, shown: `${name} ${text}`, uncertain, viaCommand };
}

// Where a target after the changes `cds` is judged, or null when it is not: { at, cd, last }, `at` the folders the
// shell may be in (moveShell), `cd` the first untrusted change shown, or null after trusted changes only, and `last`
// the last trusted one, as { shown, dests }.
export function afterChanges(cds) {
  let state = shellAt(cds[0].from);
  if (!state) return null;
  let last = null;
  for (const change of cds) {
    state = moveShell(state, change);
    if (!state.untrusted) last = { shown: change.shown, dests: state.dests };
  }
  return { at: state.at, cd: state.untrusted, last };
}

// The folder a `cd` or `pushd` names: its first word that is not an option, past one `--` that ends the options. Null
// when no word names one: none, which is the home folder, `-`, the previous folder, or `+1`, a place on the directory
// stack.
function operand(args) {
  let i = 0;
  while (args[i] && !args[i].dynamic && /^-[LPe@]+$/u.test(args[i].text)) i += 1;
  if (args[i] && !args[i].dynamic && args[i].text === '--') i += 1;
  const to = args[i];
  return to && (to.dynamic || !/^(?:-|[+-]\d+)$/u.test(to.text)) ? to : null;
}
