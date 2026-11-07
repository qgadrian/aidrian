// Bash rule: `--by human` on a product feedback item holds to the Human's own word. It is on only where the state folder
// holds `product-feedback/`, so a project that does not use the feature sees nothing of it, save the chained record below,
// which it judges anywhere. It reads two commands:
// `aidrian pr product-feedback answer` with `--by human`, `--by=human`, or a word it cannot read, and `aidrian audits
// record` with the same, on a key a feedback record lists, answered or not. A subagent is refused either one, whatever key
// it names. A main session passes only when the transcript holds an AskUserQuestion answer, given after the record was
// written, to a question naming `#<PR>`, the item's id, and its title in double quotes, and no other item, whose chosen
// option is that decision alone (review-extend transcriptAnswers). The host writes that answer; the agent's own tool calls
// cannot. With no such transcript, as on Codex or in an unattended run, the Human runs the command in their own shell,
// which no hook reads. A chain of calls is judged call by call, wherever each runs (shell-lex walkCommands). A command the
// rule did not judge, whose own words or heredoc name a call, is refused unless it only handles text, and so is `xargs`,
// `parallel`, or a shell fed unread text on a line naming one. It reads no gh, since a hook runs none, and what it cannot
// read about a record leaves the record out. A word the shell expands (shell-lex `expands`: an unquoted glob character, or
// a brace list or range, anywhere in the word) is a word it cannot read. A call whose folder or project it cannot read (a
// `cd` it cannot follow or with two operands, a folder that is no existing directory, a CDPATH in the command or the
// environment, a dynamic, expanding, or `~` --project) is refused only while this machine holds a `product-feedback/`
// folder, under the state root or the current project's state folder (feedbackOnMachine), with a reason that claims
// nothing about its words.
// A command that also runs `aidrian pr product-feedback record`, or an aidrian call whose subcommand it cannot read, can write
// the record a call is judged against after the hook ran, the first one included: there every `audits record` or `answer`
// that claims a human or that it cannot read is refused, whatever is on disk (chainedRecord).
// docs/hooks.md#bash-rules names what stays out of its sight, and its limits. The post rule (product-feedback-post.mjs)
// reads its commands with the helpers exported here.

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { reportName } from '../audits.mjs';
import { cleanTitle, listRecords, PERSONA } from '../feedback-record.mjs';
import { isDirectory } from '../fs.mjs';
import { findProject, stateDir, stateRoot } from '../project.mjs';
import { aidrianArgs, inlineShellCommand, lexPipeline, readInvocation, readsShellInput, walkCommands } from '../shell-lex.mjs';
import { readTranscript, transcriptAnswers } from './review-extend.mjs';

const HUMAN_LEAD = 'Blocked: `aidrian pr product-feedback answer` or `aidrian audits record` with `--by human` records the Human\'s own word on a product feedback item';
const SUBAGENT = `${HUMAN_LEAD}, and a subagent never gives it. Return the decision in the handoff; the main session asks the Human.`;
const UNREAD = `${HUMAN_LEAD}, and this runs in a shell fed text the rule cannot read as commands. Run it as its own command.`;
const TEXT_ONLY = `${HUMAN_LEAD}, and this command names one in a form the rule cannot judge, such as xargs, find -exec, npx, an interpreter, or a variable. Run it as its own command.`;
const CHAINED = `${HUMAN_LEAD}, and this command also runs \`aidrian pr product-feedback record\` or an aidrian call the rule cannot read, ` +
  'which can write the record it is judged against only after this check. Run `record` on its own first, then this call as its own command.';
const UNKNOWN_PROJECT = 'Blocked: this runs `aidrian pr product-feedback answer` or `aidrian audits record`, and the rule that holds `--by human` on a product feedback item ' +
  'to the Human\'s own word cannot read which project it runs in, or which words it holds, while this machine keeps product feedback. ' +
  'Write the folder and the words out in the command, such as a literal --project or a plain cd <folder> &&, or the Human runs it in their own shell.';
// What projectIn gives for a folder or project the rule cannot read, while this machine keeps product feedback.
export const UNKNOWN = Symbol('unknown project');

// Only a command holding one of these can be a call: every other Bash call pays for this one look, and reads no disk.
const CANDIDATE = /aidrian|cli\.mjs|product-feedback|audits|[$`]/u;
// `answer` takes no --project today, and refuses one; the rule reads it all the same, so the folder it names is judged.
const ANSWER_VALUES = new Set(['--by', '--reason', '--issue', '--url', '--doc', '--project']);
const AUDITS_VALUES = new Set(['--project', '--from', '--not-rechecked', '--carried-forward', '--issue', '--url', '--reason', '--by', '--doc']);
const BARE_NUMBER = /^#?([1-9]\d*)$/u;
const PULL_URL = /^https:\/\/[^/@]+\/([^/?#]+)\/([^/?#]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/u;
const ITEM_IDS = /\bPF[1-9]\d*\b/gu;
// What only handles text, so a call its words name is data. git, gh, and rg are read by their arguments (handlesText).
const TEXT_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'ag', 'ack', 'echo', 'printf', 'cat', 'tee', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff']);
const GIT_TEXT = new Set(['commit', 'log', 'grep', 'show', 'notes', 'tag']);
const GH_TEXT = new Set(['pr', 'issue']);
const FEEDS_BLIND = new Set(['xargs', 'parallel']);

// A dynamic word that stays one word whatever it holds: quoted, and no list expansion.
const quotedScalar = ({ text, dynamic, splits }) => dynamic && !splits && /[$`]/u.test(text) && !/\$@|\[@\]|\[\*\]/u.test(text);

// A word the rule cannot take as written: dynamic, or one the shell expands (shell-lex `expands`: an unquoted glob
// character, or a brace list or range, wherever in the word, quoted parts around it included).
export const unreadable = (token) => Boolean(token?.dynamic || token?.expands);

// The words of a call: { operands, by, unread, options }. `operands` lists its positional words, an unreadable one as
// null. `by` lists each --by value, and `options` each other value, an unreadable one as null. `unread` says a word the
// rule cannot read may hold a flag: any word the shell expands, a prose value's included, since it can become several
// words, one of them `--by`.
export function readWords(words, values) {
  const out = { operands: [], by: [], unread: false, options: {} };
  for (let i = 0; i < words.length; i += 1) {
    const { text, dynamic, expands } = words[i];
    if (text === '--') break;
    if (expands) out.unread = true;
    const flag = text.startsWith('--') ? text.split('=')[0] : null;
    if (flag && values.has(flag)) {
      const inline = text.includes('=');
      const value = inline ? { ...words[i], text: text.slice(flag.length + 1) } : words[i + 1];
      if (!inline) i += 1;
      if (value?.dynamic && !quotedScalar(value)) out.unread = true;
      if (value?.expands) out.unread = true;
      const read = value && !unreadable(value) ? value.text : null;
      if (flag === '--by') out.by.push(read);
      else out.options[flag] = read;
    } else if (dynamic || (expands && !text.startsWith('-'))) {
      out.operands.push(null);
      out.unread = true;
    } else if (!text.startsWith('-')) out.operands.push(text);
  }
  return out;
}

const unreadBy = ({ by, unread }) => unread || by.includes(null);
const claimsHuman = (read) => unreadBy(read) || read.by.includes('human');

// A call's PR word as { number, repo? }, or null when it cannot read one. A hook holds a URL to no remote, since it runs
// no git for this: the command does that.
export function pullRequestOf(word) {
  if (word === null) return null;
  const bare = BARE_NUMBER.exec(word);
  if (bare) return { number: Number(bare[1]) };
  const url = PULL_URL.exec(word);
  return url ? { number: Number(url[3]), repo: `${url[1]}/${url[2]}` } : null;
}

// What one walked command is, or null when it is none of these: { type: 'clean' }, a call of the two commands' families
// that claims no human; { type: 'unreadable' }, a dynamic word where the subcommand goes; { type: 'answer', pr, id,
// decision, project, unreadBy }; or { type: 'record', keys, decision, project, unreadBy }, with null for what it cannot
// read, and `project` undefined when it names none.
export function readCall(invocation) {
  const { program, args } = invocation;
  const dynamicProgram = /[$`]/u.test(program) || (program === '' && args.length > 0);
  const named = aidrianArgs(invocation);
  const words = named ?? (dynamicProgram ? args : null);
  if (!words) return null;
  const [first, second, third] = words;
  if (unreadable(first) && (named || /aidrian/iu.test(program))) return { type: 'unreadable' };
  if (first?.text === 'pr') {
    if (unreadable(second)) return { type: 'unreadable' };
    if (second?.text !== 'product-feedback') return null;
    if (unreadable(third)) return { type: 'unreadable' };
    if (third?.text !== 'answer') return { type: 'clean', writesRecord: third?.text === 'record' };
    const read = readWords(words.slice(3), ANSWER_VALUES);
    if (!claimsHuman(read)) return { type: 'clean' };
    const [pr = null, id = null, decision = null] = read.operands;
    return { type: 'answer', pr: pullRequestOf(pr), id, decision, project: read.options['--project'], unreadBy: unreadBy(read) };
  }
  if (first?.text !== 'audits') return null;
  const read = readWords(words.slice(1), AUDITS_VALUES);
  const [action = null, report = null, keys = null, decision = null] = read.operands;
  if ((action !== 'record' && action !== null) || !claimsHuman(read)) return { type: 'clean' };
  const fullKeys = report === null || keys === null ? null : keys.split(',').map((key) => key.trim()).filter(Boolean).map((key) => (key.includes('#') ? key : `${reportName(path.basename(report))}#${key}`));
  return { type: 'record', keys: fullKeys, decision, project: read.options['--project'], unreadBy: unreadBy(read) };
}

// What a question to the Human must name for this item of this record.
const askOf = (record, item) => ({ pr: record.pr, id: item.id, title: item.title, others: record.items.filter((each) => each !== item && each.title !== item.title).map((each) => each.title), since: record.recorded_at });

// The whole label the option must be: "fix-now" also reads as "Fix now".
const onlyDecision = (decision) => new RegExp(`^\\s*${decision.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('-', '[- ]')}\\s*[.!]?\\s*$`, 'iu');

// Why `answers` hold no word of the Human on this decision, or null when they do. Names the nearest miss.
function answerMismatch(answers, { pr, id, title, others, since }, decision) {
  const names = new RegExp(`(?<![\\w/])#${pr}(?!\\d)`, 'u');
  const shown = JSON.stringify(title);
  if (!answers.length) return 'the transcript holds no AskUserQuestion answer';
  const after = answers.filter((each) => typeof since === 'string' && each.at !== null && Date.parse(each.at) >= Date.parse(since));
  if (!after.length) return 'no AskUserQuestion answer came after it was recorded';
  const onPr = after.filter((each) => names.test(each.question));
  if (!onPr.length) return `no question answered since it was recorded names #${pr}`;
  const onTitle = onPr.filter((each) => each.question.includes(`"${title}"`));
  if (!onTitle.length) return `the questions naming #${pr} do not name ${shown} in double quotes`;
  const onId = onTitle.filter((each) => {
    const ids = [...new Set(each.question.match(ITEM_IDS) ?? [])];
    return ids.length === 1 && ids[0] === id;
  });
  if (!onId.length) return `the question must name ${id} and no other item's id`;
  const onItem = onId.filter((each) => !others.some((other) => each.question.includes(`"${other}"`)));
  if (!onItem.length) return 'the question names another item\'s title too, so its answer is not about this one';
  const only = onlyDecision(decision);
  if (onItem.some((each) => only.test(each.answer))) return null;
  return `the Human picked ${JSON.stringify(cleanTitle(onItem.at(-1).answer))}, and the option must be ${decision} alone`;
}

const judgeAsk = (ask, decision, input) => {
  const why = answerMismatch(transcriptAnswers(readTranscript(input?.transcript_path)), ask, decision);
  if (why === null) return null;
  return `${HUMAN_LEAD}, and this session holds no such answer (${why}). Ask the Human with AskUserQuestion: a question naming #${ask.pr}, ${ask.id}, and ${JSON.stringify(ask.title)}, the title in double quotes, ` +
    `and no other item, with one option that is ${decision} alone. Or the Human runs the command in their own shell.`;
};

const unreadableReason = (what) =>
  `${HUMAN_LEAD}, and the rule cannot read ${what}. Write it out in the command, ask the Human with AskUserQuestion, or the Human runs it in their own shell.`;

function judgeAnswer(call, input, project) {
  if (call.unreadBy) return unreadableReason('every word of it');
  if (!call.pr) return unreadableReason('the pull request');
  if (call.id === null) return unreadableReason('the item');
  if (call.decision === null) return unreadableReason('the decision');
  const records = listRecords(stateDir(project)).filter((record) => record.pr === call.pr.number && (!call.pr.repo || record.repo.toLowerCase() === call.pr.repo.toLowerCase()));
  if (!call.pr.repo && records.length > 1) return `${HUMAN_LEAD}, and more than one repository's record holds #${call.pr.number}. Name the pull request by its URL.`;
  const [record] = records;
  const item = record?.items.find((each) => each.id === call.id);
  if (!item) return `${HUMAN_LEAD}, and no record this machine can read holds that item on #${call.pr.number}. Read the pull request and record what was found, then ask the Human with AskUserQuestion, or the Human runs it in their own shell.`;
  return judgeAsk(askOf(record, item), call.decision, input);
}

// The persona items every record in the state folder lists, answered or not.
const listedItems = (project) => listRecords(stateDir(project)).flatMap((record) => record.items.filter((item) => item.source === PERSONA).map((item) => ({ record, item })));

function judgeRecord(call, input, project) {
  const items = listedItems(project);
  if (call.keys === null) return items.length ? unreadableReason('its keys, and a key it may name is an item of a feedback record') : null;
  const asks = call.keys.flatMap((key) => {
    const held = items.find((each) => each.item.audit_key === key);
    return held ? [askOf(held.record, held.item)] : [];
  });
  if (!asks.length) return null;
  if (call.unreadBy) return unreadableReason('every word of it');
  if (call.decision === null) return unreadableReason('the decision');
  return asks.map((ask) => judgeAsk(ask, call.decision, input)).find(Boolean) ?? null;
}

// Whether `text` names the answer call, whatever it holds besides.
const namesAnswer = (text) => text.includes('--by') && /\bhuman\b/u.test(text) && /\bproduct-feedback\b/u.test(text) && /\banswer\b/u.test(text);
const namesRecord = (text) => text.includes('--by') && /\bhuman\b/u.test(text) && /\baudits\b/u.test(text) && /\brecord\b/u.test(text);

// Whether one command only handles text, by its program and arguments: its output is data, unless a pipe says otherwise.
function handlesText({ program, args, environment }) {
  if (program === 'rg') return !args.some(({ text }) => /^--pre(?:=|$)/u.test(text));
  if (TEXT_PROGRAMS.has(program)) return true;
  const [first] = args;
  if (!first || first.dynamic) return false;
  // A first word that is an option is one of git's global options, which can run anything.
  if (program === 'git') return GIT_TEXT.has(first.text) && environment.length === 0 && !(first.text === 'grep' && args.some(({ text }) => /^(?:-[A-Za-z]*O|--open-files-in-pager)/u.test(text)));
  return program === 'gh' && GH_TEXT.has(first.text);
}

// The walked segments of each line in order, with what each pipes into: one lex per line, and `next` keeps two equal
// segments of a line apart.
function pipelineReader() {
  const lines = new Map();
  const sameWords = (a, b) => a.length === b.length && a.every((token, at) => token.text === b[at].text);
  return ({ line, segment }) => {
    if (!lines.has(line)) lines.set(line, { ...lexPipeline(line), next: 0 });
    const lexed = lines.get(line);
    const found = lexed.segments.findIndex((each, at) => at >= lexed.next && sameWords(each, segment));
    const at = found === -1 ? lexed.segments.findIndex((each) => sameWords(each, segment)) : found;
    if (at === -1) return [];
    lexed.next = at + 1;
    const downstream = [];
    for (let i = at; (lexed.separators[i] === '|' || lexed.separators[i] === '|&') && lexed.segments[i + 1]; i += 1) downstream.push(lexed.segments[i + 1]);
    return downstream;
  };
}

// Whether a walked command stands for the commands its shell or `eval` runs, each of them judged on its own.
const walkedShell = ({ invocation, unread }) => unread === undefined && (invocation.program === 'eval' || inlineShellCommand(invocation) !== null || readsShellInput(invocation));

// Whether a walked command can write a feedback record the hook never saw: `pr product-feedback record`, or an aidrian call
// whose subcommand it cannot read.
export const writesUnseen = (call) => call?.writesRecord === true || call?.type === 'unreadable';

// Whether this machine keeps product feedback anywhere the rule can see in one look: a `product-feedback/` folder in a
// project's state folder under the state root, or in the current project's, which covers a `state.dir` it moves.
function feedbackOnMachine(activeIn, cwd) {
  const projects = path.join(stateRoot(), 'projects');
  let names = [];
  try {
    names = readdirSync(projects);
  } catch {}
  return names.some((name) => isDirectory(path.join(projects, name, 'product-feedback'))) || Boolean(activeIn(cwd));
}

// `denied` when a command the word pass did not judge names a call (`names(text, folder)`), else null.
export function textDenial(entries, judged, denied, names) {
  const downstreamOf = pipelineReader();
  for (const entry of entries) {
    const downstream = downstreamOf(entry);
    if (judged.has(entry)) continue;
    const { invocation, segment, inputs, unread, line, folder } = entry;
    if ((FEEDS_BLIND.has(invocation.program) || unread !== undefined) && names(line, folder)) return denied;
    if (walkedShell(entry)) continue;
    if (handlesText(invocation) && downstream.every((each) => handlesText(readInvocation(each)))) continue;
    if (names([...segment.map((token) => token.text), ...inputs].join(' '), folder)) return denied;
  }
  return null;
}

// The folder a call runs for: its --project, against the folder it runs in, or null when it cannot be read: a dynamic
// one or one the shell expands (readWords), one it expands from `~`, or a relative one in a folder it cannot read.
function callFolder(project, folder) {
  if (project === undefined) return folder;
  if (project === null || project.startsWith('~')) return null;
  if (path.isAbsolute(project)) return project;
  return folder === null ? null : path.resolve(folder, project);
}

// Whether a project keeps product feedback: its state folder holds `product-feedback/`.
const keepsFeedback = (project) => isDirectory(path.join(stateDir(project), 'product-feedback'));

// The project a folder is in when the feature is on there, null when it is off, and UNKNOWN for a folder it cannot read
// while this machine keeps product feedback: the one path that looks past the current project. A folder it cannot read
// is null, one that is no existing directory (`cd ../proj[B]` as written, which the shell would expand), or any but cwd
// under a CDPATH, in the command or the environment, which can send a `cd` anywhere.
// `on` says whether the feature is on in a project, and `unknownWhen` whether a folder it cannot read is UNKNOWN rather
// than null; the ready hold (github/ready-hold.mjs) reads folders by these same rules with its own two.
export function projectReader(command, cwd, env, { on = keepsFeedback, unknownWhen = feedbackOnMachine } = {}) {
  const cdpath = /\bCDPATH\b/u.test(command) || Boolean(env.CDPATH);
  const active = new Map();
  const activeIn = (folder) => {
    if (!active.has(folder)) {
      const project = findProject(folder);
      active.set(folder, project && on(project) ? project : null);
    }
    return active.get(folder);
  };
  let unknown;
  return (folder) => {
    if (folder !== null && isDirectory(folder) && !(cdpath && folder !== cwd)) return activeIn(folder);
    unknown ??= unknownWhen(activeIn, cwd);
    return unknown ? UNKNOWN : null;
  };
}

// The deny reason for `command`, or null. On only inside a project whose state folder holds `product-feedback/`. `input` is
// the hook payload, for its `agent_id` and its transcript; `env` the environment its shell inherits, for its CDPATH.
export function check(command, { cwd = process.cwd(), input = {}, env = process.env } = {}) {
  if (!CANDIDATE.test(command)) return null;
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const projectIn = projectReader(command, cwd, env);
  const entries = walkCommands(command, cwd);
  const calls = new Map(entries.map((entry) => [entry, entry.unread === undefined ? readCall(entry.invocation) : null]));
  // chainedRecord: another call of this command may write a record after the hook, so a call here that claims a human, or
  // that the rule cannot read, is refused, whatever the disk or activeIn says now.
  const chainedRecord = (self) => entries.some((other) => other !== self && writesUnseen(calls.get(other)));
  const chained = chainedRecord(null);
  const judged = new Set();
  for (const entry of entries) {
    const { unread, folder } = entry;
    if (chained && unread !== undefined && /\bproduct-feedback\s+answer\b|\baudits\s+record\b/u.test(unread) && /--by\b/u.test(unread)) return subagent ? SUBAGENT : CHAINED;
    if (unread !== undefined) {
      const project = /\bproduct-feedback\s+answer\b|\baudits\s+record\b/u.test(unread) ? projectIn(folder) : null;
      if (!project) continue;
      if (project === UNKNOWN) {
        if (/\bproduct-feedback\s+answer\b/u.test(unread) || /--by\b/u.test(unread)) return UNKNOWN_PROJECT;
        continue;
      }
      if (/\bproduct-feedback\s+answer\b/u.test(unread)) return subagent ? SUBAGENT : UNREAD;
      if (/--by\b/u.test(unread)) {
        if (subagent) return SUBAGENT;
        if (listedItems(project).length) return UNREAD;
      }
      continue;
    }
    const call = calls.get(entry);
    if (!call) continue;
    judged.add(entry);
    if (call.type === 'clean') continue;
    // A call that claims a human, or that it cannot read, an unreadable one included, beside another call that may write.
    if (chainedRecord(entry)) return subagent ? SUBAGENT : CHAINED;
    const project = projectIn(callFolder(call.project, folder));
    if (!project) continue;
    // It cannot say which project it means, so nothing below can be looked up, and the call may claim no human at all.
    if (project === UNKNOWN) return UNKNOWN_PROJECT;
    if (subagent) return SUBAGENT;
    if (call.type === 'unreadable') return unreadableReason('its subcommand');
    const denied = call.type === 'answer' ? judgeAnswer(call, input, project) : judgeRecord(call, input, project);
    if (denied) return denied;
  }
  const names = (text, folder) => {
    if (chained && (namesRecord(text) || namesAnswer(text))) return true;
    if (!namesAnswer(text) && !namesRecord(text)) return false;
    const project = projectIn(folder);
    // A call of audits record holds only a key a record lists, which a project it cannot read may list.
    return project === UNKNOWN || (Boolean(project) && (namesAnswer(text) || listedItems(project).length > 0));
  };
  return textDenial(entries, judged, subagent ? SUBAGENT : TEXT_ONLY, names);
}
