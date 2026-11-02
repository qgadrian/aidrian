// What a commit in the main checkout gets: config.json `git.mainCheckout.commits`, "block", "warn", or "allow", and
// `aidrian pre-commit`, which a project's pre-commit and pre-merge-commit git hooks run to enforce it, and the session
// start lines that warn about commits and changes already in the main checkout.
// docs/config.md lists the key; docs/hooks.md § Commit guard describes the command, § Start lines the warnings.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.mjs';
import { checkoutRoots, mainRoot, runGit } from './git.mjs';
import { projectAt } from './project.mjs';

// The override, which the Human sets in their own shell; agents never set it.
export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_COMMIT';

// The mode for commits in the main checkout. null follows the guard: "block" when it is on, "allow" when it is off.
export function commitMode(config) {
  const { commits, guard } = config.git.mainCheckout;
  if (commits !== null) return commits;
  return guard ? 'block' : 'allow';
}

// The session-start warnings about the main checkout of `project`'s repository, zero to three lines: local
// <defaultBranch> ahead of origin/<defaultBranch>, the checkout on another branch or a detached HEAD, and changed
// tracked files. Local refs only, with no fetch. None in allow mode, or when git finds no checkout. Each line is one
// git call through runGit: a missing ref or a failing git drops that line alone, and a git stopped by the timeout drops
// its own line and, as runGit then stops waiting, the lines after it.
export function unpushedMainLine(project, config) {
  if (commitMode(config) === 'allow') return [];
  const main = mainRoot(project.root);
  if (main === null) return [];
  const branch = config.git.defaultBranch;
  const lines = [];

  const ahead = runGit(['rev-list', '--count', `refs/remotes/origin/${branch}..refs/heads/${branch}`, '--'], main);
  const count = ahead.status === 0 ? Number.parseInt(ahead.stdout, 10) : 0;
  if (count > 0) {
    lines.push(
      `Local ${branch} has ${count} commit${count === 1 ? '' : 's'} not on origin/${branch}; only worktrees commit here. ` +
        `Inspect: git log origin/${branch}..${branch}`,
    );
  }

  // Exit 1 with no output is a detached HEAD; any other failure is git not answering. The full ref, not --short, which
  // prints heads/<db> when a tag shares the branch's name.
  const head = runGit(['symbolic-ref', '-q', 'HEAD'], main);
  const current = head.stdout?.trim();
  if (head.status === 0 && current && current !== `refs/heads/${branch}`) {
    const name = current.startsWith('refs/heads/') ? current.slice('refs/heads/'.length) : current;
    lines.push(`The main checkout is on ${name}, not ${branch}; only worktrees change branch. Switch back: git switch ${branch}`);
  } else if (head.status === 1 && !current) {
    lines.push(`The main checkout's HEAD is detached, not on ${branch}. Switch back: git switch ${branch}`);
  }

  // --no-optional-locks: the main checkout is shared, so reading its status never takes the index lock. No output cap:
  // a long status must not read as git not answering.
  const status = runGit(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], main, { maxBuffer: Infinity });
  if (status.status === 0 && status.stdout.trim()) {
    lines.push('The main checkout has changed tracked files; task work belongs in a worktree. Inspect: git status');
  }
  return lines;
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
