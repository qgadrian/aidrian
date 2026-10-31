#!/usr/bin/env node
// Private words (source projects, their tracker keys, people) never leave this checkout: not in a tracked file, and not
// in what git and GitHub keep beside the files, which `npm run check` never reads. The patterns are the public ones below
// plus the git-ignored `.banned-terms.local`, one case-insensitive regular expression per line, `#` for a comment.
// The brackets keep this file from matching its own patterns.
//
//   node scripts/banned-terms.mjs commit-msg <file>   git commit-msg hook: the message
//   node scripts/banned-terms.mjs pre-push <remote>   git pre-push hook: each pushed branch name, and each commit message
//                                                     the destination remote does not have yet
//   node scripts/banned-terms.mjs claude-hook         Claude Code PreToolUse Bash hook: a gh pr/issue command's text,
//                                                     title, and body file, and a git commit's message
//
// `make hooks` installs the git hooks; the Claude Code hook goes in the git-ignored `.claude/settings.json`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = [];

// The public patterns and those of `.banned-terms.local`, read from `root` and from the main checkout: the file is
// git-ignored, so a linked worktree has no copy of its own.
export function bannedPatterns(root = ROOT) {
  const roots = new Set([root, mainCheckout(root)].filter(Boolean));
  const local = [...roots].map((dir) => path.join(dir, '.banned-terms.local')).filter((file) => existsSync(file))
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  return [...PUBLIC, ...[...new Set(local)].map((line) => new RegExp(line, 'iu'))];
}

function mainCheckout(root) {
  try {
    return path.dirname(path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));
  } catch {
    return null;
  }
}

// The patterns `text` matches, as strings.
export function bannedHits(text, patterns = bannedPatterns()) {
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

// The body files a command names, with the operand as written: `--body-file x`, `--body-file=x`, `-F x`, `-F=x`, `-Fx`,
// and a short cluster such as `-dF x`. `-` (stdin) and variables are left out.
const BODY_FILE = /(?:--body-file(?:=|\s+)|(?<=\s)-[A-Za-z]*F(?:=|\s*))('([^']*)'|"([^"$`]*)"|([^\s'"$`;&|)]+))/gu;
export function bodyFiles(command) {
  return [...command.matchAll(BODY_FILE)].map((match) => ({ operand: match[1], file: match[2] ?? match[3] ?? match[4] }))
    .filter(({ file }) => file && file !== '-');
}

// The deny reason for a Bash command, or null. Only gh pr/issue and git commit commands are read: their text is what
// GitHub and git keep. The operands that name files read, never published (a body file, a leading `cd` target), are
// left out of the text, since a home or temp path names the user; a body file's contents are read instead.
export function judgeCommand(command, { cwd = process.cwd(), patterns = bannedPatterns() } = {}) {
  if (!/\bgh\b[^\n;&|]*\b(?:pr|issue)\b|\bgit\b[^\n;&|]*\bcommit\b/u.test(command)) return null;
  const cd = /^\s*cd\s+([^\s;&|$`'"~()]+)\s*&&/u.exec(command);
  const base = cd ? path.resolve(cwd, cd[1]) : cwd;
  let text = cd ? command.replace(cd[1], '<path>') : command;
  const files = bodyFiles(command);
  for (const { operand } of files) text = text.replace(operand, '<path>');
  const found = new Set(bannedHits(text, patterns));
  for (const { file } of files) {
    try {
      for (const hit of bannedHits(readFileSync(path.resolve(base, file), 'utf8'), patterns)) found.add(`${hit} in ${file}`);
    } catch {
      // A body file that cannot be read is gh's error to report.
    }
  }
  return found.size ? `names a private word (${[...found].join(', ')}); see .banned-terms.local. Reword it.` : null;
}

// Whether `sha` is a commit this clone has: the destination's advertised head, when the push does not replace a fetch.
function known(sha) {
  if (!sha || /^0+$/u.test(sha)) return false;
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function main([mode, file, remote]) {
  if (mode === 'commit-msg') {
    // Git keeps `#` lines with -m, -F, or --cleanup=verbatim, so only a verbose commit's diff below the scissors is skipped.
    const hits = bannedHits(readFileSync(file, 'utf8').split(/^# -+ >8 -+$/mu)[0]);
    if (!hits.length) return 0;
    console.error(`commit message names a private word (${hits.join(', ')}); see .banned-terms.local.`);
    return 1;
  }
  if (mode === 'pre-push') {
    const problems = [];
    for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
      if (/^0+$/u.test(localSha)) continue;
      for (const ref of new Set([localRef, remoteRef])) {
        for (const hit of bannedHits(ref)) problems.push(`branch ${ref}: ${hit}`);
      }
      for (const sha of git(['rev-list', localSha, '--not', `--remotes=${remote}`, ...(known(remoteSha) ? [remoteSha] : [])]).split('\n').filter(Boolean)) {
        for (const hit of bannedHits(git(['log', '-1', '--format=%B', sha]))) problems.push(`commit ${sha.slice(0, 12)}: ${hit}`);
      }
    }
    if (!problems.length) return 0;
    console.error(`push names a private word; see .banned-terms.local:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  if (mode === 'claude-hook') {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const reason = judgeCommand(input.tool_input?.command ?? '', { cwd: input.cwd ?? process.cwd() });
    if (reason) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked: the command ${reason}` },
      }));
    }
    return 0;
  }
  console.error('usage: banned-terms.mjs commit-msg <file> | pre-push | claude-hook');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2));
