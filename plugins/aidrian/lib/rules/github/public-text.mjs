// Bash rule: the text of `gh issue create|edit|comment|close|reopen` and `gh pr create|edit|comment|close|reopen|merge` matches none of config.json
// `github.publicText.patterns`, and none of the private words of the git-ignored `.banned-terms.local` (lib/banned-terms.mjs),
// each a case-insensitive regular expression. Stopping it before the first post is the point: GitHub keeps the old text
// of an edited issue, pull request, or comment in a public edit history that no API deletes.
//
// With neither giving a pattern, the default, the rule is off: it reads only the config and looks for that file, and it
// looks up no remotes and reads no body. A project opting in is the signal: the
// rule asks nothing about the repository's visibility. Body and title are read as the pull request body rule reads them
// (pr-body `bodyCalls`). Private words stay private wherever a call posts, so readable text answers to them even on a call
// naming another repository; the config patterns and the unread-text refusals answer to the repository the call targets
// (`targetsAnotherRepo`).
//
// A deny names a config pattern and never echoes the text around the match, since the dispatch log records its first
// sentence. A hit from the private file names neither the word nor its pattern, only the file and where it matched.
// With any pattern, a body or a title the rule cannot read is refused, and so is a call whose text comes from an
// editor, a prompt, a template, or the commit messages. Only `--web`, where a person posts from the browser, a dry run,
// help, and `--delete-last` go without a body; close, reopen, merge, and an edit post none unless given one. Each run of
// whitespace counts as one space, so a wrapped phrase matches. This reads wording only; docs/hooks.md says what it cannot catch.
//
// Patterns run under one time budget per command (lib/bounded-regexp.mjs). One that runs out is dropped, as a bad line is.
// Private words run first, on every call of the command, so slow config patterns can never use up their time.

import { BANNED_FILE, usableBannedLines } from '../../banned-terms.mjs';
import { boundedSearch, timeBudget } from '../../bounded-regexp.mjs';
import { loadConfig } from '../../config.mjs';
import { findProject } from '../../project.mjs';
import { bodyCalls, bodyFilePath, readBody, readBodyCall, stateFolder, targetsAnotherRepo, TEXT_HEREDOC, twoSteps } from './pr-body.mjs';
import { invocationRepo } from './review-request.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PUBLIC_TEXT';

const KEY = 'config.json `github.publicText.patterns`';
const UNCHECKED = 'the public text patterns go unchecked';
const FLAGS = 'iu';
// The time for all of a command's patterns, and for one search of one. The hook has 5 s, and a later rule may wait 3 s on
// gh, so the budget ends 2 s into the process, but always leaves one search.
const BUDGET_MS = 600;
const SLICE_MS = 200;
const LATEST_END_MS = 2000;
const SHOWN_PATTERN = 80;

const isClosing = (call) => ['close', 'reopen'].includes(call.subcommand);
// What the deny calls the text: `--comment` and `--subject` carry it on those commands.
const bodyName = (call) => (isClosing(call) ? 'comment' : 'body');
const titleName = (call) => (call.subcommand === 'merge' ? 'subject' : 'title');
const flat = (text) => text.replace(/\s+/gu, ' ');

function budgetFor(startedAt) {
  const spent = startedAt === undefined ? 0 : performance.timeOrigin + performance.now() - startedAt;
  return timeBudget(Math.min(BUDGET_MS, Math.max(SLICE_MS, LATEST_END_MS - spent)), SLICE_MS);
}

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env, startedAt } = {}) {
  if (env[OVERRIDE] === '1') return null;
  const calls = [];
  for (const { call, entry, written } of bodyCalls(command, cwd, readBodyCall, TEXT_HEREDOC)) {
    if (call.help || call.dryRun || call.deleteLast) continue;
    const project = findProject(entry.chained ?? cwd);
    const config = project ? loadConfig(project).config : null;
    const patterns = config?.github.publicText.patterns ?? [];
    const words = project ? usableBannedLines(project.root) : [];
    if (!patterns.length && !words.length) continue;
    // Read now: `written` holds what the line wrote before this call, and changes as the walk goes on.
    const body = readBody(call, entry.folder, written);
    const title = call.title && !call.title.dynamic ? call.title.text : null;
    const texts = [[bodyName(call), body], [titleName(call), title]].filter(([, raw]) => raw !== null);
    calls.push({ call, entry, project, config, patterns, words, body, texts });
  }
  if (!calls.length) return null;
  const budget = budgetFor(startedAt);
  for (const { texts, words } of calls) {
    const hit = privateHit(texts, words, budget);
    if (hit) return hit;
  }
  for (const { call, entry, project, config, patterns, body, texts } of calls) {
    if (targetsAnotherRepo(call, project, invocationRepo(entry.invocation.environment, env))) continue;
    // A closing comment has no file form, so its steps post the comment first, through the command that has one.
    const stepCall = isClosing(call) ? { ...call, subcommand: 'comment' } : call;
    const steps = () => twoSteps(bodyFilePath(stateFolder(project, config, env), stepCall, entry.folder), stepCall);
    const reason = configHit(texts, patterns, budget) ?? unread(call, body, steps);
    if (reason) return reason;
  }
  return null;
}

// The line of `raw` that holds `index`, an index into its `flat` form.
function lineAt(raw, index) {
  let at = 0;
  let line = 1;
  for (const part of raw.split(/(\s+)/u)) {
    const space = /^\s/u.test(part);
    const width = space ? 1 : part.length;
    if (index < at + width) return line;
    at += width;
    if (space) line += part.split('\n').length - 1;
  }
  return line;
}

// The deny for the first text that holds a private word, or null. It says where, and never what: not the word, its
// pattern, or the text around it.
function privateHit(texts, words, budget) {
  for (const [where, raw] of texts) {
    const text = flat(raw);
    const found = words.map((word) => boundedSearch(word, FLAGS, text, budget)).filter((index) => index !== null && index >= 0);
    if (found.length) {
      return deny(`a private word from \`${BANNED_FILE}\` matched in the ${where}. The first hit is on line ${lineAt(raw, Math.min(...found))} of the ${where}: ` +
        `reword it before it is posted, and do not open \`${BANNED_FILE}\`, so its words stay out of this session.`);
    }
  }
  return null;
}

// The deny for the first text that matches a config pattern, or null. An invalid pattern never gets here: loadConfig
// drops it and `aidrian check` reports it, with the same flags.
function configHit(texts, patterns, budget) {
  for (const [where, raw] of texts) {
    const text = flat(raw);
    const pattern = patterns.find((each) => (boundedSearch(each, FLAGS, text, budget) ?? -1) >= 0);
    if (pattern !== undefined) {
      const shown = pattern.length > SHOWN_PATTERN ? `${pattern.slice(0, SHOWN_PATTERN - 1)}…` : pattern;
      return deny(`the ${where} matches the ${KEY} pattern \`${shown}\`. Rewrite it as the rule or limit, and keep the detail in the state folder ` +
        '(`aidrian state` prints it). GitHub keeps the old text in its edit history, so an edit does not remove what was already posted.');
    }
  }
  return null;
}

// The deny for text the patterns never saw, or null. `steps` gives the two steps that pass.
function unread(call, body, steps) {
  if (call.title?.dynamic) {
    const where = titleName(call);
    return deny(`the ${where} is one this rule cannot read: a variable or a command substitution, so ${UNCHECKED}. Write the ${where} out in the command.`);
  }
  if (call.body || call.bodyFile) {
    if (body === null) {
      const target = call.target && !call.target.dynamic ? ` ${call.target.text}` : '';
      const after = isClosing(call) ? ` Then run \`gh ${call.noun} ${call.subcommand}${target}\` without --comment.` : '';
      return deny(`the ${bodyName(call)} is one this rule cannot read: a variable, a command substitution, stdin without a heredoc, a file that does not ` +
        `exist yet, or a device or a pipe, so ${UNCHECKED}. ${steps()}${after}`);
    }
  } else if (['create', 'comment'].includes(call.subcommand) && !call.web) {
    return deny(`\`gh ${call.noun} ${call.subcommand}\` has no --body or --body-file, so its text comes from an editor, a prompt, a template, or the ` +
      `commit messages, and ${UNCHECKED}. ${steps()}`);
  }
  if (call.fill && call.subcommand === 'create' && !call.title && !call.web) {
    return deny(`\`--fill\` with no --title takes the title from the commit messages, so ${UNCHECKED}. Write the title out with --title.`);
  }
  return null;
}

function deny(problem) {
  return `Blocked: ${problem}\nTo override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
