// Bash rule: an agent records the Human's approval of an extra review round only after the Human gave it.
// `aidrian pr extend <PR> --human approve` grants one more round past config.json `github.maxReviewRounds` under
// `github.extraRounds: "ask"` (lib/review/extension.mjs). The rule lets it run only when this session's transcript holds
// the Human's answer to the question `extension_ask` printed: an AskUserQuestion answer, given after the judge's
// verdict, to a question naming the pull request (`#<PR>`) and the round it grants (`round <N>`), whose chosen option
// starts with "Approve". The host writes that answer to the transcript; the agent's own tool calls cannot.
// `--human deny`, and `--verdict`, always run. An approval with no ask waiting in this machine's review record is
// refused too: the review step writes that record before it prints `extension_ask`, so only a record from another
// machine lacks it, and that approval is the Human's to run.
// The Human may also run the command in their own shell (`!` in a Claude Code prompt, or another terminal), which no
// hook reads. Without a transcript the host writes in this shape (Codex), the approval is the Human's to run.

import { readFileSync } from 'node:fs';

import { findProject } from '../project.mjs';
import { readLocalState } from '../review/state.mjs';
import { commandLines, lexCommand, readInvocation } from '../shell-lex.mjs';
import { aidrianArgs } from '../shell-lex.mjs';

export const reason = (pr, round) =>
  'Blocked: `aidrian pr extend --human approve` records the Human\'s approval of an extra review round, and this session ' +
  'holds no such answer. Ask the Human with AskUserQuestion, using the `question` and `options` the review step printed ' +
  `(they name pull request #${pr ?? '<PR>'} and round ${round ?? '<N>'}), and record approve only when the Human picks the ` +
  'option that starts with "Approve". Or the Human runs the command in their own shell (`!` in the prompt). ' +
  '`--human deny` always runs.';

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
export function approved(answers, { pr, round, since = null }) {
  const names = new RegExp(`#${pr}(?!\\d)`, 'u');
  const grants = new RegExp(`\\bround ${round}(?!\\d)`, 'iu');
  return answers.some((each) => names.test(each.question) && grants.test(each.question) && /^\s*approve\b/iu.test(each.answer) &&
    (since === null || (each.at !== null && Date.parse(each.at) >= Date.parse(since))));
}

const readTranscript = (file) => {
  try {
    return typeof file === 'string' && file !== '' ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const call = extendCall(aidrianArgs(readInvocation(segment)));
      if (!call || call.answer === 'deny') continue;
      if (call.pr === null) return reason(null, null);
      let state = null;
      try {
        state = readLocalState(project, call.pr);
      } catch {}
      const pending = (state?.extensions ?? []).filter((entry) => entry.status === 'asking').at(-1);
      if (!pending) return reason(call.pr, null);
      const round = pending.round + 1;
      const since = pending.judge?.at ?? pending.decided_at ?? null;
      if (!approved(transcriptAnswers(readTranscript(input?.transcript_path)), { pr: call.pr, round, since })) return reason(call.pr, round);
    }
  }
  return null;
}
