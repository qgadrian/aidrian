// Bash rule: the text of `gh issue create|edit|comment|close|reopen` and `gh pr create|edit|comment|close|reopen|merge` matches none of config.json
// `github.publicText.patterns`, and none of the private words of the git-ignored `.banned-terms.local` (lib/banned-terms.mjs),
// each a case-insensitive regular expression. Stopping it before the first post is the point: GitHub keeps the old text
// of an edited issue, pull request, or comment in a public edit history that no API deletes.
//
// With neither giving a pattern, the default, the rule is off: it reads only the config and looks for that file, and it
// looks up no remotes and reads no body. A project opting in is the signal: the
// rule asks nothing about the repository's visibility. Body and title are read as the pull request body rule reads them
// (pr-body `bodyCalls`), and a call naming another repository answers to no rule here (`targetsAnotherRepo`).
//
// A deny names a config pattern and never echoes the text around the match, since the dispatch log records its first
// sentence. A hit from the private file names neither the word nor its pattern, only the file and where it matched.
// With any pattern, a body or a title the rule cannot read is refused, and so is a call whose text comes from an
// editor, a prompt, a template, or the commit messages. Only `--web`, where a person posts from the browser, a dry run,
// help, and `--delete-last` go without a body; close, reopen, merge, and an edit post none unless given one. Each run of
// whitespace counts as one space, so a wrapped phrase matches. This reads wording only; docs/hooks.md says what it cannot catch.

import { BANNED_FILE, usableBannedPatterns } from '../../banned-terms.mjs';
import { loadConfig } from '../../config.mjs';
import { findProject } from '../../project.mjs';
import { bodyCalls, bodyFilePath, readBody, readBodyCall, stateFolder, targetsAnotherRepo, TEXT_HEREDOC, twoSteps } from './pr-body.mjs';
import { invocationRepo } from './review-request.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PUBLIC_TEXT';

const KEY = 'config.json `github.publicText.patterns`';
const UNCHECKED = 'the public text patterns go unchecked';
const isClosing = (call) => ['close', 'reopen'].includes(call.subcommand);
// What the deny calls the text: `--comment` and `--subject` carry it on those commands.
const bodyName = (call) => (isClosing(call) ? 'comment' : 'body');
const titleName = (call) => (call.subcommand === 'merge' ? 'subject' : 'title');

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const { call, entry, written } of bodyCalls(command, cwd, readBodyCall, TEXT_HEREDOC)) {
    if (call.help || call.dryRun || call.deleteLast) continue;
    const project = findProject(entry.chained ?? cwd);
    const config = project ? loadConfig(project).config : null;
    const patterns = config?.github.publicText.patterns ?? [];
    const words = project ? usableBannedPatterns(project.root) : [];
    if ((!patterns.length && !words.length) || targetsAnotherRepo(call, project, invocationRepo(entry.invocation.environment, env))) continue;
    const body = readBody(call, entry.folder, written);
    // A closing comment has no file form, so its steps post the comment first, through the command that has one.
    const stepCall = isClosing(call) ? { ...call, subcommand: 'comment' } : call;
    const steps = () => twoSteps(bodyFilePath(stateFolder(project, config, env), stepCall, entry.folder), stepCall);
    const reason = matched(call, body, patterns, words) ?? unread(call, body, steps);
    if (reason) return reason;
  }
  return null;
}

// The deny for the first text that matches a pattern, or null. An invalid pattern never gets here: loadConfig drops it
// and `aidrian check` reports it, with the same flags.
function matched(call, body, patterns, words) {
  const title = call.title && !call.title.dynamic ? call.title.text : null;
  for (const [where, raw] of [[bodyName(call), body], [titleName(call), title]]) {
    if (raw === null) continue;
    const text = raw.replace(/\s+/gu, ' ');
    if (words.some((word) => word.test(text))) return deny(`a private word from \`${BANNED_FILE}\` matched in the ${where}. Reword it before it is posted.`);
    const pattern = patterns.find((each) => new RegExp(each, 'iu').test(text));
    if (pattern !== undefined) {
      return deny(`the ${where} matches the ${KEY} pattern \`${pattern}\`. Rewrite it as the rule or limit, and keep the detail in the state folder ` +
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
      const after = isClosing(call) ? ` Then run \`gh ${call.noun} ${call.subcommand}\` without --comment.` : '';
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
