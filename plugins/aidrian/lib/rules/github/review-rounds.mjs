// Bash rule: the review-round cap holds for agents. On whenever config.json `github.reviewer` names a review bot.
// It denies:
//   - a command that sets AIDRIAN_ALLOW_EXTRA_ROUNDS, inline (`VAR=1 cmd`), through env, or with export, declare,
//     typeset, local, or readonly, also when `builtin` runs it: the Human sets it in their own shell before the
//     session starts, never an agent;
//   - a direct request for a bot review through gh, in every form the review gate reads (lib/rules/github/review-request.mjs):
//     only `aidrian pr await-review --request` and `aidrian pr review` post one, and they count rounds against
//     `github.maxReviewRounds` first. A direct comment would skip that count, which is how one pull request once took
//     twenty bot reviews.
// The one exception to the first: inline on a literal `aidrian pr review <PR> [--with-bot] --max-rounds <N>` or `aidrian pr
// await-review <PR> --request --max-rounds <N>`, when this session's transcript holds the Human's answer to an AskUserQuestion naming
// `<owner>/<name>#<PR>` of this checkout's origin and `--max-rounds <N>`, whose chosen option starts with "Approve". The host writes that answer, not the agent.
// A checkout with several remotes gets no such exception (review-signoff.mjs approvalTarget).
// Every refusal of the override names one route and the nearest miss, so the first deny leads somewhere: while a check at
// the cap waits for the judge or the Human, its route (review-extend.mjs waitingRoute), which needs no variable; else the
// ask, where an answer can approve it. The miss names the checkout, the command's form, or what the answers lack.
// Anything the rule cannot read lets the command run.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { ROUNDS_OVERRIDE } from '../../pr-await-review.mjs';
import { findProject } from '../../project.mjs';
import { aidrianArgs, assignsVariable, commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';
import { readLocalState } from '../../review/state.mjs';
import { readTranscript, transcriptAnswers, waitingRoute } from '../review-extend.mjs';
import { approvalTarget, namesChange, oneRemote } from '../review-signoff.mjs';
import { readRequests } from './review-request.mjs';

// The deny's first sentence, which every refusal of the override starts with; the dispatch log records it.
export const OVERRIDE_REASON =
  `Blocked: ${ROUNDS_OVERRIDE} lets review rounds go past config.json github.maxReviewRounds, and only the Human sets it, on their word.`;

// The ask route, named only where an answer can approve the raise: no check waits at the cap, and one remote.
export const ASK_ROUTE =
  'Stop at round_limit, report the findings that keep coming back, and ask the Human with AskUserQuestion ' +
  'whether to continue, naming `<owner>/<name>#<PR>` and `--max-rounds <N>`, with a recommended option that starts with "Approve". On that ' +
  `answer run exactly \`${ROUNDS_OVERRIDE}=1 aidrian pr review <PR> --max-rounds <N>\`, or the same on \`aidrian pr await-review <PR> --request\`.`;

export const REQUEST_REASON =
  'Blocked: request a bot review with `aidrian pr await-review --request` (or `aidrian pr review --with-bot`), which counts ' +
  'the rounds against config.json github.maxReviewRounds before it posts. A direct request skips that count.';

export const botNamed = (reviewer) => typeof reviewer === 'string' && reviewer !== '' && reviewer.toLowerCase() !== 'none';

// Whether one invocation sets the override.
export const setsOverride = (invocation) => assignsVariable(invocation, ROUNDS_OVERRIDE);

// The two forms an answer can approve, as written after the variable; `--with-bot` is the review step that also runs the bot.
const RAISE_FORMS = { review: /^(?:--with-bot )?--max-rounds (\d+)$/u, 'await-review': /^--request --max-rounds (\d+)$/u };

// The pull request number of an `aidrian pr review|await-review <PR>` invocation, or null.
function raisedPr(invocation) {
  const [verb, sub, pr] = (aidrianArgs(invocation) ?? []).map((word) => (word.dynamic ? null : word.text));
  return verb === 'pr' && Object.hasOwn(RAISE_FORMS, sub) && /^\d+$/u.test(pr ?? '') ? pr : null;
}

// The command to hand the Human for the raise `words` asked for, without its cap: the plan's or the bot's count, and the bot
// stage when the review step runs it. Each counts its own rounds, so the other would raise the wrong cap.
function handoverOf(words) {
  const texts = (words ?? []).map((word) => (word.dynamic ? null : word.text));
  const pr = /^\d+$/u.test(texts[2] ?? '') ? texts[2] : '<PR>';
  if (texts[1] === 'await-review') return `aidrian pr await-review ${pr} --request`;
  return texts.includes('--with-bot') ? `aidrian pr review ${pr} --with-bot` : `aidrian pr review ${pr}`;
}

// Why the override on `invocation` is not the raise the Human approved in `answers`, or null when it is. `target` is
// review-signoff.mjs approvalTarget for the command. The checkout comes first, then the command's form, then the answers,
// so the first deny names the one thing to change.
export function raiseMiss(invocation, answers, target) {
  const words = aidrianArgs(invocation);
  const texts = words && !words.some((word) => word.dynamic) ? words.map((word) => word.text) : [];
  const [verb, sub, pr] = texts;
  if (target.miss === 'remotes') {
    return `This checkout has several remotes, so no answer can name the one repository the command acts on, and no answer lets an agent set ${ROUNDS_OVERRIDE} here. ` +
      `Hand the Human \`${ROUNDS_OVERRIDE}=1 ${handoverOf(words)} --max-rounds <N>\` to run in their own shell (\`!\` in the prompt, or another terminal).`;
  }
  const max = verb === 'pr' && Object.hasOwn(RAISE_FORMS, sub) && /^\d+$/u.test(pr ?? '') ? RAISE_FORMS[sub].exec(texts.slice(3).join(' '))?.[1] : undefined;
  if (!max) {
    return `An answer approves only \`${ROUNDS_OVERRIDE}=1 aidrian pr review <PR> --max-rounds <N>\`, with \`--with-bot\` before \`--max-rounds\` when the step runs the bot, ` +
      `or \`${ROUNDS_OVERRIDE}=1 aidrian pr await-review <PR> --request --max-rounds <N>\`, every word written out, with no variable or other flag.`;
  }
  if (target.miss === 'plain') return 'An approved raise runs only as one plain command, with no `cd`, `env -C`, chain, or other prefix: run it from the pull request\'s checkout.';
  if (target.miss === 'origin') return 'This checkout has no origin, so no answer can name its repository: the Human runs the command in their own shell.';
  if (!answers.length) return 'The transcript holds no AskUserQuestion answer.';
  const named = `${target.repo}#${pr}`;
  const onPr = answers.filter(({ question }) => namesChange(question, target.repo, pr));
  if (!onPr.length) return `No answered question names \`${named}\`.`;
  const onMax = onPr.filter(({ question }) => new RegExp(`--max-rounds ${max}(?!\\d)`, 'u').test(question));
  if (!onMax.length) return `The questions naming \`${named}\` do not name \`--max-rounds ${max}\`.`;
  const answer = onMax.at(-1).answer;
  return /^\s*approve\b/iu.test(answer) ? null : `The Human picked "${answer}", not the option that starts with "Approve".`;
}

// The route a check waiting at the cap of the raise's pull request offers, from this machine's review record, or null.
function pendingRoute(project, invocation) {
  const pr = raisedPr(invocation);
  if (!pr) return null;
  try {
    return waitingRoute(pr, readLocalState(project, Number(pr))?.extensions?.at(-1));
  } catch {
    return null;
  }
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
      if (setsOverride(invocation)) {
        const miss = raiseMiss(invocation, transcriptAnswers(readTranscript(input?.transcript_path)), approvalTarget(project, command, cwd, `${ROUNDS_OVERRIDE}=1\\s+`));
        const route = pendingRoute(project, invocation) ?? (oneRemote(project) ? ASK_ROUTE : null);
        if (miss) return [OVERRIDE_REASON, route, miss].filter(Boolean).join(' ');
      }
      if (readRequests(invocation, config.github.reviewer, read, env).length > 0) return REQUEST_REASON;
    }
  }
  return null;
}
