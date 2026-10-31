// Bash rule: an agent's `git commit` carries the trailers config.json `attribution.commit` lists, and its `gh pr create`
// body ends with the lines `attribution.pullRequest` asks for (docs/config.md#attribution). lib/attribution.mjs reads the
// values. Off while both lists are empty; runs only inside a project, on a call whose payload names a transcript.
// Each `git commit` of the command is judged on its own message: its -m values, the heredocs the command holds when a
// -m value is a command substitution, or its -F file, plus its --trailer values. A message on stdin (-F -) or from an
// editor counts only its --trailer values. `gh pr edit` passes: another session would attribute the same pull request
// differently.

import path from 'node:path';

import { branchCommits, carriedTrailers, currentAuthor, expectedTrailers, prAgents, prLines, prMissing } from '../attribution.mjs';
import { loadConfig } from '../config.mjs';
import { readLog } from '../dispatch-log.mjs';
import { findProject } from '../project.mjs';
import { commandLines, isLongOption, lexCommand, readGit } from '../shell-lex.mjs';
import { readText } from '../transcript.mjs';
import { readBody, readPrCall } from './github/pr-body.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_UNATTRIBUTED';

// A heredoc's body: group 3.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2\b/gu;

// The deny reason for `command`, or null. `commits(cwd, base)` is the test seam for the branch's commit trailers.
export function check(command, { cwd = process.cwd(), env = process.env, input, commits = branchCommits } = {}) {
  if (env[OVERRIDE] === '1' || typeof input?.transcript_path !== 'string' || !/\b(?:commit|pr)\b/u.test(command)) return null;
  const calls = commandLines(command).flatMap((line) => lexCommand(line).map((segment) => ({ line, segment })));
  const gitCommits = calls.map(({ line, segment }) => ({ line, git: readGit(segment) })).filter(({ git }) => git?.subcommand === 'commit');
  const prCreates = calls.map(({ line, segment }) => ({ line, call: readPrCall(segment) }))
    .filter(({ call }) => call?.subcommand === 'create' && !call.help && !call.web);
  if (!gitCommits.length && !prCreates.length) return null;
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  const { commit: commitFields, pullRequest: prFields, exclude } = config.attribution;
  if (!commitFields.length && !prFields.length) return null;
  const author = currentAuthor(input, env);
  if (commitFields.length) {
    const expected = expectedTrailers(commitFields, author);
    for (const { line, git } of gitCommits) {
      const carried = carriedTrailers(...commitMessage(git.rest, line, cwd));
      const missing = expected.filter((trailer) => !carried.has(trailer));
      if (missing.length) return commitReason(expected, missing);
    }
  }
  if (prFields.length) {
    for (const { line, call } of prCreates) {
      const body = readBody(call, line, cwd);
      if (body === null) continue;
      const agents = prFields.includes('agents')
        ? prAgents({ commits: commits(cwd, config.git.defaultBranch), rows: readLog(project, config).rows, sessionId: input.session_id, exclude })
        : [];
      const expected = prLines(prFields, author, agents);
      if (prMissing(body, expected).length) return prReason(expected);
    }
  }
  return null;
}

// [messages, trailers] of one `git commit`: the -m values in order, or the -F file's text, and the --trailer values.
function commitMessage(rest, line, cwd) {
  const messages = [];
  const trailers = [];
  let dynamic = false;
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
    if (kind === 'trailer') trailers.push(token.text);
    else if (kind === 'message') {
      if (token.dynamic) dynamic = true;
      else messages.push(token.text);
    } else if (!token.dynamic && token.text !== '-') {
      messages.push(readText(path.resolve(cwd, token.text)) ?? '');
    }
  }
  if (dynamic) for (const match of line.matchAll(HEREDOC)) messages.push(match[3]);
  return [messages, trailers];
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
