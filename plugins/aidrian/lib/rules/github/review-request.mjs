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
import { commandLines, lexCommand, readInvocation, readShortOptions } from '../../shell-lex.mjs';

export { OVERRIDE } from '../../review-gate.mjs';

// The options that take a value, per command read here, from each command's `--help`: a switch such as `gh pr review -r`
// (--request-changes) must not swallow the word after it. -R and --repo take one everywhere.
const BODY = ['-b', '--body', '-F', '--body-file'];
const VALUE_FLAGS = {
  comment: BODY,
  review: BODY,
  create: [...BODY, '-a', '--assignee', '-B', '--base', '-H', '--head', '-l', '--label', '-m', '--milestone', '-p', '--project',
    '-r', '--reviewer', '-t', '--title', '-T', '--template', '--recover'],
  edit: [...BODY, '-B', '--base', '-t', '--title', '-m', '--milestone', '--add-assignee', '--remove-assignee', '--add-label',
    '--remove-label', '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer'],
  api: ['-f', '--raw-field', '-F', '--field', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--input',
    '-p', '--preview', '--hostname', '--cache'],
};
const ROOT = ['-R', '--repo'];

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
export function readRequests({ program, args, environment = [] }, reviewer, read, env = {}) {
  if (program !== 'gh') return [];
  const command = commandPath(args);
  const key = command[0] === 'api' ? 'api' : command[1];
  if (!Object.hasOwn(VALUE_FLAGS, key)) return [];
  const { words, flags } = readWords(args, new Set([...ROOT, ...VALUE_FLAGS[key]]));
  const last = (...names) => flags.filter((flag) => names.includes(flag.name)).at(-1)?.value ?? null;
  const literal = (token) => (token && !token.dynamic ? token.text : null);
  const ghRepo = invocationRepo(environment, env);
  const [first, second, target] = words.map((token) => token.text);
  // -R names the repository; else a pull request or issue URL does; else GH_REPO, which gh reads only without either.
  const urlRepo = /\/(?:pull|issues)\//u.test(target ?? '') ? repoName(target) : null;
  // An -R the rule cannot read (`-R "$R"`) may name this repository: it counts as this one.
  const flagRepo = last('-R', '--repo');
  const targetRepo = flagRepo ? literal(flagRepo) : urlRepo ?? ghRepo;
  if (first === 'api') return apiRequests(words[1], flags, read, ghRepo);
  const isComment = ['pr', 'issue'].includes(first) && second === 'comment';
  if (isComment || (first === 'pr' && second === 'review')) {
    const body = bodyOf(last('-b', '--body'), last('-F', '--body-file'), read);
    if (!asksForReview(body)) return [];
    return [{ pr: prNumber(target ?? ''), repo: targetRepo, markers: markersIn(body) }];
  }
  if (first === 'pr' && (second === 'create' || second === 'edit') && reviewer) {
    const named = flags.filter((flag) => ['-r', '--reviewer', '--add-reviewer'].includes(flag.name)).map((flag) => literal(flag.value) ?? '');
    const login = reviewer.replace(/\[bot\]$/u, '').toLowerCase();
    if (!named.some((value) => value.split(',').some((each) => each.trim().replace(/\[bot\]$/u, '').toLowerCase() === login))) return [];
    return [{ pr: second === 'edit' ? prNumber(target ?? '') : null, repo: targetRepo, markers: [] }];
  }
  return [];
}

// `gh api repos/<o>/<r>/issues/<n>/comments` sent as a POST: the bodies its `-f`/`-F body=` fields or `--input` file send.
function apiRequests(endpoint, flags, read, ghRepo) {
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
  // gh fills `{owner}` and `{repo}` from GH_REPO, or from this repository without it, and leaves literal parts alone.
  const [owner, name] = (ghRepo ?? '').split('/');
  const repo = !match[1].includes('{') ? match[1]
    : ghRepo ? match[1].replaceAll('{owner}', owner).replaceAll('{repo}', name) : null;
  return [{ pr: Number(match[2]), repo, markers: asking.flatMap(markersIn) }];
}

// The command words of a gh command line, read as gh finds its command before it knows the command's options: an
// option word without `=`, other than a switch every command has, takes the next word as its value, wherever it is.
// So `gh pr -b x comment 5` is `pr comment`.
const SWITCHES = new Set(['-h', '--help', '--version']);
function commandPath(args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i += 1) {
    const { text } = args[i];
    if (text === '--') break;
    if (text === '-' || !text.startsWith('-')) words.push(text);
    else if (!SWITCHES.has(text) && !text.includes('=') && (text.startsWith('--') || text.length === 2)) i += 1;
  }
  return words;
}

// The repository GH_REPO names for this invocation, after its assignments and env changes (`GH_REPO=x gh`,
// `env -u GH_REPO gh`, `env -i gh`), or null for this repository. A value the rule cannot read is this repository.
function invocationRepo(environment, env) {
  let repo = env.GH_REPO ?? null;
  for (const change of environment) {
    if (change.clear) repo = null;
    else if (change.name === 'GH_REPO') repo = change.value && !change.value.dynamic ? change.value.text : null;
  }
  // GH_REPO is `[HOST/]OWNER/REPO`.
  return repo ? repoName(repo) ?? repo : null;
}

// The positional words and the options of a gh command line, as gh reads them with `values` taking a value: `--x=v`,
// `--x v`, `-xv`, `-x=v`, `-x v`, and a cluster of switches ending in one that takes a value, `-cb v`.
function readWords(args, values) {
  const words = [];
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    if (text === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (text === '-' || !text.startsWith('-')) words.push(args[i]);
    else if (text.startsWith('--')) {
      const at = text.indexOf('=');
      const name = at === -1 ? text : text.slice(0, at);
      flags.push({ name, value: at !== -1 ? { text: text.slice(at + 1), dynamic } : values.has(name) ? args[++i] ?? null : null });
    } else {
      const { options, value } = readShortOptions(text, values);
      for (const name of options) if (name !== value?.option) flags.push({ name, value: null });
      if (value) flags.push({ name: value.option, value: value.attached !== null ? { text: value.attached.replace(/^=/u, ''), dynamic } : args[++i] ?? null });
    }
  }
  return { words, flags };
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
