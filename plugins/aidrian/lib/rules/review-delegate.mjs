// Bash rule: an agent records that the Human left the ship decision at the round limit to the session only after the
// Human said so. `aidrian pr delegate <PR> --issue <REF>` (lib/review/delegation.mjs) writes that answer into the review
// record, and the merge guard (lib/rules/github/merge-review.mjs) then lets a merge that names the head run while every
// open finding is low. The command cannot see the transcript, so this rule lets it run only when this session's
// transcript holds the Human's answer to the merge guard's own round-limit question: an AskUserQuestion answer, given at
// or after the record's outcome, to exactly the question the guard builds for the outcome's head and open count
// (merge-review.mjs roundLimitQuestion), offered with exactly its two options. The latest such answer decides: an answer
// that starts with either option is that option, never a delegation, and otherwise the Human's own words must be one the
// host's adapter reads as given in the terminal (lib/hosts/index.mjs humanAnswer, as transcriptAnswers `human`), and be, whole, one of
// the phrases delegation.mjs delegates reads; a condition, a lean, or a quoted phrase is not. It binds to the record's
// outcome head, never to the call's `--head`; the command checks that the head is the pull request's current one.
// A subagent's call (an `agent_id` in the hook input) is refused: the Human answered the main session.
// It reads this machine's review record only: with no review stopped at its round limit there, as when another machine
// ran the review, the call is refused, and the Human runs it in their own shell. The host writes the answer to the
// transcript, a file in the agent's own account, so an agent with a shell could forge one there: the residual
// review-extend accepts. On a host whose adapter reads no answer as the Human's (Codex), the command is the Human's to run.
// Each call of a chain is judged alone, wherever it runs (shell-lex walkCommands); a shell fed text the rule cannot read
// as commands is refused when that text names the command, and so is a call whose subcommand the shell builds at run
// time, and one a program runs from its words, such as `xargs`, `find -exec`, `npx`, `npm --yes exec`, `arch`, `node -e`,
// `python3 -c`, `perl -e`, `deno eval`, or a program name the shell builds (shell-lex carriedText), when its words name
// the command or leave aidrian's subcommand for the program to fill in, as `xargs -I S aidrian pr S` does.
// It starts no process beyond findProject and the git read of this checkout's remotes.

import { findProject } from '../project.mjs';
import { cappedOn, delegates } from '../review/delegation.mjs';
import { openCount, readLocalState } from '../review/state.mjs';
import { aidrianArgs, carriedText, walkCommands } from '../shell-lex.mjs';
import { GRANT, roundLimitQuestion, SHIP } from './github/merge-review.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';
import { callRepo } from './review-signoff.mjs';

const LEAD = 'Blocked: `aidrian pr delegate` records that the Human left the ship decision at the round limit to the session';
const TAIL = 'Or the Human runs the command in their own shell (`!` in the prompt).';
const deny = (why) => `${LEAD}, and ${why}. ${TAIL}`;
const ASK_AGAIN = 'ask the merge guard\'s question again, with AskUserQuestion, as its denial words it';
// An answer the Human gave that is not a delegation, such as one with a condition: never the question again for it.
const ASK_MEANING = 'ask the Human what the answer means, in plain words, never the merge guard\'s question again, and record nothing until the Human says the session decides';

// The pull request number of one `aidrian pr delegate` call: { pr, words }, `pr` null for one the rule cannot read, or
// null when the invocation is not that command. A subcommand the shell builds at run time may be it: { pr: null }.
function delegateCall(words) {
  if (!words?.length) return null;
  if (words[0].dynamic || (words[0].text === 'pr' && words[1]?.dynamic)) return { pr: null, words, hidden: true };
  if (words[0].text !== 'pr' || words[1]?.text !== 'delegate') return null;
  let pr;
  for (let i = 2; i < words.length; i += 1) {
    const { text, dynamic } = words[i];
    if (['--issue', '--head', '--repo'].includes(text)) i += 1;
    else if (pr === undefined && !text.startsWith('-')) pr = !dynamic && /^#?\d+$/u.test(text) ? Number(text.replace('#', '')) : null;
  }
  return { pr: pr ?? null, words };
}

// Whether an answer is to the guard's question: its very text, offered with exactly the guard's two options.
const OPTIONS = [SHIP, GRANT].sort().join('\n');
const guardsQuestion = (each, question) => each.question === question && Array.isArray(each.options) && [...each.options].sort().join('\n') === OPTIONS;

// Why the transcript's answers miss the round-limit question `question` of `pr` at the outcome `outcome`, or null when
// the latest answer to it leaves the decision to the session in the Human's own words. Neither option's label is such
// an answer: either option is checked first, so a grant that adds "your call how many" stays a grant.
export function delegationMiss(answers, { pr, outcome, question }) {
  if (!answers.length) return `this session holds no such answer (the transcript holds no AskUserQuestion answer): ${ASK_AGAIN}`;
  const since = Date.parse(outcome.at ?? '');
  const after = answers.filter((each) => each.at !== null && !Number.isNaN(since) && Date.parse(each.at) >= since);
  if (!after.length) return `this session holds no such answer (no AskUserQuestion answer came at or after the review stopped): ${ASK_AGAIN}`;
  const asked = after.filter((each) => guardsQuestion(each, question));
  if (!asked.length) return `this session holds no such answer (no answer since is to the merge guard's round-limit question "${question}", with its two options, on #${pr}): ${ASK_AGAIN}`;
  const latest = asked.at(-1);
  if (new RegExp(`^\\s*(?:${SHIP}|merge anyway)\\b`, 'iu').test(latest.answer)) return 'the Human picked that option, and the merge guard takes it by itself: merge, with nothing to record';
  if (new RegExp(`^\\s*${GRANT}\\b`, 'iu').test(latest.answer)) return 'the Human granted rounds: do not merge';
  if (latest.human !== true) return 'the answer does not carry the host\'s marks of the Human\'s own answer in the terminal, so the rule cannot tell that the Human gave it';
  if (delegates(latest.answer)) return null;
  return `the Human's answer is not one this rule reads as leaving the decision to the session, such as one that sets a condition or leans to an option: ${ASK_MEANING}`;
}

// The deny reason for one call, or null.
function judge(call, project, input) {
  if (typeof input?.agent_id === 'string' && input.agent_id !== '') return deny('a subagent never records it: the Human answered the main session, and the main session runs it');
  if (call.hidden) return deny('its subcommand is built by the shell at run time, so the rule cannot tell it is not this one: run it written out, as its own command');
  if (call.pr === null) return deny('its pull request must be a plain number');
  const target = callRepo(project, call.words);
  if (target.miss === 'remotes' || target.miss === 'repo') {
    const list = target.remotes.join(', ') || 'none';
    return deny(`its repository must be one of this checkout's remotes (${list}), written out: add \`--repo <owner>/<name>\`, naming the repository the pull request is on`);
  }
  let state = null;
  try {
    state = readLocalState(project, call.pr, target.repo ?? undefined);
  } catch {}
  const outcome = state?.outcome ?? null;
  if (!outcome || !cappedOn(state, outcome.head)) {
    return deny(`this machine's review record of #${call.pr} holds no review stopped at its round limit, so there is no answer to record, as when another machine ran the review`);
  }
  const question = roundLimitQuestion(call.pr, outcome.head, openCount(state, outcome.head));
  const why = delegationMiss(transcriptAnswers(readTranscript(input?.transcript_path)), { pr: call.pr, outcome, question });
  return why === null ? null : deny(why);
}

// Text that names the command, in a shell string or a carrier's words.
const NAMES = /\bpr\s+delegate\b/u;
const AIDRIAN_WORD = /(?:^|\/)(?:aidrian|cli\.mjs)$/u;
// Carriers that add words from their input to the command they run.
const APPENDS = new Set(['xargs', 'parallel']);

// xargs's replace string, which it fills from its input in every word that holds it (`-I R`, `-IR`, `-J R`, `-i[R]`,
// `--replace[=R]`), read from the words before the command `words[at]`; null without one.
function replaceString(words, at) {
  for (const [i, word] of words.slice(0, at).entries()) {
    if (word === '-I' || word === '-J') return words[i + 1] ?? null;
    if (/^-[IJ]./u.test(word)) return word.slice(2);
    if (word === '-i' || word === '--replace') return '{}';
    if (/^-i./u.test(word)) return word.slice(2);
    if (word.startsWith('--replace=')) return word.slice('--replace='.length);
  }
  return null;
}

// Whether a carrier's words run aidrian with a subcommand the carrier fills in at run time, so the call may be
// `pr delegate` without naming it: `pr`, or the word after it, missing where the carrier adds its input (`xargs aidrian
// pr`), not a plain word (`find -exec aidrian pr {}`), or holding xargs's replace string (`xargs -I S aidrian pr S`).
function fillsSubcommand(program, words) {
  const at = words.findIndex((word) => AIDRIAN_WORD.test(word));
  if (at === -1) return false;
  const replace = program === 'xargs' ? replaceString(words, at) : null;
  const filled = (word) => (word === undefined ? APPENDS.has(program) : !/^[a-z][a-z-]*$/u.test(word) || (replace !== null && word.includes(replace)));
  const [first, second] = [words[at + 1], words[at + 2]];
  if (first?.startsWith('-')) return false;
  return filled(first) || (first === 'pr' && filled(second));
}

const CARRIED = 'it runs through a program that runs its words as a command (such as `xargs`, `find -exec`, `npx`, `node -e`, `python3 -c`, or a program name the shell builds), ' +
  'so the rule cannot judge the call: run it as its own command';

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const denies = [];
  for (const { invocation, unread } of walkCommands(command, null)) {
    let denied = null;
    if (unread !== undefined && NAMES.test(unread)) denied = deny('it runs in a shell fed text the rule cannot read as commands: run it as its own command');
    else {
      const call = delegateCall(aidrianArgs(invocation));
      if (call) denied = judge(call, project, input);
      else {
        const carried = carriedText(invocation);
        if (carried !== null && (NAMES.test(carried) || fillsSubcommand(invocation.program, invocation.args.map((token) => token.text)))) denied = deny(CARRIED);
      }
    }
    if (denied && !denies.includes(denied)) denies.push(denied);
  }
  return denies.length ? denies.join('\n') : null;
}
