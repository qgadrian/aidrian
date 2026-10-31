// Bash rule: an agent's `git commit` carries the trailers config.json `attribution.commit` lists, and its `gh pr create`
// body ends with the lines `attribution.pullRequest` asks for (docs/config.md#attribution). lib/attribution.mjs reads the
// values. Off while both lists are empty; runs only inside a project, on a call whose payload names a transcript.
// Each `git commit` of the command is judged on its own message: its -m values, the heredoc of a -m command substitution,
// or its -F file, plus its --trailer values. A message on stdin (-F -) or from an
// editor counts only its --trailer values. A `gh pr create` body the rule cannot read is refused. `gh pr edit` passes:
// another session would attribute the same pull request differently.

import path from 'node:path';

import { branchCommits, carriedTrailers, currentAuthor, expectedTrailers, prAgents, prLines, prMissing } from '../attribution.mjs';
import { loadConfig } from '../config.mjs';
import { readLog } from '../dispatch-log.mjs';
import { findProject } from '../project.mjs';
import { commandLines, inlineShellCommand, isLongOption, lexCommand, readGit, readInvocation } from '../shell-lex.mjs';
import { readText } from '../transcript.mjs';
import { readBody, readPrCall, readPrCalls } from './github/pr-body.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_UNATTRIBUTED';

// The heredoc a `-m` or `--message` command substitution prints unchanged, `-m "$(cat <<'EOF' … EOF)"`: group 3 is its
// body. Any other substitution, such as `$(printf x <<'EOF' … EOF)`, may print something else, so it is not read.
const MESSAGE_HEREDOC = /(?:--message(?:=|\s+)|(?<![\w-])-[A-Za-z]*m=?\s*)"?\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b/gu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd']);
// How deep `sh -c` inside `sh -c` is read.
const SHELL_DEPTH_LIMIT = 4;
// Where a -m command substitution sits among a commit's messages, until its heredoc is read.
const DYNAMIC = Symbol('dynamic message');

// A token's text, or null when it is missing or dynamic.
const staticText = (token) => (token && !token.dynamic && token.text ? token.text : null);

// The deny reason for `command`, or null. `commits(cwd, base, head)` is the test seam for the branch's commit trailers.
export function check(command, { cwd = process.cwd(), env = process.env, input, commits = branchCommits } = {}) {
  if (env[OVERRIDE] === '1' || typeof input?.transcript_path !== 'string' || !/\b(?:commit|pr)\b/u.test(command)) return null;
  const { gitCommits, prCreates } = readCalls(command, cwd);
  if (!gitCommits.length && !prCreates.length) return null;
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  const { commit: commitFields, pullRequest: prFields, exclude } = config.attribution;
  if (!commitFields.length && !prFields.length) return null;
  const author = currentAuthor(input, env);
  if (commitFields.length) {
    const expected = expectedTrailers(commitFields, author);
    for (const { messages, trailers, cleanup } of gitCommits) {
      const carried = carriedTrailers(messages.length ? [cleanup(messages.join('\n\n'))] : [], trailers);
      const missing = expected.filter((trailer) => !carried.has(trailer));
      if (missing.length) return commitReason(expected, missing);
    }
  }
  if (prFields.length) {
    for (const { call, dir } of prCreates) {
      const body = dir ? readBody(call, dir) : null;
      if (body === null) {
        return hint('the attribution rule cannot read this pull request body (a variable, a command substitution, stdin, a missing ' +
          `file, or none), so it cannot check its attribution. Pass a literal --body, a heredoc (--body "$(cat <<'EOF' … EOF)"), ` +
          'or a --body-file that exists.');
      }
      const agents = prFields.includes('agents')
        ? prAgents({ commits: commits(dir, staticText(call.base) ?? config.git.defaultBranch, staticText(call.head) ?? 'HEAD'), rows: readLog(project, config).rows, sessionId: input.session_id, exclude })
        : [];
      const expected = prLines(prFields, author, agents);
      if (prMissing(body, expected).length) return prReason(expected);
    }
  }
  return null;
}

// The command's commits, as { messages, trailers }, and its `gh pr create` calls, as { call, dir }, in order. Each is
// read in the folder it runs in: the shell's, moved by each earlier `cd` or `pushd` to a named folder, by a wrapper's
// directory change, and by `git -C`. `dir` is null once a move goes where no word names, and a relative file there is
// not read. A help or dry-run commit writes nothing and is left out. The command line of `sh -c` or `bash -c` is read
// too, starting where that shell runs; a script on a shell's stdin is not.
function readCalls(command, cwd, depth = 0) {
  const gitCommits = [];
  const prCreates = [];
  for (const line of commandLines(command)) {
    let dir = cwd;
    const messageHeredocs = [...line.matchAll(MESSAGE_HEREDOC)].map((match) => match[3]);
    const pending = [];
    const prCalls = readPrCalls(line);
    for (const segment of lexCommand(line)) {
      const invocation = readInvocation(segment);
      const { program, args, chdir } = invocation;
      const own = chdir ? moveTo(dir, chdir) : dir;
      const inner = depth < SHELL_DEPTH_LIMIT ? inlineShellCommand(invocation) : null;
      if (inner) {
        const nested = readCalls(inner, own, depth + 1);
        gitCommits.push(...nested.gitCommits);
        prCreates.push(...nested.prCreates);
      }
      const git = readGit(segment);
      if (git?.subcommand === 'commit') {
        let at = own;
        git.globals.forEach((token, i) => {
          if (token.text === '-C') at = moveTo(at, git.globals[i + 1]);
        });
        const read = commitMessage(git.rest, at);
        // A commit that writes nothing still holds its heredoc, so the later ones keep their own.
        if (read.holdsHeredoc) pending.push(read);
        if (!read.writesNothing) gitCommits.push(read);
      }
      if (readPrCall(segment)) {
        const call = prCalls.shift();
        if (call?.subcommand === 'create' && !call.help && !call.web && !call.dryRun) prCreates.push({ call, dir: own });
      }
      if (CHANGES_DIRECTORY.has(program)) dir = moveTo(dir, args.find((token) => !/^-[LPe@]+$/u.test(token.text)));
    }
    // The n-th commit whose message is a command substitution takes the line's n-th message heredoc, and only when the
    // counts match: one commit's heredoc never stands in for another's.
    pending.forEach((read, i) => {
      if (!read.dynamic) return;
      // A message part the rule cannot read may end the message, past any trailer block: then only --trailer counts.
      if (messageHeredocs.length === pending.length) read.messages.splice(read.at, 0, messageHeredocs[i]);
      else read.messages = [];
    });
  }
  return { gitCommits, prCreates };
}

// The folder `to` names from `dir`, or null when either is unknown.
function moveTo(dir, to) {
  if (!to || to.dynamic || /^(?:-|[+-]\d+)$/u.test(to.text)) return null;
  if (path.isAbsolute(to.text)) return to.text;
  return dir ? path.resolve(dir, to.text) : null;
}

// The `git commit` options that take the next word as their value, besides -m, -F, and --trailer.
const COMMIT_VALUES = ['--author', '--date', '--template', '--pathspec-from-file'];
// The status formats, which make a commit a dry run that only prints the status.
const STATUS_FORMATS = ['--short', '--porcelain', '--long', '--null'];
// The options after which git writes the subject itself, `fixup! …` or `squash! …`, above the -m values.
const GENERATED_SUBJECT = ['--fixup', '--squash'];
const COMMIT_SHORT_VALUES = new Set(['-t']);
// The options that take the message from another commit, which the rule does not read.
const REUSE_VALUES = ['--reuse-message', '--reedit-message'];
const REUSE_SHORT = new Set(['-C', '-c']);

// A message as git stores it under `--cleanup` (`mode`), which defaults to `strip` when the message is edited and to
// `whitespace` when not: `strip` drops `#` comment lines; `scissors`, when edited, drops the scissors line and all after it.
export function cleanMessage(text, mode, edit) {
  const effective = mode && mode !== 'default' ? mode : edit ? 'strip' : 'whitespace';
  let lines = text.split('\n');
  if (effective === 'strip') lines = lines.filter((line) => !line.startsWith('#'));
  if (effective === 'scissors' && edit) {
    const cut = lines.findIndex((line) => /^# -+ >8 -+$/u.test(line));
    if (cut !== -1) lines = lines.slice(0, cut);
  }
  return lines.join('\n');
}

// One commit's { messages, trailers, dynamic, holdsHeredoc, at, writesNothing, cleanup }: its -m values in order, or its -F file's text, its
// --trailer values, whether a kept or dropped -m value is a command substitution, where in `messages` it goes, and whether the
// call makes no commit: `-h`, `--help`, or a `--dry-run` or status format that no later `--no-dry-run` undoes. Option values are skipped,
// so `-m --help` is a message. `--no-message` and `--no-file` drop the -m values and the -F file before them. Under
// `--fixup` or `--squash`, git writes a subject above the -m values, so a single -m can hold the trailer block.
function commitMessage(rest, dir) {
  const read = { messages: [], trailers: [], dynamic: false, at: 0, writesNothing: false };
  const messages = [];
  let fileText = null;
  let reused = false;
  let generated = false;
  let dryRun = false;
  const formats = new Set();
  let cleanup = null;
  let edit = false;
  for (let i = 0; i < rest.length; i += 1) {
    const { text } = rest[i];
    if (text === '--') break;
    const [flag, inline] = text.startsWith('--') && text.includes('=') ? [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)] : [text, null];
    const value = () => (inline !== null ? { text: inline, dynamic: rest[i].dynamic } : rest[++i] ?? null);
    let token = null;
    let kind = null;
    if (text === '-h' || isLongOption(flag, '--help', '--he')) read.writesNothing = true;
    else if (isLongOption(flag, '--dry-run', '--dr')) dryRun = true;
    else if (STATUS_FORMATS.includes(flag) || text === '-z') formats.add(text === '-z' ? '--null' : flag);
    else if (STATUS_FORMATS.includes(flag.replace(/^--no-/u, '--'))) formats.delete(flag.replace(/^--no-/u, '--'));
    else if (flag === '--cleanup') cleanup = value()?.text ?? null;
    else if (text === '-e' || flag === '--edit') edit = true;
    else if (flag === '--no-edit') edit = false;
    else if (isLongOption(flag, '--no-dry-run', '--no-d')) dryRun = false;
    else if (COMMIT_VALUES.some((option) => isLongOption(flag, option, option)) || COMMIT_SHORT_VALUES.has(text)) value();
    else if (GENERATED_SUBJECT.some((option) => isLongOption(flag, option, option))) {
      generated = true;
      value();
    } else if (REUSE_VALUES.some((option) => isLongOption(flag, option, option)) || REUSE_SHORT.has(text)) {
      reused = true;
      value();
    }
    else if (flag === '--no-fixup' || flag === '--no-squash') generated = false;
    else if (flag === '--no-reuse-message' || flag === '--no-reedit-message') reused = false;
    else if (flag === '--no-message') messages.length = 0;
    else if (flag === '--no-file') fileText = null;
    else if (isLongOption(flag, '--message', '--m')) [kind, token] = ['message', value()];
    else if (isLongOption(flag, '--file', '--fi')) [kind, token] = ['file', value()];
    else if (isLongOption(flag, '--trailer', '--tr')) [kind, token] = ['trailer', value()];
    else if (/^-[^-]/u.test(text)) {
      // A short cluster such as `-am msg` or `-Fmsg.txt`: -m and -F take the rest of the word, else the next one.
      const at = text.search(/[mF]/u);
      if (at > 0) {
        kind = text[at] === 'm' ? 'message' : 'file';
        token = text.length > at + 1 ? { text: text.slice(at + 1), dynamic: rest[i].dynamic } : rest[++i] ?? null;
      }
    }
    if (!token) continue;
    if (kind === 'trailer') read.trailers.push(token.text);
    else if (kind === 'message' && token.dynamic) messages.push(DYNAMIC);
    else if (kind === 'message') messages.push(token.text);
    else if (token.dynamic || token.text === '-') fileText = '';
    else {
      const file = path.isAbsolute(token.text) ? token.text : dir ? path.resolve(dir, token.text) : null;
      fileText = (file && readText(file)) ?? '';
    }
  }
  read.writesNothing ||= dryRun || formats.size > 0;
  // The message git writes: another commit's when one is reused, which the rule cannot read; else the -m values, else
  // the -F file. Only the --trailer values then count for a message the rule cannot read.
  const kept = reused ? [] : messages.length ? [...(generated ? ['fixup! subject'] : []), ...messages] : fileText !== null ? [fileText] : [];
  read.holdsHeredoc = messages.includes(DYNAMIC);
  read.dynamic = kept.includes(DYNAMIC);
  read.at = kept.indexOf(DYNAMIC);
  read.messages = kept.filter((each) => each !== DYNAMIC);
  read.cleanup = (text) => cleanMessage(text, cleanup, edit);
  return read;
}

const hint = (problem) =>
  `Blocked: ${problem}\nThe values come from this session's transcript (config.json \`attribution\`). ` +
  `To override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
  "(agents must never set it on the user's behalf).";

function commitReason(expected, missing) {
  return hint(`the commit lacks the attribution trailer(s) ${missing.map((line) => `\`${line}\``).join(', ')}. ` +
    `Add them to the message's last paragraph, or pass: ${expected.map((line) => `--trailer '${line}'`).join(' ')}`);
}

function prReason(expected) {
  return hint(`the pull request body lacks its attribution. End the body with these lines, as written:\n\n${expected.join('\n')}\n`);
}
