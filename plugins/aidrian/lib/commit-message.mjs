// `aidrian commit-msg`: checks a commit subject against Conventional Commits, with the types from config.json
// `git.commits.types`. A project calls it from its commit-msg git hook with the message file git passes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig } from './config.mjs';
import { projectAt } from './project.mjs';

export const commands = {
  'commit-msg': {
    usage: '(--file PATH | --message TEXT) [--project DIR]',
    about: 'check a commit subject against Conventional Commits and the types in config.json',
    run(args) {
      const { values } = parseArgs({ args, options: { file: { type: 'string' }, message: { type: 'string' }, project: { type: 'string' } } });
      if ((values.file === undefined) === (values.message === undefined)) {
        console.error('give one of --file PATH or --message TEXT');
        return 1;
      }
      const { types } = commandConfig(projectAt(path.resolve(values.project ?? '.'))).git.commits;
      const problem = subjectProblem(commitSubject(values.message ?? readFileSync(values.file, 'utf8')), types);
      if (problem) console.error(problem);
      return problem ? 1 : 0;
    },
  },
};

// The first line that is neither blank nor a git comment.
export function commitSubject(message) {
  return message.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
}

// Why `subject` is not a valid subject for these types, with the accepted forms; null when it is valid.
// `Merge …` and `Revert …` subjects, which git writes itself, always pass.
export function subjectProblem(subject, types) {
  if (subject?.startsWith('Merge ') || subject?.startsWith('Revert ')) return null;
  const alternatives = types.map((type) => type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`^(?:${alternatives})(?:\\([a-z0-9./_-]+\\))?!?: .+`);
  if (subject && pattern.test(subject)) return null;
  return [
    subject ? `Invalid commit subject: ${subject}` : 'The commit message is empty or only comments.',
    '',
    'Use Conventional Commits: `type: subject`, `type(scope): subject`, or `type!: subject` for a breaking change.',
    `Types: ${types.join(', ')}.`,
    'Example: fix(api): reject an empty name',
  ].join('\n');
}
