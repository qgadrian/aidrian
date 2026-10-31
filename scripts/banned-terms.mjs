#!/usr/bin/env node
// Private words (source projects, their tracker keys, people) never leave this checkout: not in a tracked file, and not
// in what git and GitHub keep beside the files, which `npm run check` never reads. The patterns are the public ones below
// plus the git-ignored `.banned-terms.local`, one case-insensitive regular expression per line, `#` for a comment.
// The brackets keep this file from matching its own patterns.
//
//   node scripts/banned-terms.mjs commit-msg <file>   git commit-msg hook: the message
//   node scripts/banned-terms.mjs pre-push            git pre-push hook: each pushed branch name and new commit message
//   node scripts/banned-terms.mjs claude-hook         Claude Code PreToolUse Bash hook: a gh pr/issue command's text,
//                                                     title, and body file, and a git commit's message
//
// `make hooks` installs the git hooks; the Claude Code hook goes in the git-ignored `.claude/settings.json`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = [];

export function bannedPatterns(root = ROOT) {
  const file = path.join(root, '.banned-terms.local');
  const local = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
      .map((line) => new RegExp(line, 'iu'))
    : [];
  return [...PUBLIC, ...local];
}

// The patterns `text` matches, as strings.
export function bannedHits(text, patterns = bannedPatterns()) {
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

// The body files a command names: `--body-file x`, `--body-file=x`, `-F x`. `-` (stdin) and variables are left out.
export function bodyFiles(command) {
  const files = [];
  for (const match of command.matchAll(/(?:--body-file(?:=|\s+)|\s-F\s*)(?:'([^']*)'|"([^"$`]*)"|([^\s'"$`;&|]+))/gu)) {
    const file = match[1] ?? match[2] ?? match[3];
    if (file && file !== '-') files.push(file);
  }
  return files;
}

// The deny reason for a Bash command, or null. Only commands whose text GitHub or git keeps are read.
export function judgeCommand(command, { cwd = process.cwd(), patterns = bannedPatterns() } = {}) {
  if (!/\bgh\s+(?:-R\s+\S+\s+)?(?:pr|issue)\b|\bgit\b[^\n;&|]*\bcommit\b/u.test(command)) return null;
  const cdTo = /^\s*cd\s+([^\s;&|$`'"~]+)\s*(?:&&|;)/u.exec(command)?.[1];
  const base = cdTo ? path.resolve(cwd, cdTo) : cwd;
  const found = new Set(bannedHits(command, patterns));
  for (const file of bodyFiles(command)) {
    try {
      for (const hit of bannedHits(readFileSync(path.resolve(base, file), 'utf8'), patterns)) found.add(`${hit} in ${file}`);
    } catch {
      // A body file that cannot be read is gh's error to report.
    }
  }
  return found.size ? `names a private word (${[...found].join(', ')}); see .banned-terms.local. Reword it.` : null;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function main([mode, file]) {
  if (mode === 'commit-msg') {
    const hits = bannedHits(readFileSync(file, 'utf8').replace(/^#.*$/gmu, ''));
    if (!hits.length) return 0;
    console.error(`commit message names a private word (${hits.join(', ')}); see .banned-terms.local.`);
    return 1;
  }
  if (mode === 'pre-push') {
    const problems = [];
    for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      const [localRef, localSha, remoteRef] = line.split(' ');
      if (/^0+$/u.test(localSha)) continue;
      for (const ref of new Set([localRef, remoteRef])) {
        for (const hit of bannedHits(ref)) problems.push(`branch ${ref}: ${hit}`);
      }
      for (const sha of git(['rev-list', localSha, '--not', '--remotes']).split('\n').filter(Boolean)) {
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
