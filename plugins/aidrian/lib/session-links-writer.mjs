// The writer's half of the session links: the rows of `links.jsonl`, which the ledger's PostToolUse Bash hook
// (scripts/hook-bash-post.mjs) writes for each `aidrian worktree new` a shell call ran, and the one check a row passes
// before it is written and again before lib/session-links.mjs reads it. Display data only: no hook, gate, skill, or
// agent decides anything from it, and the hook prints nothing. This file names no host, forge, or tracker.

import { remoteIdentity } from './forges/index.mjs';
import { isRefName, runGit } from './git.mjs';
import { hasHidden } from './hidden-text.mjs';
import { isRepository, validCwd } from './session-prs.mjs';
import { appendRows } from './session-rows.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';

// The worktree a session creates: `links.jsonl` in its folder, one row `{ at, kind: "worktree", host, path, branch, cwd }`
// for each `aidrian worktree new` a shell call of the session ran (docs/hooks.md#session-ledger). Every row is appended,
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

// The branch of each `aidrian worktree new` the shell line `command` runs, read with lib/shell-lex.mjs: none for a call
// with a word the shell fills in, `--plan`, an option it does not know, a branch that starts with `-`, or other than
// one branch.
export function worktreeBranches(command) {
  if (typeof command !== 'string' || !/\bworktree\b/u.test(command)) return [];
  return [...new Set(walkCommands(command, null).flatMap(({ invocation }) => {
    const branch = invocation.dynamic ? null : newBranch(aidrianArgs(invocation));
    return branch === null ? [] : [branch];
  }))];
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

// The rows of the worktrees `branches` name, at `at`: each branch's entry of the worktree list of the main checkout
// `main`, not prunable, gives `cwd` as git spells its path; `origin`, the repository origin names as remoteIdentity
// reads it, or null, gives `host` and `path`. A branch git lists no worktree for gives none, and so does a row that fails
// isWorktreeRow, and a list that fails gives none. `list` is listWorktrees, which a test may replace.
export function worktreeRows({ branches, main, origin, at = new Date().toISOString(), list }) {
  if (branches.length === 0) return [];
  let listed;
  try {
    listed = list(main);
  } catch {
    return [];
  }
  return branches.flatMap((branch) => {
    const entry = listed.find((each) => each.branch === branch && !each.prunable);
    const row = entry && { at, kind: 'worktree', host: origin?.host ?? null, path: origin ? origin.path : null, branch, cwd: entry.path };
    return row && isWorktreeRow(row) ? [row] : [];
  });
}

// The repository origin names in the main checkout `main`, as remoteIdentity reads its URL, or null: one
// `git remote get-url origin` with constant arguments. `git` options are runGit's.
export function originRepository(main, git = {}) {
  const origin = runGit(['remote', 'get-url', 'origin'], main, git);
  const repo = origin.status === 0 ? remoteIdentity(origin.stdout.trim()) : null;
  return repo && { host: repo.host, path: repo.path };
}

// Appends the worktree rows `rows` to the links of the session folder `folder`, through appendRows with no key: every
// row is written, and the reader settles repeats. Returns whether it wrote. Never throws.
export const recordLinks = (folder, rows) => appendRows(folder, LINKS, rows.filter(isWorktreeRow), { maxBytes: LINKS_MAX_BYTES });

