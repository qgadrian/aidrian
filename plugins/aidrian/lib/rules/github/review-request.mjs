// Bash rule: the review gate (lib/review-gate.mjs) for gh. Off unless config.json `github.reviewGate.enabled` is true.
// A request is:
//   - `gh pr comment`, `gh issue comment`, or `gh pr review` whose `--body` or `--body-file` asks `@codex review`;
//   - `gh api repos/<owner>/<name>/issues/<n>/comments`, sent as a POST, whose `body=` field or `--input` file asks it;
//   - `gh pr create --reviewer` or `gh pr edit --add-reviewer` naming config.json `github.reviewer`.
// `aidrian pr await-review --request` checks the gate itself, so it is not read here. Every request in a command line is
// checked, command substitutions that run included. A body the rule cannot read (stdin, a variable) is not a request;
// a request whose pull request number it cannot read is refused.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { findProject } from '../../project.mjs';
import { asksForReview, judgeRequests, markersIn, prNumber, repoName } from '../../review-gate.mjs';
import { commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';

export { OVERRIDE } from '../../review-gate.mjs';

// gh options, of the commands read here, that take the next word as their value.
const VALUE_FLAGS = new Set([
  '-b', '--body', '-F', '--body-file', '-R', '--repo', '-f', '--field', '--raw-field', '-X', '--method', '-H', '--header',
  '-q', '--jq', '-t', '--template', '--input', '-p', '--preview', '--hostname', '--cache', '-r', '--reviewer', '--add-reviewer',
  '-T', '--title', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '--add-label',
  '--remove-label', '--add-assignee', '--remove-assignee', '--remove-reviewer', '--add-project', '--remove-project',
]);

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (!config.github.reviewGate.enabled) return null;
  const read = (file) => readFileSync(path.resolve(cwd, file), 'utf8');
  const requests = [];
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) requests.push(...readRequests(readInvocation(segment), config.github.reviewer, read, env));
  }
  return judgeRequests(requests, { project, config, env });
}

// The requests in one invocation, as { pr, repo, markers }.
export function readRequests({ program, args }, reviewer, read, env = {}) {
  if (program !== 'gh') return [];
  const words = [];
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const { text } = args[i];
    const [name, inline] = splitFlag(text);
    if (name === null) words.push(args[i]);
    else flags.push({ name, value: inline ?? (VALUE_FLAGS.has(name) ? args[++i] ?? null : null) });
  }
  const last = (...names) => flags.filter((flag) => names.includes(flag.name)).at(-1)?.value ?? null;
  const literal = (token) => (token && !token.dynamic ? token.text : null);
  const repo = literal(last('-R', '--repo')) ?? env.GH_REPO ?? null;
  const [first, second, target] = words.map((token) => token.text);
  if (first === 'api') return apiRequests(words[1], flags, read, env);
  const isComment = ['pr', 'issue'].includes(first) && second === 'comment';
  if (isComment || (first === 'pr' && second === 'review')) {
    const body = bodyOf(last('-b', '--body'), last('-F', '--body-file'), read);
    if (!asksForReview(body)) return [];
    return [{ pr: prNumber(target ?? ''), repo: repo ?? (/\/(?:pull|issues)\//u.test(target ?? '') ? repoName(target) : null), markers: markersIn(body) }];
  }
  if (first === 'pr' && (second === 'create' || second === 'edit') && reviewer) {
    const named = flags.filter((flag) => ['-r', '--reviewer', '--add-reviewer'].includes(flag.name)).map((flag) => literal(flag.value) ?? '');
    const login = reviewer.replace(/\[bot\]$/u, '').toLowerCase();
    if (!named.some((value) => value.split(',').some((each) => each.trim().replace(/\[bot\]$/u, '').toLowerCase() === login))) return [];
    return [{ pr: second === 'edit' ? prNumber(target ?? '') : null, repo, markers: [] }];
  }
  return [];
}

// `gh api repos/<o>/<r>/issues/<n>/comments` sent as a POST: the bodies its `-f`/`-F body=` fields or `--input` file send.
function apiRequests(endpoint, flags, read, env) {
  const match = /(?:^|\/)repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\b/u.exec(endpoint?.text ?? '');
  const method = flags.filter((flag) => flag.name === '-X' || flag.name === '--method').at(-1)?.value?.text?.toUpperCase() ?? null;
  if (!match || (method !== null && method !== 'POST')) return [];
  const bodies = [];
  for (const { name, value } of flags) {
    const text = value?.text ?? '';
    if (name === '--input') bodies.push(jsonBody(read, text));
    else if (['-f', '--raw-field', '-F', '--field'].includes(name) && text.startsWith('body=')) {
      const content = text.slice('body='.length);
      bodies.push(['-F', '--field'].includes(name) && content.startsWith('@') ? readOrNull(read, content.slice(1)) : content);
    }
  }
  const asking = bodies.filter(asksForReview);
  if (!asking.length) return [];
  const repo = match[1].includes('{') ? env.GH_REPO ?? null : match[1];
  return [{ pr: Number(match[2]), repo, markers: asking.flatMap(markersIn) }];
}

// [name, inline value] for an option word, or [null] for a positional. `--body=x`, `-bx`, and `-b=x` carry their value.
function splitFlag(text) {
  if (text === '-' || !text.startsWith('-')) return [null];
  if (text.startsWith('--')) {
    const at = text.indexOf('=');
    return at === -1 ? [text, null] : [text.slice(0, at), { text: text.slice(at + 1), dynamic: false }];
  }
  return text.length > 2 && VALUE_FLAGS.has(text.slice(0, 2)) ? [text.slice(0, 2), { text: text.slice(2).replace(/^=/u, ''), dynamic: false }] : [text, null];
}

// The body text: an inline body (a substitution's text, heredoc included, is read as written), or a readable file.
function bodyOf(inline, file, read) {
  if (inline) return inline.text;
  if (!file || file.dynamic || file.text === '-') return null;
  return readOrNull(read, file.text);
}

function readOrNull(read, file) {
  try {
    return read(file);
  } catch {
    return null;
  }
}

function jsonBody(read, file) {
  try {
    const body = JSON.parse(read(file))?.body;
    return typeof body === 'string' ? body : null;
  } catch {
    return null;
  }
}
