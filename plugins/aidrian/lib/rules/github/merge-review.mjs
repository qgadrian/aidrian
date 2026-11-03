// Bash rule, and the decision of the GitHub MCP merge hook: no merge while a review the Human asked for has no answer,
// while a gate review is out, or while the review of the pull request's head has not finished. docs/hooks.md#merge-guard.
// A merge is:
//   - `gh pr merge` (but `--disable-auto`), `--auto` included;
//   - `gh api repos/<owner>/<name>/pulls/<n>/merge` sent as a PUT or a POST;
//   - the MCP tool `mcp__github__merge_pull_request` (scripts/hook-mcp-github.mjs).
// It reads only this machine's review record (lib/review/state.mjs), in this order:
//   1. a `pending` entry not answered denies, whatever the head or the outcome: a request sent is owed until the bot answers;
//   2. no record the review step wrote (no outcome, no round) allows: the guard holds a review that is open or asked
//      for, not that one happens, so a review run outside `aidrian pr review` is not guarded;
//   3. a review step still running on the head (state.mjs openRun, younger than RUN_STALE_MS) denies;
//   4. otherwise the head needs a finished outcome (`received`, `none_needed`) on that very head.
// Its one network call is `gh pr view --json number,headRefOid`, made only when the call names no head or no pull request
// and a record may apply, and bounded at 3 s. A merge whose head it then cannot read is refused, as the review gate
// refuses a request whose pull request it cannot read: `--match-head-commit <sha>` names it.
// A record from another machine is not read here: that is the known limit, as for review-extend.
// The Human waives it with an AskUserQuestion answer, given at or after the head's outcome and every entry still owed, to
// a question naming `#<PR>` and the head's first 7 characters, whose chosen option starts with "Merge anyway". Without a
// transcript the host writes in that shape (Codex), the Human merges in their own shell.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { runGh } from '../../gh.mjs';
import { findProject } from '../../project.mjs';
import { originRepo, prNumber, repoName } from '../../review-gate.mjs';
import { activeRuns, FINISHED, owed, readLocalState, sameCommit } from '../../review/state.mjs';
import { commandLines, lexCommand, readInvocation } from '../../shell-lex.mjs';
import { transcriptAnswers } from '../review-extend.mjs';
import { commandPath, invocationRepo, readWords } from './review-request.mjs';

// How long the head lookup may take, inside the hook's 5 s, as pr-body's open pull request lookup.
const VIEW_TIMEOUT_MS = 3000;
const SHA = /^[0-9a-f]{7,40}$/iu;
// The options of `gh pr merge` and `gh api` that take a value, from each command's `--help`.
const MERGE_VALUES = ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo'];
const API_VALUES = ['-f', '--raw-field', '-F', '--field', '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--input',
  '-p', '--preview', '--hostname', '--cache'];

// `{ number, headRefOid }` of the pull request gh finds for `target` (a number, URL, or branch; null for the current
// branch) in `repo` (null for this one), or null when gh cannot answer in time. The test seam of the one network call.
export function viewPrAt(cwd) {
  return (target, repo) => {
    const args = ['pr', 'view', ...(target === null ? [] : [String(target)]), '--json', 'number,headRefOid', ...(repo ? ['--repo', repo] : [])];
    try {
      const view = JSON.parse(runGh(args, { cwd, exec: (file, argv, options) => execFileSync(file, argv, { ...options, timeout: VIEW_TIMEOUT_MS }) }));
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
    const match = /(?:^|\/)repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge\/?$/u.exec(literal(words[1]) ?? '');
    const fields = flags.filter((flag) => ['-f', '--raw-field', '-F', '--field'].includes(flag.name));
    const method = literal(flags.filter((flag) => flag.name === '-X' || flag.name === '--method').at(-1)?.value)?.toUpperCase() ?? (fields.length || flags.some((flag) => flag.name === '--input') ? 'POST' : 'GET');
    if (!match || !['PUT', 'POST'].includes(method)) return null;
    const sha = fields.map((flag) => literal(flag.value)).find((text) => text?.startsWith('sha='))?.slice('sha='.length) ?? null;
    // gh fills `{owner}` and `{repo}` from GH_REPO, or this repository without it.
    const ghRepo = invocationRepo(environment, env);
    const repo = match[1].includes('{') ? ghRepo : match[1];
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

// Whether the record holds anything the guard reads: an entry still owed, a run still open, or a review the step ran.
const guards = (state) => Boolean(state) && (owed(state).length > 0 || (state.active ?? []).length > 0 || state.outcome != null || state.rounds.length > 0);

export const unresolved = (pr, how) =>
  `Blocked: this merges ${pr === null ? 'a pull request' : `pull request #${pr}`}, and the merge guard could not read ` +
  `${pr === null ? 'which one, or its head commit,' : 'its head commit'} in time to check its review. ${how}`;

const MERGE_HOW = 'Name both: `gh pr merge <PR> --match-head-commit <sha>`, with the head the review covered.';

// The deny reason for a merge of `pr` at `head` in `project`, or null. `pr` or `head` null is read through
// `viewPr(target, repo)`; `answers` are the Human's AskUserQuestion answers in this session.
export function judgeMerge({ project, pr = null, head = null, target = null, repo = null, unreadable = false, viewPr, answers = [], how = MERGE_HOW }) {
  // A merge in another repository is not this record's: the target differs from both origin and the repository the
  // record was written for, as an upstream's in a fork checkout. Every spelling compares as `owner/name`, lower-cased.
  const elsewhere = (state) => {
    const target = repo === null ? null : repoName(repo);
    const known = [originRepo(project), repoName(state?.repo ?? null)].filter(Boolean);
    return target !== null && known.length > 0 && !known.includes(target);
  };
  if (unreadable) return elsewhere(null) ? null : unresolved(null, how);
  let state = pr === null ? null : readLocalState(project, pr);
  if (pr !== null && (!guards(state) || elsewhere(state))) return null;
  if (pr === null || head === null) {
    const view = viewPr(pr ?? target, repo);
    if (!view) return unresolved(pr, how);
    if (pr === null) {
      pr = view.number;
      state = readLocalState(project, pr);
      if (!guards(state) || elsewhere(state)) return null;
    }
    head ??= view.headRefOid;
  }
  const sha7 = head.slice(0, 7);
  const owing = owed(state);
  const outcome = state.outcome ?? null;
  const onHead = outcome !== null && sameCommit(outcome.head, head);
  const running = activeRuns(state, head);
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
  } else if (running.length) {
    problem = `a review step on head ${sha7} is still running (started ${running.map((each) => each.at).join(', ')}): wait for \`aidrian pr review ${pr}\` to return`;
  } else if (onHead && FINISHED.has(outcome.status)) return null;
  else if (outcome === null && !state.rounds.length) return null;
  else {
    problem = outcome === null
      ? `its review record holds rounds but no finished review of head ${sha7}`
      : onHead ? `the review of head ${sha7} is \`${outcome.status}\`${outcome.reason ? ` (${outcome.reason})` : ''}`
        : `the last review step covered ${String(outcome.head).slice(0, 7)}, not head ${sha7}`;
    problem += `: run \`aidrian pr review ${pr}\` until it returns \`received\` or \`none_needed\``;
  }
  const since = [onHead ? outcome.at : null, ...owing.map((entry) => entry.at), ...running.map((each) => each.at)].filter((at) => typeof at === 'string').sort().at(-1) ?? null;
  if (mergeApproved(answers, { pr, head, since })) return null;
  const question = `Merge pull request #${pr} at ${sha7} before its review is finished?`;
  return `Blocked: this merges pull request #${pr} at ${sha7}, and ${problem}. ` +
    `Only the Human waives this: ask with AskUserQuestion, the question "${question}", the options "Wait for the review" ` +
    '(first, recommended) and "Merge anyway", and merge only when the Human picks "Merge anyway". ' +
    'Or the Human merges in their own shell.';
}

// The deny reason for `command`, or null. On only inside a project. `input` is the hook payload, for its transcript.
export function check(command, { cwd = process.cwd(), env = process.env, input = {}, viewPr = viewPrAt(cwd) } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  let answers = null;
  for (const line of commandLines(command)) {
    for (const segment of lexCommand(line)) {
      const merge = readMerge(readInvocation(segment), env);
      if (!merge) continue;
      answers ??= transcriptAnswers(readTranscript(input?.transcript_path));
      const reason = judgeMerge({ project, ...merge, viewPr, answers });
      if (reason) return reason;
    }
  }
  return null;
}

// The deny reason for one MCP merge call's `toolInput` ({ owner, repo, pullNumber, sha? }), or null.
export function checkMcp(toolInput, { cwd = process.cwd(), input = {}, viewPr = viewPrAt(cwd) } = {}) {
  const project = findProject(cwd);
  if (!project) return null;
  const n = Number(toolInput?.pullNumber);
  const repo = typeof toolInput?.owner === 'string' && typeof toolInput?.repo === 'string' ? `${toolInput.owner}/${toolInput.repo}` : null;
  const head = typeof toolInput?.sha === 'string' && SHA.test(toolInput.sha) ? toolInput.sha : null;
  const pr = Number.isInteger(n) && n > 0 ? n : null;
  const how = 'Merge with `gh pr merge <PR> --match-head-commit <sha>` instead, which names the head.';
  if (pr === null) return unresolved(null, how);
  return judgeMerge({ project, pr, head, repo, viewPr, answers: transcriptAnswers(readTranscript(input?.transcript_path)), how });
}
