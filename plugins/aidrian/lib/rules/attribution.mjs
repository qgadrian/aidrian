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
import { commandLines, isLongOption, lexCommand, readGit, readInvocation } from '../shell-lex.mjs';
import { readText } from '../transcript.mjs';
import { readBody, readPrCall, readPrCalls } from './github/pr-body.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_UNATTRIBUTED';

// The heredoc a `-m` or `--message` command substitution holds, as `-m "$(cat <<'EOF' … EOF)"`: group 3 is its body.
const MESSAGE_HEREDOC = /(?:--message(?:=|\s+)|(?<![\w-])-[A-Za-z]*m=?\s*)"?\$\([^<]*<<-?\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b/gu;
const CHANGES_DIRECTORY = new Set(['cd', 'pushd']);

// The deny reason for `command`, or null. `commits(cwd, base)` is the test seam for the branch's commit trailers.
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
    for (const { messages, trailers } of gitCommits) {
      const carried = carriedTrailers(messages, trailers);
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
        ? prAgents({ commits: commits(dir, config.git.defaultBranch), rows: readLog(project, config).rows, sessionId: input.session_id, exclude })
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
// not read. A help or dry-run commit writes nothing and is left out.
function readCalls(command, cwd) {
  const gitCommits = [];
  const prCreates = [];
  for (const line of commandLines(command)) {
    let dir = cwd;
    const messageHeredocs = [...line.matchAll(MESSAGE_HEREDOC)].map((match) => match[3]);
    const pending = [];
    const prCalls = readPrCalls(line);
    for (const segment of lexCommand(line)) {
      const { program, args, chdir } = readInvocation(segment);
      const own = chdir ? moveTo(dir, chdir) : dir;
      const git = readGit(segment);
      if (git?.subcommand === 'commit' && !writesNothing(git.rest)) {
        let at = own;
        git.globals.forEach((token, i) => {
          if (token.text === '-C') at = moveTo(at, git.globals[i + 1]);
        });
        const read = commitMessage(git.rest, at);
        gitCommits.push(read);
        if (read.dynamic) pending.push(read);
      }
      if (readPrCall(segment)) {
        const call = prCalls.shift();
        if (call?.subcommand === 'create' && !call.help && !call.web) prCreates.push({ call, dir: own });
      }
      if (CHANGES_DIRECTORY.has(program)) dir = moveTo(dir, args.find((token) => !/^-[LPe@]+$/u.test(token.text)));
    }
    // The n-th commit whose message is a command substitution takes the line's n-th message heredoc, and only when the
    // counts match: one commit's heredoc never stands in for another's.
    pending.forEach((read, i) => {
      if (messageHeredocs.length === pending.length) read.messages.splice(read.at, 0, messageHeredocs[i]);
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

// `git commit -h`, `--help`, or `--dry-run`: no commit is made.
const writesNothing = (rest) =>
  rest.some(({ text }) => text === '-h' || isLongOption(text, '--help', '--he') || isLongOption(text, '--dry-run', '--dr'));

// One commit's { messages, trailers, dynamic, at }: its -m values in order, or its -F file's text, its --trailer values,
// whether a -m value is a command substitution, and where in `messages` that value goes.
function commitMessage(rest, dir) {
  const read = { messages: [], trailers: [], dynamic: false, at: 0 };
  for (let i = 0; i < rest.length; i += 1) {
    const { text } = rest[i];
    if (text === '--') break;
    const [flag, inline] = text.startsWith('--') && text.includes('=') ? [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)] : [text, null];
    const value = () => (inline !== null ? { text: inline, dynamic: rest[i].dynamic } : rest[++i] ?? null);
    let token = null;
    let kind = null;
    if (isLongOption(flag, '--message', '--m')) [kind, token] = ['message', value()];
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
    else if (kind === 'message' && token.dynamic) [read.dynamic, read.at] = [true, read.messages.length];
    else if (kind === 'message') read.messages.push(token.text);
    else if (!token.dynamic && token.text !== '-') {
      const file = path.isAbsolute(token.text) ? token.text : dir ? path.resolve(dir, token.text) : null;
      read.messages.push((file && readText(file)) ?? '');
    }
  }
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
