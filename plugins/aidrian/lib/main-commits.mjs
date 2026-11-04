// The commit guard, on while config.json `git.mainCheckout.guard` is: `aidrian pre-commit`, which a project's pre-commit
// and pre-merge-commit git hooks run to refuse a commit in the main checkout or one that newly stages a git-ignored file,
// and the session start lines that warn about commits and changes already in the main checkout, and about an override
// the session inherited. docs/hooks.md § Commit guard describes the command, § Start lines the warnings.
// No dependencies: this file runs from the installed plugin, which has no node_modules.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { configFromText, DEFAULTS, loadConfig } from './config.mjs';
import { isFile, isWithin, resolvedPath } from './fs.mjs';
import { checkoutRoots, mainRoot, runGit } from './git.mjs';
import { findProject, projectAt } from './project.mjs';

// The override, which the Human puts in front of one command in their own terminal; agents never set it.
export const OVERRIDE = 'AIDRIAN_ALLOW_MAIN_COMMIT';

const MAIN_CHECKOUT = 'this is the main checkout, which sessions share; commit in a task worktree: aidrian worktree new <branch>';

// The start line for a session that inherited the override, or null: with it set in the session's environment, every
// commit an agent makes runs with it, and the guard lets each one through.
export function inheritedOverrideLine(config, env = process.env) {
  if (!config.git.mainCheckout.guard || env[OVERRIDE] !== '1') return null;
  return (
    `${OVERRIDE} is set in this session, so the commit guard lets every commit through. ` +
    'Tell the Human: restart the session without it, and use it per command in their own terminal.'
  );
}

// The session-start warnings about the main checkout of `project`'s repository, zero to three lines: local
// <defaultBranch> ahead of origin/<defaultBranch>, the checkout on another branch or a detached HEAD, and changed
// tracked files. Local refs only, with no fetch. None while the guard is off, or when git finds no checkout. Each line
// is one git call through runGit: a missing ref or a failing git drops that line alone, and a git stopped by the
// timeout drops its own line and, as runGit then stops waiting, the lines after it.
export function unpushedMainLine(project, config) {
  if (!config.git.mainCheckout.guard) return [];
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
    about: 'refuse a commit in the main checkout, or one that newly stages a git-ignored file, while config.json git.mainCheckout.guard is on',
    run(args) {
      const { values } = parseArgs({ args, options: { project: { type: 'string' } } });
      if (process.env[OVERRIDE] === '1') return 0;
      // The hook runs in the checkout's top folder, with git's environment; --project changes only where the project is read.
      const cwd = process.cwd();
      const project = values.project === undefined ? committingProject(cwd) : projectAt(path.resolve(values.project));
      // One that is there but does not load gives the defaults, and says so: a git hook never stops a commit over it.
      const loaded = loadConfig(project);
      const present = isFile(path.join(project.root, project.paths.config));
      if (!loaded.current && present) {
        console.error('aidrian pre-commit: config.json unreadable; not checked');
        return 0;
      }
      const config = present ? loaded.config : configOnBranch(project, cwd);
      if (config === null) {
        console.error('aidrian pre-commit: the committed config.json unreadable; not checked');
        return 0;
      }
      if (!config.git.mainCheckout.guard) return 0;
      const { problems, unreadable } = commitProblems(cwd);
      // A check that cannot read its input finds nothing, and says so; what the other check found still counts.
      for (const what of unreadable) console.error(`aidrian pre-commit: ${what} unreadable; not checked`);
      if (!problems.length) return 0;
      const lines = [
        ...problems,
        `the override is per command, in ${config.names.human}'s own terminal: ${OVERRIDE}=1 git commit …; ` +
          'never exported before a session, and agents never set it',
      ];
      console.error(lines.map((line) => `aidrian pre-commit: ${line}`).join('\n'));
      return 1;
    },
  },
};

// The project whose guard judges a commit git makes from `cwd`. A commit routed through GIT_DIR or --git-dir from a
// folder outside the repository runs the hook there, where no project is found: then the project is the one in the
// main checkout git names, the folder that holds the common git folder, as checkoutRoots reads it.
function committingProject(cwd) {
  return findProject(cwd) ?? projectAt(commonParent(cwd) ?? cwd);
}

// The folder that holds the common git folder, or null when git cannot say.
function commonParent(cwd) {
  const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common.status === 0 && common.stdout.trim() ? path.dirname(common.stdout.trim()) : null;
}

// The config's paths from the top of the repository, as `<ref>:<path>` reads them, joined rather than asked of git in
// project.root: after an orphan switch a project below the top no longer exists on disk. One per top the project is
// under: the checkout's and the folder that holds the common git folder. A commit routed through GIT_DIR has git take
// `cwd` for the top, and a `cwd` above the repository holds the project by a path no ref has, so the caller reads the
// one a ref holds. Empty for a project outside both. Symlinks are resolved, as git resolves the top.
function configsFromTop(project, cwd) {
  const root = resolvedPath(project.root);
  if (root === null) return [];
  const tops = new Set([checkoutRoots(cwd)?.current, commonParent(cwd)]);
  return [...tops].filter((top) => top && isWithin(top, root)).map((top) => {
    const rel = path.relative(top, root);
    return rel ? `${rel.split(path.sep).join('/')}/${project.paths.config}` : project.paths.config;
  });
}

// The config for a working tree that has no config.json. With HEAD born, or in a repository with no branch yet, the
// defaults, whose guard is off: the checked-out commit has no config, so the project has not opted in. With HEAD unborn
// in a repository that has branches, as after `git switch --orphan`, which empties the working tree, config.json with
// it, the config committed on the repository's default branch: origin/HEAD when it resolves, else the local branch
// named DEFAULTS.git.defaultBranch, else the first branch whose tree holds the config path. A ref with no config.json
// gives the defaults too. null when git cannot answer, or the project is outside the checkout.
function configOnBranch(project, cwd) {
  const head = runGit(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
  if (head.status === 0) return DEFAULTS;
  if (head.status !== 1) return null;
  const branches = runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], cwd);
  if (branches.status !== 0) return null;
  const names = branches.stdout.split('\n').filter(Boolean);
  if (!names.length) return DEFAULTS;
  const files = configsFromTop(project, cwd);
  if (!files.length) return null;
  const resolves = (ref) => runGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd).status === 0;
  const heldAt = (ref) => files.find((file) => runGit(['cat-file', '-e', `${ref}:${file}`], cwd).status === 0);
  const ref =
    ['refs/remotes/origin/HEAD', `refs/heads/${DEFAULTS.git.defaultBranch}`].find(resolves) ?? names.find(heldAt);
  if (ref === undefined) return DEFAULTS;
  // 128 is git saying the ref has no such file.
  const shown = runGit(['show', `${ref}:${heldAt(ref) ?? files[0]}`], cwd, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (shown.status === 128) return DEFAULTS;
  return shown.status === 0 ? configFromText(shown.stdout, project.paths.config) : null;
}

// What is wrong with the commit git is about to make from `cwd`: { problems: [line], unreadable: [what] }. A check
// whose input git cannot give, as when it exits 128 or is stopped by the timeout, adds no problem and names that input
// in `unreadable`; the other check's problems stand. With no checkout to read, neither check runs. git runs with the
// hook's environment, so a GIT_INDEX_FILE that git set for the commit, as for a partial commit, is the index read, and
// a GIT_DIR the commit was routed through is the repository judged.
export function commitProblems(cwd) {
  const roots = checkoutRoots(cwd);
  if (roots === null) return { problems: [], unreadable: ['the checkout'] };
  const problems = [];
  const unreadable = [];
  if (roots.main === roots.current) {
    const head = runGit(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
    if (head.status === 0) {
      problems.push(MAIN_CHECKOUT);
    } else if (head.status !== 1) {
      unreadable.push('HEAD');
    } else {
      // An unborn HEAD is a repository's first commit only while it has no branch or tag: no worktree can exist before
      // it. An orphan branch in a repository with history is still a commit in the main checkout.
      const refs = runGit(['for-each-ref', '--count=1', 'refs/heads', 'refs/tags'], cwd);
      if (refs.status !== 0) unreadable.push('the refs');
      else if (refs.stdout.trim()) problems.push(MAIN_CHECKOUT);
    }
  }
  const ignored = newlyIgnored(cwd, roots.current);
  if (ignored === null) unreadable.push('the staged files');
  // A squash merge or a path restored from another branch adds a file that branch may track; the commit is refused all
  // the same, but the advice leaves that case to the Human, as unstaging it would drop it from the branch.
  for (const file of ignored ?? []) {
    problems.push(
      `${file} is git-ignored but newly staged; unstage it with git rm --cached ${shellWord(file)}, ` +
        'unless another branch already tracks it; then ask the Human',
    );
  }
  return { problems, unreadable };
}

// The paths the commit adds that git ignores and no parent tracks, or null when git cannot answer. Only added paths
// count, so a file tracked before a later .gitignore matched it never refuses a commit. --no-renames reads a staged
// move as a delete and an add, so a move into an ignored folder counts, whatever diff.renames says. --no-index matches
// the ignore rules against a path the index holds. A gitlink under an ignored worktrees folder is such a path.
// A merge adds what the other parent holds: a git-ignored file that parent already tracks, such as a force-added
// .env.example, is not newly staged, and `git rm --cached` on it would delete it from that branch.
function newlyIgnored(cwd, top) {
  // No output cap: spawnSync's default of 1 MiB would stop git on a large `git add -f`, and read as git not answering.
  const added = runGit(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=A', '-z'], cwd, { maxBuffer: Infinity });
  if (added.status !== 0) return null;
  if (!added.stdout) return [];
  // diff names paths from the top folder, and check-ignore reads them from its own folder.
  const checked = runGit(['check-ignore', '--no-index', '-z', '--stdin'], top, { input: added.stdout, maxBuffer: Infinity });
  if (checked.status === 1) return [];
  if (checked.status !== 0) return null;
  const ignored = checked.stdout.split('\0').filter(Boolean);
  const tracked = new Set();
  for (const parent of mergeParents(top)) {
    for (const chunk of argumentChunks(ignored)) {
      // ls-tree reads its paths literally; `./` keeps a name that starts with `:` from reading as pathspec magic.
      const args = ['ls-tree', '-r', '--name-only', '--full-name', '-z', parent, '--', ...chunk.map((file) => `./${file}`)];
      const listed = runGit(args, top, { maxBuffer: Infinity });
      // A git stopped by the timeout cannot answer. A parent git cannot read, such as a stray GITHEAD_ name, exempts nothing.
      if (listed.status === null) return null;
      if (listed.status === 0) for (const file of listed.stdout.split('\0')) if (file) tracked.add(file);
    }
  }
  return ignored.filter((file) => !tracked.has(file));
}

// The other parents of the commit git is about to make: the lines of MERGE_HEAD while a merge waits for its commit, as
// after a conflict, and the GITHEAD_<oid> names `git merge` sets for its pre-merge-commit hook, which runs before
// MERGE_HEAD is written. None outside a merge. A parent that is HEAD or one of its ancestors is dropped: merging it
// brings nothing in, so only a name set by hand, such as a GITHEAD_ for an older commit that tracked the path, names one.
function mergeParents(cwd) {
  const parents = new Set();
  for (const name of Object.keys(process.env)) {
    const oid = /^GITHEAD_([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(name)?.[1];
    if (oid) parents.add(oid);
  }
  const file = runGit(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], cwd);
  if (file.status === 0 && isFile(file.stdout.trim())) {
    try {
      for (const line of readFileSync(file.stdout.trim(), 'utf8').split('\n')) {
        if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(line.trim())) parents.add(line.trim());
      }
    } catch {
      // A MERGE_HEAD that cannot be read names no parent.
    }
  }
  return [...parents].filter((oid) => runGit(['merge-base', '--is-ancestor', oid, 'HEAD'], cwd).status === 1);
}

// `files` in groups small enough for one command line each.
function argumentChunks(files, limit = 128 * 1024) {
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const file of files) {
    if (chunk.length && bytes + file.length > limit) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(file);
    bytes += file.length + 3;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

// `file` as one shell word, quoted only when it needs it.
function shellWord(file) {
  return /^[\w./@+-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;
}
