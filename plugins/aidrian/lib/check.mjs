// `aidrian check` validates a project folder end to end; `aidrian init` sets one up. docs/project-folder.md describes both.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig, VERSION } from './config.mjs';
import { isIgnored } from './git.mjs';
import { indexRows, loadKnowledge } from './knowledge.mjs';
import { findProject, openProject } from './project.mjs';

const OPTIONS = { project: { type: 'string' } };

export const commands = {
  check: {
    usage: '[--project DIR]',
    about: 'validate the project folder: its root files, config.json, every knowledge index, and the .gitignore lines',
    run(args) {
      const start = path.resolve(parseArgs({ args, options: OPTIONS }).values.project ?? '.');
      const project = findProject(start);
      if (!project) {
        console.error(`no project folder at or above ${start}; run aidrian init`);
        return 1;
      }
      const { config, buckets, errors } = loadKnowledge(project);
      for (const entry of unignored(project, config)) {
        errors.push(`${entry} is not git-ignored: add the line "${entry}" to .gitignore, or run aidrian init`);
      }
      if (errors.length) {
        console.error(errors.join('\n'));
        return 1;
      }
      console.log(`ok: ${project.dir} (${buckets.length} buckets, ${indexRows(buckets).length} docs)`);
      return 0;
    },
  },
  init: {
    usage: '[--project DIR]',
    about: `create the project folder with a version ${VERSION} config.json, and add its local state to .gitignore`,
    run(args) {
      const start = path.resolve(parseArgs({ args, options: OPTIONS }).values.project ?? '.');
      const project = findProject(start) ?? openProject(start);
      if (project.errors.length) {
        console.error(project.errors.join('\n'));
        return 1;
      }
      const done = [];
      if (!existsSync(path.join(project.root, project.paths.config))) {
        mkdirSync(path.join(project.root, project.paths.knowledge), { recursive: true });
        writeFileSync(path.join(project.root, project.paths.config), `${JSON.stringify({ version: VERSION }, null, 2)}\n`);
        done.push(`wrote ${project.paths.config}`);
      }
      const missing = unignored(project, loadConfig(project).config);
      if (missing.length) {
        const file = path.join(project.root, '.gitignore');
        const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
        writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
        done.push(`added to .gitignore: ${missing.join(', ')}`);
      }
      if (!done.length) {
        console.log(`nothing to do: ${project.dir} is set up`);
        return 0;
      }
      console.log([...done, 'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check'].join('\n'));
      return 0;
    },
  },
};

// The local state the plugin writes, as .gitignore lines. A worktrees folder outside the project needs no line.
function localEntries(project, config) {
  const { paths } = project;
  const worktrees = path.posix.normalize(config.worktrees.dir ?? paths.worktrees).replace(/\/$/, '');
  const entries = [`${paths.plans}/`, `${paths.handoffs}/`, `${paths.lessons}/`, paths.dispatchLog];
  if (!path.posix.isAbsolute(worktrees) && !worktrees.startsWith('..')) entries.push(`${worktrees}/`);
  return entries;
}

// The entries git does not ignore. Outside a git repository, an entry counts as ignored when .gitignore has its line.
function unignored(project, config) {
  const file = path.join(project.root, '.gitignore');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((line) => line.trim()) : [];
  return localEntries(project, config).filter((entry) => {
    const ignored = isIgnored(project.root, entry);
    return ignored === null ? !lines.includes(entry) : !ignored;
  });
}
