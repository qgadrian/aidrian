// The writer's half of the session links: the rows of `links.jsonl`, which the ledger's PostToolUse Bash hook
// (scripts/hook-bash-post.mjs) writes for each worktree an `aidrian worktree new` of a shell call created, and the one check a row passes
// before it is written and again before lib/session-links.mjs reads it. Display data only: no hook, gate, skill, or
// agent decides anything from it, and the hook prints nothing. This file names no host, forge, or tracker.

import { isRefName, runGit } from './git.mjs';
import { hasHidden } from './hidden-text.mjs';
import { assigns, isRepository, knownFolders, OUTPUT_TAIL, remoteRepository, validCwd } from './session-prs.mjs';
import { appendRows, parsed } from './session-rows.mjs';
import { aidrianArgs, lexPipeline, readInvocation, shellRedirections, walkCommands } from './shell-lex.mjs';

// The worktree a session creates: `links.jsonl` in its folder, one row `{ at, kind: "worktree", host, path, branch, cwd }`
// for each worktree an `aidrian worktree new` of a shell call of the session created (docs/hooks.md#session-ledger). Every row is appended,
// with no key: the reader settles repeats, the newest row of each key deciding.
export const LINKS = 'links.jsonl';
export const LINKS_MAX_BYTES = 64 * 1024;
const LINK_KEYS = ['at', 'kind', 'host', 'path', 'branch', 'cwd'];

// Whether `row` is a worktree row of the shape the writer writes and the reader takes, every field checked: `at` an ISO
// time, `host` and `path` a repository (isRepository) or both null, `branch` a ref name with no hidden character, and
// `cwd` an absolute folder within 1,024 bytes with no hidden character, and no other key.
export const isWorktreeRow = (row) => row !== null && typeof row === 'object' && Object.keys(row).length === LINK_KEYS.length
  && LINK_KEYS.every((key) => Object.hasOwn(row, key)) && row.kind === 'worktree' && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
  && ((row.host === null && row.path === null) || isRepository(row.host, row.path))
  && typeof row.branch === 'string' && isRefName(row.branch) && !hasHidden(row.branch) && validCwd(row.cwd);

// The options of `aidrian worktree new` that take the next word as their value, and those that take none.
const VALUE_OPTIONS = new Set(['--base', '--slug']);
const FLAG_OPTIONS = new Set(['--fetch', '--reuse-existing']);

// What a lead command may be joined to the next by: they run in turn, in this shell, each after the last ends.
const IN_TURN = new Set(['&&', ';', '\n']);
const CHANGES_DIRECTORY = new Set(['cd', 'pushd', 'popd']);
// What may join the commands from the first call on, but for the line's last separator: `&&`, and a pipe inside a command.
const JOINED = new Set(['&&', '|', '|&']);
// A redirection that leaves the command's output where it was: one of its error output, or of its input.
const KEEPS_OUTPUT = /^(?:2>|0?<(?!>))/u;

// The `aidrian worktree new` calls of the shell line `command`, run from the payload's folder `cwd`, whose results the
// call's output holds in order, read with lib/shell-lex.mjs as the pull request ledger reads a `gh pr create`
// (session-prs.mjs): [{ branch, folder, at }], where `at` is the call's place among the line's results, so the `at`th
// result line of the output is that call's own (createdWorktrees). The line opens with its lead: bare variable
// assignments and `cd`s, joined by `&&`, `;`, or a newline, then one or more calls joined by `&&`, so nothing prints
// before the first call. From the first call on, the line is one list joined by `&&`, a pipe allowed inside a command
// after the calls, with only a `;` or a newline after its last command, so each call runs only once the one before it
// succeeded, and nothing after a call runs unless it succeeded: a line that prints a saved result after a call that
// printed none, with `;` or `||`, holds none. A call followed by a pipe, or one whose output goes elsewhere, is left
// out, with the calls after it. A substitution other than a plain `cat`, whose error output the shell does not capture,
// ends the lead before the command that holds it. What follows the calls may print anything. A line with a command
// before the first call that may print, or a `&` anywhere, holds none. `folder` is the folder the call runs in by the ledger's rule
// (knownFolders), which holds whether a host's payload names the folder the line started in or the one it ended in: one
// an absolute leading `cd` names, else `cwd` only when nothing on the line changes directory. A call with a word the
// shell fills in, `--plan`, an option it does not know, a branch that starts with `-`, other than one branch, or a folder
// the rule cannot know, as after a relative `cd` or `cd "$X"`, keeps its place and is not returned.
export function worktreeCalls(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !/\bworktree\b/u.test(command)) return [];
  const { segments, separators } = lexPipeline(command);

  // The line's own segments the walk keeps, in its order: it leaves out a `cd`, `pushd`, or `popd`.
  const kept = segments.flatMap((segment, index) => (CHANGES_DIRECTORY.has(readInvocation(segment).program) ? [] : [index]));
  const entries = walkCommands(command, cwd);
  const known = knownFolders(command, cwd, entries);
  // Whether segment `index` ends the line: its last, which a trailing `;` or newline may follow.
  const ends = (index) => index === segments.length - 1;
  const calls = [];
  let own = 0;
  for (const [index, entry] of entries.entries()) {
    // A substitution runs before the command that holds it, and the shell captures its output, not its error output.
    if (entry.line !== command) {
      if (entry.invocation.program === 'cat' && shellRedirections(entry.segment).length === 0) continue;
      break;
    }
    const at = kept[own];
    own += 1;
    const leading = calls.length === 0;
    if (leading && segments.slice(0, at).some((_, before) => !IN_TURN.has(separators[before]))) break;
    if (!isCall(entry)) {
      if (leading && assigns(entry)) continue;
      break;
    }
    const branch = entry.invocation.dynamic || typeof known[index] !== 'string' ? null : newBranch(aidrianArgs(entry.invocation));
    // From the first call on, the line is one list joined by `&&`, its pipes inside it: a command after a call runs only
    // once every call before it succeeded, so none prints where a call that printed nothing should have.
    if (leading && (separators.slice(at, -1).some((each) => !JOINED.has(each)) || ![null, ';', '\n'].includes(separators.at(-1)))) return [];
    if (separators[at] !== '&&' && !ends(at)) break;
    calls.push({ branch, folder: known[index], at: calls.length });
    if (separators[at] !== '&&') break;
  }
  return calls.filter(({ branch }) => branch !== null);
}

// Whether a walked command is an `aidrian worktree new` whose result reaches the call's output: not negated, with no
// redirection of its output.
function isCall({ invocation, segment }) {
  const [action, verb] = aidrianArgs(invocation) ?? [];
  return action?.text === 'worktree' && verb?.text === 'new' && !action.dynamic && !verb.dynamic && !invocation.negated
    && shellRedirections(segment).every((each) => KEEPS_OUTPUT.test(each));
}

// The results `aidrian worktree new` printed in the call's output `output`, in order: each line of the output's first
// 64 KiB (OUTPUT_TAIL) that is one JSON object with a string `status`, as `{ status, branch, path }`, which the command
// prints as its one line whatever happens. Lines of any other shape, such as a warning, are skipped.
export function printedResults(output) {
  if (typeof output !== 'string') return [];
  return output.slice(0, OUTPUT_TAIL).split('\n').flatMap((line) => {
    const result = parsed(line.trim());
    return typeof result?.status === 'string' ? [{ status: result.status, branch: result.branch, path: result.worktree_path }] : [];
  });
}

// The worktrees the calls of `command`, run from `cwd`, created by their own results in `output`: [{ branch, folder,
// path }], one for each call of worktreeCalls whose result, the one at its place among printedResults, has
// `status: "created"`, the call's branch, and an absolute `worktree_path`. A call that was skipped, refused
// (`status: "blocked"`), or only planned prints no such result, so it records nothing, and neither does a result
// printed at another call's place. Pairing stops at the first result that is neither created nor planned: that call
// failed, so no call after it ran, and no later place is any call's.
export function createdWorktrees(command, cwd, output) {
  const calls = worktreeCalls(command, cwd);
  const results = calls.length ? printedResults(output) : [];
  // A call that did not succeed ran nothing after it, so no later place is any call's.
  const failed = results.findIndex(({ status }) => status !== 'created' && status !== 'planned');
  return calls.flatMap(({ branch, folder, at }) => {
    const result = failed === -1 || at < failed ? results[at] : undefined;
    return result?.status === 'created' && result.branch === branch && validCwd(result.path) ? [{ branch, folder, path: result.path }] : [];
  });
}

function newBranch(args) {
  const [action, verb, ...rest] = args ?? [];
  if (action?.text !== 'worktree' || verb?.text !== 'new' || action.dynamic || verb.dynamic || rest.some((token) => token.dynamic)) return null;
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const { text } = rest[index];
    const option = text.split('=')[0];
    if (VALUE_OPTIONS.has(option)) index += text.includes('=') ? 0 : 1;
    else if (!FLAG_OPTIONS.has(text)) {
      if (text.startsWith('-')) return null;
      positionals.push(text);
    }
  }
  const [branch] = positionals;
  return positionals.length === 1 && isRefName(branch) && !hasHidden(branch) ? branch : null;
}

// The rows of the worktrees `branches` name, at `at`, each only as `created`, what createdWorktrees read of the call's
// output, says the call created it: the branch's entry of the worktree list of the main checkout `main`, not the main
// checkout, not prunable, and at the path the result names (`same(listed, printed)`, string equality unless a caller
// gives one that resolves links), gives `cwd` as git spells its path; `origin`, the repository origin names as
// originRepository reads it, or null, gives `host` and `path`. A branch with no such result or entry gives none, and so
// does a row that fails isWorktreeRow; a list that fails gives none. `list` is listWorktrees, which a test may replace.
export function worktreeRows({ branches, created, main, origin, at = new Date().toISOString(), list, same = (a, b) => a === b }) {
  const made = branches.flatMap((branch) => created.filter((each) => each.branch === branch));
  if (made.length === 0) return [];
  let listed;
  try {
    listed = list(main);
  } catch {
    return [];
  }
  return [...new Set(made.map(({ branch }) => branch))].flatMap((branch) => {
    const entry = listed.find((each) => each.branch === branch && !each.main && !each.prunable);
    if (!entry || !made.some((each) => each.branch === branch && same(entry.path, each.path))) return [];
    const row = { at, kind: 'worktree', host: origin?.host ?? null, path: origin ? origin.path : null, branch, cwd: entry.path };
    return isWorktreeRow(row) ? [row] : [];
  });
}

// The repository origin names in the folder `folder`, the checkout the command ran in, so a worktree-specific origin
// (`config.worktree`, `includeIf.onbranch`) is the one that checkout's later sessions read; or null:
// session-prs.mjs remoteRepository, the read the snapshot's remotes take (remoteRepos), so a row's repository and the
// reader's spell it alike, `url.<base>.insteadOf` rewrites left out on both sides. `git` options are runGit's.
export const originRepository = (folder, git = {}) => remoteRepository(folder, 'origin', (args, dir) => runGit(args, dir, git));

// Appends the worktree rows `rows` to the links of the session folder `folder`, through appendRows with no key: every
// row is written, and the reader settles repeats. Returns whether it wrote. Never throws.
export const recordLinks = (folder, rows) => appendRows(folder, LINKS, rows.filter(isWorktreeRow), { maxBytes: LINKS_MAX_BYTES });

