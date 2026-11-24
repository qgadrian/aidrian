// Bash rule, and the decision of the GitHub MCP merge hook: no merge while a review the Human asked for has no answer,
// while a gate review is out, or while the review of the pull request's head has not finished. docs/hooks.md#merge-guard.
// A merge is:
//   - `gh pr merge` (but `--disable-auto`, and `--help` or `-h`, which merge nothing), `--auto` included;
//   - `gh api repos/<owner>/<name>/pulls/<n>/merge` sent as a PUT or a POST, and `curl` sending one to that path's URL;
//   - the MCP tool `mcp__github__merge_pull_request`, or a host connector's call that stands for it (scripts/hook-mcp-github.mjs).
// A GraphQL call through `gh api` or `curl` that may merge (MERGE_MUTATIONS) names its pull request by a node id no record
// is keyed by, so inside a project it is refused outright, for every session, with the `gh pr merge` to run instead.
// Each is read wherever it runs (shell-lex walkCommands): in a substitution, `sh -c`, `eval`, or a heredoc fed to a shell.
// A shell fed text the rule cannot read as commands, such as a pipe into `bash`, is refused when that text names a merge.
// It reads only this machine's review record (lib/review/state.mjs), scoped to the merge's repository when the call names
// one: an entry or outcome for another repository with the same number is not this merge's. A call that names none, as
// `gh pr merge 5` in a fork checkout whose gh default may be the upstream, reads every entry. Then, in this order:
//   1. a `pending` entry not answered denies, whatever the head or the outcome: a request sent is owed until the bot answers;
//   2. no record the review step wrote (no outcome, no round) allows: the guard holds a review that is open or asked
//      for, not that one happens, so a review run outside `aidrian pr review` is not guarded;
//   3. otherwise the head needs a finished outcome (`received`, `none_needed`) on that very head.
// Its network call is `gh pr view --json number,headRefOid,baseRefName,url`, made only when the call names no head or no
// pull request and a record may apply, and bounded at 3 s, or at the command's deadline below if sooner (none past it). A merge whose head it then cannot read is refused, as the review gate
// refuses a request whose pull request it cannot read: `--match-head-commit <sha>` names it.
// A record from another machine is not read here: that is the known limit, as for review-extend.
// Before it reads the record, a merge of this repository (one that names none, or one of this checkout's remotes) holds
// the working copy to the config the base branch commits, and refuses a state folder inside a checkout of this repository
// and a checkout at the folder the records go in (review/in-force.mjs baseProblem), from local git alone. A merge naming its number compares with origin's default branch
// first (origin/HEAD, else the plugin's default branch name on origin), before any read; once a view is made, with the base
// it names. With no such ref here it makes only the refusals about the checkouts, which need no base. Its recourse says
// which compare failed (recourse). With a read that fails, or no time left, the guard goes on as it would, since
// a hook lets the action run when it cannot read. Every git read of this
// hold is stopped after 1 s, or at the 4 s deadline below if sooner. This hold applies with no record too, and neither of
// the waivers below reaches it.
// The Human waives the record's denial with an AskUserQuestion answer, given at or after the head's outcome and every
// entry still owed, to a question naming `#<PR>` and the head's first 7 characters, whose chosen option starts with
// "Merge anyway". Without a transcript the host writes in that shape (Codex), the Human merges in their own shell, and
// every attended denial hands over that one command (handOver), so a decision the Human typed in chat is never asked
// twice; a chat message is never taken as the answer. A session no Human attends is asked no question (unattendedCap).
// A review stopped at its round limit (`extension_check` or `round_limit` on the merge's head, nothing owed) runs no
// more, so its denial offers no wait: it asks to ship with what the review left open filed as an issue, or to grant
// more rounds, neither preferred, and an answer starting "Merge with the findings filed" waives it too, there only.
// For that answer, the guard does not check that the issue was filed. `extension_ask` keeps the first question: it waits
// for the Human. When every open finding of the head is low (lib/review/delegation.mjs lowOnly), the denial also names a
// third route: the Human answers in their own words that the session decides, and the session records that answer with
// the follow-up issue (`aidrian pr delegate`, which the review-delegate rule holds to the Human's answer to this very
// question, roundLimitQuestion, and which checks the issue). That record waives the denial for a merge that names the
// head, while every open finding of the head stays low and the entry is at or after the outcome; an entry another
// session recorded is not taken when the hook gives this session's id and the entry holds its own. The guard reads it
// from the record it already loaded, with no call.
// An unattended run's judge verdict (`aidrian pr waive`, lib/review/waiver.mjs) waives it in that answer's place, only
// for `round_limit` on the merge's own head, nothing owed, and only under both switches:
// `github.unattendedWaiver.allow` on the default and base branches, read from GitHub, and the main checkout's local switch.
// It never stands in for the review bot: it waives only this machine's reviewers' findings, each of medium severity or
// lower and none a security finding, and only once the bot passed exactly that head on the forge.
// A verdict counts only for a merge that names its head. Those reads are made only when the switch is on and the denial
// is waivable: the view when the guard's own lacks the base, git's project folder, then the review trail (and, for a
// pointer to another folder, up to five REST reads), which merge trust then reads no second time.
// All share one clock from the hook's start (`startedAt`, for the whole command), the guard's own head lookup included:
// none begins at 4 s, the waiver's first only within 1.5 s (checked once, before it; its later reads and the head lookup
// have only the 4 s), and each is stopped with SIGKILL at 1 s (3 s for a view) or at 4 s if sooner.
// A read that fails or would begin too late keeps the denial.
// A session no Human attends (its unattended mark, lib/unattended-mark.mjs, read by the host's session id) may not take
// the record's word alone, which a project run's confined session can write: a merge the checks above let through, with
// a record or none, the Human's answer, or a waiver, must also name its number and full head, in the repository and on
// the host the session is pinned to (every host the merge names, ghHosts and readCurl), and pass lib/review/merge-trust.mjs trustProblem on the forge (unattendedProblem); a pull request
// of a project run's issue may close or link no other issue, by its title, body, commits, and the merge's own subject and
// body (mergeClosesProblem). Attended sessions are unchanged.

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, resolveAutoMerge } from '../../config.mjs';
import { forgeFor, isTrustedCommenter, repoIdentity } from '../../forges/index.mjs';
import { knownPrefix } from '../../git.mjs';
import { stateFolders } from '../../handoff-guard.mjs';
// A cycle (pr-auto-merge.mjs imports this file), benign while neither uses the other's exports as it loads.
import { branchPolicies, changesRequested, includesGuardedPaths, pathsProblem, refusingBranches, startDocs, trailDocs, trailPaths, trailPolicies } from '../../pr-auto-merge.mjs';
import { computeVerdict } from '../../pr-checks.mjs';
import { findProject, mayFollowTeamDefault } from '../../project.mjs';
import { closingTextsProblem, mergeClosingContext } from '../../closing-words.mjs';
import { pinnedRepository, readRun } from '../../project-run.mjs';
import { originRepo, prNumber, remoteRepos, repoName } from '../../review-gate.mjs';
import { baseProblem, boundedReads, recourse } from '../../review/in-force.mjs';
import { delegationFor, lowOnly } from '../../review/delegation.mjs';
import { readHumanSignoffs, sameBot, trustProblem } from '../../review/merge-trust.mjs';
import { CAPPED, emptyState, FINISHED, openCount, owed, owedElsewhere, readLocalState, recordProblem, recordRepos, sameCommit, withRecordMemo } from '../../review/state.mjs';
// A cycle (waiver.mjs → pr-auto-merge.mjs → this file), benign while neither uses the other's exports as it loads.
import { budgetedForge, guardWaiver, READ_TIMEOUT_MS, runOf, trailKey, WAIVER_DEADLINE_MS } from '../../review/waiver.mjs';
import { walkCommands } from '../../shell-lex.mjs';
import { driverHold } from '../../run-driver.mjs';
import { readUnattendedMark } from '../../unattended-mark.mjs';
import { transcriptAnswers, waitingRoute } from '../review-extend.mjs';
import { severalRemotes } from '../review-signoff.mjs';
import { commandPath, fillRepo, invocationRepo, readWords } from './review-request.mjs';

// How long the head lookup may take, inside the hook's 5 s, as pr-body's open pull request lookup.
const VIEW_TIMEOUT_MS = 3000;
const SHA = /^[0-9a-f]{7,40}$/iu;
// The options of `gh pr merge` and `gh api` that take a value, from each command's `--help`.
const MERGE_VALUES = ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo'];
const API_VALUES = ['-f', '--raw-field', '-F', '--field', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--input',
  '-p', '--preview', '--hostname', '--cache'];

// The forge the head lookup reads through: every call bounded at VIEW_TIMEOUT_MS, or at a shorter `timeoutMs` the caller
// gives. `options` are the adapter's, such as its `run` in a test, or `killSignal`.
export const viewForge = (cwd, options = {}) => forgeFor(cwd, { ...options, timeoutMs: Math.min(VIEW_TIMEOUT_MS, options.timeoutMs ?? VIEW_TIMEOUT_MS) });

// `{ number, headRefOid, baseRefName?, url? }` of the pull request gh finds for `target` (a number, URL, or branch; null for the current
// branch) in `repo` (null for this one), or null when gh cannot answer in time. The test seam of the guard's own view;
// the unattended waiver's reads go through its own bounded forge (lib/review/waiver.mjs). `timeoutMs` is the time the
// guard has left, so the lookup is stopped with SIGKILL at the command's deadline; a `forge` given, a test's, is used as is.
export function viewPrAt(cwd, forge = null) {
  return (target, repo, { timeoutMs = VIEW_TIMEOUT_MS } = {}) => {
    try {
      // The base and URL are for the unattended waiver's team read (lib/review/waiver.mjs), in the same call.
      const view = (forge ?? viewForge(cwd, { timeoutMs, killSignal: 'SIGKILL' })).change(target, 'number,headRefOid,baseRefName,url', { repo });
      return Number.isInteger(view?.number) && typeof view.headRefOid === 'string' ? view : null;
    } catch {
      return null;
    }
  };
}

// The merge one gh invocation makes, as { pr, head, target, repo }, or null when it makes none. A part the rule cannot
// read is null: a dynamic head or number is read through gh; a dynamic repository counts as this one.
// `cwd` is the folder a query file a `gh api graphql` call names is read from.
export function readMerge({ program, args, environment = [] }, env = {}, { cwd = process.cwd() } = {}) {
  if (program === 'curl') return readCurl(args, cwd);
  if (program !== 'gh') return null;
  const merge = readGh(args, environment, env, cwd);
  return merge && !merge.graphql ? { ...merge, ...ghHosts(args, environment, env, commandPath(args)[0] === 'api') } : merge;
}

function readGh(args, environment, env, cwd) {
  const command = commandPath(args);
  const literal = (token) => (token && !token.dynamic ? token.text : null);
  if (command[0] === 'api') {
    const { words, flags } = readWords(args, new Set(API_VALUES));
    // A merge mutation named anywhere in a `gh api` call is one, whatever endpoint it is sent to; and an endpoint that is
    // GraphQL's, however spelled, or one the shell builds, meets the query rules.
    if (args.some((token) => MUTATION_TEXT.test(token.text))) return { graphql: true, pr: null, head: null, target: null, repo: null, unreadable: false };
    if (words[1]?.dynamic || endpointOf(words[1]?.text) === 'graphql') {
      const graphql = graphqlMerge(args, flags, cwd);
      if (graphql || !words[1]?.dynamic) return graphql;
    }
    // The path as written, a variable included: `repos/<repo part>/pulls/<number>/merge`.
    const match = /(?:^|\/)repos\/(.+)\/pulls\/([^/]+)\/merge\/?$/u.exec(words[1]?.text ?? '');
    const fields = flags.filter((flag) => ['-f', '--raw-field', '-F', '--field'].includes(flag.name));
    // A method the rule cannot read (`-X "$M"`) may be PUT: it counts as a merge.
    const given = flags.filter((flag) => flag.name === '-X' || flag.name === '--method').at(-1)?.value;
    const method = given?.dynamic ? 'PUT' : literal(given)?.toUpperCase() ?? (fields.length || flags.some((flag) => flag.name === '--input') ? 'POST' : 'GET');
    if (!match || !['PUT', 'POST'].includes(method)) return null;
    // A number or repository part the rule cannot read (`$PR`, `${PR}`) is a merge it cannot check: refused.
    const variable = /[$`]/u;
    if (variable.test(match[2]) || variable.test(match[1]) || !/^\d+$/u.test(match[2]) || !/^[^/]+\/[^/]+$/u.test(match[1])) return { pr: null, head: null, target: null, repo: null, unreadable: true };
    const sha = fields.map((flag) => literal(flag.value)).find((text) => text?.startsWith('sha='))?.slice('sha='.length) ?? null;
    const repo = fillRepo(match[1], invocationRepo(environment, env));
    return { pr: Number(match[2]), head: sha && SHA.test(sha) ? sha : null, target: null, repo, text: apiMergeText(fields, flags) };
  }
  if (command[0] !== 'pr' || command[1] !== 'merge') return null;
  const { words, flags } = readWords(args, new Set(MERGE_VALUES));
  // `--help` prints the command's options and merges nothing, so a read of them is never held.
  if (flags.some((flag) => ['--disable-auto', '--help', '-h'].includes(flag.name))) return null;
  const last = (...names) => flags.filter((flag) => names.includes(flag.name)).at(-1)?.value ?? null;
  const target = words[2] ? literal(words[2]) : null;
  const head = literal(last('--match-head-commit'));
  const urlRepo = /\/pull\//u.test(target ?? '') ? repoName(target) : null;
  const flagRepo = last('-R', '--repo');
  return {
    pr: target === null ? null : prNumber(target),
    head: head && SHA.test(head) ? head : null,
    target,
    repo: flagRepo ? literal(flagRepo) : urlRepo ?? invocationRepo(environment, env),
    // A target the rule cannot read, such as `"$PR"`, is no pull request it can check.
    unreadable: Boolean(words[2]) && target === null,
    text: mergeText(last('-t', '--subject'), last('-b', '--body'), last('-F', '--body-file')),
    // `--auto` leaves the merge to GitHub once the checks pass, at whatever head the branch has then.
    ...(flags.some((flag) => flag.name === '--auto') ? { auto: true } : {}),
  };
}

// The value of the variable `name` for one gh invocation, after its assignments and env changes, as a word, or null
// when it is unset or empty.
function invocationValue(name, environment, env) {
  let value = typeof env[name] === 'string' && env[name] !== '' ? { text: env[name], dynamic: false } : null;
  for (const change of environment) {
    if (change.clear) value = change.keep?.includes(name) ? value : null;
    else if (change.name === name) value = change.value ?? null;
  }
  return value === null || value.text === '' ? null : value;
}

// The host a word names, lower-cased, with GitHub's API host read as the host it serves (`api.github.com` is
// `github.com`): from a URL, git's `host:path`, or gh's `HOST/OWNER/REPO`; null for a bare `OWNER/REPO`, which names
// none; UNREAD_HOST for a word the shell builds, or one that names no host gh could reach.
const UNREAD_HOST = Symbol('unread host');
function hostNamed(word, { bare = false } = {}) {
  if (!word || word.dynamic || /[$`]/u.test(word.text)) return UNREAD_HOST;
  const text = word.text.trim();
  if (!bare && !text.includes(':') && text.split('/').filter(Boolean).length === 2) return null;
  const host = repoIdentity(bare ? `https://${text}/o/n` : text)?.host ?? null;
  return host === null ? UNREAD_HOST : host.toLowerCase().replace(/^api\.(?=[^.]+\.[^.]+)/u, '');
}

// The hosts one gh merge names, as { hosts } and { hostUnread: true }, each only when there is one: the target URL, `-R`,
// GH_REPO, GH_HOST, and, for `gh api`, `--hostname`, else the host `gh api` defaults to, github.com. Every one is kept,
// whichever gh would use, so a merge whose spellings disagree is held to all of them; a word the shell builds is unread.
// A `gh pr merge` told no host reads it from the checkout's remotes, the pinned one's for a session no Human attends.
function ghHosts(args, environment, env, api) {
  const { words, flags } = readWords(args, new Set(api ? API_VALUES : MERGE_VALUES));
  const repos = flags.filter((flag) => ['-R', '--repo'].includes(flag.name)).map((flag) => flag.value ?? { text: '', dynamic: true });
  const named = [invocationValue('GH_REPO', environment, env), ...repos].filter(Boolean).map((word) => hostNamed(word));
  const host = invocationValue('GH_HOST', environment, env);
  if (host) named.push(hostNamed(host, { bare: true }));
  if (api) {
    const given = flags.filter((flag) => flag.name === '--hostname');
    named.push(...given.map((flag) => hostNamed(flag.value, { bare: true })));
    if (!given.length && !host) named.push(API_HOST);
  } else if (words[2] && /:\/\//u.test(words[2].text)) named.push(hostNamed(words[2]));
  return placesOf(named);
}
const API_HOST = 'github.com';

const placesOf = (named) => {
  const hosts = [...new Set(named.filter((each) => typeof each === 'string'))];
  return { ...(hosts.length ? { hosts } : {}), ...(named.includes(UNREAD_HOST) ? { hostUnread: true } : {}) };
};

// The options of curl that take a value, from `curl --help all`: the ones a merge sends, and the common rest, so the
// word after one is never read as the URL.
const CURL_DATA = ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'];
const CURL_VALUES = new Set([...CURL_DATA, '-X', '--request', '-T', '--upload-file', '-H', '--header', '-u', '--user', '-o', '--output',
  '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-F', '--form', '--form-string', '-K', '--config',
  '-w', '--write-out', '--url', '-x', '--proxy', '-m', '--max-time', '--connect-timeout', '-r', '--range', '-E', '--cert', '--cacert',
  '--key', '--retry', '-U', '--proxy-user', '--oauth2-bearer', '--resolve', '--connect-to', '-D', '--dump-header']);
// A URL, a variable included, whose path is a REST merge: its host part, `repos/<repo part>/pulls/<number>/merge`.
const CURL_MERGE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/]*)(?:\/.*)?\/repos\/(.+)\/pulls\/([^/?#]+)\/merge\/?(?:[?#].*)?$/iu;
const CURL_GRAPHQL = /(?:^|\/)graphql\/?(?:[?#].*)?$/iu;

// The merge one curl invocation makes, as readMerge gives it, or null: a PUT or a POST to a REST merge URL, or a
// GraphQL call that may merge (graphqlMerge's rules: a word naming a mutation, or a body from a file that does, or
// one the shell builds, sent to a GraphQL URL or one the shell builds whole). A method it cannot read may be PUT. A body it cannot read leaves the
// head and the merge commit's text unread. The URL's host is the merge's, `api.github.com` read as `github.com`.
function readCurl(args, cwd) {
  const { words, flags } = readWords(args, CURL_VALUES);
  const urls = [...words, ...flags.filter((flag) => flag.name === '--url').map((flag) => flag.value)].filter(Boolean);
  const data = flags.filter((flag) => CURL_DATA.includes(flag.name) || ['-T', '--upload-file'].includes(flag.name));
  const found = (unreadable) => ({ graphql: true, pr: null, head: null, target: null, repo: null, unreadable });
  const graphql = urls.some((url) => CURL_GRAPHQL.test(url.text));
  if ((graphql || urls.some((url) => url.dynamic)) && args.some((token) => MUTATION_TEXT.test(token.text))) return found(false);
  if (graphql) {
    for (const { name, value } of data) {
      const file = ['-T', '--upload-file'].includes(name) ? value?.text : /^@(.+)$/u.exec(value?.text ?? '')?.[1];
      if (!value || value.dynamic || file === '-') return found(true);
      if (file === undefined) continue;
      const text = queryFile(file, cwd);
      if (text === null || MUTATION_TEXT.test(text)) return found(text === null);
    }
    return null;
  }
  const url = urls.map((each) => ({ each, match: CURL_MERGE.exec(each.text) })).find(({ match }) => match);
  if (!url) return null;
  const given = flags.filter((flag) => flag.name === '-X' || flag.name === '--request').at(-1)?.value;
  let method = given?.dynamic ? 'PUT' : given?.text?.toUpperCase();
  if (!method) {
    if (flags.some((flag) => ['-T', '--upload-file'].includes(flag.name))) method = 'PUT';
    else if (data.length && !flags.some((flag) => ['-G', '--get'].includes(flag.name))) method = 'POST';
    else method = 'GET';
  }
  if (!['PUT', 'POST'].includes(method)) return null;
  const [, hostPart, repoPart, number] = url.match;
  const variable = /[$`]/u;
  if (variable.test(number) || variable.test(repoPart) || !/^\d+$/u.test(number) || !/^[^/]+\/[^/]+$/u.test(repoPart)) return { pr: null, head: null, target: null, repo: null, unreadable: true };
  const body = curlBody(data);
  const host = variable.test(hostPart) ? UNREAD_HOST : hostNamed({ text: hostPart, dynamic: false }, { bare: true });
  return { pr: Number(number), head: body.head, target: null, repo: repoPart, text: body.text, ...placesOf([host]) };
}

// The head (`sha`) and merge commit text (`commit_title`, `commit_message`) of a curl merge's one JSON body, each null
// when it names none; a body from a file, one the shell builds, or more than one is unreadable.
function curlBody(data) {
  const text = { subject: null, body: null, unreadable: false };
  if (!data.length) return { head: null, text };
  const [only] = data;
  let json = null;
  if (data.length === 1 && only.value && !only.value.dynamic && !only.value.text.startsWith('@') && CURL_DATA.includes(only.name)) {
    try {
      json = JSON.parse(only.value.text);
    } catch {}
  }
  if (!json || typeof json !== 'object') return { head: null, text: { ...text, unreadable: true } };
  const read = (key) => (typeof json[key] === 'string' ? json[key] : null);
  const sha = read('sha');
  return { head: sha && SHA.test(sha) ? sha : null, text: { subject: read('commit_title'), body: read('commit_message'), unreadable: false } };
}

// The merge commit's own subject and body a merge names, for the closing-word check (lib/closing-words.mjs):
// { subject, body, unreadable }, each text null when the merge names none, and `unreadable` true when one comes from a
// file or a word built from a variable, which the guard cannot read.
function mergeText(subject, body, bodyFile) {
  const read = (token) => (token && !token.dynamic ? token.text : null);
  return { subject: read(subject), body: read(body), unreadable: Boolean(subject?.dynamic || body?.dynamic || bodyFile) };
}

// The same for a REST merge's `commit_title` and `commit_message` fields: a field built from a variable, one `-F` reads
// from a file (`@file`), or a request body from `--input` is unreadable.
function apiMergeText(fields, flags) {
  const text = { subject: null, body: null, unreadable: flags.some((flag) => flag.name === '--input') };
  for (const flag of fields) {
    if (!flag.value || flag.value.dynamic) {
      text.unreadable = true;
      continue;
    }
    const at = flag.value.text.indexOf('=');
    const [key, value] = at === -1 ? [flag.value.text, ''] : [flag.value.text.slice(0, at), flag.value.text.slice(at + 1)];
    if (!['commit_title', 'commit_message'].includes(key)) continue;
    if (['-F', '--field'].includes(flag.name) && value.startsWith('@')) text.unreadable = true;
    else text[key === 'commit_title' ? 'subject' : 'body'] = value;
  }
  return text;
}

// Why a merge no Human asks for would close, or link, an issue other than its project run's own, or null
// (closing-words.mjs): the pull request's title, body, and every commit message, from the review trail `trail` at the
// pinned head, and the merge's own subject and body, `merge.text`. Only for a pull request of a run's issue, as
// mergeClosingContext reads `mark` and the main checkout `home`; `pr` is { repo, host }.
export function mergeClosesProblem({ trail, merge, mark, home, pr }) {
  const context = mergeClosingContext(mark, home, trail?.headRef);
  if (context === undefined) return null;
  if (merge.text?.unreadable) return 'its merge commit\'s subject or body comes from a file or a variable the guard cannot read, and a merge of a project run\'s issue may close only that issue';
  if (typeof trail?.title !== 'string' || trail.messagesComplete !== true || !Array.isArray(trail.messages) || trail.messages.some((each) => typeof each?.message !== 'string')) {
    return 'the forge did not give its title and every commit message, so whether its merge closes another issue cannot be told';
  }
  const texts = [
    { where: 'its title', text: trail.title, title: true },
    { where: 'its body', text: trail.body ?? '' },
    ...trail.messages.map((each) => ({ where: `commit ${String(each.oid ?? '').slice(0, 7) || 'with no SHA'}`, text: each.message })),
    ...(merge.text?.subject ? [{ where: 'the merge commit\'s subject', text: merge.text.subject, title: true }] : []),
    ...(merge.text?.body ? [{ where: 'the merge commit\'s body', text: merge.text.body }] : []),
  ];
  return closingTextsProblem(texts, context, pr);
}

// The GraphQL mutations that merge a pull request, or leave its merge to GitHub: auto-merge and the merge queue.
export const MERGE_MUTATIONS = Object.freeze(['mergePullRequest', 'enablePullRequestAutoMerge', 'enqueuePullRequest']);
const MUTATION_TEXT = new RegExp(MERGE_MUTATIONS.join('|'), 'u');
// What a GraphQL call that may merge is, as a deny names it; `unreadable` when its query is one the guard cannot read.
const graphqlCall = (unreadable) => `${unreadable ? 'is a GraphQL call whose query the guard cannot read, which may' : 'is a GraphQL call that may'} merge a pull request or leave its merge to GitHub (${MERGE_MUTATIONS.join(', ')})`;

// The deny for such a call in a session a Human attends: it names its pull request by a node id, which no review record
// is keyed by, so the guard cannot check the review it owes, and refuses it outright.
export const graphqlReason = (unreadable) =>
  `Blocked: this ${graphqlCall(unreadable)}, by a node id the merge guard cannot match to a pull request's review record. ` +
  'Merge with `gh pr merge <PR> --match-head-commit <sha>`, which the guard checks; a query that only reads runs as before.';

// The largest query file a `gh api graphql` call may name that the rule reads.
const QUERY_CAP = 1024 * 1024;
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The text of the query file `file`, from `cwd`, read without following a link or waiting on a FIFO, or null when it is
// no regular file under QUERY_CAP bytes.
function queryFile(file, cwd) {
  let fd;
  try {
    fd = openSync(path.resolve(cwd, file), NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > QUERY_CAP) return null;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// A `gh api` endpoint as written, normalized: no scheme and host of an absolute URL, no query string, and no leading or
// trailing slash, so `/graphql`, `graphql/`, `graphql?x=1`, and `https://api.github.com/graphql` all read `graphql`.
export function endpointOf(text) {
  if (typeof text !== 'string') return null;
  let rest = text.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/iu.exec(rest);
  if (url) rest = url[1] ?? '';
  rest = rest.replace(/[?#].*$/u, '').replace(/^\/+|\/+$/gu, '');
  if (url) rest = rest.replace(/^api\/(?:v3\/)?/u, '');
  return rest.toLowerCase();
}

// A `gh api graphql` call that may merge (MERGE_MUTATIONS), as { graphql: true, pr: null, head: null, unreadable }, or
// null when it names none. It names one when a word of it does, or the query file a field (`-F query=@file`) or
// `--input` names does; a query the shell builds, a field value from a file it cannot read, and `--input -` may be one,
// and count as `unreadable`. The merge guard refuses such a call inside a project (graphqlReason), and to a session no
// Human attends wherever it runs.
function graphqlMerge(args, flags, cwd) {
  const found = (unreadable) => ({ graphql: true, pr: null, head: null, target: null, repo: null, unreadable });
  if (args.some((token) => MUTATION_TEXT.test(token.text))) return found(false);
  for (const flag of flags) {
    const value = flag.value;
    if (flag.name === '--input') {
      if (!value || value.dynamic || value.text === '-') return found(true);
      const text = queryFile(value.text, cwd);
      if (text === null || MUTATION_TEXT.test(text)) return found(text === null);
      continue;
    }
    if (!['-f', '--raw-field', '-F', '--field'].includes(flag.name) || !value) continue;
    if (value.dynamic && /^(?:query|[^=]*[$`])/u.test(value.text)) return found(true);
    const at = /^query=@(.+)$/u.exec(value.text);
    if (flag.name.startsWith('-F') || flag.name === '--field') {
      if (at) {
        const text = queryFile(at[1], cwd);
        if (text === null || MUTATION_TEXT.test(text)) return found(text === null);
      }
    }
  }
  return null;
}

// The options of the question at a capped review (state.mjs CAPPED), in the deny and in the answer mergeApproved takes.
export const SHIP = 'Merge with the findings filed';
export const GRANT = 'Grant more review rounds';
// SHIP holds no character a regular expression treats as special.
const SHIP_ANSWER = new RegExp(`^\\s*${SHIP}\\b`, 'iu');

// The Human's answer that waives the guard for `pr` at `head`, given at or after `since`: "Merge anyway", or, at a
// review stopped at its round limit (`capped`), "Merge with the findings filed".
export function mergeApproved(answers, { pr, head, since = null, capped = false }) {
  const names = new RegExp(`#${pr}(?!\\d)`, 'u');
  const sha7 = String(head).slice(0, 7).toLowerCase();
  const takes = (answer) => /^\s*merge anyway\b/iu.test(answer) || (capped && SHIP_ANSWER.test(answer));
  return answers.some((each) => names.test(each.question) && each.question.toLowerCase().includes(sha7) && takes(each.answer) &&
    (since === null || (each.at !== null && Date.parse(each.at) >= Date.parse(since))));
}

// `, with <N> finding(s) open` for a count, or nothing without one.
const withOpen = (count) => {
  if (count === null) return '';
  const noun = count === 1 ? 'finding' : 'findings';
  return `, with ${count} ${noun} open`;
};

// The review step's outcome on head `sha7`, as the deny names it: its status, and its reason when it has one.
const statusText = (outcome, sha7) => `the review of head ${sha7} is \`${outcome.status}\`${outcome.reason ? ` (${outcome.reason})` : ''}`;

// The question the guard asks at a review of `pr` stopped at its round limit on `head`, with `count` findings open (null:
// the record has no count). The review-delegate rule reads the Human's answer to this very text, so both build it here.
export function roundLimitQuestion(pr, head, count) {
  // With no count, the record does not say findings are what is open: the cap is also reached on a failing check.
  let left = 'them';
  if (count === null) left = 'what it left open';
  else if (count === 1) left = 'it';
  return `Review of pull request #${pr} at ${String(head).slice(0, 7).toLowerCase()} stopped at its round limit${withOpen(count)}. Ship, and file ${left} as an issue?`;
}

// The deny's tail at a review stopped at its round limit: ship with the findings filed, or grant more rounds, with
// neither preferred. The grant's route is the waiting check's own, else `aidrian pr extend`, whose refusal names it.
// `delegable`: every open finding of `head` is low, so the Human may also leave the decision to the session; `repoArg`
// is ` --repo <owner>/<name>` for the delegate command in a checkout whose remotes name several repositories.
function cappedAsk({ pr, count, last, head, delegable, repoArg, mergeArg = repoArg }) {
  const question = roundLimitQuestion(pr, head, count);
  const route = waitingRoute(pr, last) ??
    `Run \`aidrian pr extend ${pr} --human approve\`: it records the grant when an extension waits for the Human, and otherwise its refusal names the route to one more round.`;
  return `Only the Human decides this: ask with AskUserQuestion, the question "${question}", the options "${SHIP}" and "${GRANT}", ` +
    `and mark neither as preferred. When the Human picks "${SHIP}", file the findings the review left open as a follow-up issue, then merge. ` +
    `When the Human picks "${GRANT}", do not merge. ${route} ${delegable ? delegateRoute(pr, head, repoArg, mergeArg) : ''}`;
}

// The route when the Human answers in their own words that the session decides, offered only while every open finding is low.
const delegateRoute = (pr, head, repoArg, mergeArg = repoArg) =>
  'When the Human instead answers in their own words that the session decides, the session may ship, since every open finding is low: ' +
  `file what the review left open as an open follow-up issue that names pull request #${pr}, run \`aidrian pr delegate ${pr} --issue <issue> --head ${head}${repoArg}\` ` +
  `as its own command, then merge with \`gh pr merge ${pr}${mergeArg} --match-head-commit ${head}\`. `;

// ` --repo <owner>/<name>` for a command in a checkout whose remotes name several repositories: the merge's own when it
// names one, else a placeholder; '' with one remote. A git read that fails reads as one remote.
// ` --repo <owner>/<name>` for a merge command the guard suggests, when the merge named its repository: gh's default may
// be another one even in a checkout with one remote. Only a name repoName reads is written, so no shell syntax.
const mergeRepoArg = (repo) => {
  const name = repoName(repo);
  return name ? ` --repo ${name}` : '';
};

const repoArgFor = (project, repo) => {
  let several = false;
  try {
    several = severalRemotes(project);
  } catch {}
  return several ? ` --repo ${repoName(repo) ?? '<owner>/<name>'}` : '';
};

const readTranscript = (file) => {
  try {
    return typeof file === 'string' && file !== '' ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

// Whether the record holds anything the guard reads: an entry still owed, or a review the step ran or is running.
const guards = (state) => Boolean(state) && (owed(state).length > 0 || state.outcome != null || state.rounds.length > 0);

// The deny for a merge that names no repository while this machine holds records of its number for several (#305):
// the guard cannot tell which pull request gh merges, so it reads none of them in its place.
const ambiguous = (pr, repos) =>
  `Blocked: this merges pull request #${pr} with no repository named, and this machine holds review records of #${pr} for ` +
  `several repositories (${repos.join(', ')}), so the merge guard cannot tell which one it checks. Name it: ` +
  `\`gh pr merge ${pr} -R <owner>/<name> --match-head-commit <sha>\`.`;
// A merge with no repository named, of a number this machine holds records of for more than one repository.
const ambiguousRecords = (project, pr, repo) => {
  if (repo !== null || pr === null) return null;
  const repos = recordRepos(project, pr).filter(Boolean).sort();
  return repos.length > 1 ? ambiguous(pr, repos) : null;
};

export const unresolved = (pr, how) =>
  `Blocked: this merges ${pr === null ? 'a pull request' : `pull request #${pr}`}, and the merge guard could not read ` +
  `${pr === null ? 'which one, or its head commit,' : 'its head commit'} in time to check its review. ${how}`;

const MERGE_HOW = 'Name both: `gh pr merge <PR> --match-head-commit <sha>`, with the head the review covered.';

// A merge named in text the rule cannot read as commands: `gh pr merge`, or a `pulls/<n>/merge` API path.
const MERGE_TEXT = /\bpr\s+merge\b|\bpulls\/[^\s/]+\/merge\b/u;
export const UNREAD_REASON =
  'Blocked: this feeds a shell text the merge guard cannot read as commands (a pipe into a shell, a script, or nesting ' +
  'too deep), and that text names a merge, so the guard cannot check its review. Run the merge as its own command, ' +
  '`gh pr merge <PR> --match-head-commit <sha>`.';

// The part of `state` that is for repository `repo` (null: unknown, so all of it): the owed entries for it, and the
// outcome and rounds when the record is. An entry's repository is its own `repo`, else the record's, else origin's;
// one still unknown counts for every repository. Every spelling compares as `owner/name`, lower-cased. The record file is
// per number, so a fork checkout holds upstream#5 and origin#5 in one record: each merge reads only its own entries.
// `readLocalState` gives a merge of `repo` that repository's own record alone; the entries another repository's record
// holds for it (state.mjs owedElsewhere), as one written before the record was keyed by repository does, are added.
export const recordFor = (project, pr, repo) => {
  const own = readLocalState(project, pr, repo);
  const extra = repo === null ? [] : owedElsewhere(project, pr, repo);
  if (!extra.length) return own;
  return { ...(own ?? { ...emptyState(pr, repoName(repo)) }), pending: [...(own?.pending ?? []), ...extra] };
};

export function scoped(state, project, repo) {
  const target = repo === null ? null : repoName(repo);
  if (!state || target === null) return state;
  const home = repoName(state.repo ?? null) ?? originRepo(project);
  const ours = (own) => own === null || own === target;
  const mine = ours(home);
  return { ...state, pending: owed(state).filter((entry) => ours(repoName(entry.repo ?? null) ?? home)), outcome: mine ? state.outcome : null, rounds: mine ? state.rounds : [] };
}

// The deny reason when a merge of this repository finds the working copy not held to `base` (baseProblem), or null. A
// merge of a repository this checkout has no remote for reads no record of it through this working copy's config.
function heldReason({ project, pr, repo, base, deadline, now }) {
  const git = boundedReads(deadline, now);
  const name = repoName(repo);
  let problem = null;
  try {
    if (name === null || remoteRepos(project, git()).includes(name)) problem = baseProblem(project, { repo: name ?? 'origin', base, git });
  } catch {}
  if (!problem) return null;
  const merge = pr === null ? 'a pull request' : `pull request #${pr}`;
  return `Blocked: this merges ${merge}, but ${problem.replace(/\.$/u, '')}. ${recourse(problem, base)}`;
}

// What the guard makes of the Human's recorded answer that left the decision to the session (lib/review/delegation.mjs):
// { allow, delegable, route }. Read only at a capped review whose open findings are all low (`delegable`), and taken only
// for a merge that names its head (`named`), as a recorded verdict; for another, `route` says to name it. `session` is the
// merging session's id, or null when the hook gives none: an entry another session recorded is then not taken.
// A later "Grant more review rounds" answer of this session to the same question (`answers`, `count`) outranks the entry.
// `repoArg` names the repository in the merge command it suggests, as `--repo` selected it.
function delegated({ state, pr, head, capped, named, session, answers = [], count = null, repoArg = '' }) {
  const delegable = capped && lowOnly(state, head).ok;
  let taken = delegable ? delegationFor(state, head, { session }) : null;
  const question = roundLimitQuestion(pr, head, count);
  const granted = taken && answers.some((each) => each.question === question && new RegExp(`^\\s*${GRANT}\\b`, 'iu').test(each.answer ?? '') &&
    each.at !== null && Date.parse(each.at) >= Date.parse(taken.at));
  if (granted) taken = null;
  let route = '';
  if (granted) route = ` The Human granted more review rounds after the recorded answer, so it no longer stands: do not merge; run \`aidrian pr extend ${pr} --human approve\`.`;
  else if (taken && !named) route = ` The Human's recorded answer covers this head, but only for a merge that names it: merge with \`gh pr merge ${pr}${repoArg} --match-head-commit ${head}\`, or give the merge tool its \`sha\`.`;
  return { allow: Boolean(taken) && named, delegable, route };
}

// The deny reason for a merge of `pr` at `head` in `project`, or null. `pr` or `head` null is read through
// `viewPr(target, repo)`; `answers` are the Human's AskUserQuestion answers in this session.
// `waiverForge` is the test seam for the unattended waiver's reads (lib/review/waiver.mjs guardWaiver, budgetedForge's
// `make`); null builds forgeFor's only when the waiver is asked. `startedAt` is when the hook's process started, shared by
// every merge of one command; `now` the clock. `session` is the merging session's id from the hook, or null.
export function judgeMerge({ project, pr = null, head = null, target = null, repo = null, unreadable = false, viewPr, answers = [], how = MERGE_HOW, waiverForge = null, startedAt = null, now = Date.now, memo = {}, session = null, unattended = false }) {
  startedAt ??= now();
  // Only a merge that names its head can take a recorded verdict: otherwise gh merges whatever head the branch has then.
  const named = head !== null;
  // A number the rule cannot read is refused whatever the target: no record can say the merge is another's.
  if (unreadable) return unresolved(null, how);
  const held = (base) => heldReason({ project, pr, repo, base, deadline: startedAt + WAIVER_DEADLINE_MS, now });
  const before = pr === null ? null : held(null);
  if (before) return before;
  const unnamed = ambiguousRecords(project, pr, repo);
  if (unnamed) return unnamed;
  let state = pr === null ? null : scoped(recordFor(project, pr, repo), project, repo);
  if (pr !== null && !guards(state)) return null;
  let view = null;
  if (pr === null || head === null) {
    // The lookup shares the command's deadline with the waiver's reads: with no time left it is not made, and the merge
    // is refused, told to name its head.
    const left = Math.floor(startedAt + WAIVER_DEADLINE_MS - now());
    view = left > 0 ? viewPr(pr ?? target, repo, { timeoutMs: Math.min(VIEW_TIMEOUT_MS, left) }) : null;
    if (!view) return unresolved(pr, how);
    const denied = held(view.baseRefName ?? null);
    if (denied) return denied;
    if (pr === null) {
      pr = view.number;
      const later = ambiguousRecords(project, pr, repo);
      if (later) return later;
      state = scoped(recordFor(project, pr, repo), project, repo);
      if (!guards(state)) return null;
    }
    head ??= view.headRefOid;
  }
  const sha7 = head.slice(0, 7);
  const owing = owed(state);
  const outcome = state.outcome ?? null;
  const onHead = outcome !== null && sameCommit(outcome.head, head);
  // Stopped at the round limit with nothing owed: no review runs, so there is nothing to wait for.
  const capped = owing.length === 0 && onHead && CAPPED.has(outcome.status);
  const count = capped ? openCount(state, head) : null;
  let problem;
  if (owing.length) {
    problem = owing.map((entry) => {
      if (entry.kind === 'review') return `a review dispatched at ${entry.at} has no result on record: wait for it, then record it with \`aidrian pr attest ${pr} --head <sha> --reviewer <who> --findings <n> --fixed <n>\``;
      const ask = `the Human asked for a bot review (recorded ${entry.at}) `;
      const cancel = '. A later instruction, such as a merge command, does not cancel it';
      return entry.sent
        ? `${ask}that was sent and has no answer yet: wait for it with \`aidrian pr await-review ${pr}\`${cancel}`
        : `${ask}that was never sent: send it with \`aidrian pr await-review ${pr} --request\` and merge after it answers${cancel}`;
    }).join('; and ');
  } else if (onHead && FINISHED.has(outcome.status)) return null;
  else if (outcome === null && !state.rounds.length) return null;
  else if (capped) {
    problem = `${statusText(outcome, sha7)}: stopped at its round limit${withOpen(count)}, and not running`;
  } else {
    problem = outcome === null
      ? `its review record holds rounds but no finished review of head ${sha7}`
      : onHead ? statusText(outcome, sha7)
        : `the last review step covered ${String(outcome.head).slice(0, 7)}, not head ${sha7}`;
    problem += `: run \`aidrian pr review ${pr}\` until it returns \`received\` or \`none_needed\``;
  }
  const since = [onHead ? outcome.at : null, ...owing.map((entry) => entry.at)].filter((at) => typeof at === 'string').sort().at(-1) ?? null;
  if (mergeApproved(answers, { pr, head, since, capped })) return null;
  const delegation = delegated({ state, pr, head, capped, named, session, answers, count, repoArg: capped ? mergeRepoArg(repo) : '' });
  if (delegation.allow) return null;
  // A judge's recorded verdict, under both switches, for the round cap on this head only (waiverKind).
  const waiver = guardWaiver({ project, state, pr, head, named, repo, view, forge: waiverForge, startedAt, now, memo });
  const question = `Merge pull request #${pr} at ${sha7} before its review is finished?`;
  // The remotes are read only for the delegation route, which only a capped review whose open findings are all low names.
  const repoArg = delegation.delegable ? repoArgFor(project, repo) : '';
  const last = state.extensions?.at(-1) ?? null;
  let ask;
  if (unattended) ask = capped ? unattendedCap({ pr, last, local: project.paths.local }) : UNATTENDED_WAIT;
  else if (capped) ask = cappedAsk({ pr, count, last, head, delegable: delegation.delegable, repoArg, mergeArg: mergeRepoArg(repo) });
  else {
    ask = `Only the Human waives this: ask with AskUserQuestion, the question "${question}", the options "Wait for the review" ` +
      '(first, recommended) and "Merge anyway", and merge only when the Human picks "Merge anyway". ';
  }
  const shell = unattended ? 'Or the Human merges in their own shell.' : handOver(project, pr, head, repo);
  const blocked = (note, route) => `Blocked: this merges pull request #${pr} at ${sha7}, and ${problem}${note}. ${ask}${shell}${route}`;
  if (waiver.allow) {
    // A project run's waived merge is taken from its budget only after every other check of the merge passed (takeWaived).
    if (waiver.take) {
      memo.take = () => {
        const why = waiver.take();
        return why ? blocked('', ` A judge's verdict cannot stand for this head: ${why}.`) : null;
      };
    }
    return null;
  }
  return blocked(waiver.note, `${waiver.route}${delegation.route}`);
}

// The deny's ask in a session no Human attends, where no question has anyone to answer it: at a review stopped at its
// round limit, the waiting check's own route, then the stop, unless a judge's verdict stands under the unattended waiver,
// whose switches it names (`local`, the main checkout's local file); at any other denial, the review to finish.
const unattendedCap = ({ pr, last, local }) => {
  const route = last?.status === 'judging'
    ? ` The check at round ${last.round} waits for its judge: run again the review command that reached the cap, with the options it ran with, run the \`dispatch\` it prints as its read-only agent, and record its word with \`aidrian pr extend ${pr} --verdict extend|stop --reason "<evidence>" --head <sha>\`.`
    : '';
  return `No Human attends this session to answer, so do not ask with AskUserQuestion.${route} ` +
    'While the review stays stopped and no judge\'s verdict stands for this head, do not merge: file what the review left open as a follow-up issue, ' +
    'report the pull request as stopped at its round limit with that issue, and stop. A verdict stands only under the unattended waiver: ' +
    `github.unattendedWaiver.allow true on the default and base branches, and github.unattendedWaiver "on" in ${local} (docs/config.md, Unattended waiver). `;
};
const UNATTENDED_WAIT = 'No Human attends this session to waive this, so do not ask with AskUserQuestion: finish the review, or report the pull request unmerged. ';

// The deny's last route in a session a Human attends: the Human's own shell, with the one merge command to hand over when
// the Human already gave the decision in their own words, so the Human never answers it twice. It names the merge's
// repository when the merge did, and the working copy's `github.autoMerge.strategy` when it sets one.
function handOver(project, pr, head, repo) {
  let strategy = null;
  try {
    strategy = loadConfig(project).config.github.autoMerge.strategy ?? null;
  } catch {}
  const flag = typeof strategy === 'string' && /^[a-z]+$/u.test(strategy) ? ` --${strategy}` : '';
  return 'Or the Human merges in their own shell (`!` in the prompt): when the Human already gave this decision in their own words in this session, ' +
    `do not ask it again; hand over \`gh pr merge ${pr}${mergeRepoArg(repo)}${flag} --match-head-commit ${head}\`${flag ? '' : ', with the team\'s merge-strategy flag,'} for the Human to run.`;
}

// The session the hook payload names, or null.
const sessionOf = (input) => (typeof input?.session_id === 'string' && input.session_id !== '' ? input.session_id : null);

// Takes the waived merge judgeMerge let through from its project run's budget (waiver.mjs readWaiver `take`), once the
// merge passed every other check, so a merge a trust check refuses spends none of it: the deny reason when the budget
// refuses it, or null. Each merge's take is asked once.
function takeWaived(memo) {
  const take = memo.take;
  memo.take = null;
  return take ? take() : null;
}

const FULL_SHA = /^[0-9a-f]{40}$/iu;

// The repository a session no Human attends merges in, { host, owner, name }, or null: the one its project run pinned at
// init, read from the run's ledger, which no such session writes, when its mark names a run; else the one the origin of
// the main checkout `home` gives.
function pinnedFor(home, mark) {
  if (!mark?.project) return pinnedRepository(home);
  for (const state of stateFolders(home, loadConfig(home).config, { lazy: true })) {
    const found = readRun(state, mark.project);
    if (!found.problem) return found.init.repository;
  }
  return null;
}

// The projects a session no Human attends is held to, from its unattended mark alone, never from the folder a call runs
// in, which such a session may make a project of its own (`git init` in a folder of its clone): `project`, the one the
// gate started it in (the mark's `cwd`), for its folder in the repository and its record folders, else its main
// checkout's; and `home`, the main checkout's (`root`), whose policy and switches hold. Null when the main checkout
// does not resolve to a project, whatever the start folder.
export function markProjects(mark) {
  const at = (folder) => (typeof folder === 'string' && folder !== '' ? findProject(folder) : null);
  const home = at(mark?.root);
  if (!home) return null;
  return { project: at(mark?.cwd) ?? home, home };
}

// What a merge no Human asks for needs of the team's policy, as `aidrian pr auto-merge` asks it, from the review trail
// `trail` and the policies read with it, or null: the team's auto-merge on both branches, the machine's switch on in the
// main checkout `home`, the default branch's required checks named, every changed file through the paths check (with
// `includeGuardedPaths` and the policy files), the pull request the gh user's own, no comment or review by an outsider,
// no changes requested, not a draft, and every check of exactly the head finished and passed (pr-checks.mjs
// computeVerdict), so gh merges it at once rather than leave it to auto-merge or a queue.
export function policyProblem({ trail, head, policies, base, prefix, docs, home }) {
  const refusing = refusingBranches(policies, base ?? policies.main, 'autoMerge');
  if (refusing.length) return `the team does not allow auto-merge (github.autoMerge.allow on ${refusing.join(' and ')}), which a merge no Human asks for needs`;
  const team = { ...policies.policy.github.autoMerge, allow: true };
  const follows = home.localAutoMerge === 'unset' && team.default === 'on';
  const local = follows && !mayFollowTeamDefault(home) ? 'off' : home.localAutoMerge;
  if (!resolveAutoMerge({ autoMerge: team }, local).effective) return `this machine has not opted in to auto-merge (github.autoMerge in ${home.paths.local})`;
  const github = policies.policy.github;
  if (!github.requiredChecks.length) return 'the default branch names no required checks (github.requiredChecks), so a check that has not registered would read as passed';
  const paths = pathsProblem({ files: trail.files ?? [], changedFiles: trail.filesTotal ?? -1 }, prefix, { includeGuardedPaths: includesGuardedPaths(policies), policyFiles: policies.policyFiles, startDocs: docs });
  if (paths) return paths;
  if (typeof trail.author !== 'string' || typeof trail.viewer !== 'string' || trail.author.toLowerCase() !== trail.viewer.toLowerCase()) return `it is ${trail.author ?? 'nobody'}'s pull request, not ${trail.viewer ?? 'the gh user'}'s`;
  if (trail.commentsComplete !== true || trail.reviewsComplete !== true) return `the forge gave only part of its ${trail.commentsComplete !== true ? 'comments' : 'reviews'}, so who commented cannot be told`;
  const outsider = [...(trail.comments ?? []), ...(trail.reviews ?? [])].find((each) => !isTrustedCommenter({ author_association: each.association }) && !(each.bot && sameBot(each.login, github.reviewer)));
  if (outsider) return `${outsider.login ?? 'a deleted account'} commented, and is no member of the repository`;
  const changes = changesRequested({ reviewDecision: trail.reviewDecision ?? '', latestReviews: trail.latestReviews ?? [] });
  if (changes) return changes;
  if (trail.draft) return 'it is a draft';
  if (typeof trail.checks?.head !== 'string' || trail.checks.head.toLowerCase() !== head.toLowerCase() || trail.checks.complete !== true) return `the forge did not give every check of head ${head.slice(0, 7)}`;
  const verdict = computeVerdict(trail.checks.rows ?? [], github);
  return verdict.verdict === 'ready' ? null : `its checks on head ${head.slice(0, 7)} are ${verdict.verdict} (${verdict.reason}), and a merge no Human asks for runs only on finished, passing checks`;
}

// The deny reason, or null, for a merge `merge` ({ pr, head, repo, auto?, graphql? }) that the record's checks let
// through, made by a session no Human attends, whose unattended mark (lib/unattended-mark.mjs) is `mark`, held to the
// projects `project` and `home` (markProjects). The record is this machine's word, which a project run's confined session
// can write, so the merge also rests on the forge and the sign-off store: the merge must name its number and its full
// head, so gh merges the commit the forge was asked about, and neither leave the merge to GitHub (`--auto`, a GraphQL
// mutation) nor read as no record through a record file it cannot read (state.mjs recordProblem); its repository is the
// pinned one (pinnedFor), passed to every forge read, and a merge naming another is refused. Then git's project folder,
// and one forge read, the review trail, which also gives both branches' policy files and the knowledge folder; only a
// pointer to another folder reads branchPolicies and startDocs as well, through the policies the waiver read when it read
// them (`memo`). A trail the waiver read for the same repository, host, pull request, and folder (`memo.trail`) is not
// read again. It then asks policyProblem and merge-trust.mjs trustProblem. Every read is on budgetedForge's clock, the
// waiver's: none begins at WAIVER_DEADLINE_MS from `startedAt`; one that fails or runs out of time keeps the merge
// refused. `forge` is budgetedForge's `make`, the test seam.
export function unattendedProblem({ project, home = project, merge, mark, forge = null, startedAt, now = Date.now, memo = {}, planted = null }) {
  const { pr, head } = merge;
  const deny = (why) => `Blocked: no Human attends this session, and this merges ${pr === null ? 'a pull request' : `pull request #${pr}`}, but ${why}. ` +
    'A merge no Human asks for rests on the forge as well as this machine\'s review record: the team\'s auto-merge policy, the review bot\'s verdict on exactly the head, ' +
    'and the Human\'s sign-off, from the sign-off store, of every flow that asks for one (docs/review.md, Merge trust). Or the Human merges in their own shell.';
  if (merge.graphql) return deny(`it ${graphqlCall(merge.unreadable)}: merge with \`gh pr merge <PR> --match-head-commit <the 40-character head>\``);
  if (merge.auto) return deny('`--auto` leaves the merge to GitHub once the checks pass, at whatever head the branch has then: merge with `gh pr merge <PR> --match-head-commit <the 40-character head>` once every check passed');
  if (pr === null || typeof head !== 'string' || !FULL_SHA.test(head)) {
    return deny('it does not name both its number and its full head commit, so the guard cannot confirm what gh merges: merge with `gh pr merge <PR> --match-head-commit <the 40-character head>`');
  }
  const unreadable = planted ?? recordProblem(project, pr, { pastDeadline: () => now() >= startedAt + WAIVER_DEADLINE_MS });
  if (unreadable) return deny(unreadable);
  let pinned = null;
  try {
    pinned = pinnedFor(home, mark);
  } catch {}
  if (!pinned) return deny('the repository it merges in cannot be told: no project run of its mark pinned one, and the main checkout\'s origin names none');
  const repo = `${pinned.owner}/${pinned.name}`;
  if (merge.hostUnread) return deny('it names its repository or its host in a word the shell builds, which the guard cannot read: name both as written, or none');
  const elsewhere = (merge.hosts ?? []).find((host) => host !== String(pinned.host).toLowerCase());
  if (elsewhere) return deny(`it names the host ${elsewhere}, and this session works in ${repo} on ${pinned.host}`);
  if (merge.repo !== null && merge.repo !== undefined && repoName(merge.repo) !== repo.toLowerCase()) return deny(`it names ${merge.repo}, and this session works in ${repo}`);
  const deadline = startedAt + WAIVER_DEADLINE_MS;
  const reads = budgetedForge(forge ?? ((options) => forgeFor(project.root, options)), deadline, now);
  try {
    const left = Math.floor(deadline - now());
    const prefix = left > 0 ? knownPrefix(project.root, { timeout: Math.min(READ_TIMEOUT_MS, left) }) : null;
    if (prefix === null) return deny('git could not give the project\'s folder in the repository in time; running the merge once more is safe');
    // The waiver's read of the same trail, when it made one this command (waiver.mjs readWaiver): read once.
    const kept = memo.trail?.key === trailKey(repo, pinned.host, pr, prefix) ? memo.trail.value : null;
    const trail = kept ?? reads.reviewTrail(repo, pr, { host: pinned.host, paths: trailPaths(prefix) });
    const base = typeof trail?.base === 'string' && trail.base !== '' ? trail.base : null;
    const target = { repo, host: pinned.host, base };
    const remembered = memo.policies?.key === `${repo}|${base}|${prefix}` ? memo.policies.value : null;
    const policies = trailPolicies(trail, target, prefix) ?? remembered ?? branchPolicies(reads, target, prefix);
    const docs = trailDocs(trail, policies.configFile, prefix) ?? startDocs(reads, target, policies.main, policies.configFile, prefix);
    const problem = policyProblem({ trail, head, policies, base, prefix, docs, home })
      ?? trustProblem({
        trail, head, reviewer: policies.policy.github.reviewer, files: Array.isArray(trail?.files) ? trail.files : [], complete: trail?.filesComplete === true,
        configs: [policies.policy, policies.basePolicy], prefix, policyFiles: policies.policyFiles, state: scoped(recordFor(project, pr, repo), project, repo), signoffs: readHumanSignoffs({ repo, pr }),
      })
      ?? mergeClosesProblem({ trail, merge, mark, home, pr: { repo, host: pinned.host } });
    return problem ? deny(problem) : null;
  } catch (error) {
    return deny(`the forge could not confirm it in time (${String(error?.message ?? error).split('\n')[0]}); running the merge once more is safe`);
  }
}

// The unattended mark of `session`, or, for a project run's driver, the one its driver mark stands for (run-driver.mjs
// driverHold): a driver is held as a session no Human attends here too, and one whose run cannot be read names no
// project, which refuses.
const heldMark = (session, options = {}) => readUnattendedMark(session, options) ?? driverHold(session, options);

// The deny for a session no Human attends whose mark names no project the guard can read: it cannot tell whose policy holds.
const NO_PROJECT = 'Blocked: no Human attends this session, and this merges a pull request, but the project its unattended mark names cannot be read, ' +
  'so the merge guard cannot tell whose review and policy hold it. Or the Human merges in their own shell.';

// The deny reason for `command`, or null. On inside a project, and, for a session no Human attends, wherever it runs.
// `input` is the hook payload, for its transcript and the host's session id. `startedAt` is when the hook's process
// started (hook-bash passes it); without it, when this check began. `unattendedMark` reads the session's unattended mark,
// else the one its driver mark stands for (heldMark; `home` is a test's), asked once a merge, or text naming one, is
// found: with one, the projects come from the mark (markProjects), and its record files are checked before any is
// parsed (state.mjs recordProblem), and the merge must pass unattendedProblem too, whose forge reads go through
// `trustForge` (a test's). Each record file is parsed once a call (withRecordMemo).
export function check(command, { cwd = process.cwd(), env = process.env, input = {}, viewPr = viewPrAt(cwd), waiverForge = null, startedAt = Date.now(), now = Date.now, home, unattendedMark = () => heldMark(input?.session_id, home ? { home } : {}), trustForge = null } = {}) {
  return withRecordMemo(() => checkCommand(command, { cwd, env, input, viewPr, waiverForge, startedAt, now, unattendedMark, trustForge }));
}

function checkCommand(command, { cwd, env, input, viewPr, waiverForge, startedAt, now, unattendedMark, trustForge }) {
  const found = findProject(cwd);
  let answers = null;
  let held;
  const markOf = () => (held ??= { mark: unattendedMark() }).mark;
  const memo = {};
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined) {
      if ((found && MERGE_TEXT.test(unread)) || ((MERGE_TEXT.test(unread) || MUTATION_TEXT.test(unread)) && markOf())) return UNREAD_REASON;
      continue;
    }
    const merge = readMerge(invocation, env, { cwd });
    if (!merge) continue;
    const mark = markOf();
    const places = mark ? markProjects(mark) : null;
    if (mark && !places) return NO_PROJECT;
    const project = places?.project ?? found;
    if (!project) continue;
    if (merge.graphql && !mark) return graphqlReason(merge.unreadable);
    if (mark && (merge.graphql || merge.auto)) return unattendedProblem({ project, home: places.home, merge, mark, startedAt, now });
    // A session of a project run is held to the run's budget of waived merges (waiver.mjs budgetProblem).
    if (mark) Object.assign(memo, { run: runOf(mark), home: places.home });
    // Before any record is parsed: a session no Human attends is refused on record files planted to stall or mislead.
    const planted = mark && merge.pr !== null ? recordProblem(project, merge.pr, { pastDeadline: () => now() >= startedAt + WAIVER_DEADLINE_MS }) : null;
    if (planted) return unattendedProblem({ project, home: places.home, merge, mark, startedAt, now, planted });
    answers ??= transcriptAnswers(readTranscript(input?.transcript_path));
    memo.take = null;
    const reason = judgeMerge({ project, ...merge, viewPr, answers, waiverForge, startedAt, now, memo, session: sessionOf(input), unattended: Boolean(mark) });
    if (reason) return reason;
    const trust = mark ? unattendedProblem({ project, home: places.home, merge, mark, forge: trustForge, startedAt, now, memo }) : null;
    if (trust) return trust;
    const taken = takeWaived(memo);
    if (taken) return taken;
  }
  return null;
}

// The deny reason for one MCP merge call's `toolInput` ({ owner, repo, pullNumber, sha?, expectedHeadSha? }), or null:
// the head is the call's `sha`, as a host's connector maps it, or `expectedHeadSha`, the GitHub MCP server's own name for
// the head it passes to GitHub's merge. A session no Human attends meets unattendedProblem too, held to the projects its
// mark names, as in check.
export function checkMcp(toolInput, { cwd = process.cwd(), input = {}, viewPr = viewPrAt(cwd), waiverForge = null, startedAt = Date.now(), now = Date.now, home, unattendedMark = () => heldMark(input?.session_id, home ? { home } : {}), trustForge = null } = {}) {
  return withRecordMemo(() => checkTool(toolInput, { cwd, input, viewPr, waiverForge, startedAt, now, unattendedMark, trustForge }));
}

function checkTool(toolInput, { cwd, input, viewPr, waiverForge, startedAt, now, unattendedMark, trustForge }) {
  const mark = unattendedMark();
  const places = mark ? markProjects(mark) : null;
  if (mark && !places) return NO_PROJECT;
  const project = places?.project ?? findProject(cwd);
  if (!project) return null;
  const n = Number(toolInput?.pullNumber);
  const repo = typeof toolInput?.owner === 'string' && typeof toolInput?.repo === 'string' ? `${toolInput.owner}/${toolInput.repo}` : null;
  const given = [toolInput?.sha, toolInput?.expectedHeadSha].find((each) => typeof each === 'string' && each !== '');
  const head = typeof given === 'string' && SHA.test(given) ? given : null;
  const pr = Number.isInteger(n) && n > 0 ? n : null;
  const how = 'Merge with `gh pr merge <PR> --match-head-commit <sha>` instead, which names the head.';
  if (pr === null) return unresolved(null, how);
  const text = { subject: typeof toolInput?.commit_title === 'string' ? toolInput.commit_title : null, body: typeof toolInput?.commit_message === 'string' ? toolInput.commit_message : null, unreadable: false };
  const memo = mark ? { run: runOf(mark), home: places.home } : {};
  const planted = mark ? recordProblem(project, pr, { pastDeadline: () => now() >= startedAt + WAIVER_DEADLINE_MS }) : null;
  if (planted) return unattendedProblem({ project, home: places.home, merge: { pr, head, repo }, mark, startedAt, now, planted });
  const reason = judgeMerge({ project, pr, head, repo, viewPr, answers: transcriptAnswers(readTranscript(input?.transcript_path)), how, waiverForge, startedAt, now, memo, session: sessionOf(input), unattended: Boolean(mark) });
  if (reason) return reason;
  const trust = mark ? unattendedProblem({ project, home: places.home, merge: { pr, head, repo, text }, mark, forge: trustForge, startedAt, now, memo }) : null;
  return trust ?? takeWaived(memo);
}
