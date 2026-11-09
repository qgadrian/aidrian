// Bash rule: an agent never signs off a flow. `aidrian pr signoff` records the Human's sign-off under the git user's
// name, and the harness-config flow and every `signoff: "human"` flow wait for it, so an agent that ran it would sign
// in the Human's name. The review step prints the command for the Human, who runs it in their own shell (`!` in a
// Claude Code prompt, or another terminal); the short form `aidrian pr signoff <PR> --last`, which the message names,
// is the Human's too and denied alike. It denies `aidrian pr signoff` run as `aidrian`, or as a node script that
// is the plugin's cli.mjs or bin/aidrian, wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`,
// or a heredoc fed to a shell. A shell fed text the rule cannot read as commands, such as a pipe into `bash`, is refused
// when that text names a sign-off; anything else it cannot read runs. A sign-off with a plain `--check` among its words
// is the dry run, which records nothing, and runs; a `--check` the shell builds at run time, such as one glued to a
// substitution, is no dry run. An `aidrian` whose subcommand the shell builds at run time (`aidrian "$@"`) is denied
// too, since it may be a sign-off.
// A long-form sign-off also runs when this session's transcript holds the Human's answer to it: an AskUserQuestion whose
// question names the pull request with this checkout's origin (`<owner>/<name>#<PR>`), the head's first seven characters, and what is signed (`<flow>/<invariant>`,
// `<flow>/*` for every --accept of the flow, `<flow>/signoff`, or `stage:<name>/signoff` for --stage), with a chosen option that starts with "Approve". The
// host writes that answer, not the agent; a push changes the head, so it asks again. Without such a transcript the
// command stays the Human's to run. Any word the shell builds at run time, a repeated flag, --repo, and --last get no such route: the long form does the same.

import { aidrianArgs, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';
import { originRepo, remoteRepos } from '../review-gate.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';

export const REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, recorded under their name, and only the Human runs it, `--last` included. ' +
  'Stop, and ask the Human first with AskUserQuestion, in their terms: a question that also names `<owner>/<name>#<PR>`, the short head, and `<flow>/<invariant>`, `<flow>/*` for every --accept of the flow, `<flow>/signoff`, or `stage:<name>/signoff`, with a recommended option that starts with "Approve"; on that answer the long-form command runs here, written out as one plain command with no shell variables, `cd`, or chain, from the checkout of that pull request; a checkout with several remotes has no such route. ' +
  'On a host with no such question, hand the Human a command for their own shell (`!` in the prompt, or another terminal). ' +
  'At human_required naming one flow, once `aidrian pr signoff <PR> --last --check` exits 0, hand over the short form `aidrian pr signoff <PR> --last`, ' +
  'short enough to type from a phone, naming the flow and short head that `--check` printed. ' +
  'At a disputed flow\'s overrule, or any other stop, hand over the command the review step printed. ' +
  'To try a command first, run it with `--check`, which records nothing.';

// The one repository an approved command can only mean, or null. Only a single plain `aidrian pr ...` qualifies: a chain,
// `cd`, `env -C`, or an environment prefix such as GH_REPO may aim it elsewhere. A checkout with several remotes qualifies
// neither, since the forge's default may be a parent, not origin. `allowed` is the one prefix the caller's own rule permits.
export function approvalRepo(project, command, cwd, allowed = '') {
  const plain = new RegExp(`^\\s*${allowed}(?:[^\\s;&|()]*/)?aidrian\\s+pr\\s`, 'u').test(command);
  if (!plain || walkCommands(command, cwd).length !== 1) return null;
  if (new Set(remoteRepos(project)).size !== 1) return null;
  return originRepo(project);
}

// Whether `question` names pull request `pr` of `repo`, as `owner/name#pr`.
export const namesChange = (question, repo, pr) => new RegExp(`(?<![\\w./-])${repo.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}#${pr}(?!\\d)`, 'iu').test(question);

// Whether `answers` hold the Human's approval of the sign-off `words`. The latest answer naming it decides.
export function answered(words, answers, repo) {
  if (!repo || words.some((word) => word.dynamic)) return false;
  const flags = {};
  for (let i = 3; i < words.length; i += 1) {
    const flag = words[i].text;
    if (!flag.startsWith('--') || Object.hasOwn(flags, flag)) return false;
    flags[flag] = words[(i += 1)]?.text;
  }
  const pr = words[2]?.text?.replace('#', '');
  const [flow, stage, head] = [flags['--flow'], flags['--stage'], flags['--head']];
  if (!/^\d+$/u.test(pr ?? '') || Boolean(flow) === Boolean(stage) || !/^[0-9a-f]{7,}$/iu.test(head ?? '') || Object.hasOwn(flags, '--last') || Object.hasOwn(flags, '--repo')) return false;
  const invariant = flags['--accept'] ?? flags['--overrule'];
  const tokens = [stage ? `stage:${stage}/signoff` : `${flow}/${invariant ?? 'signoff'}`, ...(flags['--accept'] ? [`${flow}/*`] : [])];
  const namesToken = (question) => tokens.some((token) => {
    const at = question.indexOf(token);
    return at !== -1 && !/[\w-]/u.test(question[at + token.length] ?? '') && !/[\w-]/u.test(question[at - 1] ?? '');
  });
  const matching = answers.filter(({ question }) => namesChange(question, repo, pr) && question.includes(head.slice(0, 7)) && namesToken(question));
  return /^\s*approve\b/iu.test(matching.at(-1)?.answer ?? '');
}

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
export function check(command, { cwd = process.cwd(), input = {} } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && /\bpr\s+signoff\b/u.test(unread)) return REASON;
    const words = aidrianArgs(invocation);
    if (!words) continue;
    // A subcommand the shell builds at run time cannot be read, so it may be a sign-off.
    if (words[0]?.dynamic || (words[0]?.text === 'pr' && words[1]?.dynamic)) return REASON;
    // `--check` records nothing (lib/review-gate.mjs runSignoff), and the command takes no value that starts with `--`,
    // so a plain word `--check` is always the dry run: an agent may try a command before it hands it to the Human. A
    // dynamic word is not: `printf …`--check may expand to a value that swallows it, or to nothing.
    if (words[0]?.text === 'pr' && words[1]?.text === 'signoff' && !words.some((word) => !word.dynamic && word.text === '--check')) {
      const answers = transcriptAnswers(readTranscript(input?.transcript_path));
      if (!answers.length || !answered(words, answers, approvalRepo(project, command, cwd))) return REASON;
    }
  }
  return null;
}
