// What a commit in the main checkout gets: config.json `git.mainCheckout.commits`, "block", "warn", or "allow", and
// `aidrian pre-commit`, which a project's pre-commit and pre-merge-commit git hooks run to enforce it.
// docs/config.md lists the key; docs/hooks.md § Commit guard describes the command.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.mjs';
import { checkoutRoots, runGit } from './git.mjs';
import { projectAt } from './project.mjs';

// The override, which the Human sets in their own shell; agents never set it.
export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_COMMIT';

// The mode for commits in the main checkout. null follows the guard: "block" when it is on, "allow" when it is off.
export function commitMode(config) {
  const { commits, guard } = config.git.mainCheckout;
  if (commits !== null) return commits;
  return guard ? 'block' : 'allow';
}

export const commands = {
  'pre-commit': {
    usage: '[--project DIR]',
    about: 'refuse a commit in the main checkout, or one that newly stages a git-ignored file, as config.json git.mainCheckout.commits says',
    run(args) {
      const { values } = parseArgs({ args, options: { project: { type: 'string' } } });
      if (process.env[OVERRIDE] === '1') return 0;
      // The hook runs in the checkout's top folder, with git's environment; --project changes only where the project is read.
      const cwd = process.cwd();
      // A missing or broken config.json gives the defaults, whose guard is off: a git hook never stops a commit over it.
      const { config } = loadConfig(projectAt(path.resolve(values.project ?? cwd)));
      const mode = commitMode(config);
      if (mode === 'allow') return 0;
      const { problems, unreadable } = commitProblems(cwd);
      // A check that cannot read its input finds nothing, and says so; what the other check found still counts.
      for (const what of unreadable) console.error(`aidrian pre-commit: ${what} unreadable; not checked`);
      if (!problems.length) return 0;
      const lines = [...problems, `the override is ${OVERRIDE}=1, which ${config.names.human} sets in their own shell; agents never set it`];
      const prefix = mode === 'warn' ? 'warning: aidrian pre-commit: ' : 'aidrian pre-commit: ';
      console.error(lines.map((line) => prefix + line).join('\n'));
      return mode === 'warn' ? 0 : 1;
    },
  },
};

// What is wrong with the commit git is about to make from `cwd`: { problems: [line], unreadable: [what] }. A check
// whose input git cannot give, as when it exits 128 or is stopped by the timeout, adds no problem and names that input
// in `unreadable`; the other check's problems stand. With no checkout to read, neither check runs. git runs with the
// hook's environment, so a GIT_INDEX_FILE that git set for the commit, as for a partial commit, is the index read.
export function commitProblems(cwd) {
  const roots = checkoutRoots(cwd);
  if (roots === null) return { problems: [], unreadable: ['the checkout'] };
  const problems = [];
  const unreadable = [];
  if (roots.main === roots.current) {
    // An unborn HEAD is a repository's first commit: no worktree can exist before it.
    const head = runGit(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
    if (head.status === 0) {
      problems.push('this is the main checkout, which sessions share; commit in a task worktree: aidrian worktree new <branch>');
    } else if (head.status !== 1) {
      unreadable.push('HEAD');
    }
  }
  const ignored = newlyIgnored(cwd, roots.current);
  if (ignored === null) unreadable.push('the staged files');
  for (const file of ignored ?? []) problems.push(`${file} is git-ignored but newly staged; unstage it: git rm --cached ${shellWord(file)}`);
  return { problems, unreadable };
}

// The paths the commit adds that git ignores, or null when git cannot answer. Only added paths count, so a file tracked
// before a later .gitignore matched it never refuses a commit. --no-renames reads a staged move as a delete and an add,
// so a move into an ignored folder counts, whatever diff.renames says. --no-index matches the ignore rules against a
// path the index holds. A gitlink under an ignored worktrees folder is such a path.
function newlyIgnored(cwd, top) {
  // No output cap: spawnSync's default of 1 MiB would stop git on a large `git add -f`, and read as git not answering.
  const added = runGit(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=A', '-z'], cwd, { maxBuffer: Infinity });
  if (added.status !== 0) return null;
  if (!added.stdout) return [];
  // diff names paths from the top folder, and check-ignore reads them from its own folder.
  const checked = runGit(['check-ignore', '--no-index', '-z', '--stdin'], top, { input: added.stdout, maxBuffer: Infinity });
  if (checked.status === 1) return [];
  if (checked.status !== 0) return null;
  return checked.stdout.split('\0').filter(Boolean);
}

// `file` as one shell word, quoted only when it needs it.
function shellWord(file) {
  return /^[\w./@+-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;
}
