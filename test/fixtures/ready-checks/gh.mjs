#!/usr/bin/env node
// A gh that answers the reads of the ready checks hold for pull request 7 of acme/notes, and nothing else: it never
// reaches GitHub. In-process, `answer(args, spec)` is the exec seam's answer; as a program, it reads its spec from the
// file READY_CHECKS_SPEC names and appends each call to READY_CHECKS_LOG.
//
// `spec`: { view, edits }. `view` is what `gh pr view 7 --json …` prints (null: no such pull request); `edits` is
// { lastEditedAt, renamedAt }, what the edit times query answers (null: the query fails).

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const URL7 = 'https://github.com/acme/notes/pull/7';

const fail = (message) => Object.assign(new Error(message), { stderr: `${message}\n`, status: 1 });

export function answer(args, { view = null, edits = null } = {}) {
  if (args[0] === 'pr' && args[1] === 'view') {
    if (view === null) throw fail('no pull requests found');
    return JSON.stringify(view);
  }
  if (args[0] === 'api' && args[1] === 'graphql' && args.some((each) => each.includes('lastEditedAt'))) {
    if (edits === null) throw fail('gh: Something went wrong (HTTP 502)');
    const nodes = edits.renamedAt ? [{ createdAt: edits.renamedAt }] : [];
    return JSON.stringify({ data: { repository: { pullRequest: { lastEditedAt: edits.lastEditedAt ?? null, timelineItems: { nodes } } } } });
  }
  throw fail(`fake gh: no answer for ${args.join(' ')}`);
}

// node --test also runs every file under test/ as a test file: with no spec named, it is only the module.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.env.READY_CHECKS_SPEC) {
  const spec = JSON.parse(readFileSync(process.env.READY_CHECKS_SPEC, 'utf8'));
  if (process.env.READY_CHECKS_LOG) appendFileSync(process.env.READY_CHECKS_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
  try {
    process.stdout.write(answer(process.argv.slice(2), spec));
  } catch (error) {
    process.stderr.write(error.stderr ?? `${error.message}\n`);
    process.exit(1);
  }
}
