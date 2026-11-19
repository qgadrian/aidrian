// The closing words of a project run's issue session: what `aidrian pr auto-merge` (reason `closes`, lib/pr-auto-merge.mjs
// closingProblem) and the merge guard (lib/rules/github/merge-review.mjs unattendedProblem) refuse. A merge closes the
// issues its pull request's title, body, commits, or merge commit name after a closing word, as GitHub and a tracker's
// forge integration such as Linear's read them, and Linear also links, and may move, an issue whose key the title
// names. A project run's issue session merges with no Human, so its pull request may name only its own issue: any other
// would leave the run's ledger and the tracker telling different stories, and let text a session read steer which issues
// end. A session with no run's issue (runClosingContext) is not held to it.
//
// A token reads as a tracker key only when its prefix is a team key the run knows: the own issue's, the snapshot's
// `teams`, every team of the tracker workspace, and the teams of its issues. So `utf-8`, `x86-64`, `SHA-256`, and `e2e-2`
// are no keys while no team is named UTF, X86, SHA, or E2E. A snapshot with no `teams` knows only its issues' teams, and
// a key of any other team is a residual. When the run's snapshot cannot be read, every key-shaped token counts.

import { readdirSync } from 'node:fs';

import { loadConfig } from './config.mjs';
import { stateFolders } from './handoff-guard.mjs';
import { findProject } from './project.mjs';
import { ISSUE_KEY, readRun, RUN_ID, runsFolder } from './project-run.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

// The words that close an issue at a merge, in each form: GitHub's close, fix, and resolve, and Linear's complete too.
const CLOSING_WORD = /(?<![\w-])(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|complet(?:e[sd]?|ing))(?![\w-])/giu;
// What may stand between two references of one list: any white space but a line break (a line feed, CR LF, or a line
// or paragraph separator), which ends the list; a lone CR does not.
const BETWEEN = /(?:[^\S\r\n\u2028\u2029]|\r(?!\n)|[:,;&*_`'"()[\]>]|(?<![\w-])and(?![\w-]))+/yu;
// What may stand between a closing word and its first reference: the same, and line breaks too, since a forge that
// reads `Fixes` at a line's end and the key on the next closes it.
const BEFORE_FIRST = /(?:\s|[:,;&*_`'"()[\]>]|(?<![\w-])and(?![\w-]))+/yu;
// One reference: a link, `owner/name#12` or `#12`, or a key-shaped token such as `ENG-12`.
// A key is bounded by word characters only, so one a hyphen joins to more text, such as `ENG-9-export`, still counts.
const REFERENCE = /https?:\/\/[^\s)>\]]+|(?:[\w.-]+\/[\w.-]+)?#\d{1,9}|[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}(?!\w)/yu;
const KEY_TOKEN = /(?<!\w)([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})(?!\w)/gu;
const GITHUB_LINK = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d{1,9})(?:[/?#]|$)/iu;
const TRACKER_LINK = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})(?:[/?#]|$)/iu;
// The most references read after one closing word: a list that goes on past it is refused.
export const LIST_CAP = 50;

const prefixOf = (key) => (typeof key === 'string' && key.includes('-') ? key.slice(0, key.lastIndexOf('-')).toUpperCase() : null);
const known = (prefix, prefixes) => prefixes === null || prefixes.has(prefix);

// Every reference a closing word names in `text`: { refs, overflow }, each ref { word, text, key } for a tracker key,
// upper-cased, or { word, text, number, repo, host } for a forge issue, with `repo` and `host` null when the text names
// neither. `prefixes` is the set of team keys the run knows, upper-cased, or null for any. A link of another site, and
// a key of a team it does not know, are passed over; any other token ends the list, and so does a line break. `overflow` is true
// when a list goes on past LIST_CAP references.
export function closingRefs(text, prefixes = null) {
  const refs = [];
  let overflow = false;
  for (const match of String(text).matchAll(CLOSING_WORD)) {
    let at = match.index + match[0].length;
    for (let n = 0; ; n += 1) {
      const gap = n === 0 ? BEFORE_FIRST : BETWEEN;
      gap.lastIndex = at;
      if (gap.exec(text)) at = gap.lastIndex;
      REFERENCE.lastIndex = at;
      const ref = REFERENCE.exec(text);
      if (!ref) break;
      const read = referenceOf(ref[0], prefixes);
      if (!read) break;
      if (n === LIST_CAP) {
        overflow = true;
        break;
      }
      at = REFERENCE.lastIndex;
      // A link of another site names no issue here, and the list goes on past it.
      if (!read.skip) refs.push({ word: match[0], text: ref[0], ...read });
    }
  }
  return { refs, overflow };
}

function referenceOf(text, prefixes) {
  if (/^https?:/iu.test(text)) {
    const github = GITHUB_LINK.exec(text);
    if (github) return { number: Number(github[3]), repo: github[2].toLowerCase(), host: github[1].toLowerCase() };
    const tracker = TRACKER_LINK.exec(text);
    if (!tracker) return { skip: true };
    return known(tracker[1].toUpperCase(), prefixes) ? { key: `${tracker[1]}-${tracker[2]}`.toUpperCase() } : { skip: true };
  }
  const hash = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/u.exec(text);
  if (hash) return { number: Number(hash[2]), repo: hash[1]?.toLowerCase() ?? null, host: null };
  // A key of a team the run does not know names no issue here, and the list goes on past it, as past a link.
  const key = text.toUpperCase();
  return known(prefixOf(key), prefixes) ? { key } : { skip: true };
}

// Whether the reference `ref` names `own`, the run's issue key (lib/project-run.mjs ISSUE_KEY): a tracker key, or a
// bare number for an issue of the pull request's own repository, `pr` { repo, host }. A null `own` matches nothing.
export function namesOwnIssue(ref, own, pr) {
  if (typeof own !== 'string') return false;
  if (ref.key !== undefined) return own.includes('-') && ref.key === own.toUpperCase();
  return /^\d+$/u.test(own) && ref.number === Number(own)
    && (ref.repo === null || ref.repo === pr.repo.toLowerCase()) && (ref.host === null || ref.host === pr.host.toLowerCase());
}

// Why the texts of a pull request would close or link an issue other than the run's own, or null. `texts` are
// [{ where, text, title }]: a closing word's list in any of them counts, and in a title (`title: true`) every key of a
// known team does too, with or without a closing word. `context` is { own, prefixes } (runClosingContext), `pr`
// { repo, host }.
export function closingTextsProblem(texts, { own, prefixes }, pr) {
  const owned = typeof own === 'string' ? `its own issue ${own}` : 'the issue its unattended mark names, and that mark names none it can read';
  for (const { where, text, title } of texts) {
    const { refs, overflow } = closingRefs(text, prefixes);
    if (overflow) return `${where} lists more than ${LIST_CAP} references after a closing word, more than the gate reads, so its merge may close an issue other than ${owned}`;
    const other = refs.find((ref) => !namesOwnIssue(ref, own, pr));
    if (other) return `${where} says ${JSON.stringify(`${other.word} ${other.text}`.slice(0, 80))}, so its merge would close an issue other than ${owned}`;
    if (!title) continue;
    for (const match of String(text).matchAll(KEY_TOKEN)) {
      const key = `${match[1]}-${match[2]}`.toUpperCase();
      if (known(match[1].toUpperCase(), prefixes) && !(typeof own === 'string' && key === own.toUpperCase())) {
        return `${where} names ${JSON.stringify(key)}, which links that issue to the pull request, and its merge may move it: it may name only ${owned}`;
      }
    }
  }
  return null;
}

// The team keys the run `found` (readRun) knows, with the prefix of `own`: a set of upper-cased prefixes, from the
// snapshot's `teams`, every team of the tracker workspace when the driver gave them, and its issues' teams.
const prefixesOf = (found, own) => new Set([prefixOf(own), ...(found.snapshot.teams ?? []), ...found.snapshot.issues.map((issue) => prefixOf(issue.key))].filter(Boolean));

// The run `run` of the project at the main checkout `root`, as readRun reads it in a state folder the project's runs
// may be kept in, or null.
function runAt(root, run, { home } = {}) {
  const project = typeof root === 'string' ? findProject(root) : null;
  if (!project || typeof run !== 'string' || !RUN_ID.test(run)) return null;
  for (const state of stateFolders(project, loadConfig(project).config, { lazy: true, ...(home ? { home } : {}) })) {
    const found = readRun(state, run);
    if (!found.problem) return found;
  }
  return null;
}

// The issue a project run started `session` for, as its unattended mark names it: the key when it is a string the run's
// issue keys match; null when the mark is pending or cannot be read, or its tags are of a wrong shape, so every closing
// reference counts as another issue's; undefined when the mark names no run, which holds no session to the check.
export function runIssueOf(session, options = {}) {
  let mark;
  try {
    mark = readUnattendedMark(session, options);
  } catch {
    return null;
  }
  if (!mark) return undefined;
  if (mark.pending || mark.root === null) return null;
  if (mark.issue === undefined && mark.project === undefined) return undefined;
  return typeof mark.issue === 'string' && ISSUE_KEY.test(mark.issue) ? mark.issue : null;
}

// One read of `session`'s unattended mark, kept: a function that gives { mark } on every call, or { unreadable: true }
// when the read threw, so the callers of one command, such as the waiver's run budget and the closing words, read the
// same mark.
export function markOnce(session, options = {}) {
  let read = null;
  return () => {
    if (read) return read;
    try {
      read = { mark: readUnattendedMark(session, options) };
    } catch {
      read = { unreadable: true };
    }
    return read;
  };
}

// What the closing-word check holds `session` to, from one read of its unattended mark: { own, prefixes } (see
// closingTextsProblem), or undefined when the mark names no run's issue. A run it cannot read leaves `prefixes` null.
export function runClosingContext(session, options = {}) {
  return closingContextOf(markOnce(session, options)(), options);
}

// runClosingContext's answer from `read`, markOnce's answer.
export function closingContextOf(read, options = {}) {
  if (read.unreadable) return { own: null, prefixes: null };
  const { mark } = read;
  if (!mark) return undefined;
  if (mark.pending || mark.root === null) return { own: null, prefixes: null };
  if (mark.issue === undefined && mark.project === undefined) return undefined;
  const own = typeof mark.issue === 'string' && ISSUE_KEY.test(mark.issue) ? mark.issue : null;
  const found = own ? runAt(mark.root, mark.project, options) : null;
  return { own, prefixes: found ? prefixesOf(found, own) : null };
}

// What the merge guard holds a merge no Human asks for to, for the pull request from the branch `headRef`, made by a
// session whose held mark is `mark` (an unattended mark, or the { root } a driver mark stands for), in the project of the
// main checkout `home`: { own, prefixes } or undefined. A mark that names a run's issue holds it to that issue in that
// run; any other mark, the driver's among them, to the issue of a run in `home`'s state folders whose snapshot branch
// is `headRef`; a pull request of no run's issue is not held.
export function mergeClosingContext(mark, home, headRef) {
  if (mark?.pending || mark?.root === null) return { own: null, prefixes: null };
  if (mark?.issue !== undefined || mark?.project !== undefined) {
    const own = typeof mark.issue === 'string' && ISSUE_KEY.test(mark.issue) ? mark.issue : null;
    const found = own ? runAt(home?.root ?? mark.root, mark.project) : null;
    return { own, prefixes: found ? prefixesOf(found, own) : null };
  }
  if (!home || typeof headRef !== 'string' || headRef === '') return undefined;
  for (const state of stateFolders(home, loadConfig(home).config, { lazy: true })) {
    let names;
    try {
      names = readdirSync(runsFolder(state));
    } catch {
      continue;
    }
    for (const name of names.filter((each) => RUN_ID.test(each))) {
      const found = readRun(state, name);
      const issue = found.problem ? null : found.snapshot.issues.find((each) => each.branch === headRef);
      if (issue) return { own: issue.key, prefixes: prefixesOf(found, issue.key) };
    }
  }
  return undefined;
}
