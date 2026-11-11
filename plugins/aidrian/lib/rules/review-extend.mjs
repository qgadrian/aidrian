// Bash rule: an agent records the Human's approval of an extra review round only after the Human gave it.
// `aidrian pr extend <PR> --human approve` grants one more round past config.json `github.maxReviewRounds` under
// `github.extraRounds: "ask"` (lib/review/extension.mjs). The rule lets it run only when this session's transcript holds
// the Human's answer to the question `extension_ask` printed: an AskUserQuestion answer, given after the judge's
// verdict, to a question naming the pull request (`#<PR>`) and the round it grants (`round <N>`), whose chosen option
// starts with "Approve". The host writes that answer to the transcript; the agent's own tool calls cannot.
// `--human deny`, and `--verdict`, always run. An approval with no ask waiting in this machine's review record is
// refused too: the review step writes that record before it prints `extension_ask`, so only a record from another
// machine lacks it, and that approval is the Human's to run. While the check waits for the judge, that deny names the
// judge's route. After a judge's stop nothing waits for an answer, so it names the route to one more round instead:
// AIDRIAN_ALLOW_EXTRA_ROUNDS=1 with --max-rounds, on the Human's answer, or in their shell with several remotes.
// Every deny says why the transcript's answers miss, and a chain of calls is judged call by call, wherever each runs
// (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a shell. A shell fed text the rule
// cannot read as commands, such as a pipe into `bash`, is refused when that text names an approval.
// The Human may also run the command in their own shell (`!` in a Claude Code prompt, or another terminal), which no
// hook reads. Without a transcript the host writes in this shape (Codex), the approval is the Human's to run.

import { readFileSync } from 'node:fs';

import { findProject } from '../project.mjs';
import { readLocalState } from '../review/state.mjs';
import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { oneRemote } from './review-signoff.mjs';

const LEAD = 'Blocked: `aidrian pr extend --human approve` records the Human\'s approval of an extra review round';

// The deny when an ask waits for round `round` of pull request `pr` and the transcript holds no approval of it. `why`
// says what the rule found instead, so the agent fixes the question it asked rather than repeat the call.
export const reason = (pr, round, why = null) =>
  `${LEAD}, and this session holds no such answer${why ? ` (${why})` : ''}. Ask the Human with AskUserQuestion, using the ` +
  `\`question\` and \`options\` the review step printed (they name pull request #${pr ?? '<PR>'} and round ${round ?? '<N>'}), and ` +
  'record approve only when the Human picks the option that starts with "Approve". Or the Human runs the command in their own ' +
  'shell (`!` in the prompt). `--human deny` always runs.';

// The route to one more round while a check at the cap of pull request `pr` waits, or null when none waits: `last` is the
// record's latest check. A check waiting for the judge needs the judge's verdict first, and one waiting for the Human
// needs the Human's answer; neither needs AIDRIAN_ALLOW_EXTRA_ROUNDS, so it works in any checkout.
export function waitingRoute(pr, last) {
  const base = last?.source === 'bot' ? `aidrian pr await-review ${pr} --request` : `aidrian pr review ${pr}`;
  // The record keeps no flags, and a rerun with other options plans another review, so the session repeats its own.
  const rerun = `run again the review command that reached the cap, \`${base}\`, with the options it ran with, such as its \`--with-bot\` and \`--max-rounds\``;
  if (last?.status === 'judging') {
    return `The check at round ${last.round} on pull request #${pr} waits for the judge: ${rerun}; run the \`dispatch\` it prints ` +
      `as its read-only agent, record its word with \`aidrian pr extend ${pr} --verdict extend|stop --reason "<evidence>" --head <sha>\`, ` +
      'and run that command once more. When it then asks the Human, put its `question` and `options` to the Human with AskUserQuestion, ' +
      `word for word, and record the answer with \`aidrian pr extend ${pr} --human approve\` or \`--human deny\`.`;
  }
  if (last?.status === 'asking') {
    return `The check at round ${last.round} on pull request #${pr} waits for the Human: ${rerun}; put the \`question\` and \`options\` ` +
      `it prints to the Human with AskUserQuestion, word for word, and record the answer with ` +
      `\`aidrian pr extend ${pr} --human approve\` or \`--human deny\`.`;
  }
  return null;
}

// The deny when no ask waits for the Human in this machine's record of pull request `pr`: the judge stopped, granted,
// is still to rule, or never ran, so no answer can be recorded, and `aidrian pr extend` itself would fail. A check
// waiting for the judge names the judge's route. Otherwise more rounds are the Human's to raise, with the override:
// on an answer the review-rounds rule reads, or in their own shell when this checkout has several remotes (`shared`
// false), where no answer can name the one repository. `last` is the record's latest check, `next` the --max-rounds
// that allows one more round.
export const noAskReason = (pr, { last = null, next = null, bot = false, shared = true } = {}) => {
  const rerun = bot ? `aidrian pr await-review ${pr} --request` : `aidrian pr review ${pr}`;
  const withBot = bot ? '' : ' (with `--with-bot` before `--max-rounds` when the step runs the bot)';
  const raise = `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 ${rerun} --max-rounds ${next ?? '<N>'}`;
  const override = shared
    ? `To allow one more round, put the choice to the Human with an AskUserQuestion that names <owner>/<name>#${pr} and --max-rounds ${next ?? '<N>'}, with a recommended option that starts with "Approve"; ` +
      `on that answer run exactly \`${raise}\`${withBot}. An agent sets that variable on no other ground. Otherwise report the cap and the findings left open.`
    : `This checkout has several remotes, so no answer lets an agent set AIDRIAN_ALLOW_EXTRA_ROUNDS here: to allow one more round, the Human runs \`${raise}\`${withBot} in their own shell ` +
      '(`!` in the prompt, or another terminal). Report the cap, the findings left open, and that command.';
  if (!last) {
    return `${LEAD}, and this machine's review record holds no extension check for pull request #${pr}. When another ` +
      'machine asked, the Human runs the approval in their own shell (`!` in the prompt). ' + override;
  }
  if (last.status === 'judging') return `${LEAD}, and no extension waits for the Human on pull request #${pr} yet. ${waitingRoute(pr, last)}`;
  return `${LEAD}, and no extension waits for the Human on pull request #${pr} (the latest check, at round ${last.round}, ` +
    `is ${last.status}${last.by ? ` by the ${last.by}` : ''}), so there is no approval to record and asking again changes ` +
    'nothing. ' + override;
};

// The `--human` value of one `aidrian pr extend`, and its pull request number: { answer, pr }, or null when the
// invocation is not one. An answer or a number the rule cannot read is null in its field.
function extendCall(words) {
  if (words?.[0]?.text !== 'pr' || words[1]?.text !== 'extend') return null;
  let answer;
  let pr;
  for (let i = 2; i < words.length; i += 1) {
    const { text, dynamic } = words[i];
    if (text === '--human') {
      answer = words[i + 1] && !words[i + 1].dynamic ? words[i + 1].text : null;
      i += 1;
    } else if (text.startsWith('--human=')) answer = dynamic ? null : text.slice('--human='.length);
    else if (['--verdict', '--reason', '--head'].includes(text)) i += 1;
    else if (pr === undefined && !text.startsWith('-')) pr = !dynamic && /^#?\d+$/u.test(text) ? Number(text.replace('#', '')) : null;
  }
  return answer === undefined ? null : { answer, pr: pr ?? null };
}

// The Human's answers to AskUserQuestion in a Claude Code transcript, oldest first: [{ question, answer, at }]. The
// host writes each as a user entry whose `toolUseResult.answers` maps the question to the chosen label.
export function transcriptAnswers(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('"answers"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const answers = entry?.type === 'user' ? entry.toolUseResult?.answers : null;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue;
    for (const [question, answer] of Object.entries(answers)) {
      if (typeof answer === 'string') out.push({ question, answer, at: typeof entry.timestamp === 'string' ? entry.timestamp : null });
    }
  }
  return out;
}

// Whether `answers` hold the Human's approval of round `round` of pull request `pr`, given at or after `since`.
export const approved = (answers, query) => mismatch(answers, query) === null;

// Why `answers` hold no approval of round `round` of pull request `pr` given at or after `since`, or null when they do.
// It names the nearest miss: no answer, none after the verdict, none naming the pull request, none naming the round,
// or the label the Human picked.
export function mismatch(answers, { pr, round, since = null }) {
  const names = new RegExp(`#${pr}(?!\\d)`, 'u');
  const grants = new RegExp(`\\bround ${round}(?!\\d)`, 'iu');
  if (!answers.length) return 'the transcript holds no AskUserQuestion answer';
  const after = answers.filter((each) => since === null || (each.at !== null && Date.parse(each.at) >= Date.parse(since)));
  if (!after.length) return `no AskUserQuestion answer came after the judge's verdict at ${since}`;
  const onPr = after.filter((each) => names.test(each.question));
  if (!onPr.length) return `no question answered since the judge's verdict names #${pr}`;
  const onRound = onPr.filter((each) => grants.test(each.question));
  if (!onRound.length) return `the questions naming #${pr} do not name "round ${round}"`;
  if (onRound.some((each) => /^\s*approve\b/iu.test(each.answer))) return null;
  return `the Human picked "${onRound.at(-1).answer}", not the option that starts with "Approve"`;
}

// What the no-ask deny names from the record: its latest check, and the --max-rounds that allows one more round. A
// check's `round` counts the rounds of its own source, the plan's or the bot's reviews; a plan check also reads the plan
// rounds the record holds, which may have run since. The review step adds the rounds still granted to --max-rounds,
// so they are taken off here.
function nextCap(state) {
  const entries = state?.extensions ?? [];
  const last = entries.at(-1) ?? null;
  if (!last) return { last, next: null, bot: false };
  const bot = last.source === 'bot';
  const planRounds = !bot && Array.isArray(state?.rounds) ? state.rounds.length : 0;
  const done = Math.max(Number.isInteger(last.round) ? last.round : 0, planRounds);
  const granted = entries.filter((entry) => entry.source === last.source && entry.status === 'granted').length;
  return { last, next: done ? Math.max(1, done + 1 - granted) : null, bot };
}

export const readTranscript = (file) => {
  try {
    return typeof file === 'string' && file !== '' ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

// The deny reason for one `aidrian pr extend` call, or null.
function judge(call, project, input) {
  if (call.pr === null) return reason(null, null);
  let state = null;
  try {
    state = readLocalState(project, call.pr);
  } catch {}
  const pending = (state?.extensions ?? []).filter((entry) => entry.status === 'asking').at(-1);
  if (!pending) return noAskReason(call.pr, { ...nextCap(state), shared: oneRemote(project) });
  const round = pending.round + 1;
  const since = pending.judge?.at ?? pending.decided_at ?? null;
  const why = mismatch(transcriptAnswers(readTranscript(input?.transcript_path)), { pr: call.pr, round, since });
  return why === null ? null : reason(call.pr, round, why);
}

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
// Each call in a chain is judged against its own pull request's record, and the deny names every call it refuses, so
// one retry can fix them all.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const denies = [];
  for (const { invocation, unread } of walkCommands(command, null)) {
    const hidden = unread !== undefined && /\bpr\s+extend\b[\s\S]*\bapprove\b/u.test(unread) ? reason(null, null, 'it runs in a shell fed text the rule cannot read as commands; run it as its own command') : null;
    const call = hidden ? null : extendCall(aidrianArgs(invocation));
    const denied = hidden ?? (call && call.answer !== 'deny' ? judge(call, project, input) : null);
    if (denied && !denies.includes(denied)) denies.push(denied);
  }
  return denies.length ? denies.join('\n') : null;
}
