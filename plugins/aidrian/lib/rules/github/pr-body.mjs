// Bash rule: a pull request body written through `gh pr create` or `gh pr edit` has a `## ` heading for every section in
// config.json `github.requiredSections`, and no "Generated with [Claude Code]" footer. `gh pr create --fill` is refused:
// gh then writes the body from the commit messages. `gh pr edit` without a body flag passes, and so does a body the
// rule cannot read (a variable, stdin, a missing file): it denies only what it reads. Runs only inside a project. A
// command substitution that runs, as in `url=$(gh pr create …)`, is read as the command line is.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.mjs';
import { findProject } from '../../project.mjs';
import { commandLines, lexCommand, readInvocation, readShortOptions } from '../../shell-lex.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PR_BODY';

const FOOTER = /Generated with \[Claude Code\]/u;
const FILL = new Set(['--fill', '--fill-first', '--fill-verbose', '-f']);
// The short options of `gh pr create` and `gh pr edit` that take a value; -d, -e, -f, and -w are switches.
const SHORT_VALUES = new Set(['-a', '-B', '-b', '-F', '-H', '-l', '-m', '-p', '-r', '-R', '-T', '-t']);
// The canonical heredoc form, `--body "$(cat <<'EOF' … EOF)"`, read from the raw command: the token holding it is
// dynamic, and its text has lost the body's quotes. -b takes it attached too, or at the end of a cluster. Group 3 is
// the body.
const BODY_HEREDOC = /(?:--body(?:=|\s+)|-[A-Za-z]*b=?\s*)"?\$\([^<]*<<-?\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b/u;

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const call = readPrCall(segment);
      if (!call) continue;
      const reason = judge(call, line, cwd);
      if (reason) return reason;
    }
  }
  return null;
}

// { subcommand, fill, body, bodyFile } for a `gh [-R repo] pr create|edit …` segment, else null. Later flags win, as in gh.
function readPrCall(segment) {
  const { program, args } = readInvocation(segment);
  if (program !== 'gh') return null;
  let i = 0;
  const words = [];
  for (; i < args.length && words.length < 2; i += 1) {
    const { text, dynamic } = args[i];
    if (dynamic) return null;
    if (text === '-R' || text === '--repo') i += 1;
    else if (!text.startsWith('-')) words.push(text);
  }
  if (words[0] !== 'pr' || !['create', 'edit'].includes(words[1])) return null;
  const call = { subcommand: words[1], fill: false, body: null, bodyFile: null };
  for (; i < args.length; i += 1) {
    const { text, dynamic } = args[i];
    let [flag, inline] = text.startsWith('--') && text.includes('=') ? [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)] : [text, null];
    if (/^-[^-]/u.test(text)) {
      // A short word as gh reads it: `-dF body.md`, `-Fbody.md`, and `-F=body.md`.
      const { options, value } = readShortOptions(text, SHORT_VALUES);
      if (options.includes('-f')) call.fill = true;
      if (!value) continue;
      [flag, inline] = [value.option, value.attached?.replace(/^=/u, '') ?? null];
    }
    const value = () => (inline !== null ? { text: inline, dynamic } : args[++i] ?? null);
    if (FILL.has(flag)) call.fill = true;
    else if (flag === '--body' || flag === '-b') [call.body, call.bodyFile] = [value(), null];
    else if (flag === '--body-file' || flag === '-F') [call.bodyFile, call.body] = [value(), null];
    else if (SHORT_VALUES.has(flag)) value();
  }
  return call;
}

function judge(call, command, cwd) {
  const project = findProject(cwd);
  if (!project) return null;
  const { config } = loadConfig(project);
  if (call.fill && call.subcommand === 'create') {
    return deny(`\`--fill\` writes the body from the commit messages, without the sections config.json \`github.requiredSections\` asks for. ` +
      'Write the body to a file and pass --body-file (the pr-write skill does).');
  }
  const body = readBody(call, command, cwd);
  if (body === null) return null;
  if (FOOTER.test(body)) return deny('the body carries the "Generated with [Claude Code]" footer. Remove that line.');
  const missing = config.github.requiredSections.filter((section) => !hasSection(body, section));
  if (!missing.length) return null;
  return deny(`the body has no ${missing.map((section) => `\`## ${section}\``).join(', ')} section. ` +
    `config.json \`github.requiredSections\` lists the sections every body has: ${config.github.requiredSections.join(', ')}. ` +
    'Write the body with the pr-write skill.');
}

// The body text, or null when this rule cannot know it.
function readBody(call, command, cwd) {
  if (call.body) return call.body.dynamic ? BODY_HEREDOC.exec(command)?.[3] ?? null : call.body.text;
  if (!call.bodyFile || call.bodyFile.dynamic || call.bodyFile.text === '-') return null;
  try {
    return readFileSync(path.resolve(cwd, call.bodyFile.text), 'utf8');
  } catch {
    return null;
  }
}

function hasSection(body, section) {
  const wanted = section.trim().toLowerCase();
  return body.split('\n').some((line) => /^##\s/u.test(line) && line.slice(2).trim().toLowerCase() === wanted);
}

function deny(problem) {
  return `Blocked: ${problem}\nTo override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
