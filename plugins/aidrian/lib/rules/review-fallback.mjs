// Bash rule: an agent picks what replaces an out-of-quota reviewer only after the Human picked it.
// `aidrian pr review <PR> --quota-fallback agent:<name>|human` replaces the reviewer that stopped on quota for the current
// head (lib/review/quota.mjs): a same-model agent pass, or the Human's own review. Either weakens the review, so the rule
// lets it run only when this session's transcript holds the Human's answer to the question `blocked_quota` printed: an
// AskUserQuestion answer, given after the stop, to a question naming the pull request (`#<PR>`) and the quota, whose
// chosen option is the one the flag runs, for the exact value: "Run a critic agent" for `agent:critic` only, "Run a
// <name> agent" (or an answer that names `agent:<name>`) for any other agent, and "The Human reviews it" for human.
// The stop must be in this machine's review record, which the review step writes before it prints `blocked_quota`.
// The Human may also run the command in their own shell (`!` in a Claude Code prompt, or another terminal), which no
// hook reads. Without a transcript the host writes in this shape (Codex), the choice is the Human's to run.
// The call is read wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a
// shell. A shell fed text the rule cannot read as commands, such as a pipe into `bash`, is refused when it names the flag.

import { findProject } from '../project.mjs';
import { AGENT, agentLabel, HUMAN, LABELS } from '../review/quota.mjs';
import { readLocalState } from '../review/state.mjs';
import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';

export const reason = (pr, why = null) =>
  'Blocked: `aidrian pr review --quota-fallback` replaces a reviewer that ran out of quota with a same-model agent or the ' +
  `Human's review, and ${why ?? 'this session holds no such choice by the Human'}. Ask the Human with AskUserQuestion, using the ` +
  `\`question\` and \`options\` the review step printed for pull request #${pr ?? '<PR>'}, and run the \`run\` of the option ` +
  'the Human picks; "Wait" runs nothing. Or the Human runs the command in their own shell (`!` in the prompt).';

// The `--quota-fallback` value of one `aidrian pr review`, and its pull request number: { choice, pr }, or null when the
// invocation is not one. A value or a number the rule cannot read is null in its field.
function fallbackCall(words) {
  if (words?.[0]?.text !== 'pr' || words[1]?.text !== 'review') return null;
  let choice;
  let pr;
  for (let i = 2; i < words.length; i += 1) {
    const { text, dynamic } = words[i];
    if (text === '--quota-fallback') {
      choice = words[i + 1] && !words[i + 1].dynamic ? words[i + 1].text : null;
      i += 1;
    } else if (text.startsWith('--quota-fallback=')) choice = dynamic ? null : text.slice('--quota-fallback='.length);
    else if (['--max-rounds', '--timeout-sec'].includes(text)) i += 1;
    else if (pr === undefined && !text.startsWith('-')) pr = !dynamic && /^#?\d+$/u.test(text) ? Number(text.replace('#', '')) : null;
  }
  return choice === undefined ? null : { choice, pr: pr ?? null };
}

// Whether `answers` hold the Human's pick of exactly `choice` for pull request `pr`'s quota stop, given at or after
// `since`. An agent's answer names that agent: its label, or the value `agent:<name>` itself, so the critic's answer
// never authorizes another agent.
export function chosen(answers, { pr, choice, since = null }) {
  const names = new RegExp(`#${pr}(?!\\d)`, 'u');
  const agent = AGENT.exec(choice ?? '')?.[1];
  if (choice !== HUMAN && !agent) return false;
  const label = (agent ? agentLabel(agent) : LABELS.human).toLowerCase();
  const value = agent ? new RegExp(`(?:^|\\s)agent:${agent}(?![\\w:-])`, 'iu') : null;
  // The label, then the end of the answer or a word that is not part of the name, such as " (Recommended)".
  const picked = (answer) => {
    const text = answer.trim().toLowerCase();
    return (text.startsWith(label) && !/^[\w-]/u.test(text.slice(label.length))) || Boolean(value?.test(answer));
  };
  return answers.some((each) => names.test(each.question) && /out of quota/iu.test(each.question) && picked(each.answer) &&
    (since === null || (each.at !== null && Date.parse(each.at) >= Date.parse(since))));
}

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /--quota-fallback\b/u.test(unread)) return reason(null, 'it runs in a shell fed text the rule cannot read as commands; run it as its own command');
    const call = fallbackCall(aidrianArgs(invocation));
    if (!call) continue;
    if (call.pr === null || call.choice === null) return reason(call.pr);
    let state = null;
    try {
      state = readLocalState(project, call.pr);
    } catch {}
    const stop = (state?.quotaStops ?? []).at(-1);
    if (!stop) return reason(call.pr);
    if (!chosen(transcriptAnswers(readTranscript(input?.transcript_path)), { pr: call.pr, choice: call.choice, since: stop.at })) return reason(call.pr);
  }
  return null;
}
