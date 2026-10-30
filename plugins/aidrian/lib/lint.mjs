// `aidrian lint`: checks that keep a project's AI instructions cheap and portable. Limits come from config.json,
// except the SKILL.md size, which is Codex's.
//   skills  every <dir>/<name>/SKILL.md: a one-line YAML `description` within skills.descriptionChars, all skill
//           names and descriptions within skills.listingBytes (both hosts list them in every session), and a file
//           under SKILL_CUT_BYTES, with a warning above SKILL_WARN_BYTES
//   agents  every <dir>/*.md: `name` equals the file name, a `description` like a skill's, and a known model and effort
//   paths   tracked files hold no personal home folder such as /Users/<name>/; --staged reads what the index holds
//   budget  the knowledge budgets that `aidrian check` also runs: the `always` docs and each tagged doc (knowledge.mjs)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, isDirectory, isFile } from './config.mjs';
import { runGit } from './git.mjs';
import { checkBudgets, loadKnowledge } from './knowledge.mjs';
import { projectAt } from './project.mjs';

const KINDS = ['skills', 'agents', 'paths', 'budget'];
const MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable', 'inherit']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Home folders of placeholder or CI users are not personal.
const PERSONAL_PATH = /\/(?:Users|home)\/(?!(?:runner|you|user|example)\/)[A-Za-z_][A-Za-z0-9_.-]*\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|otf|pdf|zip|gz|tar|tgz|mp[34]|wav|ogg)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;
// Codex cuts a SKILL.md longer than 8,000 bytes when it loads it: MAX_SKILL_PROMPT_BYTES in
// codex-rs/ext/skills/src/render.rs. A file at the cut has no room left, so it fails there; the warning leaves a margin.
const SKILL_CUT_BYTES = 8000;
const SKILL_WARN_BYTES = 7500;
// Room for one staged file read through git: Node's default 1 MiB would leave a larger file unread.
const STAGED_MAX_BYTES = 64 * 1024 * 1024;

export const commands = {
  lint: {
    usage: '[skills|agents|paths|budget] [DIR...] [--staged] [--project DIR]',
    about: 'lint skills, agents, personal paths, and the knowledge budgets; DIR replaces .claude/skills or .claude/agents',
    run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, staged: { type: 'boolean' } } });
      const [kind, ...dirs] = positionals;
      if (kind !== undefined && !KINDS.includes(kind)) {
        console.error(`unknown lint: ${kind}; use one of ${KINDS.join(', ')}`);
        return 1;
      }
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      const { buckets } = loadKnowledge(project);
      const at = (rel) => path.join(project.root, rel);
      const runs = {
        skills: () => lintSkills(dirs.length ? dirs : [at('.claude/skills')], config.skills),
        agents: () => lintAgents(dirs.length ? dirs : [at('.claude/agents')], config.skills),
        paths: () => lintPaths(project.root, values.staged),
        budget: () => checkBudgets(project.root, buckets, config.knowledge.budgets),
      };
      const results = (kind ? [kind] : KINDS).map((name) => [name, runs[name]()]);
      for (const [name, { problems, warnings = [], summary }] of results) {
        if (warnings.length) console.error(warnings.map((warning) => `${name}: warning: ${warning}`).join('\n'));
        if (problems.length) console.error(problems.map((problem) => `${name}: ${problem}`).join('\n'));
        else console.log(`${name}: ${summary}`);
      }
      return results.some(([, { problems }]) => problems.length) ? 1 : 0;
    },
  },
};

export function lintSkills(dirs, { descriptionChars, listingBytes }) {
  const problems = [];
  const warnings = [];
  const move = 'move detail into references/ or steps/ files that SKILL.md names';
  let bytes = 0;
  let count = 0;
  for (const dir of dirs.filter(isDirectory)) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!isFile(file)) continue;
      count += 1;
      const size = statSync(file).size;
      if (size >= SKILL_CUT_BYTES) problems.push(`${file}: ${size} bytes; Codex cuts a SKILL.md at ${SKILL_CUT_BYTES}, so ${move}`);
      else if (size > SKILL_WARN_BYTES) warnings.push(`${file}: ${size} bytes, near Codex's ${SKILL_CUT_BYTES}-byte cut; ${move}`);
      const meta = frontmatter(readFileSync(file, 'utf8'));
      const description = checkDescription(meta, file, descriptionChars, problems);
      if (description === null) continue;
      if (meta['disable-model-invocation'] === 'true' && meta['user-invocable'] === 'false') {
        problems.push(`${file}: disable-model-invocation true and user-invocable false leave nobody able to run it`);
      }
      bytes += Buffer.byteLength(meta.name ?? name) + Buffer.byteLength(description);
    }
  }
  if (bytes > listingBytes) {
    problems.push(`the ${count} skills list ${bytes} bytes of names and descriptions; the limit is skills.listingBytes, ${listingBytes}`);
  }
  return { problems, warnings, summary: `${count} skills, ${bytes} of ${listingBytes} listing bytes` };
}

export function lintAgents(dirs, { descriptionChars }) {
  const problems = [];
  let count = 0;
  for (const dir of dirs.filter(isDirectory)) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.md')).sort()) {
      const file = path.join(dir, name);
      count += 1;
      const meta = frontmatter(readFileSync(file, 'utf8'));
      if (checkDescription(meta, file, descriptionChars, problems) === null) continue;
      if (meta.name !== name.slice(0, -3)) problems.push(`${file}: name must be "${name.slice(0, -3)}", the file name`);
      if (meta.model !== undefined && !MODELS.has(meta.model) && !/^claude-[a-z0-9.-]+$/.test(meta.model)) {
        problems.push(`${file}: model "${meta.model}" is not one of ${[...MODELS].join(', ')}, or a claude-* model id`);
      }
      if (meta.effort !== undefined && !EFFORTS.has(meta.effort)) problems.push(`${file}: effort "${meta.effort}" is not one of ${[...EFFORTS].join(', ')}`);
    }
  }
  return { problems, summary: `${count} agents` };
}

export function lintPaths(root, staged = false) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  const { status, stdout } = runGit(args, root);
  if (status !== 0) return { problems: [`git ${args[0]} failed in ${root}`], summary: '' };
  const files = stdout.split('\0').filter((file) => file && !BINARY.test(file));
  const problems = [];
  for (const file of files) {
    const text = staged ? stagedText(root, file) : workingText(root, file);
    if (text === null || text.includes('\0')) continue; // an unreadable file holds nothing to report
    text.split('\n').forEach((line, index) => {
      if (PERSONAL_PATH.test(line)) problems.push(`${file}:${index + 1}: a personal home folder: ${line.trim().slice(0, 120)}`);
    });
  }
  return { problems, summary: `no personal paths in ${files.length} ${staged ? 'staged' : 'tracked'} files` };
}

function workingText(root, file) {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

// The file as the index holds it, which is what a commit takes: a later unstaged edit or deletion does not change it.
function stagedText(root, file) {
  const { status, stdout } = runGit(['show', `:${file}`], root, { maxBuffer: STAGED_MAX_BYTES });
  return status === 0 ? stdout : null;
}

// The checked description of an agent or skill, or null after adding the problem.
function checkDescription(meta, file, limit, problems) {
  if (meta === null) {
    problems.push(`${file}: no YAML frontmatter`);
    return null;
  }
  const decoded = decodeScalar(meta.description ?? '');
  const problem =
    meta.description === undefined ? 'no description'
      : decoded.problem ? `description is not a one-line YAML string: ${decoded.problem}`
      : meta.descriptionContinues ? 'description continues on another line, which hides its length; keep it on one line'
      : decoded.value.trim() === '' ? 'description is empty'
      : decoded.value.length > limit ? `description is ${decoded.value.length} characters; the limit is ${limit}`
      : null;
  if (problem) problems.push(`${file}: ${problem}`);
  return problem ? null : decoded.value;
}

// The top-level `key: value` lines of a YAML frontmatter block, or null without one. `descriptionContinues` is true when
// an indented line follows `description:`, which YAML folds into the value.
export function frontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) return null;
  const meta = { descriptionContinues: false };
  let key = null;
  for (const line of block.split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      meta[key] = field[2].trim();
    } else if (key === 'description' && line.trim() !== '' && !line.startsWith('#')) {
      meta.descriptionContinues = true;
    }
  }
  return meta;
}

// A YAML scalar as a strict loader reads it: { value } or { problem }. Plain, double-quoted, or single-quoted only.
export function decodeScalar(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { problem: 'unterminated double-quoted string' };
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { problem: 'an escape this check cannot read; use a plain string' };
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) return { problem: 'unterminated single-quoted string' };
    const inner = raw.slice(1, -1);
    if (/(^|[^'])'([^']|$)/.test(inner)) return { problem: "a lone ' inside single quotes; write it as ''" };
    return { value: inner.replace(/''/g, "'") };
  }
  if (/^[,[\]{}#&*!|>%@`]/.test(raw) || /^[-?:](\s|$)/.test(raw)) return { problem: `a plain string cannot start with "${raw[0]}"; quote it` };
  if (raw.includes(': ') || raw.endsWith(':')) return { problem: 'a plain string cannot hold ": " or end with ":"; quote it or use " — "' };
  if (raw.includes(' #')) return { problem: 'a plain string cannot hold " #", which starts a comment; quote it' };
  if (/^(~|null|true|false|yes|no|on|off|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|[-+]?\.inf|\.nan|0o[0-7]+|0x[0-9a-f]+|\d{4}-\d\d?-\d\d?([Tt ].*)?)$/i.test(raw)) {
    return { problem: `"${raw}" reads as null, a boolean, a number, or a date; quote it` };
  }
  return { value: raw };
}
