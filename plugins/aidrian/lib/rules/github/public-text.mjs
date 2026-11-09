// Bash rule: the text of `gh issue create|edit|comment` and `gh pr create|edit|comment` matches none of config.json
// `github.publicText.patterns`, case-insensitive regular expressions. Stopping it before the first post is the point:
// GitHub keeps the old text of an edited issue, pull request, or comment in a public edit history that no API deletes.
//
// An empty list is the default and turns the rule off, with nothing looked up. A project opting in is the signal: the
// rule asks nothing about the repository's visibility. Body and title are read as the pull request body rule reads them
// (pr-body `bodyCalls`), and a call naming another repository answers to no rule here (`targetsAnotherRepo`).
//
// A deny names the pattern and never echoes the text around the match, since the dispatch log records its first sentence.
// With patterns set, a body or a title the rule cannot read is refused, and so is a call whose text comes from an
// editor, a prompt, a template, or the commit messages. Only `--web`, where a person posts from the browser, a dry run,
// help, and `--delete-last` go without a body. This reads wording only; docs/hooks.md says what it cannot catch.

import { loadConfig } from '../../config.mjs';
import { findProject } from '../../project.mjs';
import { bodyCalls, bodyFilePath, readBody, readBodyCall, stateFolder, targetsAnotherRepo, twoSteps } from './pr-body.mjs';
import { invocationRepo } from './review-request.mjs';

export const OVERRIDE = 'AIDRIAN_ALLOW_PUBLIC_TEXT';

const KEY = 'config.json `github.publicText.patterns`';

// The deny reason for `command`, or null.
export function check(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[OVERRIDE] === '1') return null;
  for (const { call, entry, written } of bodyCalls(command, cwd, readBodyCall)) {
    if (call.help || call.dryRun || call.deleteLast) continue;
    const project = findProject(entry.chained ?? cwd);
    const config = project ? loadConfig(project).config : null;
    const patterns = config?.github.publicText.patterns ?? [];
    if (!patterns.length || targetsAnotherRepo(call, project, invocationRepo(entry.invocation.environment, env))) continue;
    const body = readBody(call, entry.folder, written);
    const steps = () => twoSteps(bodyFilePath(stateFolder(project, config, env), call, entry.folder), call);
    const reason = matched(call, body, patterns) ?? unread(call, body, steps);
    if (reason) return reason;
  }
  return null;
}

// The deny for the first text that matches a pattern, or null. An invalid pattern never gets here: loadConfig drops it
// and `aidrian check` reports it, with the same flags.
function matched(call, body, patterns) {
  const title = call.title && !call.title.dynamic ? call.title.text : null;
  for (const [where, text] of [['body', body], ['title', title]]) {
    const pattern = text === null ? undefined : patterns.find((each) => new RegExp(each, 'iu').test(text));
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
    return deny(`the title is one this rule cannot read: a variable or a command substitution, so ${KEY} goes unchecked. Write the title out in the command.`);
  }
  if (call.body || call.bodyFile) {
    if (body !== null) return null;
    return deny('the body is one this rule cannot read: a variable, a command substitution, stdin without a heredoc, or a file that does not ' +
      `exist yet, so ${KEY} goes unchecked. ${steps()}`);
  }
  if (call.subcommand === 'edit' || call.web) return null;
  return deny(`\`gh ${call.noun} ${call.subcommand}\` has no --body or --body-file, so its text comes from an editor, a prompt, a template, or the ` +
    `commit messages, and ${KEY} goes unchecked. ${steps()}`);
}

function deny(problem) {
  return `Blocked: ${problem}\nTo override for an explicit, user-confirmed reason, set ${OVERRIDE}=1 in your own shell before starting the session ` +
    "(agents must never set it on the user's behalf).";
}
