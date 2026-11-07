// Bash rule, and the decision of the GitHub MCP merge hook: no merge while a review the Human asked for has no answer,
// while a gate review is out, or while the review of the pull request's head has not finished. docs/hooks.md#merge-guard.
// A merge is:
//   - `gh pr merge` (but `--disable-auto`), `--auto` included;
//   - `gh api repos/<owner>/<name>/pulls/<n>/merge` sent as a PUT or a POST;
//   - the MCP tool `mcp__github__merge_pull_request`, or a host connector's call that stands for it (scripts/hook-mcp-github.mjs).
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
// The Human waives it with an AskUserQuestion answer, given at or after the head's outcome and every entry still owed, to
// a question naming `#<PR>` and the head's first 7 characters, whose chosen option starts with "Merge anyway". Without a
// transcript the host writes in that shape (Codex), the Human merges in their own shell.
// An unattended run's judge verdict (`aidrian pr waive`, lib/review/waiver.mjs) waives it in that answer's place, only
// for `round_limit` on the merge's own head, nothing owed, and only under both switches:
// `github.unattendedWaiver.allow` on the default and base branches, read from GitHub, and the main checkout's local switch.
// A verdict counts only for a merge that names its head. Those reads are made only when the switch is on and the denial
// is waivable: the view when the guard's own lacks the base, git's project folder, then up to five forge reads.
// All share one clock from the hook's start (`startedAt`, for the whole command), the guard's own head lookup included:
// none begins at 4 s, the waiver's first only within 1.5 s (checked once, before it; its later reads and the head lookup
// have only the 4 s), and each is stopped with SIGKILL at 1 s (3 s for a view) or at 4 s if sooner.
// A read that fails or would begin too late keeps the denial.

import { readFileSync } from 'node:fs';

import { forgeFor } from '../../forges/index.mjs';
import { findProject } from '../../project.mjs';
import { originRepo, prNumber, repoName } from '../../review-gate.mjs';
import { FINISHED, owed, readLocalState, sameCommit } from '../../review/state.mjs';
// A cycle (waiver.mjs → pr-auto-merge.mjs → this file), benign while neither uses the other's exports as it loads.
import { guardWaiver, WAIVER_DEADLINE_MS } from '../../review/waiver.mjs';
import { walkCommands } from '../../shell-lex.mjs';
import { transcriptAnswers } from '../review-extend.mjs';
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
export function readMerge({ program, args, environment = [] }, env = {}) {
  if (program !== 'gh') return null;
  const command = commandPath(args);
  const literal = (token) => (token && !token.dynamic ? token.text : null);
  if (command[0] === 'api') {
    const { words, flags } = readWords(args, new Set(API_VALUES));
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
    return { pr: Number(match[2]), head: sha && SHA.test(sha) ? sha : null, target: null, repo };
  }
  if (command[0] !== 'pr' || command[1] !== 'merge') return null;
  const { words, flags } = readWords(args, new Set(MERGE_VALUES));
  if (flags.some((flag) => flag.name === '--disable-auto')) return null;
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
  };
}

// The Human's answer that waives the guard for `pr` at `head`, given at or after `since`.
export function mergeApproved(answers, { pr, head, since = null }) {
  const names = new RegExp(`#${pr}(?!\\d)`, 'u');
  const sha7 = String(head).slice(0, 7).toLowerCase();
  return answers.some((each) => names.test(each.question) && each.question.toLowerCase().includes(sha7) && /^\s*merge anyway\b/iu.test(each.answer) &&
    (since === null || (each.at !== null && Date.parse(each.at) >= Date.parse(since))));
}

const readTranscript = (file) => {
  try {
    return typeof file === 'string' && file !== '' ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

// Whether the record holds anything the guard reads: an entry still owed, or a review the step ran or is running.
const guards = (state) => Boolean(state) && (owed(state).length > 0 || state.outcome != null || state.rounds.length > 0);

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
export function scoped(state, project, repo) {
  const target = repo === null ? null : repoName(repo);
  if (!state || target === null) return state;
  const home = repoName(state.repo ?? null) ?? originRepo(project);
  const ours = (own) => own === null || own === target;
  const mine = ours(home);
  return { ...state, pending: owed(state).filter((entry) => ours(repoName(entry.repo ?? null) ?? home)), outcome: mine ? state.outcome : null, rounds: mine ? state.rounds : [] };
}

// The deny reason for a merge of `pr` at `head` in `project`, or null. `pr` or `head` null is read through
// `viewPr(target, repo)`; `answers` are the Human's AskUserQuestion answers in this session.
// `waiverForge` is the test seam for the unattended waiver's reads (lib/review/waiver.mjs guardWaiver, budgetedForge's
// `make`); null builds forgeFor's only when the waiver is asked. `startedAt` is when the hook's process started, shared by
// every merge of one command; `now` the clock.
export function judgeMerge({ project, pr = null, head = null, target = null, repo = null, unreadable = false, viewPr, answers = [], how = MERGE_HOW, waiverForge = null, startedAt = null, now = Date.now }) {
  startedAt ??= now();
  // Only a merge that names its head can take a recorded verdict: otherwise gh merges whatever head the branch has then.
  const named = head !== null;
  // A number the rule cannot read is refused whatever the target: no record can say the merge is another's.
  if (unreadable) return unresolved(null, how);
  let state = pr === null ? null : scoped(readLocalState(project, pr), project, repo);
  if (pr !== null && !guards(state)) return null;
  let view = null;
  if (pr === null || head === null) {
    // The lookup shares the command's deadline with the waiver's reads: with no time left it is not made, and the merge
    // is refused, told to name its head.
    const left = Math.floor(startedAt + WAIVER_DEADLINE_MS - now());
    view = left > 0 ? viewPr(pr ?? target, repo, { timeoutMs: Math.min(VIEW_TIMEOUT_MS, left) }) : null;
    if (!view) return unresolved(pr, how);
    if (pr === null) {
      pr = view.number;
      state = scoped(readLocalState(project, pr), project, repo);
      if (!guards(state)) return null;
    }
    head ??= view.headRefOid;
  }
  const sha7 = head.slice(0, 7);
  const owing = owed(state);
  const outcome = state.outcome ?? null;
  const onHead = outcome !== null && sameCommit(outcome.head, head);
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
  else {
    problem = outcome === null
      ? `its review record holds rounds but no finished review of head ${sha7}`
      : onHead ? `the review of head ${sha7} is \`${outcome.status}\`${outcome.reason ? ` (${outcome.reason})` : ''}`
        : `the last review step covered ${String(outcome.head).slice(0, 7)}, not head ${sha7}`;
    problem += `: run \`aidrian pr review ${pr}\` until it returns \`received\` or \`none_needed\``;
  }
  const since = [onHead ? outcome.at : null, ...owing.map((entry) => entry.at)].filter((at) => typeof at === 'string').sort().at(-1) ?? null;
  if (mergeApproved(answers, { pr, head, since })) return null;
  // A judge's recorded verdict, under both switches, for the round cap on this head only (waiverKind).
  const waiver = guardWaiver({ project, state, pr, head, named, repo, view, forge: waiverForge, startedAt, now });
  if (waiver.allow) return null;
  const question = `Merge pull request #${pr} at ${sha7} before its review is finished?`;
  return `Blocked: this merges pull request #${pr} at ${sha7}, and ${problem}${waiver.note}. ` +
    `Only the Human waives this: ask with AskUserQuestion, the question "${question}", the options "Wait for the review" ` +
    '(first, recommended) and "Merge anyway", and merge only when the Human picks "Merge anyway". ' +
    `Or the Human merges in their own shell.${waiver.route}`;
}

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
// `startedAt` is when the hook's process started (hook-bash passes it); without it, when this check began.
export function check(command, { cwd = process.cwd(), env = process.env, input = {}, viewPr = viewPrAt(cwd), waiverForge = null, startedAt = Date.now(), now = Date.now } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  let answers = null;
  for (const { invocation, unread } of walkCommands(command, null)) {
    if (unread !== undefined && MERGE_TEXT.test(unread)) return UNREAD_REASON;
    const merge = readMerge(invocation, env);
    if (!merge) continue;
    answers ??= transcriptAnswers(readTranscript(input?.transcript_path));
    const reason = judgeMerge({ project, ...merge, viewPr, answers, waiverForge, startedAt, now });
    if (reason) return reason;
  }
  return null;
}

// The deny reason for one MCP merge call's `toolInput` ({ owner, repo, pullNumber, sha? }), or null.
export function checkMcp(toolInput, { cwd = process.cwd(), input = {}, viewPr = viewPrAt(cwd), waiverForge = null, startedAt = Date.now(), now = Date.now } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const n = Number(toolInput?.pullNumber);
  const repo = typeof toolInput?.owner === 'string' && typeof toolInput?.repo === 'string' ? `${toolInput.owner}/${toolInput.repo}` : null;
  const head = typeof toolInput?.sha === 'string' && SHA.test(toolInput.sha) ? toolInput.sha : null;
  const pr = Number.isInteger(n) && n > 0 ? n : null;
  const how = 'Merge with `gh pr merge <PR> --match-head-commit <sha>` instead, which names the head.';
  if (pr === null) return unresolved(null, how);
  return judgeMerge({ project, pr, head, repo, viewPr, answers: transcriptAnswers(readTranscript(input?.transcript_path)), how, waiverForge, startedAt, now });
}
