// `aidrian check` validates a project folder end to end, knowledge budgets included; `aidrian init` sets one up;
// `aidrian state` prints the machine-local state folder. docs/project-folder.md describes all three.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, VERSION } from './config.mjs';
import { linksOutside } from './fs.mjs';
import { isIgnored } from './git.mjs';
import { checkBudgets, indexRows, loadKnowledge } from './knowledge.mjs';
import { findProject, projectAt, repoRoot, stateDir, worktreesDir } from './project.mjs';

const OPTIONS = { project: { type: 'string' } };

export const commands = {
  check: {
    usage: '[--project DIR]',
    about: 'validate the project folder: its root files, config.json, every knowledge index and its budgets, and the .gitignore lines',
    run(args) {
      const start = path.resolve(parseArgs({ args, options: OPTIONS }).values.project ?? '.');
      const project = findProject(start);
      if (!project) {
        console.error(`no project folder at or above ${start}; run aidrian init`);
        return 1;
      }
      const { config, buckets, errors } = loadKnowledge(project);
      const budgets = checkBudgets(project.root, buckets, config.knowledge.budgets);
      errors.push(...budgets.problems);
      for (const { line, gitignore } of unignored(project, config)) {
        errors.push(`${line} is not git-ignored: add the line "${line}" to ${gitignore}, or run aidrian init`);
      }
      if (budgets.warnings.length) console.error(budgets.warnings.map((warning) => `warning: ${warning}`).join('\n'));
      if (errors.length) {
        console.error(errors.join('\n'));
        return 1;
      }
      const counts = project.sources.map((source) => {
        const own = buckets.filter((bucket) => bucket.source === (source.local ? source.label : null));
        const docs = indexRows(own).length;
        return `${source.label} (${own.length} bucket${own.length === 1 ? '' : 's'}, ${docs} doc${docs === 1 ? '' : 's'})`;
      });
      console.log(`ok: ${counts.join(', ')}\nstate: ${stateDir(project, { config })}\nbudget: ${budgets.summary}`);
      return 0;
    },
  },
  init: {
    usage: '[--project DIR]',
    about: `create the project folder with a version ${VERSION} config.json, and add its local files to .gitignore`,
    run(args) {
      const start = path.resolve(parseArgs({ args, options: OPTIONS }).values.project ?? '.');
      const project = projectAt(start);
      if (project.errors.length) {
        console.error(project.errors.join('\n'));
        return 1;
      }
      const done = [];
      const setUp = existsSync(path.join(project.root, project.paths.config));
      const missing = Map.groupBy(unignored(project, commandConfig(project)), (entry) => entry.gitignore);
      // Every write must land in its folder once symlinks are resolved: the project folder's files in the project, and
      // each .gitignore in its own folder. One that would not stops init before it writes anything.
      const writes = [
        ...(setUp ? [] : [project.paths.knowledge, project.paths.config].map((rel) => ({ root: project.root, rel, shown: rel }))),
        ...[...missing.keys()].map((gitignore) => ({ root: path.dirname(path.join(project.root, gitignore)), rel: '.gitignore', shown: gitignore })),
      ];
      const outside = writes.filter(({ root, rel }) => linksOutside(root, rel));
      if (outside.length) {
        console.error(outside.map(({ root, shown }) => `${shown}: links outside ${root}; init wrote nothing`).join('\n'));
        return 1;
      }
      if (!setUp) {
        mkdirSync(path.join(project.root, project.paths.knowledge), { recursive: true });
        writeFileSync(path.join(project.root, project.paths.config), `${JSON.stringify({ version: VERSION }, null, 2)}\n`);
        done.push(`wrote ${project.paths.config}`);
      }
      for (const [gitignore, entries] of missing) {
        const lines = entries.map((entry) => entry.line);
        const file = path.join(project.root, gitignore);
        const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
        writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
        done.push(`added to ${gitignore}: ${lines.join(', ')}`);
      }
      if (!done.length) {
        console.log(`nothing to do: ${project.dir} is set up`);
        return 0;
      }
      console.log([...done, 'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check'].join('\n'));
      return 0;
    },
  },
  state: {
    usage: '[--project DIR]',
    about: 'print the machine-local state folder: plans, handoffs, lessons, and the dispatch log',
    run(args) {
      const project = projectAt(parseArgs({ args, options: OPTIONS }).values.project ?? '.');
      console.log(stateDir(project, { config: commandConfig(project) }));
      return 0;
    },
  },
};

// What git must ignore, as { line, gitignore }: the local sources file, and the state and worktrees folders when they are
// inside the repository. A line goes in the project root's .gitignore, or the repository root's when it lies outside
// the project; `gitignore` is that file's path from the project root.
function localEntries(project, config) {
  const repo = repoRoot(project);
  const state = stateDir(project, { config });
  const worktrees = worktreesDir(project, { config });
  const folders = [state, ...(within(state, worktrees) ? [] : [worktrees])].filter((dir) => within(repo, dir));
  const entry = (file, suffix) => {
    const home = within(project.root, file) ? project.root : repo;
    const line = `${path.relative(home, file).split(path.sep).join('/')}${suffix}`;
    // The probe keeps the trailing slash: git matches a folder pattern to a path it knows is a folder.
    return { probe: `${file}${suffix}`, line, gitignore: path.relative(project.root, path.join(home, '.gitignore')).split(path.sep).join('/') };
  };
  return [entry(path.join(project.root, project.paths.local), ''), ...folders.map((dir) => entry(dir, '/'))];
}

// The entries git does not ignore. Outside a git repository, an entry counts as ignored when its .gitignore has its line.
function unignored(project, config) {
  return localEntries(project, config).filter(({ probe, line, gitignore }) => {
    const ignored = isIgnored(project.root, probe);
    if (ignored !== null) return !ignored;
    const text = path.join(project.root, gitignore);
    return !(existsSync(text) ? readFileSync(text, 'utf8').split('\n').map((each) => each.trim()) : []).includes(line);
  });
}

// Whether `file` is `dir` or inside it.
function within(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
