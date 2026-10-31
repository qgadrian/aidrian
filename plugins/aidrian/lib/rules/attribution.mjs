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
import { runGit } from '../git.mjs';
import { findProject } from '../project.mjs';
import { isLongOption, lexCommand, readGit, walkCommands } from '../shell-lex.mjs';
import { readText } from '../transcript.mjs';
import { readBody, readPrCall, readPrCalls } from './github/pr-body.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_UNATTRIBUTED';

// The heredoc a `-m` or `--message` command substitution prints unchanged, `-m "$(cat <<'EOF' … EOF)"`: group 3 is its
// body. The substitution must be the whole word and hold only the heredoc: any other, such as `$(printf x <<'EOF' … EOF)`
// or one that prints more after it, may print something else, so it is not read.
const MESSAGE_HEREDOC = /(?:--message(?:=|\s+)|(?<![\w-])-[A-Za-z]*m=?\s*)(?<quote>"?)\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\2\r?\n([\s\S]*?)\r?\n[ \t]*\3[ \t]*\r?\n?[ \t]*\)\k<quote>(?=\s|$|[;&|)])/gu;
// Where a -m command substitution sits among a commit's messages, until its heredoc is read.
const DYNAMIC = Symbol('dynamic message');

// The trailers the commit will carry, as `Key: value`. git answers in the folder the commit runs in, with that
// repository's trailer settings: `git interpret-trailers` adds the --trailer values to the message's trailer block,
// and `cleanup` is the commit's message cleanup.
// A message the rule cannot read (null) counts only the --trailer values. When git cannot answer, carriedTrailers reads
// them by git's defaults.
function commitTrailers(message, trailers, dir, config = [], cleanup = (text) => text) {
  if (dir) {
    // As git commits: the --trailer values go in first, the cleanup runs over the whole message, and the trailers are
    // read from what is left. `--no-divider`: a `---` line in a commit message is text, not the start of a patch.
    const git = (args, input) => runGit([...config, 'interpret-trailers', '--no-divider', ...args], dir, { input });
    // git's prepared message ends in a newline; without it, a --trailer would join the subject's paragraph.
    const text = message === null || message.endsWith('\n') ? message ?? '' : `${message}\n`;
    // git applies trailer.* settings only when it adds a --trailer; the final read applies none (`--only-input`).
    const full = trailers.length ? git(trailers.flatMap((trailer) => ['--trailer', trailer]), text) : { status: 0, stdout: text };
    const parsed = full.status === 0 ? git(['--only-trailers', '--only-input', '--unfold'], cleanup(full.stdout)) : null;
    if (parsed?.status === 0) {
      const lines = parsed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      // git writes each trailer with its configured separator (trailer.separators), such as `Agent= main`.
      return new Set(lines.map((line) => line.replace(/^([A-Za-z0-9-]+)\s*[^\w\s-]\s*/u, '$1: ')));
    }
  }
  return carriedTrailers(message === null ? [] : [cleanup(message)], trailers);
}

// A heredoc match's body as bash passes it: as written under a quoted delimiter, or under a bare one when it holds
// nothing bash expands (`$`, a backtick, or a backslash); else null, a body the rule cannot know.
export const unchangedHeredoc = (match) => (match[2] || !/[$`\\]/u.test(match[4]) ? match[4] : null);

// A token's text, or null when it is missing or dynamic.
const staticText = (token) => (token && !token.dynamic && token.text ? token.text : null);

// The deny reason for `command`, or null. `commits(cwd, base, head)` is the test seam for the branch's commit trailers.
export function check(command, { cwd = process.cwd(), env = process.env, input, commits = branchCommits } = {}) {
  if (env[OVERRIDE] === '1' || typeof input?.transcript_path !== 'string') return null;
  const { gitCommits, prCreates } = readCalls(command, cwd);
  if (!gitCommits.length && !prCreates.length) return null;
  // Each call answers to the project it runs in, as its own folder finds it; in a folder the rule cannot know, the
  // session's.
  const projects = new Map();
  const settings = (dir) => {
    const at = dir ?? cwd;
    if (!projects.has(at)) {
      const project = findProject(at);
      projects.set(at, project ? { project, config: loadConfig(project).config } : null);
    }
    return projects.get(at);
  };
  let author;
  const who = () => (author ??= currentAuthor(input, env));
  for (const { messages, trailers, cleanup, dir, config } of gitCommits) {
    const fields = settings(dir)?.config.attribution.commit ?? [];
    if (!fields.length) continue;
    const expected = expectedTrailers(fields, who());
    const carried = commitTrailers(messages.length ? messages.join('\n\n') : null, trailers, dir, config, cleanup);
    const missing = expected.filter((trailer) => !carried.has(trailer));
    if (missing.length) return commitReason(expected, missing);
  }
  for (const { call, dir } of prCreates) {
    const found = settings(dir);
    const prFields = found?.config.attribution.pullRequest ?? [];
    if (!prFields.length) continue;
    const { project, config } = found;
    const body = readBody(call, dir);
    if (body === null) {
      return hint('the attribution rule cannot read this pull request body (a variable, a command substitution, stdin, a missing ' +
        `file, or none), so it cannot check its attribution. Pass a literal --body, a heredoc (--body "$(cat <<'EOF' … EOF)"), ` +
        'or a --body-file that exists.');
    }
    const head = staticText(call.head) ?? 'HEAD';
    const agents = prFields.includes('agents')
      ? prAgents({
        commits: dir ? commits(dir, staticText(call.base) ?? config.git.defaultBranch, head) : [],
        rows: readLog(project, config).rows,
        sessionId: input.session_id,
        exclude: config.attribution.exclude,
      })
      : [];
    const expected = prLines(prFields, who(), agents);
    if (prMissing(body, expected).length) return prReason(expected);
  }
  return null;
}

// The command's commits, as { messages, trailers, cleanup, dir, config }, and its `gh pr create` calls, as { call, dir },
// in the order they run, with the folder each runs in from shell-lex `walkCommands`: substitutions, `sh -c`, and scripts
// fed to a shell included, and a folder it cannot know as null, where a relative file is not read. A help or dry-run
// commit writes nothing and is left out.
function readCalls(command, cwd) {
  const gitCommits = [];
  const prCreates = [];
  const lines = new Map();
  const state = (line) => {
    if (!lines.has(line)) lines.set(line, { heredocs: [...line.matchAll(MESSAGE_HEREDOC)].map(unchangedHeredoc), pending: [], prCalls: [] });
    return lines.get(line);
  };
  for (const { segment, folder, line } of walkCommands(command, cwd)) {
    const git = readGit(segment);
    if (git?.subcommand === 'commit') {
      // `git -c key=value` holds for this commit only, so the rule's own git calls take it too.
      const config = git.globals.flatMap((token, i) => (token.text === '-c' && git.globals[i + 1] && !git.globals[i + 1].dynamic ? ['-c', git.globals[i + 1].text] : []));
      const read = commitMessage(git.rest, folder, config);
      Object.assign(read, { dir: folder, config });
      // A commit that writes nothing still holds its heredoc, so the later ones keep their own.
      if (read.holdsHeredoc) state(line).pending.push(read);
      if (!read.writesNothing) gitCommits.push(read);
    }
    if (readPrCall(segment)) {
      const here = state(line);
      // The same line text can run again, as two identical `sh -c` bodies do: a spent queue starts over.
      if (!here.prCalls.length) here.prCalls = readPrCalls(line);
      const call = here.prCalls.shift();
      if (call?.subcommand === 'create' && !call.help && !call.web && !call.dryRun) prCreates.push({ call, dir: folder });
    }
  }
  // The n-th commit whose message is a command substitution takes its line's n-th message heredoc, and only when the
  // counts match: one commit's heredoc never stands in for another's. A message part the rule cannot read may end the
  // message, past any trailer block, so then only --trailer counts.
  // A line that runs more than once, as an `sh -c` body run twice does, pairs each run with the line's heredocs anew.
  for (const [line, { heredocs, pending }] of lines) {
    const perRun = lexCommand(line).map(readGit).filter((git) => git?.subcommand === 'commit' && commitMessage(git.rest, null).holdsHeredoc).length;
    const paired = perRun > 0 && perRun === heredocs.length && pending.length % perRun === 0;
    pending.forEach((read, i) => {
      if (!read.dynamic) return;
      const heredoc = paired ? heredocs[i % perRun] : null;
      if (heredoc !== null) read.messages.splice(read.at, 0, heredoc);
      else read.messages = [];
    });
  }
  return { gitCommits, prCreates };
}

// The `git commit` options that take the next word as their value, besides -m, -F, and --trailer.
const COMMIT_VALUES = ['--author', '--date', '--template', '--pathspec-from-file'];
// The status formats, which make a commit a dry run that only prints the status.
const STATUS_FORMATS = ['--short', '--porcelain', '--long'];
// The options after which git writes the subject itself, `fixup! …` or `squash! …`, above the -m values.
const GENERATED_SUBJECT = ['--fixup', '--squash'];
const COMMIT_SHORT_VALUES = new Set(['-t']);
// The options that take the message from another commit, which the rule does not read.
const REUSE_VALUES = ['--reuse-message', '--reedit-message'];
const REUSE_SHORT = new Set(['-C', '-c']);

// git's comment string in `dir`: core.commentString, else core.commentChar, else `#`; `auto` picks per message, so `#`
// stands in for it.
function commentChar(dir, config = []) {
  for (const key of ['core.commentString', 'core.commentChar']) {
    const result = dir ? runGit([...config, 'config', key], dir) : null;
    const value = result?.status === 0 ? result.stdout.replace(/\n$/u, '') : '';
    if (value && value !== 'auto') return value;
  }
  return '#';
}

// A message as git stores it under `--cleanup` (`mode`), which defaults to `strip` when the message is edited and to
// `whitespace` when not: `strip` drops the lines that start with the `comment` string; `scissors`, when edited, drops the scissors line and all after it.
export function cleanMessage(text, mode, edit, comment = '#') {
  const effective = mode && mode !== 'default' ? mode : edit ? 'strip' : 'whitespace';
  let lines = text.split('\n');
  if (effective === 'strip') lines = lines.filter((line) => !line.startsWith(comment));
  if (effective === 'scissors' && edit) {
    const cut = lines.findIndex((line) => line === `${comment} ------------------------ >8 ------------------------`);
    if (cut !== -1) lines = lines.slice(0, cut);
  }
  return lines.join('\n');
}

// One commit's { messages, trailers, dynamic, holdsHeredoc, at, writesNothing, cleanup }: its -m values in order, or its -F file's text, its
// --trailer values, whether a kept or dropped -m value is a command substitution, where in `messages` it goes, and whether the
// call makes no commit: `-h`, `--help`, or a `--dry-run` or status format that no later `--no-dry-run` undoes. Option values are skipped,
// so `-m --help` is a message. `--no-message` and `--no-file` drop the -m values and the -F file before them. Under
// `--fixup` or `--squash`, git writes a subject above the -m values, so a single -m can hold the trailer block.
function commitMessage(rest, dir, config = []) {
  const read = { messages: [], trailers: [], dynamic: false, at: 0, writesNothing: false };
  const messages = [];
  let fileText = null;
  let reused = false;
  let generated = false;
  let dryRun = false;
  // git keeps one status format, which --short, --porcelain, and --long set and any of their --no- forms clears, and
  // a separate -z/--null.
  let format = null;
  let nul = false;
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
    else if (text === '-z' || flag === '--null') nul = true;
    else if (flag === '--no-null') nul = false;
    else if (STATUS_FORMATS.includes(flag)) format = flag;
    else if (STATUS_FORMATS.includes(flag.replace(/^--no-/u, '--'))) format = null;
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
      // Joined, not resolved: the filesystem follows a symlink before a `..`, as git opens the operand.
      const file = path.isAbsolute(token.text) ? token.text : dir ? `${dir}/${token.text}` : null;
      fileText = (file && readText(file)) ?? '';
    }
  }
  read.writesNothing ||= dryRun || format !== null || nul;
  // The message git writes: another commit's when one is reused, which the rule cannot read; else the -m values, else
  // the -F file. Only the --trailer values then count for a message the rule cannot read.
  const kept = reused ? [] : messages.length ? [...(generated ? ['fixup! subject'] : []), ...messages] : fileText !== null ? [fileText] : [];
  read.holdsHeredoc = messages.includes(DYNAMIC);
  // Only one -m substitution can take a heredoc; with more, the message is one the rule cannot read.
  const unread = kept.filter((each) => each === DYNAMIC).length > 1;
  read.dynamic = !unread && kept.includes(DYNAMIC);
  if (unread) kept.length = 0;
  read.at = kept.indexOf(DYNAMIC);
  read.messages = kept.filter((each) => each !== DYNAMIC);
  // Without --cleanup, git takes the repository's commit.cleanup, read in the folder the commit runs in.
  const configured = cleanup === null && dir ? runGit([...config, 'config', 'commit.cleanup'], dir) : null;
  const mode = cleanup ?? (configured?.status === 0 ? configured.stdout.trim() : null);
  read.cleanup = (text) => cleanMessage(text, mode, edit, commentChar(dir, config));
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
