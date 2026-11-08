// How a `cd`, `pushd`, or `popd` moves the shell, for the main-checkout rule (lib/rules/main-checkout.mjs).
//
// A `cd` can fail and still return 0, as a shell alias or function for cd can: the shell then stays where it was. From
// a guarded main checkout, a `cd`, `pushd`, or `popd` is trusted only when it names folders that exist, each in a
// checkout of the same repository. Into a linked worktree, nothing after it is judged, as before; inside the main
// checkout, the shell is there whether it works or not, so what follows is judged at the folders before and after it.
// Any other `cd` is untrusted: what follows is judged against the folders before it, for the rest of the line.

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

// How the directory change `change` ({ program, to }) moves a shell that may be in any of `from`, when one of them is
// a guarded main checkout in `mains`: { kind: 'worktree' }, { kind: 'main', dests }, or { kind: 'untrusted' }.
export function trustOf(change, from, mains) {
  const { program, to } = change;
  if (program === 'popd' || !to || to.dynamic || to.text.startsWith('~')) return { kind: 'untrusted' };
  const dests = path.isAbsolute(to.text) ? [to.text] : from.map((dir) => path.resolve(dir, to.text));
  if (!dests.length) return { kind: 'untrusted' };
  let inMain = false;
  for (const dest of dests) {
    const roots = isDirectory(dest) ? rootsOf(dest) : null;
    if (!roots || !mains.has(canonical(roots.main))) return { kind: 'untrusted' };
    if (canonical(roots.current) === canonical(roots.main)) inMain = true;
  }
  return inMain ? { kind: 'main', dests } : { kind: 'worktree' };
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
// shown }, `shown` the change as the deny reason names it.
export function cdChange({ program, args, builtin = false }, from) {
  const to = program === 'popd' ? null : operand(args);
  const word = to ?? args.find((token) => !token.dynamic && /^(?:-|[+-]\d+)$/u.test(token.text));
  const name = builtin ? `builtin ${program}` : program;
  if (!word || word.text === '') return { from, to, program, shown: name };
  // The lexer drops quotes: a quoted expansion, or a literal word with a shell metacharacter in it, is shown quoted again.
  let text = word.text;
  if (word.dynamic && !word.splits && /[$`]/u.test(text)) text = `"${text}"`;
  else if (!word.dynamic && /[\s$`'"\\]/u.test(text)) text = text.includes("'") ? `"${text.replace(/["$`\\]/gu, '\\$&')}"` : `'${text}'`;
  return { from, to, program, shown: `${name} ${text}` };
}

// Where a target after the changes `cds` is judged, or null when it is not: { at, cd, last }, `at` the folders the
// shell may be in, `cd` the untrusted change shown, or null after changes inside the main checkout only, and `last`
// the last of those, as { shown, dests }.
export function afterChanges(cds) {
  const mains = mainsOf(cds[0].from);
  if (!mains.size) return null;
  let at = cds[0].from;
  let last = null;
  for (const change of cds) {
    const trust = trustOf(change, at, mains);
    if (trust.kind === 'untrusted') return { at, cd: change.shown, last };
    if (trust.kind === 'worktree') return null;
    at = [...new Set([...trust.dests, ...at])];
    last = { shown: change.shown, dests: trust.dests };
  }
  return { at, cd: null, last };
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
