// Bash rule: the review-round cap holds for agents. On whenever config.json `github.reviewer` names a review bot.
// It denies:
//   - a command that sets AIDRIAN_ALLOW_EXTRA_ROUNDS, inline (`VAR=1 cmd`), through env, or with export, declare,
//     typeset, or readonly: the Human sets it in their own shell before the session starts, never an agent;
//   - a direct request for a bot review through gh, in every form the review gate reads (lib/rules/github/review-request.mjs):
//     only `aidrian pr await-review --request` and `aidrian pr review` post one, and they count rounds against
//     `github.maxReviewRounds` first. A direct comment would skip that count, which is how one pull request once took
//     twenty bot reviews.
// Anything the rule cannot read lets the command run.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { ROUNDS_OVERRIDE } from '../../pr-await-review.mjs';
import { findProject } from '../../project.mjs';
import { commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';
import { readRequests } from './review-request.mjs';

const DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly']);

export const OVERRIDE_REASON =
  `Blocked: ${ROUNDS_OVERRIDE} lets review rounds go past config.json github.maxReviewRounds, and only the Human sets it, ` +
  'in their own shell before the session starts. Stop at round_limit, report the findings that keep coming back, and ' +
  'ask the Human whether to continue.';

export const REQUEST_REASON =
  'Blocked: request a bot review with `aidrian pr await-review --request` (or `aidrian pr review --with-bot`), which counts ' +
  'the rounds against config.json github.maxReviewRounds before it posts. A direct request skips that count.';

export const botNamed = (reviewer) => typeof reviewer === 'string' && reviewer !== '' && reviewer.toLowerCase() !== 'none';

// Whether one invocation sets the override.
export function setsOverride({ program, args = [], environment = [] }) {
  if (environment.some((change) => change.name === ROUNDS_OVERRIDE && change.value !== null)) return true;
  if (!DECLARERS.has(program)) return false;
  return args.some((token) => token.text === ROUNDS_OVERRIDE || token.text.startsWith(`${ROUNDS_OVERRIDE}=`));
}

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (!botNamed(config.github.reviewer)) return null;
  const read = (file) => readFileSync(path.resolve(cwd, file), 'utf8');
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const invocation = readInvocation(segment);
      if (setsOverride(invocation)) return OVERRIDE_REASON;
      if (readRequests(invocation, config.github.reviewer, read, env).length > 0) return REQUEST_REASON;
    }
  }
  return null;
}
