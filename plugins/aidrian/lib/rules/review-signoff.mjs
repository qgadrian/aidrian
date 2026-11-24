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
// question names the pull request with the repository the command acts on (`<owner>/<name>#<PR>`) and the head's first seven characters,
// with a chosen option that starts with "Approve", where that option or the question names what is signed (`<flow>/<invariant>`,
// `<flow>/*` for every --accept of the flow, `<flow>/signoff`, or `stage:<name>/signoff` for --stage). An option that names
// such an id decides alone: "Approve ui/a" under a question naming ui/a and ui/b approves ui/a only. So the question stays
// in plain words and the option carries the id, and the first answer runs the command: a session once asked each sign-off
// twice, in plain words and then again with the id. The
// host writes that answer, not the agent; a push changes the head, so it asks again. Without such a transcript the
// command stays the Human's to run. Any word the shell builds at run time, a repeated flag, and --last get no such route: the long form does the same.
// A subagent, and a session no Human attends, get no answer route: the sign-off also writes the sign-off store
// (lib/review/merge-trust.mjs), which only a main session the Human attends writes.
// The repository is approvalTarget's: `--repo <owner>/<name>` when the command names one of this checkout's remotes, else
// the one repository the checkout's remotes name. A checkout whose remotes name several needs the `--repo`.

import { aidrianArgs, interpreterOf, walkCommands } from '../shell-lex.mjs';
import { findProject } from '../project.mjs';
import { givenRepo, namesChange, originRepo, remoteRepos, repoName } from '../remotes.mjs';
import { droveRun } from '../run-driver.mjs';
import { readUnattendedMark } from '../unattended-mark.mjs';
import { textDenial, unreadable } from './product-feedback-answer.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';

// What every in-session ask route says, as a clause and as a sentence: a Human away from the session, such as on a
// phone, sees the question only when told it waits.
export const NOTIFY_CLAUSE = 'before asking, when the host offers a tool that sends the Human a push notification, send one saying a decision waits';
export const NOTIFY = `${NOTIFY_CLAUSE[0].toUpperCase()}${NOTIFY_CLAUSE.slice(1)}.`;

// The clause every in-session route carries for a checkout whose remotes name several repositories.
export const SEVERAL = 'In a checkout whose remotes name more than one repository, end the command with `--repo <owner>/<name>`, ' +
  'the repository the question names, written out, which must be one of those remotes.';

export const REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, recorded under their name, and only the Human runs it, `--last` included. ' +
  'Stop, and ask the Human first with AskUserQuestion, once: a question in their terms that names the flow and what is signed in plain words, and also names `<owner>/<name>#<PR>` and the short head, ' +
  'with a recommended option whose label starts with "Approve" and names the exact id, `<flow>/<invariant>`, `<flow>/*` for every --accept of the flow, `<flow>/signoff`, or `stage:<name>/signoff`, such as "Approve checkout/total-shown". ' +
  `${NOTIFY} ` +
  'On that answer the long-form command runs here, written out as one plain command run from the checkout of that pull request, with no shell variables, `cd`, `env -C`, or chain. ' +
  `${SEVERAL} ` +
  'On a host with no such question, hand the Human a command for their own shell (`!` in the prompt, or another terminal). ' +
  'At human_required naming one flow, once `aidrian pr signoff <PR> --last --check` exits 0, hand over the short form `aidrian pr signoff <PR> --last`, ' +
  'short enough to type from a phone, naming the flow and short head that `--check` printed. ' +
  'At a disputed flow\'s overrule, or any other stop, hand over the command the review step printed. ' +
  'To try a command first, run it with `--check`, which records nothing.';

// The one repository an approved command can only mean, or null. Only a single plain `aidrian pr ...` qualifies: a chain,
// `cd`, `env -C`, or an environment prefix such as GH_REPO may aim it elsewhere. `allowed` is the one prefix the caller's own rule permits.
export const approvalRepo = (project, command, cwd, allowed = '') => approvalTarget(project, command, cwd, allowed).repo;

// `--repo` as every command reads it alike, written out: `<owner>/<name>` alone, with no host, URL, or `.git`, which
// givenRepo would drop and a command that passes the value to the forge as it is would not.
// A `.` or `..` owner or name is a path, never a repository.
const OWNER_NAME = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/u;
const writtenOut = (given) => typeof given === 'string' && OWNER_NAME.test(given) && repoName(given) === given.toLowerCase();

// The `--repo` value of `words`: undefined with none, the text of the one given, or null for one the rule cannot
// read: a repeated or dynamic `--repo`, or one with no value.
function repoWord(words) {
  const at = (words ?? []).flatMap((word, i) => (word.text === '--repo' ? [i] : []));
  if (!at.length) return undefined;
  const value = words[at[0] + 1];
  return at.length === 1 && !words[at[0]].dynamic && value && !value.dynamic ? value.text : null;
}

// What approvalRepo reads, with why it found no repository: { repo } or { repo: null, miss }. The repository is the
// one the command acts on, read with that command's own resolver (review-gate.mjs prRepo, whose `--repo` step is
// givenRepo, the part that needs no forge): its `--repo` when it names one, which must be
// one of this checkout's remotes; else, in a checkout whose remotes all name one repository, its origin. With no
// `--repo` in a checkout whose remotes name several, the command acts on the forge's default, which may be any of them
// (a parent, a mirror), and a hook reads no forge, so none counts. `miss` is `remotes` for that checkout, `plain` for a
// command that is not one plain `aidrian pr ...`, `repo` for a `--repo` that is not one of this checkout's remotes
// written as `<owner>/<name>`, or `origin` for no origin, as in a checkout with no remote. With no `--repo`, the checkout comes first.
// A `remotes` or `repo` miss also lists the repositories the remotes name, as `remotes`, for the deny to name.
export function approvalTarget(project, command, cwd, allowed = '') {
  const calls = walkCommands(command, cwd);
  const plain = calls.length === 1 && new RegExp(`^\\s*${allowed}(?:[^\\s;&|()]*/)?aidrian\\s+pr\\s`, 'u').test(command);
  const given = plain && calls[0].invocation ? repoWord(aidrianArgs(calls[0].invocation)) : undefined;
  const remotes = [...new Set(remoteRepos(project))];
  if (given === undefined && remotes.length > 1) return { repo: null, miss: 'remotes', remotes };
  if (!plain) return { repo: null, miss: 'plain' };
  if (given !== undefined) {
    const repo = writtenOut(given) ? givenRepo(given) : null;
    return repo && remotes.includes(repo) ? { repo } : { repo: null, miss: 'repo', remotes };
  }
  const repo = originRepo(project);
  return repo ? { repo } : { repo: null, miss: 'origin' };
}

// The repository one `aidrian pr` call acts on, from its own words `words` and this checkout's remotes, for a rule that
// judges each call of a chain apart (review-extend.mjs): { repo } or { repo: null, miss, remotes }. Its `--repo`, which must
// be written out and one of the remotes (`repo` miss); else the one repository the remotes name; else, when they name
// several, `remotes`, since the call acts on the forge's default; and `none` for a checkout with no remote at all.
export function callRepo(project, words) {
  const given = repoWord(words);
  const remotes = [...new Set(remoteRepos(project))];
  if (given === undefined) {
    if (remotes.length > 1) return { repo: null, miss: 'remotes', remotes };
    return remotes.length ? { repo: remotes[0] } : { repo: null, miss: 'none', remotes };
  }
  const repo = writtenOut(given) ? givenRepo(given) : null;
  return repo && remotes.includes(repo) ? { repo } : { repo: null, miss: 'repo', remotes };
}

// Whether this checkout's remotes name more than one repository, so an approved command ends in `--repo`.
export const severalRemotes = (project) => new Set(remoteRepos(project)).size > 1;

// Whether a question names pull request `pr` of `repo`, as `owner/name#pr` (lib/remotes.mjs), for the rules that read it here.
export { namesChange };

// Whether `answers` hold the Human's approval of the sign-off `words`. The latest answer naming it decides.
export const answered = (words, answers, repo) => signoffMiss(words, answers, { repo }) === null;

// Why `answers` hold no approval of the sign-off `words` in the repository `target` names (approvalTarget), or null when
// they do: the nearest miss, so the session fixes the one thing wrong instead of retrying the same call.
// A deny once named none, and sessions retried three times in a minute, after a `$U` in the command, a question that
// wrote `flow / invariant` with spaces, or a checkout with several remotes and no `--repo`.
export function signoffMiss(words, answers, target) {
  if (target.miss) return TARGET_MISS[target.miss] ?? 'the repository the command acts on cannot be told';
  const { repo } = target;
  const built = words.find((word) => word.dynamic);
  if (built) return `\`${built.text}\` is a word the shell builds at run time: write every word out`;
  const flags = {};
  for (let i = 3; i < words.length; i += 1) {
    const flag = words[i].text;
    if (!flag.startsWith('--') || Object.hasOwn(flags, flag)) return `\`${flag}\` is not one flag of the long form, each flag once`;
    flags[flag] = words[(i += 1)]?.text;
  }
  const pr = words[2]?.text?.replace('#', '');
  const [flow, stage, head] = [flags['--flow'], flags['--stage'], flags['--head']];
  if (Object.hasOwn(flags, '--last')) return '`--last` gets no answer route: run the long form the review step printed';
  if (!/^\d+$/u.test(pr ?? '') || Boolean(flow) === Boolean(stage) || !/^[0-9a-f]{7,}$/iu.test(head ?? '')) return 'the long form needs the pull request number, one `--flow` or `--stage`, and `--head <sha>`';
  if (Object.hasOwn(flags, '--repo') && repoName(flags['--repo']) !== repo) return `its \`--repo\` is not ${repo}`;
  const invariant = flags['--accept'] ?? flags['--overrule'];
  const tokens = [stage ? `stage:${stage}/signoff` : `${flow}/${invariant ?? 'signoff'}`, ...(flags['--accept'] ? [`${flow}/*`] : [])];
  const namesToken = (question) => tokens.some((token) => {
    const at = question.indexOf(token);
    return at !== -1 && !/[\w-]/u.test(question[at + token.length] ?? '') && !/[\w-]/u.test(question[at - 1] ?? '');
  });
  if (!answers.length) return 'the session holds no AskUserQuestion answer';
  const named = `${repo}#${pr}`;
  const onPr = answers.filter(({ question }) => namesChange(question, repo, pr));
  if (!onPr.length) return `no question answered names \`${named}\``;
  const onHead = onPr.filter(({ question }) => question.includes(head.slice(0, 7)));
  if (!onHead.length) return `no question naming ${named} names the head \`${head.slice(0, 7)}\``;
  // The option the Human chose decides when it names an id; else the question does.
  const matching = onHead.filter(({ question, answer }) => (idsOf(answer).length ? idsOf(answer).some((id) => tokens.includes(id)) : namesToken(question)));
  if (!matching.length) {
    const other = onHead.map(({ answer }) => idsOf(answer)).find((ids) => ids.length);
    if (other) return `the option the Human chose names \`${other.join('`, `')}\`, not \`${tokens[0]}\``;
    return `neither a question naming ${named} at ${head.slice(0, 7)} nor the option the Human chose names \`${tokens[0]}\`, written as one word with no space around the \`/\``;
  }
  const last = matching.at(-1).answer;
  return /^\s*approve\b/iu.test(last) ? null : `the Human picked "${last}", not the option that starts with "Approve"`;
}

// The sign-off ids an answer names, as `<flow>/<invariant>`, `<flow>/*`, or `stage:<name>/signoff`: a word with one `/`
// that is no repository's `<owner>/<name>#<PR>`, path, or URL.
const ID = /(?<![\w.:/-])(?:stage:)?[\w.-]+\/(?:\*|[\w-]+)(?![\w#/-])/gu;
const idsOf = (answer) => answer.match(ID) ?? [];

const TARGET_MISS = {
  remotes: 'this checkout\'s remotes name more than one repository: end the command with `--repo <owner>/<name>`, the one the question names',
  plain: 'it is not one plain command: no shell variable, `cd`, `env -C`, or chain',
  repo: 'its `--repo` must name, written out, one of this checkout\'s remotes',
  origin: 'this checkout has no origin to tell the repository by: end the command with `--repo <owner>/<name>`',
};

// The deny for a sign-off whose answers miss: REASON, then the miss, when the session holds answers to go by.
const missReason = (miss) => `${REASON} This call: ${miss}.`;

// What a subagent is told: it has no answer route, and its dispatcher, the main session, has. It returns the question
// rather than retrying a call no answer can open.
export const SUBAGENT_REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, and a subagent never records it, whatever an answer says. ' +
  'Stop and return `status: needs_input` to your dispatcher, with `next_owner: the Human`, the sign-off question in plain words that names ' +
  '`<owner>/<name>#<PR>` and the short head, options whose recommended one starts with "Approve" and names `<flow>/<invariant>`, `<flow>/*`, `<flow>/signoff`, or `stage:<name>/signoff`, ' +
  'and the long-form command the review step printed: the main session asks it once and runs the command.';

export const UNATTENDED_REASON =
  'Blocked: `aidrian pr signoff` is the Human\'s sign-off, and it writes the sign-off store, which a merge no Human asks for reads as the Human\'s word, ' +
  'so only a main session the Human attends runs it: never a subagent, a session no Human attends, or a project run\'s driver, whatever an answer says. ' +
  'Stop and report the sign-off the review asks for; the Human runs the command the review printed in a session they attend, or in their own shell.';

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript, its
// agent id, and the host's session id. `unattendedMark` reads the session's unattended mark (lib/unattended-mark.mjs),
// asked only for a sign-off that records: with one, or from a subagent, the sign-off is refused with no answer route.
export function check(command, { cwd = process.cwd(), input = {}, unattendedMark = () => readUnattendedMark(input?.session_id), drives = null } = {}) {
  const project = findProject(cwd);
  // A session that drove a project run signs off nothing, even after the run's end: the run's sign-offs come from a
  // separate session the Human attends.
  const driver = drives ?? (() => droveRun(input?.session_id));
  // Who may not record a sign-off wherever the call runs, read before the project, so a folder that is none, such as a
  // git folder of its own, makes no hole: a subagent, a session no Human attends, and a run's driver.
  const subagent = typeof input?.agent_id === 'string' && input.agent_id !== '';
  let held;
  const barred = () => (held ??= subagent ? SUBAGENT_REASON : unattendedMark() || driver() ? UNATTENDED_REASON : null);
  const refuse = () => barred() ?? (project ? REASON : null);
  const entries = walkCommands(command, null);
  const judged = new Set();
  for (const entry of entries) {
    const { invocation, unread } = entry;
    if (unread !== undefined && /\bpr\s+signoff\b/u.test(unread)) {
      const denied = refuse();
      if (denied) return denied;
      continue;
    }
    // A program the shell builds at run time, as `$x` or `"$(command -v aidrian)"`, may be aidrian: its words are read
    // as aidrian's, as the product-feedback rule's readCall reads them.
    const named = aidrianArgs(invocation);
    const built = !named && dynamicProgram(invocation);
    const words = named ?? (built ? invocation.args : null);
    if (!words) continue;
    judged.add(entry);
    // A subcommand the shell builds or expands at run time cannot be read, so it may be a sign-off: a first word for
    // aidrian or a built program whose text names it, and a second after `pr` for any, as the product-feedback rule's
    // readCall reads them. Only the first two words decide, so `pr product-feedback "$x"` is no sign-off.
    const sure = named || /aidrian/iu.test(invocation.program);
    if ((sure && unreadable(words[0])) || (words[0]?.text === 'pr' && unreadable(words[1]))) {
      const denied = refuse();
      if (denied) return denied;
      continue;
    }
    if (words[0]?.text === 'pr' && words[1]?.text === 'signoff' && !words.some((word) => !word.dynamic && word.text === '--check')) {
      if (barred()) return barred();
      if (!project) continue;
      if (built) return REASON;
      const answers = transcriptAnswers(readTranscript(input?.transcript_path));
      if (!answers.length) return REASON;
      const miss = signoffMiss(words, answers, approvalTarget(project, command, cwd));
      if (miss) return missReason(miss);
    }
  }
  // The shapes the word pass cannot read but the text names: xargs, parallel, npx, an interpreter, a variable or an
  // alias whose words hold the call (product-feedback-answer.mjs textDenial). No `--check` there is a dry run: only a
  // sign-off the word pass read can be one. Who may never sign off is refused wherever the command runs (refuse).
  if (!textDenial(entries, judged, true, namesSignoff)) return null;
  return scriptNames(entries, judged) ? textReason(refuse()) : refuse();
}

// Whether an interpreter's code or input, among the entries the word pass did not read, names a sign-off: text a script
// may run or only quote, as xargs or npx, which run their words, never do.
const scriptNames = (entries, judged) => entries.some((entry) => !judged.has(entry) && interpreterOf(entry.invocation.program)
  && namesSignoff([...entry.segment.map((token) => token.text), ...entry.inputs].join(' ')));

// How a refusal opens when the rule found the sign-off only in text it cannot read as commands: a background session
// that rewrote its handoff brief with a Python heredoc, whose text quoted the command for the Human, was told only to
// stop and report, retried, and then split the words to get past the rule. Its first instruction is the one for text
// that only quotes the command, which goes in a file the file tool writes, as this rule does not read it; the
// sign-off's own refusal follows, for text meant to record one.
export const TEXT_ROUTE =
  'Blocked: this call names `aidrian pr signoff` only in text this rule cannot read as commands, an interpreter\'s code or input, such as a script in a heredoc, which may run it. ' +
  'When that text only quotes the command, as a brief or a body for the Human does, it records no sign-off: write the file with the file tool instead, which this rule does not read, and go on; never split or respell the command to get past this rule.';

// The refusal `denied` for a sign-off named only in such text: TEXT_ROUTE, then `denied` for text meant to record one.
// Text piped into a shell is a command the shell runs, and keeps the sign-off's refusal alone.
export const textReason = (denied) => (denied ? `${TEXT_ROUTE} When the text is meant to record a sign-off, it is refused: ${denied.replace(/^Blocked: /u, '')}` : denied);

// Whether one command's words name a sign-off call: aidrian, then `pr signoff`.
const namesSignoff = (text) => /\baidrian\b[\s\S]*\bpr\s+signoff\b/u.test(text);

// Whether a walked command's program is a word the shell builds at run time.
const dynamicProgram = ({ program, args }) => /[$`]/u.test(program) || (program === '' && args.length > 0);
