// Bash rule: `aidrian pr product-feedback post` on a pull request from outside the team holds to the Human's own word.
// `record` stores `limited` from the reads and rule of `aidrian pr resolve` (fromOutside); a record that does not say
// false counts as limited. It is on only where the state folder holds `product-feedback/`, as the answer rule is, and holds
// a post only when a record of that pull request is limited. There a subagent is refused, and a main session passes only
// a post run alone (at most a plain `cd` before it, so nothing in the command rewrites the comment after this check), from
// `<state>/tmp/product-feedback-<PR>.md`, when the transcript holds an AskUserQuestion answer, given after that file was
// last written, to a question naming `#<PR>` and posting, whose chosen option is `Post` alone (review-extend transcriptAnswers). The host writes that answer;
// the agent's own tool calls cannot. With no such transcript, as on Codex or in an unattended run, the Human runs `post`
// in their own shell, which no hook reads.
// It reads commands as the answer rule does (product-feedback-answer.mjs): the plain call, the `node …/cli.mjs` runner, and
// each `sh -c`, `eval`, and heredoc fed to a shell, call by call (shell-lex walkCommands). A shell fed text it cannot read,
// `xargs`, `parallel`, or a command it did not judge whose words name `product-feedback` and `post` is refused while a
// held record is there, and so is a post beside a call that can write the record after the hook ran (writesUnseen). It
// reads no gh, since a hook runs none. docs/hooks.md#bash-rules names its limits.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { cleanTitle, listRecords } from '../feedback-record.mjs';
import { stateDir } from '../project.mjs';
import { aidrianArgs, lexCommand, readInvocation, walkCommands } from '../shell-lex.mjs';
import { projectReader, pullRequestOf, readCall, readWords, textDenial, UNKNOWN, unreadable, writesUnseen } from './product-feedback-answer.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';

const LEAD = 'Blocked: `aidrian pr product-feedback post` on a pull request from outside the team posts only on the Human\'s own word';
const OWN_SHELL = 'Or the Human runs the `post` command in their own shell.';
const SUBAGENT = `${LEAD}, and a subagent never gives it. Leave the comment in the state folder's tmp and return; the main session asks the Human. ${OWN_SHELL}`;
const UNREAD = `${LEAD}, and this runs it in a form the rule cannot judge, such as a shell fed text, xargs, npx, an interpreter, or a variable. Run it as its own command. ${OWN_SHELL}`;
const CHAINED = `${LEAD}, and this command also runs \`aidrian pr product-feedback record\` or an aidrian call the rule cannot read, which can write the record ` +
  `it is judged against only after this check. Run \`record\` on its own first, then \`post\` as its own command. ${OWN_SHELL}`;
const BESIDE = `${LEAD}, and this command runs more than the post, which can rewrite the comment after the Human saw it. ` +
  `Run \`post\` as its own command, with at most a plain cd <folder> && before it. ${OWN_SHELL}`;
const UNKNOWN_PROJECT = `${LEAD}, and the rule cannot read which project it runs in while this machine keeps product feedback. ` +
  `Write the folder out in the command, such as a plain cd <folder> &&. ${OWN_SHELL}`;

// Only a command holding one of these can be a call: every other Bash call pays for this one look, and reads no disk.
const CANDIDATE = /aidrian|cli\.mjs|product-feedback|[$`]/u;
const POST_VALUES = new Set(['--body-file']);
// The whole label the chosen option must be.
const POSTS = /^\s*post\s*[.!]?\s*$/iu;

// What one walked command is for this rule, or null: { type: 'unreadable' }, a dynamic word where the subcommand goes, or
// { type: 'post', pr, body, unread }, with null for what it cannot read and `body` undefined when it names none.
function readPost(invocation) {
  const { program, args } = invocation;
  const dynamicProgram = /[$`]/u.test(program) || (program === '' && args.length > 0);
  const named = aidrianArgs(invocation);
  const words = named ?? (dynamicProgram ? args : null);
  if (!words) return null;
  const [first, second, third] = words;
  if (unreadable(first) && (named || /aidrian/iu.test(program))) return { type: 'unreadable' };
  if (first?.text !== 'pr') return null;
  if (unreadable(second)) return { type: 'unreadable' };
  if (second?.text !== 'product-feedback') return null;
  if (unreadable(third)) return { type: 'unreadable' };
  if (third?.text !== 'post') return null;
  const read = readWords(words.slice(3), POST_VALUES);
  return { type: 'post', pr: pullRequestOf(read.operands[0] ?? null), body: read.options['--body-file'], unread: read.unread };
}

// Whether `command` runs nothing but its one post (`entries`, the walk, holds it alone, since the walk leaves out directory
// changes), with every other segment a `cd`, and no redirect that writes a file: a command beside the post, or a redirect
// such as `cd x > <body>`, can rewrite the comment after the hook read when it was written.
function postAlone(command, entries) {
  if (entries.length !== 1) return false;
  const segments = lexCommand(command);
  const writes = (segment) => segment.some((token, at) => token.operator && token.text.includes('>') && segment[at + 1] && !segment[at + 1].fdDup && segment[at + 1].text !== '/dev/null');
  if (segments.some(writes)) return false;
  return segments.filter((segment) => readInvocation(segment).program !== 'cd').length === 1;
}

// The records of a project that hold a post: every one that does not say `limited: false`.
const heldRecords = (project) => listRecords(stateDir(project)).filter((record) => record.limited !== false);

// Why `answers` hold no word of the Human to post on #pr, given at or after `since` (ms), or null when they do.
function postMismatch(answers, pr, since) {
  const names = new RegExp(`(?<![\\w/])#${pr}(?!\\d)`, 'u');
  if (!answers.length) return 'the transcript holds no AskUserQuestion answer';
  const after = answers.filter((each) => each.at !== null && Date.parse(each.at) >= since);
  if (!after.length) return 'no AskUserQuestion answer came after the comment was last written';
  const onPr = after.filter((each) => names.test(each.question));
  if (!onPr.length) return `no question answered since the comment was last written names #${pr}`;
  const onPost = onPr.filter((each) => /\bpost/iu.test(each.question));
  if (!onPost.length) return `the questions naming #${pr} do not ask about posting`;
  if (onPost.some((each) => POSTS.test(each.answer))) return null;
  return `the Human picked ${JSON.stringify(cleanTitle(onPost.at(-1).answer))}, and the option must be Post alone`;
}

const askReason = (pr, why) => `${LEAD}, and this session holds no such answer (${why}). Show the Human the comment and ask with AskUserQuestion: ` +
  `a question naming #${pr} and posting, with one option that is Post alone, after the comment is written. ${OWN_SHELL}`;

// The deny reason for one post call in `folder` of `project`, or null. A subagent is refused any post a record holds. A
// held post passes only when `alone` (postAlone), from the skill's own comment, `<state>/tmp/product-feedback-<PR>.md`.
function judgePost(call, project, folder, input, subagent, alone) {
  const held = heldRecords(project);
  if (!held.length) return null;
  const cannotRead = (what) => (subagent ? SUBAGENT : `${LEAD}, and the rule cannot read ${what}. Write it out in the command. ${OWN_SHELL}`);
  if (call.type === 'unreadable') return cannotRead('its subcommand');
  if (call.unread || !call.pr) return cannotRead('the pull request');
  const { number, repo } = call.pr;
  const mine = held.filter((record) => record.pr === number && (!repo || record.repo.toLowerCase() === repo.toLowerCase()));
  if (!mine.length) return null;
  if (subagent) return SUBAGENT;
  if (!alone) return BESIDE;
  // No --body-file: post refuses it with its usage line.
  if (call.body === undefined) return null;
  if (call.body === null) return cannotRead('the body file');
  if (!path.isAbsolute(call.body) && folder === null) return cannotRead('the folder the body file is in');
  const body = path.resolve(folder ?? '/', call.body);
  const name = `product-feedback-${number}.md`;
  const own = path.join(stateDir(project), 'tmp', name);
  let since;
  try {
    if (path.basename(body) !== name || realpathSync(path.dirname(body)) !== realpathSync(path.dirname(own))) {
      return `${LEAD}, and its body file is not the comment the skill drafts for #${number}. Post from --body-file ${own}. ${OWN_SHELL}`;
    }
    const stat = lstatSync(body);
    if (!stat.isFile()) throw new Error('no plain file');
    since = stat.mtimeMs;
  } catch {
    return cannotRead('when the body file was written, since it is no file');
  }
  const why = postMismatch(transcriptAnswers(readTranscript(input?.transcript_path)), number, since);
  return why === null ? null : askReason(number, why);
}

// The deny reason for `command`, or null. `input` is the hook payload, for its `agent_id` and its transcript; `env` the
// environment its shell inherits, for its CDPATH.
export function check(command, { cwd = process.cwd(), input = {}, env = process.env } = {}) {
  if (!CANDIDATE.test(command)) return null;
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const projectIn = projectReader(command, cwd, env);
  // A project that holds a post, or one it cannot read while this machine keeps product feedback.
  const holds = (folder) => {
    const project = projectIn(folder);
    return project === UNKNOWN || (Boolean(project) && heldRecords(project).length > 0);
  };
  const entries = walkCommands(command, cwd);
  const posts = new Map(entries.map((entry) => [entry, entry.unread === undefined ? readPost(entry.invocation) : null]));
  const writes = (self) => entries.some((other) => other !== self && other.unread === undefined && writesUnseen(readCall(other.invocation)));
  const judged = new Set();
  for (const entry of entries) {
    const { unread, folder } = entry;
    if (unread !== undefined) {
      if (/\bproduct-feedback\b/u.test(unread) && /\bpost\b/u.test(unread) && holds(folder)) return subagent ? SUBAGENT : UNREAD;
      continue;
    }
    const call = posts.get(entry);
    if (!call) continue;
    judged.add(entry);
    // A post beside a call that may write its record after this check: the record on disk says nothing yet.
    if (call.type === 'post' && writes(entry)) return subagent ? SUBAGENT : CHAINED;
    const project = projectIn(folder);
    if (!project) continue;
    if (project === UNKNOWN) return UNKNOWN_PROJECT;
    const denied = judgePost(call, project, folder, input, subagent, postAlone(command, entries));
    if (denied) return denied;
  }
  const names = (text, folder) => /\bproduct-feedback\b/u.test(text) && /\bpost\b/u.test(text) && holds(folder);
  return textDenial(entries, judged, subagent ? SUBAGENT : UNREAD, names);
}
