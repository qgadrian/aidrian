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

import { GIT_VALUE_GLOBALS, isLongOption, readShortOptions, walkCommands } from '../plugins/aidrian/lib/shell-lex.mjs';

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

// The gh pr and issue subcommands that only read: nothing they take is published.
const READS = new Set(['view', 'list', 'status', 'checks', 'diff', 'checkout']);
// The short options that take a value, of gh pr/issue and of git commit.
const GH_VALUES = new Set(['-a', '-B', '-b', '-F', '-H', '-l', '-m', '-p', '-r', '-R', '-T', '-t']);
const GIT_VALUES = new Set(['-m', '-F', '-C', '-c', '-t']);
// The long options whose value is the next word, so a value shaped like an option (`--title -Rx`) is never read as one.
const GH_LONG_VALUES = new Set([
  '--title', '--body', '--label', '--assignee', '--milestone', '--project', '--reviewer', '--base', '--head', '--template',
  '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer',
  '--add-project', '--remove-project', '--subject', '--comment', '--recover',
]);
// git commit's long options that take a value, each with its shortest unambiguous prefix: git takes any prefix from
// there on (`--fil` is `--file`, `--mess` is `--message`); gh (pflag) takes only the whole name.
const GIT_LONG = new Map([
  ['--file', '--fil'], ['--message', '--me'], ['--author', '--au'], ['--date', '--da'], ['--template', '--te'],
  ['--reuse-message', '--reu'], ['--reedit-message', '--ree'], ['--fixup', '--fix'], ['--squash', '--sq'],
  ['--trailer', '--tr'], ['--cleanup', '--cl'],
]);
const GIT_LONG_VALUES = new Set([...GIT_LONG.keys()].filter((option) => option !== '--file'));

// A git long option word with its option spelled in full, `=value` kept; any other word as it is.
function gitLongWord(text) {
  if (!text.startsWith('--') || text === '--') return text;
  const option = [...GIT_LONG].find(([name, shortest]) => isLongOption(text, name, shortest))?.[0];
  return option ? option + (text.includes('=') ? text.slice(text.indexOf('=')) : '') : text;
}

// What an invocation publishes, as { words, files }: the arguments git or GitHub keep (titles, bodies, messages,
// labels), and the files whose contents it publishes (`--body-file`, `--file`, `-F`), as tokens. null for an invocation
// that publishes nothing: anything but gh pr/issue (other than a read) and git commit.
export function published({ program, args }) {
  const texts = args.map((token) => token.text);
  let start;
  let fileFlag;
  let values;
  let longValues;
  if (program === 'gh') {
    const words = [];
    let i = 0;
    for (; i < args.length && words.length < 2; i += 1) {
      if (texts[i] === '-R' || texts[i] === '--repo') i += 1;
      else if (!texts[i].startsWith('-')) words.push(texts[i]);
    }
    if (!['pr', 'issue'].includes(words[0]) || !words[1] || READS.has(words[1])) return null;
    [start, fileFlag, values, longValues] = [i, '--body-file', GH_VALUES, GH_LONG_VALUES];
  } else if (program === 'git') {
    let i = 0;
    for (; i < args.length && texts[i].startsWith('-'); i += 1) if (GIT_VALUE_GLOBALS.has(texts[i])) i += 1;
    if (texts[i] !== 'commit') return null;
    [start, fileFlag, values, longValues] = [i + 1, '--file', GIT_VALUES, GIT_LONG_VALUES];
  } else {
    return null;
  }
  const rest = args.slice(start);
  const words = [];
  const files = [];
  for (let i = 0; i < rest.length; i += 1) {
    const { dynamic } = rest[i];
    const text = program === 'git' && !dynamic ? gitLongWord(rest[i].text) : rest[i].text;
    if (text === '--') {
      words.push(...rest.slice(i + 1));
      break;
    }
    if (text === fileFlag || text.startsWith(`${fileFlag}=`)) {
      files.push(text === fileFlag ? rest[++i] : { text: text.slice(fileFlag.length + 1), dynamic });
      continue;
    }
    if (text === '--repo' || text.startsWith('--repo=')) {
      if (text === '--repo') i += 1;
      continue;
    }
    // A value is published as it is, whatever its shape: it is never read as one more option.
    if (longValues.has(text)) {
      if (rest[i + 1]) words.push(rest[++i]);
      continue;
    }
    if (/^-[^-]/u.test(text) && !dynamic) {
      const { value } = readShortOptions(text, values);
      if (value) {
        // gh (pflag) reads `-F=x` as x; git keeps the `=`, as a file named `=x`.
        const attached = program === 'gh' ? value.attached?.replace(/^=/u, '') : value.attached;
        const operand = value.attached === null ? rest[++i] : { text: attached, dynamic };
        if (value.option === '-F') files.push(operand);
        else if (value.option !== '-R' && operand) words.push(operand);
        continue;
      }
    }
    words.push(rest[i]);
  }
  return { words, files: files.filter(Boolean) };
}

// The deny reason for a Bash command, or null. Only what a gh pr/issue or git commit invocation publishes is read, in
// substitutions and inline shells too (shell-lex `walkCommands`): its arguments, its body or message file's contents,
// and for `-F -` the heredoc or here-string on its input; never its file paths (a home or temp path names the user). A
// relative file in a folder a `cd` hides is refused, since it cannot be checked.
export function judgeCommand(command, { cwd = process.cwd(), patterns = bannedPatterns() } = {}) {
  const found = new Set();
  for (const { invocation, folder, inputs } of walkCommands(command, cwd)) {
    const what = published(invocation);
    if (!what) continue;
    for (const hit of bannedHits(what.words.map((token) => token.text).join('\n'), patterns)) found.add(hit);
    for (const { text, dynamic } of what.files) {
      if (text === '-') {
        for (const hit of bannedHits(inputs.join('\n'), patterns)) found.add(`${hit} on its input`);
        continue;
      }
      if (dynamic) continue;
      if (folder === null && !path.isAbsolute(text)) {
        found.add(`the unchecked file ${text}: a cd on the line hides its folder, so pass an absolute path`);
        continue;
      }
      // Joined, not resolved: the filesystem follows a symlink before a `..`, as gh and git open the operand.
      try {
        for (const hit of bannedHits(readFileSync(path.isAbsolute(text) ? text : `${folder}/${text}`, 'utf8'), patterns)) found.add(`${hit} in ${text}`);
      } catch {
        // A file that cannot be read is gh's or git's error to report.
      }
    }
  }
  return found.size ? `names a private word or an unchecked file (${[...found].join('; ')}); see .banned-terms.local.` : null;
}

// The problems of a push: git's pre-push input `lines` ("<local ref> <local sha> <remote ref> <remote sha>") to the remote
// `remote`. A pushed branch name is read, and each commit message the destination does not have yet: commits reachable
// from another remote's branches still count, since that remote may be private.
export function prePushProblems(lines, remote, { cwd = ROOT, patterns = bannedPatterns(cwd) } = {}) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const known = (sha) => {
    if (!sha || /^0+$/u.test(sha)) return false;
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  const problems = [];
  for (const line of lines.split('\n').filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
    if (/^0+$/u.test(localSha)) continue;
    for (const ref of new Set([localRef, remoteRef])) {
      for (const hit of bannedHits(ref, patterns)) problems.push(`branch ${ref}: ${hit}`);
    }
    const exclude = [`--remotes=${remote}`, ...(known(remoteSha) ? [remoteSha] : [])];
    for (const sha of git(['rev-list', localSha, '--not', ...exclude]).split('\n').filter(Boolean)) {
      for (const hit of bannedHits(git(['log', '-1', '--format=%B', sha]), patterns)) problems.push(`commit ${sha.slice(0, 12)}: ${hit}`);
    }
  }
  return problems;
}

// `file` is the message file for commit-msg, and the push remote's name for pre-push, as the git hooks pass them.
function main([mode, file]) {
  if (mode === 'commit-msg') {
    // The whole file: which `#` lines and scissors text git strips depends on --cleanup and the editor, which this hook
    // cannot see, so nothing is assumed stripped.
    const hits = bannedHits(readFileSync(file, 'utf8'));
    if (!hits.length) return 0;
    console.error(`commit message names a private word (${hits.join(', ')}); see .banned-terms.local.`);
    return 1;
  }
  if (mode === 'pre-push') {
    const problems = prePushProblems(readFileSync(0, 'utf8'), file);
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
  console.error('usage: banned-terms.mjs commit-msg <file> | pre-push <remote> | claude-hook');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2));
