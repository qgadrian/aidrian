// Bash rule: the review-round cap holds for agents. On whenever config.json `github.reviewer` names a review bot.
// It denies:
//   - a command that sets AIDRIAN_ALLOW_EXTRA_ROUNDS, inline (`VAR=1 cmd`), through env, or with export, declare,
//     typeset, local, or readonly, also when `builtin` runs it: the Human sets it in their own shell before the
//     session starts, never an agent;
//   - a direct request for a bot review through gh, in every form the review gate reads (lib/rules/github/review-request.mjs):
//     only `aidrian pr await-review --request` and `aidrian pr review` post one, and they count rounds against
//     `github.maxReviewRounds` first. A direct comment would skip that count, which is how one pull request once took
//     twenty bot reviews.
// The one exception to the first: inline on a literal `aidrian pr review <PR> --max-rounds <N>` or `aidrian pr await-review
// <PR> --request --max-rounds <N>`, when this session's transcript holds the Human's answer to an AskUserQuestion naming
// `<owner>/<name>#<PR>` of this checkout's origin and `--max-rounds <N>`, whose chosen option starts with "Approve". The host writes that answer, not the agent.
// Anything the rule cannot read lets the command run.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { ROUNDS_OVERRIDE } from '../../pr-await-review.mjs';
import { findProject } from '../../project.mjs';
import { aidrianArgs, assignsVariable, commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';
import { originRepo } from '../../review-gate.mjs';
import { readTranscript, transcriptAnswers } from '../review-extend.mjs';
import { namesChange } from '../review-signoff.mjs';
import { readRequests } from './review-request.mjs';

export const OVERRIDE_REASON =
  `Blocked: ${ROUNDS_OVERRIDE} lets review rounds go past config.json github.maxReviewRounds, and only the Human sets it, ` +
  'on their word. Stop at round_limit, report the findings that keep coming back, and ask the Human with AskUserQuestion ' +
  'whether to continue, naming `<owner>/<name>#<PR>` and `--max-rounds <N>`, with a recommended option that starts with "Approve". On that ' +
  `answer run exactly \`${ROUNDS_OVERRIDE}=1 aidrian pr review <PR> --max-rounds <N>\`, or the same on \`aidrian pr await-review <PR> --request\`.`;

export const REQUEST_REASON =
  'Blocked: request a bot review with `aidrian pr await-review --request` (or `aidrian pr review --with-bot`), which counts ' +
  'the rounds against config.json github.maxReviewRounds before it posts. A direct request skips that count.';

export const botNamed = (reviewer) => typeof reviewer === 'string' && reviewer !== '' && reviewer.toLowerCase() !== 'none';

// Whether one invocation sets the override.
export const setsOverride = (invocation) => assignsVariable(invocation, ROUNDS_OVERRIDE);

// Whether the override on `invocation` is the raise the Human approved in `answers`.
export function approvedRaise(invocation, answers, repo) {
  const words = aidrianArgs(invocation);
  if (!words || words.some((word) => word.dynamic)) return false;
  const texts = words.map((word) => word.text);
  const [verb, sub, pr] = texts;
  const shape = texts.slice(3).join(' ');
  const max = /^(?:--request )?--max-rounds (\d+)$/u.exec(shape)?.[1];
  const known = verb === 'pr' && ((sub === 'review' && !shape.startsWith('--request')) || (sub === 'await-review' && shape.startsWith('--request')));
  if (!repo || !known || !max || !/^\d+$/u.test(pr ?? '')) return false;
  const names = answers.filter(({ question }) => namesChange(question, repo, pr) && new RegExp(`--max-rounds ${max}(?!\\d)`, 'u').test(question));
  return /^\s*approve\b/iu.test(names.at(-1)?.answer ?? '');
}

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env, input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (!botNamed(config.github.reviewer)) return null;
  const read = (file) => readFileSync(path.resolve(cwd, file), 'utf8');
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const invocation = readInvocation(segment);
      if (setsOverride(invocation) && !approvedRaise(invocation, transcriptAnswers(readTranscript(input?.transcript_path)), originRepo(project))) return OVERRIDE_REASON;
      if (readRequests(invocation, config.github.reviewer, read, env).length > 0) return REQUEST_REASON;
    }
  }
  return null;
}
