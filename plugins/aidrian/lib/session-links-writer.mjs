// The writer's half of the session links: the rows of `links.jsonl`, which the ledger's PostToolUse Bash hook
// (scripts/hook-bash-post.mjs) writes for each worktree an `aidrian worktree new` of a shell call created, and the one check a row passes
// before it is written and again before lib/session-links.mjs reads it. Display data only: no hook, gate, skill, or
// agent decides anything from it, and the hook prints nothing. This file names no host, forge, or tracker.

import { isRefName, runGit } from './git.mjs';
import { hasHidden } from './hidden-text.mjs';
import { isRepository, outputTail, remoteRepository, validCwd } from './session-prs.mjs';
import { appendRows, parsed } from './session-rows.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';

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

// Each `aidrian worktree new` the shell line `command` runs from the folder `cwd`, read with lib/shell-lex.mjs:
// [{ branch, folder }], `folder` the folder it runs in as walkCommands follows a `cd`, once each. None for a call with a
// word the shell fills in, `--plan`, an option it does not know, a branch that starts with `-`, other than one branch,
// or a folder walkCommands cannot know, as after a `cd "$X"`.
export function worktreeBranches(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !/\bworktree\b/u.test(command)) return [];
  const found = new Map();
  for (const { invocation, folder } of walkCommands(command, cwd)) {
    const branch = invocation.dynamic || typeof folder !== 'string' ? null : newBranch(aidrianArgs(invocation));
    if (branch !== null) found.set(JSON.stringify([branch, folder]), { branch, folder });
  }
  return [...found.values()];
}

// What `aidrian worktree new` printed for each worktree it created in the call's output `output`: [{ branch, path }],
// from each line that is its JSON result with `status: "created"`, a branch, and an absolute `worktree_path`. A call
// that was skipped, refused (`status: "blocked"`), or only planned prints none, so it records nothing.
export function createdWorktrees(output) {
  if (typeof output !== 'string') return [];
  return outputTail(output).split('\n').flatMap((line) => {
    if (!line.includes('"created"')) return [];
    const result = parsed(line.trim());
    const { status, branch, worktree_path: made } = result ?? {};
    return status === 'created' && typeof branch === 'string' && isRefName(branch) && validCwd(made) ? [{ branch, path: made }] : [];
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

// The repository origin names in the main checkout `main`, or null: session-prs.mjs remoteRepository, the read the
// snapshot's remotes take (remoteRepos), so a row's repository and the reader's spell it alike, `url.<base>.insteadOf`
// rewrites left out on both sides. `git` options are runGit's.
export const originRepository = (main, git = {}) => remoteRepository(main, 'origin', (args, dir) => runGit(args, dir, git));

// Appends the worktree rows `rows` to the links of the session folder `folder`, through appendRows with no key: every
// row is written, and the reader settles repeats. Returns whether it wrote. Never throws.
export const recordLinks = (folder, rows) => appendRows(folder, LINKS, rows.filter(isWorktreeRow), { maxBytes: LINKS_MAX_BYTES });

